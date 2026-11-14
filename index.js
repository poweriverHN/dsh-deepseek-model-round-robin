/**
 * 每次对话轮次结束后，自动把下一次用的模型切到白名单里的下一个**确认可用**的模型。
 *
 * 动机：经费紧张时主要靠各渠道的免费 DeepSeek 额度。老盯着一个模型薅，
 * 单渠道额度很快耗尽。让多个已确认可用的模型轮流承接对话，整体可用时间更长。
 *
 * 为什么不能只看白名单：白名单是巡检脚本上一次跑出来的快照（最长可能几小时前），
 * 期间渠道可能已经挂掉。切过去才发现不可用，这一轮任务就断了。
 * 所以切换前做一次**真实 1-token 调用**探测，探测不过就顺延到下一个候选。
 *
 * 原理：监听 `agent/turn-stopping`（一轮模型回复完成、turn 即将关闭时），
 * 读巡检白名单 → 过滤掉付费渠道 → 从当前模型的下一个开始，按顺序找第一个
 * 探测通过的模型 → 通过 `agent.model.select()` 记录。下一条用户消息用它。
 *
 * 失败安全（任何一步出错都只是「不轮换」，绝不影响对话本身）：
 * - 白名单不可用（缺失/过期/解析失败）→ 保持当前模型
 * - 候选全部探测失败 → 保持当前模型（宁可花钱也不断任务）
 * - 轮换池排完只剩 0 或 1 个 → 不轮换
 * - llm 服务取不到 → 退回「只信白名单」的旧行为
 * - 任何异常静默吞掉
 */
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DEFAULT_STALE_MINUTES = 180

/**
 * DeepSeek 官方渠道：默认不参与轮换。
 *
 * 用户 2026-11-09 要求只有 DeepSeek 官方排除在外：「不要管收费还是免费，只要
 * 巡检能正常调用都列出来，除了 deepseek 官方的不巡检、不进入轮换名单」。
 * 所以 codearts 已从本表移除——它是普通渠道，照常参与轮换。
 * 被排除的渠道仍可手动选择，只是不会被自动切过去。
 */
const DEFAULT_EXCLUDE_PROVIDERS = ['deepseek-official', 'deepseek-account']

/**
 * 视为「渠道级故障」的错误码。只有这些才把模型标记为不可用，
 * 避免把工具报错、用户取消之类误判成渠道问题而错杀健康模型。
 * 也正因为它们是「可能在用户消息落盘之前就失败」的那一类，
 * 同一个集合被用来判断要不要把本轮输入放回队列。
 */
const CHANNEL_FAILURE_CODES = new Set([
  'QUOTA_EXCEEDED',
  'RATE_LIMITED',
  'TRANSPORT',
  'AUTH',
  'UNAUTHORIZED',
  'UNAVAILABLE',
  'UNKNOWN_MODEL',
  'NO_ADAPTER',
  'NO_CREDENTIAL',
])

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

/** 渠道+模型的唯一键。 */
const keyOf = entry => `${entry.provider}/${entry.model}`

/** 在列表里找 current 的下标；找不到返回 -1。 */
function indexOf(list, current) {
  for (let i = 0; i < list.length; i++) {
    const entry = list[i]
    if (entry.provider === current.provider && entry.model === current.model) return i
  }
  return -1
}

/** 取正整数配置，非法时用默认值。 */
function positive(value, fallback) {
  return Number.isFinite(value) && value > 0 ? Number(value) : fallback
}

/** 把消息内容拼成纯文本，用来做去重键。 */
function textOf(content) {
  if (!Array.isArray(content)) return ''
  return content
    .map(block => (block !== null && typeof block === 'object' && typeof block.text === 'string' ? block.text : ''))
    .join('')
    .trim()
}

/** 这条消息是否已经出现在会话日志里（= 内容没丢，只是模型失败）。 */
function recorded(session, messageId) {
  try {
    for (const event of session.ownEvents()) {
      if (event.type !== 'user/message') continue
      if (event.data?.id === messageId) return true
    }
  } catch {
    // 读不到日志时保守认为已经记录，避免重复入队
    return true
  }
  return false
}

export const name = 'deepseek-model-round-robin'
// 只硬依赖 agents。subagents 是可选能力：装配里没有它时用 ctx.get() 拿不到，
// 就当作没有子代理概念、一律轮换。写成 cordis 的 {required, optional} 是不行的——
// 那是「服务名 → 拦截配置」的映射，会变成等两个不存在的服务，插件永远 pending。
export const inject = ['agents']

