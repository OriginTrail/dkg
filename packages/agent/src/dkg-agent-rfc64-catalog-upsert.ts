// SPDX-License-Identifier: Apache-2.0

/** Catalog-owned, serialized exact-set mutations for confirmed public SWM assets. */

import {
  MAX_AUTHOR_CATALOG_BUCKET_ROWS_V1,
  catalogKeyToBucketIdV1,
  computeCanonicalGraphScopedAuthorSealDigestV1,
  computeAuthorCatalogScopeDigestV1,
  createOperationContext,
  parseDeterministicKnowledgeAssetUal,
  type AssertionCoordinateV1,
  type AuthorCatalogScopeV1,
  type CatalogSealDeploymentProfileV1,
  type CountV1,
  type DecimalU64V1,
  type EvmAddressV1,
  type KaIdV1,
  type TimestampMsV1,
} from '@origintrail-official/dkg-core';

import { DKGAgentBase } from './dkg-agent-base.js';
import type { DKGAgent } from './dkg-agent.js';
import type {
  Rfc64CatalogAuthorSignerV1,
  Rfc64CatalogSuccessorAssetInputV1,
} from './dkg-agent-rfc64-catalog.js';
import { readCurrentAuthorCatalogScopeV1 } from './internal/author-catalog-current-scope.js';
import { moveAuthorCatalogToMoreBucketsV1 } from './internal/author-catalog-move.js';
import { reconcileMovedCatalogV1 } from './internal/catalog-bucket-reconcile.js';
import {
  rfc64CatalogMutationMemoryV1,
  type Rfc64CatalogMutationStateV1,
  type Rfc64CatalogMutationV1,
} from './internal/catalog-mutation-memory.js';
import type { Rfc64VerifiedCatalogRowsV1 } from './internal/verified-catalog-rows.js';
import { yieldMainThread } from './main-thread-time-slice.js';
import type { AppliedCatalogHeadSnapshotV1 } from './rfc64/inventory-v1/index.js';
import {
  snapshotAndSortRfc64PublicCatalogSuccessorAssetsV1,
  snapshotRfc64PublicCatalogSuccessorAssetV1,
} from './rfc64/public-catalog-successor-asset-v1.js';
import { snapshotRfc64PublicCatalogAnnouncementPeersV1 } from './rfc64/catalog-peers-v1.js';
import { computeRfc64CatalogAppliedInventoryDigestV1 } from './rfc64/applied-catalog-inventory-digest-v1.js';
import type { AnnounceRfc64PublicCatalogHeadResultV1 } from './rfc64/public-catalog-service-v1.js';
import type { Rfc64PersistenceV1 } from './rfc64/persistence-v1.js';
import {
  throwIfRfc64AbortedV1 as throwIfAbortedV1,
} from './rfc64/abort-v1.js';
import {
  AuthorCatalogFullErrorV1,
  MAX_AUTHOR_CATALOG_ROWS_V1,
  assertAuthorCatalogTakesNewRowsV1,
  assertAuthorCatalogUnderMaximumV1,
  authorCatalogBucketMovesEnabledV1,
} from './internal/author-catalog-capacity.js';
import type { Rfc64ConfirmedSwmAuthorInventoryRowIdentityV1 } from
  './rfc64/swm-author-inventory-producer-v1.js';
import {
  assertReplacementHistoryIsContiguousV1,
  planNextRfc64CatalogExactSetV1,
  planRfc64CatalogProjectionTargetV1,
  sameRfc64SuccessorAssetSetsV1,
  sameRfc64SuccessorAssetV1,
  type Rfc64CatalogProjectionTargetPolicyV1,
} from './internal/catalog-exact-set-plan.js';

export type { Rfc64CatalogProjectionTargetPolicyV1 } from './internal/catalog-exact-set-plan.js';
export interface UpsertConfirmedRfc64PublicRootCatalogAssetParamsV1 {
  readonly scope: AuthorCatalogScopeV1;
  readonly author: Rfc64CatalogAuthorSignerV1;
  readonly asset: Rfc64CatalogSuccessorAssetInputV1;
  readonly deployment: CatalogSealDeploymentProfileV1;
  readonly peers: readonly string[];
  readonly catalogIssuerDelegationEffectiveAt: TimestampMsV1;
  readonly catalogIssuerDelegationExpiresAt: TimestampMsV1;
}

