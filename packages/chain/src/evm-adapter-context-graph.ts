// SPDX-License-Identifier: Apache-2.0

/**
 * Context-graph create / publish / read / policy methods.
 *
 * Mixin holder extracted from evm-adapter.ts. `extends EVMChainAdapterBase`
 * for shared state (providers, signers, caches) reached via `this`. Bodies
 * are a 1:1 move — no behaviour change. Mixed into the concrete EVMChainAdapter
 * via applyMixins(); see evm-adapter.ts for the assembly.
 */

import {
  EVMChainAdapterBase,
  CG_REGISTRY_MAX_SCAN_PAGES,
  CG_REGISTRY_REORG_BUFFER_BLOCKS,
  type ScanProvider,
} from './evm-adapter-base.js';
import {
  isTooLowAllowanceError,
} from './evm-adapter-errors.js';
import { errorCode as rpcErrorCode, errorMessage as rpcErrorMessage } from './evm-adapter-errors.js';
import {
  ContextGraphLiveAuthorityUnsupportedError,
  type ContextGraphLiveAuthority,
} from './chain-adapter.js';
import { ethers, Contract, type JsonRpcProvider } from 'ethers';
import { ContextGraphChainScanPartialError, type ChainReadOptions, type ContextGraphAuthorityReadOptions, type ContextGraphLiveAuthorityReadOptions, type ContextGraphAuthoritySnapshot, type ContextGraphFinalizedCreation, type CreateContextGraphParams, type TxResult, type ContextGraphOnChain, type ContextGraphChainScanOptions, type ContextGraphRegistryScanOptions, type ContextGraphRegistryScanPage, type CreateOnChainContextGraphParams, type CreateOnChainContextGraphResult, type VerifyParams, type PublishToContextGraphParams, type OnChainPublishResult } from './chain-adapter.js';
import { buildAuthorAttestationTypedData, AUTHOR_SCHEME_VERSION_V1 } from '@origintrail-official/dkg-core';
import {
  resolveContextGraphAuthorityHistory,
  type ContextGraphAuthorityHistoryCreationEvent,
  type ContextGraphAuthorityHistoryEvent,
  type ContextGraphAuthorityHistoryEventQuery,
} from './context-graph-authority-history.js';
import {
  normalizeEvmContextGraphCurrentAuthorityState,
} from './evm-context-graph-authority-source.js';
import { readAdaptiveEvmLogRange } from './evm-log-range.js';
import { resolveEvmFinalityAnchorBlockV1 } from './evm-finality-anchor.js';
import { isRetryableRpcError, isRpcEndpointFailoverEligible } from './evm-adapter-rpc.js';
import { isContextGraphAuthorityIndexRetryableError } from './context-graph-authority-index.js';
import { markContextGraphRegistrationNotSubmitted } from
  './context-graph-registration-error.js';
import {
  contextGraphAuthorityAnchorUnavailableV1,
} from
  './evm-context-graph-authority-index-reader.js';
import { normalizeContextGraphAuthorityHash } from
  './context-graph-authority-generation.js';
import { CONTEXT_GRAPH_AUTHORITY_FUNNEL_RPC_CONSUMER } from
  './context-graph-authority-rpc-sites.js';
import type {
  ContextGraphStorageRange,
  ContextGraphStorageRangeOptions,
} from './chain-adapter.js';
import {
  CONTEXT_GRAPH_STORAGE_ENUMERATION_RPC_CONSUMER,
  isContextGraphStorageEnumerationReadRetryable,
  isNonexistentContextGraphStorageRevert,
  readContextGraphStorageRangeV1,
} from './evm-context-graph-storage-enumeration.js';

type ContextGraphRegistryLiveScanMode =
  | 'explicitFromBlock'
  | 'listAll'
  | 'incremental'
  | 'seedFull'
  | 'seedFromCursor'
  | 'seedLiveTail';

type ContextGraphRegistryLiveScanPlan = {
  mode: ContextGraphRegistryLiveScanMode;
  pageBudget?: number;
};

type ContextGraphRegistryRepairScanPlan = {
  mode: 'repair';
  pageBudget: number;
  minimumIntervalMs: number;
};

type ContextGraphRegistryScanPlan =
  | ContextGraphRegistryLiveScanPlan
  | ContextGraphRegistryRepairScanPlan;

const CONTEXT_GRAPH_REGISTRY_REPAIR_MINIMUM_INTERVAL_MS = 24 * 60 * 60 * 1_000;

type ContextGraphAuthorityMutation = 'addParticipantAgent' | 'removeParticipantAgent';

/** Every authority writer invalidates projections, even when its receipt is lost. */
function sendContextGraphAuthorityTransaction<T>(
  write: () => Promise<T>,
  dropProjections: () => void,
): Promise<T> {
  // Also on failure: a submission whose receipt was lost may still have landed.
  return write().finally(dropProjections);
}

function normalizePageBudget(value: number | undefined): number | undefined {
  return Number.isFinite(value) && (value ?? 0) >= 1
    ? Math.floor(value ?? 0)
    : undefined;
}

/**
 * Mode-specific scan policy. Keeping these decisions behind named helpers
 * prevents the page loop from growing another matrix of loosely-related
 * booleans as new registry scan modes are added.
 */
function resumesFromWatermark(mode: ContextGraphRegistryLiveScanMode): boolean {
  return mode === 'incremental' || mode === 'seedFromCursor';
}

function persistsWatermark(mode: ContextGraphRegistryLiveScanMode): boolean {
  return mode !== 'explicitFromBlock' && mode !== 'listAll';
}

function seedsWatermarkAtEnd(mode: ContextGraphRegistryLiveScanMode): boolean {
  return mode === 'seedFull' || mode === 'seedFromCursor' || mode === 'seedLiveTail';
}

function allowsPartialFailure(mode: ContextGraphRegistryLiveScanMode): boolean {
  return mode !== 'explicitFromBlock' && mode !== 'listAll';
}

function buildPublicContextGraphRegistryScanPlan(
  fromBlock: number | undefined,
  options: ContextGraphChainScanOptions | undefined,
): ContextGraphRegistryLiveScanPlan {
  const runtimeOptions = options as
    | (ContextGraphChainScanOptions & { mode?: string })
    | undefined;
  const mode = runtimeOptions?.mode;
  const legacy = runtimeOptions as {
    incremental?: boolean;
    seedIncrementalWatermark?: boolean;
    resumeFromCursor?: boolean;
  } | undefined;
  if (
    mode !== undefined &&
    [legacy?.incremental, legacy?.seedIncrementalWatermark, legacy?.resumeFromCursor]
      .some((value) => value !== undefined)
  ) {
    throw new Error('Context graph list mode cannot be combined with legacy scan flags');
  }
  if (legacy?.incremental === true && legacy.seedIncrementalWatermark === true) {
    throw new Error('Context graph list cannot be both incremental and a watermark seed');
  }
  if (legacy?.resumeFromCursor === true && legacy.seedIncrementalWatermark !== true) {
    throw new Error('resumeFromCursor requires seedIncrementalWatermark');
  }

  if (fromBlock !== undefined) {
    return { mode: 'explicitFromBlock' };
  }

  if (runtimeOptions && 'incremental' in runtimeOptions && runtimeOptions.incremental === true) {
    return { mode: 'incremental', pageBudget: normalizePageBudget(runtimeOptions.pageBudget) };
  }

  if (
    runtimeOptions &&
    'seedIncrementalWatermark' in runtimeOptions &&
    runtimeOptions.seedIncrementalWatermark === true
  ) {
    if (runtimeOptions.resumeFromCursor === true) {
      return {
        mode: 'seedFromCursor',
        pageBudget: normalizePageBudget(runtimeOptions.pageBudget),
      };
    }
    return { mode: 'seedFull' };
  }

  if (mode !== undefined && mode !== 'listAll') {
    throw new Error(
      'listContextGraphsFromChain accepts only listAll or legacy boolean scan options; ' +
      'use scanContextGraphRegistryPages for cursor-backed daemon scans.',
    );
  }

  return { mode: 'listAll' };
}

function buildCursorContextGraphRegistryScanPlan(
  options: ContextGraphRegistryScanOptions,
): ContextGraphRegistryScanPlan {
  if (options.mode === 'incremental') {
    return { mode: 'incremental', pageBudget: normalizePageBudget(options.pageBudget) };
  }

  if (options?.mode === 'seedFull') {
    return { mode: 'seedFull' };
  }

  if (options?.mode === 'seedFromCursor') {
    return { mode: 'seedFromCursor', pageBudget: normalizePageBudget(options.pageBudget) };
  }

  if (options?.mode === 'seedLiveTail') {
    return { mode: 'seedLiveTail', pageBudget: normalizePageBudget(options.pageBudget) };
  }

  if (options?.mode === 'repair') {
    return {
      mode: 'repair',
      pageBudget: normalizePageBudget(options.pageBudget) ?? 1,
      minimumIntervalMs: Number.isFinite(options.minimumIntervalMs)
        && (options.minimumIntervalMs ?? -1) >= 0
        ? Math.floor(options.minimumIntervalMs ?? 0)
        : CONTEXT_GRAPH_REGISTRY_REPAIR_MINIMUM_INTERVAL_MS,
    };
  }

  const exhaustive: never = options;
  throw new Error(`Unsupported ContextGraphNameRegistry scan mode: ${JSON.stringify(exhaustive)}`);
}

