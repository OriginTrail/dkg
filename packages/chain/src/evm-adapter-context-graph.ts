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
} from './evm-adapter-base.js';
import {
  ContextGraphFacadeVersionUnknownError,
  ContextGraphRegistrationCoverageSignerUnavailableError,
  ContextGraphRegistrationSignerUnavailableError,
  PcaCoverageUnsupportedError,
  StaleHubBindingError,
  isHubStaleError,
  isTooLowAllowanceError,
} from './evm-adapter-errors.js';
import { ethers, Contract, type JsonRpcProvider, type Wallet } from 'ethers';
import { ContextGraphChainScanPartialError, type ChainReadOptions, type CreateContextGraphParams, type TxResult, type ContextGraphOnChain, type ContextGraphChainScanOptions, type ContextGraphRegistryScanOptions, type ContextGraphRegistryScanPage, type CreateOnChainContextGraphParams, type CreateOnChainContextGraphResult, type VerifyParams, type PublishToContextGraphParams, type OnChainPublishResult, type ContextGraphRegistrationCoverage, type PrepareContextGraphRegistrationOptions, type PreparedContextGraphRegistration } from './chain-adapter.js';
import { buildAuthorAttestationTypedData, AUTHOR_SCHEME_VERSION_V1 } from '@origintrail-official/dkg-core';
import {
  resolveContextGraphCreateDispatch,
  type ContextGraphLegacyCreateArgs,
} from './context-graph-registration-dispatch.js';
import { parsePcaRegistrationCoverageAccount } from './evm-adapter-conviction.js';

export const MAX_AUTO_COVERAGE_CANDIDATES = 32;
export const AUTO_COVERAGE_DISCOVERY_TIMEOUT_MS = 5_000;
export const AUTO_COVERAGE_READ_CONCURRENCY = 4;

const MINIMUM_PCA_WAIVER_FACADE_VERSION = [10, 0, 5] as const;
const PARAMETERS_WAIVER_ABI = [
  'function contextGraphRegistrationDeposit() view returns (uint96)',
  'function minPcaCommitmentForCgWaiver() view returns (uint96)',
] as const;

type CoverageDiscoverySnapshot = {
  deposit: bigint;
  minimumCommitment: bigint;
  latestTimestamp: bigint;
  pca: Contract;
  waiverStorage: Contract;
  reads: CoverageReadLimiter;
};

type OwnedCoverageDiscovery = {
  coverage: ContextGraphRegistrationCoverage;
  allowAgentFallback: boolean;
};

type FacadeCapability =
  | { state: 'supported'; version: string }
  | { state: 'unsupported'; version: string };

class CoverageDiscoveryDeadlineError extends Error {
  constructor() {
    super('Context-graph PCA coverage discovery exceeded its five-second budget.');
    this.name = 'CoverageDiscoveryDeadlineError';
  }
}

function withCoverageDeadline<T>(promise: Promise<T>, deadline: number): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return Promise.reject(new CoverageDiscoveryDeadlineError());
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new CoverageDiscoveryDeadlineError()), remaining);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/** A deadline-aware semaphore that caps all discovery RPC reads, not just workers. */
class CoverageReadLimiter {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(
    private readonly deadline: number,
    private readonly concurrency = AUTO_COVERAGE_READ_CONCURRENCY,
  ) {}

  async run<T>(read: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      // A queued waiter can be handed a semaphore slot at the deadline. Do not
      // start a fresh RPC after the budget has expired; only the at-most-four
      // reads already in flight may outlive their local timeout.
      if (this.expired()) throw new CoverageDiscoveryDeadlineError();
      return await withCoverageDeadline(
        Promise.resolve().then(() => {
          if (this.expired()) throw new CoverageDiscoveryDeadlineError();
          return read();
        }),
        this.deadline,
      );
    } finally {
      this.release();
    }
  }

  expired(): boolean {
    return Date.now() >= this.deadline;
  }

  private async acquire(): Promise<void> {
    if (Date.now() >= this.deadline) throw new CoverageDiscoveryDeadlineError();
    if (this.active < this.concurrency) {
      this.active += 1;
      return;
    }
    let wake!: () => void;
    const wait = new Promise<void>((resolve) => { wake = resolve; });
    this.waiting.push(wake);
    try {
      await withCoverageDeadline(wait, this.deadline);
    } catch (err) {
      const index = this.waiting.indexOf(wake);
      if (index >= 0) this.waiting.splice(index, 1);
      throw err;
    }
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.active -= 1;
  }
}

