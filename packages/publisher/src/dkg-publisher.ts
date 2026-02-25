import type { Quad, TripleStore } from '@dkg/storage';
import type { ChainAdapter, OnChainPublishResult } from '@dkg/chain';
import type { EventBus, OperationContext } from '@dkg/core';
import { DKGEvent, Logger, createOperationContext, sha256, MerkleTree, type Ed25519Keypair } from '@dkg/core';
import { GraphManager, PrivateContentStore } from '@dkg/storage';
import type { Publisher, PublishOptions, PublishResult, KAManifestEntry } from './publisher.js';
import { autoPartition } from './auto-partition.js';
import { skolemize } from './skolemize.js';
import { computeTripleHash, computePublicRoot, computePrivateRoot, computeKARoot, computeKCRoot } from './merkle.js';
import { validatePublishRequest } from './validation.js';
import {
  generateTentativeMetadata,
  generateConfirmedFullMetadata,
  type KAMetadata,
} from './metadata.js';
import { ethers } from 'ethers';

export interface DKGPublisherConfig {
  store: TripleStore;
  chain: ChainAdapter;
  eventBus: EventBus;
  keypair: Ed25519Keypair;
  publisherNodeIdentityId?: bigint;
  publisherAddress?: string;
  /** EVM private key for signing publish requests (hex string with 0x prefix) */
  publisherPrivateKey?: string;
  /**
   * Additional EVM private keys whose identities can act as receiver signers.
   * If empty, only the primary publisherPrivateKey is used for self-signing.
   */
  additionalSignerKeys?: string[];
}

export class DKGPublisher implements Publisher {
  private readonly store: TripleStore;
  private readonly chain: ChainAdapter;
  private readonly eventBus: EventBus;
  private readonly keypair: Ed25519Keypair;
  private readonly graphManager: GraphManager;
  private readonly privateStore: PrivateContentStore;
  private readonly ownedEntities = new Map<string, Set<string>>();
  private publisherNodeIdentityId: bigint;
  private readonly publisherAddress: string;
  private readonly publisherWallet?: ethers.Wallet;
  /** Additional wallets that can provide receiver signatures. */
  private readonly additionalSignerWallets: ethers.Wallet[] = [];
  private readonly log = new Logger('DKGPublisher');

  constructor(config: DKGPublisherConfig) {
    this.store = config.store;
    this.chain = config.chain;
    this.eventBus = config.eventBus;
    this.keypair = config.keypair;
    this.publisherNodeIdentityId = config.publisherNodeIdentityId ?? 0n;

    if (config.publisherPrivateKey) {
      this.publisherWallet = new ethers.Wallet(config.publisherPrivateKey);
      this.publisherAddress = this.publisherWallet.address;
    } else {
      this.publisherAddress = config.publisherAddress ?? '0x' + '0'.repeat(40);
      if (config.chain.chainId !== 'none') {
        const random = ethers.Wallet.createRandom();
        this.publisherWallet = new ethers.Wallet(random.privateKey);
      }
    }

    for (const key of config.additionalSignerKeys ?? []) {
      this.additionalSignerWallets.push(new ethers.Wallet(key));
    }

    this.graphManager = new GraphManager(config.store);
    this.privateStore = new PrivateContentStore(config.store, this.graphManager);
  }

