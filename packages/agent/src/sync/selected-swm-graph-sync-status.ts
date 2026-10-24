export interface Rfc64SelectedSwmGraphSyncStatus {
  readonly mechanism: 'rfc64-selected-on-connect';
  readonly state: 'inactive' | 'waiting' | 'continuing' | 'converged';
  readonly configuredProviderCount: number;
  readonly retryRequiredProviderCount: number;
  readonly terminalProviderCount: number;
}

export interface ProjectRfc64SelectedSwmGraphSyncStatusInput {
  readonly selected: boolean;
  readonly configuredProviderCount: number;
  readonly retryRequiredProviderCount: number;
  readonly terminalProviderCount: number;
  readonly sharedMemorySynced: boolean;
}

/** Project retry ownership without exposing provider identities. */
export function projectRfc64SelectedSwmGraphSyncStatus(
  input: ProjectRfc64SelectedSwmGraphSyncStatusInput,
): Rfc64SelectedSwmGraphSyncStatus {
  const state = !input.selected || input.configuredProviderCount === 0
    ? 'inactive'
    : input.sharedMemorySynced || input.terminalProviderCount > 0
      ? 'converged'
      : input.retryRequiredProviderCount > 0
        ? 'continuing'
        : 'waiting';
  return Object.freeze({
    mechanism: 'rfc64-selected-on-connect',
    state,
    configuredProviderCount: input.configuredProviderCount,
    retryRequiredProviderCount: input.retryRequiredProviderCount,
    terminalProviderCount: input.terminalProviderCount,
  });
}
