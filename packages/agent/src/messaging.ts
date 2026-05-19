import type { EventBus, Ed25519Keypair } from '@origintrail-official/dkg-core';
import {
  DKGEvent,
  PROTOCOL_MESSAGE,
  encodeAgentMessage,
  decodeAgentMessage,
  ed25519Sign,
  ed25519Verify,
  RESPONSE_GONE_MARKER,
  type AgentMessageMsg,
} from '@origintrail-official/dkg-core';
import type { Messenger } from './p2p/messenger.js';
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
  // Optional `contextGraphId` carried in the encrypted payload by the sender.
  // Receivers that scope chat to a specific CG can use this for ACL bookkeeping
  // and per-graph storage; legacy chat handlers that don't take this arg keep
  // working unchanged (extra positional args are silently ignored in JS).
  senderContextGraphId?: string,
  // Same value as `senderContextGraphId`, but ONLY set when the ACL has
  // positively verified the sender's CG claim (i.e. `scoped` mode where
  // the claim equals the receiver's configured CG, or `shared-context-graph`
  // mode where the claim matches a subscribed CG the sender is an active
  // member of). In `any` and `peer-allowlist` modes this is always
  // undefined because the ACL doesn't check the CG claim, so downstream
  // code that surfaces the CG to operators (notification titles, log
  // suffixes) can show it without risking an attacker-controlled label.
  // Codex PR #510 round 4/5 finding — `senderContextGraphId` alone is
  // an unverified attacker-controllable claim outside scoped/shared-CG
  // modes; consumers MUST prefer `verifiedContextGraphId` for display.
  verifiedContextGraphId?: string,
  // Optional sender-assigned message id (UUID v4 by default, see
  // `DKGAgent.sendChat` → `options.messageId`). Receivers use it to
  // deduplicate messages that arrived twice on parallel transport
  // paths (e.g. happy-eyeballs racing two relay legs, both winning,
  // both delivering the same encrypted payload). Older senders that
  // don't include the field pass `undefined`; the receiver's storage
  // layer treats it as "no dedup possible" and inserts the row
  // unconditionally — i.e. legacy on-the-wire behaviour is preserved.
  messageId?: string,
) => void | Promise<void>;

/**
 * Authorisation hook invoked on every inbound chat AFTER signature
 * verification and decryption, but BEFORE the user-level ChatHandler.
 *
 * Returning `{ accept: false, reason }` causes the receiver to send back
 * `{ success: false, error: reason ?? 'unauthorized' }` and skip the
 * ChatHandler entirely — the SQLite row + notification on the daemon
 * side never get created, so unauthorised senders are inert.
 *
 * Authentication (who the sender is) is handled by the existing Ed25519
 * signature check; this hook layers *authorisation* (are they allowed to
 * be talking to us at all?) on top.
 */
