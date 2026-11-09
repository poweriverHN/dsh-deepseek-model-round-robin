/**
 * 用假 ctx / 假 agent / 假 llm 跑一遍轮换逻辑：
 * 付费排除、探测前检查、缓存复用、全挂时不切、过期、子代理、失败标记、异常。
 * 运行：node --test
 */
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { apply } from './index.js'

/** 一份混了付费渠道的白名单：codearts 付费，trae / loomy 免费。 */
const LIST = [
  { provider: 'codearts', model: 'deepseek-v4.1-flash' },
  { provider: 'trae', model: 'DeepSeek-V4-Pro' },
  { provider: 'loomy', model: 'deepseek-v4-flash-0731' },
]
const FREE = [LIST[1], LIST[2]]

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'round-robin-'))
const whitelist = path.join(tmp, 'whitelist.json')

/** 写一份白名单，并强制刷新 mtime（否则可能命中上一份缓存）。 */
function writeWhitelist(value) {
  fs.writeFileSync(whitelist, JSON.stringify(value))
  const bumped = new Date(Date.now() + Math.floor(Math.random() * 1000) + 1)
  fs.utimesSync(whitelist, bumped, bumped)
}

/**
 * 造一个假的 llm 服务。
 * @param {(provider: string, model: string) => 'ok' | 'fail' | 'throw'} outcome 每个候选的探测结果
 * @param {{ calls?: string[] }} log 记录探测过的候选
 */
