// MessageHandler keeps a peer's key as the connection authenticated it, and
// bounds what it remembers of inbound conversations.
//
// Set-up: MessageHandlers wired through real Messengers whose routers deliver
// in-process, each handler call carrying the sending node's transport peer id,
// as a libp2p connection does. Peer ids here are opaque routing tokens with
// keys registered through registerPeerKey(), except where a test uses real
// Ed25519 peer ids.

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  generateEd25519Keypair,
  decodeReliableEnvelope,
  encodeReliableEnvelope,
  decodeAgentMessage,
  encodeAgentMessage,
  ed25519Sign,
  InMemoryMessageIdempotencyStore,
  InMemoryProtocolOutboxStore,
  RELIABLE_ENVELOPE_VERSION,
  type Ed25519Keypair,
  type StreamHandler,
  type EventBus,
  type ProtocolRouter,
} from '@origintrail-official/dkg-core';
import { sha256 } from '@noble/hashes/sha2.js';
import {
  MessageHandler, decrypt, ed25519ToX25519Private, ed25519ToX25519Public, encrypt, x25519SharedSecret,
} from '../src/index.js';
import type { MessageHandlerLimits } from '../src/messaging.js';
import { Messenger } from '../src/p2p/messenger.js';

const PEER_A = '12D3KooWAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const PEER_B = '12D3KooWBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const PEER_C = '12D3KooWCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';

const bus = (): EventBus => ({ emit: () => {}, on: () => {}, off: () => {} });
/** The peer id a connection authenticated, as the router hands it to a handler. */
const transport = (peerId: string) => ({ toString: () => peerId, toBytes: () => new Uint8Array() });

/** In-process network: each node's router delivers to the recipient's handler under the sender's transport peer id. */
class Network {
  readonly incoming = new Map<string, StreamHandler>();
  /** Every wire payload a node sent, by sending transport peer id. */
  readonly sent: Array<{ from: string; to: string; data: Uint8Array }> = [];

  router(transportPeerId: string): ProtocolRouter {
    return {
      register: (_protocol: string, handler: StreamHandler) => {
        this.incoming.set(transportPeerId, handler);
      },
      send: async (to: string, _protocol: string, data: Uint8Array) => {
        const handler = this.incoming.get(to);
        if (!handler) throw new Error(`no node ${to}`);
        this.sent.push({ from: transportPeerId, to, data });
        return handler(data, transport(transportPeerId));
      },
    } as unknown as ProtocolRouter;
  }

