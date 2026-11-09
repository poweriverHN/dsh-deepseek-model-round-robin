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

- 错误码属于渠道级故障
- 该消息**没有**出现在会话日志的 `user/message` 里（否则内容没丢，无需重复）
- 同一段原文累计回填次数没超过 `maxRequeuePerMessage`

队列**不会自动触发重跑**。唯一例外是你当时还有待处理的 steering，
那时驱动的收尾可能唤醒队列——这种情况下重发的消息会用同一个坏模型再失败一次，
但被 `maxRequeuePerMessage`（默认 2）兜住，不会死循环。

> 放回的是队列而不是输入框正文：草稿正文归客户端 shell 的 Lexical 编辑器所有，
> Host 侧没有稳定写入口。

## 切换前的可用性检查

白名单是巡检脚本上一次跑出来的**快照**（最长可能几小时前），期间渠道可能已经挂掉。
切过去才发现不可用，这一轮任务就断了。所以切换前会做一次**真实调用探测**：

1. 从当前模型的下一个开始，按轮换顺序取候选
2. 探测结果**缓存 15 分钟**：缓存里标记健康的直接用，标记不健康的直接跳过（不重复打网络）
3. 遇到未知状态的候选，**并行**探测最多 `verifyCandidates`（默认 3）个，总耗时封顶一个超时
4. 取顺序上第一个探测通过的切过去
5. 一个都没通过 → 保持当前模型不动

探测就是一次 `max_tokens: 1` 的真实请求，成功与否只看流的 `finish` 帧。

**代价**：每轮回复结束时可能多等 1～3 秒（健康渠道的探测很快）；成本约每 15 分钟 3 次 1-token 调用。
缓存命中时不打任何网络。不想要这个开销就设 `verifyBeforeSwitch: false`，退回「只信白名单」。

**失败反馈**：如果探测通过、但真正调用时失败（两者之间的时间差），
`agent/error` 会按错误码把该模型记账为不可用，下一轮不再选它。
只有渠道级错误码（`QUOTA_EXCEEDED`、`TRANSPORT`、`AUTH`、`UNAVAILABLE`、`UNKNOWN_MODEL` 等）
才会触发，工具报错之类的不会错杀健康模型。

故障时日志（`warn` 级）会带上每个候选的失败原因，例如：

```
round-robin: 候选全部探测失败：raccoon/sn-deepseek-v4-1-flash(QUOTA_EXCEEDED)、trae/DeepSeek-V4-Pro(TRANSPORT)
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
  "rotateExclude": ["deepseek-official", "deepseek-account", "codearts"],
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
| `rotateExclude` | 不参与轮换的渠道；缺省 `["deepseek-official","deepseek-account","codearts"]` |
| `models[].provider` | 渠道 id；省略时退化为用模型 id 当渠道 id |
| `models[].model` | 模型 id |

`models` 的顺序就是轮换顺序。`rotateExclude` 里的渠道会先被踢掉，剩下的才参与轮换。

## 付费渠道为什么不轮换

轮换的初衷是别把单一免费渠道的额度薅干。付费/官方渠道一旦被自动切进去，就会在你不注意的时候产生真实费用 —— 这跟初衷相反。

所以默认把 `deepseek-official`、`deepseek-account`、`codearts` 排除在轮换池外。它们在选择器里照常可见、随时可以手动选，只是不会被自动切过去。

需要让付费渠道也参与轮换时：

```yaml
config:
  excludeProviders: []        # 空数组 = 不排除任何渠道
```

或在白名单里把 `rotateExclude` 写成 `[]`。两者都省略时用内置默认。

## 配置

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `whitelistPath` | 见下 | 白名单路径 |
| `excludeProviders` | 见下 | 不参与轮换的渠道；省略时读白名单 `rotateExclude`，再缺省用三个付费渠道 |
| `verifyBeforeSwitch` | `true` | 切换前是否做真实调用探测 |
| `verifyTimeoutMs` | `8000` | 单次探测超时 |
| `verifyTtlMs` | `900000` | 探测结果缓存时长（15 分钟） |
| `verifyCandidates` | `3` | 每轮并行探测的候选上限 |
| `includeSubagents` | `false` | 设为 `true` 让子代理也参与轮换 |
| `recoverFailedInput` | `true` | 模型失败时是否把本轮输入放回队列 |
| `maxRequeuePerMessage` | `2` | 同一段输入最多被放回队列几次 |
| `statePrefix` | `round-robin` | 日志前缀 |

`whitelistPath` 解析顺序：插件配置 > 环境变量 `DSH_DEEPSEEK_WHITELIST` > `~/.dsh/deepseek-whitelist.json`。

```yaml
- insert:
    - id: deepseek-model-round-robin
      name: 'dsh-deepseek-model-round-robin'
      config:
        whitelistPath: /home/me/patrol/whitelist.json
        excludeProviders: ['deepseek-official', 'deepseek-account', 'codearts']
        verifyBeforeSwitch: true
        verifyCandidates: 3
        includeSubagents: false
```

## 为什么默认跳过子代理

子代理常常是被父代理按特定能力挑出来的（比如某个长上下文模型）。轮换会把它换掉，违背挑选意图。需要时用 `includeSubagents: true` 打开。

## 失败安全

轮换和回填都是锦上添花的东西，所以每个回调都包在 try/catch 里：

- 白名单不可用 → 不轮换，保持原样
- `agent.model` 缺失或 `select()` 抛错 → 忽略
- 信号已中止（用户取消） → 不轮换
- 读不到会话日志 → 当作「消息已记录」，不重复回填
- `inbox.append` 抛错 → 忽略

最坏情况就是「模型不轮换了」或「输入没回填」，不会让对话失败。

## 配套插件

- [`dsh-deepseek-picker-filter`](https://github.com/poweriverHN/dsh-deepseek-picker-filter) —— 选择器只列巡检确认可用的模型。两个插件读同一份白名单，可以单独用，也可以一起用。

## License

MIT