import {
  PROTOCOL_ACCESS,
  encodeAccessRequest,
  decodeAccessResponse,
  ed25519Sign,
  type Ed25519Keypair,
} from '@origintrail-official/dkg-core';
import type { Quad } from '@origintrail-official/dkg-storage';
import { computePrivateRootV10 as computePrivateRoot } from './merkle.js';
import { parseSimpleNQuads } from './publish-handler.js';

export interface AccessResult {
  granted: boolean;
  quads: Quad[];
  privateMerkleRoot?: Uint8Array;
  verified: boolean;
  rejectionReason?: string;
}

/**
 * Minimal substrate-shaped send surface AccessClient depends on.
 * Lets callers inject any object with a `sendReliable` method —
 * production wires in the agent's Universal Messenger; tests can
 * wire in a Messenger fixture or a mock. We don't import the
 * Messenger class directly to avoid the publisher → agent dep cycle.
 */
export interface AccessSendSurface {
  sendReliable(
    peerId: string,
    protocolId: string,
    payload: Uint8Array,
    opts?: { messageId?: string; timeoutMs?: number },
  ): Promise<
    | { delivered: true; response: Uint8Array; attempts: number; messageId: string }
    | {
        delivered: false;
        queued: true;
        attempts: number;
        messageId: string;
        error: string;
      }
  >;
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
  ): Promise<AccessResult> {
    const message = new TextEncoder().encode(
      kaUal + toHex(paymentProof),
    );
    const signature = await ed25519Sign(message, this.keypair.secretKey);

    const requestData = encodeAccessRequest({
      kaUal,
      requesterPeerId: this.peerId,
      paymentProof,
      requesterSignature: signature,
      requesterPublicKey: this.keypair.publicKey,
    });

    const sendResult = await this.messenger.sendReliable(
      publisherPeerId,
      PROTOCOL_ACCESS,
      requestData,
    );

    if (!sendResult.delivered) {
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
