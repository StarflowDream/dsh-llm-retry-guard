/**
 * dsh-llm-retry-guard 的测试。跑法：`node --test --test-isolation=none test/*.test.mjs`
 *
 * 这组用例守两件事，缺一不可：
 * 1. **该重试的必须重试**——2026-10-06 那三次坏采样（参数截断、控制标记漏进 JSON）
 *    对应的失败码要真的换来一次重试，不然插件的存在没有意义；
 * 2. **该放行的必须放行**——鉴权/额度/上下文预算这类失败重试也没用，必须原样交给宿主，
 *    而且**同一个 step 不许无限重试**（默认封顶 2 次），否则等于把 token 烧光。
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { DEFAULT_RETRY_CODES, POLICY_KEY, apply, findLastRetry, name } from '../lib/index.js'

/** 假 cordis 上下文：抓住监听器，并提供可断言的最少面。 */
function makeCtx() {
  const listeners = new Map()
  const warnings = []
  const ctx = {
    on(event, handler) {
      listeners.set(event, handler)
      return () => listeners.delete(event)
    },
    logger: { warn: (message) => warnings.push(message) },
  }
  return { ctx, listeners, warnings }
}

/** 一条 agent/request-error 的载荷。 */
function failurePayload(code, extra = {}) {
  return {
    agent: { id: 'agent-1' },
    turn: 4,
    step: 31,
    provider: 'deepseek-account',
    failure: { code, message: `DeepSeek Messages stream: ${code}` },
    retryPolicy: 'normal',
    signal: { aborted: false },
    ...extra,
  }
}

/** 宿主的默认续跑函数（没人接管时它返回 undefined，宿主随后抛错）。 */
const nextReturns = (value) => async () => value

test('插件名与默认重试码是契约的一部分', () => {
  assert.equal(name, 'llm-retry-guard')
  assert.ok(DEFAULT_RETRY_CODES.includes('MALFORMED_RESPONSE'))
  assert.ok(DEFAULT_RETRY_CODES.includes('STREAM_CLOSED'))
})

test('MALFORMED_RESPONSE 换来一次重试，且不叫 next', async () => {
  const { ctx, listeners } = makeCtx()
  apply(ctx, {})
  const handler = listeners.get('agent/request-error')
  assert.ok(handler, 'agent/request-error 监听器必须注册')

  let nextCalls = 0
  const action = await handler(failurePayload('MALFORMED_RESPONSE'), async () => {
    nextCalls += 1
    return undefined
  })
  assert.deepEqual(action, { kind: 'retry' })
  assert.equal(nextCalls, 0, '决定重试就不该再走 next')
})

test('别的失败码一律放行（鉴权/额度/上下文预算重试也没用）', async () => {
  const { ctx, listeners, warnings } = makeCtx()
  apply(ctx, {})
  const handler = listeners.get('agent/request-error')

  for (const code of ['QUOTA_EXHAUSTED', 'AUTH_FAILED', 'FUSION_CONTEXT_BUDGET', 'TOOL_ERROR', '']) {
    let nextCalls = 0
    const payload = failurePayload(code)
    const action = await handler(payload, async () => {
      nextCalls += 1
      return { kind: 'stop' }
    })
    assert.equal(nextCalls, 1, `${code || '(空码)'} 必须交给宿主`)
    assert.deepEqual(action, { kind: 'stop' }, '宿主的返回值要原样透传')
  }
  assert.equal(warnings.length, 0, '放行的失败不该被本插件记一笔')
})

test('同一个 step 封顶：默认 2 次之后交给宿主按原样报错', async () => {
  const { ctx, listeners, warnings } = makeCtx()
  apply(ctx, {})
  const handler = listeners.get('agent/request-error')

  const first = await handler(failurePayload('MALFORMED_RESPONSE'), nextReturns(undefined))
  const second = await handler(failurePayload('MALFORMED_RESPONSE'), nextReturns(undefined))
  let nextCalls = 0
  const third = await handler(failurePayload('MALFORMED_RESPONSE'), async () => {
    nextCalls += 1
    return undefined
  })

  assert.deepEqual(first, { kind: 'retry' })
  assert.deepEqual(second, { kind: 'retry' })
  assert.equal(nextCalls, 1, '第 3 次必须放行，不许无限重试')
  assert.equal(third, undefined)
  assert.ok(warnings.some((line) => line.includes('不再重试')), '放弃时要留下原因')
})

