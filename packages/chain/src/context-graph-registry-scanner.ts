// SPDX-License-Identifier: Apache-2.0

import { Contract } from 'ethers';
import {
  ContextGraphChainScanPartialError,
  type ContextGraphChainScanOptions,
  type ContextGraphOnChain,
  type ContextGraphRegistryScanOptions,
  type ContextGraphRegistryScanPage,
} from './chain-adapter.js';
import {
  CG_REGISTRY_MAX_SCAN_PAGES,
  CG_REGISTRY_REORG_BUFFER_BLOCKS,
} from './evm-adapter-constants.js';
import type {
  ContextGraphRegistryHistoricalScanCursor,
  ContextGraphRegistryTipScanCursor,
} from './context-graph-registry-scan-cursor.js';
import type {
  EvmEventLogPageReader,
  EvmEventLogScanProvider,
} from './evm-event-log-page-session.js';

type StatelessScanStart =
  | { kind: 'explicit'; fromBlock: number }
  | { kind: 'deployment' };

export type ContextGraphRegistryScanPlan =
  | { kind: 'stateless'; start: StatelessScanStart }
  | { kind: 'historicalIncremental'; pageBudget?: number }
  | { kind: 'historicalSeed'; start: 'deployment' | 'cursor'; pageBudget?: number }
  | { kind: 'tip' };

type ScanRange = {
  start: number;
  head: number;
  scanProviders: ReadonlyArray<EvmEventLogScanProvider>;
  degradedFromGenesis: boolean;
};

type PreparedScan =
  | (ScanRange & {
      kind: 'stateless';
      acknowledge(nextBlock: number): Promise<void>;
    })
  | (ScanRange & {
      kind: 'historicalIncremental';
      pageBudget?: number;
      acknowledge(nextBlock: number): Promise<void>;
    })
  | (ScanRange & {
      kind: 'historicalSeed';
      pageBudget?: number;
      acknowledge(nextBlock: number): Promise<void>;
    })
  | (ScanRange & {
      kind: 'tip';
      acknowledge(nextBlock: number): Promise<void>;
    });

type RegistryScannerInput = {
  registry: Contract;
  registryAddress: string;
  pageSize: number;
  historicalCursor: ContextGraphRegistryHistoricalScanCursor;
  tipCursor: ContextGraphRegistryTipScanCursor;
  resolveDeployment(): Promise<{
    fromBlock: number;
    head: number;
    scanProviders: ReadonlyArray<EvmEventLogScanProvider>;
    degradedFromGenesis?: boolean;
  }>;
  resolveHead(): Promise<{
    head: number;
    scanProviders: ReadonlyArray<EvmEventLogScanProvider>;
  }>;
  createPageSession(
    scanProviders: ReadonlyArray<EvmEventLogScanProvider>,
  ): EvmEventLogPageReader;
};

function normalizePageBudget(value: number | undefined): number | undefined {
  return Number.isFinite(value) && (value ?? 0) >= 1
    ? Math.floor(value ?? 0)
    : undefined;
}

export function buildPublicContextGraphRegistryScanPlan(
  fromBlock: number | undefined,
  options: ContextGraphChainScanOptions | undefined,
): ContextGraphRegistryScanPlan {
  const runtimeOptions = options as
    | (ContextGraphChainScanOptions & { mode?: string })
    | undefined;
  const mode = runtimeOptions?.mode;

  if (fromBlock !== undefined) {
    return { kind: 'stateless', start: { kind: 'explicit', fromBlock } };
  }
  if (runtimeOptions && 'incremental' in runtimeOptions && runtimeOptions.incremental === true) {
    return {
      kind: 'historicalIncremental',
      pageBudget: normalizePageBudget(runtimeOptions.pageBudget),
    };
  }
  if (
    runtimeOptions &&
    'seedIncrementalWatermark' in runtimeOptions &&
    runtimeOptions.seedIncrementalWatermark === true
  ) {
    if (runtimeOptions.resumeFromCursor === true) {
      return {
        kind: 'historicalSeed',
        start: 'cursor',
        pageBudget: normalizePageBudget(runtimeOptions.pageBudget),
      };
    }
    return { kind: 'historicalSeed', start: 'deployment' };
  }
  if (mode !== undefined && mode !== 'listAll') {
    throw new Error(
      'listContextGraphsFromChain accepts only listAll or legacy boolean scan options; ' +
      'use scanContextGraphRegistryPages for cursor-backed daemon scans.',
    );
  }
  return { kind: 'stateless', start: { kind: 'deployment' } };
}

