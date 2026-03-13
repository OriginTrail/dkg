import type { StreamHandler, EventBus, Ed25519Keypair } from '@origintrail-official/dkg-core';
import {
  DKGEvent,
  PROTOCOL_MESSAGE,
  encodeAgentMessage,
  decodeAgentMessage,
  ed25519Sign,
  ed25519Verify,
  withRetry,
  type AgentMessageMsg,
} from '@origintrail-official/dkg-core';
import type { ProtocolRouter } from '@origintrail-official/dkg-core';
import { encrypt, decrypt, x25519SharedSecret, ed25519ToX25519Public } from './encryption.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';

function randomBytes(n: number): Uint8Array {
  const buf = new Uint8Array(n);
  globalThis.crypto.getRandomValues(buf);
  return buf;
}

export interface SkillRequest {
  skillUri: string;
  inputData: Uint8Array;
  paymentProof?: string;
  timeoutMs?: number;
  callback?: 'inline' | 'publish_ka' | 'stream';
}

export interface SkillResponse {
  success: boolean;
  outputData?: Uint8Array;
  resultUal?: string;
  error?: string;
  executionTimeMs?: number;
}

export type SkillHandler = (
  request: SkillRequest,
  senderPeerId: string,
) => Promise<SkillResponse>;

export type ChatHandler = (
  message: string,
  senderPeerId: string,
  conversationId: string,
) => void | Promise<void>;

interface ConversationState {
  highWaterMark: number;
  lastActivity: number;
  sharedSecret: Uint8Array;
}

const CONVERSATION_TTL = 60 * 60 * 1000; // 1 hour

/**
 * Manages encrypted agent-to-agent messaging over /dkg/message/1.0.0.
 *
 * Every message carries the sender's Ed25519 public key. Both sides derive
 * a shared secret via X25519 DH (Ed25519 keys converted to X25519) and
 * encrypt payloads with XChaCha20-Poly1305. Messages are signed with
 * Ed25519 and verified on receipt.
 */
export class MessageHandler {
  private readonly router: ProtocolRouter;
  private readonly keypair: Ed25519Keypair;
  private readonly x25519Private: Uint8Array;
  private readonly peerId: string;
  private readonly eventBus: EventBus;
  private readonly conversations = new Map<string, ConversationState>();
  private readonly skillHandlers = new Map<string, SkillHandler>();
  private readonly peerKeys = new Map<string, Uint8Array>();
  private chatHandler: ChatHandler | null = null;

  constructor(
    router: ProtocolRouter,
    keypair: Ed25519Keypair,
    x25519Private: Uint8Array,
    peerId: string,
    eventBus: EventBus,
  ) {
    this.router = router;
    this.keypair = keypair;
    this.x25519Private = x25519Private;
    this.peerId = peerId;
    this.eventBus = eventBus;

    router.register(PROTOCOL_MESSAGE, this.handleIncoming.bind(this));
  }

  registerSkill(skillUri: string, handler: SkillHandler): void {
    this.skillHandlers.set(skillUri, handler);
  }

  onChat(handler: ChatHandler): void {
    this.chatHandler = handler;
  }

  /**
   * Cache a peer's Ed25519 public key for use in outgoing messages.
   * Keys are also auto-cached from incoming messages.
   */
  registerPeerKey(peerId: string, ed25519Public: Uint8Array): void {
    this.peerKeys.set(peerId, ed25519Public);
  }

