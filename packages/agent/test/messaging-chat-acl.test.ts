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
import {
  generateEd25519Keypair,
  InMemoryMessageIdempotencyStore,
  InMemoryProtocolOutboxStore,
  decodeAgentMessage,
  decodeReliableEnvelope,
  encodeAgentMessage,
  encodeReliableEnvelope,
  type Ed25519Keypair,
  type EventBus,
  type DKGStreamHandler,
  type ProtocolRouter,
} from '@origintrail-official/dkg-core';
import { MessageHandler, ed25519ToX25519Private, type ChatHandler, type ChatAclCheck } from '../src/index.js';
import { Messenger } from '../src/p2p/messenger.js';

// Hand-rolled recorder: a plain function that records every call's
// arguments and delegates to `impl`. Replaces the vitest spy seams used
// by these tests (call counting + argument capture) with no behavior
// mocking — the code under test (MessageHandler) stays real.
function recorder<A extends unknown[], R>(impl: (...args: A) => R) {
  const calls: A[] = [];
  const fn = (...args: A): R => {
    calls.push(args);
    return impl(...args);
  };
  return Object.assign(fn, { calls });
}

// Swap a method on `obj` with a recorder over `impl`, exposing a
// `mockRestore`-style handle so callers can put the original back. Used
// for the console.warn capture (observe diagnostics without polluting
// test output).
function captureMethod<T, K extends keyof T>(
  obj: T,
  key: K,
  impl: T[K] extends (...args: infer A) => infer R ? (...args: A) => R : never,
) {
  const original = obj[key];
  const rec = recorder(impl as (...args: unknown[]) => unknown);
  obj[key] = rec as unknown as T[K];
  return Object.assign(rec, {
    mockRestore: () => {
      obj[key] = original;
    },
  });
}

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
  wireFromA: Uint8Array[];
}

async function buildPair(): Promise<TestPair> {
  const keyA = await generateEd25519Keypair();
  const keyB = await generateEd25519Keypair();
  const xA = ed25519ToX25519Private(keyA.secretKey);
  const xB = ed25519ToX25519Private(keyB.secretKey);

  // Build a pair of substrate-backed Messengers that route directly
  // through each other's handler maps. rc.9 PR-3 substrate
  // semantics — receiver-side dedup, ReliableEnvelope wrapping,
  // sender-side idempotency cache — are exercised end-to-end by
  // these tests because they cover the full chat round-trip.
  let aIncoming: DKGStreamHandler | null = null;
  let bIncoming: DKGStreamHandler | null = null;
  const wireFromA: Uint8Array[] = [];

  const routerA: ProtocolRouter = {
    register: (_proto: string, handler: DKGStreamHandler) => {
      aIncoming = handler;
    },
    send: async (_to: string, _proto: string, data: Uint8Array) => {
      if (!bIncoming) throw new Error('bIncoming not registered');
      wireFromA.push(Uint8Array.from(data));
      return await bIncoming(data, { toString: () => PEER_A });
    },
  } as unknown as ProtocolRouter;

  const routerB: ProtocolRouter = {
    register: (_proto: string, handler: DKGStreamHandler) => {
      bIncoming = handler;
    },
    send: async (_to: string, _proto: string, data: Uint8Array) => {
      if (!aIncoming) throw new Error('aIncoming not registered');
      return await aIncoming(data, { toString: () => PEER_B });
    },
  } as unknown as ProtocolRouter;

  const messengerA = new Messenger({
    router: routerA,
    idempotencyStore: new InMemoryMessageIdempotencyStore(),
    outboxStore: new InMemoryProtocolOutboxStore(),
  });
  const messengerB = new Messenger({
    router: routerB,
    idempotencyStore: new InMemoryMessageIdempotencyStore(),
    outboxStore: new InMemoryProtocolOutboxStore(),
  });

  const a = new MessageHandler(messengerA, keyA, xA, PEER_A, makeEventBus());
  const b = new MessageHandler(messengerB, keyB, xB, PEER_B, makeEventBus());

  a.registerPeerKey(PEER_B, keyB.publicKey);
  b.registerPeerKey(PEER_A, keyA.publicKey);

  if (!aIncoming || !bIncoming) {
    throw new Error('handlers not captured');
  }
  return { a, b, keyA, keyB, aIncoming, bIncoming, wireFromA };
}

