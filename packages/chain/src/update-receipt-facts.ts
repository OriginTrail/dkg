// SPDX-License-Identifier: Apache-2.0
import { ethers } from 'ethers';
export interface UpdateReceiptFacts {
  readonly kaId: bigint;
  readonly merkleRoot: Uint8Array;
  readonly authorAddress?: string;
  readonly knowledgeAssetsContract: string;
}
export interface V10UpdateReceiptFacts extends UpdateReceiptFacts { readonly authorAddress: string }

type ReceiptLog = Pick<ethers.Log, 'address' | 'topics' | 'data'>;
function parseStorageLog(log: ReceiptLog, storage: ethers.Contract, address: string): ethers.LogDescription | null {
  if (log.address.toLowerCase() !== address.toLowerCase()) return null;
  try { return storage.interface.parseLog({ topics: [...log.topics], data: log.data }); }
  catch { return null; }
}
export function decodeV9UpdateReceiptLog(log: ReceiptLog, storage: ethers.Contract, address: string): UpdateReceiptFacts | null {
  const event = parseStorageLog(log, storage, address);
  if (event?.name !== 'KnowledgeBatchUpdated') return null;
  try { return { kaId: BigInt(event.args.batchId), merkleRoot: ethers.getBytes(event.args.newMerkleRoot), knowledgeAssetsContract: address }; }
  catch { return null; }
}
export function decodeV10UpdateReceiptLog(log: ReceiptLog, storage: ethers.Contract, address: string): V10UpdateReceiptFacts | null {
  const event = parseStorageLog(log, storage, address);
  if (event?.name !== 'KnowledgeAssetUpdated') return null;
  try {
    const authorAddress = String(event.args.author);
    if (!ethers.isAddress(authorAddress)) return null;
    return { kaId: BigInt(event.args.id), merkleRoot: ethers.getBytes(event.args.merkleRoot), authorAddress, knowledgeAssetsContract: address };
  } catch { return null; }
}
