// SPDX-License-Identifier: Apache-2.0

/**
 * Peer / SWM diagnostics + health readouts extracted from `dkg-agent.ts`
 * as part of the mechanical file-size reduction. These are read-mostly
 * snapshots driven by the daemon's localhost diagnostic routes
 * (`/api/peer-info`, `/api/slo`) and the MCP `dkg_peer_info` tool.
 *
 * Following the package's established `sync/` and `p2p/` extraction
 * convention, each function takes its `DKGAgent` state explicitly via a
 * small deps object rather than reaching into the instance, so behaviour
 * is unchanged — a 1:1 move. The thin `DKGAgent` methods remain as the
 * public surface and delegate here.
 */

import { createOperationContext, PROTOCOL_MESSAGE, PROTOCOL_SYNC } from '@origintrail-official/dkg-core';
import type { DKGNode, Logger } from '@origintrail-official/dkg-core';
import type { SharedMemoryHandler } from '@origintrail-official/dkg-publisher';
import type { Messenger } from './p2p/messenger.js';
import type { PeerHealth, PeerDiagnostics, PeerConnectionSnapshot, SyncReconcilerBackoff } from './dkg-agent-types.js';
import { SYNC_STALENESS_THRESHOLD_MS } from './dkg-agent-constants.js';

export async function getPeerProtocols(node: DKGNode, peerId: string): Promise<string[]> {
  try {
    const { peerIdFromString } = await import('@libp2p/peer-id');
    const pid = peerIdFromString(peerId);
    const peer = await node.libp2p.peerStore.get(pid);
    return [...(peer.protocols ?? [])];
  } catch {
    return [];
  }
}

/**
 * Snapshot of SWM gossip publish health (rc.9 PR-A). See the
 * `DKGAgent.getSwmGossipStats` JSDoc for the field semantics.
 */
export function getSwmGossipStats(state: {
  publishFailures: ReadonlyMap<string, number>;
  publishFailuresOverflow: number;
  publishFailuresTruncated: boolean;
}): {
  publishFailures: Record<string, number>;
  publishFailuresOverflow: number;
  publishFailuresTruncated: boolean;
} {
  return {
    publishFailures: Object.fromEntries(state.publishFailures),
    publishFailuresOverflow: state.publishFailuresOverflow,
    publishFailuresTruncated: state.publishFailuresTruncated,
  };
}

/**
 * Snapshot of receiver-side SWM apply metrics (rc.9 PR-A). Returns the
 * empty / pristine snapshot if the SharedMemoryHandler has not yet been
 * initialised (no SWM share has ever been received locally). See the
 * `DKGAgent.getSwmHandlerStats` JSDoc for the field semantics.
 */
export function getSwmHandlerStats(handler: SharedMemoryHandler | undefined): {
  redundantApplies: Record<string, number>;
  redundantAppliesLowerBound: boolean;
  redundantAppliesOverflow: number;
  redundantAppliesTruncated: boolean;
} {
  if (!handler) {
    return {
      redundantApplies: {},
      redundantAppliesLowerBound: false,
      redundantAppliesOverflow: 0,
      redundantAppliesTruncated: false,
    };
  }
  return handler.getStats();
}

/**
 * Build a {@link PeerDiagnostics} snapshot for the given peer. Every
 * sub-lookup is wrapped in defensive error handling — if libp2p throws
 * mid-introspection (e.g. peerStore miss, internal shape mismatch),
 * the corresponding field degrades to `null`/`[]` rather than
 * propagating. See the interface JSDoc for the postmortem context
 * that motivated the `getConnectionsReturnsForPeer` field in
 * particular.
 */
