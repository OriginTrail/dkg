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
});
