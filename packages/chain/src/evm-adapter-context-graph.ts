// SPDX-License-Identifier: Apache-2.0

/**
 * Context-graph create / publish / read / policy methods.
 *
 * Mixin holder extracted from evm-adapter.ts. `extends EVMChainAdapterBase`
 * for shared state (providers, signers, caches) reached via `this`. Bodies
 * are a 1:1 move — no behaviour change. Mixed into the concrete EVMChainAdapter
 * via applyMixins(); see evm-adapter.ts for the assembly.
 */

import { EVMChainAdapterBase, CG_REGISTRY_MAX_SCAN_PAGES, CG_REGISTRY_REORG_BUFFER_BLOCKS } from './evm-adapter-base.js';
import { ethers, Contract, type JsonRpcProvider } from 'ethers';
import { ContextGraphChainScanPartialError, type CreateContextGraphParams, type TxResult, type ContextGraphOnChain, type ContextGraphChainScanOptions, type CreateOnChainContextGraphParams, type CreateOnChainContextGraphResult, type VerifyParams, type PublishToContextGraphParams, type OnChainPublishResult } from './chain-adapter.js';
import { buildAuthorAttestationTypedData, AUTHOR_SCHEME_VERSION_V1 } from '@origintrail-official/dkg-core';

export class ContextGraphMethods extends EVMChainAdapterBase {
  /**
   * Reserve the next authorized signer and return its address. The publisher
   * uses this to bind off-chain signatures to the tx signer before
   * `publishDirect` is submitted.
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
    return this.contextGraphRegistryScanWatermarks.has(registryAddress);
  }

  async listContextGraphsFromChain(
    fromBlock?: number,
    options?: ContextGraphChainScanOptions,
  ): Promise<ContextGraphOnChain[]> {
    await this.init();
    const registry = this.contracts.contextGraphNameRegistry;
    if (!registry) return [];
    const eventFilter = registry.filters.NameClaimed();
    const registryAddress = (await registry.getAddress()).toLowerCase();
    const incremental = options?.incremental === true && fromBlock === undefined;
    const seedIncrementalWatermark =
      options?.seedIncrementalWatermark === true && !incremental && fromBlock === undefined;
    const watermark = incremental
      ? this.contextGraphRegistryScanWatermarks.get(registryAddress)
      : undefined;
    const scan =
      fromBlock === undefined
        ? incremental && watermark !== undefined
          ? { fromBlock: 0, ...(await this.resolveLogScanHead('listContextGraphsFromChain')) }
          : await this.resolveContractDeployBlock(
              registryAddress,
              'listContextGraphsFromChain',
              'ContextGraphNameRegistry',
            )
        : { fromBlock, ...(await this.resolveLogScanHead('listContextGraphsFromChain')) };
    const { fromBlock: deployBlock, head, scanProviders, degradedFromGenesis = false } = scan;
    const start = fromBlock ?? (
      incremental && watermark !== undefined
        ? Math.max(0, watermark - CG_REGISTRY_REORG_BUFFER_BLOCKS)
        : deployBlock
    );
    if (start > head) {
      if (seedIncrementalWatermark) {
        this.contextGraphRegistryScanWatermarks.set(registryAddress, head + 1);
      }
      return [];
    }

    const pageSize = this.cgRegistryScanPageSize;
    const pages = Math.ceil((head - start + 1) / pageSize);
    const blockBudget = CG_REGISTRY_MAX_SCAN_PAGES * pageSize;
    if (incremental && !degradedFromGenesis && pages > CG_REGISTRY_MAX_SCAN_PAGES) {
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

    // Incremental daemon scans can resume from the scanned prefix after a later
    // page failure. Public list-all calls should remain all-or-error.
    for (let lo = start; lo <= head; lo += pageSize) {
      const hi = Math.min(lo + pageSize - 1, head);
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
        const pageResults: ContextGraphOnChain[] = [];
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
        results.push(...pageResults);
        scannedAnyPage = true;
        if (incremental) {
          this.contextGraphRegistryScanWatermarks.set(registryAddress, hi + 1);
        }
      } catch (err) {
        if (incremental && scannedAnyPage) {
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
    }

    if (seedIncrementalWatermark) {
      this.contextGraphRegistryScanWatermarks.set(registryAddress, head + 1);
    }

    return results;
  }

  // =====================================================================
  // On-Chain Context Graphs (ContextGraphs contract)
  // =====================================================================

  /** True when `contextGraphId` is an active minted CG in ContextGraphStorage. */
  async isContextGraphActiveOnChain(contextGraphId: bigint): Promise<boolean> {
    await this.init();
    const cgs = this.requireContextGraphStorage();
    return Boolean(await cgs.isContextGraphActive(contextGraphId));
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
    const receipt = await this.sendContractTransaction(
      this.contracts.contextGraphs,
      'createContextGraph',
      [
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
      ],
      this.signer,
      'create on-chain context graph',
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
    const v10ChainId = (await this.provider.getNetwork()).chainId;
    const v10KavAddress = await this.contracts.knowledgeAssetsLifecycle!.getAddress();
    const authorTypedData = buildAuthorAttestationTypedData({
      chainId: v10ChainId,
      kav10Address: v10KavAddress,
      contextGraphId: params.contextGraphId,
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

  async getKAContextGraphId(kaId: bigint): Promise<bigint> {
    await this.init();
    const cgs = this.requireContextGraphStorage();
    const cgId: bigint = await cgs.kaToContextGraph(kaId);
    return BigInt(cgId);
  }

  async getContextGraphKCCount(contextGraphId: bigint): Promise<bigint> {
    await this.init();
    const cgs = this.requireContextGraphStorage();
    const count: bigint = await cgs.getContextGraphKCCount(contextGraphId);
    return BigInt(count);
  }

  async getContextGraphKCAt(contextGraphId: bigint, index: bigint): Promise<bigint> {
    await this.init();
    const cgs = this.requireContextGraphStorage();
    const kaId: bigint = await cgs.getContextGraphKCAt(contextGraphId, index);
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
      const raw: bigint = BigInt(await cgs.getAccessPolicy(contextGraphId));
      return Number(raw);
    } catch (primaryErr) {
      try {
        const cg = await cgs.getContextGraph(contextGraphId);
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
    const result = await cgs.getPublishPolicy(contextGraphId);
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
    const raw: string[] = await cgs.getParticipantAgents(contextGraphId);
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
  async getContextGraphNameHash(contextGraphId: bigint): Promise<string | null> {
    await this.init();
    const cgs = this.requireContextGraphStorage();
    const raw: string = await cgs.getNameHash(contextGraphId);
    if (!raw || raw === ethers.ZeroHash) return null;
    return raw.toLowerCase();
  }
}
