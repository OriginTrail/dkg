/** Outcome of one caller-owned attempt against a selected peer. */
export type PreparedPeerAttemptOutcome<T> =
  /** An expected, non-error condition that excludes this peer from a real attempt. */
  | { readonly kind: 'skipped'; readonly reason: string }
  /** Peer preparation failed before a network fetch was attempted. */
  | { readonly kind: 'prepare-failed'; readonly error: unknown }
  | {
      readonly kind: 'done';
      readonly result?: T;
      /** A recoverable transport failure may still leave inspected durable progress complete. */
      readonly diagnostic?: unknown;
    }
  /** The attempt failed; failover continues with the next peer. */
  | { readonly kind: 'failed'; readonly error: unknown }
  /** The peer answered without an error but did not resolve the request. */
  | { readonly kind: 'missed'; readonly reason: string }
  /** The traversal stops and surfaces this error. */
  | { readonly kind: 'terminal'; readonly error: unknown };

/** How one peer of the window was handled, in the same vocabulary as the outcomes. */
export type PreparedPeerAttemptRecord =
  | { readonly peerId: string; readonly kind: 'skipped'; readonly reason: string }
  | { readonly peerId: string; readonly kind: 'prepare-failed'; readonly error: unknown }
  | { readonly peerId: string; readonly kind: 'failed'; readonly error: unknown }
  | { readonly peerId: string; readonly kind: 'missed'; readonly reason: string }
  | { readonly peerId: string; readonly kind: 'done' };

/** Stable position metadata for one peer in the selected traversal window. */
export interface PreparedPeerTraversalPosition {
  /** Zero-based position in the selected window. */
  readonly index: number;
  /** Current peer plus every peer that remains after it. */
  readonly remainingPeers: number;
  readonly totalPeers: number;
  readonly selectedPeerIds: readonly string[];
}

export interface BoundedPreparedPeerTraversalOptions<T> {
  readonly candidatePeerIds: readonly string[];
  readonly maxPeers: number;
  readonly operationLabel: string;
  assertCurrent(): void;
  selectPeerWindow?(
    peerIds: string[],
    options: { readonly maxPeers: number },
  ): readonly string[];
  /** Called exactly once after de-duplication and window selection. */
  onWindowSelected?(selection: PreparedPeerWindowSelection): void;
  attemptPeer(
    peerId: string,
    position: PreparedPeerTraversalPosition,
  ): Promise<PreparedPeerAttemptOutcome<T>>;
  log(message: string): void;
}

export interface PreparedPeerWindowSelection {
  readonly candidatePeerIds: readonly string[];
  readonly selectedPeerIds: readonly string[];
  readonly maxPeers: number;
}

export interface BoundedPreparedPeerTraversalResult<T> {
  readonly completion: 'done' | 'exhausted';
  readonly result?: T;
  /** One record per peer taken from the window, in traversal order. */
  readonly attempts: readonly PreparedPeerAttemptRecord[];
  /** Prepared peers that were actually attempted, derived from {@link attempts}. */
  readonly peerAttempts: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function countPeerAttempts(attempts: readonly PreparedPeerAttemptRecord[]): number {
  return attempts.filter(({ kind }) => kind === 'done' || kind === 'failed' || kind === 'missed').length;
}

/** Pure window construction shared by traversal and caller-owned telemetry. */
export function selectBoundedPreparedPeerWindow(options: Pick<
  BoundedPreparedPeerTraversalOptions<unknown>,
  'candidatePeerIds' | 'maxPeers' | 'selectPeerWindow'
>): PreparedPeerWindowSelection {
  const maxPeers = Number.isInteger(options.maxPeers) && options.maxPeers > 0
    ? options.maxPeers
    : 0;
  const uniqueCandidates = [...new Set(options.candidatePeerIds.filter(Boolean))];
  const selected = options.selectPeerWindow
    ? options.selectPeerWindow(uniqueCandidates, { maxPeers })
    : uniqueCandidates;
  const candidateSet = new Set(uniqueCandidates);
  const selectedPeerIds = [...new Set(selected)]
    .filter((peerId) => candidateSet.has(peerId))
    .slice(0, maxPeers);
  return { candidatePeerIds: uniqueCandidates, selectedPeerIds, maxPeers };
}

/**
 * Canonical bounded peer-window iteration and outcome accounting. The caller
 * owns preparation, deadlines, transport, and result interpretation inside one
 * explicit attempt callback.
 */
export async function runBoundedPreparedPeerTraversal<T>(
  options: BoundedPreparedPeerTraversalOptions<T>,
): Promise<BoundedPreparedPeerTraversalResult<T>> {
  const selection = selectBoundedPreparedPeerWindow(options);
  options.onWindowSelected?.(selection);
  const peerWindow = selection.selectedPeerIds;
  const attempts: PreparedPeerAttemptRecord[] = [];

  for (const [index, peerId] of peerWindow.entries()) {
    options.assertCurrent();
    const position: PreparedPeerTraversalPosition = {
      index,
      remainingPeers: peerWindow.length - index,
      totalPeers: peerWindow.length,
      selectedPeerIds: peerWindow,
    };

    let outcome: PreparedPeerAttemptOutcome<T>;
    try {
      outcome = await options.attemptPeer(peerId, position);
    } catch (error) {
      options.assertCurrent();
      throw error;
    }
    options.assertCurrent();
    if (outcome.kind === 'skipped') {
      attempts.push({ peerId, kind: 'skipped', reason: outcome.reason });
      options.log(`${options.operationLabel} ${peerId} skipped: ${outcome.reason}`);
      continue;
    }
    if (outcome.kind === 'prepare-failed') {
      attempts.push({ peerId, kind: 'prepare-failed', error: outcome.error });
      options.log(`${options.operationLabel} ${peerId} failed: ${errorMessage(outcome.error)}`);
      continue;
    }
    if (outcome.kind === 'terminal') throw outcome.error;
    if (outcome.kind === 'failed') {
      attempts.push({ peerId, kind: 'failed', error: outcome.error });
      options.log(`${options.operationLabel} ${peerId} failed: ${errorMessage(outcome.error)}`);
      continue;
    }
    if (outcome.kind === 'missed') {
      attempts.push({ peerId, kind: 'missed', reason: outcome.reason });
      continue;
    }
    if (outcome.diagnostic !== undefined) {
      options.log(
        `${options.operationLabel} ${peerId} failed: ${errorMessage(outcome.diagnostic)}`,
      );
    }
    attempts.push({ peerId, kind: 'done' });
    return {
      completion: 'done',
      ...(outcome.result === undefined ? {} : { result: outcome.result }),
      attempts,
      peerAttempts: countPeerAttempts(attempts),
    };
  }

  return {
    completion: 'exhausted',
    attempts,
    peerAttempts: countPeerAttempts(attempts),
  };
}