function fakeLlm(outcome, log = { calls: [] }) {
  return {
    stream({ provider, model }) {
      log.calls.push(`${provider}/${model}`)
      const result = outcome(provider, model)
      return (async function* () {
        if (result === 'throw') throw new Error('channel down')
        if (result === 'fail') {
          yield { type: 'finish', reason: { kind: 'error', failure: { code: 'QUOTA_EXCEEDED' } } }
          return
        }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
}

/**
 * 假 ctx + 触发一次 turn-stopping（或 agent/error）。
 * @param {object} [options]
 * @param {(() => { self: string }) | undefined} [options.namesOf] subagents.namesOf 桩
 * @param {object} [options.config] 覆盖插件配置
 * @param {object} [options.llm] 假 llm 服务
 */
function harness({ namesOf, config, llm } = {}) {
  const handlers = []
  const services = {}
  if (namesOf !== undefined) services.subagents = { namesOf }
  if (llm !== undefined) services.llm = llm
  const ctx = {
    on: (event, fn) => { handlers.push({ event, fn }) },
    logger: { debug: () => {}, warn: () => {} },
    get: (name) => services[name],
  }
  apply(ctx, { whitelistPath: whitelist, ...config })
  return {
    async fire(agent) {
      for (const { event, fn } of handlers) {
        if (event === 'agent/turn-stopping') await fn({ agent, signal: { aborted: false } })
      }
    },
    async fail(agent, error, turn = 1) {
      for (const { event, fn } of handlers) {
        if (event === 'agent/error') await fn({ agent, turn, step: 1, error })
      }
    },
    claim(agent, message, turn = 1) {
      for (const { event, fn } of handlers) {
        if (event === 'agent/inbox/claimed') fn({ agent, message, turn })
      }
    },
  }
}

/**
 * 造一个能接收回填的假 agent。
 * @param {{ events?: object[] }} [options] session.ownEvents() 的返回值
 */
function recoverableAgent(options = {}) {
  const appended = []
  return {
    appended,
    session: { ownEvents: () => options.events ?? [] },
    inbox: { append: (target, message) => { appended.push({ target, message }) } },
    model: { current: () => FREE[0], select: () => {} },
  }
}

const INPUT = [{ type: 'text', text: '帮我改一下这个函数' }]
const userMessage = (id = 'm1') => ({ id, role: 'user', source: { kind: 'user' }, content: INPUT })

/** 记录 select 调用的假 agent。 */
function agentAt(selection, sink) {
  return {
    model: {
      current: () => selection,
      select: (value) => { sink.picked = value },
    },
  }
}

test('探测通过才切换：下一个可用时切到它', async () => {
  writeWhitelist({ at: Date.now(), models: LIST })
  const sink = {}
  const log = { calls: [] }
  await harness({ llm: fakeLlm(() => 'ok', log) }).fire(agentAt(FREE[0], sink))
  assert.deepStrictEqual(sink.picked, FREE[1])
  // 未知候选是**并行**探的（延迟封顶一个超时），所以会连带探到后面的候选；
  // 但选中的一定是最靠前的那个健康的
  assert.ok(log.calls.includes('loomy/deepseek-v4-flash-0731'), '探了紧邻的下一个')
  assert.ok(log.calls.length <= 3, '并行批量不超过 verifyCandidates')
})

test('下一个不可用时顺延到再下一个', async () => {
  writeWhitelist({ at: Date.now(), models: LIST })
  const sink = {}
  const log = { calls: [] }
  // 当前是 loomy（末尾），下一个绕回 trae；让 loomy 挂、trae 好
  const llm = fakeLlm((provider) => (provider === 'loomy' ? 'fail' : 'ok'), log)
  await harness({ llm }).fire(agentAt(FREE[1], sink))
  assert.deepStrictEqual(sink.picked, FREE[0], '跳过坏的下一个，切到好的')
})

test('候选全挂时保持当前模型，不切换', async () => {
  writeWhitelist({ at: Date.now(), models: LIST })
  const sink = {}
  await harness({ llm: fakeLlm(() => 'fail') }).fire(agentAt(FREE[0], sink))
  assert.strictEqual(sink.picked, undefined, '宁可不动也不能切到坏的')
})

test('探测抛异常也当作不可用', async () => {
  writeWhitelist({ at: Date.now(), models: LIST })
  const sink = {}
  await harness({ llm: fakeLlm(() => 'throw') }).fire(agentAt(FREE[0], sink))
  assert.strictEqual(sink.picked, undefined)
})

test('缓存命中时不再打网络', async () => {
  writeWhitelist({ at: Date.now(), models: LIST })
  const log = { calls: [] }
  const llm = fakeLlm(() => 'ok', log)
  const h = harness({ llm })
  await h.fire(agentAt(FREE[0], {}))
  const afterFirst = log.calls.length
  await h.fire(agentAt(FREE[0], {}))
  await h.fire(agentAt(FREE[0], {}))
  assert.strictEqual(log.calls.length, afterFirst, 'TTL 内复用缓存，不重复探测')
})

test('缓存过期后重新探测', async () => {
  writeWhitelist({ at: Date.now(), models: LIST })
  const log = { calls: [] }
  // TTL 设成 0 不该生效（positive() 会回落默认）；用 1ms 让它立刻过期
  const llm = fakeLlm(() => 'ok', log)
  const h = harness({ llm, config: { verifyTtlMs: 1 } })
  await h.fire(agentAt(FREE[0], {}))
  const first = log.calls.length
  await new Promise(resolve => setTimeout(resolve, 5))
  await h.fire(agentAt(FREE[0], {}))
  assert.ok(log.calls.length > first, 'TTL 过了要重新探')
})

test('关掉探测时退回只信白名单', async () => {
  writeWhitelist({ at: Date.now(), models: LIST })
  const sink = {}
  const log = { calls: [] }
  await harness({ llm: fakeLlm(() => 'fail', log), config: { verifyBeforeSwitch: false } })
    .fire(agentAt(FREE[0], sink))
  assert.deepStrictEqual(sink.picked, FREE[1], '不探测就直接轮换')
  assert.strictEqual(log.calls.length, 0, '一次网络都不该打')
})

test('拿不到 llm 服务时不拦，退回旧行为', async () => {
  writeWhitelist({ at: Date.now(), models: LIST })
  const sink = {}
  await harness().fire(agentAt(FREE[0], sink))
  assert.deepStrictEqual(sink.picked, FREE[1])
})

test('付费渠道默认不参与轮换', async () => {
  writeWhitelist({ at: Date.now(), models: LIST })
  const sink = {}
  const log = { calls: [] }
  await harness({ llm: fakeLlm(() => 'ok', log) }).fire(agentAt(LIST[0], sink))
  assert.deepStrictEqual(sink.picked, FREE[0], '只在免费渠道之间轮换')
  assert.ok(!log.calls.some(c => c.startsWith('codearts/')), '绝不探测付费渠道')
})

test('excludeProviders 为空时付费渠道参与轮换', async () => {
  writeWhitelist({ at: Date.now(), models: LIST })
  const sink = {}
  await harness({ llm: fakeLlm(() => 'ok'), config: { excludeProviders: [] } })
    .fire(agentAt(LIST[0], sink))
  assert.deepStrictEqual(sink.picked, LIST[1])
})

test('白名单的 rotateExclude 覆盖内置默认', async () => {
  // 只排 trae：codearts 是付费的，但既然没写进 rotateExclude，它就回到池里
  writeWhitelist({ at: Date.now(), rotateExclude: ['trae'], models: LIST })
  const sink = {}
  await harness({ llm: fakeLlm(() => 'ok') }).fire(agentAt(LIST[0], sink))
  assert.deepStrictEqual(sink.picked, LIST[2], '池里是 codearts + loomy，codearts 的下一个是 loomy')
})

test('排掉付费渠道后只剩一个模型时不轮换', async () => {
  writeWhitelist({ at: Date.now(), models: [LIST[0], LIST[1]] })
  const sink = {}
  await harness({ llm: fakeLlm(() => 'ok') }).fire(agentAt(LIST[1], sink))
  assert.strictEqual(sink.picked, undefined)
})

test('白名单过期时不轮换', async () => {
  writeWhitelist({ at: Date.now() - 999 * 60_000, staleAfterMinutes: 180, models: LIST })
  const sink = {}
  await harness({ llm: fakeLlm(() => 'ok') }).fire(agentAt(FREE[0], sink))
  assert.strictEqual(sink.picked, undefined)
})

test('白名单缺失时不轮换', async () => {
  fs.rmSync(whitelist, { force: true })
  const sink = {}
  await harness({ llm: fakeLlm(() => 'ok') }).fire(agentAt(FREE[0], sink))
  assert.strictEqual(sink.picked, undefined)
})

test('子代理默认跳过，且不浪费探测', async () => {
  writeWhitelist({ at: Date.now(), models: LIST })
  const sink = {}
  const log = { calls: [] }
  await harness({ namesOf: () => ({ self: 'subagent-1' }), llm: fakeLlm(() => 'ok', log) })
    .fire(agentAt(FREE[0], sink))
  assert.strictEqual(sink.picked, undefined)
  assert.strictEqual(log.calls.length, 0, '跳过时不该发探测请求')
})

test('根代理照常轮换', async () => {
  writeWhitelist({ at: Date.now(), models: LIST })
  const sink = {}
  await harness({ namesOf: () => ({ self: 'lead' }), llm: fakeLlm(() => 'ok') })
    .fire(agentAt(FREE[0], sink))
  assert.deepStrictEqual(sink.picked, FREE[1])
})

test('渠道级故障会把该模型记账为不可用，下轮避开', async () => {
  writeWhitelist({ at: Date.now(), models: LIST })
  const log = { calls: [] }
  const llm = fakeLlm(() => 'ok', log)
  const h = harness({ llm })
  // 先用一次调用把 trae 记进缓存（成功）
  await h.fire(agentAt(FREE[0], {}))
  // 然后 trae 真实调用失败
  await h.fail(agentAt(FREE[1], {}), { code: 'QUOTA_EXCEEDED' })
  log.calls.length = 0
  const sink = {}
  await h.fire(agentAt(FREE[0], sink))
  assert.ok(!log.calls.includes('trae/DeepSeek-V4-Pro'), '已知坏的渠道不会再被探测或选中')
})

test('非渠道级错误不会错杀健康模型', async () => {
  writeWhitelist({ at: Date.now(), models: LIST })
  const log = { calls: [] }
  const h = harness({ llm: fakeLlm(() => 'ok', log) })
  await h.fail(agentAt(FREE[1], {}), { code: 'TOOL_FAILED' })
  log.calls.length = 0
  const sink = {}
  await h.fire(agentAt(FREE[0], sink))
  assert.deepStrictEqual(sink.picked, FREE[1], '工具报错不该影响轮换判断')
})

test('select 抛错被吞掉，不炸掉对话', async () => {
  writeWhitelist({ at: Date.now(), models: LIST })
  const agent = {
    model: {
      current: () => FREE[0],
      select: () => { throw new Error('boom') },
    },
  }
  await harness({ llm: fakeLlm(() => 'ok') }).fire(agent)
})

// ---------- 失败后保住用户输入 ----------

test('消息没进日志且是渠道故障时，放回队列', async () => {
  const h = harness()
  const agent = recoverableAgent()
  h.claim(agent, userMessage())
  await h.fail(agent, { code: 'QUOTA_EXCEEDED' })
  assert.strictEqual(agent.appended.length, 1)
  assert.strictEqual(agent.appended[0].target, 'next-turn')
  assert.deepStrictEqual(agent.appended[0].message.content, INPUT)
  assert.notStrictEqual(agent.appended[0].message.id, 'm1', '重新入队要用新的消息 id')
})

test('消息已经写进日志时不重复入队', async () => {
  const h = harness()
  const agent = recoverableAgent({ events: [{ type: 'user/message', data: { id: 'm1' } }] })
  h.claim(agent, userMessage())
  await h.fail(agent, { code: 'TRANSPORT' })
  assert.strictEqual(agent.appended.length, 0)
})

test('非渠道级错误不动用户输入', async () => {
  const h = harness()
  const agent = recoverableAgent()
  h.claim(agent, userMessage())
  await h.fail(agent, { code: 'TOOL_FAILED' })
  assert.strictEqual(agent.appended.length, 0)
})

test('错误属于别的轮次时不入队', async () => {
  const h = harness()
  const agent = recoverableAgent()
  h.claim(agent, userMessage(), 1)
  await h.fail(agent, { code: 'QUOTA_EXCEEDED' }, 2)
  assert.strictEqual(agent.appended.length, 0)
})

test('没有 claimed 记录时不入队', async () => {
  const h = harness()
  const agent = recoverableAgent()
  await h.fail(agent, { code: 'QUOTA_EXCEEDED' })
  assert.strictEqual(agent.appended.length, 0)
})

test('空内容不入队', async () => {
  const h = harness()
  const agent = recoverableAgent()
  h.claim(agent, { id: 'm1', role: 'user', source: { kind: 'user' }, content: [] })
  await h.fail(agent, { code: 'QUOTA_EXCEEDED' })
  assert.strictEqual(agent.appended.length, 0)
})

test('同一段输入反复失败时按上限停止入队', async () => {
  const h = harness({ config: { maxRequeuePerMessage: 2 } })
  const agent = recoverableAgent()
  for (let i = 0; i < 5; i++) {
    h.claim(agent, userMessage(`m${i}`))
    await h.fail(agent, { code: 'QUOTA_EXCEEDED' })
  }
  assert.strictEqual(agent.appended.length, 2)
})

test('recoverFailedInput 关掉后不再回填', async () => {
  const h = harness({ config: { recoverFailedInput: false } })
  const agent = recoverableAgent()
  h.claim(agent, userMessage())
  await h.fail(agent, { code: 'QUOTA_EXCEEDED' })
  assert.strictEqual(agent.appended.length, 0)
})

test('子代理失败不回填（那是父代理给的输入）', async () => {
  const h = harness({ namesOf: () => ({ self: 'subagent-1' }) })
  const agent = recoverableAgent()
  h.claim(agent, userMessage())
  await h.fail(agent, { code: 'QUOTA_EXCEEDED' })
  assert.strictEqual(agent.appended.length, 0)
})

test('日志读不了时保守不入队', async () => {
  const h = harness()
  let appended = 0
  const agent = {
    session: { ownEvents: () => { throw new Error('unreadable') } },
    inbox: { append: () => { appended++ } },
    model: { current: () => FREE[0], select: () => {} },
  }
  h.claim(agent, userMessage())
  await h.fail(agent, { code: 'QUOTA_EXCEEDED' })
  assert.strictEqual(appended, 0, '宁可不出重复消息')
})

test('inbox.append 抛错也不炸掉对话', async () => {
  const h = harness()
  const agent = {
    session: { ownEvents: () => [] },
    inbox: { append: () => { throw new Error('boom') } },
    model: { current: () => FREE[0], select: () => {} },
  }
  h.claim(agent, userMessage())
  await h.fail(agent, { code: 'QUOTA_EXCEEDED' })
})
