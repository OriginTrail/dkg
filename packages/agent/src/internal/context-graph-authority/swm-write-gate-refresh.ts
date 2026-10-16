// SPDX-License-Identifier: Apache-2.0

import {
  CONTEXT_GRAPH_AUTHORITY_RPC_SITES as CG_AUTH_RPC_SITES,
  withRpcUsageSite,
} from '@origintrail-official/dkg-chain';
import type {
  SwmAgentGateRefreshOracle,
  SwmAgentGateRefreshResult,
} from '@origintrail-official/dkg-publisher';

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
 * worse than a retryable rejection. Only an authenticated signer reaches this
 * oracle, and a signer a fresh gate excluded is remembered for a short while so
 * one non-member cannot make the receiver read the chain on every write.
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
  /** How long a fresh gate that excluded a signer answers for that signer. */
  excludedSignerTtlMs?: number;
  /** How many excluded signers are remembered at most. */
  excludedSignerCacheMax?: number;
  now?: () => number;
}

/**
 * The sender's substrate fan-out gives one delivery 15 s; a receiver still
 * inside its second look at that point looks failed, which drops the peer.
 */
export const DEFAULT_SWM_WRITE_GATE_REFRESH_TIMEOUT_MS = 8_000;
export const DEFAULT_SWM_WRITE_GATE_EXCLUDED_SIGNER_TTL_MS = 10_000;
export const DEFAULT_SWM_WRITE_GATE_EXCLUDED_SIGNER_CACHE_MAX = 1_024;

/** Unavailable reasons of the second look itself, beside the authority's own. */
export const SWM_WRITE_GATE_REFRESH_TIMEOUT_REASON = 'swm-write-gate-refresh-timeout';
export const SWM_WRITE_GATE_REFRESH_FAILED_REASON = 'swm-write-gate-refresh-failed';

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

/**
 * One oracle per receiver. Concurrent misses by the same signer on the same
 * graph share one second look; a fresh gate that excluded the signer answers
 * again for `excludedSignerTtlMs` without new reads.
 */
export function createSwmWriteGateRefreshOracle(
  host: SwmWriteGateRefreshHost,
  options: SwmWriteGateRefreshOptions = {},
): SwmAgentGateRefreshOracle {
  const timeoutMs = options.timeoutMs ?? DEFAULT_SWM_WRITE_GATE_REFRESH_TIMEOUT_MS;
  const excludedTtlMs = options.excludedSignerTtlMs ?? DEFAULT_SWM_WRITE_GATE_EXCLUDED_SIGNER_TTL_MS;
  const excludedMax = options.excludedSignerCacheMax ?? DEFAULT_SWM_WRITE_GATE_EXCLUDED_SIGNER_CACHE_MAX;
  const now = options.now ?? Date.now;
  const inFlight = new Map<string, Promise<SwmAgentGateRefreshResult>>();
  const excluded = new Map<string, { expiresAt: number; result: SwmAgentGateRefreshResult }>();

  return async (contextGraphId, signerAddress) => {
    const key = `${contextGraphId}\u0000${signerAddress.toLowerCase()}`;
    const remembered = excluded.get(key);
    if (remembered !== undefined) {
      if (remembered.expiresAt > now()) return remembered.result;
      excluded.delete(key);
    }
    const pending = inFlight.get(key);
    if (pending !== undefined) return pending;
    const look = secondLook(host, contextGraphId, signerAddress, timeoutMs)
      .finally(() => { inFlight.delete(key); });
    inFlight.set(key, look);
    const result = await look;
    if (result.kind === 'available' && !gateContains(result, signerAddress)) {
      while (excluded.size >= excludedMax) {
        const oldest = excluded.keys().next().value;
        if (oldest === undefined) break;
        excluded.delete(oldest);
      }
      excluded.set(key, { expiresAt: now() + excludedTtlMs, result });
    }
    return result;
  };
}
