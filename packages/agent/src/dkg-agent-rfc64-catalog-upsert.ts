// SPDX-License-Identifier: Apache-2.0

/** Catalog-owned, serialized exact-set mutations for confirmed public SWM assets. */

import {
  MAX_AUTHOR_CATALOG_BUCKET_ROWS_V1,
  assertSignedAuthorCatalogHeadEnvelopeV1,
  assertSignedAuthorCatalogIssuerDelegationEnvelopeV1,
  canonicalizeCanonicalGraphScopedAuthorSealV1,
  computeCanonicalGraphScopedAuthorSealDigestV1,
  computeAuthorCatalogScopeDigestV1,
  computeControlSignatureVariantDigestHex,
  decodeOpaqueKaBundleV1,
  parseCanonicalGraphScopedAuthorSealV1,
  type AuthorCatalogScopeV1,
  type CatalogSealDeploymentProfileV1,
  type Digest32V1,
  type TimestampMsV1,
} from '@origintrail-official/dkg-core';
import { verifyControlEnvelopeIssuerSignatureV1 } from '@origintrail-official/dkg-chain';

import { DKGAgentBase } from './dkg-agent-base.js';
import type { DKGAgent } from './dkg-agent.js';
import {
  loadBoundedAuthorCatalogHistoryV1,
  type BoundedAuthorCatalogHistoryV1,
  type Rfc64CatalogAuthorSignerV1,
  type Rfc64CatalogSuccessorAssetInputV1,
  type Rfc64StagedAuthorCatalogHeadRefV1,
} from './dkg-agent-rfc64-catalog.js';
import type { AppliedCatalogHeadSnapshotV1 } from './rfc64/inventory-v1/index.js';
import {
  compareRfc64PublicCatalogSuccessorAssetsByKaIdV1,
  snapshotAndSortRfc64PublicCatalogSuccessorAssetsV1,
} from './rfc64/public-catalog-successor-asset-v1.js';
import { snapshotRfc64PublicCatalogAnnouncementPeersV1 } from './rfc64/catalog-peers-v1.js';
import { computeRfc64AppliedInventoryDigestV1 } from './rfc64/public-catalog-inventory-completeness-v1.js';
import type { Rfc64PublicCatalogIssuerAuthorizationV1 } from './rfc64/public-catalog-successor-producer-v1.js';
import type { Rfc64PersistenceV1 } from './rfc64/persistence-v1.js';
import { resolveRfc64CatalogExecutionPlanAuthorityV1 } from
  './rfc64/public-catalog-activation-config-v1.js';
import {
  throwIfRfc64AbortedV1 as throwIfAbortedV1,
} from './rfc64/abort-v1.js';
import type { Rfc64ConfirmedSwmAuthorInventoryRowIdentityV1 } from
  './rfc64/swm-author-inventory-producer-v1.js';

export interface UpsertConfirmedRfc64PublicRootCatalogAssetParamsV1 {
  readonly scope: AuthorCatalogScopeV1;
  readonly author: Rfc64CatalogAuthorSignerV1;
  readonly asset: Rfc64CatalogSuccessorAssetInputV1;
  readonly deployment: CatalogSealDeploymentProfileV1;
  readonly peers: readonly string[];
  readonly catalogIssuerDelegationEffectiveAt: TimestampMsV1;
  readonly catalogIssuerDelegationExpiresAt: TimestampMsV1;
}

export interface ReconcileRfc64PublicRootCatalogExactSetParamsV1 {
  readonly scope: AuthorCatalogScopeV1;
  readonly author: Rfc64CatalogAuthorSignerV1;
  /** Complete bounded target. Input order is ignored after immutable snapshotting. */
  readonly assets: readonly Rfc64CatalogSuccessorAssetInputV1[];
  readonly deployment: CatalogSealDeploymentProfileV1;
  readonly peers: readonly string[];
  readonly catalogIssuerDelegationEffectiveAt: TimestampMsV1;
  readonly catalogIssuerDelegationExpiresAt: TimestampMsV1;
  readonly signal?: AbortSignal;
}

