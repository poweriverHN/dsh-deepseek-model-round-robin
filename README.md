# dsh-deepseek-model-round-robin

每轮对话结束后，自动把**下一次**要用的模型切到白名单里的下一个可用项。

动机很实际：经费紧张时主要靠各渠道的免费 DeepSeek 额度。老盯着一个模型薅，单渠道额度很快见底。让多个已确认可用的模型轮流承接对话，整体可用时间就长得多——而且不用手动去点选择器。

## 行为

| 场景 | 结果 |
| --- | --- |
| 当前模型在免费池里 | 探到下一个**探测通过**的模型后切过去 |
| 下一个候选探测失败 | 顺延到再下一个，最多并行探 `verifyCandidates` 个 |
| 候选全部探测失败 | **保持当前模型不切换**（宁可不动，也不切断任务） |
| 当前模型是付费/官方模型 | 切到免费池里的可用候选，**绝不从付费模型继续往下轮** |
| 付费/官方渠道 | 默认不参与轮换，仍可手动选 |
| 轮换池排完只剩 0 或 1 个 | 不轮换 |
| 白名单缺失 / 过期 / 解析失败 | 保持当前模型不变 |
| 子代理（subagent） | 默认跳过，不轮换 |
| 模型调用失败，且该轮输入没落盘 | **把输入放回待发队列**，换模型后可重发（见下节） |
| 任何异常 | 静默吞掉，绝不影响对话 |

## 失败时保住你的输入

DSH 开启一步时先解析模型路由、准备适配器，**成功之后**才把用户消息写进会话日志。
如果模型路由在这一步就失败（额度用尽、渠道连不上、模型下架、凭据失效），会变成这样：

1. 消息已经离开 inbox（被"取走"了）
2. 又没进会话日志
3. 对话列表里看不到它，输入框也早就清空了
4. 内容只剩日志里的 inbox 内部记录 —— 只能重打

轮换降低失败概率，这一步兜住失败的后果：把原文放回 `next-turn` 待发队列。
队列就在输入框上方，**可以就地编辑、单条发送、删除**。换个模型点发送就行。

判定条件（三个都满足才动）：

- 错误码属于渠道级故障或上下文容量故障
- 该消息**没有**出现在会话日志的 `user/message` 里（否则内容没丢，无需重复）
- 同一段原文累计回填次数没超过 `maxRequeuePerMessage`

回填调用发生在 `whenIdle()` **之后**：`turn()` 在失败后还会检查一次待发队列，
若在错误回调里同步入队，驱动会立刻再开一轮把消息吃掉，用户反而看不到它。

## 失败后自动换模型重跑

回填是最后一道防线。更常见的情况是这条消息**已经写进日志**了（DSH 在发请求前就落盘），
内容没丢，但这一轮任务断了。这时插件会先尝试自愈，**按失败类型分流**：

1. 把出故障的模型记账为不可用，下一轮轮换避开它
2. 换模型：
   - **渠道故障**（`QUOTA`、`TRANSPORT`、`AUTH` 等）→ 往前换到下一个探测通过的模型
   - **目标模型撑不住上下文**（`MODEL_SWITCH_COMPACTION_FAILED`）→
     **退回上一个真正提交过请求的模型**（取自 `session.requestHeader()`）。
     这种情况继续往前轮换没有意义，只会再撞一次
3. 唤醒驱动，**用同一轮历史重新发一次请求**

第 3 步能成立，是因为失败时用户那条消息已经在日志里（或在回填路径里由队列重新提交），
模型下一次请求会自然带上它 —— 只要能再发起一次请求，这一轮就被救回来了。

叫醒驱动用的是一条 `runtime-context` 类型的隐形消息：DSH 对这类消息只提交当前的运行时
上下文快照、不提交消息本身，所以它**不会在对话历史里留下多出来的一行**，你看不到任何痕迹。

额度由 `autoRetryOnFailure`（默认 2）控制，一轮顺利跑完之后清零。用尽或换不到可用模型时，
才回落到上面的「放回队列」，让你手工换模型重发。

**额度耗尽的隔离期单独算**：`QUOTA` / `ACCOUNT_QUOTA` / `QUOTA_EXCEEDED` 不是抖动，
要人工充值才恢复。用探测的 15 分钟 TTL 记账，它每 15 分钟就会回到轮换池，
下一次轮换切过去再失败一次，用户又白看一遍「本轮运行失败」。所以这类码按
`quotaQuarantineMs`（默认 6 小时）隔离。

