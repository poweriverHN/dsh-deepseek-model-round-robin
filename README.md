# dsh-deepseek-model-round-robin

每轮对话结束后，自动把**下一次**要用的模型切到白名单里的下一个可用项。

动机很实际：经费紧张时主要靠各渠道的免费 DeepSeek 额度。老盯着一个模型薅，单渠道额度很快见底。让多个已确认可用的模型轮流承接对话，整体可用时间就长得多——而且不用手动去点选择器。

## 行为

| 场景 | 结果 |
| --- | --- |
| 当前模型在白名单里 | 切到列表里的下一个（末尾回到开头） |
| 当前模型不在白名单里 | 从白名单第一个开始 |
| 白名单只有一个模型 | 不轮换 |
| 白名单缺失 / 过期 / 解析失败 | 保持当前模型不变 |
| 子代理（subagent） | 默认跳过，不轮换 |
| 任何异常 | 静默吞掉，绝不影响对话 |

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
  "models": [
    { "provider": "codearts", "model": "deepseek-v4.1-flash" },
    { "provider": "trae", "model": "DeepSeek-V4-Pro" },
    { "provider": "loomy", "model": "deepseek-v4-flash-0731" }
  ]
}
```

| 字段 | 含义 |
| --- | --- |
| `at` | 巡检完成时间戳（毫秒）。超过 `staleAfterMinutes` 后白名单失效，不轮换 |
| `staleAfterMinutes` | 过期阈值，缺省 180 |
| `models[].provider` | 渠道 id；省略时退化为用模型 id 当渠道 id |
| `models[].model` | 模型 id |

`models` 的顺序就是轮换顺序。

## 配置

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `whitelistPath` | 见下 | 白名单路径 |
| `includeSubagents` | `false` | 设为 `true` 让子代理也参与轮换 |
| `statePrefix` | `round-robin` | debug 日志前缀 |

`whitelistPath` 解析顺序：插件配置 > 环境变量 `DSH_DEEPSEEK_WHITELIST` > `~/.dsh/deepseek-whitelist.json`。

```yaml
- insert:
    - id: deepseek-model-round-robin
      name: 'dsh-deepseek-model-round-robin'
      config:
        whitelistPath: /home/me/patrol/whitelist.json
        includeSubagents: false
```

## 为什么默认跳过子代理

子代理常常是被父代理按特定能力挑出来的（比如某个长上下文模型）。轮换会把它换掉，违背挑选意图。需要时用 `includeSubagents: true` 打开。

## 失败安全

轮换是锦上添花的东西，所以整个回调包在 try/catch 里：

- 白名单不可用 → 不轮换，保持原样
- `agent.model` 缺失或 `select()` 抛错 → 忽略
- 信号已中止（用户取消） → 不轮换

最坏情况就是「模型不轮换了」，不会让对话失败。

## License

MIT