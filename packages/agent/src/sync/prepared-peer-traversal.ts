/** Outcome of preparing one peer before it is attempted. */
export type PreparedPeerPreparation =
  | { readonly kind: 'ready' }
  /** An expected, non-error condition that excludes this peer from the attempt. */
  | { readonly kind: 'skipped'; readonly reason: string };

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
      /** An expected empty outcome, such as a clean miss, that is not an error. */
      readonly reason?: string;
    }
  | {
      readonly kind: 'terminal';
      readonly error: unknown;
    };

/** How one peer of the window was handled, in the traversal's own vocabulary. */
export type PreparedPeerAttemptRecord =
  | { readonly peerId: string; readonly outcome: 'skipped'; readonly reason: string }
  | { readonly peerId: string; readonly outcome: 'prepare-failed'; readonly error: unknown }
  | { readonly peerId: string; readonly outcome: 'failed'; readonly error: unknown }
  | { readonly peerId: string; readonly outcome: 'missed'; readonly reason?: string }
  | { readonly peerId: string; readonly outcome: 'done' };

export interface BoundedPreparedPeerTraversalOptions<T> {
  readonly candidatePeerIds: readonly string[];
  readonly maxPeers: number;
  readonly operationLabel: string;
  assertCurrent(): void;
  selectPeerWindow?(
    peerIds: string[],
    options: { readonly maxPeers: number },
  ): readonly string[];
  preparePeer(peerId: string): Promise<PreparedPeerPreparation>;
  attemptPeer(peerId: string): Promise<PreparedPeerAttemptOutcome<T>>;
  log(message: string): void;
}

export interface BoundedPreparedPeerTraversalResult<T> {
  readonly completion: 'done' | 'exhausted';
  readonly result?: T;
  readonly peerAttempts: number;
  readonly attemptedPeerIds: readonly string[];
  readonly peerWindow: readonly string[];
  /** One record per entry of {@link attemptedPeerIds}, in traversal order. */
  readonly attempts: readonly PreparedPeerAttemptRecord[];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function compactError(error: unknown): string {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code ?? '')
    : '';
  const detail = code ? `${code}:${errorMessage(error)}` : errorMessage(error);
  return detail.replace(/\s+/g, ' ').slice(0, 72);
}

/** Compact `peer=outcome` rendering of one record for aggregate failure messages. */
export function describePreparedPeerAttempt(record: PreparedPeerAttemptRecord): string {
  const peer = record.peerId.slice(-8);
  switch (record.outcome) {
    case 'skipped':
      return `${peer}=skipped:${record.reason}`;
    case 'prepare-failed':
      return `${peer}=prepare:${compactError(record.error)}`;
    case 'failed':
      return `${peer}=error:${compactError(record.error)}`;
    case 'missed':
      return record.reason === undefined ? `${peer}=missed` : `${peer}=missed:${record.reason}`;
    case 'done':
      return `${peer}=done`;
  }
}

/**
 * Canonical bounded peer preparation and failover policy for exact fetches.
 * Callers retain their evidence construction and result-consumption semantics;
 * the traversal records how every peer in the window was handled.
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
  const attempts: PreparedPeerAttemptRecord[] = [];
  let peerAttempts = 0;

  for (const peerId of peerWindow) {
    options.assertCurrent();
    attemptedPeerIds.push(peerId);

    let preparation: PreparedPeerPreparation;
    try {
      preparation = await options.preparePeer(peerId);
    } catch (error) {
      options.assertCurrent();
      attempts.push({ peerId, outcome: 'prepare-failed', error });
      options.log(`${options.operationLabel} ${peerId} failed: ${errorMessage(error)}`);
      continue;
    }
    options.assertCurrent();
    if (preparation.kind === 'skipped') {
      attempts.push({ peerId, outcome: 'skipped', reason: preparation.reason });
      options.log(`${options.operationLabel} ${peerId} skipped: ${preparation.reason}`);
      continue;
    }
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
        attempts.push({ peerId, outcome: 'failed', error: outcome.error });
        options.log(`${options.operationLabel} ${peerId} failed: ${errorMessage(outcome.error)}`);
      } else {
        attempts.push({
          peerId,
          outcome: 'missed',
          ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
        });
      }
      continue;
    }
    if (outcome.diagnostic !== undefined) {
      options.log(
        `${options.operationLabel} ${peerId} failed: ${errorMessage(outcome.diagnostic)}`,
      );
    }
    attempts.push({ peerId, outcome: 'done' });
    return {
      completion: 'done',
      ...(outcome.result === undefined ? {} : { result: outcome.result }),
      peerAttempts,
      attemptedPeerIds,
      peerWindow,
      attempts,
    };
  }

  return {
    completion: 'exhausted',
    peerAttempts,
    attemptedPeerIds,
    peerWindow,
    attempts,
  };
}