function parsedFacadeVersion(version: unknown): FacadeCapability | undefined {
  if (typeof version !== 'string') return undefined;
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/.exec(
    version.trim(),
  );
  if (!match) return undefined;
  const actual = match.slice(1, 4).map(Number);
  if (!actual.every(Number.isSafeInteger)) return undefined;
  let comparison = 0;
  for (let index = 0; index < actual.length; index += 1) {
    if (actual[index] === MINIMUM_PCA_WAIVER_FACADE_VERSION[index]) continue;
    comparison = actual[index] > MINIMUM_PCA_WAIVER_FACADE_VERSION[index] ? 1 : -1;
    break;
  }
  // The floor is a stable release: 10.0.5-rc.x remains below it, while a
  // prerelease of a later numeric version still necessarily contains the
  // selector introduced in 10.0.5.
  const supported = comparison > 0 || (comparison === 0 && match[4] === undefined);
  return { state: supported ? 'supported' : 'unsupported', version: version.trim() };
}

type ContextGraphRegistryScanPlan =
  | {
      mode: 'explicitFromBlock' | 'listAll';
      resumeFromWatermark: false;
      persistProgress: false;
      allowPartialFailure: false;
      seedAtEnd: false;
      pageBudget?: undefined;
    }
  | {
      mode: 'incremental';
      resumeFromWatermark: true;
      persistProgress: true;
      allowPartialFailure: true;
      seedAtEnd: false;
      pageBudget?: number;
    }
  | {
      mode: 'seedFull';
      resumeFromWatermark: false;
      persistProgress: true;
      allowPartialFailure: true;
      seedAtEnd: true;
      pageBudget?: undefined;
    }
  | {
      mode: 'seedFromCursor';
      resumeFromWatermark: true;
      persistProgress: true;
      allowPartialFailure: true;
      seedAtEnd: true;
      pageBudget?: number;
    };

function normalizePageBudget(value: number | undefined): number | undefined {
  return Number.isFinite(value) && (value ?? 0) >= 1
    ? Math.floor(value ?? 0)
    : undefined;
}

function buildPublicContextGraphRegistryScanPlan(
  fromBlock: number | undefined,
  options: ContextGraphChainScanOptions | undefined,
): ContextGraphRegistryScanPlan {
  const runtimeOptions = options as
    | (ContextGraphChainScanOptions & { mode?: string })
    | undefined;
  const mode = runtimeOptions?.mode;

  if (fromBlock !== undefined) {
    return {
      mode: 'explicitFromBlock',
      resumeFromWatermark: false,
      persistProgress: false,
      allowPartialFailure: false,
      seedAtEnd: false,
    };
  }

  if (runtimeOptions && 'incremental' in runtimeOptions && runtimeOptions.incremental === true) {
    return {
      mode: 'incremental',
      resumeFromWatermark: true,
      persistProgress: true,
      allowPartialFailure: true,
      seedAtEnd: false,
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
        mode: 'seedFromCursor',
        resumeFromWatermark: true,
        persistProgress: true,
        allowPartialFailure: true,
        seedAtEnd: true,
        pageBudget: normalizePageBudget(runtimeOptions.pageBudget),
      };
    }
    return {
      mode: 'seedFull',
      resumeFromWatermark: false,
      persistProgress: true,
      allowPartialFailure: true,
      seedAtEnd: true,
    };
  }

  if (mode !== undefined && mode !== 'listAll') {
    throw new Error(
      'listContextGraphsFromChain accepts only listAll or legacy boolean scan options; ' +
      'use scanContextGraphRegistryPages for cursor-backed daemon scans.',
    );
  }

  return {
    mode: 'listAll',
    resumeFromWatermark: false,
    persistProgress: false,
    allowPartialFailure: false,
    seedAtEnd: false,
  };
}

