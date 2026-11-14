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

/**
 * 一份混合白名单：codearts、trae、loomy 三个渠道。
 *
 * `FREE` 是「按内置默认排除规则后仍在轮换池里」的那部分。2026-11-09 用户要求
 * 只排除 DeepSeek 官方，codearts 因此回到池里——但本文件多处用例依赖 `FREE`
 * 表示「池中的后两个」，为保持这些用例语义不变，下面的用例显式用 `rotateExclude`
 * 把 codearts 排掉，再验证「只在池内轮换」。
 */
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
 * 假 ctx + 触发事件。
 *
 * 关键：`agent/error` 与 `agent/inbox/claimed` 的真实载荷**不含 agent**
 * （分别是 `{ turn, step, error }` 和 `{ message, turn }`），插件必须按 agent 注册监听
 * 才能靠闭包拿到 agent。所以这里的 harness 也照真实样子来：根 ctx 只收
 * `agent/created` / `agent/turn-stopping`，另两个事件发到 `agent.ctx` 上。
 * 早先的 harness 直接往载荷里塞 agent，掩盖了「根 ctx 上听不到 agent」这个真实缺陷。
 *
 * @param {object} [options]
 * @param {(() => { self: string }) | undefined} [options.namesOf] subagents.namesOf 桩
 * @param {object} [options.config] 覆盖插件配置
 * @param {object} [options.llm] 假 llm 服务
 */
function harness({ namesOf, config, llm } = {}) {
  const rootHandlers = []
  /** agent → 它的 agent.ctx 上的监听 */
  const scoped = new WeakMap()
  const services = {}
  if (namesOf !== undefined) services.subagents = { namesOf }
  if (llm !== undefined) services.llm = llm
  const ctx = {
    on: (event, fn) => { rootHandlers.push({ event, fn }) },
    logger: { debug: () => {}, warn: () => {}, info: () => {} },
    get: (name) => services[name],
  }
  apply(ctx, { whitelistPath: whitelist, ...config })

  /** 给一个 agent 补上 agent.ctx，并声明它已创建（插件的 created 监听是同步注册的）。 */
  function ensure(agent) {
    if (scoped.has(agent)) return
    const own = []
    agent.ctx = { on: (event, fn) => { own.push({ event, fn }) } }
    scoped.set(agent, own)
    for (const { event, fn } of rootHandlers) {
      if (event === 'agent/created') fn({ agent, source: 'fresh', signal: undefined })
    }
  }

  return {
    create(agent) {
      ensure(agent)
      return agent
    },
    async fire(agent) {
      ensure(agent)
      for (const { event, fn } of rootHandlers) {
        if (event === 'agent/turn-stopping') await fn({ agent, signal: { aborted: false } })
      }
    },
    /** 触发 agent/error —— 真实载荷里没有 agent。 */
    async fail(agent, error, turn = 1) {
      ensure(agent)
      for (const { event, fn } of scoped.get(agent) ?? []) {
        if (event === 'agent/error') await fn({ turn, step: 1, error })
      }
      // 自动重跑是 `void` 起的异步分支，给它一个宏任务落地
      await new Promise(resolve => setTimeout(resolve, 0))
    },
    /** 触发 agent/inbox/claimed —— 真实载荷里没有 agent。 */
    claim(agent, message, turn = 1) {
      ensure(agent)
      for (const { event, fn } of scoped.get(agent) ?? []) {
        if (event === 'agent/inbox/claimed') fn({ message, turn })
      }
    },
  }
}

/**
 * 造一个能接收回填的假 agent。
 * `whenIdle` / `status` / `followup` 齐全，这样自动重跑那条分支也能被驱动。
 * @param {{ events?: object[], idle?: boolean }} [options]
 */