  async sendChat(
    recipientPeerId: string,
    text: string,
  ): Promise<{ delivered: boolean; error?: string }> {
    try {
      const conversationId = bytesToHex(randomBytes(16));

      const recipientKey = await this.resolvePeerKey(recipientPeerId);
      const sharedSecret = this.deriveSecret(recipientKey);

      this.conversations.set(conversationId, {
        highWaterMark: 0,
        lastActivity: Date.now(),
        sharedSecret,
      });

      const payload = new TextEncoder().encode(JSON.stringify({
        type: 'chat',
        text,
      }));

      const nonce = buildNonce(conversationId, 1);
      const ciphertext = encrypt(sharedSecret, payload, nonce).ciphertext;

      const sigData = buildSignatureInput(conversationId, 1, ciphertext);
      const signature = await ed25519Sign(sigData, this.keypair.secretKey);

      const msg: AgentMessageMsg = {
        conversationId,
        sequence: 1,
        senderPeerId: this.peerId,
        recipientPeerId,
        encryptedPayload: ciphertext,
        nonce,
        senderSignature: signature,
        senderPublicKey: this.keypair.publicKey,
      };

      const responseBytes = await withRetry(
        () => this.router.send(recipientPeerId, PROTOCOL_MESSAGE, encodeAgentMessage(msg)),
        {
          maxAttempts: 3,
          baseDelayMs: 500,
          onRetry: (attempt, delay) => {
            console.warn(`[Messaging] sendChat retry ${attempt}/3 to ${recipientPeerId.slice(-8)} (delay ${Math.round(delay)}ms)`);
          },
        },
      );
      const responseMsg = decodeAgentMessage(responseBytes);
      const plain = new TextDecoder().decode(
        decrypt(sharedSecret, responseMsg.encryptedPayload, responseMsg.nonce),
      );
      const parsed = JSON.parse(plain);
      return { delivered: parsed.success !== false, error: parsed.error };
    } catch (err) {
      return { delivered: false, error: err instanceof Error ? err.message : 'Send failed' };
    }
  }

  async sendSkillRequest(
    recipientPeerId: string,
    request: SkillRequest,
  ): Promise<SkillResponse> {
    const conversationId = bytesToHex(randomBytes(16));

    const recipientKey = await this.resolvePeerKey(recipientPeerId);
    const sharedSecret = this.deriveSecret(recipientKey);

    this.conversations.set(conversationId, {
      highWaterMark: 0,
      lastActivity: Date.now(),
      sharedSecret,
    });

    const payload = new TextEncoder().encode(JSON.stringify({
      type: 'skill_request',
      ...request,
      inputData: Array.from(request.inputData),
    }));

    const nonce = buildNonce(conversationId, 1);
    const { ciphertext } = encrypt(sharedSecret, payload, nonce);
    const sigData = buildSignatureInput(conversationId, 1, ciphertext);
    const signature = await ed25519Sign(sigData, this.keypair.secretKey);

    const msg: AgentMessageMsg = {
      conversationId,
      sequence: 1,
      senderPeerId: this.peerId,
      recipientPeerId,
      encryptedPayload: ciphertext,
      nonce,
      senderSignature: signature,
      senderPublicKey: this.keypair.publicKey,
    };

    const responseBytes = await withRetry(
      () => this.router.send(recipientPeerId, PROTOCOL_MESSAGE, encodeAgentMessage(msg)),
      {
        maxAttempts: 3,
        baseDelayMs: 500,
        onRetry: (attempt, delay) => {
          console.warn(`[Messaging] sendSkillRequest retry ${attempt}/3 to ${recipientPeerId.slice(-8)} (delay ${Math.round(delay)}ms)`);
        },
      },
    );

    const responseMsg = decodeAgentMessage(responseBytes);
    const responsePlain = decrypt(
      sharedSecret,
      responseMsg.encryptedPayload,
      responseMsg.nonce,
    );

    const parsed = JSON.parse(new TextDecoder().decode(responsePlain));
    return {
      success: parsed.success,
      outputData: parsed.outputData ? new Uint8Array(parsed.outputData) : undefined,
      resultUal: parsed.resultUal,
      error: parsed.error,
      executionTimeMs: parsed.executionTimeMs,
    };
  }

