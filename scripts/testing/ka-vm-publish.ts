/**
 * Shared fixture for the KA async VM-publish specs.
 *
 * The `kaVmPublishRequest` builder, the `storeKnowledgeAssetOperationPublicQuads`
 * share-snapshot staging, and the repeated validation / broadcast / inclusion
 * constants were copy-pasted verbatim across six async-lift spec files (see
 * GH #1862). This module is the single source for that fixture so the specs stay
 * focused on the behaviour they assert.
 *
 * Every value here is byte-identical to the literals it replaced — no scenario
 * or assertion changed. Cosmetic variations across the original copies (all of
 * which resolved to the SAME value) were collapsed onto the canonical form:
 *   - `roots: [] as string[]` / `roots: []`                → `roots: []`
 *   - `contentScopeVersion: 2 as const`                    → `GRAPH_KA_CONTENT_SCOPE_VERSION` (=== 2)
 *   - inline `did:dkg:31337/<author>/7` / `ROOTLESS_UAL`   → `KA_VM_KA_UAL`
 *   - `` `sha256:${'ab'.repeat(32)}` `` / `'sha256:' + …`  → template literal
 */
import { GraphManager, type TripleStore, type Quad } from '../../packages/storage/dist/index.js';
import { GRAPH_KA_CONTENT_SCOPE_VERSION } from '../../packages/core/dist/index.js';
import {
  storeKnowledgeAssetOperationPublicQuads,
  type KnowledgeAssetVmPublishRequest,
  type LiftJobValidationMetadata,
} from '../../packages/publisher/dist/index.js';

/** Fixed KA author address shared by every VM-publish fixture request. */
export const KA_VM_AUTHOR_ADDRESS = '0x1111111111111111111111111111111111111111';
/** Fixed KA number shared by every VM-publish fixture request. */
export const KA_VM_KA_NUMBER = 7n;
/** Rootless UAL for the one queued KA (`did:dkg:31337/<author>/<kaNumber>`). */
export const KA_VM_KA_UAL = `did:dkg:31337/${KA_VM_AUTHOR_ADDRESS}/${KA_VM_KA_NUMBER.toString()}`;

/**
 * Build the canonical KA VM-publish request, overriding any field. The
 * strongly-typed `Partial<KnowledgeAssetVmPublishRequest>` override subsumes the
 * loose `Record<string, unknown>` variant some of the original copies used.
 */
export function kaVmPublishRequest(
  overrides: Partial<KnowledgeAssetVmPublishRequest> = {},
): KnowledgeAssetVmPublishRequest {
  const base: KnowledgeAssetVmPublishRequest = {
    contextGraphId: 'music-social',
    name: 'albums',
    shareOperationId: 'share-op-1',
    roots: [],
    contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
    kaUal: KA_VM_KA_UAL,
    assertionVersion: '1',
    publicTripleCount: 2,
    privateTripleCount: 0,
    seal: {
      merkleRoot: (`0x${'12'.repeat(32)}`) as `0x${string}`,
      authorAddress: KA_VM_AUTHOR_ADDRESS as `0x${string}`,
      signature: {
        r: (`0x${'34'.repeat(32)}`) as `0x${string}`,
        vs: (`0x${'56'.repeat(32)}`) as `0x${string}`,
      },
      schemeVersion: 1,
      reservedKaId: ((BigInt(KA_VM_AUTHOR_ADDRESS) << 96n) | KA_VM_KA_NUMBER).toString() as `${bigint}`,
    },
    sealChainId: '31337' as `${bigint}`,
    sealKav10Address: '0x2222222222222222222222222222222222222222' as `0x${string}`,
    sealFinalizedAtIso: '2026-01-01T00:00:00.000Z',
    sealMerkleRoot: (`0x${'12'.repeat(32)}`) as `0x${string}`,
    intentKey: `sha256:${'ab'.repeat(32)}`,
    wmCurrentAssertion: '12'.repeat(32),
    swmCurrentAssertion: '12'.repeat(32),
    kaNumber: KA_VM_KA_NUMBER.toString(),
    reservedUal: KA_VM_KA_UAL,
  };
  return { ...base, ...overrides };
}

/** The two public album triples staged by every share-snapshot fixture. */
export const KA_VM_ALBUM_QUADS: readonly Quad[] = [
  { subject: 'urn:album:one', predicate: 'http://schema.org/name', object: '"One"', graph: '' },
  { subject: 'urn:album:two', predicate: 'http://schema.org/name', object: '"Two"', graph: '' },
];

