// SPDX-License-Identifier: Apache-2.0

/** Chain truth that prevents adopting a locally sealed, already minted asset. */
export type AdoptExistingMintRefusalCode =
  | 'KA_ID_COLLISION'
  | 'KA_SUPERSEDED'
  | 'KA_CG_MISMATCH';

/** A definitive content refusal; unavailable chain evidence still returns null. */
export class AdoptExistingMintRefusalError extends Error {
  constructor(readonly code: AdoptExistingMintRefusalCode, message: string) {
    super(message);
    this.name = 'AdoptExistingMintRefusalError';
  }
}