  private async handleIncoming(data: Uint8Array, fromPeerId: { toString(): string }): Promise<Uint8Array> {
    const msg = decodeAgentMessage(data);
    const convId = msg.conversationId;
    const seq = typeof msg.sequence === 'number' ? msg.sequence : msg.sequence.low;

    // Cache sender's public key from the message
    const senderKey = msg.senderPublicKey?.length === 32
      ? msg.senderPublicKey
      : this.peerKeys.get(msg.senderPeerId);

    if (senderKey) {
      this.peerKeys.set(msg.senderPeerId, senderKey);
    }

    // Derive shared secret from sender's public key
    const sharedSecret = senderKey
      ? this.deriveSecret(senderKey)
      : new Uint8Array(32); // backward compat with pre-encryption messages

    let conv = this.conversations.get(convId);
    if (!conv) {
      conv = {
        highWaterMark: 0,
        lastActivity: Date.now(),
        sharedSecret,
      };
      this.conversations.set(convId, conv);
    }

    if (seq <= conv.highWaterMark) {
      return this.encryptAndSign(conv.sharedSecret, convId, seq + 1, {
        success: false,
        error: 'Replay detected',
      });
    }
    conv.highWaterMark = seq;
    conv.lastActivity = Date.now();

    // Verify sender's signature
    if (senderKey && msg.senderSignature.length === 64) {
      const sigData = buildSignatureInput(convId, seq, msg.encryptedPayload);
      const valid = await ed25519Verify(msg.senderSignature, sigData, senderKey);
      if (!valid) {
        return this.encryptAndSign(conv.sharedSecret, convId, seq + 1, {
          success: false,
          error: 'Invalid signature',
        });
      }
    }

    // Decrypt payload
    let plaintext: string;
    try {
      const decrypted = decrypt(conv.sharedSecret, msg.encryptedPayload, msg.nonce);
      plaintext = new TextDecoder().decode(decrypted);
    } catch {
      return this.encryptAndSign(conv.sharedSecret, convId, seq + 1, {
        success: false,
        error: 'Decryption failed',
      });
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(plaintext);
    } catch {
      return this.encryptAndSign(conv.sharedSecret, convId, seq + 1, {
        success: false,
        error: 'Invalid message format',
      });
    }

    this.eventBus.emit(DKGEvent.MESSAGE_RECEIVED, {
      conversationId: convId,
      from: fromPeerId.toString(),
      type: parsed.type,
    });

    if (parsed.type === 'skill_request') {
      const skillUri = parsed.skillUri as string;
      const handler = this.skillHandlers.get(skillUri);

      if (!handler) {
        return this.encryptAndSign(conv.sharedSecret, convId, seq + 1, {
          success: false,
          error: `Unknown skill: ${skillUri}`,
        });
      }

      const startTime = Date.now();
      const request: SkillRequest = {
        skillUri,
        inputData: new Uint8Array(parsed.inputData as number[]),
        paymentProof: parsed.paymentProof as string | undefined,
        timeoutMs: parsed.timeoutMs as number | undefined,
        callback: parsed.callback as SkillRequest['callback'],
      };

      try {
        const response = await handler(request, fromPeerId.toString());
        response.executionTimeMs = Date.now() - startTime;
        return this.encryptAndSign(conv.sharedSecret, convId, seq + 1, response);
      } catch (err) {
        return this.encryptAndSign(conv.sharedSecret, convId, seq + 1, {
          success: false,
          error: err instanceof Error ? err.message : 'Skill execution failed',
          executionTimeMs: Date.now() - startTime,
        });
      }
    }

    if (parsed.type === 'chat') {
      const text = (parsed.text as string) ?? '';
      if (this.chatHandler) {
        try {
          await this.chatHandler(text, fromPeerId.toString(), convId);
        } catch (err) {
          console.error(`[Messaging] chat handler error:`, err instanceof Error ? err.message : err);
        }
      }
      return this.encryptAndSign(conv.sharedSecret, convId, seq + 1, {
        success: true,
      });
    }

    return this.encryptAndSign(conv.sharedSecret, convId, seq + 1, {
      success: false,
      error: `Unknown message type: ${parsed.type}`,
    });
  }

