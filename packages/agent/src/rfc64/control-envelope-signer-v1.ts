import type {
  Digest32V1,
  EvmAddressV1,
  SignedControlEnvelopeV1,
  UnsignedControlEnvelopeV1,
} from '@origintrail-official/dkg-core';
import { verifyControlEnvelopeIssuerSignatureV1 } from '@origintrail-official/dkg-chain';
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

/** Sign one prepared control object and recover its declared issuer before use. */
export async function signAndVerifyRfc64ControlEnvelopeV1<
  TSigned extends SignedControlEnvelopeV1 = SignedControlEnvelopeV1,
>(
  unsigned: UnsignedControlEnvelopeV1,
  objectDigest: Digest32V1,
  signer: Rfc64ControlEnvelopeEip191SignerV1,
  assertSpecific: (value: SignedControlEnvelopeV1) => void,
): Promise<TSigned> {
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
    assertSpecific(signed);
    await verifyControlEnvelopeIssuerSignatureV1(signed);
  } catch (cause) {
    throw new Rfc64ControlEnvelopeSigningErrorV1(
      'verification',
      `signer did not produce a canonical ${unsigned.objectType} issuer signature`,
      { cause },
    );
  }
  return signed as TSigned;
}
