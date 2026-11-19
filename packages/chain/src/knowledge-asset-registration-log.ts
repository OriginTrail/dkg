// SPDX-License-Identifier: Apache-2.0

import type { Interface } from 'ethers';

interface ReceiptLog {
  readonly address?: string;
  readonly topics: ReadonlyArray<string>;
  readonly data: string;
}

/**
 * The Context Graph a publish transaction registered `kaId` to, read from the
 * receipt's own `KnowledgeAssetRegisteredToContextGraph` event. Only a log
 * emitted by the bound ContextGraphStorage contract counts.
 *
 * `ContextGraphStorage.registerKnowledgeAssetToContextGraph` is the only writer
 * of `kaToContextGraph` and reverts on a second registration, so the id in a
 * confirmed receipt is the value a later `getKAContextGraphId(kaId)` read
 * returns. Callers that already hold the receipt can skip that read.
 */
export function decodeKnowledgeAssetRegistration(
  contextGraphStorage: { readonly target: unknown; readonly interface: Interface } | undefined,
  logs: ReadonlyArray<ReceiptLog>,
  kaId: bigint,
): bigint | undefined {
  if (!contextGraphStorage || kaId <= 0n) return undefined;
  const storageAddress = String(contextGraphStorage.target).toLowerCase();
  for (const log of logs) {
    if (typeof log.address !== 'string' || log.address.toLowerCase() !== storageAddress) continue;
    try {
      const parsed = contextGraphStorage.interface.parseLog({ topics: [...log.topics], data: log.data });
      if (parsed?.name !== 'KnowledgeAssetRegisteredToContextGraph') continue;
      if (BigInt(parsed.args.kaId) !== kaId) continue;
      const contextGraphId = BigInt(parsed.args.contextGraphId);
      return contextGraphId > 0n ? contextGraphId : undefined;
    } catch { /* not a ContextGraphStorage event */ }
  }
  return undefined;
}