export async function getPeerDiagnostics(
  deps: {
    node: DKGNode;
    messenger: Messenger;
    peerHealth: ReadonlyMap<string, PeerHealth>;
    lastSuccessfulSyncAt: ReadonlyMap<string, number>;
    syncReconcilerBackoff: ReadonlyMap<string, SyncReconcilerBackoff>;
  },
  peerId: string,
): Promise<PeerDiagnostics> {
  const libp2p = deps.node.libp2p;

  // libp2p's PeerId + Connection types live in `@libp2p/interface`,
  // but `packages/agent` only depends on `@libp2p/peer-id` directly
  // (Connection types come transitively through `@origintrail-official/dkg-core`).
  // Inferring shapes from the live `libp2p.getConnections()` return
  // avoids adding a new package dep just for two type annotations.
  type LibConnection = ReturnType<typeof libp2p.getConnections>[number];
  type LibPeerId = LibConnection['remotePeer'];

  let pid: LibPeerId | null = null;
  try {
    const { peerIdFromString } = await import('@libp2p/peer-id');
    pid = peerIdFromString(peerId) as unknown as LibPeerId;
  } catch {
    // Invalid peerId string — surface as a fully-empty snapshot so
    // the route still returns 200 with an obviously-broken shape
    // (connected=false, everything zero) rather than a route 500.
    return {
      peerId,
      connected: false,
      rawConnectionCount: 0,
      getConnectionsReturnsForPeer: 0,
      connections: [],
      peerStore: null,
      outbox: { pendingCount: 0, oldestFirstFailureAt: null, attempts: [], byProtocol: {} },
      health: null,
      protocols: [],
      syncCapable: false,
      syncStatus: {
        capable: false,
        capability: 'unknown',
        lastSuccessfulSyncAt: null,
        stale: false,
        backoff: null,
      },
    };
  }

  // Canonical base58btc form. The MCP tool accepts both base58btc
  // and base32 peerId encodings; libp2p's connection/peerStore
  // lookups normalise via `peerIdFromString`, but the substrate
  // outbox and `peerHealth` are keyed by the canonical string
  // from `peerId.toString()` (see `pingPeers` which populates
  // `peerHealth` via `peerId.toString()`). Looking them up with
  // the raw input string would silently miss for base32 callers,
  // returning `connected:true` alongside empty `outbox`/`health`
  // — a real diagnostic-noise bug (PR #538 Codex review).
  const peerKey = pid.toString();

  let rawConns: LibConnection[] = [];
  try {
    // Per-connection try/catch so a single tearing-down or shape-drift
    // connection that throws from `remotePeer.equals(pid)` doesn't
    // zero out the WHOLE snapshot (which would surface as a
    // misleading `connected:false` — the inverse of what the route
    // is meant to diagnose). Skip the bad entry, keep the rest.
    rawConns = libp2p.getConnections().filter((c: LibConnection) => {
      try {
        return c.remotePeer.equals(pid!);
      } catch {
        return false;
      }
    });
  } catch {
    rawConns = [];
  }

  // libp2p's peerId-keyed lookup. See `getConnectionsReturnsForPeer`
  // JSDoc — divergence from `rawConns.length` is the Window D signature.
  let keyedConns: LibConnection[] = [];
  try {
    keyedConns = libp2p.getConnections(pid);
  } catch {
    keyedConns = [];
  }

  let peerListHasPeer = false;
  try {
    peerListHasPeer = libp2p.getPeers().some((p: unknown) => (p as { toString?: () => string })?.toString?.() === peerKey);
  } catch {
    peerListHasPeer = false;
  }
  const connected = rawConns.length > 0 || keyedConns.length > 0 || peerListHasPeer;

  const connections: PeerConnectionSnapshot[] = rawConns.map((c) => {
    const remoteAddr = c.remoteAddr?.toString() ?? null;
    return {
      direction: c.direction,
      transport: remoteAddr?.includes('/p2p-circuit') ? 'relayed' : 'direct',
      remoteAddr,
      // libp2p marks limited circuit-relay connections via
      // `connection.limits` (presence ⇒ limited). Defensive cast
      // against future shape drift.
      limited: Boolean((c as unknown as { limits?: unknown }).limits),
      streams: c.streams?.length ?? 0,
      openedAt: c.timeline?.open ?? null,
    };
  });

  let peerStoreSnapshot: PeerDiagnostics['peerStore'] = null;
  try {
    const peer = await libp2p.peerStore.get(pid);
    const multiaddrs = (peer.addresses ?? []).map((a) => a.multiaddr.toString());
    // libp2p's identify (`/ipfs/id/1.0.0`) populates Peer.metadata
    // with utf8-encoded `AgentVersion` / `ProtocolVersion` after the
    // first successful exchange. Surface both so operators can answer
    // "which DKG release is this peer running?" from the wire —
    // without this, /api/peer-info shows protocol counts but no
    // release info at all. The libp2p wire name is `AgentVersion`;
    // we expose it as `nodeVersion` because "agent" collides with
    // `DKGAgent` in the DKG context (the rename only happens at this
    // read boundary — libp2p's PB field stays `AgentVersion`).
    // Defensive: `metadata` can be Map (libp2p >=2.x), plain object
    // on some serialised paths, or undefined before identify completes.
    const readMeta = (key: string): string | null => {
      const m: unknown = (peer as { metadata?: unknown }).metadata;
      let raw: unknown;
      if (m instanceof Map) raw = m.get(key);
      else if (m && typeof m === 'object') raw = (m as Record<string, unknown>)[key];
      if (raw == null) return null;
      try {
        if (raw instanceof Uint8Array) return new TextDecoder().decode(raw);
        if (typeof raw === 'string') return raw;
        return null;
      } catch {
        return null;
      }
    };
    peerStoreSnapshot = {
      knownMultiaddrCount: multiaddrs.length,
      multiaddrs,
      protocols: [...(peer.protocols ?? [])],
      nodeVersion: readMeta('AgentVersion'),
      protocolVersion: readMeta('ProtocolVersion'),
    };
  } catch {
    // peerStore.get throws on cold-cache miss; that IS the diagnostic
    // signal — degrade to null and let the caller see the absence.
    peerStoreSnapshot = null;
  }

  // Substrate outbox snapshot for this peer.
  //
  // The top-level fields (`pendingCount`, `oldestFirstFailureAt`,
  // `attempts`) summarise the CHAT protocol only — the rc.8
  // diagnostics shape that `/api/peer-info` + MCP `dkg_peer_info`
  // consumers expect. Preserved as-is so we don't break that
  // contract.
  //
  // The new `byProtocol` map (rc.9 PR-E codex follow-up #10)
  // surfaces queued entries for EVERY protocol the substrate
  // now carries, including sync (`/dkg/10.0.1/sync` migrated in
  // this PR). Without it, stuck sync catch-up — or any future
  // protocol-substrate migration — would be invisible in
  // operator diagnostics. Each per-protocol summary mirrors the
  // top-level summary's shape so tooling can render a per-
  // protocol view with zero extra plumbing.
  const peerEntries = deps.messenger
    .listOutboxMetadata()
    .filter((entry) => entry.peer === peerKey)
    .sort((a, b) => a.firstFailureAt - b.firstFailureAt);
  const chatPending = peerEntries.filter((entry) => entry.protocol === PROTOCOL_MESSAGE);
  const byProtocol: Record<string, { pendingCount: number; oldestFirstFailureAt: number | null; attempts: number[] }> = {};
  for (const entry of peerEntries) {
    const bucket = byProtocol[entry.protocol] ?? {
      pendingCount: 0,
      oldestFirstFailureAt: null,
      attempts: [],
    };
    bucket.pendingCount += 1;
    bucket.oldestFirstFailureAt =
      bucket.oldestFirstFailureAt === null
        ? entry.firstFailureAt
        : Math.min(bucket.oldestFirstFailureAt, entry.firstFailureAt);
    bucket.attempts.push(entry.attempts);
    byProtocol[entry.protocol] = bucket;
  }
  const outbox = {
    pendingCount: chatPending.length,
    oldestFirstFailureAt: chatPending.length > 0 ? chatPending[0].firstFailureAt : null,
    attempts: chatPending.map((e) => e.attempts),
    byProtocol,
  };

  const protocols = peerStoreSnapshot?.protocols ?? [];
  // Tracks the active `PROTOCOL_SYNC` constant (now `/dkg/10.0.2/sync`
  // after sync moved off the messenger substrate), so a node
  // advertising the current protocol is reported sync-capable. Hard
  // cutover — peers on the older `/sync` wire ID are no longer
  // compatible and intentionally report syncCapable=false.
  const syncCapable = protocols.includes(PROTOCOL_SYNC);
  const syncCapability: PeerDiagnostics['syncStatus']['capability'] = peerStoreSnapshot == null
    ? 'unknown'
    : syncCapable
      ? 'supported'
      : 'unsupported';
  const now = Date.now();
  const lastSuccessfulSync = deps.lastSuccessfulSyncAt.get(peerKey) ?? null;
  const backoff = deps.syncReconcilerBackoff.get(peerKey) ?? null;
  const syncHealthObservable = connected && (syncCapability === 'supported' || syncCapability === 'unknown');
  const syncStale = syncHealthObservable && (
    backoff != null ||
    lastSuccessfulSync == null ||
    (now - lastSuccessfulSync) >= SYNC_STALENESS_THRESHOLD_MS
  );
  const syncStatus = {
    capable: syncCapable,
    capability: syncCapability,
    lastSuccessfulSyncAt: lastSuccessfulSync,
    stale: syncStale,
    backoff: syncHealthObservable && backoff
      ? {
          failures: backoff.failures,
          nextRetryAt: backoff.nextRetryAt,
          retryInMs: Math.max(0, backoff.nextRetryAt - now),
        }
      : null,
  };

  return {
    peerId: peerKey,
    connected,
    rawConnectionCount: rawConns.length,
    getConnectionsReturnsForPeer: keyedConns.length,
    connections,
    peerStore: peerStoreSnapshot,
    outbox,
    health: deps.peerHealth.get(peerKey) ?? null,
    protocols,
    syncCapable,
    syncStatus,
  };
}

