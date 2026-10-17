// SPDX-License-Identifier: Apache-2.0

import {
  CONTEXT_GRAPH_AUTHORITY_RPC_SITES as CG_AUTH_RPC_SITES,
  withRpcUsageSite,
} from '@origintrail-official/dkg-chain';
import type {
  SwmAgentGateRefreshOracle,
  SwmAgentGateRefreshResult,
} from '@origintrail-official/dkg-publisher';

import { rememberBounded } from '../../bounded-map.js';
import { isBoundedOperationTimeoutError, runBoundedOperation } from '../../bounded-operation.js';
import {
  isRetryableContextGraphAuthorityUnavailableReason,
  type ContextGraphAgentGateAuthority,
} from './context-graph-authority.js';

/**
 * The agent side of the shared-memory write gate's second look (the publisher's
 * `swm-write-gate-refresh.ts`).
 *
 * The receiver's write path judges a signer from its projected gate, the local
 * metadata roster. A writer approved after the receiver last refreshed that
 * metadata is absent from it, and the refresh that would add the writer can
 * lag behind the writer's first share. The canonical gate, the one the Sender
 * Key setup and sync authorization use, is the chain roster for a registered
 * graph, so it already contains the new member: the write path only has to ask
 * it. This oracle reads the canonical gate; when that still excludes the signer
 * it refreshes the metadata from the curator, as sync authorization does on
 * the same miss, and reads the gate once more.
 *
 * The answer keeps an unavailable authority apart from a non-member: the
 * publisher answers the first with a retryable rejection and only the second
 * with a permanent one. Everything is bounded by one deadline well inside the
 * sender's fan-out timeout, since an answer that arrives after that timeout is
 * worse than a retryable rejection.
 *
 * A valid signature proves control of a key, not membership, and keys are
 * free: a peer the roster excludes could otherwise buy a chain read per fresh
 * key. So the looks themselves are rationed per graph and per sending peer
 * within a window; a miss the ration refuses is answered as unavailable and
 * retryable, which costs the receiver nothing and lets a member whose approval
 * raced the window land on the sender's next attempt. Within the window the
 * last fresh gate of a graph answers every signer it contains without a read,
 * and a signer it excluded is remembered; both only while the graph's roster
 * revision has not moved, so a revocation or an approval that reaches the local
 * metadata is never overridden by what an earlier look saw.
 */
export interface SwmWriteGateRefreshHost {
  /** The canonical agent gate, read fresh (no cached roster). */
  resolveAgentGate(
    contextGraphId: string,
    options: { signal: AbortSignal },
  ): Promise<ContextGraphAgentGateAuthority>;
  /** Pull the graph's authoritative metadata from its curator. Honors the cooldown. */
  refreshMetaFromCurator(
    contextGraphId: string,
    options: { signal: AbortSignal },
  ): Promise<boolean>;
  /**
   * The graph's roster revision: moves whenever a fact of its local roster
   * (allowed, participant or revoked agents) may have changed. A memory of
   * this oracle answers only while it is unchanged.
   */
  readRosterRevision(contextGraphId: string): number | string;
}

export interface SwmWriteGateRefreshOptions {
  /** One deadline for both gate reads and the curator refresh. */
  timeoutMs?: number;
  /**
   * The window: how long a fresh gate answers for its graph, how long an
   * excluded signer is remembered, and over which the looks are rationed.
   */
  windowMs?: number;
  /** Looks one sending peer may start on one graph per window. */
  looksPerPeer?: number;
  /** Looks all peers together may start on one graph per window. */
  looksPerGraph?: number;
  /** How many remembered graphs, signers and peers at most, each. */
  memoryMax?: number;
  now?: () => number;
}

/**
 * The sender's substrate fan-out gives one delivery 15 s; a receiver still
 * inside its second look at that point looks failed, which drops the peer.
 */
export const DEFAULT_SWM_WRITE_GATE_REFRESH_TIMEOUT_MS = 8_000;
export const DEFAULT_SWM_WRITE_GATE_REFRESH_WINDOW_MS = 10_000;
/** A node hosting two late members may need two looks in one window. */
export const DEFAULT_SWM_WRITE_GATE_LOOKS_PER_PEER = 2;
export const DEFAULT_SWM_WRITE_GATE_LOOKS_PER_GRAPH = 4;
export const DEFAULT_SWM_WRITE_GATE_MEMORY_MAX = 1_024;

