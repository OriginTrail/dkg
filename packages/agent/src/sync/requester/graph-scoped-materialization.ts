import {
  assertSafeIri,
  parseDeterministicKnowledgeAssetUal,
} from '@origintrail-official/dkg-core';
import type { ChainAdapter } from '@origintrail-official/dkg-chain';
import {
  tryReplaceGraphAndSubjectAtomically,
  type Quad,
  type QueryOptions,
  type TripleStore,
} from '@origintrail-official/dkg-storage';
import {
  readLocallyTrustedKnowledgeAssetControls,
  withMaterializationLock,
} from '@origintrail-official/dkg-publisher';
import {
  filterOversizedSyncQuads,
  type OversizeGuardHooks,
} from '../oversize-filter.js';

const ASSERTION_VERSION = 'http://dkg.io/ontology/assertionVersion';
const MERKLE_ROOT = 'http://dkg.io/ontology/merkleRoot';
const STATUS = 'http://dkg.io/ontology/status';
const TRANSACTION_HASH = 'http://dkg.io/ontology/transactionHash';
const MATERIALIZED_VERSION = 'http://dkg.io/ontology/materializedVersion';
const PUBLISHED_AT = 'http://dkg.io/ontology/publishedAt';
const XSD_DATE_TIME = 'http://www.w3.org/2001/XMLSchema#dateTime';

export interface VerifiedGraphScopedAsset {
  contextGraphId: string;
  ual: string;
  assertionVersion: bigint;
  assertionGraph: string;
  metaGraph: string;
  dataQuads: Quad[];
  metadataQuads: Quad[];
}

export interface AuthenticatedGraphScopedAsset {
  asset: VerifiedGraphScopedAsset;
  /** Null only for explicit no-chain development mode. */
  onChainContextGraphId: string | null;
}

export type VerifyContextGraphBinding = (
  localContextGraphId: string,
  onChainContextGraphId: bigint,
) => Promise<boolean>;

export type GraphScopedMaterializationOutcome = 'applied' | 'stale' | 'quarantined';

/**
 * Bind the peer-verified payload to current chain truth before its structural
 * metadata can influence local assertion ordering. No-chain development keeps
 * the integrity-only behavior; production chains fail closed without the
 * required constant-size chain views. Local-id matching stays in the agent's
 * context-graph identity layer and is injected here as a focused verifier.
 */
