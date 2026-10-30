// SPDX-License-Identifier: Apache-2.0

/**
 * One peer's durable `_meta` of a context graph, fetched afresh from offset 0.
 *
 * The curator metadata refresh (`curator-meta-refresh.ts`) and the sub-graph
 * lookup of a write (`peer-sub-graph-registration.ts`) read a peer's `_meta`
 * this way and share these transport rules:
 *  - the requester's resumable meta checkpoint for the peer is cleared and a
 *    guaranteed-new responder session is asked for (`forceFreshSession`):
 *    clearing the offset alone is insufficient, page-fetch also retains
 *    unfinished responder-session tokens, and a stale cached row list must
 *    never be replayed as the snapshot;
 *  - the fetch is admitted through the node's sync scheduler, unless the caller
 *    already runs inside an admitted operation (see below);
 *  - at most one such fetch from a peer for a graph runs at a time. The
 *    responder keys a metadata session by requester and graph, so a second
 *    fresh session would supersede the first one's remaining pages. The wait
 *    for that turn comes after the admission: a fetch waiting for its turn holds
 *    no lock that another admitted fetch needs. A caller that stops waiting
 *    (its signal aborts) is answered at once and gives its admission back; its
 *    fetch never starts, and the fetches queued behind it still wait for the
 *    one ahead of it.
 *
 * What the result is used for (validation, checkpoints afterwards) stays with
 * the caller.
 */

import { contextGraphMetaGraphUri, type OperationContext } from '@origintrail-official/dkg-core';
import { throwIfOperationAborted, untilOperationAborted } from '../../bounded-operation.js';
import { hasSyncAdmissionSource } from '../attempt-telemetry.js';
import type { SyncPhase } from '../auth/request-build.js';
import { getSyncCheckpointKey, type SyncCheckpointStore } from '../checkpoint/state.js';
import type { SyncPageFetchOptions, SyncPageResult } from './page-fetch.js';

/** What the fetch needs of the agent. */
export interface FreshMetaFetchAgent {
  readonly syncCheckpoints: Pick<SyncCheckpointStore, 'delete'>;
  fetchSyncPages(
    ctx: OperationContext,
    remotePeerId: string,
    contextGraphId: string,
    includeSharedMemory: boolean,
    phase: SyncPhase,
    graphUri: string,
    deadline: number,
    options?: SyncPageFetchOptions,
  ): Promise<SyncPageResult>;
  runContextGraphSyncWithBackpressure<T>(
    ctx: OperationContext,
    contextGraphId: string,
    lane: 'durable',
    label: string,
    work: () => Promise<T>,
    admission: { operationSignal?: AbortSignal; source: 'control-plane' },
  ): Promise<T>;
}

export interface FreshMetaFetchOptions {
  /** The fetch's deadline, read when its turn starts (after admission and the wait for the peer). */
  readonly deadline: () => number;
  readonly signal?: AbortSignal;
}

/** Per agent: the last fetch's turn for each `<peer>\0<graph>`; it settles when that fetch does. */
const freshMetaFetchTurns = new WeakMap<object, Map<string, Promise<void>>>();

/**
 * `fetch` after every earlier one of `key`. Without an earlier one it starts in
 * the caller's turn of the event loop, as a fetch did before turns existed:
 * the curator refresh's single-flight is observed in that turn, and
 * `withKeyedLocks` always starts its work a microtask later. A caller whose
 * `signal` aborts is answered at once; a fetch still waiting for its turn
 * then never starts, and the one after it still waits for the one before it.
 */
function inTurn<T>(
  turns: Map<string, Promise<void>>,
  key: string,
  signal: AbortSignal | undefined,
  fetch: () => Promise<T>,
): Promise<T> {
  const previous = turns.get(key);
  let release!: () => void;
  const turn = new Promise<void>((resolve) => { release = resolve; });
  turns.set(key, turn);
  const run = async (): Promise<T> => {
    try {
      throwIfOperationAborted(signal);
      return await fetch();
    } finally {
      release();
      if (turns.get(key) === turn) turns.delete(key);
    }
  };
  return untilOperationAborted(previous === undefined ? run() : previous.then(run), signal);
}