> 放回的是队列而不是输入框正文：草稿正文归客户端 shell 的 Lexical 编辑器所有，
> Host 侧没有稳定写入口。

## 切换前的可用性检查

白名单是巡检脚本上一次跑出来的**快照**（最长可能几小时前），期间渠道可能已经挂掉。
切过去才发现不可用，这一轮任务就断了。所以切换前会做一次**真实调用探测**：

1. 从当前模型的下一个开始，按轮换顺序取候选
2. **先查上下文容量**：`llm.resolveModelInfo()` 里 `context` 为空的候选直接跳过（见下）
3. 探测结果**缓存 15 分钟**：缓存里标记健康的直接用，标记不健康的直接跳过（不重复打网络）
4. 遇到未知状态的候选，**并行**探测最多 `verifyCandidates`（默认 3）个，总耗时封顶一个超时
5. 取顺序上第一个探测通过的切过去
6. 一个都没通过 → 保持当前模型不动

探测就是一次 `max_tokens: 1` 的真实请求，成功与否只看流的 `finish` 帧。

**代价**：每轮回复结束时可能多等 1～3 秒（健康渠道的探测很快）；成本约每 15 分钟 3 次 1-token 调用。
缓存命中时不打任何网络。不想要这个开销就设 `verifyBeforeSwitch: false`，退回「只信白名单」。

### 为什么探测之外还要查容量

DSH 的模型切换压缩要求目标模型具备**已声明的上下文容量**
（`llm.resolveModelInfo(provider, model).context`），**历史再短也一样**。
适配器没给某个模型声明 `contextWindow` 时，切过去会立刻以
`MODEL_SWITCH_COMPACTION_FAILED` 结束整轮，用户那条消息白打。

这种模型不一定「探测不过」—— 1-token 探测调用量极小，照样能通过。
所以容量要在探测**之前**单独问一次，把这类模型挡在轮换之外。
两项检查共用同一份 15 分钟缓存，因此每个候选最多每 15 分钟问一次。

容量闸门**同时**挂在 `pickNext` 和 `probe` 上，不是只挂在探测里：
`verifyBeforeSwitch: false` 时 `pickNext` 根本不探测，若闸门只在 `probe` 里，
那条路径就完全没有保护 —— 2026-11-09 本机巡检正是被
`raccoon/sn-deepseek-v4-1-flash-1016`（没上报 `contextWindow`）在这条路径上打死的。
`health` 缓存命中「可用」的候选会跳过容量问询，因为 `probe` 是「先过容量、再探测」，
`ok: true` 已经隐含容量合格。

### 错误码有两套，两套都要认

DSH 里的失败码来自两个地方，**名字不通用**：

1. **核心** `@deepseek-ai/dsh-llm` 的 `*_CODE` 常量 —— 注意常量名和值不一样：
   `QUOTA_EXCEEDED_CODE === 'QUOTA'`、`ACCOUNT_QUOTA_EXCEEDED_CODE === 'ACCOUNT_QUOTA'`。
   pi-ai 那条路把上游错误归一成 `AUTH` / `QUOTA` / `RATE_LIMIT` / `INVALID_REQUEST` /
   `SERVER` / `TIMEOUT` / `TRANSPORT` / `PI_AI_ERROR`。
2. **`dsh-our-free-model` 的 channel-pack** —— 它自建 `LlmError` 时用自己的码，
   其中 `QUOTA_EXCEEDED`（带后缀）是真实存在、真会被抛的：loomy、trae、qoder
   额度耗尽时抛的就是它。

历史上这张表曾经一半是凭印象写的，改过一轮：

| 曾经写的 | 结论 |
| --- | --- |
| `QUOTA_EXCEEDED` | 一度被当成假码删掉，**删错了** —— pack 真的抛这个码。2026-11-20 loomy 报「积分余额不足 / QUOTA_EXCEEDED」时自动切换没有触发，就是这条 |
| `RATE_LIMITED` | 假码，真实是 `RATE_LIMIT` |
| `UNAUTHORIZED` | 假码，真实是 `AUTH`、`ACCOUNT_TOKEN_INVALID` |
| `UNAVAILABLE` | 假码，真实是 `SERVER`、`TRANSPORT` |
| `NO_CREDENTIAL` | 假码，真实是 `MISSING_CREDENTIAL`、`NO_CREDENTIAL_STORE` |