export type ChatAclCheck = (
  senderPeerId: string,
  payload: { contextGraphId?: string },
) => {
  accept: boolean;
  reason?: string;
  // Set ONLY when the ACL implementation has positively verified the
  // sender's `contextGraphId` claim against its policy (scoped mode:
  // claim equals the receiver's configured CG; shared-context-graph
  // mode: claim matches a subscribed CG the sender is an active member
  // of). MUST remain undefined when the mode does not check the claim
  // (`any`, `peer-allowlist`) so downstream consumers can distinguish
  // a verified CG from an attacker-controllable one. See
  // ChatHandler.verifiedContextGraphId for the consumer-side contract.
  verifiedContextGraphId?: string;
};

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
  private readonly messenger: Messenger;
  private readonly keypair: Ed25519Keypair;
  private readonly x25519Private: Uint8Array;
  private readonly peerId: string;
  private readonly eventBus: EventBus;
  private readonly conversations = new Map<string, ConversationState>();
  private readonly skillHandlers = new Map<string, SkillHandler>();
  private readonly peerKeys = new Map<string, Uint8Array>();
  private chatHandler: ChatHandler | null = null;
  private chatAclCheck: ChatAclCheck | null = null;

  constructor(
    messenger: Messenger,
    keypair: Ed25519Keypair,
    x25519Private: Uint8Array,
    peerId: string,
    eventBus: EventBus,
  ) {
    this.messenger = messenger;
    this.keypair = keypair;
    this.x25519Private = x25519Private;
    this.peerId = peerId;
    this.eventBus = eventBus;

    // PR-3 substrate migration: register via `messenger.register`
    // rather than `router.register` so inbound chats get
    // receiver-side dedup (ReliableEnvelope + idempotency cache)
    // for free — the multi-path duplicate-arrival class from the
    // May 2026 soak (seq=13 arriving twice) is now absorbed by the
    // substrate, not by the chat-specific `idx_chat_msgid` SQL
    // index.
    messenger.register(PROTOCOL_MESSAGE, async (data, fromPeerId) => {
      return this.handleIncoming(data, fromPeerId);
    });
  }

  registerSkill(skillUri: string, handler: SkillHandler): void {
    this.skillHandlers.set(skillUri, handler);
  }

  onChat(handler: ChatHandler): void {
    this.chatHandler = handler;
  }

  /**
   * Install an authorisation hook for inbound chats. When unset, all
   * authenticated senders are accepted (legacy behaviour). The daemon
   * sets this from `chat.acl` in the node config — see lifecycle.ts.
   */
  setChatAcl(check: ChatAclCheck | null): void {
    this.chatAclCheck = check;
  }

  /**
   * Cache a peer's Ed25519 public key for use in outgoing messages.
   * Keys are also auto-cached from incoming messages.
   */
  registerPeerKey(peerId: string, ed25519Public: Uint8Array): void {
    this.peerKeys.set(peerId, ed25519Public);
  }

  /**
   * Send an encrypted chat over the Universal Messenger substrate.
   *
   * Outbound semantics (rc.9 PR-3):
   *
   *   * **Delivered** → the recipient's ACK was returned synchronously.
   *     Returns `{ delivered: true }`.
   *   * **Queued** → the dial failed with a recoverable error
   *     (`'no valid addresses for peer'`, `NO_RESERVATION`, etc.).
   *     The substrate has enqueued the encoded envelope to the SQLite
   *     outbox and will retry on the periodic tick + every
   *     `connection:open` from the recipient. Returns
   *     `{ delivered: false, queued: true, attempts, nextAttemptAtMs, error }`.
   *   * **Hard failure** → encoding bug, unknown protocol, or other
   *     non-recoverable error. Returns `{ delivered: false, error }`
   *     (no retry, no queue entry).
   *
   * Sender-side idempotency: if the caller passes the same
   * `messageId` twice (operator double-click, daemon restart replay
   * via in-flight outbox), the substrate returns the cached response
   * without a second wire send.
   */
  async sendChat(
    recipientPeerId: string,
    text: string,
    options: { contextGraphId?: string; messageId?: string } = {},
  ): Promise<{
    delivered: boolean;
    error?: string;
    queued?: boolean;
    attempts?: number;
    nextAttemptAtMs?: number;
  }> {
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
        ...(options.contextGraphId ? { contextGraphId: options.contextGraphId } : {}),
        ...(options.messageId ? { messageId: options.messageId } : {}),
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

      const sendResult = await this.messenger.sendReliable(
        recipientPeerId,
        PROTOCOL_MESSAGE,
        encodeAgentMessage(msg),
        { messageId: options.messageId },
      );

      if (!sendResult.delivered) {
        // inFlight === true means another sender holds the slot;
        // no durable outbox row exists yet, so surface it as a
        // not-yet-queued attempt the caller should retry immediately.
        const nextAttemptAtMs = sendResult.queued
          ? sendResult.nextAttemptAtMs
          : Date.now();
        return {
          delivered: false,
          queued: sendResult.queued,
          attempts: sendResult.attempts,
          nextAttemptAtMs,
          error: sendResult.error,
        };
      }

      // RESPONSE_GONE: the receiver cached this messageId mark-only
      // (response > 256 KiB). For chat the ACK payload is tiny so
      // this branch should never fire in practice; if it did the
      // safe thing is to treat the send as delivered (because the
      // recipient definitely processed it, we just don't have the
      // ACK body to introspect). Documented in
      // docs/messenger.md "RESPONSE_GONE handling".
      const responseBytes = sendResult.response;
      const responseText = new TextDecoder().decode(responseBytes);
      if (responseText === RESPONSE_GONE_MARKER) {
        return { delivered: true };
      }

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

    // Skill requests are synchronous request/response — we don't
    // want the outbox to silently queue a skill call (the operator
    // is waiting on the reply). If `sendReliable` queues instead of
    // delivering, surface that as an explicit failure so the caller
    // can retry deliberately rather than blocking on a background
    // tick.
    const sendResult = await this.messenger.sendReliable(
      recipientPeerId,
      PROTOCOL_MESSAGE,
      encodeAgentMessage(msg),
    );
    if (!sendResult.delivered) {
      return {
        success: false,
        error: `Skill request queued (not delivered): ${sendResult.error}`,
      };
    }
    const responseBytes = sendResult.response;
    const responseText = new TextDecoder().decode(responseBytes);
    if (responseText === RESPONSE_GONE_MARKER) {
      return {
        success: false,
        error: 'Skill response exceeded receiver-side response cache (RESPONSE_GONE); retry with a fresh messageId',
      };
    }

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

  private async handleIncoming(data: Uint8Array, fromPeerId: string): Promise<Uint8Array> {
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
      from: fromPeerId,
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
        const response = await handler(request, fromPeerId);
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
      const senderContextGraphId =
        typeof parsed.contextGraphId === 'string' ? parsed.contextGraphId : undefined;
      // Pre-V11 senders omit this; missing or non-string ⇒ undefined ⇒
      // receiver's dedup layer treats the row as un-dedupable and
      // inserts unconditionally (legacy on-wire behaviour preserved).
      const senderMessageId =
        typeof parsed.messageId === 'string' ? parsed.messageId : undefined;

      // Authorisation check (layered on top of the existing Ed25519
      // signature check above). When unset, all authenticated senders are
      // accepted — this preserves the legacy behaviour for nodes that
      // haven't configured `chat.acl`.
      // `verifiedContextGraphId` is sourced from the ACL verdict (only
      // set in scoped / shared-context-graph modes that actually check
      // the claim). When the ACL is null or omits the field, downstream
      // consumers see only the unverified `senderContextGraphId` and
      // MUST treat that as attacker-controllable.
      let verifiedContextGraphId: string | undefined;
      if (this.chatAclCheck) {
        // Defence in depth: an unexpected exception from the ACL
        // callback (db lookup glitch, custom-callback bug, etc.) must
        // NOT bubble up as a transport-layer error to the sender —
        // the sender would interpret it as a network failure and
        // retry, when the right semantic is "we couldn't authorize
        // you, fail closed". Codex PR #510 round 4 caught this:
        // without the try/catch, an ACL/db problem turned into a
        // confusing send-side timeout. We log the exception locally
        // and return a clean `unauthorized` so the sender's
        // ACL-aware error handling kicks in.
        let verdict: ReturnType<ChatAclCheck>;
        try {
          verdict = this.chatAclCheck(fromPeerId, {
            contextGraphId: senderContextGraphId,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          // Use console.warn rather than a structured log so we don't
          // create a new MessageHandler→logger coupling for an edge
          // case. The daemon's ACL helpers don't throw in normal
          // operation; this branch is the misbehaving-custom-callback
          // safety net.
          console.warn(`[MessageHandler] chat ACL threw, failing closed: ${msg}`);
          verdict = { accept: false, reason: 'unauthorized: ACL evaluation error' };
        }
        if (!verdict.accept) {
          return this.encryptAndSign(conv.sharedSecret, convId, seq + 1, {
            success: false,
            error: verdict.reason ?? 'unauthorized',
          });
        }
        verifiedContextGraphId = verdict.verifiedContextGraphId;
      }

      if (this.chatHandler) {
        try {
          await this.chatHandler(
            text,
            fromPeerId,
            convId,
            senderContextGraphId,
            verifiedContextGraphId,
            senderMessageId,
          );
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
