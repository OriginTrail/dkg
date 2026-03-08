export { DashboardDB } from './db.js';
export type {
  DashboardDBOptions,
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
} from './db.js';

export { StructuredLogger } from './structured-logger.js';
export { OperationTracker } from './operation-tracker.js';
export { MetricsCollector } from './metrics-collector.js';
export type { MetricsSource } from './metrics-collector.js';
export { handleNodeUIRequest } from './api.js';
export type { LlmSettingsCallbacks } from './api.js';
export { ChatAssistant } from './chat-assistant.js';
export type { ChatRequest, ChatResponse, ChatStreamEvent, ChatLlmDiagnostics } from './chat-assistant.js';
export { ChatMemoryManager } from './chat-memory.js';
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
export { initTelemetry, recordGauge, setOperationSpan, isTelemetryConfigured } from './telemetry.js';
export type { TelemetryConfig } from './telemetry.js';