interface ReconcileRfc64SwmInventoryCatalogExactSetParamsV1
  extends ReconcileRfc64PublicRootCatalogExactSetParamsV1 {
  /**
   * Projection-owned atomic boundary: verify the expected inventory head while
   * holding its scope lock, then execute the synchronous applied-head CAS
   * before releasing that lock.
   */
  readonly commitAppliedHeadIfInventoryCurrent: (
    commit: () => AppliedCatalogHeadSnapshotV1,
  ) => Promise<Rfc64SourceAwareAppliedHeadCommitResultV1>;
}

interface Rfc64CatalogExactSetMutationOptionsV1 {
  readonly commitAppliedHead?: (
    commit: () => AppliedCatalogHeadSnapshotV1,
  ) => Promise<Rfc64SourceAwareAppliedHeadCommitResultV1>;
}

interface Rfc64SourceAwareAppliedHeadCommitResultV1 {
  readonly appliedHead: AppliedCatalogHeadSnapshotV1;
  /** False means the signed branch was committed but the source needs a follow-up pass. */
  readonly sourceCurrent: boolean;
}

export interface ReconcileRfc64PublicRootCatalogExactSetResultV1 {
  readonly status: 'advanced' | 'existing' | 'empty';
  readonly appliedHead: AppliedCatalogHeadSnapshotV1 | null;
  readonly successorsApplied: number;
  readonly targetAssetCount: number;
}

interface ReconcileRfc64SwmInventoryCatalogExactSetResultV1
  extends ReconcileRfc64PublicRootCatalogExactSetResultV1 {
  readonly sourceCurrent: boolean;
}

interface Rfc64CatalogMutationStateV1 {
  readonly current: AppliedCatalogHeadSnapshotV1 | null;
  readonly previousHead: Rfc64StagedAuthorCatalogHeadRefV1;
  readonly catalogIssuerAuthorization: Rfc64PublicCatalogIssuerAuthorizationV1;
  readonly assets: Rfc64CatalogSuccessorAssetInputV1[];
  readonly expectedCurrentCatalogHeadDigest: Digest32V1 | null;
}

export class Rfc64CatalogUpsertMethods extends DKGAgentBase {
  /** Package-internal positive proof used by crash-safe confirmed-row retirement. */
  async rfc64CatalogContainsConfirmedSwmRowV1(
    this: DKGAgent,
    params: Readonly<{
      readonly scope: AuthorCatalogScopeV1;
      readonly expectedRow: Rfc64ConfirmedSwmAuthorInventoryRowIdentityV1;
    }>,
  ): Promise<boolean> {
    const persistence = this.rfc64PersistenceV1;
    if (persistence === undefined) throw new Error('RFC-64 persistence is unavailable');
    const state = await this.readRfc64CatalogMutationStateV1(
      persistence,
      computeAuthorCatalogScopeDigestV1(params.scope),
      params.scope.authorAddress,
    );
    return state?.assets.some((asset) => (
      asset.seal.kaUal === params.expectedRow.kaUal
      && asset.seal.assertionVersion === params.expectedRow.assertionVersion
      && computeCanonicalGraphScopedAuthorSealDigestV1(asset.seal)
        === params.expectedRow.sealDigest
    )) ?? false;
  }

