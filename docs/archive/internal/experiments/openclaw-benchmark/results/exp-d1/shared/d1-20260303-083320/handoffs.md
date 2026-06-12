# Handoffs
runId: d1-20260303-083320

## 2026-03-03T07:43:07.399895+00:00 | handoff
- runId: `d1-20260303-083320`
- agent: `d1-stream-api`
- stream: `stream-api`
- note: stream-api work complete. All API contracts, TypeBox schemas, AJV validators, gateway method handlers, authorization scopes, and event scope guards are in place. 33 validation tests passing, build clean.

For the state/persistence stream: Handlers in src/gateway/server-methods/notifications.ts need a NotificationStore injected via GatewayRequestContext (similar to how CronService is available as context.cron). The store should implement list/get/create/update/delete/mute/history operations and fire context.broadcast("notification.delivered", ...) and context.broadcast("notification.failed", ...) events on delivery outcomes.

For the UI stream: Import types from src/gateway/protocol/index.ts (NotificationRule, NotificationsListResult, etc.). Subscribe to notification.delivered and notification.failed events for real-time status panel updates.

For the integration test stream: The validators test at src/gateway/protocol/notifications-validators.test.ts covers schema validation. E2E tests should connect via WebSocket, call notifications.create/list/update/delete methods, and verify broadcast events.

## 2026-03-03T07:44:07.400081+00:00 | handoff
- runId: `d1-20260303-083320`
- agent: `d1-stream-core`
- stream: `stream-core`
- note: ## stream-core COMPLETE: Notification Orchestration Internals

### What was built
Full notification orchestration subsystem at `src/infra/notifications/`:
1. **types.ts** — All types: NotificationRequest/Record/Result, FanoutPolicy, delivery status lifecycle, priority weights
2. **state.ts** — File-based persistence: create/load/update/delete notifications, atomic writes, status derivation, active↔completed directory management
3. **fanout.ts** — Policy engine: 'all' (parallel), 'priority' (sequential fallback), 'first-success' (stop on first OK)
4. **queue.ts** — In-memory priority queue with FIFO within same priority, enqueue listeners for wakeup
5. **orchestrator.ts** — Main orchestrator: submit (inline fanout), getStatus, recover (disk→queue), stop (graceful with inflight tracking), diagnostic events
6. **index.ts** — Public API re-exports
7. **orchestrator.test.ts** — 47 tests covering all types, state persistence, queue behavior, all 3 fanout policies, TTL expiry, recovery, error handling

### Integration points for other streams
- **Gateway API stream**: Wire `createNotificationOrchestrator` into gateway startup, inject `deliver` using existing `deliverOutboundPayloads` or plugin outbound adapters
- **UI stream**: Use `getStatus(id)` and `NotificationRecord` type for status panel display
- **Persistence stream**: State files live at `<stateDir>/notifications/` — consistent with delivery-queue pattern
- **Test stream**: Orchestrator accepts `stateDir` override for isolated test state

### Key design decisions
- Synchronous submit (inline fanout) for immediate results; queue+loop for recovery/background processing
- No external DB — file-per-notification JSON, consistent with existing delivery-queue.ts pattern
- Status derivation is automatic from aggregate channel delivery statuses
- `DeliverToChannelFn` is the seam — callers inject their own delivery implementation
