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
 * Nothing is cached and no look is shared between requests: a roster can
 * change on chain, in an accepted private authority or in local metadata
 * independently of one another, so any memory of a look would need a fence
 * on all of them. Instead every miss is judged from a read of its own, and the
 * reads are rationed. A valid signature proves control of a key, not
 * membership, and keys are free, so the looks are rationed per graph and per
 * sending peer within a window; a miss the ration refuses is answered as
 * unavailable and retryable, which costs the receiver nothing and lets the
 * sender's next attempt be judged afresh.
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
}

export interface SwmWriteGateRefreshOptions {
  /** One deadline for both gate reads and the curator refresh. */
  timeoutMs?: number;
  /** The window over which the looks are rationed. */
  windowMs?: number;
  /** Looks one sending peer may start on one graph per window. */
  looksPerPeer?: number;
  /** Looks all peers together may start on one graph per window. */
  looksPerGraph?: number;
  /** How many rations are tracked at most, for graphs and for graph-peer pairs each. */
  rationMemoryMax?: number;
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
export const DEFAULT_SWM_WRITE_GATE_RATION_MEMORY_MAX = 1_024;

/** Unavailable reasons of the second look itself, beside the authority's own. */
export const SWM_WRITE_GATE_REFRESH_TIMEOUT_REASON = 'swm-write-gate-refresh-timeout';
export const SWM_WRITE_GATE_REFRESH_FAILED_REASON = 'swm-write-gate-refresh-failed';
export const SWM_WRITE_GATE_REFRESH_RATIONED_REASON = 'swm-write-gate-refresh-rationed';

const RATIONED: SwmAgentGateRefreshResult = Object.freeze({
  kind: 'unavailable',
  reason: SWM_WRITE_GATE_REFRESH_RATIONED_REASON,
  retryable: true,
});

function gateContains(gate: ContextGraphAgentGateAuthority, signerAddress: string): boolean {
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
  const rationMemoryMax = options.rationMemoryMax ?? DEFAULT_SWM_WRITE_GATE_RATION_MEMORY_MAX;
  const now = options.now ?? Date.now;
  // Graph and peer rations live apart, so churn of sending peers cannot evict
  // a graph's counter and hand it a fresh budget inside its window.
  const graphRations = new Map<string, Ration>();
  const peerRations = new Map<string, Ration>();

  const current = (rations: Map<string, Ration>, key: string): Ration | undefined => {
    const ration = rations.get(key);
    return ration !== undefined && ration.windowEndsAt > now() ? ration : undefined;
  };
  const hasLook = (rations: Map<string, Ration>, key: string, limit: number): boolean =>
    (current(rations, key)?.looks ?? 0) < limit;
  const takeLook = (rations: Map<string, Ration>, key: string): void => {
    const ration = current(rations, key);
    if (ration !== undefined) ration.looks += 1;
    else rememberBounded(rations, key, { windowEndsAt: now() + windowMs, looks: 1 }, rationMemoryMax);
  };

  return async (contextGraphId, signerAddress, fromPeerId) => {
    // Both rations are checked before either is taken: a refused request
    // consumes nothing, neither another peer's late member's look nor map space.
    const peerKey = `${contextGraphId}\u0000${fromPeerId}`;
    if (!hasLook(peerRations, peerKey, looksPerPeer) || !hasLook(graphRations, contextGraphId, looksPerGraph)) {
      return RATIONED;
    }
    takeLook(peerRations, peerKey);
    takeLook(graphRations, contextGraphId);
    return secondLook(host, contextGraphId, signerAddress, timeoutMs);
  };
}
