# Decisions
runId: d1-20260303-083320

## 2026-03-03T07:36:35.342406+00:00 | decision
- runId: `d1-20260303-083320`
- agent: `d1-stream-ui`
- stream: `stream-ui`
- note: UI panel reuses existing delivery-queue infrastructure (loadPendingDeliveries, loadFailedDeliveries) rather than introducing a separate notification state store. The panel aggregates per-channel delivery stats from QueuedDelivery entries and renders them using the established renderTable + theme pattern. Orchestration status is an optional field on StatusSummary so it gracefully degrades when the gateway is unreachable or notifications are not configured.

## 2026-03-03T07:37:04.043367+00:00 | decision
- runId: `d1-20260303-083320`
- agent: `d1-stream-core`
- stream: `stream-core`
- note: File-based JSON persistence for notification state (consistent with delivery-queue.ts pattern). No SQLite or external DB — atomic writes via tmp+rename. State lifecycle: pending → queued → delivering → delivered | failed | expired. Three fanout policies: all (parallel broadcast), priority (ordered fallback), first-success (stop after first delivery). Exponential backoff for retries: 5s, 25s, 2m, 10m, max 5 retries.

## 2026-03-03T07:37:51.981242+00:00 | decision
- runId: `d1-20260303-083320`
- agent: `d1-stream-test`
- stream: `stream-test`
- note: Test architecture: Vitest unit config (not e2e) for all integration tests — in-process mocking + real filesystem via temp dirs. Delivery queue tests use createFixtureSuite. Orchestration tests compose real system-events + mock channel plugins + delivery queue with real FS. Shared fixtures in src/test-utils/notification-fixtures.ts following existing test utility patterns.

## 2026-03-03T07:42:48.597564+00:00 | decision
- runId: `d1-20260303-083320`
- agent: `d1-stream-api`
- stream: `stream-api`
- note: Used TypeBox + AJV for schema validation (matching existing cron/agents/sessions patterns). Notification rules use a condition+targets model: each rule has a condition (event name + optional filter) and 1-10 channel targets (channel + optional accountId/to). Priority levels: low/normal/high/urgent. Categories: agent/system/cron/security/channel/custom. Throttle support via maxPerHour/cooldownMs/dedupe. Read methods (list/get/history) require operator.read scope; write mutations (create/update/delete/mute) require operator.admin scope; test delivery requires operator.write scope. Notification events (notification.delivered/notification.failed) are not scope-guarded so all connected operators can see them. Handlers return UNAVAILABLE until the persistence layer (state stream) is integrated.
