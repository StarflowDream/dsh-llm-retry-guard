# Changelog

## 0.2.0 — 2026-10-11

### Added

- **重试留痕**：决定重试时按官方格式往会话 append `llm/retry` + `llm/retry-started`（带本插件的稳定 `policyKey = ["dsh-llm-retry-guard","normal"]`），重试从此在会话日志/轨迹里可见、可复盘。留痕要过 `dsh-llm-retry` 的官方不变量校验（必须在打开的 turn/step 内、provider 要对得上、`retry` 必须等于同链上一条 +1、`retryId` 要延续）；被拒时只记一条警告，**不改变重试判定**。
- **计数改读会话日志**：次数优先从 `session.snapshotEvents()` 里同一 `(turn, step, provider, policyKey)` 链上的上一条 `llm/retry` 读取 —— 插件重载、桌面端重启后计数仍然连续；读不到才退回进程内计数。
- 新增导出 `POLICY_KEY` 与 `findLastRetry(session, turn, step, provider)`。
- `status.json` 新增自证字段：`traced` / `traceFailed` / `lastCountFrom` / `policyKey`。

### Tests

- 15 条用例（新增 6 条）：留痕事件对配对、日志计数跨重载连续、只认本插件那条链、`retryId` 在同链延续、留痕被官方不变量拒绝时判定不变、`findLastRetry` 键空间。

## 0.1.0 — 2026-10-06

- 初版：对 `MALFORMED_RESPONSE` / `STREAM_CLOSED` / `STREAM_CUT`（外加 `EMPTY_RESPONSE` / `TRANSPORT` 兜底）回 `{ kind: "retry" }`，按 `agent + turn + step` 封顶（默认 2 次），其余失败一律 `next()`。
- `$DSH_HOME/llm-retry-guard/status.json` 自证：`retries` / `exhausted` / `byCode` / `pendingKeys` / `lastMessage`。
