export interface PreparedPeerAttempt<T> {
  readonly result?: T;
  /** Recoverable attempt failure retained after the caller completed required inspection. */
  readonly failure?: unknown;
}

export interface BoundedPreparedPeerTraversalOptions<T> {
  readonly candidatePeerIds: readonly string[];
  readonly maxPeers: number;
  readonly operationLabel: string;
  assertCurrent(): void;
  shouldContinue(): boolean;
  selectPeerWindow?(
    peerIds: string[],
    options: { readonly maxPeers: number },
  ): readonly string[];
  preparePeer(peerId: string): Promise<boolean>;
  attemptPeer(peerId: string): Promise<PreparedPeerAttempt<T>>;
  isSuccess(result: T | undefined): boolean;
  /** Exact-fetch inspection errors are terminal; proof-repair transport errors may fail over. */
  canContinueAfterThrownAttempt?(error: unknown): boolean;
  log(message: string): void;
}

export interface BoundedPreparedPeerTraversalResult<T> {
  readonly succeeded: boolean;
  readonly result?: T;
  readonly peerAttempts: number;
  readonly attemptedPeerIds: readonly string[];
  readonly peerWindow: readonly string[];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Canonical bounded peer preparation and failover policy for exact fetches.
 * Callers retain their evidence construction and result-consumption semantics.
 */
export async function runBoundedPreparedPeerTraversal<T>(
  options: BoundedPreparedPeerTraversalOptions<T>,
): Promise<BoundedPreparedPeerTraversalResult<T>> {
  const maxPeers = Number.isInteger(options.maxPeers) && options.maxPeers > 0
    ? options.maxPeers
    : 0;
  const uniqueCandidates = [...new Set(options.candidatePeerIds.filter(Boolean))];
  const selected = options.selectPeerWindow
    ? options.selectPeerWindow(uniqueCandidates, { maxPeers })
    : uniqueCandidates;
  const candidateSet = new Set(uniqueCandidates);
  const peerWindow = [...new Set(selected)]
    .filter((peerId) => candidateSet.has(peerId))
    .slice(0, maxPeers);
  const attemptedPeerIds: string[] = [];
  let peerAttempts = 0;

  for (const peerId of peerWindow) {
    options.assertCurrent();
    if (!options.shouldContinue()) break;
    attemptedPeerIds.push(peerId);

    let prepared: boolean;
    try {
      prepared = await options.preparePeer(peerId);
    } catch (error) {
      options.assertCurrent();
      options.log(`${options.operationLabel} ${peerId} failed: ${errorMessage(error)}`);
      continue;
    }
    options.assertCurrent();
    if (!prepared) continue;
    peerAttempts += 1;

    let attempt: PreparedPeerAttempt<T>;
    try {
      attempt = await options.attemptPeer(peerId);
    } catch (error) {
      options.assertCurrent();
      if (options.canContinueAfterThrownAttempt?.(error) === false) throw error;
      options.log(`${options.operationLabel} ${peerId} failed: ${errorMessage(error)}`);
      continue;
    }
    options.assertCurrent();
    if (attempt.failure !== undefined) {
      options.log(
        `${options.operationLabel} ${peerId} failed: ${errorMessage(attempt.failure)}`,
      );
    }
    if (options.isSuccess(attempt.result)) {
      return {
        succeeded: true,
        ...(attempt.result === undefined ? {} : { result: attempt.result }),
        peerAttempts,
        attemptedPeerIds,
        peerWindow,
      };
    }
  }

  return {
    succeeded: false,
    peerAttempts,
    attemptedPeerIds,
    peerWindow,
  };
}