/**
 * Ping all known peers to check liveness. Updates the peerHealth map with
 * latency and last-seen timestamps. Returns the number of peers that responded.
 */
export async function pingPeers(
  deps: { node: DKGNode; peerHealth: Map<string, PeerHealth>; log: Logger },
): Promise<number> {
  const ctx = createOperationContext('system');
  const peers = deps.node.libp2p.getPeers();
  if (peers.length === 0) return 0;

  const PING_TIMEOUT_MS = 10_000;
  let alive = 0;
  const now = Date.now();

  const results = await Promise.allSettled(
    peers.map(async (peerId) => {
      const id = peerId.toString();
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), PING_TIMEOUT_MS);
      try {
        const latency = await deps.node.libp2p.services.ping.ping(peerId, { signal: ac.signal });
        clearTimeout(timer);
        deps.peerHealth.set(id, {
          peerId: id,
          alive: true,
          latencyMs: latency,
          lastSeen: now,
          lastChecked: now,
        });
        return true;
      } catch {
        clearTimeout(timer);
        const prev = deps.peerHealth.get(id);
        deps.peerHealth.set(id, {
          peerId: id,
          alive: false,
          latencyMs: null,
          lastSeen: prev?.lastSeen ?? null,
          lastChecked: now,
        });
        return false;
      }
    }),
  );

  for (const r of results) {
    if (r.status === 'fulfilled' && r.value) alive++;
  }

  deps.log.info(ctx, `Peer health ping: ${alive}/${peers.length} peers alive`);
  return alive;
}
