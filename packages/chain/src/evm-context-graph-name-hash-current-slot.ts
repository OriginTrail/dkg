// SPDX-License-Identifier: Apache-2.0

import { ethers } from 'ethers';

export interface ContextGraphNameHashSlotScope {
  readonly storageAddress: string;
  readonly providers: readonly object[];
  readonly rpcUrls: readonly string[];
}

export interface ContextGraphNameHashSlot {
  readonly id: bigint;
  readonly nameHash: string | null;
}

export interface ContextGraphNameHashSlotAnchor {
  readonly blockNumber: number;
  readonly blockHash: string;
}

export interface ContextGraphNameHashSlotState {
  readonly scope: ContextGraphNameHashSlotScope;
  readonly highWater: bigint;
  readonly anchor: ContextGraphNameHashSlotAnchor;
  readonly idsByHash: ReadonlyMap<string, readonly bigint[]>;
}

export function sameContextGraphNameHashSlotScope(
  a: ContextGraphNameHashSlotScope,
  b: ContextGraphNameHashSlotScope,
): boolean {
  return a.storageAddress === b.storageAddress
    && a.providers.length === b.providers.length
    && a.providers.every((provider, index) => provider === b.providers[index])
    && a.rpcUrls.length === b.rpcUrls.length
    && a.rpcUrls.every((url, index) => url === b.rpcUrls[index]);
}

export function copyContextGraphNameHashSlotScope(
  scope: ContextGraphNameHashSlotScope,
): ContextGraphNameHashSlotScope {
  return {
    storageAddress: scope.storageAddress,
    providers: [...scope.providers],
    rpcUrls: [...scope.rpcUrls],
  };
}

export function cloneContextGraphNameHashIdsByHash(
  source: ReadonlyMap<string, readonly bigint[]> | undefined,
): Map<string, bigint[]> {
  return new Map(
    [...(source ?? [])].map(([nameHash, ids]) => [nameHash, [...ids]]),
  );
}

export function appendContextGraphNameHashSlots(
  idsByHash: Map<string, bigint[]>,
  slots: readonly ContextGraphNameHashSlot[],
  firstId: bigint,
  lastId: bigint,
): void {
  const expectedCount = lastId < firstId ? 0 : Number(lastId - firstId + 1n);
  if (slots.length !== expectedCount) {
    throw new Error(
      `resolveContextGraphIdByNameHash: current-slot refresh returned `
      + `${slots.length} rows for ${expectedCount} ids`,
    );
  }
  const seen = new Set<bigint>();
  for (const slot of slots) {
    if (slot.id < firstId || slot.id > lastId || seen.has(slot.id)) {
      throw new Error(
        `resolveContextGraphIdByNameHash: invalid current-slot refresh id `
        + `${slot.id.toString()} for range [${firstId.toString()}, ${lastId.toString()}]`,
      );
    }
    seen.add(slot.id);
    if (slot.nameHash === null || slot.nameHash === ethers.ZeroHash) continue;
    const normalized = slot.nameHash.toLowerCase();
    const ids = idsByHash.get(normalized) ?? [];
    ids.push(slot.id);
    idsByHash.set(normalized, ids);
  }
}

export function waitForContextGraphSlotRead<T>(
  work: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) return work;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(
      signal.reason instanceof Error
        ? signal.reason
        : Object.assign(new Error('Context Graph slot read aborted'), { name: 'AbortError' }),
    );
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}