  /**
   * Own genesis creation, predecessor reconstruction, exact-set successor,
   * applied-head CAS, and best-effort availability announcement as one
   * serialized catalog mutation.
   */
  async upsertConfirmedRfc64PublicRootCatalogAssetV1(
    this: DKGAgent,
    params: UpsertConfirmedRfc64PublicRootCatalogAssetParamsV1,
  ): Promise<AppliedCatalogHeadSnapshotV1> {
    this.assertRfc64CatalogAuthoringModeV1(params.scope.contextGraphId);
    if (params.scope.subGraphName !== null) {
      throw new Error('RFC-64 confirmed public asset upsert requires the root catalog lane');
    }
    if (params.scope.authorAddress !== params.asset.seal.authorAddress) {
      throw new Error('RFC-64 confirmed public asset author differs from the catalog scope');
    }
    const peers = snapshotRfc64PublicCatalogAnnouncementPeersV1(params.peers);
    const persistence = this.rfc64PersistenceV1;
    if (persistence === undefined) {
      throw new Error('RFC-64 catalog upsert requires durable persistence');
    }
    const service = this.rfc64PublicCatalogServiceV1;
    if (service === undefined) {
      throw new Error('RFC-64 catalog upsert requires the public catalog service');
    }
    service.acceptedPolicySnapshotForCatalogScope(params.scope);
    const catalogScopeDigest = computeAuthorCatalogScopeDigestV1(params.scope);

    return this.rfc64CatalogMutationCoordinatorV1.run(params.scope, async () => {
      let state = await this.readRfc64CatalogMutationStateV1(
        persistence,
        catalogScopeDigest,
        params.scope.authorAddress,
      );
      state ??= await this.createRfc64CatalogGenesisStateV1(params);
      const assets = state.assets;
      const existingIndex = assets.findIndex(
        (asset) => asset.seal.reservedKaId === params.asset.seal.reservedKaId,
      );
      if (
        existingIndex >= 0
        && sameRfc64SuccessorAssetV1(assets[existingIndex]!, params.asset)
      ) {
        if (state.current === null) {
          throw new Error('RFC-64 staged genesis unexpectedly contains an ordinary asset');
        }
        return state.current;
      }
      if (existingIndex >= 0) assets[existingIndex] = params.asset;
      else assets.push(params.asset);
      const committed = await this.applyRfc64CatalogSuccessorV1(
        persistence,
        state,
        params,
        assets,
        peers,
      );
      return committed.applied;
    });
  }

  /**
   * Reconcile one complete, already-verified target through deterministic
   * one-KA successors. The selected-CG lifecycle calls this after durable SWM
   * inventory mutations; explicit callers retain the same repair surface.
   */
  async reconcileRfc64PublicRootCatalogExactSetV1(
    this: DKGAgent,
    params: ReconcileRfc64PublicRootCatalogExactSetParamsV1,
  ): Promise<ReconcileRfc64PublicRootCatalogExactSetResultV1> {
    return this.reconcileRfc64PublicRootCatalogExactSetCoreV1(params);
  }

  /** Typed projection boundary; direct exact-set callers remain source-neutral. */
  async reconcileRfc64SwmInventoryCatalogExactSetV1(
    this: DKGAgent,
    params: ReconcileRfc64SwmInventoryCatalogExactSetParamsV1,
  ): Promise<ReconcileRfc64SwmInventoryCatalogExactSetResultV1> {
    return this.reconcileRfc64PublicRootCatalogExactSetCoreV1(params, {
      commitAppliedHead: params.commitAppliedHeadIfInventoryCurrent,
    });
  }

