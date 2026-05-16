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
import { MessageOutbox } from '../src/message-outbox.js';

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
  outbox,
  health,
}: {
  rawConnections: StubConnection[];
  keyedConnectionsByPeer?: Map<string, StubConnection[]>;
  peerStoreEntries?: Map<
    string,
    { addresses: Array<{ multiaddr: { toString: () => string } }>; protocols?: string[] }
  >;
  outbox?: MessageOutbox;
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
    messageOutbox: outbox ?? new MessageOutbox(),
    peerHealth: health ?? new Map(),
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
              protocols: ['/dkg/10.0.0/sync', '/dkg/10.0.0/message'],
            },
          ],
        ]),
      });
      const diag = await callDiagnostics(agentLike, PEER_A);
      expect(diag.peerStore).toEqual({
        knownMultiaddrCount: 2,
        multiaddrs: ['/ip4/1.2.3.4/tcp/4001', `/ip4/5.6.7.8/tcp/4001/p2p/${PEER_A}`],
        protocols: ['/dkg/10.0.0/sync', '/dkg/10.0.0/message'],
      });
      expect(diag.protocols).toEqual(['/dkg/10.0.0/sync', '/dkg/10.0.0/message']);
      expect(diag.syncCapable).toBe(true);
    });
  });

  describe('outbox snapshot', () => {
    it('reports pending count + oldest first-failure ts + per-entry attempt counts', async () => {
      const outbox = new MessageOutbox();
      outbox.enqueueFailure(
        { recipientPeerId: PEER_A, text: 'first', messageId: 'm1' },
        'transport failed',
        1000,
      );
      // Bump the first entry to 2 attempts.
      outbox.enqueueFailure(
        { recipientPeerId: PEER_A, text: 'first', messageId: 'm1' },
        'transport failed again',
        2000,
      );
      outbox.enqueueFailure(
        { recipientPeerId: PEER_A, text: 'second', messageId: 'm2' },
        'transport failed',
        1500,
      );
      // Unrelated peer — must NOT appear in PEER_A's diagnostics.
      outbox.enqueueFailure(
        { recipientPeerId: PEER_B, text: 'other', messageId: 'm3' },
        'transport failed',
        1200,
      );
      const agentLike = makeAgentLike({ rawConnections: [], outbox });
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
  });
});