/** Unavailable reasons of the second look itself, beside the authority's own. */
export const SWM_WRITE_GATE_REFRESH_TIMEOUT_REASON = 'swm-write-gate-refresh-timeout';
export const SWM_WRITE_GATE_REFRESH_FAILED_REASON = 'swm-write-gate-refresh-failed';
export const SWM_WRITE_GATE_REFRESH_RATIONED_REASON = 'swm-write-gate-refresh-rationed';
export const SWM_WRITE_GATE_REFRESH_ROSTER_CHANGED_REASON = 'swm-write-gate-refresh-roster-changed';

const RATIONED: SwmAgentGateRefreshResult = Object.freeze({
  kind: 'unavailable',
  reason: SWM_WRITE_GATE_REFRESH_RATIONED_REASON,
  retryable: true,
});
/**
 * The graph's roster changed while the look was in flight: what it read may
 * predate a revocation or an approval the local metadata already holds, so it
 * admits nobody. The sender's next attempt is judged from coherent gates.
 */
const ROSTER_CHANGED: SwmAgentGateRefreshResult = Object.freeze({
  kind: 'unavailable',
  reason: SWM_WRITE_GATE_REFRESH_ROSTER_CHANGED_REASON,
  retryable: true,
});

function gateContains(
  gate: ContextGraphAgentGateAuthority | SwmAgentGateRefreshResult,
  signerAddress: string,
): boolean {
  if (gate.kind !== 'available') return false;
  const signer = signerAddress.toLowerCase();
  return gate.agentAddresses.some((address) => address.toLowerCase() === signer);
}

function projectAuthority(authority: ContextGraphAgentGateAuthority): SwmAgentGateRefreshResult {
  if (authority.kind === 'unavailable') {
    return {
      kind: 'unavailable',
      reason: authority.reason,
      retryable: isRetryableContextGraphAuthorityUnavailableReason(authority.reason),
    };
  }
  return authority;
}

async function secondLook(
  host: SwmWriteGateRefreshHost,
  contextGraphId: string,
  signerAddress: string,
  timeoutMs: number,
): Promise<SwmAgentGateRefreshResult> {
  try {
    return await runBoundedOperation(
      async (signal) => {
        // Billed to the write apply site whose read this is, like the first.
        const readGate = () => withRpcUsageSite(
          CG_AUTH_RPC_SITES.workspaceApply,
          () => host.resolveAgentGate(contextGraphId, { signal }),
        );
        const current = await readGate();
        // An unavailable authority is not evidence about the signer; a refresh
        // of local metadata would not make it available either.
        if (current.kind === 'unavailable' || gateContains(current, signerAddress)) {
          return projectAuthority(current);
        }
        // The canonical gate excludes the signer or has no roster. Where that
        // gate rests on local metadata, the metadata may be what is stale:
        // refresh it from the curator and read once more.
        let refreshed = false;
        try {
          refreshed = await host.refreshMetaFromCurator(contextGraphId, { signal });
        } catch (err) {
          if (signal.aborted) throw err;
        }
        return projectAuthority(refreshed ? await readGate() : current);
      },
      { timeoutMs, label: `SWM write gate refresh for "${contextGraphId}"` },
    );
  } catch (err) {
    return {
      kind: 'unavailable',
      reason: isBoundedOperationTimeoutError(err)
        ? SWM_WRITE_GATE_REFRESH_TIMEOUT_REASON
        : `${SWM_WRITE_GATE_REFRESH_FAILED_REASON}: ${err instanceof Error ? err.message : String(err)}`,
      retryable: true,
    };
  }
}

interface Remembered<T> {
  readonly expiresAt: number;
  /** The graph's roster revision when the value was learned. */
  readonly revision: number | string;
  readonly value: T;
}

/** Looks started within the current window, per graph and per (graph, peer). */
interface Ration {
  windowEndsAt: number;
  looks: number;
}