  /**
   * A node on transport `transportPeerId` whose handler signs with `keypair`
   * and names `claimedPeerId` as its sender.
   */
  node(
    transportPeerId: string,
    keypair: Ed25519Keypair,
    options: { claimedPeerId?: string; limits?: MessageHandlerLimits } = {},
  ): MessageHandler {
    const messenger = new Messenger({
      router: this.router(transportPeerId),
      idempotencyStore: new InMemoryMessageIdempotencyStore(),
      outboxStore: new InMemoryProtocolOutboxStore(),
    });
    return new MessageHandler(
      messenger,
      keypair,
      ed25519ToX25519Private(keypair.secretKey),
      options.claimedPeerId ?? transportPeerId,
      bus(),
      options.limits,
    );
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('MessageHandler peer keys', () => {
  it('a message naming another peer as its sender does not change the key used for that peer', async () => {
    const keyA = await generateEd25519Keypair();
    const keyB = await generateEd25519Keypair();
    const keyC = await generateEd25519Keypair();
    const net = new Network();
    const a = net.node(PEER_A, keyA);
    const b = net.node(PEER_B, keyB);
    // C sends from its own connection, signs with its own key, and names A as the sender.
    const c = net.node(PEER_C, keyC, { claimedPeerId: PEER_A });
    a.registerPeerKey(PEER_B, keyB.publicKey);
    b.registerPeerKey(PEER_A, keyA.publicKey);
    b.registerPeerKey(PEER_C, keyC.publicKey);
    c.registerPeerKey(PEER_B, keyB.publicKey);
    const receivedByA: Array<{ text: string; from: string }> = [];
    a.onChat((text, from) => { receivedByA.push({ text, from }); });
    const receivedByB: string[] = [];
    b.onChat((_text, from) => { receivedByB.push(from); });

    await c.sendChat(PEER_B, 'from C, naming A');

    // B still encrypts to A's own key, so A reads B's next chat.
    await expect(b.sendChat(PEER_A, 'hello A')).resolves.toEqual({ delivered: true });
    expect(receivedByA).toEqual([{ text: 'hello A', from: PEER_B }]);
    // What B accepted from C, it accepted as C's.
    expect(receivedByB.every((from) => from === PEER_C)).toBe(true);
  });

  it('refuses a message whose key is not the key of the peer that sent it, and keeps no state for it', async () => {
    const keyB = await generateEd25519Keypair();
    const keyC = await generateEd25519Keypair();
    const otherKey = await generateEd25519Keypair();
    const net = new Network();
    const b = net.node(PEER_B, keyB);
    // Transport C, but the handler signs with and names a different key.
    const c = net.node(PEER_C, otherKey);
    b.registerPeerKey(PEER_C, keyC.publicKey);
    c.registerPeerKey(PEER_B, keyB.publicKey);
    const chat = vi.fn();
    b.onChat(chat);

    const result = await c.sendChat(PEER_B, 'signed with another key');

    expect(result.delivered).toBe(false);
    expect(chat).not.toHaveBeenCalled();
    expect(b.activeConversations).toBe(0);
  });

  it('reads the key of a real Ed25519 peer id from the id itself', async () => {
    const { publicKeyFromRaw } = await import('@libp2p/crypto/keys');
    const { peerIdFromPublicKey } = await import('@libp2p/peer-id');
    const keyFor = async () => {
      const keypair = await generateEd25519Keypair();
      return { peerId: peerIdFromPublicKey(publicKeyFromRaw(keypair.publicKey)).toString(), keypair };
    };
    const a = await keyFor();
    const b = await keyFor();
    const net = new Network();
    const nodeA = net.node(a.peerId, a.keypair);
    const nodeB = net.node(b.peerId, b.keypair);
    const chat = vi.fn();
    nodeB.onChat(chat);

    await expect(nodeA.sendChat(b.peerId, 'no registered keys')).resolves.toEqual({ delivered: true });
    expect(chat).toHaveBeenCalledWith('no registered keys', a.peerId, expect.any(String), undefined, undefined, undefined);
  });
});

describe('MessageHandler signatures and peer ids', () => {
  /** A message from A to B with `signature` over `plaintext`, and the reply B sends back, as A reads it. */
  async function deliverSigned(
    signature: (input: Uint8Array, keyA: Ed25519Keypair) => Promise<Uint8Array>,
    plaintext = '{"type":"chat","text":"hello"}',
  ) {
    const keyA = await generateEd25519Keypair();
    const keyB = await generateEd25519Keypair();
    const net = new Network();
    const b = net.node(PEER_B, keyB);
    b.registerPeerKey(PEER_A, keyA.publicKey);
    const chat = vi.fn();
    b.onChat(chat);
    const conversationId = 'cd'.repeat(16);
    const nonce = new Uint8Array(24).fill(3);
    const secret = sha256(x25519SharedSecret(ed25519ToX25519Private(keyA.secretKey), ed25519ToX25519Public(keyB.publicKey)));
    const { ciphertext } = encrypt(secret, new TextEncoder().encode(plaintext), nonce);
    const prefix = new TextEncoder().encode(`${conversationId}:1:`);
    const input = new Uint8Array(prefix.length + ciphertext.length);
    input.set(prefix);
    input.set(ciphertext, prefix.length);
    const message = encodeAgentMessage({
      conversationId, sequence: 1, senderPeerId: PEER_A, recipientPeerId: PEER_B, encryptedPayload: ciphertext, nonce,
      senderSignature: await signature(input, keyA), senderPublicKey: keyA.publicKey,
    });
    const replyBytes = await net.incoming.get(PEER_B)!(
      encodeReliableEnvelope({ messageId: 'signed-message', version: RELIABLE_ENVELOPE_VERSION, tsMs: Date.now(), payload: message }),
      transport(PEER_A),
    );
    const reply = decodeAgentMessage(replyBytes);
    const answer = JSON.parse(new TextDecoder().decode(decrypt(secret, reply.encryptedPayload, reply.nonce))) as { success: boolean; error?: string };
    return { answer, chat, b };
  }

  it('accepts a message its peer signed', async () => {
    const { answer, chat, b } = await deliverSigned((input, keyA) => ed25519Sign(input, keyA.secretKey));
    expect(answer).toEqual({ success: true });
    expect(chat).toHaveBeenCalledTimes(1);
    expect(b.activeConversations).toBe(1);
  });

  it.each([
    ['a signature that does not verify', async (input: Uint8Array, keyA: Ed25519Keypair) => {
      const signature = await ed25519Sign(input, keyA.secretKey);
      signature[0] ^= 1;
      return signature;
    }],
    ['no signature', async () => new Uint8Array(0)],
  ])('refuses a message with %s, and keeps no state for it', async (_name, signature) => {
    const { answer, chat, b } = await deliverSigned(signature);
    expect(answer).toEqual({ success: false, error: 'Invalid signature' });
    expect(chat).not.toHaveBeenCalled();
    expect(b.activeConversations).toBe(0);
  });

  it.each([
    ['is not JSON', 'not json', 'Invalid message format'],
    ['is of a type it does not know', '{"type":"poll"}', 'Unknown message type: poll'],
  ])('answers a signed message that %s with an error', async (_name, plaintext, error) => {
    const { answer, chat } = await deliverSigned((input, keyA) => ed25519Sign(input, keyA.secretKey), plaintext);
    expect(answer).toEqual({ success: false, error });
    expect(chat).not.toHaveBeenCalled();
  });

  it('refuses a message from a peer id that carries no Ed25519 key', async () => {
    const { generateKeyPair } = await import('@libp2p/crypto/keys');
    const { peerIdFromPrivateKey } = await import('@libp2p/peer-id');
    const secp256k1Peer = peerIdFromPrivateKey(await generateKeyPair('secp256k1')).toString();
    const keyB = await generateEd25519Keypair();
    const posingKey = await generateEd25519Keypair();
    const net = new Network();
    const b = net.node(PEER_B, keyB);
    const chat = vi.fn();
    b.onChat(chat);
    const message = encodeAgentMessage({
      conversationId: 'ef'.repeat(16), sequence: 1, senderPeerId: secp256k1Peer, recipientPeerId: PEER_B,
      encryptedPayload: new Uint8Array(16), nonce: new Uint8Array(24), senderSignature: new Uint8Array(64),
      senderPublicKey: posingKey.publicKey,
    });
    await expect(net.incoming.get(PEER_B)!(
      encodeReliableEnvelope({ messageId: 'secp256k1-peer', version: RELIABLE_ENVELOPE_VERSION, tsMs: Date.now(), payload: message }),
      transport(secp256k1Peer),
    )).rejects.toThrow('Peer ID does not carry an Ed25519 key');
    expect(chat).not.toHaveBeenCalled();
    expect(b.activeConversations).toBe(0);
  });
});

describe('MessageHandler conversation state', () => {
  async function pair(limits?: MessageHandlerLimits) {
    const keyA = await generateEd25519Keypair();
    const keyB = await generateEd25519Keypair();
    const net = new Network();
    const a = net.node(PEER_A, keyA);
    const b = net.node(PEER_B, keyB, { limits });
    a.registerPeerKey(PEER_B, keyB.publicKey);
    b.registerPeerKey(PEER_A, keyA.publicKey);
    b.onChat(() => {});
    return { a, b, net };
  }

  it('remembers at most the configured number of inbound conversations', async () => {
    const { a, b } = await pair({ maxConversations: 3 });
    for (let i = 0; i < 10; i++) {
      await expect(a.sendChat(PEER_B, `message ${i}`)).resolves.toEqual({ delivered: true });
    }
    expect(b.activeConversations).toBe(3);
    // The sending side keeps nothing per conversation it starts.
    expect(a.activeConversations).toBe(0);
  });

  it('forgets conversations idle for longer than the TTL', async () => {
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const { a, b } = await pair({ conversationTtlMs: 60_000 });
    await a.sendChat(PEER_B, 'first');
    await a.sendChat(PEER_B, 'second');
    expect(b.activeConversations).toBe(2);
    now += 61_000;
    await a.sendChat(PEER_B, 'third');
    expect(b.activeConversations).toBe(1);
  });

  it('keeps no state for a message it cannot decrypt', async () => {
    const keyA = await generateEd25519Keypair();
    const keyB = await generateEd25519Keypair();
    const net = new Network();
    const b = net.node(PEER_B, keyB);
    b.registerPeerKey(PEER_A, keyA.publicKey);
    const chat = vi.fn();
    b.onChat(chat);
    const a = net.node(PEER_A, keyA);
    a.registerPeerKey(PEER_B, keyB.publicKey);
    // One delivered chat gives the shape of a real message.
    await expect(a.sendChat(PEER_B, 'delivered')).resolves.toEqual({ delivered: true });
    const message = decodeAgentMessage(decodeReliableEnvelope(net.sent.at(-1)!.data).payload);
    expect(b.activeConversations).toBe(1);

    // A's own signature, over a ciphertext under a key B does not share with A.
    const conversationId = 'ab'.repeat(16);
    const nonce = message.nonce;
    const ciphertext = encrypt(new Uint8Array(32).fill(7), new TextEncoder().encode('{"type":"chat","text":"x"}'), nonce).ciphertext;
    const signed = new TextEncoder().encode(`${conversationId}:1:`);
    const input = new Uint8Array(signed.length + ciphertext.length);
    input.set(signed);
    input.set(ciphertext, signed.length);
    const forged = encodeAgentMessage({
      ...message,
      conversationId,
      sequence: 1,
      encryptedPayload: ciphertext,
      senderSignature: await ed25519Sign(input, keyA.secretKey),
    });
    await net.incoming.get(PEER_B)!(
      encodeReliableEnvelope({ messageId: 'undecryptable', version: RELIABLE_ENVELOPE_VERSION, tsMs: Date.now(), payload: forged }),
      transport(PEER_A),
    );
    expect(chat).toHaveBeenCalledTimes(1);
    expect(b.activeConversations).toBe(1);
  });

  it('still refuses a message replayed under a new envelope', async () => {
    const { a, b, net } = await pair();
    const chat = vi.fn();
    b.onChat(chat);
    await expect(a.sendChat(PEER_B, 'once')).resolves.toEqual({ delivered: true });
    const { data } = net.sent.at(-1)!;
    const envelope = decodeReliableEnvelope(data);

    // The same message bytes, under a message id the messenger has not seen.
    const replay = encodeReliableEnvelope({ ...envelope, messageId: `${envelope.messageId}-again` });
    await net.incoming.get(PEER_B)!(replay, transport(PEER_A));

    expect(chat).toHaveBeenCalledTimes(1);
    expect(b.activeConversations).toBe(1);
  });
});
