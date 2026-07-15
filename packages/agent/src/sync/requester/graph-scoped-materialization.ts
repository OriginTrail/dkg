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

export interface VerifiedGraphScopedAsset {
  contextGraphId: string;
  ual: string;
  assertionVersion: bigint;
  assertionGraph: string;
  metaGraph: string;
  dataQuads: Quad[];
  metadataQuads: Quad[];
}

export type GraphScopedMaterializationOutcome = 'applied' | 'stale' | 'quarantined';

/**
 * Bind the peer-verified payload to current chain truth before its structural
 * metadata can influence local assertion ordering. No-chain development keeps
 * the integrity-only behavior; production chains fail closed without both
 * constant-size views.
 */
export async function authenticateVerifiedGraphScopedAsset(
  chain: ChainAdapter,
  asset: VerifiedGraphScopedAsset,
  resolveOnChainContextGraphId?: (contextGraphId: string) => Promise<string | null>,
): Promise<VerifiedGraphScopedAsset> {
  if (chain.chainId === 'none') return asset;
  if (
    !chain.getLatestMerkleRoot
    || !chain.getMerkleRootCount
    || !chain.getKAContextGraphId
    || !resolveOnChainContextGraphId
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
  const [latestRoot, rootCount, boundContextGraphId, expectedContextGraphId] = await Promise.all([
    chain.getLatestMerkleRoot(kaId),
    chain.getMerkleRootCount(kaId),
    chain.getKAContextGraphId(kaId),
    resolveOnChainContextGraphId(asset.contextGraphId),
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
  if (
    expectedContextGraphId === null
    || BigInt(expectedContextGraphId) <= 0n
    || boundContextGraphId !== BigInt(expectedContextGraphId)
  ) {
    throw Object.assign(
      new Error(
        `Graph-scoped durable sync ${asset.ual} is bound to context graph ${boundContextGraphId}, ` +
        `not local context graph ${asset.contextGraphId} (${expectedContextGraphId ?? 'unresolved'})`,
      ),
      { code: 'VM_CHAIN_CONTEXT_GRAPH_MISMATCH' },
    );
  }
  return {
    ...asset,
    metadataQuads: [
      ...asset.metadataQuads,
      {
        subject: asset.ual,
        predicate: STATUS,
        object: '"confirmed"',
        graph: asset.metaGraph,
      },
    ],
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
    const locallyTrustedMetadata = await readLocallyTrustedKnowledgeAssetControls(
      store,
      asset.metaGraph,
      asset.ual,
      asset.metadataQuads,
      options,
    );

    const replaced = await tryReplaceGraphAndSubjectAtomically(
      store,
      asset.assertionGraph,
      asset.dataQuads,
      asset.metaGraph,
      asset.ual,
      [...asset.metadataQuads, ...locallyTrustedMetadata],
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

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}
