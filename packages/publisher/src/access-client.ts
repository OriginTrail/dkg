import {
  PROTOCOL_ACCESS,
  encodeAccessRequest,
  decodeAccessResponse,
  ed25519Sign,
  resolveWithinAbort,
  type Ed25519Keypair,
} from '@origintrail-official/dkg-core';
import type { Quad } from '@origintrail-official/dkg-storage';
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

/**
 * Minimal substrate-shaped send surface AccessClient depends on.
 * Lets callers inject any object with a `sendReliable` method —
 * production wires in the agent's Universal Messenger; tests can
 * wire in a Messenger fixture or a mock. Bounded calls additionally require
 * sendRequestOwned, which the standard Messenger provides. We don't import the
 * Messenger class directly to avoid the publisher → agent dep cycle.
 */
type AccessSendResult =
  | { delivered: true; response: Uint8Array; attempts: number; messageId: string }
  | { delivered: false; queued: boolean; attempts: number; messageId: string; error: string };

export interface AccessSendSurface {
  /** Existing optionless calls retain this legacy transport contract. */
  sendReliable(peerId: string, protocolId: string, payload: Uint8Array,
    opts?: { messageId?: string; timeoutMs?: number }): Promise<AccessSendResult>;
  /** Required for bounded/cancellable calls; never queues a read after failure. */
  sendRequestOwned?(peerId: string, protocolId: string, payload: Uint8Array,
    opts?: { messageId?: string; timeoutMs?: number; signal?: AbortSignal; maxReadBytes?: number;
      recoverPeerAfterFailure?: boolean }): Promise<AccessSendResult>;
}

/**
 * Client-side access protocol for requesting private triples from a publisher node.
 * After receiving triples, verifies them against the privateMerkleRoot to ensure
 * data integrity.
 *
 * rc.9 PR-8: migrated from `ProtocolRouter.send` to Messenger
 * substrate (`sendReliable`). Wire prefix bumped to
 * `/dkg/10.0.1/private-access`; receivers must run the substrate.
 * Queued returns are surfaced to the caller as a failed access
 * request — access is synchronous-by-design (the requester is
 * waiting for triples, not enqueueing a background fetch).
 */
export class AccessClient {
  private readonly messenger: AccessSendSurface;
  private readonly keypair: Ed25519Keypair;
  private readonly peerId: string;

  constructor(messenger: AccessSendSurface, keypair: Ed25519Keypair, peerId: string) {
    this.messenger = messenger;
    this.keypair = keypair;
    this.peerId = peerId;
  }

  async requestAccess(
    publisherPeerId: string,
    kaUal: string,
    paymentProof: Uint8Array = new Uint8Array(0),
    options: AccessClientRequestOptions = {},
  ): Promise<AccessResult> {
    options.signal?.throwIfAborted();
    for (const limit of [options.maxResponseBytes, options.maxQuads]) {
      if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) {
        throw new RangeError('Private access limits must be positive safe integers');
      }
    }
    const requestOwned = Object.values(options).some(value => value !== undefined);
    if (requestOwned && !this.messenger.sendRequestOwned) {
      throw Object.assign(new Error('Bounded private access requires sendRequestOwned transport'), {
        code: 'ACCESS_REQUEST_OWNED_REQUIRED',
      });
    }
    const message = new TextEncoder().encode(
      kaUal + toHex(paymentProof),
    );
    const signature = await ed25519Sign(message, this.keypair.secretKey);

    options.signal?.throwIfAborted();
    const requestData = encodeAccessRequest({
      kaUal,
      requesterPeerId: this.peerId,
      paymentProof,
      requesterSignature: signature,
      requesterPublicKey: this.keypair.publicKey,
    });

    const sendResult = await resolveWithinAbort(() => requestOwned
      ? this.messenger.sendRequestOwned!(publisherPeerId, PROTOCOL_ACCESS, requestData, {
        timeoutMs: options.timeoutMs, signal: options.signal, maxReadBytes: options.maxResponseBytes,
        recoverPeerAfterFailure: false,
      })
      : this.messenger.sendReliable(publisherPeerId, PROTOCOL_ACCESS, requestData), options.signal);
    options.signal?.throwIfAborted();
    if (!sendResult) throw new Error('Private access cancelled');

    if (!sendResult.delivered) {
      if (requestOwned) throw Object.assign(new Error('Private access transport is busy'), { code: 'ACCESS_UNAVAILABLE' });
      // Access is synchronous-by-design — surface queued as a
      // rejection so the caller can retry with a fresh request rather
      // than waiting for a background outbox flush. The substrate
      // still keeps the outbox entry around for diagnostics.
      return {
        granted: false,
        quads: [],
        verified: false,
        rejectionReason: `transport: ${sendResult.error}`,
      };
    }

    if (options.maxResponseBytes !== undefined && sendResult.response.byteLength > options.maxResponseBytes) {
      throw Object.assign(new Error('Private access response exceeds byte limit'), { code: 'ACCESS_RESPONSE_TOO_LARGE' });
    }
    const response = decodeAccessResponse(sendResult.response);

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
    if (options.maxQuads !== undefined && quads.length > options.maxQuads) {
      throw Object.assign(new Error('Private access response exceeds quad limit'), { code: 'ACCESS_RESPONSE_TOO_LARGE' });
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
