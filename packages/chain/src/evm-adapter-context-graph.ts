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
import { ContextGraphChainScanPartialError, type ChainReadOptions, type ContextGraphAuthoritySnapshot, type CreateContextGraphParams, type TxResult, type ContextGraphOnChain, type ContextGraphChainScanOptions, type ContextGraphRegistryScanOptions, type ContextGraphRegistryScanPage, type CreateOnChainContextGraphParams, type CreateOnChainContextGraphResult, type VerifyParams, type PublishToContextGraphParams, type OnChainPublishResult } from './chain-adapter.js';
import { buildAuthorAttestationTypedData, AUTHOR_SCHEME_VERSION_V1 } from '@origintrail-official/dkg-core';

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

  async addContextGraphParticipantAgent(contextGraphId: bigint, agent: string): Promise<TxResult> {
    await this.init();
    const contextGraphs = this.contracts.contextGraphs;
    if (!contextGraphs) {
      throw new Error('ContextGraphs contract not deployed.');
    }
    const receipt = await this.sendContractTransaction(
      contextGraphs,
      'addParticipantAgent',
      [contextGraphId, ethers.getAddress(agent)],
      this.signer,
      'add context graph participant agent',
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
    const receipt = await this.sendContractTransaction(
      contextGraphs,
      'removeParticipantAgent',
      [contextGraphId, ethers.getAddress(agent)],
      this.signer,
      'remove context graph participant agent',
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
   * Resolve policy, membership, and their stable event-derived generations at
   * one finalized block. The event generation (rather than the observation
   * block) keeps independently booted RFC-64 peers on the same policy digest.
   */
  async getContextGraphAuthoritySnapshot(
    contextGraphId: bigint,
    options: ChainReadOptions = {},
  ): Promise<ContextGraphAuthoritySnapshot> {
    await this.init();
    options.signal?.throwIfAborted();
    const base = this.requireContextGraphStorage();
    return this.readTipProvider(
      'getContextGraphAuthoritySnapshot',
      async (provider) => {
        options.signal?.throwIfAborted();
        const finalized = await provider.getBlock('finalized');
        if (finalized === null || finalized.hash === null) {
          throw new Error('finalized Context Graph authority block is unavailable');
        }
        const contract = base.connect(provider) as Contract;
        const filters = contract.filters as unknown as Record<
          string,
          (...args: unknown[]) => ethers.DeferredTopicFilter
        >;
        const contractAddress = await contract.getAddress();
        const { fromBlock } = await this.resolveContractDeployBlock(
          contractAddress,
          'getContextGraphAuthoritySnapshot',
          'ContextGraphStorage',
        );
        const readLogs = async (name: string, ...args: unknown[]) => {
          const filter = filters[name]!(...args);
          const logs: Array<ethers.EventLog | ethers.Log> = [];
          // Production RPCs commonly cap eth_getLogs ranges. Keep every read
          // deployment-anchored and page-bounded while all state and event
          // results remain pinned to the single finalized anchor selected
          // above. The exact Context Graph stays encoded in each filter.
          for (
            let lo = fromBlock;
            lo <= finalized.number;
            lo += this.cgRegistryScanPageSize
          ) {
            options.signal?.throwIfAborted();
            const hi = Math.min(
              lo + this.cgRegistryScanPageSize - 1,
              finalized.number,
            );
            logs.push(...await contract.queryFilter(filter, lo, hi));
          }
          return logs;
        };
        const [
          current,
          created,
          transfers,
          publishPolicyUpdates,
          publishAuthorityUpdates,
          participantAdds,
          participantRemoves,
        ] = await Promise.all([
          (contract as any).getContextGraph.staticCall(
            contextGraphId,
            { blockTag: finalized.number },
          ),
          readLogs('ContextGraphCreated', contextGraphId),
          readLogs('Transfer', null, null, contextGraphId),
          readLogs('PublishPolicyUpdated', contextGraphId),
          readLogs('PublishAuthorityUpdated', contextGraphId),
          readLogs('AgentParticipantAdded', contextGraphId),
          readLogs('AgentParticipantRemoved', contextGraphId),
        ]);
        options.signal?.throwIfAborted();
        if (created.length !== 1) {
          throw new Error(
            `Context Graph ${contextGraphId.toString()} has ${created.length} finalized creation events`,
          );
        }
        const creationEvent = created[0] as ethers.EventLog;
        const post = await provider.getBlock(finalized.number);
        if (post?.hash?.toLowerCase() !== finalized.hash.toLowerCase()) {
          throw new Error('finalized Context Graph authority anchor changed during resolution');
        }
        const policyEvents = [...created, ...transfers, ...publishPolicyUpdates,
          ...publishAuthorityUpdates].sort((left, right) => (
          left.blockNumber - right.blockNumber || left.index - right.index
        ));
        const source = policyEvents.at(-1)!;
        const participantAgents = [...(current.participantAgents ?? current[1] ?? [])]
          .map((address) => String(address).toLowerCase())
          .sort();
        const owner = String(current.owner ?? current[0]).toLowerCase();
        const accessPolicy = Number(BigInt(current.accessPolicy ?? current[5]));
        const publishPolicy = Number(BigInt(current.publishPolicy ?? current[6]));
        const authorityRaw = String(current.publishAuthority ?? current[7]).toLowerCase();
        const ownershipEra = Math.max(0, transfers.length - 1);
        return Object.freeze({
          chainId: (await provider.getNetwork()).chainId.toString(10),
          governanceContract: (await contract.getAddress()).toLowerCase(),
          contextGraphId: contextGraphId.toString(10),
          owner,
          active: Boolean(current.active ?? current[3]),
          accessPolicy,
          publishPolicy,
          publishAuthority: authorityRaw === ethers.ZeroAddress ? null : authorityRaw,
          publishAuthorityAccountId:
            BigInt(current.publishAuthorityAccountId ?? current[8]).toString(10),
          participantAgents: Object.freeze(participantAgents),
          nameHash: String(creationEvent.args[2]).toLowerCase(),
          ownershipEra: ownershipEra.toString(10),
          policyVersion: (
            ownershipEra + publishPolicyUpdates.length + publishAuthorityUpdates.length
          ).toString(10),
          rosterVersion: (
            ownershipEra + participantAdds.length + participantRemoves.length
          ).toString(10),
          sourceBlockNumber: source.blockNumber.toString(10),
          sourceBlockHash: source.blockHash.toLowerCase(),
        });
      },
      { signal: options.signal },
    );
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
