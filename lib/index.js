/**
 * dsh-llm-retry-guard —— 一次采样事故不许吃掉整轮。
 *
 * ## 为什么有这一层（2026-10-06 实测事故）
 *
 * DeepSeek 的账号线路（`deepseek-account`，实现是核心包
 * `dsh/node_modules/@deepseek-ai/dsh-llm-deepseek/lib/index.js`，在 `resources/app.asar` 里）
 * 会在流结束时**逐块校验工具调用参数是不是合法 JSON**：
 *
 * ```js
 * if (reason.kind !== "max-tokens") for (const { content } of blocks.values()) {
 *   if (content.type !== "tool-call") continue;
 *   try { parsed = JSON.parse(content.arguments); }
 *   catch (_invalidProviderToolJson) { return malformed("tool input is invalid JSON"); }
 *   object(parsed);
 * }
 * ```
 *
 * 一次坏采样 = `LlmError(MALFORMED_RESPONSE)` = **整轮抛掉**，用户看到的是
 * 「本轮运行失败 · DeepSeek Messages stream: tool input is invalid JSON」，
 * 模型已经在做的那件事全部作废。
 *
 * 同一个晚上在同一份会话记录（`session-3a741b08-…`）里抓到三次——证据取自
 * `assistant/attempt.stream` 里 `block-end` 的 `block.arguments`：
 *
 * | 轮 | 北京时间 | 工具 | 坏在哪 |
 * |---|---|---|---|
 * | turn 4 | 20:54:49 | `compress` | 参数写到 10011 字节处断掉 |
 * | turn 5 | 20:55:35 | `write` | 参数只写到 649 字节就没了 |
 * | turn 7 | 21:02:02 | `memory_search` | DSML 控制标记漏进 JSON 正文 |
 *
 * 三条都是**采样事故**：换个采样多半就正常了（这三次之后同类的调用都成功了）。
 * 所以正确的处置是"再采一次"，而不是"把整轮判死"。
 *
 * ## 怎么修（用 DSH 自己的扩展点，不改 app.asar）
 *
 * 宿主在请求失败后会把失败交给 `agent/request-error` 瀑布：
 *
 * ```js
 * const action = await this.dispatch.waterfall("agent/request-error",
 *   { turn, step, provider: request.provider, failure: finish.failure, retryPolicy, signal },
 *   () => Promise.resolve(void 0));
 * if (action?.kind !== "retry") throw new LlmError(finish.failure.message, finish.failure.code, finish.failure);
 * ```
 *
 * 也就是说：**只要有中间件回 `{ kind: "retry" }`，这一轮就重新发一次请求**（失败的
 * 那次会作为 `assistant/attempt` 留档供复盘）。`dsh-model-fusion` 的
 * `src/host/native-context.ts:195` 就是照这个约定返 `{ kind: 'retry' }` 的。
 *
 * 本插件只干一件事：对上表这类**模型流本身坏了**的失败码回 `{ kind: "retry" }`，
 * 并且**按 agent+turn+step 计数封顶**（默认 2 次）——线路真坏了要照实报错，
 * 不能无限重试把 token 烧光。其余失败（鉴权、额度、上下文预算、工具报错）
 * 一律 `next()`，一个字都不碰。
 *
 * ## 补强：留痕 + 计数跨重启（2026-10-11）
 *
 * 判断逻辑没变，只在"决定重试"那条路径上多两件事：
 *
 * 1. **留痕**：按官方格式往会话 append `llm/retry` + `llm/retry-started`（带本插件的
 *    稳定 `POLICY_KEY`），于是重试在会话日志/轨迹里看得见、可复盘。官方
 *    `dsh-llm-retry/lib/invariant.js` 会逐条校验（必须在打开的 turn/step 内、provider
 *    要对得上、`retry` 必须等于同链上一条 +1、`retryId` 要延续），所以这一段是
 *    尽力而为：被拒只 `warn` + 记一笔 `traceFailed`，绝不改变判定、也不把一次恢复变成一次崩。
 * 2. **计数读会话日志**：`findLastRetry()` 从 `session.snapshotEvents()` 里取同一
 *    (turn, step, provider, POLICY_KEY) 的上一条 `retry`，跨插件重载 / 桌面端重启连续；
 *    没有 session 可读时才退回进程内 Map（`status.json` 的 `lastCountFrom` 自报用的哪一个）。
 *
 * @module dsh-llm-retry-guard
 */

import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Cordis 插件名。 */
export const name = 'llm-retry-guard'

/**
 * 默认重试的失败码：都是"提供商这一条流本身没给完/给脏了"这一类，
 * 换一次采样有意义。
 *
 * - `MALFORMED_RESPONSE`：工具调用参数不是合法 JSON（2026-10-06 事故的主角）；
 * - `STREAM_CLOSED` / `STREAM_CUT`：流被中途掐断；
 * - `EMPTY_RESPONSE`：一个内容块都没有（宿主默认策略已经重试，这里是兜底）；
 * - `TRANSPORT`：传输层异常。
 */