function buildCursorContextGraphRegistryScanPlan(
  options: ContextGraphRegistryScanOptions,
): ContextGraphRegistryScanPlan {
  if (options.mode === 'incremental') {
    return {
      mode: 'incremental',
      resumeFromWatermark: true,
      persistProgress: true,
      allowPartialFailure: true,
      seedAtEnd: false,
      pageBudget: normalizePageBudget(options.pageBudget),
    };
  }

  if (options?.mode === 'seedFull') {
    return {
      mode: 'seedFull',
      resumeFromWatermark: false,
      persistProgress: true,
      allowPartialFailure: true,
      seedAtEnd: true,
    };
  }

  if (options?.mode === 'seedFromCursor') {
    return {
      mode: 'seedFromCursor',
      resumeFromWatermark: true,
      persistProgress: true,
      allowPartialFailure: true,
      seedAtEnd: true,
      pageBudget: normalizePageBudget(options.pageBudget),
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
    await this.init();
    const registry = this.contracts.contextGraphNameRegistry;
    if (!registry) return [];
    const registryAddress = (await registry.getAddress()).toLowerCase();
    const scanPlan = buildPublicContextGraphRegistryScanPlan(fromBlock, options);
    return this._collectContextGraphRegistryScan(registry, registryAddress, fromBlock, scanPlan);
  }

  async *scanContextGraphRegistryPages(
    options: ContextGraphRegistryScanOptions,
  ): AsyncIterable<ContextGraphRegistryScanPage> {
    await this.init();
    const registry = this.contracts.contextGraphNameRegistry;
    if (!registry) return;
    const registryAddress = (await registry.getAddress()).toLowerCase();
    const scanPlan = buildCursorContextGraphRegistryScanPlan(options);
    yield* this._iterateContextGraphRegistryScanPages(registry, registryAddress, undefined, scanPlan);
  }

  private async _collectContextGraphRegistryScan(
    registry: Contract,
    registryAddress: string,
    fromBlock: number | undefined,
    scanPlan: ContextGraphRegistryScanPlan,
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
    scanPlan: ContextGraphRegistryScanPlan,
  ): AsyncGenerator<ContextGraphRegistryScanPage, void, unknown> {
    const eventFilter = registry.filters.NameClaimed();
    const persistedWatermark = (scanPlan.resumeFromWatermark || scanPlan.seedAtEnd)
      ? await this.contextGraphRegistryScanCursor.loadWatermark(registryAddress)
      : undefined;
    const canResumeFromWatermark = scanPlan.resumeFromWatermark && persistedWatermark !== undefined;
    const scan =
      fromBlock === undefined
        ? canResumeFromWatermark
          ? { fromBlock: 0, ...(await this.resolveLogScanHead('listContextGraphsFromChain')) }
          : await this.resolveContractDeployBlock(
              registryAddress,
              'listContextGraphsFromChain',
              'ContextGraphNameRegistry',
            )
        : { fromBlock, ...(await this.resolveLogScanHead('listContextGraphsFromChain')) };
    const { fromBlock: deployBlock, head, scanProviders, degradedFromGenesis = false } = scan;
    const start = fromBlock ?? (
      canResumeFromWatermark
        ? Math.max(0, persistedWatermark - CG_REGISTRY_REORG_BUFFER_BLOCKS)
        : deployBlock
    );
    if (start > head) {
      if (scanPlan.seedAtEnd) {
        await this.contextGraphRegistryScanCursor.saveWatermark(registryAddress, head + 1);
      }
      return;
    }

    const pageSize = this.cgRegistryScanPageSize;
    const pages = Math.ceil((head - start + 1) / pageSize);
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

    const results: ContextGraphOnChain[] = [];
    const connected = new Map<JsonRpcProvider, Contract>();
    let preferred: JsonRpcProvider | undefined;
    let scannedAnyPage = false;

    // Daemon scans can resume from the scanned prefix after a later page
    // failure. Public list-all calls should remain all-or-error.
    for (let lo = start; lo <= head; lo += pageSize) {
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
        if (scanPlan.allowPartialFailure && scannedAnyPage) {
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
        ack: scanPlan.persistProgress
          ? async () => {
              await this.contextGraphRegistryScanCursor.saveWatermark(registryAddress, hi + 1);
            }
          : async () => {},
      };
      const scannedPages = Math.floor((hi - start) / pageSize) + 1;
      if (scanPlan.pageBudget !== undefined && scannedPages >= scanPlan.pageBudget && hi < head) return;
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

  async prepareOnChainContextGraphRegistration(
    options: PrepareContextGraphRegistrationOptions = {},
  ): Promise<PreparedContextGraphRegistration> {
    await this.init();

    const explicitAccountId = options.registrationPcaAccountId;
    if (explicitAccountId !== undefined && explicitAccountId <= 0n) {
      throw new RangeError('registrationPcaAccountId must be a positive PCA account id.');
    }
    const pinnedSigner = options.registrationSignerAddress
      ? this.registrationSignerByAddress(options.registrationSignerAddress)
      : undefined;

    if (explicitAccountId !== undefined) {
      const candidates = pinnedSigner
        ? [pinnedSigner]
        : options.preferPcaCoveredSigner
          ? this.signerPool
          : [this.signer];
      const signer = await this.resolveExplicitCoverageSigner(explicitAccountId, candidates);
      return this.sealContextGraphRegistration(
        signer,
        { source: 'explicit', accountId: explicitAccountId },
      );
    }

    // An unpinned synchronous publisher has not planned a publish signer yet.
    // Reuse one snapshot/deadline for the whole configured pool and select the
    // first signer with fully verified coverage. This is deterministic in pool
    // order and falls back to the primary signer when discovery fails closed.
    if (options.preferPcaCoveredSigner && !pinnedSigner) {
      const deadline = Date.now() + AUTO_COVERAGE_DISCOVERY_TIMEOUT_MS;
      const snapshot = await this.prepareCoverageDiscoverySnapshot(deadline);
      if (snapshot) {
        const agentCandidates: Wallet[] = [];
        for (const signer of this.signerPool) {
          const owned = await this.discoverOwnedCoverageForSigner(signer, snapshot);
          if (owned.coverage.source === 'owned') {
            return this.sealContextGraphRegistration(signer, owned.coverage);
          }
          if (owned.allowAgentFallback) agentCandidates.push(signer);
          if (Date.now() >= deadline) break;
        }
        // Ownership has stronger authority than a consent-free agent binding,
        // so only consult agent mappings after every pool signer has had a
        // bounded opportunity to prove owned coverage.
        for (const signer of agentCandidates) {
          const coverage = await this.discoverAgentCoverageForSigner(signer, snapshot);
          if (coverage.source === 'agent') {
            return this.sealContextGraphRegistration(signer, coverage);
          }
          if (Date.now() >= deadline) break;
        }
      }
      return this.sealContextGraphRegistration(this.signer, { source: 'none' });
    }

    const signer = pinnedSigner ?? this.signer;
    const deadline = Date.now() + AUTO_COVERAGE_DISCOVERY_TIMEOUT_MS;
    const snapshot = await this.prepareCoverageDiscoverySnapshot(deadline);
    const coverage = snapshot
      ? await this.discoverCoverageForSigner(signer, snapshot)
      : { source: 'none' as const };
    return this.sealContextGraphRegistration(signer, coverage);
  }

  async createOnChainContextGraph(
    params: CreateOnChainContextGraphParams,
    preparationOptions?: PrepareContextGraphRegistrationOptions,
  ): Promise<CreateOnChainContextGraphResult> {
    const prepared = preparationOptions !== undefined
      ? await this.prepareOnChainContextGraphRegistration(preparationOptions)
      // Preserve the legacy direct-call path: callers that did not ask for a
      // registration execution context do not incur PCA discovery reads.
      : this.sealContextGraphRegistration(this.signer, { source: 'none' });
    return prepared.submit(params);
  }

  private registrationSignerByAddress(address: string): Wallet {
    let signer: Wallet | undefined;
    try {
      signer = this.findSignerByAddress(address);
    } catch {
      // Normalize malformed addresses into the same stable capability error as
      // a valid address that is not present in the configured signer pool.
    }
    if (!signer) throw new ContextGraphRegistrationSignerUnavailableError(address);
    return signer;
  }

  /**
   * Resolve one explicitly requested PCA against the configured signer pool.
   * Ownership wins without per-signer reads; otherwise exact agent mappings
   * are checked in deterministic pool order. Explicit intent fails closed and
   * never silently degrades to the primary signer/deposit path.
   */
  private async resolveExplicitCoverageSigner(
    accountId: bigint,
    candidates: readonly Wallet[],
  ): Promise<Wallet> {
    const pca = this.contracts.dkgPublishingConvictionNFT;
    if (!pca) {
      throw new ContextGraphRegistrationCoverageSignerUnavailableError(accountId, {
        cause: new Error('DKGPublishingConvictionNFT is not deployed.'),
      });
    }

    let firstReadError: unknown;
    try {
      const owner = ethers.getAddress(String(await this.readContract(
        pca,
        'pca.ownerOf explicit registration coverage',
        'ownerOf',
        accountId,
      )));
      const ownerSigner = candidates.find(
        (candidate) => ethers.getAddress(candidate.address) === owner,
      );
      if (ownerSigner) return ownerSigner;
    } catch (err) {
      firstReadError = err;
    }

    for (const signer of candidates) {
      try {
        const mappedAccountId = BigInt(await this.readContract(
          pca,
          'pca.agentToAccountId explicit registration coverage',
          'agentToAccountId',
          signer.address,
        ));
        if (mappedAccountId === accountId) return signer;
      } catch (err) {
        firstReadError ??= err;
      }
    }

    throw new ContextGraphRegistrationCoverageSignerUnavailableError(accountId, {
      cause: firstReadError,
    });
  }

  private sealContextGraphRegistration(
    signer: Wallet,
    coverage: ContextGraphRegistrationCoverage,
  ): PreparedContextGraphRegistration {
    if (coverage.source !== 'none' && coverage.accountId <= 0n) {
      throw new RangeError('Covered context-graph registration requires a positive PCA account id.');
    }
    const signerAddress = ethers.getAddress(signer.address);
    const sealedCoverage = Object.freeze({ ...coverage });
    const submit = async (
      params: CreateOnChainContextGraphParams,
    ): Promise<CreateOnChainContextGraphResult> => {
      if (params == null) throw new TypeError('Prepared context-graph registration requires create parameters.');
      // A prepared capability may outlive adapter reconfiguration. Fail rather
      // than substituting another pool signer; the captured wallet remains the
      // only wallet this capability can use.
      const available = this.findSignerByAddress(signerAddress);
      if (!available || available !== signer) {
        throw new ContextGraphRegistrationSignerUnavailableError(signerAddress);
      }
      return this.withHubStaleRetryAny(() =>
        this.submitPreparedContextGraphRegistration(params, signer, sealedCoverage));
    };
    return Object.freeze({ signerAddress, coverage: sealedCoverage, submit });
  }

  private async prepareCoverageDiscoverySnapshot(
    deadline: number,
  ): Promise<CoverageDiscoverySnapshot | undefined> {
    const pca = this.contracts.dkgPublishingConvictionNFT;
    const configuredParameters = this.contracts.parametersStorage;
    if (!pca || !configuredParameters) return undefined;

    const reads = new CoverageReadLimiter(deadline);
    try {
      const parametersAddress = await reads.run(() => configuredParameters.getAddress());
      const parameters = new Contract(parametersAddress, PARAMETERS_WAIVER_ABI, this.provider);
      const deposit = BigInt(await reads.run(() => this.readContract(
        parameters,
        'parametersStorage.contextGraphRegistrationDeposit',
        'contextGraphRegistrationDeposit',
      )));
      if (deposit === 0n) return undefined;

      const [minimumCommitmentRaw, latestBlock, waiverStorage] = await Promise.all([
        reads.run(() => this.readContract(
          parameters,
          'parametersStorage.minPcaCommitmentForCgWaiver',
          'minPcaCommitmentForCgWaiver',
        )),
        reads.run(() => this.readTipProvider(
          'latest block for context-graph PCA coverage',
          (provider) => provider.getBlock('latest'),
        )),
        reads.run(() => this.resolveContract('ContextGraphWaiverStorage')),
      ]);
      if (!latestBlock) return undefined;
      return {
        deposit,
        minimumCommitment: BigInt(minimumCommitmentRaw),
        latestTimestamp: BigInt(latestBlock.timestamp),
        pca,
        waiverStorage,
        reads,
      };
    } catch {
      // Discovery is advisory. Any global read/deployment/budget failure retains
      // the ordinary deposit path; the contract remains the authority at submit.
      return undefined;
    }
  }

  private async discoverCoverageForSigner(
    signer: Wallet,
    snapshot: CoverageDiscoverySnapshot,
  ): Promise<ContextGraphRegistrationCoverage> {
    const owned = await this.discoverOwnedCoverageForSigner(signer, snapshot);
    if (owned.coverage.source === 'owned' || !owned.allowAgentFallback) {
      return owned.coverage;
    }
    return this.discoverAgentCoverageForSigner(signer, snapshot);
  }

  private async discoverOwnedCoverageForSigner(
    signer: Wallet,
    snapshot: CoverageDiscoverySnapshot,
  ): Promise<OwnedCoverageDiscovery> {
    try {
      const balance = BigInt(await snapshot.reads.run(() => this.readContract(
        snapshot.pca,
        'pca.balanceOf registration signer',
        'balanceOf',
        signer.address,
      )));
      if (balance > BigInt(MAX_AUTO_COVERAGE_CANDIDATES)) {
        // Do not consult an unsolicited agent binding after refusing amplified
        // owner enumeration. The operator can still supply an explicit PCA ID.
        return { coverage: { source: 'none' }, allowAgentFallback: false };
      }

      const accountIds = await Promise.all(Array.from(
        { length: Number(balance) },
        (_unused, index) => snapshot.reads.run(async () => BigInt(await this.readContract(
          snapshot.pca,
          'pca.tokenOfOwnerByIndex registration coverage',
          'tokenOfOwnerByIndex',
          signer.address,
          BigInt(index),
        ))),
      ));
      accountIds.sort((left, right) => left < right ? -1 : left > right ? 1 : 0);

      const ownerEligibility = await Promise.all(accountIds.map(async (accountId) => ({
        accountId,
        eligible: await this.registrationCoverageCandidateEligible(
          signer.address,
          accountId,
          'owned',
          snapshot,
        ),
      })));
      const owned = ownerEligibility.find((candidate) => candidate.eligible);
      if (owned) {
        return {
          coverage: { source: 'owned', accountId: owned.accountId },
          allowAgentFallback: false,
        };
      }
      return {
        coverage: { source: 'none' },
        allowAgentFallback: !snapshot.reads.expired(),
      };
    } catch {
      // A signer-level owner-enumeration or total-budget failure cannot safely
      // fall through to an unsolicited agent binding.
      return { coverage: { source: 'none' }, allowAgentFallback: false };
    }
  }

  private async discoverAgentCoverageForSigner(
    signer: Wallet,
    snapshot: CoverageDiscoverySnapshot,
  ): Promise<ContextGraphRegistrationCoverage> {
    try {
      const agentAccountId = BigInt(await snapshot.reads.run(() => this.readContract(
        snapshot.pca,
        'pca.agentToAccountId registration coverage',
        'agentToAccountId',
        signer.address,
      )));
      if (
        agentAccountId > 0n
        && await this.registrationCoverageCandidateEligible(
          signer.address,
          agentAccountId,
          'agent',
          snapshot,
        )
      ) {
        return { source: 'agent', accountId: agentAccountId };
      }
    } catch {
      // Agent resolution or total-budget failure makes automatic coverage
      // unavailable. Never guess a candidate.
    }
    return { source: 'none' };
  }

  private async registrationCoverageCandidateEligible(
    signerAddress: string,
    accountId: bigint,
    relation: 'owned' | 'agent',
    snapshot: CoverageDiscoverySnapshot,
  ): Promise<boolean> {
    try {
      const [account, waivedCountRaw, owner] = await Promise.all([
        snapshot.reads.run(() => this.readContract(
          snapshot.pca,
          'pca.accounts registration coverage',
          'accounts',
          accountId,
        )),
        snapshot.reads.run(() => this.readContract(
          snapshot.waiverStorage,
          'contextGraphWaiverStorage.waivedCgCount',
          'waivedCgCount',
          accountId,
        )),
        relation === 'owned'
          ? snapshot.reads.run(() => this.readContract(
              snapshot.pca,
              'pca.ownerOf registration coverage',
              'ownerOf',
              accountId,
            ))
          : Promise.resolve(signerAddress),
      ]);
      if (ethers.getAddress(String(owner)) !== ethers.getAddress(signerAddress)) return false;

      const parsedAccount = parsePcaRegistrationCoverageAccount(account);
      if (!parsedAccount) return false;
      const { committedTRAC: committed, expiresAtTimestamp, fullySwept } = parsedAccount;
      if (
        committed === 0n
        || fullySwept
        || committed < snapshot.minimumCommitment
        || (expiresAtTimestamp !== 0n && snapshot.latestTimestamp >= expiresAtTimestamp)
      ) return false;

      const quota = committed / snapshot.deposit;
      return quota > BigInt(waivedCountRaw);
    } catch {
      // Candidate-local failures mark only this candidate unverified; other
      // owned candidates remain eligible for deterministic evaluation.
      return false;
    }
  }

  private async readContextGraphsFacadeCapability(
    contextGraphs: Contract,
  ): Promise<FacadeCapability> {
    let rawVersion: unknown;
    try {
      rawVersion = await this.readContract(
        contextGraphs,
        'contextGraphs.version',
        'version',
      );
    } catch (err) {
      if (isHubStaleError(err)) throw err;
      throw new ContextGraphFacadeVersionUnknownError({ cause: err });
    }
    const capability = parsedFacadeVersion(rawVersion);
    if (!capability) throw new ContextGraphFacadeVersionUnknownError();
    return capability;
  }

  private async submitPreparedContextGraphRegistration(
    params: CreateOnChainContextGraphParams,
    signer: Wallet,
    coverage: Readonly<ContextGraphRegistrationCoverage>,
  ): Promise<CreateOnChainContextGraphResult> {
    await this.init();
    const contextGraphs = this.contracts.contextGraphs;
    const contextGraphStorage = this.contracts.contextGraphStorage;
    if (!contextGraphs || !contextGraphStorage) {
      throw new Error('ContextGraphs contract not deployed. Deploy ContextGraphs and ContextGraphStorage first.');
    }
    if (params.accessPolicy === undefined || params.publishPolicy === undefined) {
      throw new Error(
        'createOnChainContextGraph: `accessPolicy` and `publishPolicy` are required (SPEC_CG_MEMORY_MODEL). ' +
        'Pass both explicitly — e.g. { accessPolicy: 1, publishPolicy: 0 } for invite-only + curators-only.',
      );
    }

    const legacyCreateArgs: ContextGraphLegacyCreateArgs = [
      params.participantAgents ?? [],
      params.metadataBatchId ?? 0n,
      params.accessPolicy,
      params.publishPolicy,
      params.publishAuthority ?? ethers.ZeroAddress,
      params.publishAuthorityAccountId ?? 0n,
      params.nameHash ?? ethers.ZeroHash,
    ];
    const registrationAccountId = coverage.source === 'none' ? 0n : coverage.accountId;
    const legacyCoverageAccountId = params.publishAuthorityAccountId ?? 0n;
    let createDispatch = resolveContextGraphCreateDispatch(legacyCreateArgs);

    if (registrationAccountId > 0n && registrationAccountId !== legacyCoverageAccountId) {
      const facade = await this.readContextGraphsFacadeCapability(contextGraphs);
      if (facade.state === 'supported') {
        createDispatch = resolveContextGraphCreateDispatch(legacyCreateArgs, {
          mode: 'pca',
          accountId: registrationAccountId,
        });
      } else if (coverage.source === 'explicit') {
        let currentBinding: boolean;
        try {
          currentBinding = await this.isCurrentHubContractAddress(
            'ContextGraphs',
            await contextGraphs.getAddress(),
          );
        } catch (err) {
          if (isHubStaleError(err)) throw err;
          throw new ContextGraphFacadeVersionUnknownError({ cause: err });
        }
        if (!currentBinding) {
          throw new StaleHubBindingError(
            'ContextGraphs',
            await contextGraphs.getAddress(),
          );
        }
        throw new PcaCoverageUnsupportedError(facade.version);
      }
      // Automatic coverage on a confirmed old facade deliberately falls back
      // to the legacy paid path during rolling deployment.
    }

    const submitCreate = () => this.sendContractTransaction(
      contextGraphs,
      createDispatch.method,
      createDispatch.args,
      signer,
      'create on-chain context graph',
    );
    const receipt = await (async () => {
      try {
        return await submitCreate();
      } catch (err) {
        if (!isTooLowAllowanceError(err)) throw err;
        const parametersStorage = this.contracts.parametersStorage as Contract | undefined;
        let deposit = 0n;
        try {
          deposit = parametersStorage
            ? BigInt(await this.readContract(
                parametersStorage,
                'parametersStorage.contextGraphRegistrationDeposit',
                'contextGraphRegistrationDeposit',
              ))
            : 0n;
        } catch (depositError) {
          if (isHubStaleError(depositError)) throw depositError;
          deposit = 0n;
        }
        if (deposit === 0n) throw err;
        await this.ensureV10ApproveTrac(
          signer,
          await contextGraphs.getAddress(),
          deposit,
          'cg registration deposit',
          true,
        );
        return submitCreate();
      }
    })();

    let contextGraphId: bigint | undefined;
    for (const log of receipt.logs) {
      try {
        const parsed = contextGraphStorage.interface.parseLog({
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

  async getKAContextGraphId(kaId: bigint, options: ChainReadOptions = {}): Promise<bigint> {
    await this.init();
    const cgs = this.requireContextGraphStorage();
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
    const cgs = this.requireContextGraphStorage();
    const count: bigint = await this.readContract(
      cgs, 'cgStorage.getContextGraphKaCount', 'getContextGraphKaCount', contextGraphId,
    );
    return BigInt(count);
  }

  async getContextGraphKCAt(contextGraphId: bigint, index: bigint): Promise<bigint> {
    await this.init();
    const cgs = this.requireContextGraphStorage();
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
          'cgStorage.getContextGraph',
          'getContextGraph',
          [contextGraphId],
          { signal: options.signal },
        );
        const raw =
          cg?.accessPolicy
          ?? (Array.isArray(cg) ? cg[5] : undefined);
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
      { signal: options.signal },
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
}