function tamperLastMessage(
  pair: TestPair,
  mutate: (message: ReturnType<typeof decodeAgentMessage>) => void,
  messageId: string,
): Promise<Uint8Array> {
  const wire = pair.wireFromA.at(-1);
  if (!wire) throw new Error('no captured message from peer A');
  const envelope = decodeReliableEnvelope(wire);
  const message = decodeAgentMessage(envelope.payload);
  mutate(message);
  return pair.bIncoming(
    encodeReliableEnvelope({
      ...envelope,
      messageId,
      payload: encodeAgentMessage(message),
    }),
    { toString: () => PEER_A },
  );
}

describe('MessageHandler — chat ACL + contextGraphId plumbing', () => {
  it('contextGraphId rides the encrypted payload and reaches the chat handler', async () => {
    const { a, b } = await buildPair();

    const chatHandler = recorder<Parameters<ChatHandler>, void>(() => undefined);
    b.onChat(chatHandler);

    const result = await a.sendChat(PEER_B, 'hello from A', {
      contextGraphId: 'cg-debug',
    });

    expect(result.delivered).toBe(true);
    expect(result.error).toBeUndefined();

    expect(chatHandler.calls).toHaveLength(1);
    const [text, sender, _convId, senderContextGraphId] = chatHandler.calls[0];
    expect(text).toBe('hello from A');
    expect(sender).toBe(PEER_A);
    expect(senderContextGraphId).toBe('cg-debug');
  });

  it('omits contextGraphId when sender did not provide one', async () => {
    const { a, b } = await buildPair();
    const chatHandler = recorder<Parameters<ChatHandler>, void>(() => undefined);
    b.onChat(chatHandler);

    await a.sendChat(PEER_B, 'no cg');

    const [, , , senderContextGraphId] = chatHandler.calls[0];
    expect(senderContextGraphId).toBeUndefined();
  });

  it('ACL accept → chat handler is invoked', async () => {
    const { a, b } = await buildPair();
    const acl = recorder<Parameters<ChatAclCheck>, ReturnType<ChatAclCheck>>((sender, payload) => {
      expect(sender).toBe(PEER_A);
      expect(payload.contextGraphId).toBe('cg-ok');
      expect(payload.textBytes).toBe(new TextEncoder().encode('allowed').byteLength);
      return { accept: true };
    });
    b.setChatAcl(acl);

    const chatHandler = recorder<Parameters<ChatHandler>, void>(() => undefined);
    b.onChat(chatHandler);

    const result = await a.sendChat(PEER_B, 'allowed', { contextGraphId: 'cg-ok' });

    expect(result.delivered).toBe(true);
    expect(acl.calls).toHaveLength(1);
    expect(chatHandler.calls).toHaveLength(1);
  });

  it('ACL reject → unauthorized response reaches sender, chat handler is NOT invoked', async () => {
    const { a, b } = await buildPair();
    b.setChatAcl(() => ({ accept: false, reason: 'unauthorized: nope' }));

    const chatHandler = recorder<Parameters<ChatHandler>, void>(() => undefined);
    b.onChat(chatHandler);

    const result = await a.sendChat(PEER_B, 'rejected');

    expect(result.delivered).toBe(false);
    expect(result.error).toBe('unauthorized: nope');
    expect(chatHandler.calls).toEqual([]);
  });

  it('ACL reject falls back to default "unauthorized" reason when none provided', async () => {
    const { a, b } = await buildPair();
    b.setChatAcl(() => ({ accept: false }));
    const chatHandler = recorder<Parameters<ChatHandler>, void>(() => undefined);
    b.onChat(chatHandler);

    const result = await a.sendChat(PEER_B, 'no-reason');

    expect(result.delivered).toBe(false);
    expect(result.error).toBe('unauthorized');
    expect(chatHandler.calls).toEqual([]);
  });

  it('setChatAcl(null) restores accept-all behaviour', async () => {
    const { a, b } = await buildPair();
    b.setChatAcl(() => ({ accept: false, reason: 'blocked' }));
    b.setChatAcl(null);

    const chatHandler = recorder<Parameters<ChatHandler>, void>(() => undefined);
    b.onChat(chatHandler);

    const result = await a.sendChat(PEER_B, 'should-pass');
    expect(result.delivered).toBe(true);
    expect(chatHandler.calls).toHaveLength(1);
  });

  it('backwards compat — legacy 3-arg ChatHandler still works', async () => {
    const { a, b } = await buildPair();
    // Pretend a legacy handler that only knows about 3 args. JS will
    // silently drop the 4th positional arg — verify nothing breaks.
    const legacyHandler = recorder<Parameters<ChatHandler>, void>(((
      text: string,
      _senderPeerId: string,
      _convId: string,
    ) => {
      expect(text).toBe('legacy');
    }) as ChatHandler);
    b.onChat(legacyHandler);

    const result = await a.sendChat(PEER_B, 'legacy', { contextGraphId: 'cg-x' });
    expect(result.delivered).toBe(true);
    expect(legacyHandler.calls).toHaveLength(1);
  });

  // Codex PR #510 round 4 — a throwing ACL callback must NOT bubble
  // out as a transport-layer failure (the sender would interpret it
  // as a network issue and retry). The handler now catches and
  // surfaces a clean `unauthorized` so the sender's ACL-aware error
  // path kicks in.
  it('ACL throw → handler catches and fails closed with "unauthorized" reason', async () => {
    const { a, b } = await buildPair();
    // Silence console.warn so the deliberate throw doesn't pollute
    // the test output (hand-rolled capture over console.warn).
    const warnSpy = captureMethod(console, 'warn', () => {});
    try {
      b.setChatAcl(() => {
        throw new Error('db unavailable');
      });
      const chatHandler = recorder<Parameters<ChatHandler>, void>(() => undefined);
      b.onChat(chatHandler);

      const result = await a.sendChat(PEER_B, 'should-reject-on-throw');

      expect(result.delivered).toBe(false);
      expect(result.error).toMatch(/unauthorized: ACL evaluation error/);
      // Critically: chat handler must NOT run when ACL evaluation
      // failed — fail-closed semantics.
      expect(chatHandler.calls).toEqual([]);
      // Diagnostics should land on console.warn so operators can see
      // why ACL is suddenly rejecting everything.
      expect(warnSpy.calls).toContainEqual([
        expect.stringContaining('chat ACL threw, failing closed: db unavailable'),
      ]);
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
    const acl = recorder<Parameters<ChatAclCheck>, ReturnType<ChatAclCheck>>(() => ({ accept: true }));
    b.setChatAcl(acl);
    b.onChat(() => {});

    await a.sendChat(PEER_B, 'm1');
    await a.sendChat(PEER_B, 'm2');
    await a.sendChat(PEER_B, 'm3');

    expect(acl.calls).toHaveLength(3);
  });

  it('rejects an envelope whose claimed sender or recipient disagrees with transport state', async () => {
    const pair = await buildPair();
    pair.b.setChatAcl(() => ({ accept: true }));
    pair.b.onChat(() => {});
    await pair.a.sendChat(PEER_B, 'capture a valid signed message');

    await expect(tamperLastMessage(
      pair,
      (message) => { message.senderPeerId = PEER_B; },
      '00000000-0000-4000-8000-000000000001',
    )).rejects.toThrow(/senderPeerId does not match authenticated transport peer/);

    await expect(tamperLastMessage(
      pair,
      (message) => { message.recipientPeerId = PEER_A; },
      '00000000-0000-4000-8000-000000000002',
    )).rejects.toThrow(/recipientPeerId does not match this node/);
  });

  it('rejects malformed or forged signing material before consulting the chat ACL', async () => {
    const pair = await buildPair();
    const acl = recorder<Parameters<ChatAclCheck>, ReturnType<ChatAclCheck>>(() => ({
      accept: true,
    }));
    pair.b.setChatAcl(acl);
    pair.b.onChat(() => {});
    await pair.a.sendChat(PEER_B, 'capture a valid signed message');
    expect(acl.calls).toHaveLength(1);

    await expect(tamperLastMessage(
      pair,
      (message) => { message.senderPublicKey = new Uint8Array(); },
      '00000000-0000-4000-8000-000000000003',
    )).rejects.toThrow(/missing a valid sender public key/);

    await expect(tamperLastMessage(
      pair,
      (message) => { message.senderSignature = new Uint8Array(); },
      '00000000-0000-4000-8000-000000000004',
    )).rejects.toThrow(/missing a valid sender signature/);

    await expect(tamperLastMessage(
      pair,
      (message) => {
        message.senderSignature = Uint8Array.from(message.senderSignature);
        message.senderSignature[0] ^= 0xff;
      },
      '00000000-0000-4000-8000-000000000005',
    )).rejects.toThrow(/Invalid message signature/);

    expect(acl.calls).toHaveLength(1);
  });
});

// GH #462 — skill_request authorization (parallel to the chat ACL above).
// PROTOCOL_MESSAGE authenticates the caller's peerId via Ed25519 but did no
// authorization: any connected peer could invoke any registered skill. The
// MessageHandler-level hook is accept-all when unset (library back-compat);
// the DAEMON installs the default-deny policy (lifecycle.ts, buildSkillAcl).
describe('MessageHandler — skill_request ACL (GH #462)', () => {
  const SKILL = 'did:dkg:skill:test/echo';

  function echoSkill() {
    return vi.fn(async (req: { inputData: Uint8Array }) => ({
      success: true,
      outputData: req.inputData,
    }));
  }

  it('no ACL installed → skill executes (library-level back-compat)', async () => {
    const { a, b } = await buildPair();
    const handler = echoSkill();
    b.registerSkill(SKILL, handler as never);

    const res = await a.sendSkillRequest(PEER_B, { skillUri: SKILL, inputData: new TextEncoder().encode('hi') });
    expect(res.success).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('ACL reject → unauthorized response, skill handler NOT invoked', async () => {
    const { a, b } = await buildPair();
    const handler = echoSkill();
    b.registerSkill(SKILL, handler as never);
    b.setSkillAcl(() => ({ accept: false, reason: 'unauthorized: default-deny (GH #462)' }));

    const res = await a.sendSkillRequest(PEER_B, { skillUri: SKILL, inputData: new Uint8Array([1]) });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/unauthorized/);
    expect(handler).not.toHaveBeenCalled();
  });

  it('ACL accept for the sender → skill executes', async () => {
    const { a, b } = await buildPair();
    const handler = echoSkill();
    b.registerSkill(SKILL, handler as never);
    const acl = vi.fn((senderPeerId: string) => ({ accept: senderPeerId === PEER_A }));
    b.setSkillAcl(acl);

    const res = await a.sendSkillRequest(PEER_B, { skillUri: SKILL, inputData: new Uint8Array([2]) });
    expect(res.success).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(acl).toHaveBeenCalledWith(PEER_A, SKILL);
  });

  it('ACL throw → fails closed with unauthorized, handler NOT invoked', async () => {
    const { a, b } = await buildPair();
    const handler = echoSkill();
    b.registerSkill(SKILL, handler as never);
    b.setSkillAcl(() => { throw new Error('boom'); });

    const res = await a.sendSkillRequest(PEER_B, { skillUri: SKILL, inputData: new Uint8Array([3]) });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/unauthorized/);
    expect(handler).not.toHaveBeenCalled();
  });

  it('ACL denial happens BEFORE unknown-skill resolution (no skill-existence oracle)', async () => {
    const { a, b } = await buildPair();
    b.setSkillAcl(() => ({ accept: false, reason: 'unauthorized: default-deny (GH #462)' }));

    // Unauthorized caller probing an unregistered skill must see the SAME
    // unauthorized error, not "Unknown skill: …" (which would leak the
    // registered-skill namespace to unauthenticated peers).
    const res = await a.sendSkillRequest(PEER_B, { skillUri: 'did:dkg:skill:test/none', inputData: new Uint8Array() });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/unauthorized/);
    expect(res.error).not.toMatch(/Unknown skill/);
  });

  it('setSkillAcl(null) restores accept-all behaviour', async () => {
    const { a, b } = await buildPair();
    const handler = echoSkill();
    b.registerSkill(SKILL, handler as never);
    b.setSkillAcl(() => ({ accept: false }));
    b.setSkillAcl(null);

    const res = await a.sendSkillRequest(PEER_B, { skillUri: SKILL, inputData: new Uint8Array([4]) });
    expect(res.success).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
