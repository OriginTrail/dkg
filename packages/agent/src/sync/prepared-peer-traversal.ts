export type PreparedPeerAttemptOutcome<T> =
  | {
      readonly kind: 'done';
      readonly result?: T;
      /** A recoverable transport failure may still leave inspected durable progress complete. */
      readonly diagnostic?: unknown;
    }
  | {
      readonly kind: 'continue';
      readonly error?: unknown;
    }
  | {
      readonly kind: 'terminal';
      readonly error: unknown;
    };

export interface BoundedPreparedPeerTraversalOptions<T> {
  readonly candidatePeerIds: readonly string[];
  readonly maxPeers: number;
  readonly operationLabel: string;
  assertCurrent(): void;
  selectPeerWindow?(
    peerIds: string[],
    options: { readonly maxPeers: number },
  ): readonly string[];
  preparePeer(peerId: string): Promise<boolean>;
  attemptPeer(peerId: string): Promise<PreparedPeerAttemptOutcome<T>>;
  log(message: string): void;
}

export interface BoundedPreparedPeerTraversalResult<T> {
  readonly completion: 'done' | 'exhausted';
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

    let outcome: PreparedPeerAttemptOutcome<T>;
    try {
      outcome = await options.attemptPeer(peerId);
    } catch (error) {
      options.assertCurrent();
      throw error;
    }
    options.assertCurrent();
    if (outcome.kind === 'terminal') throw outcome.error;
    if (outcome.kind === 'continue') {
      if (outcome.error !== undefined) {
        options.log(`${options.operationLabel} ${peerId} failed: ${errorMessage(outcome.error)}`);
      }
      continue;
    }
    if (outcome.diagnostic !== undefined) {
      options.log(
        `${options.operationLabel} ${peerId} failed: ${errorMessage(outcome.diagnostic)}`,
      );
    }
    return {
      completion: 'done',
      ...(outcome.result === undefined ? {} : { result: outcome.result }),
      peerAttempts,
      attemptedPeerIds,
      peerWindow,
    };
  }

  return {
    completion: 'exhausted',
    peerAttempts,
    attemptedPeerIds,
    peerWindow,
  };
}
