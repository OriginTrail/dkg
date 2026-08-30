// SPDX-License-Identifier: Apache-2.0

import { Contract, ethers, type JsonRpcProvider } from 'ethers';
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
import type { ContextGraphRegistryScanCursor } from './context-graph-registry-scan-cursor.js';

type StatelessScanStart =
  | { kind: 'explicit'; fromBlock: number }
  | { kind: 'deployment' };

export type ContextGraphRegistryScanPlan =
  | { kind: 'stateless'; start: StatelessScanStart }
  | { kind: 'historicalIncremental'; pageBudget?: number }
  | { kind: 'historicalSeed'; start: 'deployment' | 'cursor'; pageBudget?: number }
  | { kind: 'tip' };

type ScanProvider = { provider: JsonRpcProvider; backendHead: number };
type ScanRange = {
  start: number;
  head: number;
  scanProviders: ReadonlyArray<ScanProvider>;
  degradedFromGenesis: boolean;
};

type PreparedScan = ScanRange & {
  kind: ContextGraphRegistryScanPlan['kind'];
  pageBudget?: number;
  pageLimit: { kind: 'unbounded' } | { kind: 'defaultCapUnlessBudget' };
  pageFailure: { kind: 'allOrError' } | { kind: 'partialAfterProgress' };
  emptyRange: { kind: 'return' } | { kind: 'acknowledge' };
  acknowledge(nextBlock: number): Promise<void>;
};

type RegistryScannerInput = {
  registry: Contract;
  registryAddress: string;
  pageSize: number;
  historicalCursor: ContextGraphRegistryScanCursor;
  tipCursor: ContextGraphRegistryScanCursor;
  resolveDeployment(): Promise<{
    fromBlock: number;
    head: number;
    scanProviders: ReadonlyArray<ScanProvider>;
    degradedFromGenesis?: boolean;
  }>;
  resolveHead(): Promise<{
    head: number;
    scanProviders: ReadonlyArray<ScanProvider>;
  }>;
  queryPage(
    filter: unknown,
    lo: number,
    hi: number,
    scanProviders: ReadonlyArray<ScanProvider>,
    connected: Map<JsonRpcProvider, Contract>,
    preferred?: JsonRpcProvider,
  ): Promise<{
    logs: ReadonlyArray<ethers.EventLog | ethers.Log>;
    provider: JsonRpcProvider;
  }>;
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
    const { start, head, scanProviders, degradedFromGenesis, pageBudget } = prepared;
    if (start > head) {
      if (prepared.emptyRange.kind === 'acknowledge') await prepared.acknowledge(head + 1);
      return;
    }

    const pages = Math.ceil((head - start + 1) / this.input.pageSize);
    const blockBudget = CG_REGISTRY_MAX_SCAN_PAGES * this.input.pageSize;
    if (
      prepared.pageLimit.kind === 'defaultCapUnlessBudget' &&
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
    const connected = new Map<JsonRpcProvider, Contract>();
    let preferred: JsonRpcProvider | undefined;
    let scannedAnyPage = false;
    for (let lo = start; lo <= head; lo += this.input.pageSize) {
      const hi = Math.min(lo + this.input.pageSize - 1, head);
      let pageResults: ContextGraphOnChain[];
      try {
        const page = await this.input.queryPage(
          eventFilter,
          lo,
          hi,
          scanProviders,
          connected,
          preferred,
        );
        preferred = page.provider;
        pageResults = [];
        for (const log of page.logs) {
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
      } catch (err) {
        if (prepared.pageFailure.kind === 'partialAfterProgress' && scannedAnyPage) {
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
      const watermark = await this.input.historicalCursor.loadWatermark(
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
      this.input.historicalCursor.saveWatermark(this.input.registryAddress, nextBlock);
    const tipAcknowledge = (nextBlock: number) =>
      this.input.tipCursor.saveWatermarkStrict(this.input.registryAddress, nextBlock);
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
          pageLimit: { kind: 'unbounded' },
          pageFailure: { kind: 'allOrError' },
          emptyRange: { kind: 'return' },
          acknowledge: noAcknowledge,
        };
      }
      case 'historicalIncremental':
        return {
          kind: scanPlan.kind,
          ...(await resolveHistoricalCursor()),
          pageBudget: scanPlan.pageBudget,
          pageLimit: { kind: 'defaultCapUnlessBudget' },
          pageFailure: { kind: 'partialAfterProgress' },
          emptyRange: { kind: 'return' },
          acknowledge: historicalAcknowledge,
        };
      case 'historicalSeed': {
        if (scanPlan.start === 'deployment') {
          // Preserve monotonic store behavior while a full recovery replays old pages.
          await this.input.historicalCursor.loadWatermark(this.input.registryAddress);
        }
        const range = await (scanPlan.start === 'cursor'
          ? resolveHistoricalCursor()
          : resolveDeployment());
        return {
          kind: scanPlan.kind,
          ...range,
          pageBudget: scanPlan.pageBudget,
          pageLimit: { kind: 'unbounded' },
          pageFailure: { kind: 'partialAfterProgress' },
          emptyRange: { kind: 'acknowledge' },
          acknowledge: historicalAcknowledge,
        };
      }
      case 'tip': {
        const tip = await this.input.resolveHead();
        const loaded = await this.input.tipCursor.loadWatermarkResult(
          this.input.registryAddress,
        );
        if (loaded.status === 'failed') {
          throw new Error(
            'listContextGraphsFromChain: tip cursor load failed; refusing to initialize from ' +
              'the current head because persisted progress may exist',
            { cause: loaded.error },
          );
        }
        const watermark = loaded.watermark;
        const start = watermark === undefined
          ? Math.max(0, tip.head - this.input.pageSize + 1)
          : Math.max(0, watermark - CG_REGISTRY_REORG_BUFFER_BLOCKS);
        // Persist the conservative lower bound before the first query. Strict persistence makes a
        // configured-store failure observable; an in-process pending marker is retried here.
        await this.input.tipCursor.saveWatermarkStrict(
          this.input.registryAddress,
          watermark ?? Math.max(1, start),
        );
        return {
          kind: scanPlan.kind,
          ...tip,
          start,
          degradedFromGenesis: false,
          pageLimit: { kind: 'unbounded' },
          pageFailure: { kind: 'partialAfterProgress' },
          emptyRange: { kind: 'return' },
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
