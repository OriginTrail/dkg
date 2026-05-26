/**
 * Regression tests for `DKGAgent.getPeerDiagnostics`.
 *
 * The diagnostic surface was introduced after the May 2026 Miles↔Lex
 * 6h messaging soak postmortem, where an inbound circuit-relay
 * connection was open but outbound `dialProtocol` kept failing with
 * "no valid addresses for peer" for several minutes. The two paths
 * libp2p exposes — `getConnections()` walked + filtered, vs the
 * peerId-keyed `getConnections(peerId)` — can disagree under that
 * failure mode, and the `getConnectionsReturnsForPeer` field surfaces
 * the disagreement to operators (and to PR 5's repro test).
 *
 * These tests bind `DKGAgent.prototype.getPeerDiagnostics` to a
 * minimal stub (same pattern as `publish-relay-registry.test.ts`)
 * rather than standing up a full DkgAgent, so the assertions stay
 * focused on the diagnostic shape and don't drag in libp2p / chain /
 * storage initialisation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DKGAgent } from '../src/dkg-agent.js';
import { PROTOCOL_MESSAGE, type ProtocolOutboxEntry } from '@origintrail-official/dkg-core';

interface StubOutboxEntry {
  peer: string;
  protocol: string;
  messageId: string;
  attempts: number;
  firstFailureAt: number;
  lastAttemptAt: number;
  nextAttemptAt: number;
  lastError: string;
  payload: Uint8Array;
}

/**
 * Minimal substrate-outbox fixture for diagnostics tests. The
 * production `Messenger` uses a SQLite-backed `ProtocolOutboxStore`;
 * the diagnostics surface only reads `listOutbox()`, so a flat
 * array of entries is all we need to exercise the snapshot logic.
 *
 * rc.9 PR-3: replaces the chat-specific `MessageOutbox` fixture
 * that this test used to import — the chat outbox was deleted
 * when chat migrated onto `/dkg/10.0.1/message`.
 */
function makeOutboxStub(entries: StubOutboxEntry[]) {
  return {
    listOutbox: vi.fn((): ProtocolOutboxEntry[] => entries.map((e) => ({ ...e }))),
  };
}

const PEER_A = '12D3KooWFq5KMnSMyYr8Z8t8a6Vh1Y6N6KkF5UZjLpCqUkBJsAaa';
const PEER_B = '12D3KooWBqq7vfABCDEFkLmNoPqRsTuVwXyZAbCdEfGhIjKlMnaa';

interface StubConnection {
  remotePeer: { equals: (p: unknown) => boolean; toString: () => string };
  remoteAddr?: { toString: () => string };
  direction: 'inbound' | 'outbound';
  streams: unknown[];
  timeline: { open: number };
  limits?: unknown;
}

function makeStubConn(
  remotePeerId: string,
  overrides: Partial<StubConnection> = {},
): StubConnection {
  return {
    remotePeer: {
      equals: (p: any) => p?.toString?.() === remotePeerId,
      toString: () => remotePeerId,
    },
    remoteAddr: { toString: () => '/ip4/127.0.0.1/tcp/4001' },
    direction: 'inbound',
    streams: [],
    timeline: { open: 1715670000000 },
    ...overrides,
  };
}