/**
 * GH#3081 — what one catalog mutation reports while it runs: how long each phase took and whether
 * it resolved or rejected. The delivery of its head is not among them: the mutation hands the head
 * off and returns, and the fan-out reports itself. Observation only; an observer never changes the
 * mutation, and `measure` passes the work's result or rejection through unchanged.
 */
export interface Rfc64CatalogMutationObserverV1 {
  now(): number;
  measure<T>(phase: 'state' | 'successor' | 'cas', work: () => Promise<T>, startedAt?: number): Promise<T>;
}

const UNOBSERVED_CATALOG_MUTATION_V1: Rfc64CatalogMutationObserverV1 = Object.freeze({
  now: () => 0,
  measure: <T>(_phase: unknown, work: () => Promise<T>) => work(),
});

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

interface ReconcileRfc64SwmInventoryCatalogParamsV1
  extends ReconcileRfc64PublicRootCatalogExactSetParamsV1 {
  /** Lane-owned projection semantics; repair eligibility is resolved separately. */
  readonly targetPolicy: Rfc64CatalogProjectionTargetPolicyV1;
  /**
   * Projection-owned atomic boundary: verify the expected inventory head while
   * holding its scope lock, then execute the synchronous applied-head CAS
   * before releasing that lock.
   */
  readonly commitAppliedHeadIfInventoryCurrent: (
    commit: () => AppliedCatalogHeadSnapshotV1,
  ) => Promise<Rfc64SourceAwareAppliedHeadCommitResultV1>;
}

interface Rfc64CatalogProjectionMutationOptionsV1 {
  readonly targetPolicy: Rfc64CatalogProjectionTargetPolicyV1;
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

interface ReconcileRfc64SwmInventoryCatalogResultV1
  extends ReconcileRfc64PublicRootCatalogExactSetResultV1 {
  readonly sourceCurrent: boolean;
}

export class Rfc64CatalogUpsertMethods extends DKGAgentBase {
  /** Package-internal positive proof used by crash-safe confirmed-row retirement. */
  async rfc64CatalogCoversConfirmedSwmRowV1(
    this: DKGAgent,
    params: Readonly<{
      readonly scope: AuthorCatalogScopeV1;
      readonly expectedRow: Rfc64ConfirmedSwmAuthorInventoryRowIdentityV1 & Readonly<{
        assertionCoordinate: AssertionCoordinateV1;
      }>;
    }>,
  ): Promise<boolean> {
    const persistence = this.rfc64PersistenceV1;
    if (persistence === undefined) throw new Error('RFC-64 persistence is unavailable');
    const { scope, state } = await this.readRfc64CatalogMutationStateV1(persistence, params.scope, (current) => {
      const ual = parseDeterministicKnowledgeAssetUal(params.expectedRow.kaUal);
      const kaId = ((BigInt(ual.agentAddress) << 96n) | BigInt(ual.kaNumber)).toString() as KaIdV1;
      return catalogKeyToBucketIdV1(kaId, current.bucketCount);
    });
    const asset = state?.assets.find((candidate) => (
      candidate.seal.kaUal === params.expectedRow.kaUal
    ));
    if (
      asset === undefined
      || asset.assertionCoordinate !== params.expectedRow.assertionCoordinate
    ) return false;
    const catalogVersion = BigInt(asset.seal.assertionVersion);
    const expectedVersion = BigInt(params.expectedRow.assertionVersion);
    // A newer assertion on the same stable KA and coordinate is durable
    // completion for an obsolete confirmation repair. Never reconstruct or
    // roll it back to the older workspace/seal generation.
    const covered = catalogVersion > expectedVersion || (
      catalogVersion === expectedVersion
      && computeCanonicalGraphScopedAuthorSealDigestV1(asset.seal) === params.expectedRow.sealDigest
    );
    // The answer retires a durable repair marker: it does not rest on memory alone.
    if (covered) await this.confirmRfc64CatalogDurableV1(persistence, scope, state!, asset);
    return covered;
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
    return this.upsertObservedRfc64PublicRootCatalogAssetV1(params, UNOBSERVED_CATALOG_MUTATION_V1);
  }

