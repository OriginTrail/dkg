import {
  PROTOCOL_ACCESS, ProtocolReadLimitError, encodeAccessRequest, decodeAccessResponse,
  ed25519Sign, resolveWithinAbort, type Ed25519Keypair,
} from '@origintrail-official/dkg-core';
import type { Quad } from '@origintrail-official/dkg-storage';
import { accessError } from './access-errors.js';
import { computePrivateRootV10 as computePrivateRoot } from './merkle.js';
import { parseSimpleNQuads } from './publish-handler.js';

export interface AccessClientRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  maxResponseBytes?: number;
  maxQuads?: number;
}

export interface AccessResult {
  granted: boolean;
  quads: Quad[];
  privateMerkleRoot?: Uint8Array;
  /** Matches the root supplied by the peer; does not authenticate a chain anchor. */
  verified: boolean;
  rejectionReason?: string;
}

type AccessDeliveredResult = { delivered: true; response: Uint8Array; attempts: number; messageId: string };
type AccessSendFailure = { delivered: false; queued: boolean; attempts: number; messageId: string; error: string };
type AccessSendResult = AccessDeliveredResult | AccessSendFailure;
type RequestOwnedAccessSendResult = AccessDeliveredResult | (AccessSendFailure & { queued: false });

/** Compatibility boundary for the existing optionless AccessClient. */
export interface AccessSendSurface {
  sendReliable(peerId: string, protocolId: string, payload: Uint8Array,
    opts?: { messageId?: string; timeoutMs?: number }): Promise<AccessSendResult>;
}

/** Explicit owned transport: a failed read must never enter the durable outbox. */
export interface RequestOwnedAccessSendSurface {
  sendRequestOwned(peerId: string, protocolId: string, payload: Uint8Array,
    opts?: { messageId?: string; timeoutMs?: number; signal?: AbortSignal; maxReadBytes?: number;
      recoverPeerAfterFailure?: boolean }): Promise<RequestOwnedAccessSendResult>;
}

/** Legacy optionless access. Existing queued transport failures remain denials. */
export class AccessClient {
  constructor(private readonly messenger: AccessSendSurface,
    private readonly keypair: Ed25519Keypair, private readonly peerId: string) {}

  async requestAccess(publisherPeerId: string, kaUal: string,
    paymentProof: Uint8Array = new Uint8Array(0)): Promise<AccessResult> {
    const payload = await encodeRequest(this.keypair, this.peerId, kaUal, paymentProof);
    const result = await this.messenger.sendReliable(publisherPeerId, PROTOCOL_ACCESS, payload);
    if (!result.delivered) return { granted: false, quads: [], verified: false,
      rejectionReason: `transport: ${result.error}` };
    return decodeResult(result.response);
  }
}

/** Caller-owned access with explicit cancellation and response bounds. */
export class RequestOwnedAccessClient {
  private readonly send: RequestOwnedAccessSendSurface['sendRequestOwned'];
  constructor(messenger: RequestOwnedAccessSendSurface,
    private readonly keypair: Ed25519Keypair, private readonly peerId: string) {
    const send = messenger.sendRequestOwned;
    if (typeof send !== 'function') {
      throw accessError('ACCESS_REQUEST_OWNED_REQUIRED', 'Bounded private access requires sendRequestOwned transport');
    }
    this.send = send.bind(messenger);
  }

  async requestAccess(publisherPeerId: string, kaUal: string,
    paymentProof: Uint8Array = new Uint8Array(0), options: AccessClientRequestOptions = {}): Promise<AccessResult> {
    const { signal, timeoutMs, maxResponseBytes, maxQuads } = options;
    signal?.throwIfAborted();
    for (const limit of [maxResponseBytes, maxQuads]) {
      if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) {
        throw new RangeError('Private access limits must be positive safe integers');
      }
    }
    const payload = await encodeRequest(this.keypair, this.peerId, kaUal, paymentProof);
    signal?.throwIfAborted();
    let result: RequestOwnedAccessSendResult | null;
    try {
      result = await resolveWithinAbort(() => this.send(publisherPeerId, PROTOCOL_ACCESS, payload,
        { timeoutMs, signal, maxReadBytes: maxResponseBytes, recoverPeerAfterFailure: false }), signal);
    } catch (error) {
      if (error instanceof ProtocolReadLimitError) {
        throw accessError('ACCESS_RESPONSE_TOO_LARGE', 'Private access response exceeds byte limit', { cause: error });
      }
      throw error;
    }
    signal?.throwIfAborted();
    if (!result || !result.delivered) throw accessError('ACCESS_UNAVAILABLE', 'Private access transport is busy');
    return decodeResult(result.response, { maxResponseBytes, maxQuads });
  }
}

async function encodeRequest(keypair: Ed25519Keypair, requesterPeerId: string,
  kaUal: string, paymentProof: Uint8Array): Promise<Uint8Array> {
  const signature = await ed25519Sign(new TextEncoder().encode(kaUal + toHex(paymentProof)), keypair.secretKey);
  return encodeAccessRequest({ kaUal, requesterPeerId, paymentProof,
    requesterSignature: signature, requesterPublicKey: keypair.publicKey });
}

function decodeResult(bytes: Uint8Array,
  { maxResponseBytes, maxQuads }: Pick<AccessClientRequestOptions, 'maxResponseBytes' | 'maxQuads'> = {}): AccessResult {
  if (maxResponseBytes !== undefined && bytes.byteLength > maxResponseBytes) {
    throw accessError('ACCESS_RESPONSE_TOO_LARGE', 'Private access response exceeds byte limit');
  }
  const response = decodeAccessResponse(bytes);

  if (!response.granted) {
    return {
      granted: false,
      quads: [],
      verified: false,
      rejectionReason: response.rejectionReason,
    };
  }

  const nquadsStr = new TextDecoder().decode(response.nquads);
  const quads = parseSimpleNQuads(nquadsStr);
  if (maxQuads !== undefined && quads.length > maxQuads) {
    throw accessError('ACCESS_RESPONSE_TOO_LARGE', 'Private access response exceeds quad limit');
  }

  // Verify merkle root of received private triples
  let verified = false;
  if (response.privateMerkleRoot.length === 32 && !isZeroBytes(response.privateMerkleRoot)) {
    const computedRoot = computePrivateRoot(quads);
    if (computedRoot) {
      verified = bytesEqual(computedRoot, response.privateMerkleRoot);
    }
  } else if (quads.length > 0) {
    // No root provided but we got triples — accept but mark as unverified
    verified = false;
  }

  return {
    granted: true,
    quads,
    privateMerkleRoot: response.privateMerkleRoot,
    verified,
  };
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function isZeroBytes(bytes: Uint8Array): boolean {
  for (const b of bytes) {
    if (b !== 0) return false;
  }
  return true;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