  private async reconcileRfc64PublicRootCatalogExactSetCoreV1(
    this: DKGAgent,
    params: ReconcileRfc64PublicRootCatalogExactSetParamsV1,
    options: Readonly<Rfc64CatalogExactSetMutationOptionsV1> = {},
  ): Promise<ReconcileRfc64SwmInventoryCatalogExactSetResultV1> {
    throwIfAbortedV1(params.signal);
    this.assertRfc64CatalogAuthoringModeV1(params.scope.contextGraphId);
    if (params.scope.subGraphName !== null) {
      throw new Error('RFC-64 exact-set reconciliation requires the root catalog lane');
    }
    const targetAssets = snapshotAndSortRfc64PublicCatalogSuccessorAssetsV1(
      params.assets,
      'RFC-64 exact-set target assets',
    );
    for (const asset of targetAssets) {
      if (asset.seal.authorAddress !== params.scope.authorAddress) {
        throw new Error('RFC-64 exact-set target author differs from the catalog scope');
      }
    }
    const peers = snapshotRfc64PublicCatalogAnnouncementPeersV1(params.peers);
    const persistence = this.rfc64PersistenceV1;
    if (persistence === undefined) {
      throw new Error('RFC-64 exact-set reconciliation requires durable persistence');
    }
    const service = this.rfc64PublicCatalogServiceV1;
    if (service === undefined) {
      throw new Error('RFC-64 exact-set reconciliation requires the public catalog service');
    }
    service.acceptedPolicySnapshotForCatalogScope(params.scope);
    const catalogScopeDigest = computeAuthorCatalogScopeDigestV1(params.scope);

    return this.rfc64CatalogMutationCoordinatorV1.run(params.scope, async () => {
      throwIfAbortedV1(params.signal);
      // The coordinator tail follows this physical read. Caller cancellation
      // remains prompt through the coordinator's outer race, but persistence
      // cannot close until a non-cooperative read actually settles.
      let state = await this.readRfc64CatalogMutationStateV1(
        persistence,
        catalogScopeDigest,
        params.scope.authorAddress,
      );
      throwIfAbortedV1(params.signal);
      if (state === null && targetAssets.length === 0) {
        return Object.freeze({
          status: 'empty' as const,
          appliedHead: null,
          successorsApplied: 0,
          targetAssetCount: 0,
          sourceCurrent: true,
        });
      }
      state ??= await this.createRfc64CatalogGenesisStateV1(params);
      throwIfAbortedV1(params.signal);
      assertReplacementHistoryIsContiguousV1(state.assets, targetAssets);
      if (sameRfc64SuccessorAssetSetsV1(state.assets, targetAssets)) {
        return Object.freeze({
          status: state.current === null ? 'empty' as const : 'existing' as const,
          appliedHead: state.current,
          successorsApplied: 0,
          targetAssetCount: targetAssets.length,
          sourceCurrent: true,
        });
      }

      let successorsApplied = 0;
      const hardLimit = MAX_AUTHOR_CATALOG_BUCKET_ROWS_V1 * 2;
      while (!sameRfc64SuccessorAssetSetsV1(state.assets, targetAssets)) {
        throwIfAbortedV1(params.signal);
        if (successorsApplied >= hardLimit) {
          throw new Error('RFC-64 exact-set reconciliation exceeded its bounded successor limit');
        }
        const nextAssets = planNextRfc64CatalogExactSetV1(state.assets, targetAssets);
        const committed = await this.applyRfc64CatalogSuccessorV1(
          persistence,
          state,
          params,
          nextAssets,
          peers,
          params.signal,
          options.commitAppliedHead,
        );
        successorsApplied += 1;
        state = Object.freeze({
          current: committed.applied,
          previousHead: Object.freeze({
            objectDigest: committed.successor.headObjectDigest,
            signatureVariantDigest: committed.successor.signatureVariantDigest,
          }),
          catalogIssuerAuthorization: state.catalogIssuerAuthorization,
          assets: nextAssets,
          expectedCurrentCatalogHeadDigest: committed.applied.currentCatalogHeadDigest,
        });
        if (!committed.sourceCurrent) {
          return Object.freeze({
            status: 'advanced' as const,
            appliedHead: state.current,
            successorsApplied,
            targetAssetCount: targetAssets.length,
            sourceCurrent: false,
          });
        }
      }
      return Object.freeze({
        status: 'advanced' as const,
        appliedHead: state.current,
        successorsApplied,
        targetAssetCount: targetAssets.length,
        sourceCurrent: true,
      });
    }, params.signal);
  }

  private assertRfc64CatalogAuthoringModeV1(
    this: DKGAgent,
    contextGraphId: string,
  ): void {
    const authority = resolveRfc64CatalogExecutionPlanAuthorityV1(
      this.config.rfc64CatalogExecutionPlan,
      contextGraphId,
    );
    if (authority.killSwitchActive) {
      throw new Error('RFC-64 catalog authoring is disabled by the Track-2 kill switch');
    }
    if (!authority.authoringAllowed) {
      throw new Error('RFC-64 catalog authoring is disabled for legacy-mode CG');
    }
  }