function makeAgentLike({
  rawConnections,
  keyedConnectionsByPeer,
  peerStoreEntries,
  outboxEntries,
  health,
}: {
  rawConnections: StubConnection[];
  keyedConnectionsByPeer?: Map<string, StubConnection[]>;
  peerStoreEntries?: Map<
    string,
    {
      addresses: Array<{ multiaddr: { toString: () => string } }>;
      protocols?: string[];
      // rc.11: libp2p's identify protocol populates Peer.metadata
      // with utf8-encoded AgentVersion / ProtocolVersion entries
      // after the first successful exchange. The diagnostics surface
      // reads these to answer "which DKG release is this peer
      // running?" — see `peerStore: { nodeVersion, protocolVersion }`
      // on PeerDiagnostics (libp2p's `AgentVersion` is renamed to
      // `nodeVersion` to avoid colliding with `DKGAgent`). Map<string,
      // Uint8Array> matches the libp2p >=2.x shape; a plain object
      // (other code path) is also handled by the production reader.
      metadata?: Map<string, Uint8Array> | Record<string, Uint8Array>;
    }
  >;
  outboxEntries?: StubOutboxEntry[];
  health?: Map<string, any>;
}): any {
  return {
    node: {
      libp2p: {
        getConnections: vi.fn((arg?: unknown) => {
          if (arg == null) return rawConnections;
          const key = (arg as { toString: () => string }).toString();
          return keyedConnectionsByPeer?.get(key) ?? [];
        }),
        peerStore: {
          get: vi.fn(async (pid: any) => {
            const key = pid.toString();
            const entry = peerStoreEntries?.get(key);
            if (!entry) throw new Error('NotFound');
            return entry;
          }),
        },
      },
    },
    messenger: makeOutboxStub(outboxEntries ?? []),
    peerHealth: health ?? new Map(),
  };
}

function makeOutboxEntry(overrides: Partial<StubOutboxEntry>): StubOutboxEntry {
  return {
    peer: PEER_A,
    protocol: PROTOCOL_MESSAGE,
    messageId: 'm1',
    attempts: 1,
    firstFailureAt: 1000,
    lastAttemptAt: 1000,
    nextAttemptAt: 6000,
    lastError: 'transport failed',
    payload: new Uint8Array(0),
    ...overrides,
  };
}

async function callDiagnostics(agentLike: any, peerId: string): Promise<any> {
  return (DKGAgent.prototype as any).getPeerDiagnostics.call(agentLike, peerId);
}

