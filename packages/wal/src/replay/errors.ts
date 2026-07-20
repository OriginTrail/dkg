export type WalReplayErrorCode =
  | 'WAL_REPLAY_INVALID_CONFIGURATION'
  | 'WAL_REPLAY_INVALID_OBJECT'
  | 'WAL_REPLAY_MIXED_SCOPE'
  | 'WAL_REPLAY_DUPLICATE_OBJECT'
  | 'WAL_REPLAY_MISSING_PARENT'
  | 'WAL_REPLAY_CAUSAL_CYCLE'
  | 'WAL_REPLAY_CAUSAL_BASE_MISMATCH'
  | 'WAL_REPLAY_STALE_RESOLUTION'
  | 'WAL_REPLAY_INCOMPLETE_RESOLUTION'
  | 'WAL_REPLAY_SEMANTIC_REJECTED'
  | 'WAL_REPLAY_SEMANTIC_RESULT_MISMATCH'
  | 'WAL_REPLAY_RESOURCE_LIMIT';

export type WalReplayDisposition = 'blocked' | 'quarantine';

export class WalReplayError extends Error {
  constructor(
    readonly code: WalReplayErrorCode,
    message: string,
    readonly disposition: WalReplayDisposition,
    readonly reasonCode?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'WalReplayError';
  }
}

export function replayError(
  code: WalReplayErrorCode,
  message: string,
  disposition: WalReplayDisposition,
  reasonCode?: string,
  cause?: unknown,
): never {
  throw new WalReplayError(
    code,
    message,
    disposition,
    reasonCode,
    cause === undefined ? undefined : { cause },
  );
}