export class ContextGraphMethods extends EVMChainAdapterBase {
  /**
   * Legacy cost-independent authorized signer selection. New publish flows use
   * resolvePublisherPublishPlan once byte size is known so signer, lifetime,
   * price, and strict funding are fixed by one adapter operation.
   */
  async getAuthorizedPublisherAddress(contextGraphId: bigint): Promise<string> {
    await this.init();
    return (await this.nextAuthorizedSigner(contextGraphId)).address;
  }

  // =====================================================================
  // Context Graphs (name-hash commitment via ContextGraphNameRegistry)
  //
  // Thin transitional affordance — reserves a bytes32 name-hash with an
  // optional cleartext metadata reveal. Governance for the context graph
  // itself (publish policy, participant agents) lives in `ContextGraphs` /
  // `ContextGraphStorage` — see createOnChainContextGraph.
  // =====================================================================

  async createContextGraph(params: CreateContextGraphParams): Promise<TxResult> {
    await this.init();
    const registry = this.contracts.contextGraphNameRegistry;
    const name = params.name ?? params.metadata?.['name'];
    if (!registry || !name) {
      throw new Error(
        'createContextGraph: requires ContextGraphNameRegistry in Hub and params.name (or metadata.name). ' +
          'Deploy ContextGraphNameRegistry and register it in the Hub, or provide name.',
      );
    }
    const accessPolicy = params.accessPolicy ?? 0;
    const nameHash = ethers.keccak256(ethers.toUtf8Bytes(name));
    const receipt = await this.sendContractTransaction(
      registry,
      'claimName',
      [nameHash, accessPolicy],
      this.signer,
      'claim context graph name',
    );
    if (!receipt) throw new Error('createContextGraph: no receipt');
    let contextGraphIdHex: string | undefined;
    for (const log of receipt.logs) {
      try {
        const parsed = registry.interface.parseLog({ topics: [...log.topics], data: log.data });
        if (parsed?.name === 'NameClaimed') {
          contextGraphIdHex = String(parsed.args.nameHash);
          break;
        }
      } catch { /* not this contract */ }
    }

    // Optionally reveal cleartext metadata on-chain
    if (params.revealOnChain) {
      const description = params.description ?? params.metadata?.['description'] ?? '';
      await this.revealContextGraphMetadata(nameHash, name, description);
    }

    return {
      hash: receipt.hash,
      blockNumber: receipt.blockNumber,
      txIndex: receipt.index,
      success: true,
      contextGraphId: contextGraphIdHex ?? nameHash,
    };
  }

  async submitToContextGraph(_kcId: string, _contextGraphId: string): Promise<TxResult> {
    throw new Error('submitToContextGraph: not yet implemented on EVM adapter (Milestone 5)');
  }

  async revealContextGraphMetadata(contextGraphId: string, name: string, description: string): Promise<TxResult> {
    await this.init();
    const registry = this.contracts.contextGraphNameRegistry;
    if (!registry) throw new Error('revealContextGraphMetadata: ContextGraphNameRegistry not available');
    const receipt = await this.sendContractTransaction(
      registry,
      'revealMetadata',
      [contextGraphId, name, description],
      this.signer,
      'reveal context graph metadata',
    );
    if (!receipt) throw new Error('revealContextGraphMetadata: no receipt');
    return { hash: receipt.hash, blockNumber: receipt.blockNumber, txIndex: receipt.index, success: true };
  }

  async hasContextGraphRegistryScanWatermark(): Promise<boolean> {
    await this.init();
    const registry = this.contracts.contextGraphNameRegistry;
    if (!registry) return false;
    const registryAddress = (await registry.getAddress()).toLowerCase();
    return (await this.contextGraphRegistryScanCursor.loadWatermark(registryAddress)) != null;
  }

  async listContextGraphsFromChain(
    fromBlock?: number,
    options?: ContextGraphChainScanOptions,
  ): Promise<ContextGraphOnChain[]> {
    const scanPlan = buildPublicContextGraphRegistryScanPlan(fromBlock, options);
    await this.init();
    const registry = this.contracts.contextGraphNameRegistry;
    if (!registry) return [];
    const registryAddress = (await registry.getAddress()).toLowerCase();
    return this._collectContextGraphRegistryScan(registry, registryAddress, fromBlock, scanPlan);
  }

  async *scanContextGraphRegistryPages(
    options: ContextGraphRegistryScanOptions,
  ): AsyncIterable<ContextGraphRegistryScanPage> {
    const scanPlan = buildCursorContextGraphRegistryScanPlan(options);
    if (scanPlan.mode === 'repair' && !this.contextGraphRegistryScanCursor.hasDurableRepairAuditStore()) {
      throw new Error(
        'ContextGraphNameRegistry repair requires a durable repairAudit load/save capability',
      );
    }
    await this.init();
    const registry = this.contracts.contextGraphNameRegistry;
    if (!registry) return;
    const registryAddress = (await registry.getAddress()).toLowerCase();
    if (scanPlan.mode === 'repair') {
      yield* this._iterateContextGraphRegistryRepairPages(
        registry,
        registryAddress,
        scanPlan,
        options.signal,
      );
      return;
    }
    yield* this._iterateContextGraphRegistryScanPages(
      registry,
      registryAddress,
      undefined,
      scanPlan,
      options.signal,
    );
  }

  private async _collectContextGraphRegistryScan(
    registry: Contract,
    registryAddress: string,
    fromBlock: number | undefined,
    scanPlan: ContextGraphRegistryLiveScanPlan,
  ): Promise<ContextGraphOnChain[]> {
    const results: ContextGraphOnChain[] = [];
    for await (const page of this._iterateContextGraphRegistryScanPages(
      registry,
      registryAddress,
      fromBlock,
      scanPlan,
    )) {
      results.push(...page.contextGraphs);
      await page.ack();
    }
    return results;
  }