  private async readRfc64CatalogMutationStateV1(
    this: DKGAgent,
    persistence: Rfc64PersistenceV1,
    catalogScopeDigest: Digest32V1,
    authorAddress: AuthorCatalogScopeV1['authorAddress'],
  ): Promise<Rfc64CatalogMutationStateV1 | null> {
    const current = persistence.inventory.readAppliedCatalogHeadV1(
      catalogScopeDigest,
      authorAddress,
    );
    if (current === null) return null;

    const storedHead = await persistence.controlObjects.getVerifiedObjectByDigest({
      objectDigest: current.currentCatalogHeadDigest,
      verifyIssuerSignature: verifyControlEnvelopeIssuerSignatureV1,
    });
    if (storedHead === null) throw new Error('RFC-64 applied author head is not durably staged');
    assertSignedAuthorCatalogHeadEnvelopeV1(storedHead.envelope);
    const previousHead = Object.freeze({
      objectDigest: storedHead.envelope.objectDigest as Digest32V1,
      signatureVariantDigest: computeControlSignatureVariantDigestHex(
        storedHead.envelope.objectDigest,
        storedHead.envelope.signature,
      ) as Digest32V1,
    });
    const history = await loadBoundedAuthorCatalogHistoryV1(persistence, previousHead);
    const assets = await loadRfc64CatalogSuccessorAssetsV1(persistence, history);
    const storedDelegation = await persistence.controlObjects.getVerifiedObjectByDigest({
      objectDigest: history.previousHead.payload.catalogIssuerDelegationDigest,
      verifyIssuerSignature: verifyControlEnvelopeIssuerSignatureV1,
    });
    if (storedDelegation === null) {
      throw new Error('RFC-64 applied author head delegation is not durably staged');
    }
    assertSignedAuthorCatalogIssuerDelegationEnvelopeV1(storedDelegation.envelope);
    return Object.freeze({
      current,
      previousHead,
      catalogIssuerAuthorization: Object.freeze({
        catalogIssuerDelegation: storedDelegation.envelope,
        parentAuthorAgentEvidence: null,
      }),
      assets,
      expectedCurrentCatalogHeadDigest: current.currentCatalogHeadDigest,
    });
  }

  private async createRfc64CatalogGenesisStateV1(
    this: DKGAgent,
    params: Readonly<{
      scope: AuthorCatalogScopeV1;
      author: Rfc64CatalogAuthorSignerV1;
      catalogIssuerDelegationEffectiveAt: TimestampMsV1;
      catalogIssuerDelegationExpiresAt: TimestampMsV1;
      signal?: AbortSignal;
    }>,
  ): Promise<Rfc64CatalogMutationStateV1> {
    throwIfAbortedV1(params.signal);
    const genesis = await this.publishAuthorCatalogGenesisV1({
      scope: params.scope,
      author: params.author,
      peers: [],
      issuedAt: Date.now().toString() as TimestampMsV1,
      catalogIssuerDelegationEffectiveAt: params.catalogIssuerDelegationEffectiveAt,
      catalogIssuerDelegationExpiresAt: params.catalogIssuerDelegationExpiresAt,
    });
    throwIfAbortedV1(params.signal);
    return Object.freeze({
      current: null,
      previousHead: Object.freeze({
        objectDigest: genesis.headObjectDigest,
        signatureVariantDigest: genesis.signatureVariantDigest,
      }),
      catalogIssuerAuthorization: genesis.catalogIssuerAuthorization,
      assets: [],
      expectedCurrentCatalogHeadDigest: null,
    });
  }