export const DEFAULT_RETRY_CODES = Object.freeze([
  'MALFORMED_RESPONSE',
  'STREAM_CLOSED',
  'STREAM_CUT',
  'EMPTY_RESPONSE',
  'TRANSPORT',
])

/** 每个 agent+turn+step 默认最多重试几次。 */
const DEFAULT_MAX_RETRIES = 2

/** 计数表的硬上限，防止长会话里无限长大。 */
const MAX_KEYS = 512

/**
 * 本插件在会话事件里的**稳定链身份**。刻意不含可变配置值：官方
 * `dsh-llm-retry/lib/invariant.js` 按 (turn, step, provider, policyKey) 认链、并要求
 * `retry` 在同一条链上连续，把配置写进来会让用户一改配置就"看起来从 1 重开"，等于放开额度。
 */
export const POLICY_KEY = JSON.stringify(['dsh-llm-retry-guard', 'normal'])

/**
 * 读会话事件（读不到就返回 undefined：没有 session、没有事件面、或快照抛错）。
 * 单独抽出来是为了让 `status.json` 能如实自报"这次次数到底是从会话日志来的，还是退回进程内了"。
 * @param {unknown} session `payload.agent.session`
 * @returns {Array<{type: string, data: Record<string, unknown>}> | undefined}
 */
export function readSessionEvents(session) {
  try {
    const events = typeof session?.snapshotEvents === 'function' ? session.snapshotEvents() : undefined
    return Array.isArray(events) && typeof events.findLast === 'function' ? events : undefined
  } catch {
    return undefined
  }
}

/**
 * 在一份事件列表里找本插件同一 (turn, step, provider) 链上的上一条调度（②）。
 * @param {unknown} events 会话事件列表
 * @param {unknown} turn
 * @param {unknown} step
 * @param {unknown} provider
 * @returns {{type: string, data: Record<string, unknown>} | undefined}
 */
export function findLastRetryIn(events, turn, step, provider) {
  if (!Number.isInteger(turn) || !Number.isInteger(step)) return undefined
  if (typeof provider !== 'string' || provider.length === 0) return undefined
  if (!Array.isArray(events) || typeof events.findLast !== 'function') return undefined
  return events.findLast((event) => event?.type === 'llm/retry'
    && event.data?.turn === turn
    && event.data?.step === step
    && event.data?.provider === provider
    && event.data?.policyKey === POLICY_KEY)
}

/**
 * `findLastRetryIn` 的便利包装：直接从 session 读。
 * 读不到（没有 session / 没有事件面 / 字段不合法）就返回 undefined，调用方退回进程内计数。
 * @param {unknown} session `payload.agent.session`
 * @param {unknown} turn
 * @param {unknown} step
 * @param {unknown} provider
 * @returns {{type: string, data: Record<string, unknown>} | undefined}
 */
export function findLastRetry(session, turn, step, provider) {
  return findLastRetryIn(readSessionEvents(session), turn, step, provider)
}

/**
 * 把"这次重试"按官方格式写进会话（①）：`llm/retry` + `llm/retry-started`。
 *
 * 官方不变量逐条校验（必须在打开的 turn/step 内、provider 要对得上、`retry` 必须等于
 * 同链上一条 +1、`retryId` 要延续），任何不合规的 append 都会抛。所以这里是**尽力而为**：
 * 写不进去只记一笔警告，绝不改变"要不要重试"的判定，也不把一次恢复变成一次崩溃。
 *
 * @param {object} args
 * @returns {boolean} 是否成功留痕
 */
function traceScheduledRetry({ session, failure, turn, step, provider, retry, maxRetries, previousRetryId, warn }) {
  if (typeof session?.append !== 'function') return false
  if (!Number.isInteger(turn) || !Number.isInteger(step)) return false
  if (typeof provider !== 'string' || provider.length === 0) return false
  if (typeof failure?.message !== 'string' || failure.message.length === 0) return false
  if (typeof failure?.code !== 'string' || failure.code.length === 0) return false
  if (!Number.isInteger(retry) || retry < 1 || retry > maxRetries) return false
  const retryId = typeof previousRetryId === 'string' && previousRetryId.length > 0 ? previousRetryId : randomUUID()
  try {
    session.append('llm/retry', {
      retryId,
      turn,
      step,
      provider,
      mode: 'normal',
      policyKey: POLICY_KEY,
      retry,
      maxRetries,
      delayMs: 0,
      failure,
    })
    session.append('llm/retry-started', { retryId, turn, step, retry })
    return true
  } catch (error) {
    warn(`重试留痕被官方不变量拒绝（不影响本次重试）：${String(error?.message ?? error)}`)
    return false
  }
}

