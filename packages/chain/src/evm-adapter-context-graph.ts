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
  isTooLowAllowanceError,
} from './evm-adapter-errors.js';
import { ethers, Contract, type JsonRpcProvider } from 'ethers';
import { RPC_READ_STALL_TIMEOUT_MS } from './evm-adapter-constants.js';
import { withTimeout } from './evm-adapter-rpc.js';
import { withRpcRequestAbortSignal } from './rpc-request-transport.js';
import { ContextGraphChainScanPartialError, type ChainReadOptions, type CreateContextGraphParams, type TxResult, type ContextGraphOnChain, type ContextGraphChainScanOptions, type ContextGraphRegistryScanOptions, type ContextGraphRegistryScanPage, type CreateOnChainContextGraphParams, type CreateOnChainContextGraphResult, type VerifyParams, type PublishToContextGraphParams, type OnChainPublishResult } from './chain-adapter.js';
import { buildAuthorAttestationTypedData, AUTHOR_SCHEME_VERSION_V1 } from '@origintrail-official/dkg-core';
import {
  CONTEXT_GRAPH_NAME_HASH_ENUMERATION_CONCURRENCY,
  ContextGraphNameHashResolver,
  type ContextGraphNameHashSlot,
  type ContextGraphNameHashSlotIndexAnchor,
  type ContextGraphNameHashSlotIndexScope,
} from './context-graph-name-hash-resolver.js';

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

