/**
 * 每次对话轮次结束后，自动把下一次用的模型切到白名单里的下一个可用项。
 *
 * 动机：经费紧张时主要靠各渠道的免费 DeepSeek 额度。老盯着一个模型薅，
 * 单渠道额度很快耗尽。让多个已确认可用的模型轮流承接对话，整体可用时间更长。
 *
 * 原理：监听 `agent/turn-stopping`（一轮模型回复完成、turn 即将关闭时），
 * 读巡检白名单，找到当前模型的下一个，通过 `agent.model.select()` 记录。
 * 下一条用户消息就用新模型，无需手动切换。
 *
 * - 白名单不可用（缺失/过期/解析失败）→ 保持当前模型，绝不打断对话
 * - 白名单只有一个模型 → 不轮换
 * - 当前模型不在白名单里 → 从白名单第一个开始
 * - 任何异常都静默吞掉：这是锦上添花的插件，不该影响正常使用
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DEFAULT_STALE_MINUTES = 180

/**
 * 解析白名单路径：显式配置 > 环境变量 > `~/.dsh/deepseek-whitelist.json`。
 * @param {string | undefined} configured
 * @returns {string}
 */
function resolveWhitelistPath(configured) {
  if (typeof configured === 'string' && configured !== '') return configured
  const fromEnv = process.env.DSH_DEEPSEEK_WHITELIST
  if (typeof fromEnv === 'string' && fromEnv !== '') return fromEnv
  return path.join(os.homedir(), '.dsh', 'deepseek-whitelist.json')
}

/** 在列表里找 current 的下标；找不到返回 -1。 */
function indexOf(list, current) {
  for (let i = 0; i < list.length; i++) {
    const entry = list[i]
    if (entry.provider === current.provider && entry.model === current.model) return i
  }
  return -1
}

export const name = 'deepseek-model-round-robin'
export const inject = { required: ['agents'], optional: ['subagents'] }

export function apply(ctx, config) {
  const whitelistPath = resolveWhitelistPath(config?.whitelistPath)
  const skipSubagents = config?.includeSubagents !== true
  const statePrefix = typeof config?.statePrefix === 'string' ? config.statePrefix : 'round-robin'

  let cachedMtime = -1
  let cachedModels = null
  let cachedAt = 0
  let cachedStaleMs = DEFAULT_STALE_MINUTES * 60_000

  /** 读取白名单列表；不可用时返回 undefined。 */
  function readRotationList() {
    let stat
    try {
      stat = fs.statSync(whitelistPath)
    } catch {
      return undefined
    }
    if (stat.mtimeMs !== cachedMtime || cachedModels === null) {
      try {
        const parsed = JSON.parse(fs.readFileSync(whitelistPath, 'utf8'))
        if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.models)) return undefined
        const list = []
        for (const row of parsed.models) {
          if (!row || typeof row.model !== 'string' || row.model === '') continue
          list.push({
            provider: typeof row.provider === 'string' && row.provider !== '' ? row.provider : row.model,
            model: row.model,
          })
        }
        if (list.length === 0) return undefined
        cachedModels = list
        cachedAt = Number(parsed.at) || 0
        cachedStaleMs = (Number(parsed.staleAfterMinutes) > 0 ? Number(parsed.staleAfterMinutes) : DEFAULT_STALE_MINUTES) * 60_000
        cachedMtime = stat.mtimeMs
      } catch {
        return undefined
      }
    }
    if (!Number.isFinite(cachedAt) || cachedAt <= 0) return undefined
    if (Date.now() - cachedAt > cachedStaleMs) return undefined
    return cachedModels
  }

  /** 是否是子代理（默认不轮换子代理）。服务不可用时一律当作根代理。 */
  function isSubagent(agent) {
    if (!skipSubagents) return false
    try {
      const names = ctx.subagents?.namesOf?.(agent)
      return names !== undefined && names.self !== 'lead'
    } catch {
      return false
    }
  }

  ctx.on('agent/turn-stopping', ({ agent, signal }) => {
    try {
      if (signal.aborted) return
      if (isSubagent(agent)) return

      const list = readRotationList()
      if (list === undefined || list.length <= 1) return

      const current = agent.model?.current?.()
      if (current === undefined || typeof current.provider !== 'string' || typeof current.model !== 'string') return

      const pos = indexOf(list, current)
      const next = list[pos < 0 ? 0 : (pos + 1) % list.length]
      if (next.provider === current.provider && next.model === current.model) return

      agent.model.select(next)
      ctx.logger?.debug?.(`${statePrefix}: ${current.provider}/${current.model} -> ${next.provider}/${next.model}`)
    } catch {
      // 失败安全：轮换是锦上添花，任何异常都不该影响对话
    }
  })
}