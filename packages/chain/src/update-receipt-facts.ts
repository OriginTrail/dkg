// SPDX-License-Identifier: Apache-2.0
export interface UpdateReceiptFacts {
  readonly kaId: bigint;
  readonly merkleRoot: Uint8Array;
  readonly authorAddress?: string;
  readonly knowledgeAssetsContract: string;
}

export type UpdateReceiptSelection =
  | Readonly<{ kind: 'single-v10' }>
  | Readonly<{ kind: 'first-matching'; kaId: bigint }>;