/**
 * 插件入口。
 * @param {object} ctx cordis 上下文。
 * @param {object} [config] 行配置 `{ enabled, maxRetries, codes }`。
 * @returns {() => void} 释放函数。
 */
export function apply(ctx, config = {}) {
  if (config.enabled === false) return () => {}

  const maxRetries = Number.isInteger(config.maxRetries) && config.maxRetries > 0
    ? config.maxRetries
    : DEFAULT_MAX_RETRIES
  const codes = new Set(
    (Array.isArray(config.codes) && config.codes.length > 0 ? config.codes : DEFAULT_RETRY_CODES)
      .map((code) => String(code).toUpperCase()),
  )

  /** 每个 agent+turn+step 已经重试过几次。 */
  const attempts = new Map()
  /** 自证字段：一条 `status.json` 就能看出这个插件到底有没有干活。 */
  const stats = {
    retries: 0,
    exhausted: 0,
    skipped: 0,
    byCode: {},
    lastCode: '',
    lastMessage: '',
    lastAt: 0,
    traced: 0,
    traceFailed: 0,
    lastCountFrom: '',
    lastPriorRetry: null,
  }

  const statusFile = () => join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'llm-retry-guard', 'status.json')

  /** 落一笔状态（尽力而为，绝不因为它失败而影响重试判定）。 */
  const persist = () => {
    const file = statusFile()
    const payload = {
      plugin: name,
      version: '0.2.1',
      policyKey: POLICY_KEY,
      maxRetries,
      codes: [...codes],
      ...stats,
      pendingKeys: [...attempts.entries()].map(([key, used]) => ({ key, used })),
      savedAt: Date.now(),
    }
    void (async () => {
      try {
        await mkdir(dirname(file), { recursive: true })
        await writeFile(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
      } catch {
        // 状态是给人事后取证的，写不进去不改变重试行为。
      }
    })()
  }

  const warn = (message) => {
    try {
      ctx.logger?.warn?.(`dsh-llm-retry-guard: ${message}`)
    } catch {
      // logger 缺失不是错误。
    }
  }

  const dispose = ctx.on('agent/request-error', async (payload, next) => {
    const failure = payload?.failure
    const code = typeof failure?.code === 'string' ? failure.code.toUpperCase() : ''
    if (code === '' || !codes.has(code)) return next()
    if (payload?.signal?.aborted) return next()

    const agentId = payload?.agent?.id ?? '(no-agent)'
    const turn = payload?.turn
    const step = payload?.step
    const provider = payload?.provider
    const key = `${agentId}:${turn ?? '?'}:${step ?? '?'}`

    // ② 次数优先从会话日志读：跨插件重载、跨桌面端重启都连续；读不到才退回进程内计数。
    //    `lastCountFrom` 说的是"次数从哪来"：能读会话日志就是 session（日志里没有上一条＝0），
    //    读不到才是 memory；日志里读到的那个数字另记在 `lastPriorRetry`（没有则 null）。
    const session = payload?.agent?.session
    const events = readSessionEvents(session)
    const prior = findLastRetryIn(events, turn, step, provider)
    const fromLog = Number.isSafeInteger(prior?.data?.retry) ? prior.data.retry : undefined
    const used = fromLog ?? (attempts.get(key) ?? 0)
    stats.lastCountFrom = events === undefined ? 'memory' : 'session'
    stats.lastPriorRetry = fromLog ?? null

    if (used >= maxRetries) {
      stats.exhausted += 1
      stats.lastCode = code
      stats.lastMessage = String(failure?.message ?? '')
      stats.lastAt = Date.now()
      warn(`${code} 在 ${key} 已经重试 ${used} 次仍失败，不再重试，按原样报错`)
      persist()
      return next()
    }

    if (attempts.size >= MAX_KEYS) attempts.clear()
    attempts.set(key, used + 1)
    stats.retries += 1
    stats.byCode[code] = (stats.byCode[code] ?? 0) + 1
    stats.lastCode = code
    stats.lastMessage = String(failure?.message ?? '')
    stats.lastAt = Date.now()

    // ① 留痕：按官方格式把这次重试写进会话，让它在轨迹/复盘里看得见。
    const traced = traceScheduledRetry({
      session,
      failure,
      turn,
      step,
      provider,
      retry: used + 1,
      maxRetries,
      previousRetryId: prior?.data?.retryId,
      warn,
    })
    if (traced) stats.traced += 1
    else stats.traceFailed += 1

    warn(`${code}：${key} 第 ${used + 1}/${maxRetries} 次重试（次数来源：${events === undefined ? '进程内计数' : (fromLog === undefined ? '会话日志（这条链还没有上一条）' : `会话日志 retry=${fromLog}`)}；留痕：${traced ? '已写入会话' : '未写入'}；原失败：${stats.lastMessage}）`)
    persist()
    return { kind: 'retry' }
  })

  return () => {
    if (typeof dispose === 'function') dispose()
    attempts.clear()
  }
}
