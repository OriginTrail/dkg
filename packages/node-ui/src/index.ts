export {
  DashboardDB,
  SqliteMessageIdempotencyStore,
  SqliteProtocolOutboxStore,
  type SqliteProtocolOutboxStoreOptions,
  SqliteSyncCheckpointStore,
  SqliteChangelogCursorStore,
  SqliteChangelogEraGuard,
  SqliteKaNumberStore,
  SCHEMA_VERSION,
  // Notifications-pane redesign (V16): activity-digest primitives shared
  // with the daemon's `assertion_activity` emitters + scoped read path.
  ACTIVITY_DIGEST_WINDOW_MS,
  ASSERTION_ACTIVITY_TYPE,
  buildActivityDigestKey,
  parseActivityDigestKey,
} from './db.js';
export {
  SqliteChainEventCursorStore,
  SqliteContextGraphRegistryScanCursorStore,
} from './chain-cursor-stores.js';
export type {
  DashboardDBOptions,
  LogVolumePruneResult,
  LegacyRoutineLogCleanupResult,
  MetricSnapshotRow,
  OperationRow,
  OperationPhaseRow,
  OperationStatsSummary,
  OperationStatsBucket,
  SpendingSummary,
  SpendingPeriod,
  ChatMessageRow,
  LogRow,
  QueryHistoryRow,
  SavedQueryRow,
  ContextGraphSubscriptionRow,
  ContextGraphReadinessProvenance,
  StoredContextGraphJoinPolicy,
  ContextGraphJoinPolicyAuditInput,
  ContextGraphJoinPolicyRateReservationInput,
  ContextGraphJoinPolicyRateReservationResult,
  ContextGraphAutomaticApprovalCommitInput,
  ContextGraphAutomaticApprovalRepairInput,
  ContextGraphAutomaticApprovalRepairRecord,
  ContextGraphMemberPrincipalType,
  ContextGraphMemberStatus,
  ContextGraphMemberRow,
  NotificationRow,
  AssertionActivityKind,
} from './db.js';

export { StructuredLogger } from './structured-logger.js';
export { OperationTracker } from './operation-tracker.js';
export { MetricsCollector } from './metrics-collector.js';
export type { MetricsSource } from './metrics-collector.js';
export { handleNodeUIRequest } from './api.js';
export { scopeNotifications, PCA_COST_COVERED_TYPE } from './notifications-scope.js';
export type {
  NotifWire,
  ScopedNotificationsResult,
  NotificationScopeContext,
} from './notifications-scope.js';
export type { LlmSettingsCallbacks, TelemetrySettingsCallbacks } from './api.js';
export { LogPushWorker } from './gelf-push-worker.js';
export type { LogPushWorkerOptions } from './gelf-push-worker.js';
export { OtlpLogWorker } from './otlp-log-worker.js';
export type { OtlpLogWorkerOptions } from './otlp-log-worker.js';
export { ChatMemoryManager, AGENT_CONTEXT_GRAPH, CHAT_TURNS_ASSERTION } from './chat-memory.js';
export type {
  MemoryToolContext,
  MemoryStats,
  MemoryEntity,
  SessionPublicationStatus,
  SessionPublishResult,
  SessionGraphDeltaWatermark,
  SessionGraphDeltaResult,
} from './chat-memory.js';
export { LlmClient, LlmRequestError } from './llm/client.js';
export { resolveCapabilities } from './llm/capability-resolver.js';
export type { LlmConfig, LlmChatRequest, LlmChatMessage, LlmStreamEvent, LlmCompletionResult, LlmCapabilities } from './llm/types.js';
export {
  initTelemetry, shutdownTelemetry, isTelemetryConfigured,
  // Flush-only hook for the daemon's terminal shutdown point: exports what has
  // been recorded while leaving the provider live (shutdownTelemetry does not).
  flushTelemetry, TERMINAL_FLUSH_BUDGET_MS,
  // Back-compat shims for the pre-#1317 telemetry API (no-ops / legacy config).
  recordGauge, setOperationSpan,
} from './telemetry.js';
export type { TelemetryInitConfig, TelemetryResource, OtlpSignalConfig, TelemetryConfig } from './telemetry.js';