/**
 * Fetch `peerId`'s complete durable `_meta` of `contextGraphId` in a fresh
 * session. Throws as soon as the caller's signal aborts, including while the
 * fetch waits for its turn.
 */
export function fetchFreshContextGraphMeta(
  agent: FreshMetaFetchAgent,
  ctx: OperationContext,
  peerId: string,
  contextGraphId: string,
  options: FreshMetaFetchOptions,
): Promise<SyncPageResult> {
  let turns = freshMetaFetchTurns.get(agent);
  if (turns === undefined) {
    turns = new Map();
    freshMetaFetchTurns.set(agent, turns);
  }
  const peerTurns = turns;
  const runFetch = () => inTurn(peerTurns, `${peerId}\0${contextGraphId}`, options.signal, () => {
    agent.syncCheckpoints.delete(getSyncCheckpointKey(peerId, contextGraphId, false, 'meta'));
    return agent.fetchSyncPages(
      ctx,
      peerId,
      contextGraphId,
      false,
      'meta',
      contextGraphMetaGraphUri(contextGraphId),
      options.deadline(),
      { signal: options.signal, forceFreshSession: true },
    );
  });
  // W1 §5.5 — TRIGGER attribution with a base case.
  //
  // Every fresh `_meta` fetch funnels here, so one guard covers all four
  // enumerated callers:
  //   1. `runImmediatePostApprovalSync` (dkg-agent-lifecycle.ts) — requester,
  //      no enclosing operation (gossipsub handler)
  //   2. `resolveCuratorPeerIdsForCg` (dkg-agent-lifecycle.ts) — requester,
  //      reached from the changelog lane's `runResync`, so it DOES run inside
  //      an admitted operation
  //   3. `authorizeSyncRequest` (sync/auth/request-authorize.ts) — RESPONDER,
  //      authorizing an inbound request; no requester operation exists
  //   (1 to 3 reach it through the curator metadata refresh)
  //   4. the sub-graph lookup of a write (`peer-sub-graph-registration.ts`) —
  //      requester, from the publisher's check before it refuses a write into
  //      a sub-graph the node has not registered; no enclosing operation
  //
  // `control-plane` therefore covers BOTH requester-side and responder-side
  // control traffic. Anyone later reading it as "requester meta refresh" is
  // wrong. A FIFTH caller must be checked against this list rather than
  // assumed to fit — the guard will silently give it a plausible label.
  //
  // Guarded on scope PRESENCE, never on `=== 'unspecified'`: an admitted
  // operation whose caller omitted `source` legitimately holds that sentinel,
  // and relabelling it `control-plane` would launder "we do not know" into a
  // confident answer. See `hasSyncAdmissionSource`'s doc comment.
  //
  // Case 2 keeps its ENCLOSING source on purpose. A refresh nested inside a
  // catch-up happens *because* of that catch-up — skip the catch-up and the
  // refresh does not happen — so those bytes are that lane's cost. Attributing
  // them to `control-plane` would move them out of the eligible numerator and
  // under-count the very lane §7.3 is evaluating.
  //
  // A standalone fetch is real outbound sync work: it is admitted through the
  // node-wide scheduler, so partitioned mode can route it to fast capacity and
  // the global cap still bounds it; in shared mode it may also take the one
  // reserved control-plane slot beside that cap (#3280), so a transfer that
  // holds every general slot does not refuse it. A nested one stays inside its
  // enclosing admission: acquiring twice could deadlock a saturated partition.
  return hasSyncAdmissionSource()
    ? runFetch()
    : agent.runContextGraphSyncWithBackpressure(
      ctx,
      contextGraphId,
      'durable',
      'durable:control-plane',
      runFetch,
      { operationSignal: options.signal, source: 'control-plane' },
    );
}
