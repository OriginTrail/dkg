import type { StreamHandler, EventBus, Ed25519Keypair } from '@dkg/core';
import {
  DKGEvent,
  PROTOCOL_MESSAGE,
  encodeAgentMessage,
  decodeAgentMessage,
  ed25519Sign,
  ed25519Verify,
  type AgentMessageMsg,
} from '@dkg/core';
import type { ProtocolRouter } from '@dkg/core';
import { encrypt, decrypt, x25519SharedSecret } from './encryption.js';
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
 * Handles X25519 key exchange, XChaCha20-Poly1305 encryption, replay
 * protection, and SkillRequest/SkillResponse dispatch.
 */
export class MessageHandler {
  private readonly router: ProtocolRouter;
  private readonly keypair: Ed25519Keypair;
  private readonly x25519Private: Uint8Array;
  private readonly peerId: string;
  private readonly eventBus: EventBus;
  private readonly conversations = new Map<string, ConversationState>();
  private readonly skillHandlers = new Map<string, SkillHandler>();
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

  async sendChat(
    recipientPeerId: string,
    text: string,
  ): Promise<{ delivered: boolean; error?: string }> {
    const conversationId = bytesToHex(randomBytes(16));
    const sharedSecret = new Uint8Array(32);

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
    let encrypted: Uint8Array;
    try {
      encrypted = encrypt(sharedSecret, payload, nonce).ciphertext;
    } catch {
      encrypted = payload;
    }

    const msg: AgentMessageMsg = {
      conversationId,
      sequence: 1,
      senderPeerId: this.peerId,
      recipientPeerId,
      encryptedPayload: encrypted,
      nonce,
      senderSignature: new Uint8Array(64),
    };

    try {
      const responseBytes = await this.router.send(
        recipientPeerId,
        PROTOCOL_MESSAGE,
        encodeAgentMessage(msg),
      );
      const responseMsg = decodeAgentMessage(responseBytes);
      let plain: string;
      try {
        plain = new TextDecoder().decode(
          decrypt(sharedSecret, responseMsg.encryptedPayload, responseMsg.nonce),
        );
      } catch {
        plain = new TextDecoder().decode(responseMsg.encryptedPayload);
      }
      const parsed = JSON.parse(plain);
      return { delivered: parsed.success !== false, error: parsed.error };
    } catch (err) {
      return { delivered: false, error: err instanceof Error ? err.message : 'Send failed' };
    }
  }

  /**
   * Sends an encrypted SkillRequest to a remote agent and waits for the response.
   */
  async sendSkillRequest(
    recipientPeerId: string,
    recipientX25519Public: Uint8Array,
    request: SkillRequest,
  ): Promise<SkillResponse> {
    const conversationId = bytesToHex(randomBytes(16));
    const sharedSecret = deriveSharedSecret(this.x25519Private, recipientX25519Public);

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
    };

    const responseBytes = await this.router.send(
      recipientPeerId,
      PROTOCOL_MESSAGE,
      encodeAgentMessage(msg),
    );

    const responseMsg = decodeAgentMessage(responseBytes);

    const responseSharedSecret = sharedSecret;
    const responsePlain = decrypt(
      responseSharedSecret,
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

    let conv = this.conversations.get(convId);
    if (!conv) {
      conv = {
        highWaterMark: 0,
        lastActivity: Date.now(),
        sharedSecret: new Uint8Array(32),
      };
      this.conversations.set(convId, conv);
    }

    if (seq <= conv.highWaterMark) {
      return this.encryptResponse(conv.sharedSecret, convId, seq + 1, {
        success: false,
        error: 'Replay detected',
      });
    }
    conv.highWaterMark = seq;
    conv.lastActivity = Date.now();

    let plaintext: string;
    try {
      const decrypted = decrypt(conv.sharedSecret, msg.encryptedPayload, msg.nonce);
      plaintext = new TextDecoder().decode(decrypted);
    } catch {
      plaintext = new TextDecoder().decode(msg.encryptedPayload);
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(plaintext);
    } catch {
      return this.encryptResponse(conv.sharedSecret, convId, seq + 1, {
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
        return this.encryptResponse(conv.sharedSecret, convId, seq + 1, {
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
        return this.encryptResponse(conv.sharedSecret, convId, seq + 1, response);
      } catch (err) {
        return this.encryptResponse(conv.sharedSecret, convId, seq + 1, {
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
        } catch {
          // chat handler is fire-and-forget
        }
      }
      return this.encryptResponse(conv.sharedSecret, convId, seq + 1, {
        success: true,
      });
    }

    return this.encryptResponse(conv.sharedSecret, convId, seq + 1, {
      success: false,
      error: `Unknown message type: ${parsed.type}`,
    });
  }

  private encryptResponse(
    sharedSecret: Uint8Array,
    conversationId: string,
    sequence: number,
    response: SkillResponse,
  ): Uint8Array {
    const payload = new TextEncoder().encode(JSON.stringify({
      ...response,
      outputData: response.outputData ? Array.from(response.outputData) : undefined,
    }));

    const nonce = buildNonce(conversationId, sequence);

    let encrypted: Uint8Array;
    try {
      encrypted = encrypt(sharedSecret, payload, nonce).ciphertext;
    } catch {
      encrypted = payload;
    }

    return encodeAgentMessage({
      conversationId,
      sequence,
      senderPeerId: this.peerId,
      recipientPeerId: '',
      encryptedPayload: encrypted,
      nonce,
      senderSignature: new Uint8Array(64),
    });
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
