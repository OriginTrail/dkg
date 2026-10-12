import type {
  Digest32V1,
  EvmAddressV1,
  SignedControlEnvelopeV1,
  UnsignedControlEnvelopeV1,
} from '@origintrail-official/dkg-core';
import {
  isExternalEvmSigner,
  verifyControlEnvelopeIssuerSignatureV1,
  type AuthorSigner,
  type VerifiedControlEnvelopeIssuerSignatureV1,
} from '@origintrail-official/dkg-chain';
import { ethers } from 'ethers';
import { raceRfc64AgainstAbortV1 } from './abort-v1.js';
import { signRfc64ControlObjectExternallyV1, signingRfc64ControlObjectV1 } from './external-author-control-signing-v1.js';

/** EOA signer shared by RFC-64 control-object producers. */
export interface Rfc64ControlEnvelopeEip191SignerV1 {
  readonly issuer: EvmAddressV1;
  readonly signDigest: (objectDigest: Uint8Array) => Promise<string>;
}

/**
 * An author's key as the EIP-191 signer of the RFC-64 control objects it
 * issues (a context graph's replica authority seed, an author's shared-memory
 * inventory and catalog), whichever holds it: the node or an external signer
 * (see `heldAuthorSigner`). An external signer is shown the control object
 * being signed (see `signRfc64ControlObjectExternallyV1`); a key on the node
 * signs the digest. A key that is not `issuer`'s is refused before it signs,
 * the request is abandoned when `signal` aborts, and the signature must
 * recover to `issuer`.
 */
export function rfc64AuthorDigestSignerV1(
  issuer: string,
  author: Pick<AuthorSigner, 'address' | 'signMessage'>,
  signal?: AbortSignal,
): (objectDigest: Uint8Array) => Promise<string> {
  return async (objectDigest) => {
    if (author.address.toLowerCase() !== issuer.toLowerCase()) {
      throw new Error(`RFC-64: the signing key does not belong to author ${issuer}`);
    }
    const signature = await raceRfc64AgainstAbortV1(() => (
      isExternalEvmSigner(author) ? signRfc64ControlObjectExternallyV1(author, objectDigest) : author.signMessage(objectDigest)
    ), signal);
    if (ethers.verifyMessage(objectDigest, signature).toLowerCase() !== issuer.toLowerCase()) {
      throw new Error(`RFC-64: the signature does not recover to author ${issuer}`);
    }
    return signature;
  };
}

export class Rfc64ControlEnvelopeSigningErrorV1 extends Error {
  constructor(
    readonly phase: 'callback' | 'verification',
    message: string,
    options: ErrorOptions = {},
  ) {
    super(message, options);
    this.name = 'Rfc64ControlEnvelopeSigningErrorV1';
  }
}

/**
 * The same signer, awaiting `turn` before each signature. A producer that
 * works on the main thread passes its time-slice checkpoint, so the work
 * around each signature does not run back to back with the work before it.
 * The callback is read once and called on a snapshot that holds the issuer,
 * which is the receiver a producer's own signer snapshot gives it.
 */
export function rfc64SignerTakingTurnsV1(
  signer: Rfc64ControlEnvelopeEip191SignerV1,
  turn: () => Promise<void>,
): Rfc64ControlEnvelopeEip191SignerV1 {
  const { issuer, signDigest } = signer;
  if (typeof signDigest !== 'function') return signer;
  const snapshot = Object.freeze({ issuer, signDigest });
  return Object.freeze({
    issuer,
    signDigest: async (objectDigest: Uint8Array): Promise<string> => {
      await turn();
      return snapshot.signDigest(objectDigest);
    },
  });
}

export interface SignedAndVerifiedRfc64ControlEnvelopeV1 {
  readonly envelope: SignedControlEnvelopeV1;
  readonly issuerSignature: VerifiedControlEnvelopeIssuerSignatureV1;
}

/** Sign one prepared control object and recover its declared issuer before use. */
export async function signAndVerifyRfc64ControlEnvelopeV1(
  unsigned: UnsignedControlEnvelopeV1,
  objectDigest: Digest32V1,
  signer: Rfc64ControlEnvelopeEip191SignerV1,
): Promise<SignedAndVerifiedRfc64ControlEnvelopeV1> {
  let signature: string;
  try {
    signature = await signingRfc64ControlObjectV1(
      unsigned,
      () => signer.signDigest(ethers.getBytes(objectDigest)),
    );
  } catch (cause) {
    throw new Rfc64ControlEnvelopeSigningErrorV1(
      'callback',
      `signer callback failed for ${unsigned.objectType}`,
      { cause },
    );
  }
  const signed = { ...unsigned, objectDigest, signature } as SignedControlEnvelopeV1;
  try {
    const issuerSignature = await verifyControlEnvelopeIssuerSignatureV1(signed);
    return Object.freeze({ envelope: signed, issuerSignature });
  } catch (cause) {
    throw new Rfc64ControlEnvelopeSigningErrorV1(
      'verification',
      `signer did not produce a canonical ${unsigned.objectType} issuer signature`,
      { cause },
    );
  }
}