export interface StageKnowledgeAssetShareSnapshotParams {
  store: TripleStore;
  /** Defaults to a fresh `GraphManager` over `store`. */
  graphManager?: GraphManager;
  contextGraphId?: string;
  shareOperationId?: string;
  kaUal?: string;
  /**
   * Kept as `string | number | bigint` so each call site preserves its exact
   * value AND type — the two SWM-staging specs pass the string `'1'`, the
   * rootless-snapshot spec passes the number `1`.
   */
  assertionVersion?: string | number | bigint;
  publisherPeerId?: string;
  accessPolicy?: 'public' | 'ownerOnly' | 'allowList';
  quads?: readonly Quad[];
}

/**
 * Stage the KA share snapshot (`storeKnowledgeAssetOperationPublicQuads`) shared
 * by the SWM-backed VM-publish specs. Every parameter defaults to the canonical
 * fixture value; genuine per-file variations (store, assertionVersion type,
 * accessPolicy, shareOperationId) are passed by the caller's thin wrapper.
 */
export async function stageKnowledgeAssetShareSnapshot(
  params: StageKnowledgeAssetShareSnapshotParams,
): Promise<void> {
  await storeKnowledgeAssetOperationPublicQuads({
    store: params.store,
    graphManager: params.graphManager ?? new GraphManager(params.store),
    contextGraphId: params.contextGraphId ?? 'music-social',
    shareOperationId: params.shareOperationId ?? 'share-op-1',
    kaUal: params.kaUal ?? KA_VM_KA_UAL,
    assertionVersion: params.assertionVersion ?? '1',
    publisherPeerId: params.publisherPeerId ?? 'peer-1',
    quads: params.quads ?? KA_VM_ALBUM_QUADS,
    ...(params.accessPolicy !== undefined ? { accessPolicy: params.accessPolicy } : {}),
  });
}

/** Shared `validated`-transition payload (`authorityProofRef: 'knowledge-asset-lifecycle'`, `swmQuadCount: 2`). */
export const KA_VM_VALIDATION: LiftJobValidationMetadata = {
  canonicalRoots: [],
  canonicalRootMap: {},
  swmQuadCount: 2,
  authorityProofRef: 'knowledge-asset-lifecycle',
  transitionType: 'CREATE',
};

/** Shared `broadcast` payload (`0xef…` attempted tx hash, `wallet-1`). Untyped so it mirrors the specs' local `bx`. */
export const KA_VM_BROADCAST_TX = {
  txHash: (`0x${'ef'.repeat(32)}`) as `0x${string}`,
  walletId: 'wallet-1',
};

/** Shared `inclusion` payload (`0xaa…` block hash). Untyped so it mirrors the specs' local `inc` (no txHash). */
export const KA_VM_INCLUSION = {
  blockNumber: 10,
  blockHash: (`0x${'aa'.repeat(32)}`) as `0x${string}`,
  blockTimestamp: 1,
};

/** Executor-signed on-chain tx hash (`0xcd…`) driven through the pre-send write-ahead. */
export const KA_VM_EXECUTOR_TX_HASH = (`0x${'cd'.repeat(32)}`) as `0x${string}`;

/**
 * r14 (3878067113) + r16 (3878126518) — typed recovery fixtures, genuinely checked: the
 * `satisfies` annotations compile under the package's test-helper typecheck lane
 * (`tsconfig.test-helpers.json`, run as part of the package build), so a contract change
 * fails HERE at build time rather than drifting silently.
 */
import type {
  AsyncKnowledgeAssetVmPublishRecoveryEvidence,
  AsyncLiftChainProofResolution,
} from '../../packages/publisher/dist/index.js';

export function recoveredResolution(
  txHash: `0x${string}` = KA_VM_EXECUTOR_TX_HASH,
): AsyncLiftChainProofResolution {
  return {
    status: 'recovered',
    recovery: kaVmRecoveryEvidence(txHash),
  } satisfies AsyncLiftChainProofResolution;
}

export function kaVmRecoveryEvidence(
  txHash: `0x${string}` = KA_VM_EXECUTOR_TX_HASH,
): AsyncKnowledgeAssetVmPublishRecoveryEvidence {
  return {
    inclusion: {
      txHash,
      blockNumber: 1,
      blockHash: (`0x${'aa'.repeat(32)}`) as `0x${string}`,
    },
    finalization: {
      mode: 'published',
      txHash,
      ual: KA_VM_KA_UAL,
      batchId: '7',
      startKAId: '7',
      endKAId: '7',
      publisherAddress: KA_VM_AUTHOR_ADDRESS as `0x${string}`,
    },
    publishProof: {
      merkleRoot: (`0x${'12'.repeat(32)}`) as `0x${string}`,
      authorAddress: KA_VM_AUTHOR_ADDRESS as `0x${string}`,
      txIndex: 4,
    },
  } satisfies AsyncKnowledgeAssetVmPublishRecoveryEvidence;
}

