/**
 * 用假 ctx / 假 agent 跑一遍轮换逻辑：付费渠道排除、下一个、回环、过期、子代理、异常。
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
 * 假 ctx + 触发一次 turn-stopping。
 * @param {object} options
 * @param {(() => { self: string }) | undefined} [options.namesOf] subagents.namesOf 桩
 * @param {object} [options.config] 覆盖插件配置
 */
function harness({ namesOf, config } = {}) {
  const handlers = []
  const ctx = {
    on: (event, fn) => { handlers.push({ event, fn }) },
    logger: { debug: () => {} },
    subagents: namesOf === undefined ? undefined : { namesOf },
  }
  apply(ctx, { whitelistPath: whitelist, ...config })
  return {
    async fire(agent) {
      for (const { event, fn } of handlers) {
        if (event === 'agent/turn-stopping') await fn({ agent, signal: { aborted: false } })
      }
    },
  }
}

/** 记录 select 调用的假 agent。 */
function agentAt(selection, sink) {
  return {
    model: {
      current: () => selection,
      select: (value) => { sink.picked = value },
    },
  }
}

test('付费渠道默认不参与轮换', async () => {
  writeWhitelist({ at: Date.now(), models: LIST })
  const sink = {}
  await harness().fire(agentAt(FREE[0], sink))
  assert.deepStrictEqual(sink.picked, FREE[1], '只在免费渠道之间轮换')
})

test('末尾回环到免费列表开头', async () => {
  writeWhitelist({ at: Date.now(), models: LIST })
  const sink = {}
  await harness().fire(agentAt(FREE[1], sink))
  assert.deepStrictEqual(sink.picked, FREE[0])
})

test('当前用的是付费模型时切到第一个免费渠道', async () => {
  writeWhitelist({ at: Date.now(), models: LIST })
  const sink = {}
  await harness().fire(agentAt(LIST[0], sink))
  assert.deepStrictEqual(sink.picked, FREE[0], '绝不从付费模型再往下轮')
})

test('excludeProviders 为空时付费渠道参与轮换', async () => {
  writeWhitelist({ at: Date.now(), models: LIST })
  const sink = {}
  await harness({ config: { excludeProviders: [] } }).fire(agentAt(LIST[0], sink))
  assert.deepStrictEqual(sink.picked, LIST[1])
})

test('白名单的 rotateExclude 覆盖内置默认', async () => {
  // 只排 trae：codearts 是付费的，但既然没写进 rotateExclude，它就回到池里
  writeWhitelist({ at: Date.now(), rotateExclude: ['trae'], models: LIST })
  const sink = {}
  await harness().fire(agentAt(LIST[0], sink))
  assert.deepStrictEqual(sink.picked, LIST[2], '池里是 codearts + loomy，codearts 的下一个是 loomy')
})

test('排掉付费渠道后只剩一个模型时不轮换', async () => {
  writeWhitelist({ at: Date.now(), models: [LIST[0], LIST[1]] })
  const sink = {}
  await harness().fire(agentAt(LIST[1], sink))
  assert.strictEqual(sink.picked, undefined)
})

test('白名单过期时不轮换', async () => {
  writeWhitelist({ at: Date.now() - 999 * 60_000, staleAfterMinutes: 180, models: LIST })
  const sink = {}
  await harness().fire(agentAt(FREE[0], sink))
  assert.strictEqual(sink.picked, undefined)
})

test('白名单缺失时不轮换', async () => {
  fs.rmSync(whitelist, { force: true })
  const sink = {}
  await harness().fire(agentAt(FREE[0], sink))
  assert.strictEqual(sink.picked, undefined)
})

test('子代理默认跳过', async () => {
  writeWhitelist({ at: Date.now(), models: LIST })
  const sink = {}
  await harness({ namesOf: () => ({ self: 'subagent-1' }) }).fire(agentAt(FREE[0], sink))
  assert.strictEqual(sink.picked, undefined)
})

test('根代理照常轮换', async () => {
  writeWhitelist({ at: Date.now(), models: LIST })
  const sink = {}
  await harness({ namesOf: () => ({ self: 'lead' }) }).fire(agentAt(FREE[0], sink))
  assert.deepStrictEqual(sink.picked, FREE[1])
})

test('select 抛错被吞掉，不炸掉对话', async () => {
  writeWhitelist({ at: Date.now(), models: LIST })
  const agent = { model: { current: () => FREE[0], select: () => { throw new Error('boom') } } }
  await harness().fire(agent)
})