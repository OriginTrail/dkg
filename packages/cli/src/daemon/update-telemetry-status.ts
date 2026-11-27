import type { LastUpdateCheck } from './state.js';

export type UpdateTelemetryVersionStatus =
  | 'disabled'
  | 'updating'
  | 'unknown'
  | 'channel-missing'
  | 'latest'
  | 'behind';

export type UpdateTelemetryState = {
  autoUpdateEnabled: boolean;
  isUpdating: boolean;
  lastUpdateCheck: LastUpdateCheck;
};

/**
 * Resolve the operator-visible update state with explicit precedence.
 * The log exporter calls this for every emitted record, so it reflects the
 * daemon's current state rather than the state at exporter construction.
 */
export function resolveUpdateTelemetryVersionStatus(
  state: UpdateTelemetryState,
): UpdateTelemetryVersionStatus {
  if (!state.autoUpdateEnabled) return 'disabled';
  if (state.isUpdating) return 'updating';
  if (state.lastUpdateCheck.checkedAt === 0) return 'unknown';
  if (state.lastUpdateCheck.channelTargetMissing) return 'channel-missing';
  return state.lastUpdateCheck.upToDate ? 'latest' : 'behind';
}