function recoverableAgent(options = {}) {
  const appended = []
  const followups = []
  return {
    appended,
    followups,
    status: options.idle === false ? 'running' : 'idle',
    whenIdle: async () => {},
    followup: message => { followups.push(message) },
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
  // 排掉 codearts，让池回到 [trae, loomy]，才能验证「loomy 的下一个（trae）坏、
  // 再下一个」这一绕回语义。
  writeWhitelist({ at: Date.now(), rotateExclude: ['codearts'], models: LIST })
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

test('DeepSeek 官方渠道默认不参与轮换', async () => {
  // 官方渠道在池外：从 codearts 出发，下一个应是 trae（如果 codearts 被排除则是
  // trae；这里显式排官方，验证官方不会被选中/探测）。
  const OFFICIAL = [{ provider: 'deepseek-official', model: 'deepseek-chat' }, LIST[0], LIST[1]]
  writeWhitelist({ at: Date.now(), models: OFFICIAL })
  const sink = {}
  const log = { calls: [] }
  await harness({ llm: fakeLlm(() => 'ok', log) }).fire(agentAt(LIST[1], sink))
  assert.deepStrictEqual(sink.picked, LIST[0], '下一个是池内的 codearts，不是官方渠道')
  assert.ok(!log.calls.some(c => c.startsWith('deepseek-official/')), '绝不探测官方渠道')
})

test('excludeProviders 为空时所有渠道都参与轮换', async () => {
  writeWhitelist({ at: Date.now(), models: LIST })
  const sink = {}
  await harness({ llm: fakeLlm(() => 'ok'), config: { excludeProviders: [] } })
    .fire(agentAt(LIST[0], sink))
  assert.deepStrictEqual(sink.picked, LIST[1])
})

test('白名单的 rotateExclude 覆盖内置默认', async () => {
  // 只排 trae：codearts 是普通渠道、没写进 rotateExclude，因此留在池里
  writeWhitelist({ at: Date.now(), rotateExclude: ['trae'], models: LIST })
  const sink = {}
  await harness({ llm: fakeLlm(() => 'ok') }).fire(agentAt(LIST[0], sink))
  assert.deepStrictEqual(sink.picked, LIST[2], '池里是 codearts + loomy，codearts 的下一个是 loomy')
})

test('显式排掉 codearts 后只剩一个模型时不轮换', async () => {
  writeWhitelist({ at: Date.now(), rotateExclude: ['codearts'], models: [LIST[0], LIST[1]] })
  const sink = {}
  await harness({ llm: fakeLlm(() => 'ok') }).fire(agentAt(LIST[1], sink))
  assert.strictEqual(sink.picked, undefined, '池里只有 trae 自己，不切')
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
  const h = harness({ config: { autoRetryOnFailure: 0 } })
  const agent = recoverableAgent()
  h.claim(agent, userMessage())
  await h.fail(agent, { code: 'QUOTA_EXCEEDED' })
  assert.strictEqual(agent.appended.length, 1)
  assert.strictEqual(agent.appended[0].target, 'next-turn')
  assert.deepStrictEqual(agent.appended[0].message.content, INPUT)
  assert.notStrictEqual(agent.appended[0].message.id, 'm1', '重新入队要用新的消息 id')
})

test('消息已经写进日志时不重复入队', async () => {
  const h = harness({ config: { autoRetryOnFailure: 0 } })
  const agent = recoverableAgent({ events: [{ type: 'user/message', data: { id: 'm1' } }] })
  h.claim(agent, userMessage())
  await h.fail(agent, { code: 'TRANSPORT' })
  assert.strictEqual(agent.appended.length, 0)
})

test('非渠道级错误不动用户输入', async () => {
  const h = harness({ config: { autoRetryOnFailure: 0 } })
  const agent = recoverableAgent()
  h.claim(agent, userMessage())
  await h.fail(agent, { code: 'TOOL_FAILED' })
  assert.strictEqual(agent.appended.length, 0)
})

test('错误属于别的轮次时不入队', async () => {
  const h = harness({ config: { autoRetryOnFailure: 0 } })
  const agent = recoverableAgent()
  h.claim(agent, userMessage(), 1)
  await h.fail(agent, { code: 'QUOTA_EXCEEDED' }, 2)
  assert.strictEqual(agent.appended.length, 0)
})

test('没有 claimed 记录时不入队', async () => {
  const h = harness({ config: { autoRetryOnFailure: 0 } })
  const agent = recoverableAgent()
  await h.fail(agent, { code: 'QUOTA_EXCEEDED' })
  assert.strictEqual(agent.appended.length, 0)
})

test('空内容不入队', async () => {
  const h = harness({ config: { autoRetryOnFailure: 0 } })
  const agent = recoverableAgent()
  h.claim(agent, { id: 'm1', role: 'user', source: { kind: 'user' }, content: [] })
  await h.fail(agent, { code: 'QUOTA_EXCEEDED' })
  assert.strictEqual(agent.appended.length, 0)
})

test('同一段输入反复失败时按上限停止入队', async () => {
  const h = harness({ config: { maxRequeuePerMessage: 2, autoRetryOnFailure: 0 } })
  const agent = recoverableAgent()
  for (let i = 0; i < 5; i++) {
    h.claim(agent, userMessage(`m${i}`))
    await h.fail(agent, { code: 'QUOTA_EXCEEDED' })
  }
  assert.strictEqual(agent.appended.length, 2)
})

test('recoverFailedInput 关掉后不再回填', async () => {
  const h = harness({ config: { recoverFailedInput: false, autoRetryOnFailure: 0 } })
  const agent = recoverableAgent()
  h.claim(agent, userMessage())
  await h.fail(agent, { code: 'QUOTA_EXCEEDED' })
  assert.strictEqual(agent.appended.length, 0)
})

test('子代理失败不回填（那是父代理给的输入）', async () => {
  const h = harness({ namesOf: () => ({ self: 'subagent-1' }), config: { autoRetryOnFailure: 0 } })
  const agent = recoverableAgent()
  h.claim(agent, userMessage())
  await h.fail(agent, { code: 'QUOTA_EXCEEDED' })
  assert.strictEqual(agent.appended.length, 0)
})

test('日志读不了时保守不入队', async () => {
  const h = harness({ config: { autoRetryOnFailure: 0 } })
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
  const h = harness({ config: { autoRetryOnFailure: 0 } })
  const agent = {
    session: { ownEvents: () => [] },
    inbox: { append: () => { throw new Error('boom') } },
    model: { current: () => FREE[0], select: () => {} },
  }
  h.claim(agent, userMessage())
  await h.fail(agent, { code: 'QUOTA_EXCEEDED' })
})

// ---------- 失败后自动换模型重跑 ----------

test('渠道故障时自动切到下一个可用模型，并用同一轮历史重跑', async () => {
  writeWhitelist({ at: Date.now(), models: LIST })
  const h = harness({ llm: fakeLlm(() => 'ok') })
  const sink = {}
  const agent = Object.assign(agentAt(FREE[0], sink), {
    status: 'idle',
    whenIdle: async () => {},
    followup: message => { agent.followups.push(message) },
    followups: [],
  })
  await h.fail(agent, { code: 'QUOTA_EXCEEDED' })
  assert.deepStrictEqual(sink.picked, FREE[1], '切到探测通过的下一个')
  assert.strictEqual(agent.followups.length, 1, '唤醒一次，让这一轮用新模型重跑')
})

test('重跑用的触发消息是 runtime-context，不会在历史里留下用户可见的一行', async () => {
  writeWhitelist({ at: Date.now(), models: LIST })
  const h = harness({ llm: fakeLlm(() => 'ok') })
  const agent = Object.assign(agentAt(FREE[0], {}), {
    status: 'idle',
    whenIdle: async () => {},
    followups: [],
    followup: message => { agent.followups.push(message) },
  })
  await h.fail(agent, { code: 'TRANSPORT' })
  assert.strictEqual(agent.followups[0].source.kind, 'runtime-context')
})

test('agent 不空闲时不插队，交给用户的下一次输入', async () => {
  writeWhitelist({ at: Date.now(), models: LIST })
  const h = harness({ llm: fakeLlm(() => 'ok') })
  const sink = {}
  const agent = Object.assign(agentAt(FREE[0], sink), {
    status: 'running',
    whenIdle: async () => {},
    followups: [],
    followup: message => { agent.followups.push(message) },
  })
  await h.fail(agent, { code: 'QUOTA_EXCEEDED' })
  assert.strictEqual(agent.followups.length, 0, '不抢正在跑的那一轮')
  assert.deepStrictEqual(sink.picked, FREE[1], '但模型已经换好，下一次输入就用它')
})

test('自动重跑达到上限后停下，不再唤醒', async () => {
  writeWhitelist({ at: Date.now(), models: LIST })
  const h = harness({ llm: fakeLlm(() => 'ok'), config: { autoRetryOnFailure: 1 } })
  const agent = Object.assign(agentAt(FREE[0], {}), {
    status: 'idle',
    whenIdle: async () => {},
    followups: [],
    followup: message => { agent.followups.push(message) },
  })
  await h.fail(agent, { code: 'QUOTA_EXCEEDED' })
  await h.fail(agent, { code: 'QUOTA_EXCEEDED' })
  assert.strictEqual(agent.followups.length, 1, '额度只有 1 次')
})

test('一轮顺利跑完后重试额度清零', async () => {
  writeWhitelist({ at: Date.now(), models: LIST })
  const h = harness({ llm: fakeLlm(() => 'ok'), config: { autoRetryOnFailure: 1 } })
  const agent = Object.assign(agentAt(FREE[0], {}), {
    status: 'idle',
    whenIdle: async () => {},
    followups: [],
    followup: message => { agent.followups.push(message) },
  })
  await h.fail(agent, { code: 'QUOTA_EXCEEDED' })
  await h.fire(agent) // 一轮正常结束
  await h.fail(agent, { code: 'QUOTA_EXCEEDED' })
  assert.strictEqual(agent.followups.length, 2, '成功一轮后额度还回来')
})

test('关掉自动重跑时才走回填', async () => {
  writeWhitelist({ at: Date.now(), models: LIST })
  const h = harness({ llm: fakeLlm(() => 'ok'), config: { autoRetryOnFailure: 0 } })
  const agent = recoverableAgent()
  h.claim(agent, userMessage())
  await h.fail(agent, { code: 'QUOTA_EXCEEDED' })
  assert.strictEqual(agent.followups.length, 0)
  assert.strictEqual(agent.appended.length, 1, '退回队列让用户手工重发')
})

test('换不到可用模型时回落到回填输入', async () => {
  writeWhitelist({ at: Date.now(), models: LIST })
  // 所有候选都探测失败 → pickNext 返回 undefined
  const h = harness({ llm: fakeLlm(() => 'fail') })
  const agent = recoverableAgent()
  h.claim(agent, userMessage())
  await h.fail(agent, { code: 'QUOTA_EXCEEDED' })
  assert.strictEqual(agent.followups.length, 0)
  assert.strictEqual(agent.appended.length, 1, '换不到模型也不能把输入丢掉')
})

test('非渠道级错误不触发自动重跑', async () => {
  writeWhitelist({ at: Date.now(), models: LIST })
  const h = harness({ llm: fakeLlm(() => 'ok') })
  const agent = Object.assign(agentAt(FREE[0], {}), {
    status: 'idle',
    whenIdle: async () => {},
    followups: [],
    followup: message => { agent.followups.push(message) },
  })
  await h.fail(agent, { code: 'TOOL_FAILED' })
  assert.strictEqual(agent.followups.length, 0)
})

// ---------- 回归：这两个事件的载荷里没有 agent ----------

test('agent/error 与 agent/inbox/claimed 都按 agent 注册，不依赖载荷里的 agent', async () => {
  const h = harness({ config: { autoRetryOnFailure: 0 } })
  const agent = recoverableAgent()
  // harness 只在 agent.ctx 上投递，载荷里没有 agent 字段
  h.claim(agent, userMessage())
  await h.fail(agent, { code: 'QUOTA_EXCEEDED' })
  assert.strictEqual(agent.appended.length, 1, '能在 agent.ctx 上收到事件并拿到 agent')
})
