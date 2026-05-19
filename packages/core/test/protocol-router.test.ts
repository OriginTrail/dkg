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
      expect(isRecoverableSendError(new Error('NO_RESERVATION'))).toBe(true);
      expect(isRecoverableSendError(new Error('no reservation for relay'))).toBe(true);
    });

    // Regression for the May 2026 multi-node soak: libp2p surfaces
    // "All multiaddr dials failed" when every candidate address for
    // the peer fails in a single dial attempt (instantaneous
    // routing-table miss). Pre-fix this was terminal; post-fix it
    // queues so the substrate outbox + PR-5 DHT-walk-on-stall
    // re-resolves the peer and retries.
    it('returns true for libp2p multiaddr dial exhaustion (May 2026 soak)', () => {
      expect(isRecoverableSendError(new Error('All multiaddr dials failed'))).toBe(true);
      // Matches case-insensitively + within wrapping context (libp2p
      // sometimes prefixes with the protocol id).
      expect(isRecoverableSendError(new Error('dialProtocol(/dkg/10.0.1/message): All multiaddr dials failed'))).toBe(true);
      expect(isRecoverableSendError(new Error('all multiaddr dials failed'))).toBe(true);
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

  // Codex review of PR #538: the fast path previously latched a
  // half-dead connection for the whole 3-attempt retry budget. If
  // `newStream()` opened a stream on a stale connection and the
  // subsequent `send`/`readAll` blew up with a recoverable error,
  // the retry loop would just pick the same dead connection on the
  // next attempt (libp2p doesn't always prune a torn-down connection
  // before our 500 ms backoff fires). The fix is a per-`send()`
  // exclude-set: once a connection produces a failure, it's
  // blacklisted for the remaining attempts and the loop either
  // picks a different live candidate or falls through to
  // `dialProtocol`.
  describe('fast path connection-blacklist on stream failure (PR #538 Codex feedback)', () => {
    const FAKE_PEER_ID = '12D3KooWBzj7Hg2cKCdsKL6QcjC5UbLztKTvzCZQHaT4P4ZyJEAA';

    // Stream that succeeds on send/close but throws a recoverable
    // error during readAll — the stale-half-dead-connection shape
    // the reviewer flagged.
    function makeDeadReadStream() {
      return {
        writeStatus: 'open' as const,
        send: () => undefined,
        close: async () => undefined,
        abort: () => undefined,
        async *[Symbol.asyncIterator]() {
          throw new Error('stream returned in closed state');
        },
      };
    }

    function makeWorkingStream(response: Uint8Array) {
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

    function makeConn(opts: {
      onNewStream: () => Promise<unknown>;
      label: string;
    }) {
      return {
        status: 'open' as const,
        label: opts.label,
        remotePeer: {
          equals: (other: unknown) => String(other) === FAKE_PEER_ID,
          toString: () => FAKE_PEER_ID,
        },
        newStream: opts.onNewStream,
      };
    }

    it('skips a connection that failed on a prior attempt and picks the next live one', async () => {
      // Two live connections to the same peer. The first one's
      // newStream returns a stream that blows up on readAll
      // (recoverable). The second is healthy. Without the
      // blacklist, the retry loop would re-pick the first
      // connection — libp2p's `getConnections()` returns the same
      // list across the 500ms backoff. With the blacklist, attempt
      // 2 picks the second connection and the send succeeds.
      let connADials = 0;
      let connBDials = 0;
      let dialProtocolCalls = 0;
      const connA = makeConn({
        label: 'A-stale',
        onNewStream: async () => {
          connADials += 1;
          return makeDeadReadStream() as any;
        },
      });
      const connB = makeConn({
        label: 'B-healthy',
        onNewStream: async () => {
          connBDials += 1;
          return makeWorkingStream(new Uint8Array([0x42])) as any;
        },
      });
      const node = {
        libp2p: {
          getConnections: () => [connA, connB],
          dialProtocol: async () => {
            dialProtocolCalls += 1;
            throw new Error('dialProtocol should not be reached — second connection is healthy');
          },
          handle: () => undefined,
          unhandle: () => undefined,
          peerStore: { get: async () => { throw new Error('NotFound'); } },
        },
      } as unknown as DKGNode;
      const peerResolver = { resolve: async () => [] } as unknown as PeerResolver;
      const router = new ProtocolRouter(node, { peerResolver });

      const out = await router.send(FAKE_PEER_ID, '/dkg/test/1.0.0', new Uint8Array([1]));
      expect(out).toEqual(new Uint8Array([0x42]));
      expect(connADials).toBe(1);
      expect(connBDials).toBe(1);
      expect(dialProtocolCalls).toBe(0);
    });

    it('falls through to dialProtocol after the only candidate connection is blacklisted', async () => {
      // Single bad connection. After attempt 1 blacklists it, the
      // fast path has no remaining candidates → returns null →
      // dialProtocol runs on attempts 2 (and 3 if needed). This is
      // the exact recovery the reviewer was looking for: an
      // unconditional fallback would risk re-triggering the
      // upgrade race the fast path was built to avoid, but
      // blacklisting + relying on the existing `null →
      // dialProtocol` fallback inside the same retry loop is safe.
      let newStreamCalls = 0;
      let dialProtocolCalls = 0;
      const badConn = makeConn({
        label: 'only-bad',
        onNewStream: async () => {
          newStreamCalls += 1;
          return makeDeadReadStream() as any;
        },
      });
      const node = {
        libp2p: {
          getConnections: () => [badConn],
          dialProtocol: async () => {
            dialProtocolCalls += 1;
            return makeWorkingStream(new Uint8Array([0x77])) as any;
          },
          handle: () => undefined,
          unhandle: () => undefined,
          peerStore: { get: async () => { throw new Error('NotFound'); } },
        },
      } as unknown as DKGNode;
      const peerResolver = { resolve: async () => [] } as unknown as PeerResolver;
      const router = new ProtocolRouter(node, { peerResolver });

      const out = await router.send(FAKE_PEER_ID, '/dkg/test/1.0.0', new Uint8Array([1]));
      expect(out).toEqual(new Uint8Array([0x77]));
      // Bad connection was tried exactly once before being
      // blacklisted — the retry budget is spent on dialProtocol,
      // not on hammering the same dead connection.
      expect(newStreamCalls).toBe(1);
      expect(dialProtocolCalls).toBe(1);
    });

    it('does not blacklist a connection used by a successful send (no false-positive eviction)', async () => {
      // Sanity test: the blacklist only kicks in on failure. A
      // successful send must not poison the connection for future
      // sends. Because `triedConnections` is per-`send()` it's
      // technically impossible for a successful send to leak its
      // entries — but if a future refactor moved the WeakSet up
      // to the router instance, this test would catch it.
      let aDials = 0;
      const goodConn = makeConn({
        label: 'good',
        onNewStream: async () => {
          aDials += 1;
          return makeWorkingStream(new Uint8Array([0x55])) as any;
        },
      });
      const node = {
        libp2p: {
          getConnections: () => [goodConn],
          dialProtocol: async () => { throw new Error('unused'); },
          handle: () => undefined,
          unhandle: () => undefined,
          peerStore: { get: async () => { throw new Error('NotFound'); } },
        },
      } as unknown as DKGNode;
      const peerResolver = { resolve: async () => [] } as unknown as PeerResolver;
      const router = new ProtocolRouter(node, { peerResolver });

      await router.send(FAKE_PEER_ID, '/dkg/test/1.0.0', new Uint8Array([1]));
      await router.send(FAKE_PEER_ID, '/dkg/test/1.0.0', new Uint8Array([2]));
      await router.send(FAKE_PEER_ID, '/dkg/test/1.0.0', new Uint8Array([3]));

      // 3 successful sends → 3 newStream calls on the same conn.
      // If a refactor accidentally promoted the blacklist to the
      // router scope, sends 2+ would skip this conn and fall
      // through to dialProtocol (which throws here).
      expect(aDials).toBe(3);
    });
  });

  // Direct unit tests on `tryReuseExistingConnection`'s
  // `excludeConnections` wiring — independent of `ProtocolRouter.send`
  // so a future refactor that changes how `send()` plumbs the
  // blacklist still exercises the candidate-skip logic itself.
  describe('tryReuseExistingConnection: excludeConnections wiring', () => {
    it('skips connections present in the exclude WeakSet', async () => {
      const { tryReuseExistingConnection } = await import('../src/protocol-router.js');
      const callOrder: string[] = [];
      const conns = [
        { status: 'open', label: 'A', newStream: async () => { callOrder.push('A'); throw new Error('boom'); } },
        { status: 'open', label: 'B', newStream: async () => {
          callOrder.push('B');
          return { writeStatus: 'open' } as any;
        } },
      ] as any[];
      const exclude = new WeakSet<object>();
      exclude.add(conns[0]);

      const result = await tryReuseExistingConnection(
        () => conns,
        '/test/1.0.0',
        AbortSignal.timeout(1000),
        { peerHasDirectAddrs: async () => false, excludeConnections: exclude },
      );

      expect(callOrder).toEqual(['B']);
      expect(result?.connection).toBe(conns[1]);
    });

    it('returns the connection alongside the stream so callers can blacklist on failure', async () => {
      const { tryReuseExistingConnection } = await import('../src/protocol-router.js');
      const targetConn = {
        status: 'open',
        newStream: async () => ({ writeStatus: 'open' } as any),
      };
      const result = await tryReuseExistingConnection(
        () => [targetConn] as any[],
        '/test/1.0.0',
        AbortSignal.timeout(1000),
        { peerHasDirectAddrs: async () => false },
      );
      expect(result).not.toBeNull();
      expect(result!.connection).toBe(targetConn);
      expect(result!.stream.writeStatus).toBe('open');
    });

    it('returns null when every candidate is excluded', async () => {
      const { tryReuseExistingConnection } = await import('../src/protocol-router.js');
      const conns = [
        { status: 'open', newStream: async () => ({ writeStatus: 'open' } as any) },
        { status: 'open', newStream: async () => ({ writeStatus: 'open' } as any) },
      ];
      const exclude = new WeakSet<object>();
      exclude.add(conns[0]);
      exclude.add(conns[1]);

      const result = await tryReuseExistingConnection(
        () => conns as any[],
        '/test/1.0.0',
        AbortSignal.timeout(1000),
        { peerHasDirectAddrs: async () => false, excludeConnections: exclude },
      );
      expect(result).toBeNull();
    });
  });

  // rc.9 PR-4 — multi-path parallel send. ProtocolRouter.send(parallelPaths > 1)
  // races up to N live connections via Promise.any-equivalent; the
  // first successful response wins, losers are aborted. Safe by the
  // /dkg/10.0.1/* prefix invariant (receiver dedupes via
  // Messenger.register). When fewer than 2 live connections exist or
  // all parallel attempts fail, falls through to the single-path
  // resolver + dialProtocol retry loop. See SendOptions JSDoc.
  describe('send() multi-path parallel race (rc.9 PR-4)', () => {
    const FAKE_PEER_ID = '12D3KooWBzj7Hg2cKCdsKL6QcjC5UbLztKTvzCZQHaT4P4ZyJEAA';

    function makeWorkingStream(response: Uint8Array, delayMs = 0) {
      let returned = false;
      return {
        writeStatus: 'open' as const,
        send: () => undefined,
        close: async () => undefined,
        abort: () => undefined,
        async *[Symbol.asyncIterator]() {
          if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
          if (!returned) {
            returned = true;
            yield response;
          }
        },
      };
    }

    function makeConn(opts: {
      label: string;
      onNewStream: (
        protocols?: string,
        options?: { runOnLimitedConnection?: boolean; signal?: AbortSignal },
      ) => Promise<unknown>;
    }) {
      return {
        status: 'open' as const,
        label: opts.label,
        remotePeer: {
          equals: (other: unknown) => String(other) === FAKE_PEER_ID,
          toString: () => FAKE_PEER_ID,
        },
        newStream: opts.onNewStream,
      };
    }

    function makeRouter(opts: {
      connections: ReadonlyArray<ReturnType<typeof makeConn>>;
      onDial?: () => void;
    }): ProtocolRouter {
      const node = {
        libp2p: {
          getConnections: () => opts.connections,
          dialProtocol: async () => {
            opts.onDial?.();
            throw new Error('dialProtocol should not be reached when multi-path wins');
          },
          handle: () => undefined,
          unhandle: () => undefined,
          peerStore: { get: async () => { throw new Error('NotFound'); } },
        },
      } as unknown as DKGNode;
      const peerResolver = { resolve: async () => [] } as unknown as PeerResolver;
      return new ProtocolRouter(node, { peerResolver });
    }

    it('parallelPaths=1 (default) preserves the single-path code — no multi-path race', async () => {
      let aDials = 0;
      let bDials = 0;
      const connA = makeConn({
        label: 'A',
        onNewStream: async () => {
          aDials += 1;
          return makeWorkingStream(new Uint8Array([0xAA])) as any;
        },
      });
      const connB = makeConn({
        label: 'B',
        onNewStream: async () => {
          bDials += 1;
          return makeWorkingStream(new Uint8Array([0xBB])) as any;
        },
      });
      const router = makeRouter({ connections: [connA, connB] });

      const result = await router.send(FAKE_PEER_ID, '/dkg/10.0.1/test', new Uint8Array([1]));

      // Single-path takes the first live connection only.
      expect(result).toEqual(new Uint8Array([0xAA]));
      expect(aDials).toBe(1);
      expect(bDials).toBe(0);
    });

    it('parallelPaths>1 with N>=2 live connections opens N parallel streams', async () => {
      let aDials = 0;
      let bDials = 0;
      let cDials = 0;
      const connA = makeConn({
        label: 'A',
        onNewStream: async () => {
          aDials += 1;
          // Slow-A so B wins; this verifies the winner-selection
          // path; A's stream gets aborted as a loser.
          return makeWorkingStream(new Uint8Array([0xAA]), 100) as any;
        },
      });
      const connB = makeConn({
        label: 'B',
        onNewStream: async () => {
          bDials += 1;
          return makeWorkingStream(new Uint8Array([0xBB])) as any;
        },
      });
      const connC = makeConn({
        label: 'C',
        onNewStream: async () => {
          cDials += 1;
          return makeWorkingStream(new Uint8Array([0xCC]), 200) as any;
        },
      });
      const router = makeRouter({ connections: [connA, connB, connC] });

      const result = await router.send(FAKE_PEER_ID, '/dkg/10.0.1/test', new Uint8Array([1]), {
        parallelPaths: 3,
      });

      // Fast-B wins; we returned its bytes. Slow-A and Slow-C were
      // also issued (race kicked off all 3 in parallel).
      expect(result).toEqual(new Uint8Array([0xBB]));
      expect(aDials).toBe(1);
      expect(bDials).toBe(1);
      expect(cDials).toBe(1);
    });

    it('parallelPaths>1 with only 1 live connection skips the race (multi-path adds no value)', async () => {
      let aDials = 0;
      const connA = makeConn({
        label: 'A',
        onNewStream: async () => {
          aDials += 1;
          return makeWorkingStream(new Uint8Array([0xAA])) as any;
        },
      });
      const router = makeRouter({ connections: [connA] });

      const result = await router.send(FAKE_PEER_ID, '/dkg/10.0.1/test', new Uint8Array([1]), {
        parallelPaths: 3,
      });

      expect(result).toEqual(new Uint8Array([0xAA]));
      // Exactly one newStream — multi-path fell through to single-path
      // (which then hit the fast-reuse on connA).
      expect(aDials).toBe(1);
    });

    it('parallelPaths>1 falls through to single-path when ALL parallel attempts fail', async () => {
      let aDials = 0;
      let bDials = 0;
      let dialCalls = 0;
      let multipathSignal: AbortSignal | undefined;
      let fallbackSignal: AbortSignal | undefined;
      const connA = makeConn({
        label: 'A-dead',
        onNewStream: async (_protocols, options) => {
          aDials += 1;
          multipathSignal ??= options?.signal;
          throw new Error('A: stream returned in closed state');
        },
      });
      const connB = makeConn({
        label: 'B-dead',
        onNewStream: async () => {
          bDials += 1;
          throw new Error('B: stream returned in closed state');
        },
      });
      const node = {
        libp2p: {
          getConnections: () => [connA, connB],
          dialProtocol: async (_peer: unknown, _protocol: string, options?: { signal?: AbortSignal }) => {
            dialCalls += 1;
            fallbackSignal = options?.signal;
            return makeWorkingStream(new Uint8Array([0xCC])) as any;
          },
          handle: () => undefined,
          unhandle: () => undefined,
          peerStore: { get: async () => { throw new Error('NotFound'); } },
        },
      } as unknown as DKGNode;
      const peerResolver = { resolve: async () => [] } as unknown as PeerResolver;
      const router = new ProtocolRouter(node, { peerResolver });

      const result = await router.send(FAKE_PEER_ID, '/dkg/10.0.1/test', new Uint8Array([1]), {
        parallelPaths: 2,
      });

      // All multi-path attempts failed → fell through to single-path
      // → fast-reuse hits A and B which throw, so dialProtocol takes
      // over and succeeds.
      expect(result).toEqual(new Uint8Array([0xCC]));
      // Each conn dialed at least once during multi-path; single-path
      // may try them again via fast-reuse before falling to dial.
      expect(aDials).toBeGreaterThanOrEqual(1);
      expect(bDials).toBeGreaterThanOrEqual(1);
      expect(dialCalls).toBeGreaterThanOrEqual(1);
      expect(fallbackSignal).toBeDefined();
      expect(fallbackSignal).not.toBe(multipathSignal);
      expect(fallbackSignal?.aborted).toBe(false);
    });

    it('parallelPaths>1 accepts the number-form timeoutMs still working via opts.timeoutMs', async () => {
      // Backwards-compat smoke: passing a number as the 4th arg
      // still works (rc.8 call sites untouched).
      let dials = 0;
      const node = {
        libp2p: {
          getConnections: () => [],
          dialProtocol: async () => {
            dials += 1;
            return makeWorkingStream(new Uint8Array([0xDD])) as any;
          },
          handle: () => undefined,
          unhandle: () => undefined,
          peerStore: { get: async () => { throw new Error('NotFound'); } },
        },
      } as unknown as DKGNode;
      const peerResolver = { resolve: async () => [] } as unknown as PeerResolver;
      const router = new ProtocolRouter(node, { peerResolver });

      const result = await router.send(FAKE_PEER_ID, '/dkg/10.0.1/test', new Uint8Array([1]), 5000);
      expect(result).toEqual(new Uint8Array([0xDD]));
      expect(dials).toBe(1);
    });
  });

  // Direct unit tests on raceMultiPath itself — independent of
  // ProtocolRouter.send so future refactors that change how send()
  // wires the racer still exercise the race semantics directly.
  describe('raceMultiPath: race semantics (rc.9 PR-4)', () => {
    it('returns null when fewer than 2 live candidates exist', async () => {
      const { raceMultiPath } = await import('../src/protocol-router.js');
      const conn = {
        status: 'open',
        newStream: async () => ({ writeStatus: 'open' } as any),
      };
      const result = await raceMultiPath({
        getConnections: () => [conn] as any[],
        protocolId: '/test/1.0.0',
        data: new Uint8Array([1]),
        parallelPaths: 3,
        signal: AbortSignal.timeout(1000),
        maxReadBytes: 1024,
      });
      expect(result).toBeNull();
    });

    it('returns the first fulfilled response and reports the count of attempted paths', async () => {
      const { raceMultiPath } = await import('../src/protocol-router.js');
      const conns = [
        { status: 'open', newStream: async () => ({
          writeStatus: 'open', send: () => undefined, close: async () => undefined, abort: () => undefined,
          async *[Symbol.asyncIterator]() { await new Promise((r) => setTimeout(r, 50)); yield new Uint8Array([0xAA]); },
        } as any) },
        { status: 'open', newStream: async () => ({
          writeStatus: 'open', send: () => undefined, close: async () => undefined, abort: () => undefined,
          async *[Symbol.asyncIterator]() { yield new Uint8Array([0xBB]); },
        } as any) },
      ];
      const result = await raceMultiPath({
        getConnections: () => conns as any[],
        protocolId: '/test/1.0.0',
        data: new Uint8Array([1]),
        parallelPaths: 2,
        signal: AbortSignal.timeout(1000),
        maxReadBytes: 1024,
      });
      expect(result?.response).toEqual(new Uint8Array([0xBB]));
      expect(result?.attemptedPaths).toBe(2);
    });

    it('returns null when every parallel attempt fails (AggregateError swallowed)', async () => {
      const { raceMultiPath } = await import('../src/protocol-router.js');
      const conns = [
        { status: 'open', newStream: async () => { throw new Error('A-dead'); } },
        { status: 'open', newStream: async () => { throw new Error('B-dead'); } },
      ];
      const result = await raceMultiPath({
        getConnections: () => conns as any[],
        protocolId: '/test/1.0.0',
        data: new Uint8Array([1]),
        parallelPaths: 2,
        signal: AbortSignal.timeout(1000),
        maxReadBytes: 1024,
      });
      expect(result).toBeNull();
    });

    it('aborts the loser stream after the winner settles', async () => {
      const { raceMultiPath } = await import('../src/protocol-router.js');
      let loserAborted = false;
      const winnerStream: any = {
        writeStatus: 'open',
        send: () => undefined,
        close: async () => undefined,
        abort: () => undefined,
        async *[Symbol.asyncIterator]() { yield new Uint8Array([0xCC]); },
      };
      const loserStream: any = {
        writeStatus: 'open',
        send: () => undefined,
        close: async () => undefined,
        abort: () => { loserAborted = true; },
        async *[Symbol.asyncIterator]() {
          await new Promise((r) => setTimeout(r, 100));
          yield new Uint8Array([0xDD]);
        },
      };
      const conns = [
        { status: 'open', newStream: async () => winnerStream },
        { status: 'open', newStream: async () => loserStream },
      ];
      const result = await raceMultiPath({
        getConnections: () => conns as any[],
        protocolId: '/test/1.0.0',
        data: new Uint8Array([1]),
        parallelPaths: 2,
        signal: AbortSignal.timeout(1000),
        maxReadBytes: 1024,
      });
      expect(result?.response).toEqual(new Uint8Array([0xCC]));
      expect(loserAborted).toBe(true);
    });

    it('aborts a late loser stream immediately after newStream returns', async () => {
      const { raceMultiPath } = await import('../src/protocol-router.js');
      let lateLoserAborted = false;
      let lateLoserSent = false;
      const winnerStream: any = {
        writeStatus: 'open',
        send: () => undefined,
        close: async () => undefined,
        abort: () => undefined,
        async *[Symbol.asyncIterator]() { yield new Uint8Array([0xCC]); },
      };
      const lateLoserStream: any = {
        writeStatus: 'open',
        send: () => { lateLoserSent = true; },
        close: async () => undefined,
        abort: () => { lateLoserAborted = true; },
        async *[Symbol.asyncIterator]() { yield new Uint8Array([0xDD]); },
      };
      const conns = [
        { status: 'open', newStream: async () => winnerStream },
        {
          status: 'open',
          newStream: async () => {
            await new Promise((r) => setTimeout(r, 25));
            return lateLoserStream;
          },
        },
      ];
      const result = await raceMultiPath({
        getConnections: () => conns as any[],
        protocolId: '/test/1.0.0',
        data: new Uint8Array([1]),
        parallelPaths: 2,
        signal: AbortSignal.timeout(1000),
        maxReadBytes: 1024,
      });
      expect(result?.response).toEqual(new Uint8Array([0xCC]));

      await new Promise((r) => setTimeout(r, 50));
      expect(lateLoserAborted).toBe(true);
      expect(lateLoserSent).toBe(false);
    });
  });
});
