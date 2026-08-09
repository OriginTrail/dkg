// SPDX-License-Identifier: Apache-2.0

/** Bounded deploy-anchored exact-topic ContextGraphCreated reverse lookup. */

import { Contract, ethers, type JsonRpcProvider } from 'ethers';

import { CG_REGISTRY_MAX_SCAN_PAGES } from './evm-adapter-constants.js';
import { EvmContextGraphNameHashFence } from './evm-context-graph-name-hash-fence.js';

export interface ContextGraphNameHashScanProvider {
  readonly provider: JsonRpcProvider;
  readonly backendHead: number;
}

export interface EvmContextGraphNameHashHistoricalLogResolverDependencies {
  readonly requireContextGraphStorage: () => Contract;
  readonly scanPageSize: () => number;
  readonly resolveContractDeployBlock: (
    address: string,
    operationLabel: string,
    contractLabel: string,
  ) => Promise<{
    readonly fromBlock: number;
    readonly head: number;
    readonly scanProviders: ReadonlyArray<ContextGraphNameHashScanProvider>;
    readonly degradedFromGenesis?: boolean;
  }>;
  readonly queryEventLogsPage: (
    baseContract: Contract,
    filter: unknown,
    lo: number,
    hi: number,
    scanProviders: ReadonlyArray<ContextGraphNameHashScanProvider>,
    connected: Map<JsonRpcProvider, Contract>,
    label: string,
    preferred?: JsonRpcProvider,
  ) => Promise<{
    readonly logs: ReadonlyArray<ethers.EventLog | ethers.Log>;
    readonly provider: JsonRpcProvider;
  }>;
}

export class EvmContextGraphNameHashHistoricalLogResolver {
  constructor(
    private readonly fence: EvmContextGraphNameHashFence,
    private readonly dependencies: EvmContextGraphNameHashHistoricalLogResolverDependencies,
  ) {}

  async resolve(normalizedNameHash: string): Promise<bigint | null> {
    await this.fence.initialize();
    const scopeToken = await this.fence.captureScopeToken();
    const cgs = this.dependencies.requireContextGraphStorage();
    const storageAddress = (await cgs.getAddress()).toLowerCase();
    const { fromBlock, head, scanProviders: reachableProviders } =
      await this.dependencies.resolveContractDeployBlock(
        storageAddress,
        'resolveContextGraphIdByNameHash',
        'ContextGraphStorage',
      );
    const pageSize = this.dependencies.scanPageSize();
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

    const headAnchor = await this.fence.captureHistoricalHead(reachableProviders, head);
    const scannedRegistryHighWater = await this.fence.loadHistoricalRegistryHighWaterAtHead(
      headAnchor.scanProviders.map(({ provider }) => provider),
      head,
    );
    const assertHistoricalRegistryCurrent = async (): Promise<void> => {
      const currentBoundary = await this.fence.loadProviderHighWaters();
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
      await this.fence.assertScopeCurrent(scopeToken, 'historical scan');
      await this.fence.assertHistoricalHeadCurrent(headAnchor, usedProviders);
    };

    if (fromBlock > head) {
      await assertScanCurrent();
      await assertHistoricalRegistryCurrent();
      await assertScanCurrent();
      return null;
    }

    const filter = cgs.filters.ContextGraphCreated(null, null, normalizedNameHash);
    const connected = new Map<JsonRpcProvider, Contract>();
    const ids = new Set<bigint>();
    let preferred: JsonRpcProvider | undefined;
    for (let lo = fromBlock; lo <= head; lo += pageSize) {
      const hi = Math.min(lo + pageSize - 1, head);
      const page = await this.dependencies.queryEventLogsPage(
        cgs,
        filter,
        lo,
        hi,
        headAnchor.scanProviders,
        connected,
        'resolveContextGraphIdByNameHash ContextGraphCreated',
        preferred,
      );
      preferred = page.provider;
      usedProviders.add(page.provider);
      for (const log of page.logs) {
        const parsed = cgs.interface.parseLog({ topics: [...log.topics], data: log.data });
        if (parsed?.name !== 'ContextGraphCreated') continue;
        const id = BigInt(parsed.args.contextGraphId);
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
    const currentHash = await this.fence.readCurrentNameHash(id);
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
