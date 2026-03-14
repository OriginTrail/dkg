import type { ProtocolRouter } from '@origintrail-official/dkg-core';
import {
  PROTOCOL_ACCESS,
  encodeAccessRequest,
  decodeAccessResponse,
  ed25519Sign,
  type Ed25519Keypair,
} from '@origintrail-official/dkg-core';
import type { Quad } from '@origintrail-official/dkg-storage';
import { computePrivateRoot } from './merkle.js';
import { parseSimpleNQuads } from './publish-handler.js';

export interface AccessResult {
  granted: boolean;
  quads: Quad[];
  privateMerkleRoot?: Uint8Array;
  verified: boolean;
  rejectionReason?: string;
}

/**
 * Client-side access protocol for requesting private triples from a publisher node.
 * After receiving triples, verifies them against the privateMerkleRoot to ensure
 * data integrity.
 */
export class AccessClient {
  private readonly router: ProtocolRouter;
  private readonly keypair: Ed25519Keypair;
  private readonly peerId: string;

  constructor(router: ProtocolRouter, keypair: Ed25519Keypair, peerId: string) {
    this.router = router;
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

    const responseData = await this.router.send(
      publisherPeerId,
      PROTOCOL_ACCESS,
      requestData,
    );

    const response = decodeAccessResponse(responseData);

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
