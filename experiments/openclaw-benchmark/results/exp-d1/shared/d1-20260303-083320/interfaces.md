# Interfaces
runId: d1-20260303-083320

## 2026-03-03T07:43:00.094981+00:00 | interface
- runId: `d1-20260303-083320`
- agent: `d1-stream-api`
- stream: `stream-api`
- note: Gateway notification methods (all validated via AJV, TypeBox schemas in src/gateway/protocol/schema/notifications.ts):

- notifications.list(params: {limit?, offset?, category?, enabled?, sortDir?}) -> {rules: NotificationRule[], total}
- notifications.get(params: {id}) -> NotificationRule
- notifications.create(params: {name, category, condition: {event, filter?}, targets: [{channel, accountId?, to?}], description?, enabled?, priority?, throttle?, templateBody?}) -> NotificationRule
- notifications.update(params: {id, patch: {name?, description?, enabled?, priority?, category?, condition?, targets?, throttle?, templateBody?}}) -> NotificationRule
- notifications.delete(params: {id}) -> {removed: boolean}
- notifications.test(params: {id, message?}) -> {delivered: boolean, results: [{channel, status, error?}]}
- notifications.mute(params: {id, muted: boolean, muteUntilMs?}) -> NotificationRule
- notifications.history(params: {ruleId?, limit?, offset?, status?, category?, sortDir?}) -> {entries: NotificationLogEntry[], total}

Broadcast events:
- notification.delivered: {ruleId, ruleName?, event, priority, category, channel, ts}
- notification.failed: {ruleId, ruleName?, event, priority, category, channel?, error?, ts}

NotificationRule shape: {id, name, description?, enabled, priority, category, condition, targets[], throttle?, templateBody?, muted?, muteUntilMs?, createdAtMs, updatedAtMs}

Handlers currently return ErrorCodes.UNAVAILABLE until persistence/state layer is wired in.

## 2026-03-03T07:43:51.971593+00:00 | interface
- runId: `d1-20260303-083320`
- agent: `d1-stream-core`
- stream: `stream-core`
- note: ## Notification Orchestration API (src/infra/notifications/index.ts)

### Core Types
- `NotificationRequest` — Input: payloads, targets[], fanoutPolicy, priority, ttlMs, idempotencyKey
- `NotificationResult` — Output: id, status, deliveries[]
- `NotificationRecord` — Persisted: full record with deliveries, timestamps, metadata
- `NotificationTarget` — { channel, to, accountId?, threadId? }
- `FanoutPolicy` — 'all' | 'priority' | 'first-success'
- `NotificationPriority` — 'low' | 'normal' | 'high' | 'urgent'
- `NotificationStatus` — 'pending' | 'queued' | 'processing' | 'completed' | 'partially_completed' | 'failed' | 'expired'
- `ChannelDeliveryStatus` — 'pending' | 'delivering' | 'delivered' | 'failed' | 'expired'
- `ChannelDeliveryRecord` — Per-channel: channel, to, status, attempts, messageId, errors

### Orchestrator Factory
```ts
createNotificationOrchestrator(config: {
  deliver: DeliverToChannelFn;
  concurrency?: number;
  stateDir?: string;
  log?: OrchestratorLogger;
}): NotificationOrchestrator
```

### Orchestrator Methods
- `submit(request: NotificationRequest): Promise<NotificationResult>` — Create + execute fanout
- `getStatus(id: string): Promise<NotificationRecord | null>` — Query by ID
- `recover(): Promise<{ recovered, expired }>` — Re-enqueue active from disk
- `stop(): Promise<void>` — Graceful shutdown
- `queueDepth(): number` / `activeCount(): number` — Observability

### DeliverToChannelFn (inject per-channel delivery)
```ts
type DeliverToChannelFn = (params: {
  channel: Exclude<OutboundChannel, 'none'>;
  to: string;
  accountId?: string;
  threadId?: string | number | null;
  payloads: ReplyPayload[];
}) => Promise<{ ok: boolean; messageId?: string; error?: string }>
```

### Persistence
- State dir: `<stateDir>/notifications/` (active) and `<stateDir>/notifications/completed/` (terminal)
- Atomic writes via tmp+rename (same pattern as delivery-queue.ts)
- File-per-notification JSON