function waitForContextGraphSlotRead<T>(
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
  async isContextGraphActiveOnChain(contextGraphId: bigint): Promise<boolean> {
    await this.init();
    const cgs = this.requireContextGraphStorage();
    return Boolean(await this.readContract(
      cgs, 'cgStorage.isContextGraphActive', 'isContextGraphActive', contextGraphId,
    ));
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
    const receipt = await (async () => {
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
        await this.ensureV10ApproveTrac(
          this.signer,
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
  async getContextGraphAccessPolicy(contextGraphId: bigint): Promise<number> {
    await this.init();
    const cgs = this.requireContextGraphStorage();
    try {
      const raw: bigint = BigInt(await this.readContract(
        cgs, 'cgStorage.getAccessPolicy', 'getAccessPolicy', contextGraphId,
      ));
      return Number(raw);
    } catch (primaryErr) {
      try {
        const cg = await this.readContract(
          cgs, 'cgStorage.getContextGraph', 'getContextGraph', contextGraphId,
        );
        const raw =
          cg?.accessPolicy
          ?? (Array.isArray(cg) ? cg[5] : undefined);
        if (raw === undefined || raw === null) {
          throw new Error('ContextGraphStorage.getContextGraph returned no accessPolicy field');
        }
        return Number(BigInt(raw));
      } catch (fallbackErr) {
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
   * Named EVM boundary for one uncached reverse lookup. Small registries use
   * current-state enumeration; larger registries switch before any per-id read
   * to the bounded exact-topic history lane. The wrapper resolver owns input
   * normalization, negative TTL, and single-flight waiting.
   */
  private async loadContextGraphIdByNameHashFromChain(
    normalizedNameHash: string,
  ): Promise<bigint | null> {
    await this.init();
    const bindingEpoch = this.contextGraphNameHashBindingEpoch;
    const scopeBefore = await this.captureContextGraphNameHashIndexScope();
    const assertCurrentLaneBinding = async (): Promise<void> => {
      const scopeAfter = await this.captureContextGraphNameHashIndexScope();
      if (
        this.contextGraphNameHashBindingEpoch !== bindingEpoch
        || !this.sameContextGraphNameHashIndexScope(scopeBefore, scopeAfter)
      ) {
        throw new Error(
          'resolveContextGraphIdByNameHash: chain provider or ContextGraphStorage ' +
          'binding changed during current-slot resolution',
        );
      }
    };
    let providerHighWaters: ReadonlyMap<JsonRpcProvider, bigint> | undefined;
    const result = await this.contextGraphNameHashSlotIndex.resolve(
      normalizedNameHash,
      {
        captureScope: () => this.captureContextGraphNameHashIndexScope(),
        captureAnchor: () => this.captureContextGraphNameHashIndexAnchor(),
        loadAnchorHash: (blockNumber) =>
          this.loadContextGraphNameHashIndexAnchorHash(blockNumber),
        loadLatestId: async () => {
          const snapshot = await this.loadCurrentContextGraphNameHashProviderHighWaters();
          providerHighWaters = snapshot.providerHighWaters;
          return snapshot.latestId;
        },
        loadRange: (firstId, lastId) => {
          if (providerHighWaters === undefined) {
            throw new Error(
              'resolveContextGraphIdByNameHash: current provider high-water snapshot is missing',
            );
          }
          return this.loadCurrentContextGraphNameHashSlots(
            firstId,
            lastId,
            providerHighWaters,
          );
        },
        onCommit: () => this.contextGraphNameHashResolver?.invalidateAll(),
      },
    );
    if (result.mode === 'historical') {
      return this.loadContextGraphIdByNameHashFromHistoricalEvents(normalizedNameHash);
    }
    if (result.id !== null) {
      // The high-water counter alone cannot reveal a same-height reorg that
      // replaces a slot while preserving the total count. Re-read the exact
      // candidate on every positive lookup: this keeps the O(1) steady-state
      // path while ensuring a cached binding is never returned after its own
      // live slot stopped committing the requested hash.
      const verification = await this.loadCurrentContextGraphNameHashProviderHighWaters();
      if (verification.latestId !== result.highWater) {
        throw new Error(
          `resolveContextGraphIdByNameHash: Context Graph registry advanced from ` +
          `${result.highWater.toString()} to ${verification.latestId.toString()} ` +
          'during current-slot resolution',
        );
      }
      const currentHash = await this.getContextGraphNameHashRetryingNull(
        result.id,
        undefined,
        verification.providerHighWaters,
      );
      if (currentHash !== normalizedNameHash) {
        throw new Error(
          `resolveContextGraphIdByNameHash: indexed slot ${result.id.toString()} ` +
          `currently commits ${currentHash ?? ethers.ZeroHash}, expected ` +
          normalizedNameHash,
        );
      }
    }
    await assertCurrentLaneBinding();
    return result.id;
  }

  /**
   * Read every reachable configured backend and use the largest observed
   * registry counter. A healthy-but-lagging preferred RPC must not hide an
   * appended duplicate or make a >1024 registry enter the fast lane.
   */
  private async loadCurrentContextGraphNameHashProviderHighWaters(): Promise<{
    latestId: bigint;
    providerHighWaters: ReadonlyMap<JsonRpcProvider, bigint>;
  }> {
    await this.init();
    const cgs = this.requireContextGraphStorage();
    const providerHighWaters = new Map<JsonRpcProvider, bigint>();
    let firstFailure: unknown;
    for (const provider of this.providers) {
      try {
        await withTimeout(
          this.ensureConfiguredStaticChainIdValidated(provider),
          RPC_READ_STALL_TIMEOUT_MS,
          'resolveContextGraphIdByNameHash current high-water chainId validation',
        );
        const raw = await withTimeout(
          this.rebindContract(cgs, provider).getLatestContextGraphId(),
          RPC_READ_STALL_TIMEOUT_MS,
          'resolveContextGraphIdByNameHash current high-water read',
        );
        const latestId = BigInt(raw);
        if (latestId < 0n) {
          throw new Error(
            `resolveContextGraphIdByNameHash: getLatestContextGraphId returned ` +
            `invalid negative id ${latestId.toString()}`,
          );
        }
        providerHighWaters.set(provider, latestId);
      } catch (cause) {
        firstFailure ??= cause;
      }
    }
    if (providerHighWaters.size === 0) {
      throw firstFailure ?? new Error(
        'resolveContextGraphIdByNameHash: no RPC backend returned a current registry high-water',
      );
    }
    const latestId = [...providerHighWaters.values()].reduce(
      (maximum, value) => value > maximum ? value : maximum,
      0n,
    );
    return { latestId, providerHighWaters };
  }

  /** Identity guard for the adapter-local write-once slot index. */
  private async captureContextGraphNameHashIndexScope(): Promise<ContextGraphNameHashSlotIndexScope> {
    const cgs = this.requireContextGraphStorage();
    return {
      storageAddress: (await cgs.getAddress()).toLowerCase(),
      providers: [...this.providers],
      rpcUrls: [...this.rpcUrls],
    };
  }

  private sameContextGraphNameHashIndexScope(
    a: ContextGraphNameHashSlotIndexScope,
    b: ContextGraphNameHashSlotIndexScope,
  ): boolean {
    return a.storageAddress === b.storageAddress
      && a.providers.length === b.providers.length
      && a.providers.every((provider, index) => provider === b.providers[index])
      && a.rpcUrls.length === b.rpcUrls.length
      && a.rpcUrls.every((url, index) => url === b.rpcUrls[index]);
  }

  /** Canonical block witness retained with one complete current-slot snapshot. */
  private async captureContextGraphNameHashIndexAnchor(): Promise<ContextGraphNameHashSlotIndexAnchor> {
    const block = await this.readTipProvider(
      'resolveContextGraphIdByNameHash current-slot anchor',
      (provider) => provider.getBlock('latest'),
    );
    if (block === null || block.hash === null) {
      throw new Error(
        'resolveContextGraphIdByNameHash: latest canonical block has no hash',
      );
    }
    return {
      blockNumber: block.number,
      blockHash: block.hash.toLowerCase(),
    };
  }

  /** Re-read a retained witness block without trusting a lagging preferred RPC. */
  private loadContextGraphNameHashIndexAnchorHash(blockNumber: number): Promise<string | null> {
    return this.readProviderRetryingNull(
      'resolveContextGraphIdByNameHash validate current-slot anchor',
      async (provider) => {
        const block = await provider.getBlock(blockNumber);
        return block?.hash?.toLowerCase() ?? null;
      },
      { skipPreferred: true },
    );
  }

  /** Fixed-concurrency staged range loader for the bounded current-state lane. */
  private async loadCurrentContextGraphNameHashSlots(
    firstId: bigint,
    lastId: bigint,
    providerHighWaters: ReadonlyMap<JsonRpcProvider, bigint>,
  ): Promise<readonly ContextGraphNameHashSlot[]> {
    const scanController = new AbortController();
    const slots: ContextGraphNameHashSlot[] = [];
    let nextId = firstId;
    let failed = false;
    let firstFailure: unknown;
    const worker = async (): Promise<void> => {
      while (!failed) {
        const contextGraphId = nextId;
        if (contextGraphId > lastId) return;
        nextId += 1n;
        try {
          const currentHash = await this.getContextGraphNameHashRetryingNull(
            contextGraphId,
            scanController.signal,
            providerHighWaters,
          );
          slots.push({ id: contextGraphId, nameHash: currentHash });
        } catch (cause) {
          if (!failed) {
            failed = true;
            firstFailure = cause;
            scanController.abort(cause);
          }
          return;
        }
      }
    };

    const workerCount = Math.min(
      CONTEXT_GRAPH_NAME_HASH_ENUMERATION_CONCURRENCY,
      Number(lastId - firstId + 1n),
    );
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    if (failed) throw firstFailure;
    return slots;
  }

  /**
   * A zero slot on one RPC is not authoritative: that endpoint may lag the
   * latest high-water read. Accept null only after every configured backend
   * reports zero, while retaining the same bounded failover/error semantics as
   * the rest of the adapter.
   */
  private async getContextGraphNameHashRetryingNull(
    contextGraphId: bigint,
    signal?: AbortSignal,
    providerHighWaters?: ReadonlyMap<JsonRpcProvider, bigint>,
  ): Promise<string | null> {
    await this.init();
    const cgs = this.requireContextGraphStorage();
    const highWaters = providerHighWaters
      ?? (await this.loadCurrentContextGraphNameHashProviderHighWaters()).providerHighWaters;
    const observed = new Set<string | null>();
    let firstFailure: unknown;
    for (const [provider, highWater] of highWaters) {
      if (highWater < contextGraphId) continue;
      signal?.throwIfAborted();
      try {
        const startRead = () => Promise.resolve(
          this.rebindContract(cgs, provider).getNameHash(contextGraphId) as Promise<string>,
        );
        const physicalRead = signal
          ? withRpcRequestAbortSignal(signal, startRead)
          : startRead();
        const raw: string = await withTimeout(
          waitForContextGraphSlotRead(physicalRead, signal),
          RPC_READ_STALL_TIMEOUT_MS,
          `resolveContextGraphIdByNameHash current-slot getNameHash(${contextGraphId.toString()})`,
        );
        observed.add(!raw || raw === ethers.ZeroHash ? null : raw.toLowerCase());
      } catch (cause) {
        if (signal?.aborted) signal.throwIfAborted();
        firstFailure ??= cause;
      }
    }
    if (observed.size === 0) {
      throw firstFailure ?? new Error(
        `resolveContextGraphIdByNameHash: no RPC backend could read slot ` +
        contextGraphId.toString(),
      );
    }
    if (observed.size !== 1) {
      throw new Error(
        `resolveContextGraphIdByNameHash: RPC backends disagree on current slot ` +
        contextGraphId.toString(),
      );
    }
    return observed.values().next().value ?? null;
  }

  /**
   * Bounded fallback for registries above the fast-enumeration cap. It scans
   * the exact indexed nameHash topic from the resolved deployment block, fails
   * closed on duplicate ids, and re-reads the sole candidate's current slot.
   */
  private async loadContextGraphIdByNameHashFromHistoricalEvents(
    normalizedNameHash: string,
  ): Promise<bigint | null> {
    await this.init();
    const bindingEpoch = this.contextGraphNameHashBindingEpoch;
    const scopeBefore = await this.captureContextGraphNameHashIndexScope();
    const cgs = this.requireContextGraphStorage();
    const storageAddress = (await cgs.getAddress()).toLowerCase();
    const { fromBlock, head, scanProviders: reachableProviders } = await this.resolveContractDeployBlock(
      storageAddress,
      'resolveContextGraphIdByNameHash',
      'ContextGraphStorage',
    );
    const pages = fromBlock > head
      ? 0
      : Math.ceil((head - fromBlock + 1) / this.cgRegistryScanPageSize);
    if (pages > CG_REGISTRY_MAX_SCAN_PAGES) {
      throw new Error(
        `resolveContextGraphIdByNameHash: historical ContextGraphCreated scan ` +
        `would need ${pages} eth_getLogs calls over blocks ` +
        `[${fromBlock}, ${head}] at a ${this.cgRegistryScanPageSize}-block window ` +
        `(budget ${CG_REGISTRY_MAX_SCAN_PAGES} pages).`,
      );
    }

    // Historical pages must all come from providers that agree on one exact
    // head block. Without this fence, a lagging/forked endpoint could omit the
    // duplicate that makes the requested name hash ambiguous.
    const headProviders = reachableProviders.filter(({ backendHead }) => backendHead >= head);
    let headHash: string | null = null;
    const scanProviders: Array<(typeof reachableProviders)[number]> = [];
    for (const candidate of headProviders) {
      try {
        const block = await withTimeout(
          candidate.provider.getBlock(head),
          RPC_READ_STALL_TIMEOUT_MS,
          'resolveContextGraphIdByNameHash historical head anchor',
        );
        const candidateHash = block?.hash?.toLowerCase() ?? null;
        if (candidateHash === null) continue;
        if (headHash === null) headHash = candidateHash;
        if (candidateHash === headHash) scanProviders.push(candidate);
      } catch {
        // A backend that served getBlockNumber may still reject/stall the
        // exact head block. Keep collecting same-head providers and fail only
        // if none can anchor the scan.
      }
    }
    if (headHash === null || scanProviders.length === 0) {
      throw new Error(
        'resolveContextGraphIdByNameHash: no RPC backend could anchor the historical scan head',
      );
    }

    const usedProviders = new Set<JsonRpcProvider>([scanProviders[0]!.provider]);
    const assertScanCurrent = async (): Promise<void> => {
      const scopeAfter = await this.captureContextGraphNameHashIndexScope();
      if (
        this.contextGraphNameHashBindingEpoch !== bindingEpoch
        || !this.sameContextGraphNameHashIndexScope(scopeBefore, scopeAfter)
      ) {
        throw new Error(
          'resolveContextGraphIdByNameHash: chain provider or ContextGraphStorage ' +
          'binding changed during historical scan',
        );
      }
      for (const provider of usedProviders) {
        const block = await withTimeout(
          provider.getBlock(head),
          RPC_READ_STALL_TIMEOUT_MS,
          'resolveContextGraphIdByNameHash historical head revalidation',
        );
        if (block?.hash?.toLowerCase() !== headHash) {
          throw new Error(
            'resolveContextGraphIdByNameHash: canonical chain anchor changed ' +
            'during historical scan',
          );
        }
      }
    };

    if (fromBlock > head) {
      await assertScanCurrent();
      return null;
    }

    const filter = cgs.filters.ContextGraphCreated(null, null, normalizedNameHash);
    const connected = new Map<JsonRpcProvider, Contract>();
    const ids = new Set<bigint>();
    let preferred: JsonRpcProvider | undefined;
    for (let lo = fromBlock; lo <= head; lo += this.cgRegistryScanPageSize) {
      const hi = Math.min(lo + this.cgRegistryScanPageSize - 1, head);
      const page = await this.queryEventLogsPage(
        cgs,
        filter,
        lo,
        hi,
        scanProviders,
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
    if (ids.size === 0) return null;
    if (ids.size !== 1) {
      throw new Error(
        `resolveContextGraphIdByNameHash: ambiguous ${normalizedNameHash}; ` +
        `ContextGraphCreated committed it to ${ids.size} numeric ids`,
      );
    }

    const id = ids.values().next().value as bigint;
    const currentHash = await this.getContextGraphNameHash(id);
    if (currentHash !== normalizedNameHash) {
      throw new Error(
        `resolveContextGraphIdByNameHash: slot ${id.toString()} currently commits ` +
        `${currentHash ?? ethers.ZeroHash}, expected ${normalizedNameHash}`,
      );
    }
    await assertScanCurrent();
    return id;
  }

  /**
   * Cold-start inverse name binding. Registries within the fixed id budget use
   * current getNameHash enumeration without archive history; larger registries
   * use the bounded deploy-anchored exact-topic fallback. Both lanes scan their
   * complete bounded source so duplicate commitments fail closed.
   */
  async resolveContextGraphIdByNameHash(
    nameHash: string,
    options: ChainReadOptions = {},
  ): Promise<bigint | null> {
    this.contextGraphNameHashResolver ??= new ContextGraphNameHashResolver({
      load: (normalizedNameHash) =>
        this.loadContextGraphIdByNameHashFromChain(normalizedNameHash),
    });
    return this.contextGraphNameHashResolver.resolve(nameHash, options.signal);
  }
}