export async function authenticateVerifiedGraphScopedAsset(
  chain: ChainAdapter,
  asset: VerifiedGraphScopedAsset,
  verifyContextGraphBinding?: VerifyContextGraphBinding,
  receivedAt = new Date(),
): Promise<AuthenticatedGraphScopedAsset> {
  const receivedAtMs = receivedAt.getTime();
  if (!Number.isFinite(receivedAtMs)) {
    throw new Error(`Graph-scoped durable sync ${asset.ual} has an invalid local receive time`);
  }
  const locallyVisibleMetadata = (status: 'confirmed' | 'tentative'): Quad[] => [
    {
      subject: asset.ual,
      predicate: PUBLISHED_AT,
      object: `"${receivedAt.toISOString()}"^^<${XSD_DATE_TIME}>`,
      graph: asset.metaGraph,
    },
    {
      subject: asset.ual,
      predicate: STATUS,
      object: `"${status}"`,
      graph: asset.metaGraph,
    },
  ];
  const structuralMetadata = asset.metadataQuads.filter((quad) => (
    quad.predicate !== PUBLISHED_AT
    && quad.predicate !== STATUS
    && quad.predicate !== MATERIALIZED_VERSION
  ));
  // The timestamp above is local receive time, not peer metadata. It is safe
  // for discovery ordering and keeps graph-scoped KAs visible without trusting
  // a peer-controlled dkg:publishedAt value. No-chain mode remains explicitly
  // tentative because it has integrity verification but no chain provenance.
  if (chain.chainId === 'none') {
    return {
      asset: {
        ...asset,
        metadataQuads: [...structuralMetadata, ...locallyVisibleMetadata('tentative')],
      },
      onChainContextGraphId: null,
    };
  }
  if (
    !chain.getLatestMerkleRoot
    || !chain.getMerkleRootCount
    || !chain.getKAContextGraphId
  ) {
    throw Object.assign(
      new Error(
        'Graph-scoped durable sync requires chain root, assertion-count, and context-graph verification',
      ),
      { code: 'VM_CHAIN_VERIFICATION_UNSUPPORTED' },
    );
  }
  const identity = parseDeterministicKnowledgeAssetUal(asset.ual);
  if (identity.chainId !== chain.chainId) {
    throw new Error(
      `Graph-scoped durable sync UAL chain ${identity.chainId} does not match local chain ${chain.chainId}`,
    );
  }
  const kaId = (BigInt(identity.agentAddress) << 96n) | BigInt(identity.kaNumber);
  const roots = asset.metadataQuads
    .filter((quad) => quad.predicate === MERKLE_ROOT)
    .map((quad) => parseBytes32Literal(quad.object, 'merkleRoot'));
  if (roots.length !== 1) {
    throw new Error(`Graph-scoped durable sync ${asset.ual} has ${roots.length} Merkle roots`);
  }
  const [latestRoot, rootCount, boundContextGraphId] = await Promise.all([
    chain.getLatestMerkleRoot(kaId),
    chain.getMerkleRootCount(kaId),
    chain.getKAContextGraphId(kaId),
  ]);
  if (latestRoot.length !== 32 || !bytesEqual(latestRoot, roots[0]!)) {
    throw Object.assign(
      new Error(`Graph-scoped durable sync ${asset.ual} does not match the latest on-chain Merkle root`),
      { code: 'VM_CHAIN_ROOT_MISMATCH' },
    );
  }
  if (rootCount !== asset.assertionVersion) {
    throw Object.assign(
      new Error(
        `Graph-scoped durable sync ${asset.ual} assertionVersion ${asset.assertionVersion} ` +
        `does not match on-chain root count ${rootCount}`,
      ),
      { code: 'VM_CHAIN_ASSERTION_VERSION_MISMATCH' },
    );
  }
  if (boundContextGraphId <= 0n) {
    throw Object.assign(
      new Error(
        `Graph-scoped durable sync ${asset.ual} is bound to invalid context graph ${boundContextGraphId}`,
      ),
      { code: 'VM_CHAIN_CONTEXT_GRAPH_MISMATCH' },
    );
  }
  if (!verifyContextGraphBinding) {
    throw Object.assign(
      new Error('Graph-scoped durable sync requires local-to-chain context-graph verification'),
      { code: 'VM_CHAIN_VERIFICATION_UNSUPPORTED' },
    );
  }
  if (!(await verifyContextGraphBinding(asset.contextGraphId, boundContextGraphId))) {
    throw Object.assign(
      new Error(
        `Graph-scoped durable sync ${asset.ual} is bound to context graph ${boundContextGraphId}, `
        + `which does not match local context graph ${asset.contextGraphId}`,
      ),
      { code: 'VM_CHAIN_CONTEXT_GRAPH_MISMATCH' },
    );
  }
  const transactionHashes = asset.metadataQuads
    .filter((quad) => quad.predicate === TRANSACTION_HASH)
    .map((quad) => parseTransactionHashLiteral(quad.object));
  if (transactionHashes.length > 1) {
    throw Object.assign(
      new Error(
        `Graph-scoped durable sync ${asset.ual} allows at most one receipt transaction hash, `
          + `got ${transactionHashes.length}`,
      ),
      { code: 'VM_CHAIN_PROVENANCE_MISMATCH' },
    );
  }

  let materializedBlock: number;
  let materializedTxIndex: number;
  if (transactionHashes.length === 0) {
    // RFC-64 finalized VM materialization deliberately has no receipt claim:
    // it is reconstructed from a pinned finalized chain snapshot. A later
    // durable-sync requester must not trust the serving peer's local
    // materializedVersion, and the requester strips that field before this
    // boundary. The independently read current root, root count, KA->CG
    // binding, and local CG name binding above fully authenticate the exact
    // current assertion. Use a neutral LOCAL ordering stamp; assertionVersion
    // remains the authoritative stale-write guard for this receiptless lane.
    materializedBlock = 0;
    materializedTxIndex = 0;
  } else if (asset.assertionVersion === 1n) {
    const transactionHash = transactionHashes[0]!;
    if (!chain.resolvePublishByTxHash) {
      throw Object.assign(
        new Error('Graph-scoped durable sync requires receipt-backed publish verification'),
        { code: 'VM_CHAIN_PROVENANCE_UNSUPPORTED' },
      );
    }
    const resolved = await chain.resolvePublishByTxHash(transactionHash);
    const resolvedKaId = resolved?.kaId ?? resolved?.batchId;
    if (
      !resolved
      || resolvedKaId !== kaId
      || resolved.merkleRoot === undefined
      || !bytesEqual(resolved.merkleRoot, roots[0]!)
      || resolved.txHash.toLowerCase() !== transactionHash.toLowerCase()
    ) {
      throw Object.assign(
        new Error(`Graph-scoped durable sync ${asset.ual} publish provenance is not chain-valid`),
        { code: 'VM_CHAIN_PROVENANCE_MISMATCH' },
      );
    }
    materializedBlock = resolved.blockNumber;
    materializedTxIndex = resolved.txIndex ?? 0;
  } else {
    const transactionHash = transactionHashes[0]!;
    if (!chain.verifyKAUpdate || !chain.getLatestMerkleRootPublisher) {
      throw Object.assign(
        new Error('Graph-scoped durable sync requires receipt-backed update verification'),
        { code: 'VM_CHAIN_PROVENANCE_UNSUPPORTED' },
      );
    }
    const publisherAddress = await chain.getLatestMerkleRootPublisher(kaId);
    const verified = await chain.verifyKAUpdate(transactionHash, kaId, publisherAddress);
    if (
      !verified.verified
      || verified.onChainMerkleRoot === undefined
      || !bytesEqual(verified.onChainMerkleRoot, roots[0]!)
      || (verified.merkleRootCount !== undefined
        && verified.merkleRootCount !== asset.assertionVersion)
      || verified.blockNumber === undefined
    ) {
      throw Object.assign(
        new Error(`Graph-scoped durable sync ${asset.ual} update provenance is not chain-valid`),
        { code: 'VM_CHAIN_PROVENANCE_MISMATCH' },
      );
    }
    materializedBlock = verified.blockNumber;
    materializedTxIndex = verified.txIndex ?? 0;
  }
  if (
    !Number.isSafeInteger(materializedBlock)
    || materializedBlock < 0
    || !Number.isSafeInteger(materializedTxIndex)
    || materializedTxIndex < 0
  ) {
    throw new Error(`Graph-scoped durable sync ${asset.ual} has invalid receipt ordering data`);
  }
  return {
    asset: {
      ...asset,
      metadataQuads: [
        ...structuralMetadata,
        ...locallyVisibleMetadata('confirmed'),
        {
          subject: asset.ual,
          predicate: MATERIALIZED_VERSION,
          object: `"${materializedBlock}:${materializedTxIndex}"`,
          graph: asset.metaGraph,
        },
      ],
    },
    onChainContextGraphId: boundContextGraphId.toString(),
  };
}