test('计数按 agent+turn+step 分开（另一轮/另一个 agent 不共用额度）', async () => {
  const { ctx, listeners } = makeCtx()
  apply(ctx, { maxRetries: 1 })
  const handler = listeners.get('agent/request-error')

  assert.deepEqual(await handler(failurePayload('MALFORMED_RESPONSE'), nextReturns(undefined)), { kind: 'retry' })
  // 同一 step 已用尽
  assert.equal(await handler(failurePayload('MALFORMED_RESPONSE'), nextReturns(undefined)), undefined)
  // 换 step → 重新有一次机会
  assert.deepEqual(
    await handler(failurePayload('MALFORMED_RESPONSE', { step: 32 }), nextReturns(undefined)),
    { kind: 'retry' },
  )
  // 换 agent → 也是独立额度
  assert.deepEqual(
    await handler(failurePayload('MALFORMED_RESPONSE', { agent: { id: 'agent-2' } }), nextReturns(undefined)),
    { kind: 'retry' },
  )
})

test('调用方已取消时不重试', async () => {
  const { ctx, listeners } = makeCtx()
  apply(ctx, {})
  const handler = listeners.get('agent/request-error')
  let nextCalls = 0
  const action = await handler(failurePayload('MALFORMED_RESPONSE', { signal: { aborted: true } }), async () => {
    nextCalls += 1
    return undefined
  })
  assert.equal(nextCalls, 1)
  assert.equal(action, undefined)
})

test('enabled:false 时压根不注册监听器', () => {
  const { ctx, listeners } = makeCtx()
  const dispose = apply(ctx, { enabled: false })
  assert.equal(listeners.size, 0)
  assert.equal(typeof dispose, 'function')
})

test('重试码可配置：只认列出来的那几个', async () => {
  const { ctx, listeners } = makeCtx()
  apply(ctx, { codes: ['malformed_response'] })
  const handler = listeners.get('agent/request-error')

  assert.deepEqual(await handler(failurePayload('MALFORMED_RESPONSE'), nextReturns(undefined)), { kind: 'retry' })
  let nextCalls = 0
  await handler(failurePayload('STREAM_CLOSED', { step: 9 }), async () => {
    nextCalls += 1
    return undefined
  })
  assert.equal(nextCalls, 1, '没列出来的码要放行')
})

test('状态文件落盘，事后一条 GET/一次 cat 就能核', async () => {
  const home = await mkdtemp(join(tmpdir(), 'retry-guard-'))
  process.env.DSH_HOME = home
  const { ctx, listeners } = makeCtx()
  apply(ctx, {})
  await listeners.get('agent/request-error')(failurePayload('MALFORMED_RESPONSE'), nextReturns(undefined))

  // 落盘是异步尽力而为，给它一点时间
  await new Promise((resolve) => setTimeout(resolve, 50))
  const raw = await readFile(join(home, 'llm-retry-guard', 'status.json'), 'utf8')
  const status = JSON.parse(raw)
  assert.equal(status.plugin, 'llm-retry-guard')
  assert.equal(status.retries, 1)
  assert.equal(status.byCode.MALFORMED_RESPONSE, 1)
  assert.equal(status.maxRetries, 2)
  assert.equal(status.pendingKeys.length, 1)
  assert.match(status.lastMessage, /MALFORMED_RESPONSE/)
})

// ── ①② 段：重试留痕 + 计数读会话日志（2026-10-11 用户 m01165「行，那你补上1和2吧」）──

/** 假 session：只实现官方不变量用到的那两个面。 */
function makeSession(events = []) {
  const log = [...events]
  return {
    append(type, data) {
      log.push({ type, data })
    },
    snapshotEvents() {
      return [...log]
    },
    log,
  }
}

