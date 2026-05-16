import { describe, it, expect } from 'vitest';
import { isRecoverableSendError, DEFAULT_SEND_TIMEOUT_MS, ProtocolRouter } from '../src/protocol-router.js';
import type { DKGNode } from '../src/node.js';
import type { PeerResolver } from '../src/network/peer-resolver.js';

describe('ProtocolRouter', () => {
  describe('isRecoverableSendError', () => {
    it('returns true for protocol selection / negotiation errors (relay sync)', () => {
      expect(isRecoverableSendError(new Error('Protocol selection failed - could not negotiate /dkg/sync/1.0.0'))).toBe(true);
      expect(isRecoverableSendError(new Error('could not negotiate /dkg/sync/1.0.0'))).toBe(true);
    });

    it('returns true for connection/stream errors', () => {
      expect(isRecoverableSendError(new Error('stream returned in closed state'))).toBe(true);
      expect(isRecoverableSendError(new Error('ECONNRESET'))).toBe(true);
      expect(isRecoverableSendError(new Error('ETIMEDOUT'))).toBe(true);
      expect(isRecoverableSendError(new Error('ECONNREFUSED'))).toBe(true);
      expect(isRecoverableSendError(new Error('EPIPE'))).toBe(true);
      expect(isRecoverableSendError(new Error('The operation was aborted'))).toBe(true);
      expect(isRecoverableSendError(new Error('no valid addresses'))).toBe(true);
    });

    it('returns false for non-recoverable errors', () => {
      expect(isRecoverableSendError(new Error('Read limit exceeded'))).toBe(false);
      expect(isRecoverableSendError(new Error('handler error'))).toBe(false);
      expect(isRecoverableSendError(new Error('Invalid payload'))).toBe(false);
    });

    it('handles non-Error values', () => {
      expect(isRecoverableSendError('protocol selection failed')).toBe(true);
      expect(isRecoverableSendError(null)).toBe(false);
    });
  });

  describe('DEFAULT_SEND_TIMEOUT_MS', () => {
    it('is 20 seconds for relay/sync tolerance', () => {
      expect(DEFAULT_SEND_TIMEOUT_MS).toBe(20_000);
    });
  });

  // Per-attempt resolver re-run was added in the MessageOutbox PR after
  // the two-laptop debug session that produced PR #517. Original shape
  // (PR #497) called `peerResolver.resolve()` once before the dial loop;
  // a transient routing-table miss on that single call left all 3
  // dialProtocol attempts hitting an empty peerStore in the next ~1.5s,
  // producing a hard `'no valid addresses for peer'` failure that the
  // recoverable-error retry budget couldn't actually recover from.
  describe('send() resolver re-priming', () => {
    // Minimal valid Ed25519 peerId from the libp2p test fixtures.
    // `peerIdFromString` validates this is a parseable peerId; the
    // value never reaches the wire because dialProtocol is stubbed.
    const FAKE_PEER_ID = '12D3KooWBzj7Hg2cKCdsKL6QcjC5UbLztKTvzCZQHaT4P4ZyJEAA';

    function makeStubStream(response: Uint8Array) {
      const closed = false;
      let returned = false;
      return {
        writeStatus: 'open' as const,
        send: () => undefined,
        close: async () => undefined,
        abort: () => undefined,
        async *[Symbol.asyncIterator]() {
          if (!returned) {
            returned = true;
            yield response;
          }
        },
      };
    }

    function makeRouter(opts: {
      dialBehavior: () => Promise<unknown>;
      onResolve: () => void;
    }): ProtocolRouter {
      const node = {
        libp2p: {
          dialProtocol: opts.dialBehavior,
          handle: () => undefined,
          unhandle: () => undefined,
        },
      } as unknown as DKGNode;
      const peerResolver = {
        resolve: async () => {
          opts.onResolve();
          return [];
        },
      } as unknown as PeerResolver;
      return new ProtocolRouter(node, { peerResolver });
    }

    it('re-runs peerResolver.resolve() on every retry attempt (was once-pre-loop)', async () => {
      let resolveCalls = 0;
      let dialCalls = 0;
      const router = makeRouter({
        onResolve: () => { resolveCalls += 1; },
        dialBehavior: async () => {
          dialCalls += 1;
          throw new Error('The dial request has no valid addresses for peer');
        },
      });

      await expect(
        router.send(FAKE_PEER_ID, '/dkg/test/1.0.0', new Uint8Array([1, 2, 3])),
      ).rejects.toThrow(/no valid addresses/);

      // Primary regression assertion: 3 dial attempts → 3 resolver
      // calls. Pre-fix this would have been 1 resolver call + 3 dial
      // attempts, all hitting the same empty peerStore.
      expect(dialCalls).toBe(3);
      expect(resolveCalls).toBe(3);
    });

    it('stops retrying once a resolver-re-prime followed by dial succeeds', async () => {
      let resolveCalls = 0;
      let dialCalls = 0;
      const router = makeRouter({
        onResolve: () => { resolveCalls += 1; },
        dialBehavior: async () => {
          dialCalls += 1;
          if (dialCalls < 3) {
            throw new Error('no valid addresses for peer');
          }
          return makeStubStream(new Uint8Array([0xAA, 0xBB])) as any;
        },
      });

      const result = await router.send(
        FAKE_PEER_ID,
        '/dkg/test/1.0.0',
        new Uint8Array([1]),
      );

      expect(dialCalls).toBe(3);
      // Resolver re-primes before each of the 3 dial attempts —
      // including the third one that succeeds.
      expect(resolveCalls).toBe(3);
      expect(result).toEqual(new Uint8Array([0xAA, 0xBB]));
    });

    it('stops at attempt 1 for non-recoverable errors and only re-primes once', async () => {
      let resolveCalls = 0;
      let dialCalls = 0;
      const router = makeRouter({
        onResolve: () => { resolveCalls += 1; },
        dialBehavior: async () => {
          dialCalls += 1;
          throw new Error('Read limit exceeded');
        },
      });

      await expect(
        router.send(FAKE_PEER_ID, '/dkg/test/1.0.0', new Uint8Array([1])),
      ).rejects.toThrow(/Read limit exceeded/);

      // Non-recoverable errors should NOT trigger the retry loop's
      // backoff + re-prime path. Dial fires once, resolver primes once.
      expect(dialCalls).toBe(1);
      expect(resolveCalls).toBe(1);
    });
  });

  // PR 5 — "Window D" fast path. Before dialProtocol, send() checks
  // `libp2p.getConnections(peerId)` for an existing open connection
  // and opens the stream on it directly via `connection.newStream`,
  // skipping the address-resolution + dialProtocol path entirely.
  // The May 2026 Miles↔Lex 6h soak postmortem traced multi-minute
  // outbound failures to the case where an inbound circuit was open
  // but peerStore was empty for the peer; dialProtocol returned
  // "no valid addresses for peer" each time. This fast path
  // succeeds in that scenario without ever touching peerStore.
  describe('send() existing-connection fast path (PR 5 — Window D)', () => {
    const FAKE_PEER_ID = '12D3KooWBzj7Hg2cKCdsKL6QcjC5UbLztKTvzCZQHaT4P4ZyJEAA';

    function makeStubStream(response: Uint8Array) {
      let returned = false;
      return {
        writeStatus: 'open' as const,
        send: () => undefined,
        close: async () => undefined,
        abort: () => undefined,
        async *[Symbol.asyncIterator]() {
          if (!returned) {
            returned = true;
            yield response;
          }
        },
      };
    }

    function makeRouterWithFastPath(opts: {
      connections: Array<{
        status?: string;
        // Limited (circuit-relay-v2) marker — the fast path checks
        // for it to gate the peerStore-direct-addrs probe (PR #537
        // CI fix; see protocol-router.ts JSDoc).
        limits?: unknown;
        // `remotePeer` is what the fast path's raw `getConnections()`
        // walk filters on (the per-user-review fix to PR #537:
        // peerId-keyed lookup would silently miss the Window D
        // shape because libp2p's keyed lookup can return [] even
        // when raw walk shows live connections that match the
        // peerId). Default below stamps FAKE_PEER_ID so connections
        // pass the filter; tests that want a non-matching
        // `remotePeer` can override.
        remotePeer?: { equals: (other: unknown) => boolean; toString: () => string };
        newStream: (
          protocols: string,
          options?: { runOnLimitedConnection?: boolean; signal?: AbortSignal },
        ) => Promise<ReturnType<typeof makeStubStream>>;
      }>;
      dialBehavior: () => Promise<unknown>;
      onResolve?: () => void;
      onGetConnections?: () => void;
      // Default: peerStore.get throws (Window D cold-cache shape).
      // Tests that exercise the DCUtR-upgrade skip-limited path
      // override with a populated peer that includes a non-circuit
      // address (or include `/p2p-circuit` only to assert we still
      // fast-path through limited when peerStore has ONLY relay
      // addresses).
      peerStoreGet?: (pid: unknown) => Promise<{ addresses: Array<{ multiaddr: { toString: () => string } }> }>;
    }): ProtocolRouter {
      const peerStoreGet =
        opts.peerStoreGet ??
        (async () => {
          throw new Error('NotFound');
        });
      const stampedConnections = opts.connections.map((c) => ({
        ...c,
        remotePeer:
          c.remotePeer ?? {
            equals: (other: unknown) => String(other) === FAKE_PEER_ID,
            toString: () => FAKE_PEER_ID,
          },
      }));
      const node = {
        libp2p: {
          getConnections: () => {
            opts.onGetConnections?.();
            return stampedConnections;
          },
          dialProtocol: opts.dialBehavior,
          handle: () => undefined,
          unhandle: () => undefined,
          peerStore: { get: peerStoreGet },
        },
      } as unknown as DKGNode;
      const peerResolver = {
        resolve: async () => {
          opts.onResolve?.();
          return [];
        },
      } as unknown as PeerResolver;
      return new ProtocolRouter(node, { peerResolver });
    }

    it('reuses an existing open connection and skips dialProtocol + resolver entirely', async () => {
      let newStreamCalls = 0;
      let dialCalls = 0;
      let resolveCalls = 0;
      const router = makeRouterWithFastPath({
        connections: [
          {
            status: 'open',
            newStream: async (protocols, options) => {
              newStreamCalls += 1;
              // Must opt-in to limited connections so circuit-relay
              // (limited) connections are usable as stream-carriers.
              // Same flag the dialProtocol call uses below; the fast
              // path MUST mirror it or it would silently downgrade
              // relayed reachability vs the old path.
              expect(options?.runOnLimitedConnection).toBe(true);
              expect(protocols).toBe('/dkg/test/1.0.0');
              return makeStubStream(new Uint8Array([0xAA])) as any;
            },
          },
        ],
        dialBehavior: async () => {
          dialCalls += 1;
          throw new Error('dialProtocol must not be called when fast path hits');
        },
        onResolve: () => { resolveCalls += 1; },
      });

      const out = await router.send(FAKE_PEER_ID, '/dkg/test/1.0.0', new Uint8Array([1]));
      expect(out).toEqual(new Uint8Array([0xAA]));
      expect(newStreamCalls).toBe(1);
      expect(dialCalls).toBe(0);
      // Resolver is bypassed on warm path — its only job (priming
      // peerStore for the dialer) is unnecessary when we don't dial.
      expect(resolveCalls).toBe(0);
    });

    it('falls through to dialProtocol when no connections exist (cold peer)', async () => {
      let dialCalls = 0;
      let resolveCalls = 0;
      const router = makeRouterWithFastPath({
        connections: [],
        dialBehavior: async () => {
          dialCalls += 1;
          return makeStubStream(new Uint8Array([0xBB])) as any;
        },
        onResolve: () => { resolveCalls += 1; },
      });

      const out = await router.send(FAKE_PEER_ID, '/dkg/test/1.0.0', new Uint8Array([1]));
      expect(out).toEqual(new Uint8Array([0xBB]));
      expect(dialCalls).toBe(1);
      expect(resolveCalls).toBe(1);
    });

    it('falls through to dialProtocol when newStream throws (race / dead conn)', async () => {
      let newStreamCalls = 0;
      let dialCalls = 0;
      let resolveCalls = 0;
      const router = makeRouterWithFastPath({
        connections: [
          {
            status: 'open',
            newStream: async () => {
              newStreamCalls += 1;
              throw new Error('connection went away mid-newStream');
            },
          },
        ],
        dialBehavior: async () => {
          dialCalls += 1;
          return makeStubStream(new Uint8Array([0xCC])) as any;
        },
        onResolve: () => { resolveCalls += 1; },
      });

      const out = await router.send(FAKE_PEER_ID, '/dkg/test/1.0.0', new Uint8Array([1]));
      expect(out).toEqual(new Uint8Array([0xCC]));
      expect(newStreamCalls).toBe(1);
      // Fallback within the SAME attempt — we don't waste a retry
      // slot on a fast-path miss. Resolver runs once for the
      // dialProtocol fallback.
      expect(dialCalls).toBe(1);
      expect(resolveCalls).toBe(1);
    });

    it('aborts a dead reused stream (writeStatus=closed) and falls back to dialProtocol when no other candidate exists', async () => {
      let abortCalls = 0;
      let dialCalls = 0;
      const router = makeRouterWithFastPath({
        connections: [
          {
            status: 'open',
            newStream: async () => ({
              // The known mid-stream-negotiation race documented at
              // docs/archive/UPSTREAM_ISSUE_DRAFT.md — `newStream`
              // returns a stream that's already in a closed state
              // because the CM tore down the connection between
              // negotiation and return. We must NOT send on it.
              writeStatus: 'closed' as const,
              send: () => undefined,
              close: async () => undefined,
              abort: () => { abortCalls += 1; },
              async *[Symbol.asyncIterator]() {
                /* never yields */
              },
            }),
          },
        ],
        dialBehavior: async () => {
          dialCalls += 1;
          return makeStubStream(new Uint8Array([0xDD])) as any;
        },
      });

      const out = await router.send(FAKE_PEER_ID, '/dkg/test/1.0.0', new Uint8Array([1]));
      expect(out).toEqual(new Uint8Array([0xDD]));
      // Dead reused stream MUST be aborted so the underlying yamux
      // muxer cleans it up — otherwise leak.
      expect(abortCalls).toBe(1);
      expect(dialCalls).toBe(1);
    });

    // Codex review of PR #537: when the first candidate returns a
    // dead stream, the fast path MUST continue to the next candidate
    // before giving up. Returning early (the original PR shape)
    // disables the entire fast path whenever a single stale
    // connection happens to be first in `getConnections()`'s output —
    // exactly the "peerStore is empty but we have multiple live
    // conns" scenario this PR is meant to heal, since libp2p
    // sometimes hands back a torn-down connection alongside a
    // healthy one in the same `getConnections` result.
    it('continues to the next candidate when an earlier one returns a dead stream (PR #537 Codex fix)', async () => {
      let firstAborted = 0;
      let secondUsed = 0;
      let dialCalls = 0;
      const router = makeRouterWithFastPath({
        connections: [
          {
            status: 'open',
            newStream: async () => ({
              writeStatus: 'closed' as const,
              send: () => undefined,
              close: async () => undefined,
              abort: () => { firstAborted += 1; },
              async *[Symbol.asyncIterator]() {
                /* never yields */
              },
            }),
          },
          {
            status: 'open',
            newStream: async () => {
              secondUsed += 1;
              return makeStubStream(new Uint8Array([0x55])) as any;
            },
          },
        ],
        dialBehavior: async () => {
          dialCalls += 1;
          throw new Error('dialProtocol must not be called — second candidate is healthy');
        },
      });

      const out = await router.send(FAKE_PEER_ID, '/dkg/test/1.0.0', new Uint8Array([1]));
      expect(out).toEqual(new Uint8Array([0x55]));
      expect(firstAborted).toBe(1);
      expect(secondUsed).toBe(1);
      expect(dialCalls).toBe(0);
    });

    // Codex review of PR #537 + CI regression on
    // `e2e-agents.test.ts > agents exchange encrypted chat through
    // a relay (DCUtR upgrade)`: opening a stream on a LIMITED
    // (circuit-relay-v2) connection when peerStore has direct
    // addresses for the peer triggers libp2p's connection-manager
    // auto-upgrade race — CM dials direct, succeeds, prunes the
    // limited connection mid-stream, the just-opened stream dies
    // and the receiver's `Connection.onIncomingStream → abort`
    // throws an unhandled `StreamStateError`. Guard: skip limited
    // candidates when peerStore has any non-circuit address.
    it('skips a limited (circuit-relay) candidate when peerStore has direct addresses (DCUtR upgrade race)', async () => {
      let limitedNewStream = 0;
      let dialCalls = 0;
      const router = makeRouterWithFastPath({
        connections: [
          {
            status: 'open',
            limits: { bytes: 1024 * 1024 },
            newStream: async () => {
              limitedNewStream += 1;
              return makeStubStream(new Uint8Array([0x00])) as any;
            },
          },
        ],
        peerStoreGet: async () => ({
          addresses: [
            { multiaddr: { toString: () => '/ip4/1.2.3.4/tcp/4001' } },
          ],
        }),
        dialBehavior: async () => {
          dialCalls += 1;
          return makeStubStream(new Uint8Array([0x66])) as any;
        },
      });

      const out = await router.send(FAKE_PEER_ID, '/dkg/test/1.0.0', new Uint8Array([1]));
      expect(out).toEqual(new Uint8Array([0x66]));
      expect(limitedNewStream).toBe(0);
      expect(dialCalls).toBe(1);
    });

    // The Window D shape this fast path is meant to heal: a single
    // inbound LIMITED circuit-relay connection AND an empty
    // peerStore for the peer. Verify the fast path still fires
    // here (the DCUtR guard above must not regress Window D).
    it('uses a limited candidate when peerStore is empty (Window D — the case this PR exists to heal)', async () => {
      let limitedUsed = 0;
      let dialCalls = 0;
      const router = makeRouterWithFastPath({
        connections: [
          {
            status: 'open',
            limits: { bytes: 1024 * 1024 },
            newStream: async () => {
              limitedUsed += 1;
              return makeStubStream(new Uint8Array([0x77])) as any;
            },
          },
        ],
        // Default peerStoreGet throws — cold-cache miss.
        dialBehavior: async () => {
          dialCalls += 1;
          throw new Error('dialProtocol must not be called — fast path heals Window D');
        },
      });

      const out = await router.send(FAKE_PEER_ID, '/dkg/test/1.0.0', new Uint8Array([1]));
      expect(out).toEqual(new Uint8Array([0x77]));
      expect(limitedUsed).toBe(1);
      expect(dialCalls).toBe(0);
    });

    // peerStore returns ONLY circuit-relay addresses (no direct).
    // CM can't auto-upgrade — there's no direct path to upgrade
    // to. The limited candidate is safe to use.
    it('uses a limited candidate when peerStore has ONLY circuit addresses (no upgrade target)', async () => {
      let limitedUsed = 0;
      let dialCalls = 0;
      const router = makeRouterWithFastPath({
        connections: [
          {
            status: 'open',
            limits: { bytes: 1024 * 1024 },
            newStream: async () => {
              limitedUsed += 1;
              return makeStubStream(new Uint8Array([0x88])) as any;
            },
          },
        ],
        peerStoreGet: async () => ({
          addresses: [
            { multiaddr: { toString: () => '/ip4/9.9.9.9/tcp/4001/p2p/Q/p2p-circuit/p2p/P' } },
          ],
        }),
        dialBehavior: async () => {
          dialCalls += 1;
          throw new Error('dialProtocol must not be called — limited fast path is safe');
        },
      });

      const out = await router.send(FAKE_PEER_ID, '/dkg/test/1.0.0', new Uint8Array([1]));
      expect(out).toEqual(new Uint8Array([0x88]));
      expect(limitedUsed).toBe(1);
      expect(dialCalls).toBe(0);
    });

    it('skips connections whose status is not "open"', async () => {
      let openCalls = 0;
      let closedCalls = 0;
      let dialCalls = 0;
      const router = makeRouterWithFastPath({
        connections: [
          {
            status: 'closing',
            newStream: async () => {
              closedCalls += 1;
              return makeStubStream(new Uint8Array([0x00])) as any;
            },
          },
          {
            status: 'open',
            newStream: async () => {
              openCalls += 1;
              return makeStubStream(new Uint8Array([0xEE])) as any;
            },
          },
        ],
        dialBehavior: async () => {
          dialCalls += 1;
          throw new Error('should not dial — open conn was second in list');
        },
      });

      const out = await router.send(FAKE_PEER_ID, '/dkg/test/1.0.0', new Uint8Array([1]));
      expect(out).toEqual(new Uint8Array([0xEE]));
      // Closing connections are not viable carriers — skip without
      // calling newStream on them (would either throw or hand back
      // a dead stream that we'd then have to abort).
      expect(closedCalls).toBe(0);
      expect(openCalls).toBe(1);
      expect(dialCalls).toBe(0);
    });

    it('treats a getConnections() throw as a fast-path miss (defensive)', async () => {
      let dialCalls = 0;
      const router = makeRouterWithFastPath({
        connections: [],
        dialBehavior: async () => {
          dialCalls += 1;
          return makeStubStream(new Uint8Array([0xFF])) as any;
        },
        onGetConnections: () => {
          throw new Error('libp2p internal state mismatch');
        },
      });

      const out = await router.send(FAKE_PEER_ID, '/dkg/test/1.0.0', new Uint8Array([1]));
      expect(out).toEqual(new Uint8Array([0xFF]));
      // A throwing getConnections must NOT propagate — the fast
      // path silently misses and we go through dialProtocol as
      // if no connection existed. Anything else risks turning a
      // diagnostic-only assist into a real availability regression.
      expect(dialCalls).toBe(1);
    });

    // User review on PR #537: the fast path MUST walk
    // `getConnections()` (raw, no peerId arg) and filter by
    // `remotePeer.equals(peerId)` ourselves, NOT call the
    // peerId-keyed `getConnections(peerId)` overload. The Window D
    // signature (`rawConnectionCount > getConnectionsReturnsForPeer`
    // in `PeerDiagnostics`) is libp2p's keyed lookup returning `[]`
    // for a peer whose live connection is still present in the raw
    // walk. Using the keyed lookup here would make the fast path
    // miss the exact case it was built to heal. Pin the raw-walk
    // behavior with a stub whose keyed-lookup overload returns []
    // but whose no-arg overload returns a usable inbound limited
    // connection.
    it('walks raw getConnections() — finds candidates when keyed lookup returns [] (Window D shape)', async () => {
      let newStreamCalls = 0;
      let dialCalls = 0;
      // Build a custom node where `libp2p.getConnections(arg)`
      // returns [] for the peerId-keyed overload but
      // `libp2p.getConnections()` (no arg) returns the live
      // inbound limited connection — exactly the Window D shape
      // PR #533's `getConnectionsReturnsForPeer` diagnostic
      // surfaces as `0` against a positive `rawConnectionCount`.
      const liveConn = {
        status: 'open' as const,
        limits: { bytes: 1024 * 1024 },
        remotePeer: {
          equals: (other: unknown) => String(other) === FAKE_PEER_ID,
          toString: () => FAKE_PEER_ID,
        },
        newStream: async () => {
          newStreamCalls += 1;
          return makeStubStream(new Uint8Array([0x99])) as any;
        },
      };
      const node = {
        libp2p: {
          getConnections: (arg?: unknown) => (arg == null ? [liveConn] : []),
          dialProtocol: async () => {
            dialCalls += 1;
            throw new Error('dialProtocol must not be called — fast path must heal Window D');
          },
          handle: () => undefined,
          unhandle: () => undefined,
          peerStore: { get: async () => { throw new Error('NotFound'); } },
        },
      } as unknown as DKGNode;
      const peerResolver = {
        resolve: async () => [],
      } as unknown as PeerResolver;
      const router = new ProtocolRouter(node, { peerResolver });

      const out = await router.send(FAKE_PEER_ID, '/dkg/test/1.0.0', new Uint8Array([1]));
      expect(out).toEqual(new Uint8Array([0x99]));
      expect(newStreamCalls).toBe(1);
      expect(dialCalls).toBe(0);
    });
  });
});