  /**
   * The same mutation, reporting its phases to `observer` (GH#3081; the finalized-private
   * placement repair is the observed caller). The input stays data-only.
   */
  protected async upsertObservedRfc64PublicRootCatalogAssetV1(
    this: DKGAgent,
    params: UpsertConfirmedRfc64PublicRootCatalogAssetParamsV1,
    observer: Rfc64CatalogMutationObserverV1,
  ): Promise<AppliedCatalogHeadSnapshotV1> {
    const authority = this.assertRfc64CatalogAuthoringModeV1(params.scope.contextGraphId);
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
    const stateStartedAt = observer.now();

    return this.runRfc64CatalogMutationV1(params.scope, async (mutation) => {
      // GH#3134 — the lane's current scope, read under the lane's lock, and the asset's bucket of it.
      const readState = () => this.readRfc64CatalogMutationStateV1(
        persistence,
        params.scope,
        (current) => catalogKeyToBucketIdV1(params.asset.seal.reservedKaId as KaIdV1, current.bucketCount),
      );
      // The state phase includes the wait for the mutation lock, so it starts before `run`.
      let { scope, state } = await observer.measure('state', async () => {
        const read = await readState();
        return { scope: read.scope, state: read.state ?? await this.createRfc64CatalogGenesisStateV1(params) };
      }, stateStartedAt);
      let assets = [...state.assets];
      const existingIndex = assets.findIndex(
        (asset) => asset.seal.reservedKaId === params.asset.seal.reservedKaId,
      );
      // GH#3134 — a new asset needs a free row in its bucket; a row the catalog holds is replaced in
      // place. Where moves are on, a full bucket first moves the catalog to more buckets, unless the
      // catalog already holds the node's maximum.
      if (
        existingIndex < 0
        && assets.length >= MAX_AUTHOR_CATALOG_BUCKET_ROWS_V1
        && state.current !== null
        && authorCatalogBucketMovesEnabledV1()
      ) {
        assertAuthorCatalogUnderMaximumV1(Number(state.current.inventoryRowCount), assets, 1);
        await moveAuthorCatalogToMoreBucketsV1({
          persistence,
          scope,
          applied: state.current,
          signer: {
            issuer: params.author.address.toLowerCase() as EvmAddressV1,
            signDigest: (digest) => params.author.signMessage(digest),
          },
          issuedAt: Date.now().toString() as TimestampMsV1,
          stageOnly: authority.reconciliationLane === 'shadow-stage',
        });
        const moved = await readState();
        scope = moved.scope;
        state = moved.state!;
        assets = [...state.assets];
      }
      if (existingIndex < 0) assertAuthorCatalogTakesNewRowsV1(assets, 1);
      if (
        existingIndex >= 0
        && sameRfc64SuccessorAssetV1(assets[existingIndex]!, params.asset)
      ) {
        if (state.current === null) {
          throw new Error('RFC-64 staged genesis unexpectedly contains an ordinary asset');
        }
        await this.confirmRfc64CatalogDurableV1(persistence, scope, state, assets[existingIndex]!);
        return state.current;
      }
      if (existingIndex >= 0) {
        const existing = assets[existingIndex]!;
        const existingVersion = BigInt(existing.seal.assertionVersion);
        const requestedVersion = BigInt(params.asset.seal.assertionVersion);
        if (
          existing.assertionCoordinate === params.asset.assertionCoordinate
          && requestedVersion < existingVersion
        ) {
          // A delayed VM-confirmation repair for vN must not roll a catalog
          // back after SWM vN+1 has already become its current author row.
          // The newer row covers the same KA lineage, so the repair is
          // durably complete without publishing another head.
          if (state.current === null) {
            throw new Error('RFC-64 staged genesis unexpectedly contains an ordinary asset');
          }
          await this.confirmRfc64CatalogDurableV1(persistence, scope, state, existing);
          return state.current;
        }
        if (
          existing.assertionCoordinate !== params.asset.assertionCoordinate
          || requestedVersion <= existingVersion
        ) {
          throw new Error(
            `RFC-64 catalog upsert for KA ${params.asset.seal.reservedKaId} is not a newer assertion version on the same coordinate`,
          );
        }
      }
      // The mutation's own copy: what is signed and what is remembered are the same bytes.
      const asset = snapshotRfc64PublicCatalogSuccessorAssetV1(params.asset);
      if (existingIndex >= 0) assets[existingIndex] = asset;
      else assets.push(asset);
      const committed = await this.applyRfc64CatalogSuccessorV1(
        persistence,
        state,
        { ...params, scope },
        assets,
        peers,
        authority.reconciliationLane === 'shadow-stage',
        { observer, mutation },
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
    const result = await this.reconcileRfc64PublicRootCatalogProjectionCoreV1(params, {
      targetPolicy: 'exact-replacement',
    });
    return Object.freeze({
      status: result.status,
      appliedHead: result.appliedHead,
      successorsApplied: result.successorsApplied,
      targetAssetCount: result.targetAssetCount,
    });
  }

  /** One lane-owned projection boundary for exact replacement or monotonic union. */
  async reconcileRfc64SwmInventoryCatalogV1(
    this: DKGAgent,
    params: ReconcileRfc64SwmInventoryCatalogParamsV1,
  ): Promise<ReconcileRfc64SwmInventoryCatalogResultV1> {
    return this.reconcileRfc64PublicRootCatalogProjectionCoreV1(params, {
      targetPolicy: params.targetPolicy,
      commitAppliedHead: params.commitAppliedHeadIfInventoryCurrent,
    });
  }

  private async reconcileRfc64PublicRootCatalogProjectionCoreV1(
    this: DKGAgent,
    params: ReconcileRfc64PublicRootCatalogExactSetParamsV1,
    options: Readonly<Rfc64CatalogProjectionMutationOptionsV1>,
  ): Promise<ReconcileRfc64SwmInventoryCatalogResultV1> {
    throwIfAbortedV1(params.signal);
    const authority = this.assertRfc64CatalogAuthoringModeV1(params.scope.contextGraphId);
    if (params.scope.subGraphName !== null) {
      throw new Error('RFC-64 exact-set reconciliation requires the root catalog lane');
    }
    const requestedAssets = snapshotAndSortRfc64PublicCatalogSuccessorAssetsV1(
      params.assets,
      'RFC-64 exact-set target assets',
      // GH#3134 — a whole target: where catalogs move to more buckets, up to the node's maximum.
      authorCatalogBucketMovesEnabledV1() ? MAX_AUTHOR_CATALOG_ROWS_V1 : undefined,
    );
    for (const asset of requestedAssets) {
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

    return this.runRfc64CatalogMutationV1(params.scope, async (mutation) => {
      throwIfAbortedV1(params.signal);
      // The coordinator tail follows this physical read. Caller cancellation
      // remains prompt through the coordinator's outer race, but persistence
      // cannot close until a non-cooperative read actually settles.
      const read = await this.readRfc64CatalogMutationStateV1(persistence, params.scope);
      if (read.scope.bucketCount !== '1') {
        return this.reconcileRfc64CatalogBucketsV1(persistence, read.scope, params, requestedAssets, options, {
          mutation,
          peers,
          stageOnly: authority.reconciliationLane === 'shadow-stage',
        });
      }
      let state = read.state;
      throwIfAbortedV1(params.signal);
      if (state === null && requestedAssets.length === 0) {
        return Object.freeze({
          status: 'empty' as const,
          appliedHead: null,
          successorsApplied: 0,
          targetAssetCount: 0,
          sourceCurrent: true,
        });
      }
      state ??= await this.createRfc64CatalogGenesisStateV1(params);
      // Reading the applied set, planning against it and producing its
      // successor each walk every row; timers and I/O run in between.
      await yieldMainThread();
      throwIfAbortedV1(params.signal);
      const targetAssets = planRfc64CatalogProjectionTargetV1(
        state.assets,
        requestedAssets,
        options.targetPolicy,
      );
      assertReplacementHistoryIsContiguousV1(state.assets, targetAssets);
      if (sameRfc64SuccessorAssetSetsV1(state.assets, targetAssets)) {
        // Nothing to sign: the catalog that answer rests on, every row's bundle included, is read
        // back from the durable store.
        if (state.current !== null) await this.confirmRfc64CatalogDurableV1(persistence, params.scope, state);
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
          authority.reconciliationLane === 'shadow-stage',
          { signal: params.signal, commitAppliedHead: options.commitAppliedHead, mutation },
        );
        successorsApplied += 1;
        state = committed.next;
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

  /** GH#3134 — the exact-set reconciliation of a moved catalog, bucket by bucket, under the lane's lock. */
  private async reconcileRfc64CatalogBucketsV1(
    this: DKGAgent,
    persistence: Rfc64PersistenceV1,
    scope: AuthorCatalogScopeV1,
    params: ReconcileRfc64PublicRootCatalogExactSetParamsV1,
    requested: readonly Rfc64CatalogSuccessorAssetInputV1[],
    options: Readonly<Rfc64CatalogProjectionMutationOptionsV1>,
    work: Readonly<{ mutation: Rfc64CatalogMutationV1; peers: readonly string[]; stageOnly: boolean }>,
  ): Promise<ReconcileRfc64SwmInventoryCatalogResultV1> {
    return reconcileMovedCatalogV1({
      persistence,
      scope,
      requested,
      policy: options.targetPolicy,
      readBucketState: async (bucketId) => (
        await this.readRfc64CatalogMutationStateV1(persistence, params.scope, () => bucketId)
      ).state!,
      applySuccessor: async (state, assets) => this.applyRfc64CatalogSuccessorV1(
        persistence,
        state,
        { ...params, scope },
        assets,
        work.peers,
        work.stageOnly,
        { signal: params.signal, commitAppliedHead: options.commitAppliedHead, mutation: work.mutation },
      ),
      throwIfAborted: () => throwIfAbortedV1(params.signal),
    });
  }

  private assertRfc64CatalogAuthoringModeV1(
    this: DKGAgent,
    contextGraphId: string,
  ): ReturnType<DKGAgent['resolveRfc64CatalogServingAuthorityV1']> {
    const authority = this.resolveRfc64CatalogServingAuthorityV1(contextGraphId);
    if (authority.killSwitchActive) {
      throw new Error('RFC-64 catalog authoring is disabled by the Track-2 kill switch');
    }
    if (!authority.authoringAllowed) {
      throw new Error('RFC-64 catalog authoring is disabled for legacy-mode CG');
    }
    return authority;
  }

  /**
   * The verified state of the lane's current catalog: from memory while the durable applied head
   * and the scope's accepted policy are the ones it was read under, else from the durable store.
   * GH#3134 — the current catalog is the lane's one-bucket catalog until its bucket is full; then
   * it is the scope of the lane's newest applied head, and the state is that of the bucket
   * `bucketOf` names in it.
   */
  private async readRfc64CatalogMutationStateV1(
    this: DKGAgent,
    persistence: Rfc64PersistenceV1,
    lane: AuthorCatalogScopeV1,
    bucketOf?: (current: AuthorCatalogScopeV1) => DecimalU64V1,
  ): Promise<Readonly<{ scope: AuthorCatalogScopeV1; state: Rfc64CatalogMutationStateV1 | null }>> {
    const oneBucket = lane.bucketCount === '1' ? lane : { ...lane, bucketCount: '1' as CountV1 };
    const applied = persistence.inventory.readAppliedCatalogHeadV1(
      computeAuthorCatalogScopeDigestV1(oneBucket),
      lane.authorAddress,
    );
    const scope = applied !== null && BigInt(applied.inventoryRowCount) >= MAX_AUTHOR_CATALOG_BUCKET_ROWS_V1
      ? readCurrentAuthorCatalogScopeV1(persistence.inventory, oneBucket)
      : oneBucket;
    let authority: string | undefined;
    try {
      authority = this.rfc64PublicCatalogServiceV1?.acceptedPolicyDigestForCatalogScope(scope);
    } catch { /* No accepted policy for this exact scope: nothing is served from memory. */ }
    const bucketId = scope.bucketCount === '1' || bucketOf === undefined
      ? '0' as DecimalU64V1
      : bucketOf(scope);
    const state = await rfc64CatalogMutationMemoryV1(this).read(
      persistence,
      computeAuthorCatalogScopeDigestV1(scope),
      scope.authorAddress,
      authority,
      { bucketCount: scope.bucketCount, bucketId },
      scope.bucketCount === '1' ? applied : undefined,
    );
    return Object.freeze({ scope, state });
  }

  /**
   * One serialized mutation of `scope`. A mutation that fails leaves nothing remembered about the
   * scope, unless it failed after its own applied-head CAS: that state is the committed one. A
   * refusal for a full catalog is not such a failure.
   */
  private runRfc64CatalogMutationV1<T>(
    this: DKGAgent,
    scope: AuthorCatalogScopeV1,
    mutate: (mutation: Rfc64CatalogMutationV1) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    return this.rfc64CatalogMutationCoordinatorV1.run(scope, async () => {
      const mutation = rfc64CatalogMutationMemoryV1(this).mutation(
        computeAuthorCatalogScopeDigestV1(scope),
        scope.authorAddress,
      );
      try {
        return await mutate(mutation);
      } catch (cause) {
        // GH#3134 — a full catalog refuses a new row from the row count of the state it has
        // just read, before a successor is asked for: what is remembered is still the applied
        // head's, and forgetting it would make the next placement read the whole catalog again.
        if (!(cause instanceof AuthorCatalogFullErrorV1)) mutation.failed();
        throw cause;
      }
    }, signal);
  }

  /**
   * Before `state` ends work without a successor: its head's directory root and bucket, and the
   * bundle of the row the decision is about (every row's when no `asset` is named), are in the
   * durable store.
   */
  private confirmRfc64CatalogDurableV1(
    this: DKGAgent,
    persistence: Rfc64PersistenceV1,
    scope: AuthorCatalogScopeV1,
    state: Rfc64CatalogMutationStateV1,
    asset?: Rfc64CatalogSuccessorAssetInputV1,
  ): Promise<void> {
    return rfc64CatalogMutationMemoryV1(this).confirmDurable(
      persistence,
      computeAuthorCatalogScopeDigestV1(scope),
      scope.authorAddress,
      state,
      asset,
    );
  }

  /** The durable stores are closing: nothing read from them stays in memory. */
  protected clearRfc64CatalogMutationMemoryV1(this: DKGAgent): void {
    rfc64CatalogMutationMemoryV1(this).clear();
  }

  /** The rows of `scope` this process has verified, for the successor producer. */
  protected rfc64VerifiedCatalogRowsV1(
    this: DKGAgent,
    scope: AuthorCatalogScopeV1,
  ): Rfc64VerifiedCatalogRowsV1 | undefined {
    return rfc64CatalogMutationMemoryV1(this).verifiedRows(
      computeAuthorCatalogScopeDigestV1(scope),
      scope.authorAddress,
    );
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
      bucketId: '0' as DecimalU64V1,
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
    stageOnly: boolean,
    options: Readonly<{
      signal?: AbortSignal;
      commitAppliedHead?: (
        commit: () => AppliedCatalogHeadSnapshotV1,
      ) => Promise<Rfc64SourceAwareAppliedHeadCommitResultV1>;
      observer?: Rfc64CatalogMutationObserverV1;
      /** The serialized mutation this successor belongs to, when it runs inside one. */
      mutation?: Rfc64CatalogMutationV1;
    }> = {},
  ) {
    const { signal, commitAppliedHead, mutation } = options;
    const observer = options.observer ?? UNOBSERVED_CATALOG_MUTATION_V1;
    // From here to the applied-head CAS a failure may come from the catalog itself.
    mutation?.producing();
    // The plan before this call and the successor below are whole-set work.
    const { successor, appliedInventoryDigest } = await observer.measure('successor', async () => {
      await yieldMainThread();
      throwIfAbortedV1(signal);
      const produced = await this.publishAuthorCatalogExactSetSuccessorV1({
        previousHead: state.previousHead,
        author: params.author,
        catalogIssuerAuthorization: state.catalogIssuerAuthorization,
        assets,
        selectedBucketId: state.bucketId,
        deployment: params.deployment,
        issuedAt: Date.now().toString() as TimestampMsV1,
        peers: [],
        signal,
      });
      throwIfAbortedV1(signal);
      return {
        successor: produced,
        appliedInventoryDigest: computeRfc64CatalogAppliedInventoryDigestV1({
          catalogScopeDigest: produced.catalogScopeDigest,
          rows: produced.assets,
          directory: {
            bucketCount: produced.catalogScope.bucketCount,
            directoryRootDigest: produced.directoryRootDigest,
            totalRows: produced.inventoryRowCount,
          },
        }),
      };
    });
    const commit = (): AppliedCatalogHeadSnapshotV1 => (
      persistence.inventory.compareAndSwapAppliedCatalogHeadV1({
        catalogScopeDigest: successor.catalogScopeDigest,
        authorAddress: params.scope.authorAddress,
        currentCatalogHeadDigest: successor.headObjectDigest,
        appliedInventoryDigest,
        catalogVersion: successor.announcement.catalogVersion,
        inventoryRowCount: successor.inventoryRowCount,
        expectedCurrentCatalogHeadDigest: state.expectedCurrentCatalogHeadDigest,
        stageOnly,
      }).snapshot
    );
    const committed = await observer.measure('cas', async () => (commitAppliedHead === undefined
      ? Object.freeze({ appliedHead: commit(), sourceCurrent: true })
      : commitAppliedHead(commit)));
    const next = mutation === undefined
      ? rfc64CatalogMutationMemoryV1(this).advance(state, committed.appliedHead, successor, assets)
      : mutation.committed(state, committed.appliedHead, successor, assets);
    if (!signal?.aborted) {
      // The head is durable. Hand it to the catalog service's delivery owner and return: the
      // fan-out runs outside this serialized mutation, so the next change never waits for a peer
      // (GH#3081). The fan-out reports itself; the mutation has nothing to observe about it.
      this.deliverRfc64CatalogHeadV1({ announcement: successor.announcement, peers });
    } else {
      // The caller gave up after the commit, so nothing is handed off. The head is durable all
      // the same and reaches peers with the catalog's next head or through replay: say so.
      this.reportRfc64CatalogHeadNotHandedOffV1(successor.announcement);
    }
    return Object.freeze({
      applied: committed.appliedHead,
      successor,
      sourceCurrent: committed.sourceCurrent,
      next,
    });
  }

  /**
   * Author-side announce delivery is best-effort, but a silently failed
   * fan-out leaves every replica waiting on connect-time replay churn. Surface
   * the per-peer outcome so a slow convergence can be traced to its cause.
   */
  warnRfc64CatalogAnnounceFailuresV1(
    this: DKGAgent,
    delivery: AnnounceRfc64PublicCatalogHeadResultV1,
  ): void {
    const failed = delivery.failedPeers;
    if (failed.length === 0) return;
    const total = failed.length + delivery.announcedPeers.length;
    this.log.warn(
      createOperationContext('system'),
      `RFC-64 catalog head announce failed for ${failed.length}/${total} peer(s)`
        + ` head=${delivery.announcement.catalogHeadObjectDigest}`
        + ` cg=${delivery.announcement.contextGraphId}`
        + ` version=${delivery.announcement.catalogVersion}`
        + ` peers=${failed.map(({ peerId }) => peerId.slice(-8)).join(',')}`
        + ` error=${failed[0]!.error.slice(0, 160)}`,
    );
  }

}
