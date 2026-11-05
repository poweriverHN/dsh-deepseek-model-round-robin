/**
 * 用假 ctx / 假 agent 跑一遍轮换逻辑：下一个、回环、不在列表、过期、单元素、子代理、异常。
 * 运行：node --test
 */
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { apply } from './index.js'

const LIST = [
  { provider: 'codearts', model: 'deepseek-v4.1-flash' },
  { provider: 'trae', model: 'DeepSeek-V4-Pro' },
  { provider: 'loomy', model: 'deepseek-v4-flash-0731' },
]

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'round-robin-'))
const whitelist = path.join(tmp, 'whitelist.json')

/** 写一份白名单。 */
function writeWhitelist(value) {
  fs.writeFileSync(whitelist, JSON.stringify(value))
  // mtime 可能落在同一毫秒，强制刷新，避免命中上一份缓存
  const bumped = new Date(Date.now() + Math.floor(Math.random() * 1000) + 1)
  fs.utimesSync(whitelist, bumped, bumped)
}

/**
 * 假 ctx + 触发一次 turn-stopping。
 * @param {(() => { self: string }) | undefined} namesOf 可选的 subagents.namesOf 桩
 */
function harness(namesOf) {
  const handlers = []
  const ctx = {
    on: (event, fn) => { handlers.push({ event, fn }) },
    logger: { debug: () => {} },
    subagents: namesOf === undefined ? undefined : { namesOf },
  }
  apply(ctx, { whitelistPath: whitelist })
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

test('切到列表里的下一个', async () => {
  writeWhitelist({ at: Date.now(), models: LIST })
  const sink = {}
  await harness().fire(agentAt(LIST[1], sink))
  assert.deepStrictEqual(sink.picked, LIST[2])
})

test('末尾回环到开头', async () => {
  writeWhitelist({ at: Date.now(), models: LIST })
  const sink = {}
  await harness().fire(agentAt(LIST[2], sink))
  assert.deepStrictEqual(sink.picked, LIST[0])
})

test('当前模型不在列表里时从第一个开始', async () => {
  writeWhitelist({ at: Date.now(), models: LIST })
  const sink = {}
  await harness().fire(agentAt({ provider: 'nope', model: 'nope' }, sink))
  assert.deepStrictEqual(sink.picked, LIST[0])
})

test('白名单过期时不轮换', async () => {
  writeWhitelist({ at: Date.now() - 999 * 60_000, staleAfterMinutes: 180, models: LIST })
  const sink = {}
  await harness().fire(agentAt(LIST[0], sink))
  assert.strictEqual(sink.picked, undefined)
})

test('白名单只有一个模型时不轮换', async () => {
  writeWhitelist({ at: Date.now(), models: [LIST[0]] })
  const sink = {}
  await harness().fire(agentAt(LIST[0], sink))
  assert.strictEqual(sink.picked, undefined)
})

test('子代理默认跳过', async () => {
  writeWhitelist({ at: Date.now(), models: LIST })
  const sink = {}
  await harness(() => ({ self: 'subagent-1' })).fire(agentAt(LIST[0], sink))
  assert.strictEqual(sink.picked, undefined)
})

test('根代理照常轮换', async () => {
  writeWhitelist({ at: Date.now(), models: LIST })
  const sink = {}
  await harness(() => ({ self: 'lead' })).fire(agentAt(LIST[0], sink))
  assert.deepStrictEqual(sink.picked, LIST[1])
})

test('select 抛错被吞掉，不炸掉对话', async () => {
  writeWhitelist({ at: Date.now(), models: LIST })
  const agent = { model: { current: () => LIST[0], select: () => { throw new Error('boom') } } }
  await harness().fire(agent)
})