  private async *_iterateContextGraphRegistryScanPages(
    registry: Contract,
    registryAddress: string,
    fromBlock: number | undefined,
    scanPlan: ContextGraphRegistryLiveScanPlan,
    signal?: AbortSignal,
  ): AsyncGenerator<ContextGraphRegistryScanPage, void, unknown> {
    const watermarkOwner = persistsWatermark(scanPlan.mode)
      ? this.contextGraphRegistryScanCursor.beginWatermarkScan(registryAddress)
      : undefined;
    if (persistsWatermark(scanPlan.mode) && watermarkOwner === undefined) {
      throw new Error('ContextGraphNameRegistry live scan already has an active cursor owner');
    }
    try {
      signal?.throwIfAborted();
      const persistedWatermark = (resumesFromWatermark(scanPlan.mode) || seedsWatermarkAtEnd(scanPlan.mode))
        ? await this.contextGraphRegistryScanCursor.loadWatermark(registryAddress)
        : undefined;
      const canResumeFromWatermark = resumesFromWatermark(scanPlan.mode) && persistedWatermark !== undefined;
      const scan = fromBlock === undefined
        ? scanPlan.mode === 'seedLiveTail'
          ? { fromBlock: 0, ...(await this.resolveLogScanHead('listContextGraphsFromChain')) }
          : canResumeFromWatermark
            ? { fromBlock: 0, ...(await this.resolveLogScanHead('listContextGraphsFromChain')) }
            : await this.resolveContractDeployBlock(
                registryAddress,
                'listContextGraphsFromChain',
                'ContextGraphNameRegistry',
              )
        : { fromBlock, ...(await this.resolveLogScanHead('listContextGraphsFromChain')) };
      const { head, scanProviders, degradedFromGenesis = false } = scan;
      // A cursor beyond the current head by more than the normal reorg overlap
      // cannot make progress: every incremental tick would otherwise return
      // before emitting an ACK. Treat it as an authoritative rollback/corruption
      // and replace it store-first while replaying the current protected tail.
      const replaceAheadWatermark = canResumeFromWatermark
        && persistedWatermark! - CG_REGISTRY_REORG_BUFFER_BLOCKS > head;
      const resumeWatermark = replaceAheadWatermark ? head + 1 : persistedWatermark;
      const start = fromBlock ?? (
        scanPlan.mode === 'seedLiveTail'
          ? Math.max(0, scan.head + 1 - CG_REGISTRY_REORG_BUFFER_BLOCKS)
          : canResumeFromWatermark
          ? Math.max(0, resumeWatermark! - CG_REGISTRY_REORG_BUFFER_BLOCKS)
          : scan.fromBlock
      );

      if (start > head) {
        if (seedsWatermarkAtEnd(scanPlan.mode)) {
          await this.contextGraphRegistryScanCursor.saveWatermark(registryAddress, head + 1, {
            owner: watermarkOwner,
            replace: replaceAheadWatermark,
          });
        }
        return;
      }

      const pageSize = this.cgRegistryScanPageSize;
      const pages = Math.ceil((head - start + 1) / pageSize);
      const budgetedNextBlock = scanPlan.pageBudget === undefined
        ? undefined
        : start + scanPlan.pageBudget * pageSize;
      const budgetStopsBeforeHead = scanPlan.pageBudget !== undefined
        && pages > scanPlan.pageBudget;
      const budgetCannotAdvanceWatermark = budgetStopsBeforeHead
        && canResumeFromWatermark
        && budgetedNextBlock! <= persistedWatermark!;
      if (
        (scanPlan.mode === 'seedLiveTail' && budgetStopsBeforeHead)
        || budgetCannotAdvanceWatermark
      ) {
        throw new Error(
          `listContextGraphsFromChain: live page budget ${scanPlan.pageBudget} at `
            + `${pageSize} block(s)/page cannot cover the reorg overlap/current-head progression `
            + `(start ${start}, head ${head}, watermark ${persistedWatermark ?? 'none'}). `
            + `Increase cgRegistryScanPageSize or the live page budget so one invocation can `
            + `reach the current head or advance beyond the durable watermark.`,
        );
      }
      const blockBudget = CG_REGISTRY_MAX_SCAN_PAGES * pageSize;
      if (scanPlan.mode === 'incremental' && scanPlan.pageBudget === undefined && !degradedFromGenesis && pages > CG_REGISTRY_MAX_SCAN_PAGES) {
        throw new Error(
          `listContextGraphsFromChain: incremental ContextGraphNameRegistry scan would need ` +
            `${pages} eth_getLogs calls over blocks [${start}, ${head}] at a ` +
            `${pageSize}-block window (budget ${CG_REGISTRY_MAX_SCAN_PAGES} pages / ` +
            `${blockBudget} blocks). ` +
            `Use an RPC that can anchor the registry deploy block and serve the ` +
            `requested log range, or increase cgRegistryScanPageSize for an RPC ` +
            `known to support larger ranges.`,
        );
      }

      yield* this._iterateContextGraphRegistryRangePages({
        registry,
        start,
        head,
        scanProviders,
        mode: scanPlan.mode === 'explicitFromBlock' ? 'listAll' : scanPlan.mode,
        pageBudget: scanPlan.pageBudget,
        allowPartialFailure: allowsPartialFailure(scanPlan.mode),
        rpcUsageConsumer: 'listContextGraphsFromChain',
        targetBlock: head,
        completesGeneration: () => false,
        signal,
        acknowledge: persistsWatermark(scanPlan.mode)
          ? (() => {
              let replace = replaceAheadWatermark;
              return async (_fromBlock: number, toBlock: number) => {
                await this.contextGraphRegistryScanCursor.saveWatermark(registryAddress, toBlock + 1, {
                  owner: watermarkOwner,
                  replace,
                });
                replace = false;
              };
            })()
          : async () => {},
      });
    } finally {
      if (watermarkOwner !== undefined) {
        this.contextGraphRegistryScanCursor.closeWatermarkScan(registryAddress, watermarkOwner);
      }
    }
  }

  private async *_iterateContextGraphRegistryRepairPages(
    registry: Contract,
    registryAddress: string,
    scanPlan: ContextGraphRegistryRepairScanPlan,
    signal?: AbortSignal,
  ): AsyncGenerator<ContextGraphRegistryScanPage, void, unknown> {
    const session = await this.contextGraphRegistryRepairCoordinator.begin({
      registryAddress,
      minimumIntervalMs: scanPlan.minimumIntervalMs,
      signal,
      resolveHead: () => this.resolveLogScanHead('repairContextGraphRegistry'),
      resolveDeployment: () => this.resolveContractDeployBlock(
        registryAddress,
        'repairContextGraphRegistry',
        'ContextGraphNameRegistry',
      ),
    });
    if (!session) return;
    try {
      yield* this._iterateContextGraphRegistryRangePages({
        registry,
        start: session.startBlock,
        head: session.range.head,
        scanProviders: session.range.scanProviders,
        mode: 'repair',
        pageBudget: scanPlan.pageBudget,
        allowPartialFailure: true,
        rpcUsageConsumer: 'repairContextGraphRegistry',
        targetBlock: session.targetBlock,
        completesGeneration: (toBlock) => toBlock >= session.targetBlock,
        signal,
        acknowledge: (fromBlock, toBlock) => session.acknowledge(fromBlock, toBlock),
      });
    } finally {
      session.close();
    }
  }