教训：不要按「DSH 核心里应该只有这些」去删条目。pack 的码不在核心码表里，
删掉就等着某天自动切换静默失效。要用就直读 `pack.js` 里 `new LlmError(...)` 的第二个参数。

**失败反馈**：如果探测通过、但真正调用时失败（两者之间的时间差），
`agent/error` 会按错误码把该模型记账为不可用，下一轮不再选它，
并按类型换模型重跑（见上一节）。工具报错之类的不会错杀健康模型。

> `agent/error` 与 `agent/inbox/claimed` 的载荷里**没有 `agent`**
> （分别是 `{ turn, step, error }` 和 `{ message, turn }`）。
> 所以这两个监听必须挂在 `agent/created` 拿到的 `agent.ctx` 上、用闭包捕获 agent；
> 挂在根 `ctx` 上拿到的永远是 `undefined`，整套回填与记账会**静默失效**。

> 回填**必须等这一轮彻底跑完**再入队。`turn()` 在 catch 之后会检查
> `if (!this.inbox.hasPending) return false` —— 若在 `agent/error` 里同步入队，
> 驱动会立刻再开一轮、把刚放回去的消息吃掉，于是「回显到输入框」变成「消息凭空消失」。

故障时日志（`warn` 级）会带上每个候选的失败原因，例如：

```
round-robin: 候选全部探测失败：raccoon/sn-deepseek-v4-1-flash(QUOTA)、trae/DeepSeek-V4-Pro(TRANSPORT)
```

轮换发生在 `agent/turn-stopping`（一轮回复完成、turn 即将关闭时）。写入的是 `agent.model.select()`，**下一条用户消息**才生效，当前这轮不会被打断。

## 安装

```bash
git clone https://github.com/poweriverHN/dsh-deepseek-model-round-robin.git
cd dsh-deepseek-model-round-robin

dsh plugin install link:/path/to/dsh-deepseek-model-round-robin
```

或：

```
plugin_manager  action=install_bundle  target=link:/path/to/dsh-deepseek-model-round-robin
```

纯 Host 侧 ESM，没有客户端代码，装完刷新页面即可。

## 白名单格式