/**
 * Materialize one already-verified V2 KA as the current version-independent
 * assertion graph and metadata subject. The per-KA lock and version gate make
 * retrying or racing durable pages idempotent, while exact graph replacement
 * heals replicas that were poisoned by the former insert-only path.
 */
export async function materializeVerifiedGraphScopedAsset(params: {
  store: TripleStore;
  asset: VerifiedGraphScopedAsset;
  options?: QueryOptions;
  oversizeHooks?: OversizeGuardHooks;
}): Promise<GraphScopedMaterializationOutcome> {
  const { store, asset, options = {}, oversizeHooks } = params;
  const filtered = filterOversizedSyncQuads([
    ...asset.dataQuads,
    ...asset.metadataQuads,
  ]);
  if (filtered.dropped.length > 0) {
    oversizeHooks?.recordDrops(filtered.dropped, 'durable-sync:graph-scoped');
    return 'quarantined';
  }

  return withMaterializationLock(asset.metaGraph, asset.ual, async () => {
    const currentVersion = await readCurrentAssertionVersion(
      store,
      asset.metaGraph,
      asset.ual,
      options,
    );
    if (currentVersion !== undefined && currentVersion > asset.assertionVersion) {
      return 'stale';
    }
    let replacementMetadata = asset.metadataQuads;
    if (currentVersion === asset.assertionVersion) {
      const currentPublishedAt = await readCurrentPublishedAt(
        store,
        asset.metaGraph,
        asset.ual,
        options,
      );
      if (currentPublishedAt) {
        replacementMetadata = [
          ...asset.metadataQuads.filter((quad) => quad.predicate !== PUBLISHED_AT),
          currentPublishedAt,
        ];
      }
    }
    const locallyTrustedMetadata = await readLocallyTrustedKnowledgeAssetControls(
      store,
      asset.metaGraph,
      asset.ual,
      replacementMetadata,
      options,
    );

    const replaced = await tryReplaceGraphAndSubjectAtomically(
      store,
      asset.assertionGraph,
      asset.dataQuads,
      asset.metaGraph,
      asset.ual,
      [...replacementMetadata, ...locallyTrustedMetadata],
      options,
    );
    if (!replaced) {
      throw Object.assign(
        new Error('Graph-scoped durable sync requires atomic data/metadata replacement support'),
        { code: 'VM_ATOMIC_REPLACE_UNSUPPORTED' },
      );
    }
    return 'applied';
  });
}