export function apply(ctx, config) {
  const whitelistPath = resolveWhitelistPath(config?.whitelistPath)
  const skipSubagents = config?.includeSubagents !== true
  const statePrefix = typeof config?.statePrefix === 'string' ? config.statePrefix : 'round-robin'

  // 配置显式给出时优先（空数组 = 不排除任何渠道，允许付费模型参与轮换）
  const excludeProviders = Array.isArray(config?.excludeProviders)
    && config.excludeProviders.every(id => typeof id === 'string')
    ? config.excludeProviders
    : null

  const verify = config?.verifyBeforeSwitch !== false
  const verifyTimeoutMs = positive(config?.verifyTimeoutMs, 8_000)
  const verifyTtlMs = positive(config?.verifyTtlMs, 15 * 60_000)
  const verifyCandidates = Math.max(1, Math.floor(positive(config?.verifyCandidates, 3)))

  // 失败后是否把本轮输入放回队列（默认开）
  const recoverInput = config?.recoverFailedInput !== false
  const maxRequeue = Math.floor(positive(config?.maxRequeuePerMessage, 2))

  /**
   * 渠道级故障后自动换模型重跑的轮数上限。0 = 关掉自动重跑，只做记账与回填。
   * 默认 2：够跨过一次抖动，整池都挂时也不会无限打转。
   */
  const autoRetryRaw = config?.autoRetryOnFailure
  const autoRetry = Number.isFinite(autoRetryRaw) && autoRetryRaw >= 0 ? Math.floor(autoRetryRaw) : 2

  /** 每个 agent 已自动重跑的轮数；一轮顺利跑完后清零。 */
  const retries = new WeakMap()

  /** 健康度缓存：`provider/model` → { ok, at }。探测结果按 TTL 复用，避免每轮都打网络。 */
  const health = new Map()

  /** 每个 agent 最近一次被取走的用户消息，用于失败后回填。 */
  const claimed = new WeakMap()
  /** 每个 agent 的「原文 → 已重新入队次数」，防止死循环。 */
  const requeued = new WeakMap()

  let cachedMtime = -1
  let cachedModels = null
  let cachedAt = 0
  let cachedStaleMs = DEFAULT_STALE_MINUTES * 60_000
  let cachedExclude = null

  /**
   * 读取白名单并滤掉付费渠道。
   *
   * 排除名单来源（优先级从高到低）：插件配置 `excludeProviders`
   * → 白名单里的 `rotateExclude` → 内置默认（三个付费/官方渠道）。
   * 逐项过滤后只剩 0 或 1 个时返回 undefined，调用方不轮换。
   */
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
        cachedExclude = Array.isArray(parsed.rotateExclude) && parsed.rotateExclude.every(id => typeof id === 'string')
          ? parsed.rotateExclude
          : null
        cachedAt = Number(parsed.at) || 0
        cachedStaleMs = (Number(parsed.staleAfterMinutes) > 0 ? Number(parsed.staleAfterMinutes) : DEFAULT_STALE_MINUTES) * 60_000
        cachedMtime = stat.mtimeMs
      } catch {
        return undefined
      }
    }
    if (!Number.isFinite(cachedAt) || cachedAt <= 0) return undefined
    if (Date.now() - cachedAt > cachedStaleMs) return undefined

    const exclude = excludeProviders ?? cachedExclude ?? DEFAULT_EXCLUDE_PROVIDERS
    const allowed = exclude.length === 0
      ? cachedModels
      : cachedModels.filter(entry => !exclude.includes(entry.provider))
    return allowed.length <= 1 ? undefined : allowed
  }

  /** 是否是子代理（默认不轮换子代理）。服务不可用时一律当作根代理。 */
  function isSubagent(agent) {
    if (!skipSubagents) return false
    try {
      // subagents 不在 inject 里，用 ctx.get() 取：装配没有它时返回 undefined 而不是抛错
      const subagents = ctx.get?.('subagents')
      const names = subagents?.namesOf?.(agent)
      return names !== undefined && names.self !== 'lead'
    } catch {
      return false
    }
  }

  /** 缓存里新鲜的结论；没有则 undefined。 */
  function cachedHealth(entry) {
    const hit = health.get(keyOf(entry))
    if (hit === undefined) return undefined
    return Date.now() - hit.at < verifyTtlMs ? hit.ok : undefined
  }

  /**
   * 对候选发一次真实 1-token 调用，确认它真的能用。
   * 只认流里的 `finish` 帧：reason 为 error/aborted 即失败；正常结束即成功。
   * 失败原因（错误码/异常信息）记进缓存，轮换卡住时能从日志看出为什么。
   * @returns {Promise<boolean>}
   */
  async function probe(entry) {
    const llm = ctx.get?.('llm')
    if (llm === undefined || typeof llm.stream !== 'function') return true // 拿不到 llm 就不拦，退回旧行为

    let ok = false
    let detail = ''
    try {
      const stream = llm.stream({
        provider: entry.provider,
        model: entry.model,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
        maxTokens: 1,
        signal: AbortSignal.timeout(verifyTimeoutMs),
      })
      ok = true // 默认成功；只有明确的失败帧或抛错才翻成 false
      for await (const chunk of stream) {
        if (chunk?.type !== 'finish') continue
        const kind = chunk.reason?.kind
        if (kind === 'error' || kind === 'aborted') {
          ok = false
          detail = chunk.reason?.failure?.code ?? kind
        }
        break
      }
    } catch (error) {
      ok = false
      const code = error?.failure?.code ?? error?.code
      detail = typeof code === 'string' ? code : (error instanceof Error ? error.message : String(error))
    }
    health.set(keyOf(entry), { ok, at: Date.now(), detail })
    return ok
  }

  /**
   * 从 current 之后按轮换顺序挑一个**确认可用**的候选。
   * @returns {Promise<{ provider: string, model: string } | undefined>} undefined = 没有可用候选，保持当前模型
   */
  async function pickNext(list, current) {
    const pos = indexOf(list, current)
    /** 轮换顺序：从当前的下一个开始，绕一圈。current 不在池里时从第一个开始。 */
    const ordered = []
    for (let i = 1; i <= list.length; i++) ordered.push(list[((pos < 0 ? -1 : pos) + i) % list.length])

    if (!verify) return ordered[0]

    // 第一轮：只看缓存。命中的健康项直接选；已知不健康的跳过（不重复打网络）。
    const needProbe = []
    for (const entry of ordered) {
      const known = cachedHealth(entry)
      if (known === true) return entry
      if (known === false) continue
      needProbe.push(entry)
      if (needProbe.length >= verifyCandidates) break
    }

    // 第二轮：把未知的候选并行探测（总耗时封顶一个超时），按顺序取第一个通过的
    if (needProbe.length > 0) {
      const results = await Promise.all(needProbe.map(entry => probe(entry)))
      const hit = results.findIndex(Boolean)
      if (hit >= 0) return needProbe[hit]
      // 全挂：把原因带到日志里，否则「轮换不动」时无从下手
      const why = needProbe
        .map(entry => `${keyOf(entry)}(${health.get(keyOf(entry))?.detail || '未知'})`)
        .join('、')
      ctx.logger?.warn?.(`${statePrefix}: 候选全部探测失败：${why}`)
    }
    return undefined
  }

  ctx.on('agent/turn-stopping', async ({ agent, signal }) => {
    try {
      if (signal.aborted) return
      if (isSubagent(agent)) return

      // 这一轮顺利跑完：把自动重试额度还回去，下一轮重新给满
      retries.set(agent, 0)

      const list = readRotationList()
      if (list === undefined) return

      const current = agent.model?.current?.()
      if (current === undefined || typeof current.provider !== 'string' || typeof current.model !== 'string') return

      const next = await pickNext(list, current)
      if (next === undefined) {
        ctx.logger?.warn?.(`${statePrefix}: 候选均未通过可用性检查，保持 ${keyOf(current)}`)
        return
      }
      if (next.provider === current.provider && next.model === current.model) return

      agent.model.select(next)
      ctx.logger?.debug?.(`${statePrefix}: ${keyOf(current)} -> ${keyOf(next)}`)
    } catch {
      // 失败安全：轮换是锦上添花，任何异常都不该影响对话
    }
  })

  /**
   * 触发一次「用同一轮历史重跑」的隐形消息。
   *
   * 为什么需要它：请求失败时用户那条消息**已经写进日志**了（step 在发请求前就 append），
   * 而 agent 空闲后再唤醒时，若 inbox 为空，`turn()` 会直接判定本轮 completed、不发请求。
   * 所以必须放一条消息进队列把驱动叫起来。
   *
   * 为什么用 runtime-context：step 对这类消息只提交**当前**的运行时上下文快照，
   * 不提交消息本身，所以它不会在对话历史里留下一行，用户看不到任何多余内容。
   */
  function triggerMessage() {
    return {
      id: randomUUID(),
      role: 'user',
      source: { kind: 'runtime-context' },
      content: [],
    }
  }

  /**
   * 把本轮输入放回队列，让用户换模型后能直接重发。
   * 只在内容确实没进日志时使用；已经落盘的消息交给对话列表显示即可，放进队列会重复。
   */
  function queueInputBack(agent, turn, code) {
    if (!recoverInput || isSubagent(agent)) return

    const pending = claimed.get(agent)
    if (pending === undefined || pending.turn !== turn) return

    // 已经写进日志 → 内容没丢，交给对话列表显示即可，不重复入队
    if (recorded(agent.session, pending.message.id)) return

    const text = textOf(pending.message.content)
    if (text === '') return

    // 防循环：同一段原文反复失败时不再无限入队
    let counts = requeued.get(agent)
    if (counts === undefined) {
      counts = new Map()
      requeued.set(agent, counts)
    }
    const count = counts.get(text) ?? 0
    if (count >= maxRequeue) {
      ctx.logger?.warn?.(`${statePrefix}: 同一段输入已重新入队 ${count} 次，本次不再入队，避免死循环`)
      return
    }
    counts.set(text, count + 1)

    // 队列不唤醒驱动：放回去只是为了让用户能换模型后自己重发
    agent.inbox.append('next-turn', {
      id: randomUUID(),
      role: 'user',
      source: { kind: 'user' },
      content: pending.message.content,
    })
    ctx.logger?.info?.(`${statePrefix}: 模型调用失败（${code}），已把该轮输入放回队列，可换模型后重发`)
  }

  /**
   * 渠道级故障的兜底处理，按代价从低到高依次尝试：
   *   1. 把出故障的模型记账为不可用（补上「探测通过」与「真实调用」之间的时间差）
   *   2. 自动换到下一个确认可用的模型，用同一轮历史重跑——用户无感
   *   3. 重跑额度用尽或换不到模型时，把输入放回队列，让用户手工换模型重发
   *
   * 之所以能重跑：用户那条消息失败时已经在日志里了，模型下一轮请求会带上它，
   * 所以只要能再发起一次请求，这一轮就被救回来了。
   */
  async function handleFailure(agent, turn, error) {
    const code = error?.failure?.code ?? error?.code
    if (typeof code !== 'string' || !CHANNEL_FAILURE_CODES.has(code)) return

    const current = agent.model?.current?.()
    const currentKnown = current !== undefined && typeof current.provider === 'string' && typeof current.model === 'string'
    if (currentKnown) {
      health.set(keyOf(current), { ok: false, at: Date.now() })
      ctx.logger?.warn?.(`${statePrefix}: ${keyOf(current)} 调用失败（${code}），暂时移出轮换`)
    }

    // 子代理的输入是父代理给的，重跑与回填都不该由这里做
    if (isSubagent(agent)) return

    const used = retries.get(agent) ?? 0
    if (autoRetry > 0 && used < autoRetry && currentKnown) {
      const list = readRotationList()
      const next = list === undefined ? undefined : await pickNext(list, current)
      if (next !== undefined && !(next.provider === current.provider && next.model === current.model)) {
        retries.set(agent, used + 1)
        agent.model.select(next)
        // 等本轮真正收尾再唤醒：在 agent/error 里同步重入驱动会撞上正在结束的这一轮
        await agent.whenIdle?.()
        if (agent.status === 'idle') {
          agent.followup(triggerMessage())
          ctx.logger?.info?.(
            `${statePrefix}: ${keyOf(current)} 故障（${code}），已自动切到 ${keyOf(next)}，用同一轮历史重试（第 ${used + 1}/${autoRetry} 次）`,
          )
          return
        }
        // 用户已经发了新消息（或 agent 又被唤醒）：让那一轮自然跑，不要插队
        ctx.logger?.info?.(`${statePrefix}: 已切到 ${keyOf(next)}，但 agent 不空闲，交给下一次输入`)
        return
      }
      ctx.logger?.warn?.(`${statePrefix}: 换不到可用模型，本轮不再自动重试`)
    }

    queueInputBack(agent, turn, code)
  }

  /**
   * 每个 Agent 单独注册这两个监听。
   *
   * 必须按 agent 注册而不是在根 ctx 上听：`agent/error` 的载荷是
   * `{ turn, step, error }`、`agent/inbox/claimed` 是 `{ message, turn }`，
   * **都不含 agent**。在根 ctx 上听只能拿到 undefined，回填与记账会静默失效。
   */
  ctx.on('agent/created', ({ agent }) => {
    try {
      const scope = agent?.ctx
      if (scope === undefined || typeof scope.on !== 'function') return

      // 记住每轮被取走的用户消息，失败时可能要把它放回队列
      scope.on('agent/inbox/claimed', ({ message, turn }) => {
        try {
          // 只看真实用户输入。runtime-context 是我们自己的重跑触发器，
          // 若把它记进来，重跑再失败时回填的就是空内容，真正的输入反而被顶掉。
          if (message?.source?.kind === 'runtime-context') return
          claimed.set(agent, { message, turn })
        } catch {
          // 失败安全
        }
      })

      scope.on('agent/error', ({ turn, error }) => {
        // 不能 await：这个事件在 turn 内部同步 emit，等它会和正在收尾的驱动互相死锁
        void handleFailure(agent, turn, error).catch(() => {})
      })
    } catch {
      // 失败安全
    }
  })
}