/** 造一条"本插件已经在这一 (turn,step,provider) 链上调度过"的 llm/retry 事件。 */
function scheduledRetry({
  turn = 4,
  step = 31,
  provider = 'deepseek-account',
  retry = 1,
  retryId = 'rid-1',
  policyKey = POLICY_KEY,
} = {}) {
  return {
    type: 'llm/retry',
    data: {
      retryId,
      turn,
      step,
      provider,
      mode: 'normal',
      policyKey,
      retry,
      maxRetries: 2,
      delayMs: 0,
      failure: { code: 'MALFORMED_RESPONSE', message: 'DeepSeek Messages stream: MALFORMED_RESPONSE' },
    },
  }
}

/** 把 payload 的 agent 换成带 session 的版本。 */
function withSession(code, session, extra = {}) {
  const payload = failurePayload(code, extra)
  payload.agent = { id: 'agent-1', session }
  return payload
}

test('① 决定重试时往会话里留一对 llm/retry + llm/retry-started', async () => {
  const { ctx, listeners } = makeCtx()
  apply(ctx, {})
  const session = makeSession()
  const handler = listeners.get('agent/request-error')

  assert.deepEqual(await handler(withSession('MALFORMED_RESPONSE', session), nextReturns(undefined)), { kind: 'retry' })
  assert.deepEqual(session.log.map((event) => event.type), ['llm/retry', 'llm/retry-started'])

  const [scheduled, started] = session.log
  assert.equal(scheduled.data.policyKey, POLICY_KEY, '必须带本插件的稳定链身份')
  assert.equal(scheduled.data.mode, 'normal')
  assert.equal(scheduled.data.turn, 4)
  assert.equal(scheduled.data.step, 31)
  assert.equal(scheduled.data.provider, 'deepseek-account')
  assert.equal(scheduled.data.retry, 1)
  assert.equal(scheduled.data.maxRetries, 2, 'normal 模式必须带 maxRetries（官方不变量要求）')
  assert.equal(scheduled.data.delayMs, 0)
  assert.match(scheduled.data.failure.message, /MALFORMED_RESPONSE/)
  assert.ok(typeof scheduled.data.retryId === 'string' && scheduled.data.retryId.length > 0)
  assert.deepEqual(started.data, { retryId: scheduled.data.retryId, turn: 4, step: 31, retry: 1 })
})

test('② 计数从会话日志读：日志里已有 2 条调度，新进程第三次直接放行（跨重载连续）', async () => {
  const { ctx, listeners } = makeCtx()
  apply(ctx, {}) // 全新进程：内存计数是空的
  const session = makeSession([scheduledRetry({ retry: 1 }), scheduledRetry({ retry: 2 })])
  const handler = listeners.get('agent/request-error')

  let nextCalls = 0
  const action = await handler(withSession('MALFORMED_RESPONSE', session), async () => {
    nextCalls += 1
    return undefined
  })
  assert.equal(nextCalls, 1, '日志里已经重试 2 次，必须放行')
  assert.equal(action, undefined)
  assert.equal(session.log.length, 2, '放行时不该再往会话里写事件')
})

test('② 只认自己那条链：别的 policyKey 的历史不占我们的额度', async () => {
  const { ctx, listeners } = makeCtx()
  apply(ctx, {})
  const session = makeSession([scheduledRetry({ retry: 9, policyKey: JSON.stringify(['someone-else', 'normal']) })])
  const handler = listeners.get('agent/request-error')

  assert.deepEqual(await handler(withSession('MALFORMED_RESPONSE', session), nextReturns(undefined)), { kind: 'retry' })
  assert.equal(session.log.at(-2).data.retry, 1, '别人链上的 retry=9 不算数')
  assert.equal(session.log.at(-1).data.retry, 1)
})

test('② retryId 在同一条链上延续（官方不变量要求）', async () => {
  const { ctx, listeners } = makeCtx()
  apply(ctx, {})
  const session = makeSession([scheduledRetry({ retry: 1, retryId: 'chain-42' })])
  const handler = listeners.get('agent/request-error')

  await handler(withSession('MALFORMED_RESPONSE', session), nextReturns(undefined))
  assert.equal(session.log.at(-2).data.retryId, 'chain-42')
  assert.equal(session.log.at(-1).data.retryId, 'chain-42')
})

