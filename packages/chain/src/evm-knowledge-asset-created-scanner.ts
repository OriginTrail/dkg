// SPDX-License-Identifier: Apache-2.0

import { ethers, type Contract } from 'ethers';
import type { ChainEvent } from './chain-adapter.js';
import type { EvmEventScan } from './evm-event-contracts.js';

type EvmLog = ethers.Log | ethers.EventLog;

type KnowledgeAssetEvidence = {
  readonly publisherAddress: string;
  readonly startKAId: string;
  readonly endKAId: string;
};

function parseLog(contract: Contract, log: EvmLog): ethers.LogDescription | null {
  return contract.interface.parseLog({ topics: [...log.topics], data: log.data });
}

function contractDeclaresEvent(contract: Contract, name: string): boolean {
  return contract.interface.fragments.some(
    fragment => fragment.type === 'event' && (fragment as { name?: string }).name === name,
  );
}

async function collectLegacyMintEvidence(
  kaStorage: Contract,
  scan: EvmEventScan,
): Promise<Map<string, KnowledgeAssetEvidence>> {
  const byTransaction = new Map<string, KnowledgeAssetEvidence>();
  if (!contractDeclaresEvent(kaStorage, 'KnowledgeAssetsMinted')) return byTransaction;

  for await (const log of scan.query(
    kaStorage,
    'kas.queryFilter(KnowledgeAssetsMinted)',
    kaStorage.filters.KnowledgeAssetsMinted(),
  )) {
    const parsed = parseLog(kaStorage, log);
    if (!parsed) continue;
    byTransaction.set(log.transactionHash, {
      publisherAddress: String(parsed.args.to),
      startKAId: parsed.args.startId.toString(),
      endKAId: (BigInt(parsed.args.endId) - 1n).toString(),
    });
  }
  return byTransaction;
}

async function collectGreenfieldTransferEvidence(
  kaStorage: Contract,
  scan: EvmEventScan,
): Promise<Map<string, string>> {
  const ownerByTokenId = new Map<string, string>();
  if (!contractDeclaresEvent(kaStorage, 'Transfer')) return ownerByTokenId;

  try {
    const filter = kaStorage.filters.Transfer(ethers.ZeroAddress);
    for await (const log of scan.query(kaStorage, 'kas.queryFilter(Transfer)', filter)) {
      const parsed = parseLog(kaStorage, log);
      if (parsed?.args.tokenId != null) {
        ownerByTokenId.set(parsed.args.tokenId.toString(), String(parsed.args.to));
      }
    }
  } catch {
    scan.signal?.throwIfAborted();
    // The attested author remains the bounded fallback when transfer enumeration is unavailable.
  }
  return ownerByTokenId;
}

function projectKnowledgeAssetCreated(
  kaStorage: Contract,
  log: EvmLog,
  legacyByTransaction: ReadonlyMap<string, KnowledgeAssetEvidence>,
  greenfieldOwnerByTokenId: ReadonlyMap<string, string>,
): ChainEvent | undefined {
  const parsed = parseLog(kaStorage, log);
  if (!parsed) return undefined;

  const kaId = parsed.args.id.toString();
  const author = typeof parsed.args.author === 'string' ? parsed.args.author : '';
  const legacy = legacyByTransaction.get(log.transactionHash);
  const greenfieldOwner = legacy ? undefined : greenfieldOwnerByTokenId.get(kaId);

  return {
    type: 'KCCreated',
    blockNumber: log.blockNumber,
    data: {
      kaId,
      merkleRoot: parsed.args.merkleRoot,
      merkleRootBytes: parsed.args.merkleRoot,
      byteSize: parsed.args.byteSize.toString(),
      txHash: log.transactionHash,
      txIndex: log.transactionIndex,
      publisherAddress: legacy?.publisherAddress ?? greenfieldOwner ?? author,
      author,
      startKAId: legacy?.startKAId ?? kaId,
      endKAId: legacy?.endKAId ?? kaId,
    },
  };
}

/**
 * Scan one KnowledgeAssetCreated deployment generation. The create query runs
 * first, then legacy mint evidence takes precedence over transfer ownership
 * and the attested author fallback for every projected row.
 */
export async function* scanKnowledgeAssetCreatedEvents(
  kaStorage: Contract,
  scan: EvmEventScan,
): AsyncIterable<ChainEvent> {
  const createLogs: EvmLog[] = [];
  for await (const log of scan.query(
    kaStorage,
    'kas.queryFilter(KnowledgeAssetCreated)',
    kaStorage.filters.KnowledgeAssetCreated(),
  )) createLogs.push(log);

  const legacyByTransaction = await collectLegacyMintEvidence(kaStorage, scan);
  const greenfieldOwnerByTokenId = await collectGreenfieldTransferEvidence(kaStorage, scan);
  for (const log of createLogs) {
    scan.signal?.throwIfAborted();
    const event = projectKnowledgeAssetCreated(
      kaStorage,
      log,
      legacyByTransaction,
      greenfieldOwnerByTokenId,
    );
    if (event) yield event;
  }
}
