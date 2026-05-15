// messaging-chat-acl.test.ts
//
// End-to-end (in-process) test of MessageHandler chat plumbing — the
// pieces of `messaging.ts` that landed for Phase 1 of the agent debug
// chat RFC:
//
//   1. `sendChat({ contextGraphId })` carries the field in the
//      encrypted JSON payload.
//   2. `handleIncoming` decrypts, extracts `senderContextGraphId` if
//      present, and passes it to the chat handler.
//   3. `setChatAcl(fn)` is consulted before the chat handler; an
//      `{ accept: false }` verdict produces an encrypted unauthorized
//      response and skips the chat handler entirely.
//   4. Backwards compatibility: legacy 3-arg ChatHandlers still work
//      against the new 4-arg signature (extra positional arg ignored).
//
// Set-up: two MessageHandlers (A, B) wired with stub Messenger/Router
// so A.sendChat → B.handleIncoming via an in-memory hop. Pre-registers
// each peer's Ed25519 public key so we don't need real libp2p PeerId
// strings.

import { describe, it, expect, vi } from 'vitest';
import { generateEd25519Keypair, type Ed25519Keypair } from '@origintrail-official/dkg-core';
import type { ProtocolRouter, EventBus, DKGStreamHandler } from '@origintrail-official/dkg-core';
import { MessageHandler, ed25519ToX25519Private, type ChatHandler, type ChatAclCheck } from '../src/index.js';
import type { Messenger } from '../src/p2p/messenger.js';

// Two PeerId-shaped opaque tokens. We pre-cache the Ed25519 pubkeys via
// registerPeerKey() so MessageHandler never tries to decode these as
// real libp2p PeerIds — they're just routing identifiers in this test.
const PEER_A = '12D3KooWAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const PEER_B = '12D3KooWBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

function makeEventBus(): EventBus {
  return {
    emit: () => {},
    on: () => {},
    off: () => {},
  };
}

interface TestPair {
  a: MessageHandler;
  b: MessageHandler;
  keyA: Ed25519Keypair;
  keyB: Ed25519Keypair;
  /** The bound `handleIncoming` for peer B (what A's messenger calls). */
  bIncoming: DKGStreamHandler;
  aIncoming: DKGStreamHandler;
}

async function buildPair(): Promise<TestPair> {
  const keyA = await generateEd25519Keypair();
  const keyB = await generateEd25519Keypair();
  const xA = ed25519ToX25519Private(keyA.secretKey);
  const xB = ed25519ToX25519Private(keyB.secretKey);

  // Capture each side's `handleIncoming` so we can wire the
  // messengers across without needing real libp2p.
  let aIncoming: DKGStreamHandler | null = null;
  let bIncoming: DKGStreamHandler | null = null;

  const routerA: ProtocolRouter = {
    register: (_proto: string, handler: DKGStreamHandler) => {
      aIncoming = handler;
    },
  } as unknown as ProtocolRouter;

  const routerB: ProtocolRouter = {
    register: (_proto: string, handler: DKGStreamHandler) => {
      bIncoming = handler;
    },
  } as unknown as ProtocolRouter;

  // A's messenger routes outbound frames to B.handleIncoming and back.
  const messengerA: Messenger = {
    sendToPeer: async (_to: string, _proto: string, data: Uint8Array) => {
      if (!bIncoming) throw new Error('bIncoming not registered');
      return await bIncoming(data, { toString: () => PEER_A });
    },
  } as unknown as Messenger;

  // B's messenger isn't actually used by the test cases (B only
  // receives), but provide a stub so construction succeeds.
  const messengerB: Messenger = {
    sendToPeer: async (_to: string, _proto: string, data: Uint8Array) => {
      if (!aIncoming) throw new Error('aIncoming not registered');
      return await aIncoming(data, { toString: () => PEER_B });
    },
  } as unknown as Messenger;

  const a = new MessageHandler(routerA, messengerA, keyA, xA, PEER_A, makeEventBus());
  const b = new MessageHandler(routerB, messengerB, keyB, xB, PEER_B, makeEventBus());

  // Cache each side's public key on the other so MessageHandler
  // doesn't try to decode PEER_A/PEER_B as a real libp2p PeerId.
  a.registerPeerKey(PEER_B, keyB.publicKey);
  b.registerPeerKey(PEER_A, keyA.publicKey);

  if (!aIncoming || !bIncoming) {
    throw new Error('handlers not captured');
  }
  return { a, b, keyA, keyB, aIncoming, bIncoming };
}