  private async *_iterateContextGraphRegistryRangePages(input: {
    registry: Contract;
    start: number;
    head: number;
    scanProviders: ReadonlyArray<ScanProvider>;
    mode: ContextGraphRegistryScanOptions['mode'] | 'listAll';
    pageBudget?: number;
    allowPartialFailure: boolean;
    rpcUsageConsumer: 'listContextGraphsFromChain' | 'repairContextGraphRegistry';
    targetBlock: number;
    completesGeneration(toBlock: number): boolean;
    signal?: AbortSignal;
    acknowledge(fromBlock: number, toBlock: number): Promise<void>;
  }): AsyncGenerator<ContextGraphRegistryScanPage, void, unknown> {
    const eventFilter = input.registry.filters.NameClaimed();
    const { registry, start, head, scanProviders } = input;
    const pageSize = this.cgRegistryScanPageSize;

    const results: ContextGraphOnChain[] = [];
    const connected = new Map<JsonRpcProvider, Contract>();
    let preferred: JsonRpcProvider | undefined;
    let scannedAnyPage = false;

    // Daemon scans can resume from the scanned prefix after a later page
    // failure. Public list-all calls should remain all-or-error.
    for (let lo = start; lo <= head; lo += pageSize) {
      input.signal?.throwIfAborted();
      const hi = Math.min(lo + pageSize - 1, head);
      let pageResults: ContextGraphOnChain[];
      try {
        const page = await this.queryEventLogsPage(
          registry,
          eventFilter,
          lo,
          hi,
          scanProviders,
          connected,
          'listContextGraphsFromChain NameClaimed',
          preferred,
          input.rpcUsageConsumer,
        );
        preferred = page.provider;
        pageResults = [];
        for (const log of page.logs) {
          const parsed = registry.interface.parseLog({ topics: [...log.topics], data: log.data });
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
        input.signal?.throwIfAborted();
        if (input.allowPartialFailure && scannedAnyPage) {
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
      const scannedPages = Math.floor((hi - start) / pageSize) + 1;
      const acknowledgement = {
        state: 'pending' as 'pending' | 'saving' | 'saved' | 'failed',
      };
      yield {
        contextGraphs: pageResults,
        scanProgress: Object.freeze({
          mode: input.mode,
          page: scannedPages,
          ...(input.pageBudget !== undefined ? { pageBudget: input.pageBudget } : {}),
          fromBlock: lo,
          toBlock: hi,
          targetBlock: input.targetBlock,
          completesGeneration: input.completesGeneration(hi),
        }),
        ack: async () => {
          if (acknowledgement.state !== 'pending') {
            throw new Error(
              `ContextGraphNameRegistry page [${lo}, ${hi}] acknowledgement is `
              + `${acknowledgement.state}; each page may be acknowledged exactly once`,
            );
          }
          acknowledgement.state = 'saving';
          try {
            input.signal?.throwIfAborted();
            await input.acknowledge(lo, hi);
            acknowledgement.state = 'saved';
          } catch (error) {
            acknowledgement.state = 'failed';
            throw error;
          }
        },
      };
      if (acknowledgement.state !== 'saved') {
        throw new Error(
          `ContextGraphNameRegistry page [${lo}, ${hi}] must be acknowledged before scanning continues`,
        );
      }
      if (input.pageBudget !== undefined && scannedPages >= input.pageBudget && hi < head) return;
    }

  }

  // =====================================================================
  // On-Chain Context Graphs (ContextGraphs contract)
  // =====================================================================

  /** True when `contextGraphId` is an active minted CG in ContextGraphStorage. */
  async isContextGraphActiveOnChain(
    contextGraphId: bigint,
    options: ChainReadOptions = {},
  ): Promise<boolean> {
    await this.init();
    const cgs = this.requireContextGraphStorage();
    return Boolean(await this.readContractWithOptions(
      cgs,
      'cgStorage.isContextGraphActive',
      'isContextGraphActive',
      [contextGraphId],
      { signal: options.signal },
    ));
  }

  /**
   * One `getContextGraph` read at `latest`; see
   * ChainAdapter.getContextGraphLiveAuthority.
   *
   * Callers asking for the SAME graph at the same moment share one physical
   * read through the coalescer. Nothing is retained: a caller arriving after
   * that read started never receives it, so this stays a live read with zero
   * staleness — which is what lets the security gates above it use it. See
   * `context-graph-live-authority-coalescer.ts`.
   */
  async getContextGraphLiveAuthority(
    contextGraphId: bigint,
    options: ContextGraphLiveAuthorityReadOptions = {},
  ): Promise<ContextGraphLiveAuthority | null> {
    await this.init();
    const cgs = this.requireContextGraphStorage();
    // BEFORE THE COALESCER, AND THAT IS THE WHOLE POINT.
    //
    // `flightKey` below carries no freshness component, so a bounded answer
    // placed inside `run()` would be handed to every caller sharing that key —
    // including a live one that asked precisely because its decision cannot
    // tolerate a stale roster. The coalescer's contract, stated in its own
    // header and in the docstring above, is that it only ever carries reads
    // with zero staleness; that is what lets the security gates use it.
    //
    // So a bounded read is answered here or not at all. A miss simply falls
    // through to the live read below, unchanged.
    if (this.contextGraphBoundedAuthorityReadsEnabled
      && options.freshness === 'bounded') {
      const peeked = await this.contextGraphAuthorityIndexReader
        ?.peekContextGraphLiveAuthority(contextGraphId, { signal: options.signal });
      // `undefined` is "the index cannot answer", never "no such graph": the
      // caller falls back to the chain rather than inheriting a conclusion the
      // index never reached.
      if (peeked !== undefined) return peeked;
    }
    // Full lineage, never the bare numeric id: ContextGraphStorage hands out
    // sequential ids, so another deployment reuses them freely.
    const flightKey = [
      this.deploymentId,
      (await cgs.getAddress()).toLowerCase(),
      contextGraphId.toString(10),
    ].join(':');
    return this.contextGraphLiveAuthorityCoalescer.run(
      flightKey,
      async (flightSignal) => {
        let raw: unknown;
        try {
          raw = await this.readContractWithOptions(
            cgs,
            CONTEXT_GRAPH_AUTHORITY_FUNNEL_RPC_CONSUMER,
            'getContextGraph',
            [contextGraphId],
            {
              signal: flightSignal,
              // The agent's live authority gate fails closed after 2.5s. A
              // normal point read gives one endpoint 4s, so its caller abort
              // would pre-empt transport failover. This named policy lets a
              // stalled endpoint yield to a configured fallback while keeping
              // the outer security deadline unchanged.
              policy: 'securityGatePointRead',
            },
          );
        } catch (err) {
          if (flightSignal.aborted) throw err;
          if (isNonexistentContextGraphRevert(err, contextGraphId)) return null;
          if (isLiveAuthorityReadTransient(err)) throw err;
          throw new ContextGraphLiveAuthorityUnsupportedError(rpcErrorMessage(err), { cause: err });
        }
        return decodeContextGraphLiveAuthority(raw, contextGraphId);
      },
      {
        signal: options.signal,
        ...(options.requestClass === undefined ? {} : { requestClass: options.requestClass }),
      },
    );
  }

  async createOnChainContextGraph(params: CreateOnChainContextGraphParams): Promise<CreateOnChainContextGraphResult> {
    await this.init();
    if (!this.contracts.contextGraphs || !this.contracts.contextGraphStorage) {
      throw new Error('ContextGraphs contract not deployed. Deploy ContextGraphs and ContextGraphStorage first.');
    }

    if (params.accessPolicy === undefined || params.publishPolicy === undefined) {
      throw new Error(
        'createOnChainContextGraph: `accessPolicy` and `publishPolicy` are required (SPEC_CG_MEMORY_MODEL). ' +
        'Pass both explicitly — e.g. { accessPolicy: 1, publishPolicy: 0 } for invite-only + curators-only.',
      );
    }

    const contextGraphs = this.contracts.contextGraphs;
    const createArgs = [
      params.participantAgents ?? [],
      params.metadataBatchId ?? 0n,
      params.accessPolicy,
      params.publishPolicy,
      params.publishAuthority ?? ethers.ZeroAddress,
      params.publishAuthorityAccountId ?? 0n,
      // OT-RFC-38 / LU-6 Phase B — opt-in wire-id commitment. Default
      // `bytes32(0)` opts out; the agent supplies a non-zero hash
      // (typically `keccak256(bytes(cleartextId))`) to enable cores'
      // chain-event-driven host-mode auto-subscribe path.
      params.nameHash ?? ethers.ZeroHash,
    ];
    const submitCreate = () =>
      this.sendContractTransaction(
        contextGraphs,
        'createContextGraph',
        createArgs,
        this.signer,
        'create on-chain context graph',
      );

    // OT-RFC-53: when the registration deposit is active, createContextGraph
    // pulls it via transferFrom and reverts until the ContextGraphs facade is
    // approved. Recover LAZILY (mirrors the publish/update #888 allowance
    // recovery): on a first-attempt revert, if a deposit is actually configured,
    // approve it to the facade and retry once. The common path (deposit dormant)
    // is a single tx with NO extra eth_call, so it never perturbs timing-
    // sensitive integration tests.
    const receipt = await sendContextGraphAuthorityTransaction(
      async () => {
        try {
          return await submitCreate();
        } catch (err) {
          // Only the deposit-allowance revert is recoverable here. Mirror the
          // publish/update allowance recovery (`isTooLowAllowanceError`): an
          // unrelated first-attempt revert (invalid access/publish policy, PCA
          // coherence failure, paused contract, insufficient balance, RPC error)
          // must NOT trigger a state-changing TRAC approval before re-failing.
          if (!isTooLowAllowanceError(err)) {
            throw err;
          }
          // #1340: read the deposit through the RPC-failover facade (`readContract`),
          // NOT a bare call on the signer's primary-bound `parametersStorage` handle.
          // A broken primary otherwise throws here → is swallowed to 0n → the TRAC
          // approve + retry below never run, defeating failover for a new CG's first
          // publish. `readContract` fails over on transport errors (429/5xx/timeout)
          // and rethrows a decoded revert unchanged; the catch → 0n now fires only
          // when ALL endpoints fail or the deposit is genuinely dormant.
          const ps = this.contracts.parametersStorage as Contract | undefined;
          let deposit = 0n;
          try {
            deposit = ps
              ? await this.readContract<bigint>(
                  ps,
                  'parametersStorage.contextGraphRegistrationDeposit',
                  'contextGraphRegistrationDeposit',
                )
              : 0n;
          } catch {
            deposit = 0n;
          }
          if (deposit === 0n) throw err;
          try {
            await this.ensureV10ApproveTrac(
              this.signer,
              await contextGraphs.getAddress(),
              deposit,
              'cg registration deposit',
              true,
            );
          } catch (approvalError) {
            // The initial create attempt has definitively reverted with
            // TooLowAllowance and the retry has not been submitted yet. Even if
            // the approval receipt itself is ambiguous, it cannot have created
            // the Context Graph. Preserve that distinction for the agent's
            // durable registration state machine.
            throw markContextGraphRegistrationNotSubmitted(approvalError);
          }
          return submitCreate();
        }
      },
      () => this.contextGraphAuthorityIndex?.dropProjections(),
    );

    let contextGraphId: bigint | undefined;
    for (const log of receipt.logs) {
      try {
        const parsed = this.contracts.contextGraphStorage!.interface.parseLog({
          topics: [...log.topics],
          data: log.data,
        });
        if (parsed?.name === 'ContextGraphCreated') {
          contextGraphId = BigInt(parsed.args.contextGraphId);
          break;
        }
      } catch { /* not this contract */ }
    }

    if (contextGraphId === undefined) {
      return {
        hash: receipt.hash,
        blockNumber: receipt.blockNumber,
        txIndex: receipt.index,
        success: false,
        contextGraphId: 0n,
      };
    }

    return {
      hash: receipt.hash,
      blockNumber: receipt.blockNumber,
      txIndex: receipt.index,
      success: receipt.status === 1,
      contextGraphId,
    };
  }

  async addContextGraphParticipantAgent(contextGraphId: bigint, agent: string): Promise<TxResult> {
    await this.init();
    const contextGraphs = this.contracts.contextGraphs;
    if (!contextGraphs) {
      throw new Error('ContextGraphs contract not deployed.');
    }
    const receipt = await sendContextGraphAuthorityTransaction(
      () => this.sendContractTransaction(
        contextGraphs,
        'addParticipantAgent' satisfies ContextGraphAuthorityMutation,
        [contextGraphId, ethers.getAddress(agent)],
        this.signer,
        'add context graph participant agent',
      ),
      () => this.contextGraphAuthorityIndex?.dropProjections(),
    );
    return {
      hash: receipt.hash,
      blockNumber: receipt.blockNumber,
      txIndex: receipt.index,
      success: receipt.status === 1,
    };
  }

  async removeContextGraphParticipantAgent(contextGraphId: bigint, agent: string): Promise<TxResult> {
    await this.init();
    const contextGraphs = this.contracts.contextGraphs;
    if (!contextGraphs) {
      throw new Error('ContextGraphs contract not deployed.');
    }
    const receipt = await sendContextGraphAuthorityTransaction(
      () => this.sendContractTransaction(
        contextGraphs,
        'removeParticipantAgent' satisfies ContextGraphAuthorityMutation,
        [contextGraphId, ethers.getAddress(agent)],
        this.signer,
        'remove context graph participant agent',
      ),
      () => this.contextGraphAuthorityIndex?.dropProjections(),
    );
    return {
      hash: receipt.hash,
      blockNumber: receipt.blockNumber,
      txIndex: receipt.index,
      success: receipt.status === 1,
    };
  }

  async verify(params: VerifyParams): Promise<TxResult> {
    await this.init();
    if (!this.contracts.contextGraphs) {
      throw new Error('ContextGraphs contract not deployed.');
    }

    const receipt = await this.sendContractTransaction(
      this.contracts.contextGraphs,
      'registerKnowledgeAsset',
      [params.contextGraphId, params.batchId],
      this.signer,
      'register knowledge collection',
    );

    return {
      hash: receipt.hash,
      blockNumber: receipt.blockNumber,
      txIndex: receipt.index,
      success: receipt.status === 1,
    };
  }

  async publishToContextGraph(params: PublishToContextGraphParams): Promise<OnChainPublishResult> {
    await this.init();
    if (!this.contracts.knowledgeAssets) {
      throw new Error('KnowledgeAssets contract not deployed.');
    }
    if (!this.contracts.knowledgeAssetsStorage) {
      throw new Error('KnowledgeAssetsStorage contract not deployed (required for log parsing).');
    }

    // V9→V10 mirror — NOT SUPPORTED under OT-RFC-43 Option-1 / §F2. A V10
    // Knowledge Asset id is author-namespaced and the AuthorAttestation digest
    // binds the reserved packed kaId; this legacy mirror has no allocator and no
    // reserved id to sign over, so it cannot synthesize a mintable attestation
    // (the on-chain createKnowledgeAssets rejects a namespace-mismatched id).
    // Publish through the V10 lifecycle (finalize → swm/share → vm/publish).
    //
    // This guard MUST run before ANY on-chain side effect (the TRAC approve and
    // the legacy `ka.publishToContextGraph` tx below): throwing after the send
    // would leave a partially-applied publish on-chain and invite duplicate
    // publishes on caller retry.
    throw new Error(
      'publishToContextGraph (V9→V10 mirror) is not supported under OT-RFC-43 Option-1: ' +
        'publish through the V10 lifecycle (finalize → swm/share → vm/publish), which allocates ' +
        'and binds the per-author reservedKaId into the author attestation.',
    );

    const signer = await this.nextAuthorizedSigner(params.contextGraphId);
    const receiverIdentityIds = params.receiverSignatures.map((s) => s.identityId);
    const receiverRs = params.receiverSignatures.map((s) => ethers.hexlify(s.r));
    const receiverVSs = params.receiverSignatures.map((s) => ethers.hexlify(s.vs));
    const participantIdentityIds = params.participantSignatures.map((s) => s.identityId);
    const participantRs = params.participantSignatures.map((s) => ethers.hexlify(s.r));
    const participantVSs = params.participantSignatures.map((s) => ethers.hexlify(s.vs));

    // Non-null assertions: the guards above (and the unsupported-mirror throw)
    // make this block unreachable, so TS no longer carries the `knowledgeAssets`/
    // `token` presence narrowing here. Kept for type-completeness until the
    // mirror is removed.
    const ka = this.contracts.knowledgeAssets!.connect(signer) as any;
    const kaAddress = await this.contracts.knowledgeAssets!.getAddress();

    if (this.contracts.token && params.tokenAmount > 0n) {
      const token = this.contracts.token!.connect(signer) as Contract;
      const currentAllowance: bigint = await token.allowance(signer.address, kaAddress);
      if (currentAllowance < params.tokenAmount) {
        await this.sendContractTransaction(
          token,
          'approve',
          [kaAddress, ethers.MaxUint256],
          signer,
          'approve context graph publish TRAC',
        );
      }
    }

    const tx = await ka.publishToContextGraph(
      params.kaCount,
      params.publisherNodeIdentityId,
      ethers.hexlify(params.merkleRoot),
      params.publicByteSize,
      params.epochs,
      params.tokenAmount,
      ethers.ZeroAddress,
      ethers.hexlify(params.publisherSignature.r),
      ethers.hexlify(params.publisherSignature.vs),
      receiverIdentityIds,
      receiverRs,
      receiverVSs,
      params.contextGraphId,
      participantIdentityIds,
      participantRs,
      participantVSs,
    );

    const ackSignatures = [
      ...params.receiverSignatures,
      ...params.participantSignatures,
    ].filter((s, i, arr) =>
      i === arr.findIndex((a) => a.identityId === s.identityId),
    );

    // V9→V10 mirror: RandomSampling reads `merkleLeafCount` from on-chain
    // storage to pick `chunkId`. Silently writing 1 here would brick every
    // bridged KC whose flat-KC tree has more than one leaf (the prover
    // would request a chunk past the tree's leaf range). Refuse to mirror
    // if the caller didn't supply the real count.
    if (
      typeof params.merkleLeafCount !== 'number'
      || !Number.isInteger(params.merkleLeafCount)
      || params.merkleLeafCount < 1
    ) {
      throw new Error(
        'publishToContextGraph: missing/invalid merkleLeafCount. '
        + 'V10 mirror requires the caller to supply the V10MerkleTree leaf count '
        + '(integer ≥ 1). Hard-coding would corrupt RandomSampling chunk selection.',
      );
    }

    // Unreachable below (kept for type-completeness until the mirror is removed);
    // the unsupported-mirror guard above throws before any on-chain side effect.
    const v10ChainId = await this.getEvmChainId();
    const v10KavAddress = await this.contracts.knowledgeAssetsLifecycle!.getAddress();
    const authorTypedData = buildAuthorAttestationTypedData({
      chainId: v10ChainId,
      kav10Address: v10KavAddress,
      // #1116: AuthorAttestation no longer binds contextGraphId.
      merkleRoot: params.merkleRoot,
      authorAddress: signer.address,
      reservedKaId: 0n,
    });
    const authorSig = ethers.Signature.from(
      await signer.signTypedData(
        authorTypedData.domain,
        authorTypedData.types,
        authorTypedData.message,
      ),
    );

    return this.createKnowledgeAssets({
      publishOperationId: ethers.hexlify(ethers.randomBytes(32)),
      contextGraphId: params.contextGraphId,
      merkleRoot: params.merkleRoot,
      knowledgeAssetsAmount: params.kaCount,
      byteSize: params.publicByteSize,
      epochs: params.epochs,
      tokenAmount: params.tokenAmount,
      merkleLeafCount: params.merkleLeafCount,
      isImmutable: false,
      publisherNodeIdentityId: params.publisherNodeIdentityId,
      author: {
        address: signer.address,
        signature: {
          r: ethers.getBytes(authorSig.r),
          vs: ethers.getBytes(authorSig.yParityAndS),
        },
        schemeVersion: AUTHOR_SCHEME_VERSION_V1,
      },
      ackSignatures,
    });
  }

  /**
   * Two positive `ContextGraphStorage` views below read the ONE log first.
   *
   * `latest`, not `finalized`, and that is what makes them stand in for the
   * call at all: each one replaces an UNPINNED `eth_call`, answered at the
   * chain's current head with that head's tip-reorg exposure. Reading them at
   * the settled cursor instead would be a DIFFERENT answer, fifty blocks behind
   * the call it replaces, and a KA registered inside that window would read as
   * not registered.
   *
   * THE EXPOSURE IS THAT CALL'S WINDOW PLUS UP TO ONE TICK INTERVAL, and it is
   * worth stating plainly rather than claiming parity. An `eth_call` self-heals
   * the moment its endpoint follows a reorg; a tail row does not disappear
   * until the tick's NEXT pass replaces the tail wholesale, so a registration
   * orphaned by a tip reorg can still be folded into a positive `bound` or a
   * known ordinal for up to `chain.indexTickMs`. The module's
   * write-once justification (knowledge-asset-read-model.ts) is about a SETTLED
   * row and does not cover the tail. Bounded by the tick's own liveness gate,
   * not attacker-choosable — the id must have been emitted on a fork this
   * node's own tick followed — and `verifyContextGraphBinding` still
   * cross-checks the local id on the admission path this reaches.
   *
   * Negative bindings and counts never use the log: unlike a durable positive
   * binding or already-known ordinal, they may change in the block immediately
   * after the tick's head observation. Every other refusal — a cold log, a
   * stalled tick, a held fork suspicion, a backfill that has not reached the
   * graph's creation block, an ordinal past what the log holds — runs the
   * `eth_call` exactly as it did before the log existed.
   */
  private async knowledgeAssetsFromLogFor(contract: Contract) {
    const binding = this.chainEventLogBinding;
    if (binding?.knowledgeAssets === undefined
      || binding.contextGraphStorageAddress === undefined) return undefined;
    let currentAddress: string;
    try {
      currentAddress = (await contract.getAddress()).toLowerCase();
    } catch {
      return undefined;
    }
    // A Hub self-heal may resolve the successor before the detached one-log
    // runtime has rebuilt. Never answer the successor from the retired proxy's
    // folded rows; an address mismatch takes the existing live eth_call below.
    return binding.contextGraphStorageAddress === currentAddress
      ? { binding, readModel: binding.knowledgeAssets }
      : undefined;
  }

  async getKAContextGraphId(kaId: bigint, options: ChainReadOptions = {}): Promise<bigint> {
    await this.init();
    const cgs = this.requireContextGraphStorage();
    const knowledgeAssetsFromLog = await this.knowledgeAssetsFromLogFor(cgs);
    const logged = await knowledgeAssetsFromLog?.readModel.readContextGraphForKa(
      kaId,
      { view: 'latest' },
    );
    if (logged !== undefined
      && knowledgeAssetsFromLog !== undefined
      && this.chainEventLogBindingIsCurrent(knowledgeAssetsFromLog.binding)) {
      return logged.contextGraphId;
    }
    const cgId: bigint = await this.readContractWithOptions(
      cgs,
      'cgStorage.kaToContextGraph',
      'kaToContextGraph',
      [kaId],
      { signal: options.signal },
    );
    return BigInt(cgId);
  }

  async getContextGraphKCCount(contextGraphId: bigint): Promise<bigint> {
    await this.init();
    // Count is mutable. Even complete coverage only proves the tick's last
    // observed head, while this unpinned call must include a registration that
    // lands immediately afterwards. Keep the live call for that distinction.
    const cgs = this.requireContextGraphStorage();
    const count: bigint = await this.readContract(
      cgs, 'cgStorage.getContextGraphKaCount', 'getContextGraphKaCount', contextGraphId,
    );
    return BigInt(count);
  }

  async getContextGraphKCAt(contextGraphId: bigint, index: bigint): Promise<bigint> {
    await this.init();
    const cgs = this.requireContextGraphStorage();
    const knowledgeAssetsFromLog = await this.knowledgeAssetsFromLogFor(cgs);
    // One ordinal, not the list: the read model answers it from its per-graph
    // ordinal cache, so a walk over a graph's ordinals costs one fold per log
    // revision instead of one per ordinal (scalar read from PR #2784).
    const logged = await knowledgeAssetsFromLog?.readModel.readContextGraphKaAt(
      contextGraphId,
      index,
      { view: 'latest' },
    );
    // Position IS the ordinal — the on-chain list only ever appends. An index
    // the log does not hold is NOT an out-of-range answer to invent: the chain
    // reverts on one, and callers read that revert, so the call below must be
    // the thing that produces it. The read model returns `undefined` for it.
    if (logged !== undefined
      && knowledgeAssetsFromLog !== undefined
      && this.chainEventLogBindingIsCurrent(knowledgeAssetsFromLog.binding)) {
      return logged.kaId;
    }
    const kaId: bigint = await this.readContract(
      cgs, 'cgStorage.getContextGraphKaAt', 'getContextGraphKaAt', contextGraphId, index,
    );
    return BigInt(kaId);
  }

  /**
   * OT-RFC-38 / LU-5: chain-backed access-policy oracle for cores.
   * `ContextGraphStorage.getAccessPolicy` returns the uint8 enum
   * (`0`=public, `1`=curated). Unregistered ids return `0` (Solidity
   * default-zero mapping); callers should treat that as "public /
   * unknown" — for the encrypted-payload guard, `0` MUST NOT be
   * interpreted as a positive curation signal.
   */
  async getContextGraphAccessPolicy(
    contextGraphId: bigint,
    options: ChainReadOptions = {},
  ): Promise<number> {
    await this.init();
    const cgs = this.requireContextGraphStorage();
    try {
      const raw: bigint = BigInt(await this.readContractWithOptions(
        cgs,
        'cgStorage.getAccessPolicy',
        'getAccessPolicy',
        [contextGraphId],
        { signal: options.signal },
      ));
      return Number(raw);
    } catch (primaryErr) {
      if (options.signal?.aborted) throw primaryErr;
      try {
        const cg = await this.readContractWithOptions(
          cgs,
          CONTEXT_GRAPH_AUTHORITY_FUNNEL_RPC_CONSUMER,
          'getContextGraph',
          [contextGraphId],
          { signal: options.signal },
        );
        const raw =
          cg?.accessPolicy
          ?? (Array.isArray(cg) ? cg[CONTEXT_GRAPH_TUPLE_INDEX.accessPolicy] : undefined);
        if (raw === undefined || raw === null) {
          throw new Error('ContextGraphStorage.getContextGraph returned no accessPolicy field');
        }
        return Number(BigInt(raw));
      } catch (fallbackErr) {
        if (options.signal?.aborted) throw fallbackErr;
        throw new Error(
          `ContextGraphStorage access-policy lookup failed via getAccessPolicy and getContextGraph fallback: ` +
          `${primaryErr instanceof Error ? primaryErr.message : String(primaryErr)}; ` +
          `fallback: ${fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)}`,
        );
      }
    }
  }

  /**
   * Issue #872 / Codex round-3 — chain-backed publish-policy oracle
   * for non-creator peers. `ContextGraphStorage.getPublishPolicy`
   * returns the tuple `(uint8 publishPolicy, address publishAuthority)`.
   * `publishPolicy: 0` = curators-only, `1` = open. Unregistered ids
   * return `(0, address(0))` from Solidity's default-zero mapping —
   * the caller is responsible for cross-checking registration
   * status before treating that as a positive "curators-only" signal.
   */
  async getContextGraphPublishPolicy(contextGraphId: bigint): Promise<{
    publishPolicy: number;
    publishAuthority: string;
  }> {
    await this.init();
    const cgs = this.requireContextGraphStorage();
    const result = await this.readContract(
      cgs, 'cgStorage.getPublishPolicy', 'getPublishPolicy', contextGraphId,
    );
    // Ethers v6 returns named tuple as both array and object access;
    // destructure positionally to stay robust against ABI naming
    // changes.
    const rawPolicy: bigint = BigInt(result[0] ?? result.publishPolicy ?? 0);
    const rawAuthority: string = String(result[1] ?? result.publishAuthority ?? ethers.ZeroAddress);
    return {
      publishPolicy: Number(rawPolicy),
      publishAuthority: ethers.getAddress(rawAuthority),
    };
  }

  /**
   * OT-RFC-38 / LU-6 Phase B — chain-backed participant-agent
   * allowlist read. Mirrors {@link getContextGraphAccessPolicy}
   * (single eth_call, used as the authoritative oracle when the
   * local store has no answer).
   *
   * `ContextGraphStorage.getParticipantAgents` returns the address
   * array as registered at create time. Empty array for unregistered
   * ids or CGs that genuinely have no agents (the Solidity getter
   * just returns the stored mapping; absent ids return zero-length).
   * Addresses are returned in EIP-55 checksum form to keep callers
   * consistent with the local-store accessor.
   */
  async getContextGraphParticipantAgents(contextGraphId: bigint): Promise<string[]> {
    await this.init();
    const cgs = this.requireContextGraphStorage();
    const raw: string[] = await this.readContract(
      cgs, 'cgStorage.getParticipantAgents', 'getParticipantAgents', contextGraphId,
    );
    return raw.map((addr: string) => ethers.getAddress(addr));
  }

  /**
   * Resolve policy, membership, and their stable event-derived generations at
   * ONE anchor block, selected by `chain.finalityConfirmations` — the node's
   * single definition of finality (see evm-finality-anchor.ts). The event
   * generation (rather than the observation block) keeps independently booted
   * RFC-64 peers on the same policy digest: every field the digest is built
   * from is event-derived, so peers agree once they have observed the same
   * events, and never needed to agree on an observation bound.
   */
  async getContextGraphAuthoritySnapshot(
    contextGraphId: bigint,
    options: ContextGraphAuthorityReadOptions = {},
  ): Promise<ContextGraphAuthoritySnapshot> {
    await this.init();
    options.signal?.throwIfAborted();
    const indexReader = this.contextGraphAuthorityIndexReader;
    if (indexReader !== undefined) {
      return indexReader.readContextGraphAuthoritySnapshot(contextGraphId, options);
    }
    const base = this.requireContextGraphStorage();
    return this.readTipProvider(
      'getContextGraphAuthoritySnapshot',
      async (provider) => {
        options.signal?.throwIfAborted();
        // One anchor for the whole snapshot, at the operator-configured finality
        // depth rather than at the endpoint's `finalized` tag. The docstring's
        // "one finalized block" buys INTRA-snapshot coherence; peer agreement
        // comes from the event-derived generations below, never from the
        // observation bound (two peers reading the `finalized` tag at different
        // wall-clock times never shared a bound either).
        const finalized = await resolveEvmFinalityAnchorBlockV1({
          finalityConfirmations: this.finalityConfirmations,
          readHead: () => provider.getBlock('latest'),
          readBlockAt: (anchorBlockNumber) => provider.getBlock(anchorBlockNumber),
          unavailable: contextGraphAuthorityAnchorUnavailableV1,
        });
        const finalizedHash = finalized.hash;
        const contract = base.connect(provider) as Contract;
        const filters = contract.filters as unknown as Record<
          string,
          (...args: unknown[]) => ethers.DeferredTopicFilter
        >;
        const contractAddress = (await contract.getAddress()).toLowerCase();
        const readCurrentState = () => (contract.getContextGraph as ethers.ContractMethod).staticCall(
          contextGraphId,
          { blockTag: finalized.number },
        );
        const cache = this.contextGraphAuthorityHistory;
        const cacheKey = [
          this.deploymentId,
          contractAddress,
          contextGraphId.toString(10),
        ].join(':');
        const authorityFilters = new Map<string, ethers.DeferredTopicFilter>();
        const readAuthorityEvents = async (
          name: 'ContextGraphCreated' | ContextGraphAuthorityHistoryEventQuery['name'],
          targetContextGraphId: bigint,
          fromBlock: number,
          toBlock: number,
        ): Promise<ethers.EventLog[]> => {
          let filter = authorityFilters.get(name);
          if (filter === undefined) {
            filter = name === 'Transfer'
              ? filters[name]!(null, null, targetContextGraphId)
              : filters[name]!(targetContextGraphId);
            authorityFilters.set(name, filter);
          }
          return readAdaptiveEvmLogRange({
            read: async (rangeFrom, rangeTo) => (
              (await contract.queryFilter(filter!, rangeFrom, rangeTo))
                .map((rawEvent) => rawEvent as ethers.EventLog)
            ),
            fromBlock,
            toBlock,
            signal: options.signal,
            provider,
          });
        };
        const readAuthorityHistory = () => resolveContextGraphAuthorityHistory({
          cache,
          cacheKey,
          readScope: provider,
          contextGraphId,
          finalized: { number: finalized.number, hash: finalizedHash },
          pageSize: this.cgRegistryScanPageSize,
          signal: options.signal,
          loadColdFromBlock: () => this.resolveContractDeployBlockNumber(
            contractAddress,
            'getContextGraphAuthoritySnapshot',
            'ContextGraphStorage',
          ),
          readBlockHash: async (blockNumber) => (
            (await provider.getBlock(blockNumber))?.hash ?? null
          ),
          readCreationEvents: async (targetContextGraphId, fromBlock, toBlock) => (
            readAuthorityEvents(
              'ContextGraphCreated',
              targetContextGraphId,
              fromBlock,
              toBlock,
            ).then((events): ContextGraphAuthorityHistoryCreationEvent[] => events.map((event) => {
              const nameHash = normalizeContextGraphAuthorityHash(
                event.args.nameHash ?? event.args[2],
              );
              if (nameHash === undefined) {
                throw new Error(
                  'ContextGraphStorage returned an invalid ContextGraphCreated name hash',
                );
              }
              return {
                blockNumber: event.blockNumber,
                blockHash: event.blockHash,
                index: event.index,
                nameHash,
              };
            }))
          ),
          readEvents: async (query: ContextGraphAuthorityHistoryEventQuery, fromBlock, toBlock) => {
            const { name } = query;
            const rawEvents = await readAuthorityEvents(
              name,
              query.contextGraphId,
              fromBlock,
              toBlock,
            );
            const normalized: ContextGraphAuthorityHistoryEvent[] = [];
            for (const rawEvent of rawEvents) {
              const event = rawEvent;
              if (name === 'Transfer') {
                const from = String(event.args.from ?? event.args[0]).toLowerCase();
                const to = String(event.args.to ?? event.args[1]).toLowerCase();
                if (!ethers.isAddress(from)
                  || !ethers.isAddress(to)
                  || from === ethers.ZeroAddress
                  || to === ethers.ZeroAddress
                  || from === to) continue;
              }
              normalized.push({
                blockNumber: event.blockNumber,
                blockHash: event.blockHash,
                index: event.index,
              });
            }
            return normalized;
          },
        });
        const [rawCurrent, history] = await Promise.all([
          readCurrentState(),
          readAuthorityHistory(),
        ]);
        const { throughBlockNumber: _number, throughBlockHash: _hash, ...generation } =
          history.state;
        const authority = Object.freeze(Object.assign(
          {},
          normalizeEvmContextGraphCurrentAuthorityState(rawCurrent),
          generation,
        ));
        options.signal?.throwIfAborted();
        const chainId = (await provider.getNetwork()).chainId.toString(10);
        const snapshot: ContextGraphAuthoritySnapshot = Object.freeze({
          chainId,
          governanceContract: contractAddress,
          ...authority,
          contextGraphId: contextGraphId.toString(10),
          ownershipEra: authority.ownershipEra.toString(10),
          policyVersion: authority.policyVersion.toString(10),
          rosterVersion: authority.rosterVersion.toString(10),
          sourceBlockNumber: authority.sourceBlockNumber.toString(10),
        });
        // Verify the combined current-state + generation view only after both
        // reads settle. The legacy reader publishes its checkpoint here, so a
        // changed head cannot escape as one mixed snapshot.
        await history.publish();
        return snapshot;
      },
      {
        signal: options.signal,
        // The legacy history reader raises ContextGraphAuthorityIndexRetryableError
        // for a moved anchor, a cached checkpoint ahead of this endpoint and an
        // unresolvable anchor block. It is recognized BY TYPE here, ahead of
        // `isRpcEndpointFailoverEligible`'s message regex, so an authority read
        // fails over instead of aborting the catalog admission it gates.
        isRetryable: (error: unknown) => (
          !options.signal?.aborted && (
            isContextGraphAuthorityIndexRetryableError(error)
            || isRpcEndpointFailoverEligible(error)
          )
        ),
        // The legacy history scan retains the ordinary wide-scan policy.
        policy: 'wideLogScan',
      },
    );
  }

  async getContextGraphFinalizedCreation(
    contextGraphId: bigint,
    options: ContextGraphAuthorityReadOptions = {},
  ): Promise<ContextGraphFinalizedCreation | undefined> {
    await this.init();
    options.signal?.throwIfAborted();
    const contractAddress = (
      await this.requireContextGraphStorage().getAddress()
    ).toLowerCase();
    const binding = this.chainEventLogBinding;
    const source = binding?.contextGraphAuthority;
    const read = source?.readContextGraphFinalizedCreation;
    if (binding === undefined
      || source === undefined
      || read === undefined
      || binding.contextGraphStorageAddress !== contractAddress
      || source.contractAddress !== contractAddress) {
      return undefined;
    }
    const creation = await read.call(
      source,
      contextGraphId,
      { signal: options.signal },
    );
    options.signal?.throwIfAborted();
    // `getAddress()` is local for an ethers Contract but remains a Promise.
    // Resolve it before the final synchronous generation check so there is no
    // await between proving the binding current and handing the pair over.
    const currentAddress = (
      await this.requireContextGraphStorage().getAddress()
    ).toLowerCase();
    options.signal?.throwIfAborted();
    if (creation === undefined
      || currentAddress !== contractAddress
      || !this.chainEventLogBindingIsCurrent(binding)
      || binding.contextGraphAuthority !== source
      || binding.contextGraphStorageAddress !== contractAddress
      || source.contractAddress !== contractAddress) {
      return undefined;
    }
    if (!ethers.isHexString(creation.nameHash, 32)
      || creation.nameHash.toLowerCase() === ethers.ZeroHash
      || (creation.accessPolicy !== 0 && creation.accessPolicy !== 1)) {
      return undefined;
    }
    return Object.freeze({
      nameHash: creation.nameHash.toLowerCase(),
      accessPolicy: creation.accessPolicy,
    });
  }

  /**
   * OT-RFC-38 / LU-6 Phase B — read the curator-committed wire id
   * from `ContextGraphStorage.getNameHash(uint256)`. Returns `null`
   * ONLY for the no-commitment cases: an unregistered id OR the opt-out
   * path (curator passed `bytes32(0)` at create time), both of which the
   * Solidity getter surfaces as `bytes32(0)` (a mapping default, not a
   * revert). A `null` therefore unambiguously means "no chain-anchored
   * hash" so callers may fall back to the beacon path.
   *
   * #884 review (🔴 GaJgD): an RPC ERROR is NOT collapsed to `null` — it
   * PROPAGATES. The identity-binding caller (`localCgMatchesOnChainSlot`)
   * fails OPEN on `null` (treats it as a legitimate opt-out), so swallowing
   * a transient read failure as `null` would let a stale local→onChainId
   * mapping pass the identity gate and re-enable the plaintext downgrade for
   * the wrong slot. Letting the error throw lets the caller fail CLOSED
   * instead.
   */
  async getContextGraphNameHash(
    contextGraphId: bigint,
    options: ChainReadOptions = {},
  ): Promise<string | null> {
    await this.init();
    const cgs = this.requireContextGraphStorage();
    const raw: string = await this.readContractWithOptions(
      cgs,
      'cgStorage.getNameHash',
      'getNameHash',
      [contextGraphId],
      {
        signal: options.signal,
        policy: 'securityGatePointRead',
      },
    );
    if (!raw || raw === ethers.ZeroHash) return null;
    return raw.toLowerCase();
  }

  /**
   * Cold-start inverse name binding. The dedicated EVM resolver owns both the
   * bounded current-slot lane and the deploy-anchored exact-topic fallback.
   */
  async resolveContextGraphIdByNameHash(
    nameHash: string,
    options: ChainReadOptions = {},
  ): Promise<bigint | null> {
    return this.getContextGraphNameHashResolver().resolve(nameHash, options.signal);
  }

  async resolveContextGraphIdsByNameHashes(
    nameHashes: readonly string[],
    options: ChainReadOptions = {},
  ): Promise<ReadonlyMap<string, bigint | null>> {
    return this.getContextGraphNameHashResolver().resolveMany(nameHashes, options.signal);
  }

  /** See ChainAdapter.hasContextGraphNameRegistry. */
  async hasContextGraphNameRegistry(): Promise<boolean> {
    await this.init();
    return this.contracts.contextGraphNameRegistry !== undefined;
  }

  /**
   * See ChainAdapter.readContextGraphStorageRange and
   * evm-context-graph-storage-enumeration.ts.
   */
  async readContextGraphStorageRange(
    options: ContextGraphStorageRangeOptions,
  ): Promise<ContextGraphStorageRange> {
    await this.init();
    options.signal?.throwIfAborted();
    const storage = this.requireContextGraphStorage();
    const storageAddress = (await storage.getAddress()).toLowerCase();
    const label = CONTEXT_GRAPH_STORAGE_ENUMERATION_RPC_CONSUMER;
    const readOptions = {
      signal: options.signal,
      rpcUsageConsumer: CONTEXT_GRAPH_STORAGE_ENUMERATION_RPC_CONSUMER,
      // Background bulk reads, like the authority snapshot: the wide-scan
      // attempt cap lets a pass queued behind the RPC governor's background
      // startup jitter finish instead of timing out on the 4 s point-read cap.
      policy: 'wideLogScan' as const,
    };
    const viewReadOptions = {
      ...readOptions,
      isRetryable: isContextGraphStorageEnumerationReadRetryable,
    };
    return readContextGraphStorageRangeV1({
      storageAddress,
      readAnchor: () => this.readTipProvider(
        `${label} anchor`,
        async (provider) => {
          const anchor = await resolveEvmFinalityAnchorBlockV1({
            finalityConfirmations: this.finalityConfirmations,
            readHead: () => provider.getBlock('latest'),
            readBlockAt: (blockNumber) => provider.getBlock(blockNumber),
            unavailable: (detail) => new Error(
              `Context Graph storage enumeration anchor unavailable: ${detail}`,
            ),
          });
          return { number: anchor.number, hash: anchor.hash };
        },
        readOptions,
      ),
      readLatestId: (blockTag) => this.readContractWith(
        storage,
        `${label} getLatestContextGraphId`,
        (c) => c.getLatestContextGraphId({ blockTag }),
        viewReadOptions,
      ),
      readContextGraph: (contextGraphId, blockTag) => this.readContractWith(
        storage,
        `${label} getContextGraph`,
        (c) => c.getContextGraph(contextGraphId, { blockTag }),
        viewReadOptions,
      ),
      readNameHash: (contextGraphId, blockTag) => this.readContractWith(
        storage,
        `${label} getNameHash`,
        (c) => c.getNameHash(contextGraphId, { blockTag }),
        viewReadOptions,
      ),
      isNonexistentContextGraph: isNonexistentContextGraphStorageRevert,
    }, options);
  }
}

/**
 * Positional layout of `ContextGraphStorage.getContextGraph`, for the one shape
 * ethers may hand back without names. One map, so the two decoders that fall
 * back to positions cannot drift apart.
 */
const CONTEXT_GRAPH_TUPLE_INDEX = { participantAgents: 1, active: 3, accessPolicy: 5 } as const;

const ERC721_NONEXISTENT_TOKEN_INTERFACE = new ethers.Interface([
  'error ERC721NonexistentToken(uint256 tokenId)',
]);

/**
 * `getContextGraph` reverts only through `_requireExists`, which always carries
 * the typed `ERC721NonexistentToken` payload. Match it exactly — the decoded
 * name, or the encoded bytes for THIS id — so nothing else can be mistaken for
 * "the chain proved this id does not exist".
 */
function isNonexistentContextGraphRevert(err: unknown, contextGraphId: bigint): boolean {
  if (rpcErrorCode(err) !== 'CALL_EXCEPTION') return false;
  const e = err as { revert?: unknown; data?: unknown; errorData?: unknown };
  const revert = e.revert as { name?: unknown; args?: unknown } | null | undefined;
  if (revert !== null && typeof revert === 'object' && revert.name === 'ERC721NonexistentToken') {
    // Id-exact, like the bytes branch below: a revert that names some OTHER
    // token proves nothing about this one, and answering "nonexistent" here is
    // terminal - it would report a live, registered graph as permanently gone.
    const named = (revert.args as ArrayLike<unknown> | null | undefined)?.[0];
    try {
      return named !== undefined && named !== null
        && BigInt(named as string | number | bigint) === contextGraphId;
    } catch {
      return false;
    }
  }
  const expected = ERC721_NONEXISTENT_TOKEN_INTERFACE
    .encodeErrorResult('ERC721NonexistentToken', [contextGraphId])
    .toLowerCase();
  for (const raw of [e.data, e.errorData]) {
    if (typeof raw === 'string' && raw.toLowerCase() === expected) return true;
  }
  return false;
}

/**
 * Transient for this view, by the package's own disposition rather than a
 * private reading of provider error strings: another attempt may succeed, and
 * the three point reads would fail the same way, so the error propagates. That
 * covers local governor saturation and an exhausted endpoint set
 * (`retry-later`) — answering those with three MORE reads would be exactly
 * wrong. `BAD_DATA` is excluded for the reason `isContractViewRetryable`
 * gives: on a view it is a client-side decode, not an outage.
 *
 * Everything else falls back to the point reads. `getContextGraph` has shipped
 * beside them since v10.0.0, so this is never "selector absent"; it is a tuple
 * that does not decode, or a revert that proves nothing about this id. The
 * point reads do not share the tuple and already own the established
 * disposition of every such fault, so they decide.
 *
 * That set is NOT all deterministic. ethers v6 coerces every JSON-RPC error
 * body on `eth_call` (an HTTP-200 rate limit, "header not found") into a bare
 * CALL_EXCEPTION, which the shared classifier reads as `fail`. Such a fault
 * takes the fallback too; the liveness read then fails the same way and yields
 * the same retryable disposition it always did, at the cost of one extra read.
 * Telling those apart is the shared classifier's job, not a matcher here.
 */
function isLiveAuthorityReadTransient(err: unknown): boolean {
  return isRetryableRpcError(err) && rpcErrorCode(err) !== 'BAD_DATA';
}

function decodeContextGraphLiveAuthority(
  raw: unknown,
  contextGraphId: bigint,
): ContextGraphLiveAuthority {
  const named = (raw ?? {}) as { active?: unknown; accessPolicy?: unknown; participantAgents?: unknown };
  const positional = Array.isArray(raw) ? (raw as unknown[]) : [];
  const active = named.active ?? positional[CONTEXT_GRAPH_TUPLE_INDEX.active];
  const accessPolicy = named.accessPolicy ?? positional[CONTEXT_GRAPH_TUPLE_INDEX.accessPolicy];
  const agents = named.participantAgents ?? positional[CONTEXT_GRAPH_TUPLE_INDEX.participantAgents];
  // Boundary check on an `unknown`. ethers itself never hands back a wrongly
  // typed field - a real ABI mismatch arrives as BAD_DATA and takes the same
  // exit through the catch in the caller - so this guards the seam (a rebound
  // or substituted read), not the wire. Either way the answer is UNSUPPORTED:
  // the three point reads own the established disposition of every malformed
  // value, where a plain throw would resurface as the RETRYABLE
  // policy-unavailable reason and retry a permanent fault forever.
  let policy: number;
  try {
    if (typeof active !== 'boolean' || !Array.isArray(agents)) throw new Error('tuple layout');
    policy = Number(BigInt(accessPolicy as string | number | bigint));
  } catch {
    throw new ContextGraphLiveAuthorityUnsupportedError(
      `getContextGraph(${contextGraphId}) returned an undecodable tuple`,
    );
  }
  // Roster entries are handed through as read. The resolver owns their
  // validation and normalization, so a malformed entry keeps its terminal
  // `chain-participant-authority-invalid` disposition on this path too.
  return Object.freeze({
    active,
    accessPolicy: policy,
    participantAgents: Object.freeze(agents.map((value) => String(value))),
  });
}