describe('DKGAgent.getPeerDiagnostics', () => {
  describe('connection counts', () => {
    it('returns rawConnectionCount = number of open conns whose remotePeer matches', async () => {
      const conns = [
        makeStubConn(PEER_A, { direction: 'inbound' }),
        makeStubConn(PEER_A, { direction: 'outbound' }),
        makeStubConn(PEER_B, { direction: 'inbound' }),
      ];
      const agentLike = makeAgentLike({
        rawConnections: conns,
        keyedConnectionsByPeer: new Map([
          [PEER_A, [conns[0], conns[1]]],
          [PEER_B, [conns[2]]],
        ]),
      });
      const diag = await callDiagnostics(agentLike, PEER_A);
      expect(diag.rawConnectionCount).toBe(2);
      expect(diag.getConnectionsReturnsForPeer).toBe(2);
      expect(diag.connected).toBe(true);
    });

    // The Window D bug: libp2p's peerId-keyed lookup says 0, but a raw
    // walk over getConnections() shows 1 connection that matches the
    // peerId. This is the smoking-gun divergence that PR 5's repro
    // test will assert against, so the diagnostic must distinguish
    // the two counts even when they disagree.
    it('reports getConnectionsReturnsForPeer DISTINCTLY from rawConnectionCount when libp2p filters', async () => {
      const conn = makeStubConn(PEER_A, { direction: 'inbound', limits: { bytes: 1024 * 1024 } });
      const agentLike = makeAgentLike({
        rawConnections: [conn],
        keyedConnectionsByPeer: new Map([[PEER_A, []]]),
      });
      const diag = await callDiagnostics(agentLike, PEER_A);
      expect(diag.rawConnectionCount).toBe(1);
      expect(diag.getConnectionsReturnsForPeer).toBe(0);
      expect(diag.connected).toBe(true);
      expect(diag.connections[0].limited).toBe(true);
    });

    it('returns connected=false and both counts=0 when nothing matches', async () => {
      const agentLike = makeAgentLike({
        rawConnections: [makeStubConn(PEER_B)],
        keyedConnectionsByPeer: new Map([[PEER_A, []]]),
      });
      const diag = await callDiagnostics(agentLike, PEER_A);
      expect(diag.connected).toBe(false);
      expect(diag.rawConnectionCount).toBe(0);
      expect(diag.getConnectionsReturnsForPeer).toBe(0);
      expect(diag.connections).toEqual([]);
    });
  });

  describe('connection snapshot fields', () => {
    it('classifies /p2p-circuit addresses as relayed transport', async () => {
      const direct = makeStubConn(PEER_A, {
        remoteAddr: { toString: () => '/ip4/1.2.3.4/tcp/4001' },
      });
      const relayed = makeStubConn(PEER_A, {
        remoteAddr: {
          toString: () => `/ip4/9.9.9.9/tcp/4001/p2p/${PEER_B}/p2p-circuit/p2p/${PEER_A}`,
        },
      });
      const agentLike = makeAgentLike({
        rawConnections: [direct, relayed],
        keyedConnectionsByPeer: new Map([[PEER_A, [direct, relayed]]]),
      });
      const diag = await callDiagnostics(agentLike, PEER_A);
      expect(diag.connections[0].transport).toBe('direct');
      expect(diag.connections[1].transport).toBe('relayed');
    });

    it('reports limited=false when libp2p does not set connection.limits', async () => {
      const conn = makeStubConn(PEER_A);
      const agentLike = makeAgentLike({
        rawConnections: [conn],
        keyedConnectionsByPeer: new Map([[PEER_A, [conn]]]),
      });
      const diag = await callDiagnostics(agentLike, PEER_A);
      expect(diag.connections[0].limited).toBe(false);
    });

    // Codex review of PR #533 flagged that the original
    // `remoteAddr: c.remoteAddr?.toString() ?? ''` silently changed the
    // `/api/peer-info` contract: pre-PR callers got `null` when
    // libp2p had no remote multiaddr to report, post-PR they got `''`
    // and could no longer distinguish "address unavailable" from an
    // actual empty multiaddr. Lock the `null` preservation in.
    it('preserves remoteAddr=null when libp2p does not expose a multiaddr', async () => {
      const conn = makeStubConn(PEER_A, { remoteAddr: undefined });
      const agentLike = makeAgentLike({
        rawConnections: [conn],
        keyedConnectionsByPeer: new Map([[PEER_A, [conn]]]),
      });
      const diag = await callDiagnostics(agentLike, PEER_A);
      expect(diag.connections[0].remoteAddr).toBeNull();
      // A missing addr can't be circuit-relay → falls back to `direct`.
      // (We don't dereference `null.includes('/p2p-circuit')`, which
      // was the second class of bug the JSDoc-level type change
      // would have triggered if we didn't guard the transport check.)
      expect(diag.connections[0].transport).toBe('direct');
    });
  });

  describe('peerStore introspection', () => {
    it('returns peerStore=null when libp2p has no entry (cold cache)', async () => {
      const agentLike = makeAgentLike({
        rawConnections: [],
        peerStoreEntries: new Map(),
      });
      const diag = await callDiagnostics(agentLike, PEER_A);
      expect(diag.peerStore).toBeNull();
    });

    it('extracts multiaddrs + protocols from a populated peerStore entry', async () => {
      // rc.9 PR-E: `syncCapable` now tracks the current PROTOCOL_SYNC
      // wire ID (`/dkg/10.0.1/sync`), not the legacy `/dkg/10.0.0/sync`.
      // A peer advertising the bumped protocol is reported sync-capable.
      const agentLike = makeAgentLike({
        rawConnections: [],
        peerStoreEntries: new Map([
          [
            PEER_A,
            {
              addresses: [
                { multiaddr: { toString: () => '/ip4/1.2.3.4/tcp/4001' } },
                { multiaddr: { toString: () => `/ip4/5.6.7.8/tcp/4001/p2p/${PEER_A}` } },
              ],
              protocols: ['/dkg/10.0.1/sync', '/dkg/10.0.1/message'],
            },
          ],
        ]),
      });
      const diag = await callDiagnostics(agentLike, PEER_A);
      expect(diag.peerStore).toEqual({
        knownMultiaddrCount: 2,
        multiaddrs: ['/ip4/1.2.3.4/tcp/4001', `/ip4/5.6.7.8/tcp/4001/p2p/${PEER_A}`],
        protocols: ['/dkg/10.0.1/sync', '/dkg/10.0.1/message'],
        // No `metadata` provided in the stub → identify hasn't run
        // → both version fields null (rc.11 follow-up).
        nodeVersion: null,
        protocolVersion: null,
      });
      expect(diag.protocols).toEqual(['/dkg/10.0.1/sync', '/dkg/10.0.1/message']);
      expect(diag.syncCapable).toBe(true);
    });

    // rc.11 follow-up to the "version on the wire" gap surfaced during
    // the v10.0.0-rc.10 network rollout: before this PR, /api/peer-info
    // could tell operators *which* protocols a peer spoke, but not
    // *which DKG release* they were running — leaving "did the network
    // pick up the upgrade?" answerable only by guessing from on-chain
    // contract registrations. The fix wires
    // `DKGNodeConfig.nodeVersion` → libp2p `nodeInfo.userAgent`, so
    // remote peers see `dkg/<semver>` in their peerStore as
    // `Peer.metadata.AgentVersion` (libp2p's wire name). The reader
    // decodes that back to a UTF-8 string surfaced as `nodeVersion` on
    // the diagnostics object — kept distinct from libp2p's name to
    // avoid colliding with `DKGAgent`.
    it('surfaces nodeVersion (libp2p AgentVersion) + protocolVersion from peer.metadata (Map shape, libp2p >=2.x)', async () => {
      const enc = new TextEncoder();
      const agentLike = makeAgentLike({
        rawConnections: [],
        peerStoreEntries: new Map([
          [
            PEER_A,
            {
              addresses: [{ multiaddr: { toString: () => '/ip4/1.2.3.4/tcp/4001' } }],
              protocols: ['/dkg/10.0.1/message'],
              metadata: new Map<string, Uint8Array>([
                ['AgentVersion', enc.encode('dkg/10.0.0-rc.11')],
                ['ProtocolVersion', enc.encode('ipfs/0.1.0')],
              ]),
            },
          ],
        ]),
      });
      const diag = await callDiagnostics(agentLike, PEER_A);
      expect(diag.peerStore?.nodeVersion).toBe('dkg/10.0.0-rc.11');
      expect(diag.peerStore?.protocolVersion).toBe('ipfs/0.1.0');
    });

    // Defensive path: some libp2p serialisation surfaces (and certain
    // peerStore re-hydration code paths) return `metadata` as a plain
    // object instead of a Map. The production reader handles both —
    // this test locks that in so a future "always-Map" assumption
    // doesn't silently degrade the version surface to null.
    it('also reads AgentVersion when peer.metadata is a plain object (defensive shape)', async () => {
      const enc = new TextEncoder();
      const agentLike = makeAgentLike({
        rawConnections: [],
        peerStoreEntries: new Map([
          [
            PEER_A,
            {
              addresses: [],
              protocols: [],
              metadata: {
                AgentVersion: enc.encode('dkg/10.0.0-rc.12'),
              },
            },
          ],
        ]),
      });
      const diag = await callDiagnostics(agentLike, PEER_A);
      expect(diag.peerStore?.nodeVersion).toBe('dkg/10.0.0-rc.12');
      expect(diag.peerStore?.protocolVersion).toBeNull();
    });

    // Regression for the rc.9 PR-E hard cutover: a peer that still
    // only advertises the legacy `/dkg/10.0.0/sync` protocol is now
    // *intentionally* reported as `syncCapable: false`. Without this
    // assertion, a future regression that relaxed the check to "any
    // sync version" would slip through silently.
    it('reports syncCapable=false for a legacy peer that only advertises /dkg/10.0.0/sync', async () => {
      const agentLike = makeAgentLike({
        rawConnections: [],
        peerStoreEntries: new Map([
          [
            PEER_A,
            {
              addresses: [],
              protocols: ['/dkg/10.0.0/sync', '/dkg/10.0.0/message'],
            },
          ],
        ]),
      });
      const diag = await callDiagnostics(agentLike, PEER_A);
      expect(diag.protocols).toEqual(['/dkg/10.0.0/sync', '/dkg/10.0.0/message']);
      expect(diag.syncCapable).toBe(false);
    });
  });

  describe('outbox snapshot (substrate-backed, rc.9 PR-3)', () => {
    it('reports pending count + oldest first-failure ts + per-entry attempt counts for the chat protocol only', async () => {
      const outboxEntries: StubOutboxEntry[] = [
        // PEER_A, chat, attempts=2, oldest.
        makeOutboxEntry({ peer: PEER_A, messageId: 'm1', attempts: 2, firstFailureAt: 1000 }),
        // PEER_A, chat, attempts=1.
        makeOutboxEntry({ peer: PEER_A, messageId: 'm2', attempts: 1, firstFailureAt: 1500 }),
        // PEER_B, chat — must NOT appear in PEER_A's diagnostics.
        makeOutboxEntry({ peer: PEER_B, messageId: 'm3', attempts: 1, firstFailureAt: 1200 }),
        // PEER_A, but a non-chat protocol — the diagnostics surface
        // is chat-specific at the TOP level by design, so this must
        // be filtered out of `outbox.pendingCount`. (It still appears
        // under `outbox.byProtocol`; see the per-protocol breakdown
        // test below for that contract.)
        makeOutboxEntry({
          peer: PEER_A,
          protocol: '/dkg/10.0.1/swm-sender-key',
          messageId: 'm4',
          attempts: 5,
          firstFailureAt: 500,
        }),
      ];
      const agentLike = makeAgentLike({ rawConnections: [], outboxEntries });
      const diag = await callDiagnostics(agentLike, PEER_A);
      expect(diag.outbox.pendingCount).toBe(2);
      expect(diag.outbox.oldestFirstFailureAt).toBe(1000);
      expect(diag.outbox.attempts).toEqual([2, 1]);
    });

    it('reports zeros when no entries are pending', async () => {
      const agentLike = makeAgentLike({ rawConnections: [] });
      const diag = await callDiagnostics(agentLike, PEER_A);
      expect(diag.outbox).toEqual({
        pendingCount: 0,
        oldestFirstFailureAt: null,
        attempts: [],
        byProtocol: {},
      });
    });

    /**
     * rc.9 PR-E codex follow-up #10.
     *
     * Sync migrated onto `messenger.sendReliable` in this PR, which
     * means recoverable sync failures now queue in the same
     * substrate outbox as chat. Before this fix, the diagnostics
     * surface only summarised chat-protocol queued entries — stuck
     * sync catch-up was invisible to operators. The new
     * `outbox.byProtocol` map breaks out queued entries per protocol
     * so any future protocol-substrate migration shows up
     * automatically with zero diagnostics-route changes.
     */
    it('surfaces per-protocol pending entries via outbox.byProtocol (sync, swm, chat, anything)', async () => {
      const outboxEntries: StubOutboxEntry[] = [
        // 2x chat (newer + older)
        makeOutboxEntry({ peer: PEER_A, messageId: 'chat-1', attempts: 1, firstFailureAt: 2000 }),
        makeOutboxEntry({ peer: PEER_A, messageId: 'chat-2', attempts: 2, firstFailureAt: 1000 }),
        // 1x sync (the migration this PR ships)
        makeOutboxEntry({
          peer: PEER_A,
          protocol: '/dkg/10.0.1/sync',
          messageId: 'sync-1',
          attempts: 3,
          firstFailureAt: 1500,
        }),
        // 1x SWM sender-key (representing future protocol migrations)
        makeOutboxEntry({
          peer: PEER_A,
          protocol: '/dkg/10.0.1/swm-sender-key',
          messageId: 'swm-1',
          attempts: 5,
          firstFailureAt: 500,
        }),
        // PEER_B entry — must NOT appear in PEER_A's per-protocol view.
        makeOutboxEntry({
          peer: PEER_B,
          protocol: '/dkg/10.0.1/sync',
          messageId: 'sync-other-peer',
          attempts: 7,
          firstFailureAt: 100,
        }),
      ];
      const agentLike = makeAgentLike({ rawConnections: [], outboxEntries });
      const diag = await callDiagnostics(agentLike, PEER_A);

      // The chat-specific top-level summary is unchanged from rc.8.
      expect(diag.outbox.pendingCount).toBe(2);
      expect(diag.outbox.oldestFirstFailureAt).toBe(1000);
      expect(diag.outbox.attempts).toEqual([2, 1]);

      // Per-protocol breakdown surfaces sync + SWM alongside chat.
      expect(Object.keys(diag.outbox.byProtocol).sort()).toEqual([
        '/dkg/10.0.1/message',
        '/dkg/10.0.1/swm-sender-key',
        '/dkg/10.0.1/sync',
      ]);
      expect(diag.outbox.byProtocol['/dkg/10.0.1/sync']).toEqual({
        pendingCount: 1,
        oldestFirstFailureAt: 1500,
        attempts: [3],
      });
      expect(diag.outbox.byProtocol['/dkg/10.0.1/swm-sender-key']).toEqual({
        pendingCount: 1,
        oldestFirstFailureAt: 500,
        attempts: [5],
      });
      expect(diag.outbox.byProtocol['/dkg/10.0.1/message']).toEqual({
        pendingCount: 2,
        oldestFirstFailureAt: 1000,
        attempts: [2, 1],
      });
      // PEER_B sync entry MUST NOT bleed into PEER_A's per-protocol view.
      expect(diag.outbox.byProtocol['/dkg/10.0.1/sync'].attempts).not.toContain(7);
    });

    /**
     * Regression for the exact bug Codex described: "sync catch-up
     * gets stuck and is invisible in the diagnostics surface". A peer
     * with ONLY sync queued (no chat) used to report
     * `outbox.pendingCount=0` and looked healthy. Now sync is visible
     * in `byProtocol` so operators can tell the difference.
     */
    it('makes a sync-only stuck peer visible in diagnostics (was invisible pre-rc.9 PR-E)', async () => {
      const outboxEntries: StubOutboxEntry[] = [
        makeOutboxEntry({
          peer: PEER_A,
          protocol: '/dkg/10.0.1/sync',
          messageId: 'sync-stuck',
          attempts: 4,
          firstFailureAt: 7000,
        }),
      ];
      const agentLike = makeAgentLike({ rawConnections: [], outboxEntries });
      const diag = await callDiagnostics(agentLike, PEER_A);

      // Top-level chat-specific summary still reports zero — that's
      // intentional (preserves rc.8 contract).
      expect(diag.outbox.pendingCount).toBe(0);
      expect(diag.outbox.oldestFirstFailureAt).toBeNull();

      // But the per-protocol view tells operators that sync IS stuck.
      expect(diag.outbox.byProtocol).toEqual({
        '/dkg/10.0.1/sync': {
          pendingCount: 1,
          oldestFirstFailureAt: 7000,
          attempts: [4],
        },
      });
    });
  });

  describe('defensive error handling', () => {
    it('degrades to an empty snapshot on invalid peerId rather than throwing', async () => {
      const agentLike = makeAgentLike({ rawConnections: [] });
      const diag = await callDiagnostics(agentLike, 'not-a-real-peer-id');
      expect(diag).toMatchObject({
        peerId: 'not-a-real-peer-id',
        connected: false,
        rawConnectionCount: 0,
        getConnectionsReturnsForPeer: 0,
        connections: [],
        peerStore: null,
        protocols: [],
        syncCapable: false,
      });
    });

    it('returns rawConnectionCount=0 when getConnections() throws', async () => {
      const agentLike = makeAgentLike({ rawConnections: [] });
      agentLike.node.libp2p.getConnections = vi.fn(() => {
        throw new Error('libp2p internal blew up');
      });
      const diag = await callDiagnostics(agentLike, PEER_A);
      expect(diag.rawConnectionCount).toBe(0);
      expect(diag.getConnectionsReturnsForPeer).toBe(0);
    });

    it('returns peerStore=null when peerStore.get throws', async () => {
      const agentLike = makeAgentLike({ rawConnections: [] });
      agentLike.node.libp2p.peerStore.get = vi.fn(async () => {
        throw new Error('NotFound');
      });
      const diag = await callDiagnostics(agentLike, PEER_A);
      expect(diag.peerStore).toBeNull();
    });

    // 🔴 Codex review on PR #538: the raw-walk filter previously
    // wrapped the entire `getConnections().filter(...)` in one
    // try/catch, so a single tearing-down connection whose
    // `remotePeer.equals(pid)` throws would zero out rawConnections
    // and flip `connected:false` for the whole snapshot — exact
    // inverse of the diagnostic intent. The fix: per-connection
    // try/catch that skips the bad entry and keeps the rest.
    it('skips a single connection that throws from remotePeer.equals without zeroing the snapshot', async () => {
      const goodConn = makeStubConn(PEER_A, { direction: 'inbound' });
      const tearingDownConn: StubConnection = {
        remotePeer: {
          equals: () => { throw new Error('connection in teardown'); },
          toString: () => '<tearing-down>',
        },
        remoteAddr: { toString: () => '/ip4/127.0.0.1/tcp/4002' },
        direction: 'outbound',
        streams: [],
        timeline: { open: 1715670001000 },
      };
      const agentLike = makeAgentLike({
        rawConnections: [tearingDownConn, goodConn],
        keyedConnectionsByPeer: new Map([[PEER_A, [goodConn]]]),
      });
      const diag = await callDiagnostics(agentLike, PEER_A);
      // The bad connection was skipped (caught), the good one survived.
      expect(diag.rawConnectionCount).toBe(1);
      expect(diag.connected).toBe(true);
    });
  });

  // 🔴 Codex review on PR #538 (preserved through rc.9 PR-3
  // substrate cutover): the MCP `dkg_peer_info` tool accepts
  // both base58btc and base32 peerId encodings. libp2p's
  // connection + peerStore lookups normalise via
  // `peerIdFromString`, but the substrate outbox + `peerHealth`
  // are keyed by the canonical `peerId.toString()` form. Without
  // normalising once up front, a base32 caller would see
  // `connected:true` alongside empty `outbox`/`health` — silent
  // diagnostic noise.
  describe('peerId normalization (PR #538 review)', () => {
    it('uses canonical peerId.toString() for outbox and health lookups, and returns it in the result', async () => {
      const outboxEntries: StubOutboxEntry[] = [
        makeOutboxEntry({ peer: PEER_A, messageId: 'm1', firstFailureAt: 1715670000000 }),
      ];
      const health = new Map([
        [PEER_A, { peerId: PEER_A, alive: true, latencyMs: 42, lastSeen: 1715670000000, lastChecked: 1715670000000 }],
      ]);
      const agentLike = makeAgentLike({
        rawConnections: [makeStubConn(PEER_A)],
        keyedConnectionsByPeer: new Map([[PEER_A, [makeStubConn(PEER_A)]]]),
        outboxEntries,
        health,
      });

      const diag = await callDiagnostics(agentLike, PEER_A);
      expect(diag.peerId).toBe(PEER_A);
      expect(diag.outbox.pendingCount).toBe(1);
      expect(diag.health).not.toBeNull();
      expect(diag.health.latencyMs).toBe(42);
    });
  });
});