  private async applyRfc64CatalogSuccessorV1(
    this: DKGAgent,
    persistence: Rfc64PersistenceV1,
    state: Rfc64CatalogMutationStateV1,
    params: Readonly<{
      scope: AuthorCatalogScopeV1;
      author: Rfc64CatalogAuthorSignerV1;
      deployment: CatalogSealDeploymentProfileV1;
    }>,
    assets: readonly Rfc64CatalogSuccessorAssetInputV1[],
    peers: readonly string[],
    signal?: AbortSignal,
    commitAppliedHead?: (
      commit: () => AppliedCatalogHeadSnapshotV1,
    ) => Promise<Rfc64SourceAwareAppliedHeadCommitResultV1>,
  ) {
    throwIfAbortedV1(signal);
    const successor = await this.publishAuthorCatalogExactSetSuccessorV1({
      previousHead: state.previousHead,
      author: params.author,
      catalogIssuerAuthorization: state.catalogIssuerAuthorization,
      assets,
      deployment: params.deployment,
      issuedAt: Date.now().toString() as TimestampMsV1,
      peers: [],
    });
    throwIfAbortedV1(signal);
    const appliedInventoryDigest = computeRfc64AppliedInventoryDigestV1({
      catalogScopeDigest: successor.catalogScopeDigest,
      rows: successor.assets,
    });
    const commit = (): AppliedCatalogHeadSnapshotV1 => (
      persistence.inventory.compareAndSwapAppliedCatalogHeadV1({
        catalogScopeDigest: successor.catalogScopeDigest,
        authorAddress: params.scope.authorAddress,
        currentCatalogHeadDigest: successor.headObjectDigest,
        appliedInventoryDigest,
        catalogVersion: successor.announcement.catalogVersion,
        inventoryRowCount: successor.signedBucketRowCount,
        expectedCurrentCatalogHeadDigest: state.expectedCurrentCatalogHeadDigest,
      }).snapshot
    );
    const committed = commitAppliedHead === undefined
      ? Object.freeze({ appliedHead: commit(), sourceCurrent: true })
      : await commitAppliedHead(commit);
    if (!signal?.aborted) {
      await this.announceRfc64PublicCatalogHeadV1({
        announcement: successor.announcement,
        peers,
        signal,
      });
    }
    return Object.freeze({
      applied: committed.appliedHead,
      successor,
      sourceCurrent: committed.sourceCurrent,
    });
  }

}

function assertReplacementHistoryIsContiguousV1(
  current: readonly Rfc64CatalogSuccessorAssetInputV1[],
  target: readonly Rfc64CatalogSuccessorAssetInputV1[],
): void {
  const currentByKaId = new Map(current.map((asset) => [asset.seal.reservedKaId, asset]));
  for (const targetAsset of target) {
    const currentAsset = currentByKaId.get(targetAsset.seal.reservedKaId);
    if (currentAsset === undefined || sameRfc64SuccessorAssetV1(currentAsset, targetAsset)) continue;
    const currentVersion = BigInt(currentAsset.seal.assertionVersion);
    const targetVersion = BigInt(targetAsset.seal.assertionVersion);
    if (
      currentAsset.assertionCoordinate !== targetAsset.assertionCoordinate
      || targetVersion <= currentVersion
    ) {
      throw new Error(
        `RFC-64 exact-set replacement for KA ${targetAsset.seal.reservedKaId} is not a newer assertion version on the same coordinate`,
      );
    }
  }
}

export function planNextRfc64CatalogExactSetV1(
  current: readonly Rfc64CatalogSuccessorAssetInputV1[],
  target: readonly Rfc64CatalogSuccessorAssetInputV1[],
): Rfc64CatalogSuccessorAssetInputV1[] {
  let currentIndex = 0;
  let targetIndex = 0;
  while (currentIndex < current.length || targetIndex < target.length) {
    const currentAsset = current[currentIndex];
    const targetAsset = target[targetIndex];
    if (currentAsset === undefined) {
      return insertOrFreeRfc64CatalogCapacityV1(current, target, targetAsset!);
    }
    if (targetAsset === undefined) {
      return current.filter((_, index) => index !== currentIndex);
    }
    const comparison = compareRfc64CatalogAssetsByKaIdV1(currentAsset, targetAsset);
    if (comparison < 0) return current.filter((_, index) => index !== currentIndex);
    if (comparison > 0) {
      return insertOrFreeRfc64CatalogCapacityV1(current, target, targetAsset);
    }
    if (!sameRfc64SuccessorAssetV1(currentAsset, targetAsset)) {
      if (
        BigInt(targetAsset.seal.assertionVersion)
          > BigInt(currentAsset.seal.assertionVersion) + 1n
      ) {
        // A durable inventory can advance more than once while catalog
        // projection is unavailable. Remove the stale row first, then insert
        // the independently verified latest row on the following successor.
        return current.filter((_, index) => index !== currentIndex);
      }
      const next = [...current];
      next[currentIndex] = targetAsset;
      return next;
    }
    currentIndex += 1;
    targetIndex += 1;
  }
  throw new Error('RFC-64 exact-set planner was called for an already-converged target');
}