export function buildCursorContextGraphRegistryScanPlan(
  options: ContextGraphRegistryScanOptions,
): ContextGraphRegistryScanPlan {
  switch (options.mode) {
    case 'incremental':
      return {
        kind: 'historicalIncremental',
        pageBudget: normalizePageBudget(options.pageBudget),
      };
    case 'tip':
      return { kind: 'tip' };
    case 'seedFull':
      return { kind: 'historicalSeed', start: 'deployment' };
    case 'seedFromCursor':
      return {
        kind: 'historicalSeed',
        start: 'cursor',
        pageBudget: normalizePageBudget(options.pageBudget),
      };
    default: {
      const exhaustive: never = options;
      throw new Error(`Unsupported ContextGraphNameRegistry scan mode: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/** Focused planner/executor for ContextGraphNameRegistry discovery. */
export class ContextGraphRegistryScanner {
  constructor(private readonly input: RegistryScannerInput) {}

  async collect(scanPlan: ContextGraphRegistryScanPlan): Promise<ContextGraphOnChain[]> {
    const results: ContextGraphOnChain[] = [];
    for await (const page of this.pages(scanPlan)) {
      results.push(...page.contextGraphs);
      await page.ack();
    }
    return results;
  }

  async *pages(
    scanPlan: ContextGraphRegistryScanPlan,
  ): AsyncGenerator<ContextGraphRegistryScanPage, void, unknown> {
    const eventFilter = this.input.registry.filters.NameClaimed();
    const prepared = await this.prepare(scanPlan);
    const { start, head, scanProviders, degradedFromGenesis } = prepared;
    const pageBudget = 'pageBudget' in prepared ? prepared.pageBudget : undefined;
    if (start > head) {
      if (prepared.kind === 'historicalSeed') await prepared.acknowledge(head + 1);
      return;
    }

    const pages = Math.ceil((head - start + 1) / this.input.pageSize);
    const blockBudget = CG_REGISTRY_MAX_SCAN_PAGES * this.input.pageSize;
    if (
      prepared.kind === 'historicalIncremental' &&
      pageBudget === undefined &&
      !degradedFromGenesis &&
      pages > CG_REGISTRY_MAX_SCAN_PAGES
    ) {
      throw new Error(
        `listContextGraphsFromChain: incremental ContextGraphNameRegistry scan would need ` +
          `${pages} eth_getLogs calls over blocks [${start}, ${head}] at a ` +
          `${this.input.pageSize}-block window (budget ${CG_REGISTRY_MAX_SCAN_PAGES} pages / ` +
          `${blockBudget} blocks). ` +
          `Use an RPC that can anchor the registry deploy block and serve the ` +
          `requested log range, or increase cgRegistryScanPageSize for an RPC ` +
          `known to support larger ranges.`,
      );
    }

    const results: ContextGraphOnChain[] = [];
    const pageSession = this.input.createPageSession(scanProviders);
    const queryPage = async (lo: number, hi: number): Promise<ContextGraphOnChain[]> => {
      const pageResults: ContextGraphOnChain[] = [];
      for (const log of await pageSession.query(eventFilter, lo, hi)) {
        const parsed = this.input.registry.interface.parseLog({
          topics: [...log.topics],
          data: log.data,
        });
        if (!parsed || parsed.name !== 'NameClaimed') continue;
        pageResults.push({
          contextGraphId: String(parsed.args.nameHash),
          creator: String(parsed.args.creator),
          accessPolicy: Number(parsed.args.accessPolicy),
          blockNumber: log.blockNumber,
          metadataRevealed: false,
        });
      }
      return pageResults;
    };
    const currentTipStart = Math.max(0, head - this.input.pageSize + 1);
    let scannedAnyPage = false;
    for (let lo = start; lo <= head; lo += this.input.pageSize) {
      const hi = Math.min(lo + this.input.pageSize - 1, head);
      let pageResults: ContextGraphOnChain[];
      try {
        pageResults = await queryPage(lo, hi);
      } catch (err) {
        // A persisted tip cursor is gap-safe progress, not permission for an
        // unavailable old page to suppress recent discovery forever. Probe the
        // bounded current-tip window independently, but deliberately do not
        // acknowledge it: the failed gap remains the next catch-up attempt.
        if (prepared.kind === 'tip' && lo < currentTipStart) {
          const currentPageResults = await queryPage(currentTipStart, head);
          results.push(...currentPageResults);
          yield {
            contextGraphs: currentPageResults,
            ack: async () => {},
          };
          return;
        }
        if (prepared.kind !== 'stateless' && scannedAnyPage) {
          const message = err instanceof Error ? err.message : String(err);
          throw new ContextGraphChainScanPartialError(
            `listContextGraphsFromChain: partial ContextGraphNameRegistry scan ` +
              `stopped after block ${lo - 1}; failed page [${lo}, ${hi}]: ${message}`,
            {
              partialResults: results,
              scannedToBlock: lo - 1,
              failedFromBlock: lo,
              failedToBlock: hi,
              cause: err,
            },
          );
        }
        throw err;
      }
      results.push(...pageResults);
      scannedAnyPage = true;
      yield {
        contextGraphs: pageResults,
        ack: () => prepared.acknowledge(hi + 1),
      };
      const scannedPages = Math.floor((hi - start) / this.input.pageSize) + 1;
      if (pageBudget !== undefined && scannedPages >= pageBudget && hi < head) return;
    }
  }

  private async prepare(scanPlan: ContextGraphRegistryScanPlan): Promise<PreparedScan> {
    const resolveDeployment = async (): Promise<ScanRange> => {
      const { fromBlock, ...resolved } = await this.input.resolveDeployment();
      return {
        start: fromBlock,
        ...resolved,
        degradedFromGenesis: resolved.degradedFromGenesis ?? false,
      };
    };
    const resolveHistoricalCursor = async (): Promise<ScanRange> => {
      const watermark = await this.input.historicalCursor.loadBestEffortWatermark(
        this.input.registryAddress,
      );
      if (watermark !== undefined) {
        return {
          start: Math.max(0, watermark - CG_REGISTRY_REORG_BUFFER_BLOCKS),
          ...(await this.input.resolveHead()),
          degradedFromGenesis: false,
        };
      }
      return resolveDeployment();
    };
    const historicalAcknowledge = (nextBlock: number) =>
      this.input.historicalCursor.saveBestEffortWatermark(
        this.input.registryAddress,
        nextBlock,
      );
    const tipAcknowledge = (nextBlock: number) =>
      this.input.tipCursor.saveStrictWatermark(this.input.registryAddress, nextBlock);
    const noAcknowledge = async () => {};

    switch (scanPlan.kind) {
      case 'stateless': {
        const range = scanPlan.start.kind === 'explicit'
          ? {
              start: scanPlan.start.fromBlock,
              ...(await this.input.resolveHead()),
              degradedFromGenesis: false,
            }
          : await resolveDeployment();
        return {
          kind: scanPlan.kind,
          ...range,
          acknowledge: noAcknowledge,
        };
      }
      case 'historicalIncremental':
        return {
          kind: scanPlan.kind,
          ...(await resolveHistoricalCursor()),
          pageBudget: scanPlan.pageBudget,
          acknowledge: historicalAcknowledge,
        };
      case 'historicalSeed': {
        if (scanPlan.start === 'deployment') {
          // Preserve monotonic store behavior while a full recovery replays old pages.
          await this.input.historicalCursor.loadBestEffortWatermark(this.input.registryAddress);
        }
        const range = await (scanPlan.start === 'cursor'
          ? resolveHistoricalCursor()
          : resolveDeployment());
        return {
          kind: scanPlan.kind,
          ...range,
          pageBudget: scanPlan.pageBudget,
          acknowledge: historicalAcknowledge,
        };
      }
      case 'tip': {
        const tip = await this.input.resolveHead();
        const watermark = await this.input.tipCursor.loadStrictWatermark(
          this.input.registryAddress,
        );
        const start = watermark === undefined
          ? Math.max(0, tip.head - this.input.pageSize + 1)
          : Math.max(0, watermark - CG_REGISTRY_REORG_BUFFER_BLOCKS);
        // Persist the conservative lower bound before the first query. Strict persistence makes a
        // configured-store failure observable; an in-process pending marker is retried here.
        await this.input.tipCursor.saveStrictWatermark(
          this.input.registryAddress,
          watermark ?? Math.max(1, start),
        );
        return {
          kind: scanPlan.kind,
          ...tip,
          start,
          degradedFromGenesis: false,
          acknowledge: tipAcknowledge,
        };
      }
      default: {
        const exhaustive: never = scanPlan;
        throw new Error(
          `Unsupported ContextGraphNameRegistry scan plan: ${JSON.stringify(exhaustive)}`,
        );
      }
    }
  }
}
