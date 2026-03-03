# Experiment D1 Shared Plan
runId: d1-20260303-083320
task: notification-orchestration-subsystem

## 2026-03-03T07:36:33.413758+00:00 | plan
- runId: `d1-20260303-083320`
- agent: `d1-stream-ui`
- stream: `stream-ui`
- note: UI status panel for notification orchestration health and per-channel delivery state.

Files to create:
- src/notifications/orchestration-status.types.ts — type definitions (OrchestrationStatus, ChannelDeliveryStats, DeliveryHealth)
- src/notifications/orchestration-status.ts — data collector that reads delivery-queue state and builds OrchestrationStatus
- src/notifications/orchestration-status-panel.ts — terminal table formatter using renderTable/theme/palette patterns

Files to modify:
- src/commands/status.types.ts — extend StatusSummary with optional orchestration field
- src/commands/status.command.ts — add Notifications section to status output
- src/commands/status.summary.ts — wire orchestration status into getStatusSummary()

Test files:
- src/notifications/orchestration-status.test.ts
- src/notifications/orchestration-status-panel.test.ts

## 2026-03-03T07:37:02.063557+00:00 | plan
- runId: `d1-20260303-083320`
- agent: `d1-stream-core`
- stream: `stream-core`
- note: ## stream-core: Gateway Orchestration Internals & State Model

### Scope
Implement the core notification orchestration engine: queueing, multi-channel fanout policies, and delivery status lifecycle tracking.

### Files to create
- src/infra/notifications/types.ts — Core types (NotificationRequest, DeliveryStatus, FanoutPolicy, etc.)
- src/infra/notifications/state.ts — Notification state persistence (file-based JSON, consistent with existing patterns)
- src/infra/notifications/fanout.ts — Fanout policy engine (all-channels, priority-ordered, first-success)
- src/infra/notifications/queue.ts — Notification orchestration queue (builds on delivery-queue pattern)
- src/infra/notifications/orchestrator.ts — Main orchestrator tying queue + fanout + state
- src/infra/notifications/index.ts — Public API surface
- src/infra/notifications/orchestrator.test.ts — Integration tests

### Design approach
- File-based JSON persistence (consistent with delivery-queue.ts, sessions store)
- Reuse existing ChannelPlugin outbound adapter for actual delivery
- Reuse existing diagnostic events for observability
- State lifecycle: pending → queued → delivering → delivered/failed/expired
- Fanout policies: all (parallel), priority (ordered fallback), first-success (stop on first OK)
- Exponential backoff for retries (consistent with existing delivery-queue.ts)
- No external dependencies needed

## 2026-03-03T07:37:49.734029+00:00 | plan
- runId: `d1-20260303-083320`
- agent: `d1-stream-test`
- stream: `stream-test`
- note: Scope: Integration tests and fixtures for notification orchestration subsystem. Files: src/infra/outbound/delivery-queue.test.ts (delivery queue lifecycle with real FS), src/infra/notification-orchestration.test.ts (e2e orchestration flows), src/test-utils/notification-fixtures.ts (shared fixtures). Scenarios: delivery queue enqueue/ack/fail/retry/recovery, system events overflow/dedup/isolation, channel manager lifecycle/restart/backoff, end-to-end event-to-delivery pipeline, failure cases (permanent errors, transient retry, partial bestEffort, abort).

## 2026-03-03T07:42:46.396424+00:00 | plan
- runId: `d1-20260303-083320`
- agent: `d1-stream-api`
- stream: `stream-api`
- note: API contract + validation layer for notification orchestration subsystem. Files: src/gateway/protocol/schema/notifications.ts (TypeBox schemas), src/gateway/protocol/schema/types.ts (type exports), src/gateway/protocol/schema/protocol-schemas.ts (registry), src/gateway/protocol/schema.ts (barrel), src/gateway/protocol/index.ts (AJV validators), src/gateway/server-methods/notifications.ts (8 gateway method handlers), src/gateway/server-methods.ts (handler registration), src/gateway/method-scopes.ts (authorization scopes), src/gateway/server-broadcast.ts (event scope guards), src/gateway/protocol/notifications-validators.test.ts (33 validation tests). Gateway methods: notifications.list, notifications.get, notifications.create, notifications.update, notifications.delete, notifications.test, notifications.mute, notifications.history. Events: notification.delivered, notification.failed.