和 [`dsh-deepseek-picker-filter`](https://github.com/poweriverHN/dsh-deepseek-picker-filter) 共用同一份文件：

```json
{
  "at": 1793846236768,
  "staleAfterMinutes": 180,
  "rotateExclude": ["deepseek-official", "deepseek-account"],
  "models": [
    { "provider": "trae", "model": "DeepSeek-V4-Pro" },
    { "provider": "loomy", "model": "deepseek-v4-flash-0731" },
    { "provider": "raccoon", "model": "sn-deepseek-v4-1-flash" }
  ]
}
```

| 字段 | 含义 |
| --- | --- |
| `at` | 巡检完成时间戳（毫秒）。超过 `staleAfterMinutes` 后白名单失效，不轮换 |
| `staleAfterMinutes` | 过期阈值，缺省 180 |
| `rotateExclude` | 不参与轮换的渠道；缺省 `["deepseek-official","deepseek-account"]` |
| `models[].provider` | 渠道 id；省略时退化为用模型 id 当渠道 id |
| `models[].model` | 模型 id |

`models` 的顺序就是轮换顺序。`rotateExclude` 里的渠道会先被踢掉，剩下的才参与轮换。

## 为什么官方渠道永远不参与轮换

轮换的初衷是别把单一渠道的额度薅干。DeepSeek **官方**渠道（`deepseek-official`、`deepseek-account`）走的是你自己的付费额度，一旦被自动切进去，就会在你不注意的时候产生真实费用 —— 这跟初衷相反。

所以 `deepseek-official` / `deepseek-account` **恒在排除名单里**：配置里把 `excludeProviders` 写成 `[]` 也去不掉，白名单里把 `rotateExclude` 写成 `[]` 同样去不掉。这两个渠道在选择器里照常可见、随时可以手动选，只是不会被自动切过去。

其余渠道（包括 `codearts`、`workbuddy-ai`、`workbuddy-cn` 这类带付费型号的第三方渠道）只要巡检能调通，就照常参与轮换：它们的额度是按渠道结算的赠送/订阅额度，轮换本来就是为了在这些渠道之间摊开用量。

配置与白名单的排除名单都是**只增不减**：

```yaml
config:
  excludeProviders: ['loomy']   # 在官方渠道之外，再排掉 loomy
```

```json
{ "rotateExclude": ["lobsterai"] }
```

两者会合并，再并上内置的官方渠道，一起从轮换池里滤掉。

## 配置

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `whitelistPath` | 见下 | 白名单路径 |
| `excludeProviders` | `null` | 在官方渠道之外额外排除的渠道；与白名单 `rotateExclude` 合并，只能加、不能减 |
| `verifyBeforeSwitch` | `true` | 切换前是否做真实调用探测 |
| `verifyTimeoutMs` | `8000` | 单次探测超时 |
| `verifyTtlMs` | `900000` | 探测结果缓存时长（15 分钟） |
| `verifyCandidates` | `3` | 每轮并行探测的候选上限 |
| `quotaQuarantineMs` | `21600000` | 额度耗尽类失败的隔离时长（6 小时）；`0` = 不隔离，退回探测 TTL |
| `includeSubagents` | `false` | 设为 `true` 让子代理也参与轮换 |
| `autoRetryOnFailure` | `2` | 渠道故障后自动换模型重跑的轮数上限；`0` = 只回填、不自动重跑 |
| `recoverFailedInput` | `true` | 重跑用尽后是否把本轮输入放回队列 |
| `maxRequeuePerMessage` | `2` | 同一段输入最多被放回队列几次 |
| `statePrefix` | `round-robin` | 日志前缀 |

`whitelistPath` 解析顺序：插件配置 > 环境变量 `DSH_DEEPSEEK_WHITELIST` > `~/.dsh/deepseek-whitelist.json`。

```yaml
- insert:
    - id: deepseek-model-round-robin
      name: 'dsh-deepseek-model-round-robin'
      config:
        whitelistPath: /home/me/patrol/whitelist.json
        excludeProviders: ['deepseek-official', 'deepseek-account']
        verifyBeforeSwitch: true
        verifyCandidates: 3
        includeSubagents: false
        autoRetryOnFailure: 2
```

### 白名单路径为什么不写进插件自带的 patch

本仓库的 `cordis.patch.yml` 永远是 `config: {}`，**不放任何具体路径**。
一条 `/workspace/...` 或 `C:\...` 这样的路径一旦跟着代码走，换台机器装就必然读不到白名单，
而白名单读不到的后果是四个渠道的全部模型一起摊进选择器。

机器相关的路径放在**该机器 profile 的 `cordis.patch.yml`** 里（loader 会在所有 bundle 层之后应用它，
`- id:` 定向覆盖整段 `config`）：

```yaml
# $DSH_HOME/profiles/<name>/cordis.patch.yml —— 只属于这台机器，不进 git
- id: deepseek-model-round-robin
  name: 'dsh-deepseek-model-round-robin'
  config:
    whitelistPath: /workspace/dsh使用/免费模型巡检/whitelist.json
```

路径全用 `node:path` / `os.homedir()` 拼接，没有写死的分隔符，Windows 与 Linux 同一份代码可用；
仓库里也不该出现任何绝对路径。

## 为什么默认跳过子代理

子代理常常是被父代理按特定能力挑出来的（比如某个长上下文模型）。轮换会把它换掉，违背挑选意图。需要时用 `includeSubagents: true` 打开。

## 失败安全

轮换、探测、重跑和回填都是锦上添花的东西，所以每个回调都包在 try/catch 里：

- 白名单不可用 → 不轮换，保持原样
- `agent.model` 缺失或 `select()` 抛错 → 忽略
- 信号已中止（用户取消） → 不轮换
- 读不到会话日志 → 当作「消息已记录」，不重复回填
- `inbox.append` 抛错 → 忽略
- 自动重跑换不到模型 → 回落到回填
- `resolveModelInfo` 不可用或抛错 → 不拦，退回「只信探测」
- 拿不到 `llm` 服务 → 退回「只信白名单」的旧行为

最坏情况就是「模型不轮换了」或「输入没回填」，不会让对话失败。

## 配套插件

- [`dsh-deepseek-picker-filter`](https://github.com/poweriverHN/dsh-deepseek-picker-filter) —— 选择器只列巡检确认可用的模型。两个插件读同一份白名单，可以单独用，也可以一起用。

## License

MIT