function insertOrFreeRfc64CatalogCapacityV1(
  current: readonly Rfc64CatalogSuccessorAssetInputV1[],
  target: readonly Rfc64CatalogSuccessorAssetInputV1[],
  asset: Rfc64CatalogSuccessorAssetInputV1,
): Rfc64CatalogSuccessorAssetInputV1[] {
  if (current.length < MAX_AUTHOR_CATALOG_BUCKET_ROWS_V1) {
    return insertRfc64CatalogAssetV1(current, asset);
  }
  const targetKaIds = new Set(target.map((targetAsset) => targetAsset.seal.reservedKaId));
  for (let index = current.length - 1; index >= 0; index -= 1) {
    if (!targetKaIds.has(current[index]!.seal.reservedKaId)) {
      return current.filter((_currentAsset, currentIndex) => currentIndex !== index);
    }
  }
  throw new Error('RFC-64 exact-set planner cannot free capacity for a target-only asset');
}

function insertRfc64CatalogAssetV1(
  current: readonly Rfc64CatalogSuccessorAssetInputV1[],
  asset: Rfc64CatalogSuccessorAssetInputV1,
): Rfc64CatalogSuccessorAssetInputV1[] {
  const next = [...current, asset];
  next.sort((left, right) => compareRfc64CatalogAssetsByKaIdV1(left, right));
  return next;
}

function compareRfc64CatalogAssetsByKaIdV1(
  left: Rfc64CatalogSuccessorAssetInputV1,
  right: Rfc64CatalogSuccessorAssetInputV1,
): -1 | 0 | 1 {
  return compareRfc64PublicCatalogSuccessorAssetsByKaIdV1(left, right);
}

function sameRfc64SuccessorAssetSetsV1(
  left: readonly Rfc64CatalogSuccessorAssetInputV1[],
  right: readonly Rfc64CatalogSuccessorAssetInputV1[],
): boolean {
  return left.length === right.length
    && left.every((asset, index) => sameRfc64SuccessorAssetV1(asset, right[index]!));
}

async function loadRfc64CatalogSuccessorAssetsV1(
  persistence: Rfc64PersistenceV1,
  history: BoundedAuthorCatalogHistoryV1,
): Promise<Rfc64CatalogSuccessorAssetInputV1[]> {
  const assets: Rfc64CatalogSuccessorAssetInputV1[] = [];
  for (const row of history.previousBucket?.payload.rows ?? []) {
    const bundleBytes = await persistence.kaBundles.readKaBundleByDigest(row.transfer.blobDigest);
    if (bundleBytes === null) {
      throw new Error(`RFC-64 applied catalog bundle ${row.transfer.blobDigest} is unavailable`);
    }
    const decoded = decodeOpaqueKaBundleV1(bundleBytes);
    if (
      decoded.blobDigest !== row.transfer.blobDigest
      || decoded.projectionDigest !== row.projectionDigest
    ) {
      throw new Error('RFC-64 applied catalog bundle differs from its signed predecessor row');
    }
    assets.push(Object.freeze({
      assertionCoordinate: row.assertionCoordinate,
      projectionBytes: new Uint8Array(decoded.projectionBytes),
      seal: parseCanonicalGraphScopedAuthorSealV1(decoded.sealBytes),
    }));
  }
  return assets;
}

function sameRfc64SuccessorAssetV1(
  left: Rfc64CatalogSuccessorAssetInputV1,
  right: Rfc64CatalogSuccessorAssetInputV1,
): boolean {
  return left.assertionCoordinate === right.assertionCoordinate
    && canonicalizeCanonicalGraphScopedAuthorSealV1(left.seal)
      === canonicalizeCanonicalGraphScopedAuthorSealV1(right.seal)
    && equalBytes(left.projectionBytes, right.projectionBytes);
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength
    && left.every((byte, index) => byte === right[index]);
}