  private async encryptAndSign(
    sharedSecret: Uint8Array,
    conversationId: string,
    sequence: number,
    response: SkillResponse,
  ): Promise<Uint8Array> {
    const payload = new TextEncoder().encode(JSON.stringify({
      ...response,
      outputData: response.outputData ? Array.from(response.outputData) : undefined,
    }));

    const nonce = buildNonce(conversationId, sequence);
    const ciphertext = encrypt(sharedSecret, payload, nonce).ciphertext;

    const sigData = buildSignatureInput(conversationId, sequence, ciphertext);
    const signature = await ed25519Sign(sigData, this.keypair.secretKey);

    return encodeAgentMessage({
      conversationId,
      sequence,
      senderPeerId: this.peerId,
      recipientPeerId: '',
      encryptedPayload: ciphertext,
      nonce,
      senderSignature: signature,
      senderPublicKey: this.keypair.publicKey,
    });
  }

  /**
   * Resolve a peer's Ed25519 public key. Checks the local cache first,
   * then extracts the key from the libp2p PeerId (which encodes the
   * Ed25519 public key in its identity multihash).
   */
  private async resolvePeerKey(peerId: string): Promise<Uint8Array> {
    const cached = this.peerKeys.get(peerId);
    if (cached) return cached;

    const key = await ed25519KeyFromPeerId(peerId);
    this.peerKeys.set(peerId, key);
    return key;
  }

  /**
   * Derive a shared secret from our X25519 private key and a peer's
   * Ed25519 public key (converted to X25519).
   */
  private deriveSecret(theirEd25519Public: Uint8Array): Uint8Array {
    const theirX25519 = ed25519ToX25519Public(theirEd25519Public);
    return deriveSharedSecret(this.x25519Private, theirX25519);
  }

  cleanExpiredConversations(): number {
    const now = Date.now();
    let cleaned = 0;
    for (const [id, conv] of this.conversations) {
      if (now - conv.lastActivity > CONVERSATION_TTL) {
        this.conversations.delete(id);
        cleaned++;
      }
    }
    return cleaned;
  }

  get activeConversations(): number {
    return this.conversations.size;
  }
}

function deriveSharedSecret(ourPrivate: Uint8Array, theirPublic: Uint8Array): Uint8Array {
  const raw = x25519SharedSecret(ourPrivate, theirPublic);
  return sha256(raw);
}

function buildNonce(conversationId: string, sequence: number): Uint8Array {
  const data = new TextEncoder().encode(`${conversationId}:${sequence}`);
  return sha256(data).slice(0, 24);
}

function buildSignatureInput(conversationId: string, sequence: number, ciphertext: Uint8Array): Uint8Array {
  const prefix = new TextEncoder().encode(`${conversationId}:${sequence}:`);
  const combined = new Uint8Array(prefix.length + ciphertext.length);
  combined.set(prefix);
  combined.set(ciphertext, prefix.length);
  return combined;
}

/**
 * Extract the raw 32-byte Ed25519 public key from a libp2p PeerId string.
 *
 * Ed25519 PeerIds use CIDv1 with an identity multihash whose digest is
 * a protobuf-encoded PublicKey: [0x08, 0x01 (Ed25519), 0x12, 0x20, ...32 bytes].
 */
async function ed25519KeyFromPeerId(peerIdStr: string): Promise<Uint8Array> {
  const { peerIdFromString } = await import('@libp2p/peer-id');
  const peerId = peerIdFromString(peerIdStr);
  const digest = peerId.toMultihash().digest;
  return parseEd25519FromProtobuf(digest);
}

function parseEd25519FromProtobuf(proto: Uint8Array): Uint8Array {
  let offset = 0;

  while (offset < proto.length) {
    const tag = proto[offset++];
    const fieldNumber = tag >> 3;
    const wireType = tag & 0x07;

    if (wireType === 0) {
      // Varint — skip it
      while (offset < proto.length && (proto[offset] & 0x80)) offset++;
      offset++;
      continue;
    }

    if (wireType === 2) {
      // Length-delimited — read length, then bytes
      let len = 0;
      let shift = 0;
      while (offset < proto.length) {
        const b = proto[offset++];
        len |= (b & 0x7f) << shift;
        if (!(b & 0x80)) break;
        shift += 7;
      }

      if (fieldNumber === 2) {
        return proto.slice(offset, offset + len);
      }
      offset += len;
      continue;
    }

    throw new Error('Unexpected wire type in PeerId protobuf');
  }

  throw new Error('Ed25519 public key not found in PeerId');
}
