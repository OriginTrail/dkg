// SPDX-License-Identifier: Apache-2.0

/** Bounded deploy-anchored exact-topic ContextGraphCreated reverse lookup. */

import { ethers, type JsonRpcProvider } from 'ethers';

import { CG_REGISTRY_MAX_SCAN_PAGES } from './evm-adapter-constants.js';
import type { EvmContextGraphNameHashReader } from './evm-context-graph-name-hash-fence.js';

export class EvmContextGraphNameHashHistoricalLogResolver {
  constructor(
    private readonly reader: EvmContextGraphNameHashReader,
  ) {}

  async resolve(normalizedNameHash: string): Promise<bigint | null> {
    await this.reader.initialize();
    const scopeToken = await this.reader.captureScopeToken();
    const scan = await this.reader.prepareHistoricalScan();
    const { fromBlock, head, pageSize } = scan;
    const pages = fromBlock > head
      ? 0
      : Math.ceil((head - fromBlock + 1) / pageSize);
    if (pages > CG_REGISTRY_MAX_SCAN_PAGES) {
      throw new Error(
        `resolveContextGraphIdByNameHash: historical ContextGraphCreated scan ` +
        `would need ${pages} eth_getLogs calls over blocks ` +
        `[${fromBlock}, ${head}] at a ${pageSize}-block window ` +
        `(budget ${CG_REGISTRY_MAX_SCAN_PAGES} pages).`,
      );
    }

    const anchoredScan = await scan.anchor();
    const { headAnchor } = anchoredScan;
    const scannedRegistryHighWater = await this.reader.loadHistoricalRegistryHighWaterAtHead(
      headAnchor.scanProviders.map(({ provider }) => provider),
      head,
    );
    const assertHistoricalRegistryCurrent = async (): Promise<void> => {
      const currentBoundary = await this.reader.loadProviderHighWaters();
      if (currentBoundary.latestId !== scannedRegistryHighWater) {
        throw new Error(
          `resolveContextGraphIdByNameHash: registry high-water changed from ` +
          `${scannedRegistryHighWater.toString()} to ` +
          `${currentBoundary.latestId.toString()} during historical scan`,
        );
      }
    };

    const usedProviders = new Set<JsonRpcProvider>([
      headAnchor.scanProviders[0]!.provider,
    ]);
    const assertScanCurrent = async (): Promise<void> => {
      await this.reader.assertScopeCurrent(scopeToken, 'historical scan');
      await this.reader.assertHistoricalHeadCurrent(headAnchor, usedProviders);
    };

    if (fromBlock > head) {
      await assertScanCurrent();
      await assertHistoricalRegistryCurrent();
      await assertScanCurrent();
      return null;
    }

    const ids = new Set<bigint>();
    let preferred: JsonRpcProvider | undefined;
    for (let lo = fromBlock; lo <= head; lo += pageSize) {
      const hi = Math.min(lo + pageSize - 1, head);
      const page = await anchoredScan.readContextGraphCreatedPage(
        normalizedNameHash,
        lo,
        hi,
        preferred,
      );
      preferred = page.provider;
      usedProviders.add(page.provider);
      for (const id of page.ids) {
        if (id <= 0n) {
          throw new Error(
            `resolveContextGraphIdByNameHash: invalid Context Graph id ` +
            `${id.toString()} for ${normalizedNameHash}`,
          );
        }
        ids.add(id);
      }
    }

    await assertScanCurrent();
    if (ids.size === 0) {
      await assertHistoricalRegistryCurrent();
      await assertScanCurrent();
      return null;
    }
    if (ids.size !== 1) {
      throw new Error(
        `resolveContextGraphIdByNameHash: ambiguous ${normalizedNameHash}; ` +
        `ContextGraphCreated committed it to ${ids.size} numeric ids`,
      );
    }

    const id = ids.values().next().value as bigint;
    const currentHash = await this.reader.readCurrentNameHash(id);
    if (currentHash !== normalizedNameHash) {
      throw new Error(
        `resolveContextGraphIdByNameHash: slot ${id.toString()} currently commits ` +
        `${currentHash ?? ethers.ZeroHash}, expected ${normalizedNameHash}`,
      );
    }
    await assertScanCurrent();
    await assertHistoricalRegistryCurrent();
    await assertScanCurrent();
    return id;
  }
}
