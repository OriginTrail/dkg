// publisher/test/_helpers/substrate.ts
//
// rc.9 PR-8 — minimal test-only helper that mimics the agent-side
// Universal Messenger substrate (`Messenger.register` + `Messenger
// .sendReliable`) using only the core package's primitives. Required
// after PR-8's wire-prefix bump to `/dkg/10.0.1/private-access`:
// receivers MUST decode `ReliableEnvelope`, senders MUST encode it,
// or both sides fail to interop.
//
// We can't import the real `Messenger` here because it lives in the
// agent package (which depends on publisher) — that'd cycle. So this
// re-implements just the wire-shape parts of the substrate. It does
// NOT include the outbox or retry ladder; access tests are
// synchronous-by-design (the requester is waiting for triples, not
// enqueueing background work) so a single attempt is all that's
// needed for the protocol-level assertions these tests cover.

import { randomUUID } from 'node:crypto';
import {
  decodeReliableEnvelope,
  encodeReliableEnvelope,
  InMemoryMessageIdempotencyStore,
  RELIABLE_ENVELOPE_VERSION,
  type ProtocolRouter,
} from '@origintrail-official/dkg-core';
import type { AccessSendSurface } from '../../src/access-client.js';

/**
 * Register a handler the way `Messenger.register` does it: decode
 * the outer `ReliableEnvelope`, consult a fresh in-memory
 * idempotency cache for receiver-side dedup, pass the inner payload
 * + sender peerId string to the supplied handler.
 *
 * Returns the idempotency store so tests that want to assert on
 * dedup state can poke it.
 */
export function registerSubstrateHandler(
  router: ProtocolRouter,
  protocolId: string,
  handler: (payload: Uint8Array, peerId: string) => Promise<Uint8Array>,
): InMemoryMessageIdempotencyStore {
  const idem = new InMemoryMessageIdempotencyStore();
  router.register(protocolId, async (envelopeBytes, peerIdObj) => {
    const env = decodeReliableEnvelope(envelopeBytes);
    const peerKey = peerIdObj.toString();
    const seen = idem.check(peerKey, protocolId, env.messageId, 'in');
    if (seen.seen) return seen.cachedResponse ?? new Uint8Array();
    const response = await handler(env.payload, peerKey);
    idem.record(peerKey, protocolId, env.messageId, 'in', response);
    return response;
  });
  return idem;
}

/**
 * Mint an `AccessSendSurface` over a raw `ProtocolRouter` so tests
 * can construct an `AccessClient` without depending on the agent
 * package's `Messenger` class. Wraps each send in a fresh
 * `ReliableEnvelope`; reports the `router.send` failure as `queued`
 * (the substrate's standard recoverable shape).
 */
export function createSubstrateClient(router: ProtocolRouter): AccessSendSurface {
  return {
    async sendReliable(peerId, protocolId, payload, opts) {
      const messageId = opts?.messageId ?? randomUUID();
      const envelope = encodeReliableEnvelope({
        messageId,
        version: RELIABLE_ENVELOPE_VERSION,
        tsMs: Date.now(),
        payload,
      });
      try {
        const response = await router.send(peerId, protocolId, envelope, opts?.timeoutMs);
        return { delivered: true as const, response, attempts: 1, messageId };
      } catch (err) {
        return {
          delivered: false as const,
          queued: true as const,
          attempts: 1,
          messageId,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };
}
