# dsh-llm-retry-guard

**一次坏采样不许吃掉整轮。**

给 [DeepSeek Harness](https://github.com/deepseek-ai/dsh) 的 `agent/request-error` 瀑布补上一小段：当模型流本身坏了、而内置重试策略**不认**这几个失败码时，回一个 `{ kind: "retry" }`，让宿主把这一步重新发一次请求。

## 它补的是哪个洞

DeepSeek 线路（`deepseek-account`）在流结束时**逐块校验工具调用参数是不是合法 JSON**：

```js
try { parsed = JSON.parse(content.arguments) }
catch (_invalidProviderToolJson) { return malformed("tool input is invalid JSON") }
```

一次坏采样 ＝ `LlmError(MALFORMED_RESPONSE)` ＝ **整轮抛掉**，用户看到「本轮运行失败 · DeepSeek Messages stream: tool input is invalid JSON」，模型已经在做的那件事全部作废。

2026-10-06 一个晚上在同一份会话记录里抓到三次，都是**采样事故**（换个采样多半就正常）：

| 轮 | 北京时间 | 工具 | 坏在哪 |
|---|---|---|---|
| turn 4 | 20:54:49 | `compress` | 参数写到 10011 字节处断掉 |
| turn 5 | 20:55:35 | `write` | 参数只写到 649 字节就没了 |
| turn 7 | 21:02:02 | `memory_search` | DSML 控制标记漏进 JSON 正文 |

内置的 `@deepseek-ai/dsh-llm-retry` 在 normal 策略下只认 `EMPTY_RESPONSE` / `RATE_LIMIT` / `SERVER` / `TIMEOUT` / `TRANSPORT` —— **`MALFORMED_RESPONSE`、`STREAM_CLOSED`、`STREAM_CUT` 不在里面**，所以这种事故官方策略什么都不做。本插件就干这一件事。

## 边界（它不做什么）

- **鉴权、额度、上下文预算、工具报错**一律 `next()`，一个字都不碰 —— 重试也没用。
- **不做退避**（`delayMs = 0`，判完立刻重发）；**不做关键词匹配**，只按**错误码**判，所以消息里恰好出现 "timeout" 之类的字眼不会误触发。
- 同一个 `agent + turn + step` 默认**封顶 2 次**，用尽后按原样报错 —— 线路真坏了要照实报，不能无限重试把 token 烧光。

## 判定顺序（源码级）

`lib/index.js` 的 `agent/request-error` 监听器，四条路径：

1. 错误码不在白名单 → `next()`
2. 调用方已取消（`payload.signal.aborted`）→ `next()`
3. 这一 (turn, step) 已经用满 `maxRetries` → `next()`
4. 否则**留痕 + 返回 `{ kind: "retry" }`**

## 重试留痕（0.2.0）

决定重试的那一刻，按官方格式往会话 append 一对事件：

```js
session.append('llm/retry',         { retryId, turn, step, provider, mode: 'normal',
                                      policyKey, retry, maxRetries, delayMs: 0, failure })
session.append('llm/retry-started', { retryId, turn, step, retry })
```

`policyKey = ["dsh-llm-retry-guard", "normal"]`（刻意不含配置值 —— 官方不变量按 `(turn, step, provider, policyKey)` 认链并要求 `retry` 连续，把配置写进去会让"改一次配置"看起来像从 1 重开，等于放开额度）。

官方 `dsh-llm-retry/lib/invariant.js` 会**逐条校验**这些事件（必须在打开的 turn/step 内、provider 要对得上、`retry` 必须等于同链上一条 +1、`retryId` 要延续），所以留痕是**尽力而为**：被拒只记一条警告并计入 `traceFailed`，**绝不改变"要不要重试"的判定**，也不会把一次恢复变成一次崩溃。

**计数优先从会话日志读**（同一 `(turn, step, provider, policyKey)` 链上的上一条 `llm/retry`），所以插件重载、桌面端重启之后计数仍然连续；读不到（例如没有 session 可读）才退回进程内计数。

## 自证

一条 `status.json` 就能看出这个插件到底有没有干活：

```
$DSH_HOME/llm-retry-guard/status.json
```

| 字段 | 含义 |
|---|---|
| `retries` / `byCode` | 一共重试了几次 / 按失败码分 |
| `exhausted` | 用尽额度、按原样报错的次数 |
| `traced` / `traceFailed` | 留痕成功 / 被官方不变量拒绝的次数 |
| `lastCountFrom` | 这次次数**从哪来**：`session`＝读到了会话日志（哪怕这条链还没有上一条，那就从 0 数起）；`memory`＝拿不到 session、退回进程内计数 |
| `lastPriorRetry` | 会话日志里读到的上一条 `retry`（没有则 `null`） |
| `lastCode` / `lastMessage` / `lastAt` | 最近一次失败码 / 原文 / 时间 |
| `policyKey` / `maxRetries` / `codes` | 生效中的链身份与配置 |

## 安装

```bash
# 一条命令，不需要 git
dsh plugin --profile web add https://github.com/StarflowDream/dsh-llm-retry-guard/releases/download/v0.2.1/dsh-llm-retry-guard-0.2.1.tgz
```

从本地源码安装：

```bash
dsh plugin --profile web add file:/path/to/dsh-llm-retry-guard
```

装完**必须重启 DSH**（`dsh web` 或桌面端应用）—— 插件 bundle 只在启动时并入 profile 层栈，桌面端同样支持。

## 配置

在 `$DSH_HOME/profiles/<profile>/cordis.patch.yml` 里：

```yaml
- id: dsh-llm-retry-guard
  config:
    enabled: true          # 默认 true
    maxRetries: 2          # 同一 agent+turn+step 最多补几次，默认 2
    codes:                 # 要接管的失败码，默认就是下面这五个
      - MALFORMED_RESPONSE
      - STREAM_CLOSED
      - STREAM_CUT
      - EMPTY_RESPONSE
      - TRANSPORT
```

`EMPTY_RESPONSE` / `TRANSPORT` 其实内置策略已经会重试，这里列着只是兜底（内置策略不存在或已被改掉时才有意义）。

## 测试

```bash
npm test        # = node --test --test-isolation=none test/*.test.mjs
```

17 条用例守两件事：**该重试的必须重试**（`MALFORMED_RESPONSE` 换一次重试，且不再走 `next()`）、**该放行的必须放行**（鉴权/额度/上下文预算原样交给宿主、同一 step 封顶、调用方取消时不动作），外加 0.2.0 的六条（留痕配对、日志计数跨重载、只认自己那条链、`retryId` 延续、留痕被拒不影响判定、`findLastRetry` 键空间）与 0.2.1 的两条（自证口径 `session`/`memory`、读到上一条就据此递增）。

## 已知限制

- 留痕是尽力而为：官方不变量拒绝时不会重试失败，只是这次重试在会话里看不见（`traced`/`traceFailed` 会如实记账）。
- 只有能拿到 `agent.session` 时才从日志计数；拿不到就退回进程内 Map（重启后清零）。
- 只处理"模型流本身坏了"这类失败码；线路真挂、鉴权失效不会因为装了这个插件被掩盖。

---

## English summary

`dsh-llm-retry-guard` is a small DSH plugin that hooks the `agent/request-error` waterfall and answers `{ kind: "retry" }` for the failure codes the built-in retry policy never retries — `MALFORMED_RESPONSE` (tool-call arguments are not valid JSON), `STREAM_CLOSED`, `STREAM_CUT` (plus `EMPTY_RESPONSE` / `TRANSPORT` as a fallback). One bad sample therefore costs one re-sample instead of a whole turn. It never touches auth/quota/context-budget/tool errors, never adds a delay, and caps retries per `agent + turn + step` (default 2).

Since 0.2.0 it also **traces every retry into the session** using the official durable `llm/retry` + `llm/retry-started` event pair (own stable `policyKey`, validated by `dsh-llm-retry`'s invariant), and **counts retries from the session log** so the counter survives plugin reloads and app restarts. A `status.json` under `$DSH_HOME/llm-retry-guard/` reports `retries`, `byCode`, `traced`, `traceFailed`, `lastCountFrom` and the active config.

## License

MIT