async function readCurrentPublishedAt(
  store: TripleStore,
  metaGraph: string,
  ual: string,
  options: QueryOptions,
): Promise<Quad | undefined> {
  const result = await store.query(`
    SELECT ?publishedAt WHERE {
      GRAPH <${assertSafeIri(metaGraph)}> {
        <${assertSafeIri(ual)}> <${PUBLISHED_AT}> ?publishedAt .
      }
    }
  `, options);
  if (result.type !== 'bindings' || result.bindings.length !== 1) return undefined;
  const object = result.bindings[0]?.publishedAt;
  const lexical = object?.match(/^"([^"\\]*(?:\\.[^"\\]*)*)"(?:\^\^.*|@.*)?$/)?.[1];
  if (!object || !lexical || !Number.isFinite(Date.parse(lexical))) return undefined;
  return { subject: ual, predicate: PUBLISHED_AT, object, graph: metaGraph };
}

async function readCurrentAssertionVersion(
  store: TripleStore,
  metaGraph: string,
  ual: string,
  options: QueryOptions,
): Promise<bigint | undefined> {
  const result = await store.query(`
    SELECT ?version WHERE {
      GRAPH <${assertSafeIri(metaGraph)}> {
        <${assertSafeIri(ual)}> <${ASSERTION_VERSION}> ?version .
      }
    }
  `, options);
  if (result.type !== 'bindings' || result.bindings.length === 0) return undefined;

  let latest: bigint | undefined;
  for (const row of result.bindings) {
    const raw = row.version;
    const lexical = raw?.match(/^"([^"\\]*(?:\\.[^"\\]*)*)"(?:\^\^.*|@.*)?$/)?.[1] ?? raw;
    if (lexical === undefined || !/^\d+$/.test(lexical)) {
      throw new Error(`Invalid stored assertionVersion metadata for ${ual}: ${raw ?? '<missing>'}`);
    }
    const version = BigInt(lexical);
    if (latest === undefined || version > latest) latest = version;
  }
  return latest;
}

function parseBytes32Literal(raw: string, field: string): Uint8Array {
  const lexical = raw.match(/^"([^"]*)"(?:\^\^.*|@.*)?$/)?.[1] ?? raw;
  const hex = lexical.replace(/^0x/i, '');
  if (!/^[0-9a-f]{64}$/i.test(hex)) {
    throw new Error(`Graph-scoped durable sync ${field} must be 32 bytes of hexadecimal data`);
  }
  return Uint8Array.from(hex.match(/.{2}/g)!.map((pair) => Number.parseInt(pair, 16)));
}

function parseTransactionHashLiteral(raw: string): string {
  const lexical = raw.match(/^"([^"]*)"(?:\^\^.*|@.*)?$/)?.[1] ?? raw;
  if (!/^0x[0-9a-f]{64}$/i.test(lexical)) {
    throw new Error('Graph-scoped durable sync transactionHash must be a 32-byte hex literal');
  }
  return lexical;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}
