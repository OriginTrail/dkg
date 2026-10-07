import type {
  Digest32V1,
  EvmAddressV1,
  SignedControlEnvelopeV1,
  UnsignedControlEnvelopeV1,
} from '@origintrail-official/dkg-core';
import {
  verifyControlEnvelopeIssuerSignatureV1,
  type VerifiedControlEnvelopeIssuerSignatureV1,
} from '@origintrail-official/dkg-chain';
import { ethers } from 'ethers';

/** EOA signer shared by RFC-64 control-object producers. */
export interface Rfc64ControlEnvelopeEip191SignerV1 {
  readonly issuer: EvmAddressV1;
  readonly signDigest: (objectDigest: Uint8Array) => Promise<string>;
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
 */
export function rfc64SignerTakingTurnsV1(
  signer: Rfc64ControlEnvelopeEip191SignerV1,
  turn: () => Promise<void>,
): Rfc64ControlEnvelopeEip191SignerV1 {
  const { issuer, signDigest } = signer;
  if (typeof signDigest !== 'function') return signer;
  return Object.freeze({
    issuer,
    signDigest: async (objectDigest: Uint8Array): Promise<string> => {
      await turn();
      return signDigest(objectDigest);
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
    signature = await signer.signDigest(ethers.getBytes(objectDigest));
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