/** One oracle per receiver. */
export function createSwmWriteGateRefreshOracle(
  host: SwmWriteGateRefreshHost,
  options: SwmWriteGateRefreshOptions = {},
): SwmAgentGateRefreshOracle {
  const timeoutMs = options.timeoutMs ?? DEFAULT_SWM_WRITE_GATE_REFRESH_TIMEOUT_MS;
  const windowMs = options.windowMs ?? DEFAULT_SWM_WRITE_GATE_REFRESH_WINDOW_MS;
  const looksPerPeer = options.looksPerPeer ?? DEFAULT_SWM_WRITE_GATE_LOOKS_PER_PEER;
  const looksPerGraph = options.looksPerGraph ?? DEFAULT_SWM_WRITE_GATE_LOOKS_PER_GRAPH;
  const memoryMax = options.memoryMax ?? DEFAULT_SWM_WRITE_GATE_MEMORY_MAX;
  const now = options.now ?? Date.now;

  /** The look in flight for a signer, with the roster revision it started under. */
  const inFlight = new Map<string, { revision: number | string; look: Promise<SwmAgentGateRefreshResult> }>();
  /** The last fresh gate of a graph. */
  const freshGates = new Map<string, Remembered<SwmAgentGateRefreshResult>>();
  /** Signers a fresh gate excluded, by graph and signer. */
  const excluded = new Map<string, Remembered<SwmAgentGateRefreshResult>>();
  const rations = new Map<string, Ration>();

  const recall = <T>(memory: Map<string, Remembered<T>>, key: string, revision: number | string): T | undefined => {
    const remembered = memory.get(key);
    if (remembered === undefined) return undefined;
    if (remembered.expiresAt > now() && remembered.revision === revision) return remembered.value;
    memory.delete(key);
    return undefined;
  };
  const remember = <T>(memory: Map<string, Remembered<T>>, key: string, revision: number | string, value: T): void => {
    rememberBounded(memory, key, { expiresAt: now() + windowMs, revision, value }, memoryMax);
  };
  /** Take one look from the ration of `key`, or refuse it. */
  const takeLook = (key: string, limit: number): boolean => {
    const at = now();
    const ration = rations.get(key);
    if (ration === undefined || ration.windowEndsAt <= at) {
      rememberBounded(rations, key, { windowEndsAt: at + windowMs, looks: 1 }, memoryMax);
      return true;
    }
    if (ration.looks >= limit) return false;
    ration.looks += 1;
    return true;
  };

  return async (contextGraphId, signerAddress, fromPeerId) => {
    const signer = signerAddress.toLowerCase();
    const signerKey = `${contextGraphId}\u0000${signer}`;
    const revision = host.readRosterRevision(contextGraphId);
    const freshGate = recall(freshGates, contextGraphId, revision);
    if (freshGate !== undefined && gateContains(freshGate, signer)) return freshGate;
    const remembered = recall(excluded, signerKey, revision);
    if (remembered !== undefined) return remembered;
    // A look in flight is shared only within its roster revision: a request
    // whose projected gate already reflects a later revocation must not
    // inherit what an earlier look read.
    const pending = inFlight.get(signerKey);
    let look: Promise<SwmAgentGateRefreshResult>;
    if (pending !== undefined && pending.revision === revision) {
      look = pending.look;
    } else {
      // The graph's ration is taken only when the peer's allows the look, so one
      // refused peer does not consume what another peer's late member needs.
      if (!takeLook(`${contextGraphId}\u0000${fromPeerId}`, looksPerPeer)) return RATIONED;
      if (!takeLook(contextGraphId, looksPerGraph)) return RATIONED;
      const entry = { revision, look: secondLook(host, contextGraphId, signer, timeoutMs) };
      look = entry.look.finally(() => { if (inFlight.get(signerKey) === entry) inFlight.delete(signerKey); });
      inFlight.set(signerKey, entry);
    }
    const result = await look;
    if (host.readRosterRevision(contextGraphId) !== revision) return ROSTER_CHANGED;
    if (result.kind === 'available') {
      remember(freshGates, contextGraphId, revision, result);
      if (!gateContains(result, signer)) remember(excluded, signerKey, revision, result);
    }
    return result;
  };
}