  async publish(options: PublishOptions): Promise<PublishResult> {
    const { paranetId, quads, privateQuads = [], operationCtx, entityProofs = false } = options;
    const ctx: OperationContext = operationCtx ?? createOperationContext('publish');

    this.log.info(ctx, `Preparing publish: ${quads.length} public triples, ${privateQuads.length} private (entityProofs=${entityProofs})`);
    await this.graphManager.ensureParanet(paranetId);

    const kaMap = autoPartition(quads);

    const manifestEntries: KAManifestEntry[] = [];
    const kaMetadata: KAMetadata[] = [];

    // Step 1: Compute privateMerkleRoot over ALL private triples
    let privateMerkleRoot: Uint8Array | undefined;
    if (privateQuads.length > 0) {
      privateMerkleRoot = computePrivateRoot(privateQuads);
    }

    // Step 2: Build manifest entries (needed regardless of merkle mode)
    let tokenCounter = 1n;
    for (const [rootEntity, publicQuads] of kaMap) {
      const entityPrivateQuads = privateQuads.filter(
        (q) => q.subject === rootEntity || q.subject.startsWith(rootEntity + '/.well-known/genid/'),
      );

      manifestEntries.push({
        tokenId: tokenCounter,
        rootEntity,
        privateMerkleRoot: entityPrivateQuads.length > 0
          ? computePrivateRoot(entityPrivateQuads)
          : undefined,
        privateTripleCount: entityPrivateQuads.length,
      });

      kaMetadata.push({
        rootEntity,
        kcUal: '',
        tokenId: tokenCounter,
        publicTripleCount: publicQuads.length,
        privateTripleCount: entityPrivateQuads.length,
        privateMerkleRoot: entityPrivateQuads.length > 0
          ? computePrivateRoot(entityPrivateQuads)
          : undefined,
      });

      tokenCounter++;
    }

    const allSkolemizedQuads = [...kaMap.values()].flat();
    const existing = this.ownedEntities.get(paranetId) ?? new Set();
    const validation = validatePublishRequest(allSkolemizedQuads, manifestEntries, paranetId, existing);
    if (!validation.valid) {
      throw new Error(`Validation failed: ${validation.errors.join('; ')}`);
    }

    // Step 3: Compute kcMerkleRoot using the two-level scheme
    let kcMerkleRoot: Uint8Array;
    const allPublicHashes = allSkolemizedQuads.map(computeTripleHash);

    if (privateMerkleRoot) {
      // Anchor privateMerkleRoot as a synthetic public triple hash
      const syntheticTripleHash = computeTripleHash({
        subject: `urn:dkg:kc`,
        predicate: 'http://dkg.io/ontology/privateContentRoot',
        object: `"0x${Buffer.from(privateMerkleRoot).toString('hex')}"`,
        graph: '',
      });
      allPublicHashes.push(syntheticTripleHash);
    }

    if (entityProofs) {
      // Per-entity kaRoots → Merkle tree
      const kaRoots: Uint8Array[] = [];
      for (const [rootEntity, publicQuads] of kaMap) {
        const pubRoot = computePublicRoot(publicQuads);
        kaRoots.push(pubRoot ?? new Uint8Array(32));
      }
      kcMerkleRoot = computeKCRoot(kaRoots);
      this.log.info(ctx, `Computed kcMerkleRoot (entityProofs) for ${kaRoots.length} KAs`);
    } else {
      // Flat hash over all public triples + synthetic anchor
      const tree = new MerkleTree(allPublicHashes);
      kcMerkleRoot = tree.root;
      this.log.info(ctx, `Computed kcMerkleRoot (flat) over ${allPublicHashes.length} triple hashes`);
    }
    const kaCount = manifestEntries.length;

    const dataGraph = this.graphManager.dataGraphUri(paranetId);
    const normalizedQuads = allSkolemizedQuads.map((q) => ({ ...q, graph: dataGraph }));

    // Store synthetic triple anchoring privateMerkleRoot in the data graph
    if (privateMerkleRoot) {
      normalizedQuads.push({
        subject: 'urn:dkg:kc',
        predicate: 'http://dkg.io/ontology/privateContentRoot',
        object: `"0x${Buffer.from(privateMerkleRoot).toString('hex')}"`,
        graph: dataGraph,
      });
    }

    this.log.info(ctx, `Storing ${normalizedQuads.length} triples in local store`);
    await this.store.insert(normalizedQuads);

    // Store private quads
    for (const [rootEntity] of kaMap) {
      const entityPrivateQuads = privateQuads.filter(
        (q) => q.subject === rootEntity || q.subject.startsWith(rootEntity + '/.well-known/genid/'),
      );
      if (entityPrivateQuads.length > 0) {
        await this.privateStore.storePrivateTriples(paranetId, rootEntity, entityPrivateQuads);
      }
    }

    let onChainResult: OnChainPublishResult | undefined;
    let status: 'tentative' | 'confirmed' = 'tentative';
    let ual = `did:dkg:${this.chain.chainId}/${this.publisherAddress}/0`;

    // Build EVM ECDSA signatures for on-chain verification
    const merkleRootHex = ethers.hexlify(kcMerkleRoot);
    const identityId = this.publisherNodeIdentityId;

    if (!this.publisherWallet) {
      this.log.warn(ctx, `No EVM wallet configured — skipping on-chain publish`);
    } else if (identityId === 0n) {
      this.log.warn(ctx, `Identity not set (0) — skipping on-chain publish`);
    } else {
      this.log.info(ctx, `Signing on-chain publish (identityId=${identityId}, signer=${this.publisherWallet.address})`);

      // Public byte size = length of serialized public N-Quads (must match what receivers sign)
      const nquadsStr = allSkolemizedQuads
        .map(
          (q) =>
            `<${q.subject}> <${q.predicate}> ${q.object.startsWith('"') ? q.object : `<${q.object}>`} <${q.graph}> .`,
        )
        .join('\n');
      const publicByteSize = BigInt(new TextEncoder().encode(nquadsStr).length);

      const tokenAmount =
        typeof this.chain.getRequiredPublishTokenAmount === 'function'
          ? await this.chain.getRequiredPublishTokenAmount(publicByteSize, 1)
          : 1n;

      // Publisher signature: sign keccak256(abi.encodePacked(uint72 identityId, bytes32 merkleRoot))
      const pubMsgHash = ethers.solidityPackedKeccak256(
        ['uint72', 'bytes32'],
        [identityId, merkleRootHex],
      );
      const pubSig = ethers.Signature.from(
        await this.publisherWallet.signMessage(ethers.getBytes(pubMsgHash)),
      );

      // Receiver signature: sign (merkleRoot, publicByteSize) so attested size is binding on-chain
      const rcvMsgHash = ethers.solidityPackedKeccak256(
        ['bytes32', 'uint64'],
        [merkleRootHex, publicByteSize],
      );
      const rcvSig = ethers.Signature.from(
        await this.publisherWallet.signMessage(ethers.getBytes(rcvMsgHash)),
      );

      this.log.info(ctx, `Submitting on-chain publish tx (${kaCount} KAs, publicByteSize=${publicByteSize}, tokenAmount=${tokenAmount})`);
      try {
        onChainResult = await this.chain.publishKnowledgeAssets({
          kaCount,
          publisherNodeIdentityId: identityId,
          merkleRoot: kcMerkleRoot,
          publicByteSize,
          epochs: 1,
          tokenAmount,
          publisherSignature: {
            r: ethers.getBytes(pubSig.r),
            vs: ethers.getBytes(pubSig.yParityAndS),
          },
          receiverSignatures: [
            {
              identityId,
              r: ethers.getBytes(rcvSig.r),
              vs: ethers.getBytes(rcvSig.yParityAndS),
            },
          ],
        });

        // V9 UAL: did:dkg:{chainId}/{publisherAddress}/{firstKAId}
        ual = `did:dkg:${this.chain.chainId}/${onChainResult.publisherAddress}/${onChainResult.startKAId}`;

        for (const km of kaMetadata) {
          km.kcUal = ual;
        }
        const confirmedQuads = generateConfirmedFullMetadata(
          {
            ual,
            paranetId,
            merkleRoot: kcMerkleRoot,
            kaCount,
            publisherPeerId: '',
            timestamp: new Date(),
          },
          kaMetadata,
          {
            txHash: onChainResult.txHash,
            blockNumber: onChainResult.blockNumber,
            blockTimestamp: onChainResult.blockTimestamp,
            publisherAddress: onChainResult.publisherAddress,
            batchId: onChainResult.batchId,
            chainId: this.chain.chainId,
          },
        );
        await this.store.insert(confirmedQuads);
        status = 'confirmed';
        this.log.info(ctx, `On-chain confirmed: UAL=${ual} batchId=${onChainResult.batchId} tx=${onChainResult.txHash}`);
      } catch (err) {
        this.log.warn(ctx, `On-chain tx failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (status === 'tentative') {
      ual = `did:dkg:${this.chain.chainId}/${this.publisherAddress}/0`;
      for (const km of kaMetadata) {
        km.kcUal = ual;
      }
      const tentativeQuads = generateTentativeMetadata(
        {
          ual,
          paranetId,
          merkleRoot: kcMerkleRoot,
          kaCount,
          publisherPeerId: '',
          timestamp: new Date(),
        },
        kaMetadata,
      );
      await this.store.insert(tentativeQuads);
      this.log.info(ctx, `Stored as tentative: UAL=${ual}`);
    }

    // Track owned entities only on confirmed publishes
    if (status === 'confirmed') {
      if (!this.ownedEntities.has(paranetId)) {
        this.ownedEntities.set(paranetId, new Set());
      }
      for (const e of manifestEntries) {
        this.ownedEntities.get(paranetId)!.add(e.rootEntity);
      }
    }

    const result: PublishResult = {
      kcId: onChainResult?.batchId ?? 0n,
      merkleRoot: kcMerkleRoot,
      kaManifest: manifestEntries,
      status,
      onChainResult,
    };

    this.eventBus.emit(DKGEvent.KC_PUBLISHED, result);
    return result;
  }

  async update(kcId: bigint, options: PublishOptions): Promise<PublishResult> {
    const { paranetId, quads, privateQuads = [], operationCtx } = options;
    const ctx: OperationContext = operationCtx ?? createOperationContext('publish');
    this.log.info(ctx, `Updating kcId=${kcId} with ${quads.length} triples`);
    const dataGraph = this.graphManager.dataGraphUri(paranetId);

    const kaMap = autoPartition(quads);
    const kaRoots: Uint8Array[] = [];
    const manifestEntries: KAManifestEntry[] = [];

    let tokenCounter = 1n;
    for (const [rootEntity, publicQuads] of kaMap) {
      await this.store.deleteBySubjectPrefix(dataGraph, rootEntity);
      await this.privateStore.deletePrivateTriples(paranetId, rootEntity);

      const entityPrivateQuads = privateQuads.filter(
        (q) => q.subject === rootEntity || q.subject.startsWith(rootEntity + '/.well-known/genid/'),
      );

      const pubRoot = computePublicRoot(publicQuads);
      const privRoot = entityPrivateQuads.length > 0 ? computePrivateRoot(entityPrivateQuads) : undefined;

      kaRoots.push(computeKARoot(pubRoot, privRoot));
      manifestEntries.push({
        tokenId: tokenCounter++,
        rootEntity,
        privateMerkleRoot: privRoot,
        privateTripleCount: entityPrivateQuads.length,
      });

      const normalized = publicQuads.map((q) => ({ ...q, graph: dataGraph }));
      await this.store.insert(normalized);

      if (entityPrivateQuads.length > 0) {
        await this.privateStore.storePrivateTriples(paranetId, rootEntity, entityPrivateQuads);
      }
    }

    const kcMerkleRoot = computeKCRoot(kaRoots);

    const allSkolemizedQuads = [...kaMap.values()].flat();
    await this.chain.updateKnowledgeAssets({
      batchId: kcId,
      newMerkleRoot: kcMerkleRoot,
      newPublicByteSize: BigInt(allSkolemizedQuads.length * 100),
    });

    const result: PublishResult = {
      kcId,
      merkleRoot: kcMerkleRoot,
      kaManifest: manifestEntries,
      status: 'confirmed',
    };

    this.eventBus.emit(DKGEvent.KA_UPDATED, result);
    return result;
  }

  setIdentityId(id: bigint): void {
    this.publisherNodeIdentityId = id;
  }

  getIdentityId(): bigint {
    return this.publisherNodeIdentityId;
  }

  autoPartition(quads: Quad[]): KAManifestEntry[] {
    const kaMap = autoPartition(quads);
    let tokenId = 1n;
    return [...kaMap.keys()].map((rootEntity) => ({
      tokenId: tokenId++,
      rootEntity,
    }));
  }

  skolemize(rootEntity: string, quads: Quad[]): Quad[] {
    return skolemize(rootEntity, quads);
  }
}
