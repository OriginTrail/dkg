import {
  AUTHOR_SCHEME_VERSION_V1,
  buildAuthorAttestationTypedData,
  type VerifiedCatalogSealBindingSnapshotV1,
} from '@origintrail-official/dkg-core';
import { ethers } from 'ethers';

export class RecoverableAuthorAttestationErrorV1 extends Error {
  constructor(message: string, options: ErrorOptions = {}) {
    super(message, options);
    this.name = 'RecoverableAuthorAttestationErrorV1';
  }
}

/** Require the v1 EOA AuthorAttestation committed by a catalog seal to recover its author. */
export function assertRecoverableAuthorAttestationV1(
  binding: VerifiedCatalogSealBindingSnapshotV1,
): void {
  const { seal } = binding;
  if (seal.authorSchemeVersion !== String(AUTHOR_SCHEME_VERSION_V1)) {
    throw new RecoverableAuthorAttestationErrorV1(
      'unsupported author attestation scheme',
    );
  }
  try {
    const typedData = buildAuthorAttestationTypedData({
      chainId: BigInt(seal.assertedAtChainId),
      kav10Address: seal.assertedAtKav10Address,
      merkleRoot: ethers.getBytes(seal.assertionMerkleRoot),
      authorAddress: seal.authorAddress,
      reservedKaId: BigInt(seal.reservedKaId),
      schemeVersion: AUTHOR_SCHEME_VERSION_V1,
    });
    const digest = ethers.TypedDataEncoder.hash(
      typedData.domain,
      typedData.types,
      typedData.message,
    );
    const signature = ethers.Signature.from({
      r: seal.authorAttestationR,
      yParityAndS: seal.authorAttestationVS,
    });
    const recovered = ethers.recoverAddress(digest, signature).toLowerCase();
    if (recovered !== seal.authorAddress) {
      throw new Error(`signature recovers ${recovered} instead of ${seal.authorAddress}`);
    }
  } catch (cause) {
    throw new RecoverableAuthorAttestationErrorV1(
      'author attestation does not recover the catalog author',
      { cause },
    );
  }
}