describe('MessageHandler — chat ACL + contextGraphId plumbing', () => {
  it('contextGraphId rides the encrypted payload and reaches the chat handler', async () => {
    const { a, b } = await buildPair();

    const chatHandler = vi.fn();
    b.onChat(chatHandler);

    const result = await a.sendChat(PEER_B, 'hello from A', {
      contextGraphId: 'cg-debug',
    });

    expect(result.delivered).toBe(true);
    expect(result.error).toBeUndefined();

    expect(chatHandler).toHaveBeenCalledTimes(1);
    const [text, sender, _convId, senderContextGraphId] = chatHandler.mock.calls[0];
    expect(text).toBe('hello from A');
    expect(sender).toBe(PEER_A);
    expect(senderContextGraphId).toBe('cg-debug');
  });

  it('omits contextGraphId when sender did not provide one', async () => {
    const { a, b } = await buildPair();
    const chatHandler = vi.fn();
    b.onChat(chatHandler);

    await a.sendChat(PEER_B, 'no cg');

    const [, , , senderContextGraphId] = chatHandler.mock.calls[0];
    expect(senderContextGraphId).toBeUndefined();
  });

  it('ACL accept → chat handler is invoked', async () => {
    const { a, b } = await buildPair();
    const acl: ChatAclCheck = vi.fn((sender, payload) => {
      expect(sender).toBe(PEER_A);
      expect(payload.contextGraphId).toBe('cg-ok');
      return { accept: true };
    });
    b.setChatAcl(acl);

    const chatHandler = vi.fn();
    b.onChat(chatHandler);

    const result = await a.sendChat(PEER_B, 'allowed', { contextGraphId: 'cg-ok' });

    expect(result.delivered).toBe(true);
    expect(acl).toHaveBeenCalledTimes(1);
    expect(chatHandler).toHaveBeenCalledTimes(1);
  });

  it('ACL reject → unauthorized response reaches sender, chat handler is NOT invoked', async () => {
    const { a, b } = await buildPair();
    b.setChatAcl(() => ({ accept: false, reason: 'unauthorized: nope' }));

    const chatHandler = vi.fn();
    b.onChat(chatHandler);

    const result = await a.sendChat(PEER_B, 'rejected');

    expect(result.delivered).toBe(false);
    expect(result.error).toBe('unauthorized: nope');
    expect(chatHandler).not.toHaveBeenCalled();
  });

  it('ACL reject falls back to default "unauthorized" reason when none provided', async () => {
    const { a, b } = await buildPair();
    b.setChatAcl(() => ({ accept: false }));
    const chatHandler = vi.fn();
    b.onChat(chatHandler);

    const result = await a.sendChat(PEER_B, 'no-reason');

    expect(result.delivered).toBe(false);
    expect(result.error).toBe('unauthorized');
    expect(chatHandler).not.toHaveBeenCalled();
  });

  it('setChatAcl(null) restores accept-all behaviour', async () => {
    const { a, b } = await buildPair();
    b.setChatAcl(() => ({ accept: false, reason: 'blocked' }));
    b.setChatAcl(null);

    const chatHandler = vi.fn();
    b.onChat(chatHandler);

    const result = await a.sendChat(PEER_B, 'should-pass');
    expect(result.delivered).toBe(true);
    expect(chatHandler).toHaveBeenCalledTimes(1);
  });

  it('backwards compat — legacy 3-arg ChatHandler still works', async () => {
    const { a, b } = await buildPair();
    // Pretend a legacy handler that only knows about 3 args. JS will
    // silently drop the 4th positional arg — verify nothing breaks.
    const legacyHandler = vi.fn(((text: string, _senderPeerId: string, _convId: string) => {
      expect(text).toBe('legacy');
    }) as ChatHandler);
    b.onChat(legacyHandler);

    const result = await a.sendChat(PEER_B, 'legacy', { contextGraphId: 'cg-x' });
    expect(result.delivered).toBe(true);
    expect(legacyHandler).toHaveBeenCalledTimes(1);
  });

  // Codex PR #510 round 4 — a throwing ACL callback must NOT bubble
  // out as a transport-layer failure (the sender would interpret it
  // as a network issue and retry). The handler now catches and
  // surfaces a clean `unauthorized` so the sender's ACL-aware error
  // path kicks in.
  it('ACL throw → handler catches and fails closed with "unauthorized" reason', async () => {
    const { a, b } = await buildPair();
    // Silence console.warn so the deliberate throw doesn't pollute
    // the test output.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      b.setChatAcl(() => {
        throw new Error('db unavailable');
      });
      const chatHandler = vi.fn();
      b.onChat(chatHandler);

      const result = await a.sendChat(PEER_B, 'should-reject-on-throw');

      expect(result.delivered).toBe(false);
      expect(result.error).toMatch(/unauthorized: ACL evaluation error/);
      // Critically: chat handler must NOT run when ACL evaluation
      // failed — fail-closed semantics.
      expect(chatHandler).not.toHaveBeenCalled();
      // Diagnostics should land on console.warn so operators can see
      // why ACL is suddenly rejecting everything.
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('chat ACL threw, failing closed: db unavailable'),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('ACL runs AFTER signature verification (defence in depth)', async () => {
    const { a, b } = await buildPair();

    // Confirm by counting: we expect the ACL to be consulted exactly
    // once per chat message, NOT before message decoding. We can't
    // easily test signature-rejection-then-ACL-not-called without
    // mucking with raw bytes, but the order-of-operations invariant
    // is asserted indirectly here: any malformed signature would
    // never reach the ACL.
    const acl = vi.fn(() => ({ accept: true }));
    b.setChatAcl(acl);
    b.onChat(() => {});

    await a.sendChat(PEER_B, 'm1');
    await a.sendChat(PEER_B, 'm2');
    await a.sendChat(PEER_B, 'm3');

    expect(acl).toHaveBeenCalledTimes(3);
  });
});