test('① 留痕被官方不变量拒绝时，不影响重试判定，只多一句警告', async () => {
  const { ctx, listeners, warnings } = makeCtx()
  apply(ctx, {})
  const session = {
    append() {
      throw new Error('llm/retry must be appended inside an open step')
    },
    snapshotEvents: () => [],
  }
  const handler = listeners.get('agent/request-error')

  assert.deepEqual(await handler(withSession('MALFORMED_RESPONSE', session), nextReturns(undefined)), { kind: 'retry' })
  assert.ok(warnings.some((line) => line.includes('留痕')), '被拒要留一句警告')
})

test('findLastRetry 只认同链同 provider 的上一条（键空间契约）', () => {
  const events = [scheduledRetry({ retry: 1 }), scheduledRetry({ retry: 2, step: 32 })]
  assert.equal(findLastRetry({ snapshotEvents: () => events }, 4, 31, 'deepseek-account').data.retry, 1)
  assert.equal(findLastRetry({ snapshotEvents: () => events }, 4, 32, 'deepseek-account').data.retry, 2)
  assert.equal(findLastRetry({ snapshotEvents: () => events }, 4, 99, 'deepseek-account'), undefined)
  assert.equal(findLastRetry({ snapshotEvents: () => events }, 4, 31, 'other-provider'), undefined)
  assert.equal(findLastRetry(undefined, 4, 31, 'deepseek-account'), undefined)
  assert.equal(findLastRetry({ snapshotEvents: () => { throw new Error('boom') } }, 4, 31, 'deepseek-account'), undefined)
  assert.equal(findLastRetry({ snapshotEvents: () => events }, '4', 31, 'deepseek-account'), undefined)
})

// ── 0.2.1：自证字段的语义（lastCountFrom 报的是"次数从哪来"，不是"有没有读到上一条"）──

test('② 自证口径：能读会话日志就报 session，哪怕这条链还没有上一条', async () => {
  const home = await mkdtemp(join(tmpdir(), 'retry-guard-count-'))
  process.env.DSH_HOME = home
  const { ctx, listeners } = makeCtx()
  apply(ctx, {})
  const session = makeSession() // 有事件面，但日志里没有本插件的上一条
  await listeners.get('agent/request-error')(withSession('MALFORMED_RESPONSE', session), nextReturns(undefined))
  await new Promise((resolve) => setTimeout(resolve, 50))

  const status = JSON.parse(await readFile(join(home, 'llm-retry-guard', 'status.json'), 'utf8'))
  assert.equal(status.lastCountFrom, 'session', '读了会话日志就该报 session')
  assert.equal(status.lastPriorRetry, null, '日志里没有上一条时该记 null')
  assert.equal(status.version, '0.2.1')
})

test('② 自证口径：只有拿不到会话日志才报 memory；读到上一条就记下那个数字', async () => {
  const home = await mkdtemp(join(tmpdir(), 'retry-guard-count2-'))
  process.env.DSH_HOME = home
  const { ctx, listeners } = makeCtx()
  apply(ctx, {})
  const handler = listeners.get('agent/request-error')

  // 第一笔：payload 里没有 session → 退回进程内计数
  await handler(failurePayload('MALFORMED_RESPONSE'), nextReturns(undefined))
  await new Promise((resolve) => setTimeout(resolve, 50))
  let status = JSON.parse(await readFile(join(home, 'llm-retry-guard', 'status.json'), 'utf8'))
  assert.equal(status.lastCountFrom, 'memory')
  assert.equal(status.lastPriorRetry, null)

  // 第二笔：日志里已有本插件 retry=1 → 次数从日志读，并如实记下 1
  const session = makeSession([scheduledRetry({ retry: 1 })])
  await handler(withSession('MALFORMED_RESPONSE', session), nextReturns(undefined))
  await new Promise((resolve) => setTimeout(resolve, 50))
  status = JSON.parse(await readFile(join(home, 'llm-retry-guard', 'status.json'), 'utf8'))
  assert.equal(status.lastCountFrom, 'session')
  assert.equal(status.lastPriorRetry, 1)
  assert.equal(session.log.at(-2).data.retry, 2, '日志里是 1，这次就该写 2')
})
