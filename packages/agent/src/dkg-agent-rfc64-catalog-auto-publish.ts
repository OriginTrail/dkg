// SPDX-License-Identifier: Apache-2.0

/**
 * Selected-CG RFC-64 SWM inventory and public-catalog authoring support.
 * Finalized VM remains inventoried by the chain; confirmation retracts the
 * corresponding SWM-only catalog row.
 */

import {
  assertAssertionCoordinateV1,
  assertContextGraphIdV1,
  assertSafeIri,
  assertSubGraphNameV1,
  assertSwmAuthorInventoryShareOperationIdV1,
  canonicalGraphScopedAuthorSealFromAssertionSealV1,
  computeCanonicalGraphScopedAuthorSealDigestV1,
  computeKaProjectionDigestV1,
  computeSwmAuthorInventoryScopeDigestV1,
  contextGraphAssertionUri,
  contextGraphMetaUri,
  createOperationContext,
  encodeCanonicalCgSharedPublicRootProjectionV1,
  parseGraphScopedAssertionSealCandidate,
  type AssertionCoordinateV1,
  type AssertionSeal,
  type AuthorCatalogScopeV1,
  type ContextGraphIdV1,
  type CountV1,
  type Digest32V1,
  type EvmAddressV1,
  type OperationContext,
  type SubGraphNameV1,
  type SwmAuthorInventoryScopeV1,
  type SwmAuthorInventorySnapshotV1,
  type TimestampMsV1,
} from '@origintrail-official/dkg-core';
import { GraphManager, type Quad } from '@origintrail-official/dkg-storage';
import {
  resolveKnowledgeAssetOperationPublicQuads,
  resolvePublishedKnowledgeAssetWorkspaceHead,
} from '@origintrail-official/dkg-publisher';
import { DKGAgentBase } from './dkg-agent-base.js';
import type { DKGAgent } from './dkg-agent.js';
import { rfc64CatalogLaneAcceptsWorkspaceHeadV1 } from
  './dkg-agent-rfc64-swm-catalog-projection.js';
import type {
  Rfc64CatalogSuccessorAssetInputV1,
} from './dkg-agent-rfc64-catalog.js';
import type { AppliedCatalogHeadSnapshotV1 } from './rfc64/inventory-v1/index.js';
import {
  maintainRfc64SwmAuthorInventoryV1,
  removeRfc64SwmAuthorInventoryRowV1,
} from './rfc64/swm-author-inventory-producer-v1.js';
import {
  rfc64SwmInventoryShadowRuntimeV1,
  type Rfc64SwmAuthorInventoryShadowMutationResultV1,
  type Rfc64SwmAuthorInventoryShadowStatusV1,
} from './rfc64/swm-inventory-shadow-runtime-v1.js';

export type {
  Rfc64SwmAuthorInventoryShadowMutationResultV1,
  Rfc64SwmAuthorInventoryShadowStatusV1,
} from './rfc64/swm-inventory-shadow-runtime-v1.js';

// Compatibility exports for consumers of the historically public dist/*
// subpath. The implementation moved to the projection owner, but the named
// types remain available from their original module path.
export type {
  ReconcileRfc64PublicCatalogFromSwmInventoryParamsV1,
  ReconcileRfc64PublicCatalogFromSwmInventoryResultV1,
} from './dkg-agent-rfc64-swm-catalog-projection.js';

function rfc64SwmInventoryAssetKeyV1(input: Readonly<{
  contextGraphId: string;
  subGraphName?: string | null;
  authorAddress: string;
  assertionCoordinate: string;
}>): string {
  return JSON.stringify([
    input.contextGraphId,
    input.subGraphName ?? null,
    input.authorAddress.toLowerCase(),
    input.assertionCoordinate,
  ]);
}

/** Explicit catalog-authoring input; ordinary VM confirmation never calls it. */
export interface RecordRfc64PublicCatalogAssetParamsV1 {
  readonly contextGraphId: ContextGraphIdV1;
  readonly subGraphName?: SubGraphNameV1 | null;
  readonly assertionCoordinate: AssertionCoordinateV1;
  readonly publicQuads: readonly Quad[];
  readonly seal: AssertionSeal;
}

/** @deprecated Use RecordRfc64PublicCatalogAssetParamsV1. */
export type RecordConfirmedRfc64PublicCatalogAssetParamsV1 =
  RecordRfc64PublicCatalogAssetParamsV1;

function shadowResult(
  status: Rfc64SwmAuthorInventoryShadowMutationResultV1['status'],
  action: Rfc64SwmAuthorInventoryShadowMutationResultV1['action'],
  attempts: number,
  headObjectDigest: string | null,
  error: string | null,
): Rfc64SwmAuthorInventoryShadowMutationResultV1 {
  return Object.freeze({ status, action, attempts, headObjectDigest, error });
}

export interface RecordRfc64SwmAuthorInventoryShadowParamsV1 {
  readonly contextGraphId: string;
  readonly subGraphName?: string | null;
  readonly assertionCoordinate: string;
  /** Lifecycle identity whose assertion URI owns the durable seal. */
  readonly lifecycleAgentAddress: string;
  readonly shareOperationId: string;
}

export interface RemoveRfc64SwmAuthorInventoryShadowParamsV1 {
  readonly contextGraphId: string;
  readonly subGraphName?: string | null;
  readonly seal: AssertionSeal;
}

export interface ObserveRfc64DurableSwmPromotionParamsV1
  extends RecordRfc64SwmAuthorInventoryShadowParamsV1 {
  readonly ctx: OperationContext;
}

export interface AfterDurableSwmPromotionParamsV1
  extends Omit<RecordRfc64SwmAuthorInventoryShadowParamsV1, 'shareOperationId'> {
  readonly shareOperationId: string | null;
  readonly ctx: OperationContext;
}

export interface ObserveRfc64ConfirmedVmParamsV1 {
  readonly contextGraphId: string;
  readonly subGraphName?: string | null;
  readonly assertionCoordinate: string;
  readonly seal: AssertionSeal;
  readonly assertionUri: string;
  readonly ctx: OperationContext;
  readonly publicationLabel: 'publish' | 'queued publish';
}

export class Rfc64CatalogAutoPublishMethods extends DKGAgentBase {
  /**
   * One post-commit hook shared by every durable WM to SWM promotion path.
   * Pointer maintenance retains its existing best-effort ordering; the RFC-64
   * shadow observer is admitted to a bounded detached scheduler and therefore
   * cannot delay an already-committed user operation.
   */
  async afterDurableSwmPromotionV1(
    this: DKGAgent,
    params: AfterDurableSwmPromotionParamsV1,
  ): Promise<void> {
    await this._stampSwmPointer(
      params.contextGraphId,
      params.assertionCoordinate,
      params.lifecycleAgentAddress,
      params.subGraphName ?? undefined,
    );
    if (params.shareOperationId === null) return;
    this.scheduleRfc64SwmInventoryObserverV1({
      ...params,
      shareOperationId: params.shareOperationId,
    });
  }

  /**
   * Background observer body; failures are contained and logged. A durable
   * inventory mutation for a selected CG requests its scope-owned exact
   * signed catalog target. Retrying an already-present row also re-requests a
   * catalog reconciliation that may have failed after the prior inventory
   * commit, without making the detached observer own projection lifetime.
   */
  async observeRfc64DurableSwmPromotionV1(
    this: DKGAgent,
    params: ObserveRfc64DurableSwmPromotionParamsV1,
  ): Promise<void> {
    try {
      const result = await this.recordRfc64SwmAuthorInventoryShadowV1(params);
      if (result.status === 'applied' || result.status === 'existing') {
        this.requestRfc64SwmCatalogProjectionV1({
          contextGraphId: params.contextGraphId as ContextGraphIdV1,
          authorAddress: params.lifecycleAgentAddress.toLowerCase() as EvmAddressV1,
          ctx: params.ctx,
        });
      }
    } catch (cause) {
      this.log.warn(
        params.ctx,
        `RFC-64 SWM inventory/catalog lifecycle escaped its failure boundary: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  }

  /** Await a point-in-time observer snapshot for tests and controlled drains. */
  async awaitInFlightRfc64SwmInventoryObserversV1(this: DKGAgent): Promise<void> {
    await rfc64SwmInventoryShadowRuntimeV1(this).drain();
    await this.whenRfc64SwmCatalogProjectionSupervisorIdleV1();
  }

  /** Reopen the fully drained observer owner for same-instance restart. */
  openRfc64SwmInventoryObserversV1(this: DKGAgent): void {
    rfc64SwmInventoryShadowRuntimeV1(this).reopen();
  }

  /** Fence detached inventory observers before projection and persistence close. */
  async closeRfc64SwmInventoryObserversV1(this: DKGAgent): Promise<void> {
    await rfc64SwmInventoryShadowRuntimeV1(this).closeAndDrain();
  }

  inFlightRfc64SwmInventoryObserverCountV1(this: DKGAgent): number {
    return rfc64SwmInventoryShadowRuntimeV1(this).inFlightCount;
  }

  private scheduleRfc64SwmInventoryObserverV1(
    this: DKGAgent,
    params: ObserveRfc64DurableSwmPromotionParamsV1,
  ): void {
    const assetKey = rfc64SwmInventoryAssetKeyV1({
      contextGraphId: params.contextGraphId,
      subGraphName: params.subGraphName,
      authorAddress: params.lifecycleAgentAddress,
      assertionCoordinate: params.assertionCoordinate,
    });
    rfc64SwmInventoryShadowRuntimeV1(this).schedule(
      assetKey,
      () => this.observeRfc64DurableSwmPromotionV1(params),
    );
  }

  /**
   * Canonical post-confirmation observer for exact SWM-inventory removal.
   * Finalized VM is already inventoried by the chain. Remove its SWM row and
   * enqueue selected-catalog convergence so RFC-64 no longer advertises
   * the asset as SWM-only. The irreversible publish response never waits for
   * catalog signing, storage, or peer fan-out.
   */
  async observeRfc64ConfirmedVmV1(
    this: DKGAgent,
    params: ObserveRfc64ConfirmedVmParamsV1,
  ): Promise<void> {
    const subGraphName = params.subGraphName ?? null;
    const contextGraphId = params.contextGraphId;
    const assertionCoordinate = params.assertionCoordinate;
    let confirmedSeal: ReturnType<typeof canonicalGraphScopedAuthorSealFromAssertionSealV1>;
    try {
      assertContextGraphIdV1(contextGraphId, 'confirmed publish contextGraphId');
      assertAssertionCoordinateV1(
        assertionCoordinate,
        'confirmed publish assertionCoordinate',
      );
      if (subGraphName !== null) {
        assertSubGraphNameV1(subGraphName, 'confirmed publish subGraphName');
      }
      confirmedSeal = canonicalGraphScopedAuthorSealFromAssertionSealV1(params.seal);
    } catch (cause) {
      this.log.warn(
        params.ctx,
        `Confirmed ${params.publicationLabel} for <${params.assertionUri}> but RFC-64 post-confirmation observer input was invalid: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
      return;
    }
    const shadowRuntime = rfc64SwmInventoryShadowRuntimeV1(this);
    const assetKey = rfc64SwmInventoryAssetKeyV1({
      contextGraphId,
      subGraphName,
      authorAddress: confirmedSeal.authorAddress,
      assertionCoordinate,
    });
    shadowRuntime.markVmConfirmed(assetKey, confirmedSeal.assertionVersion);
    try {
      await shadowRuntime.runExclusive(
        assetKey,
        async () => {
          const result = await this.removeRfc64SwmAuthorInventoryShadowV1({
            contextGraphId,
            subGraphName,
            seal: params.seal,
          });
          if (result.status === 'applied' || result.status === 'absent') {
            this.requestRfc64SwmCatalogProjectionV1({
              contextGraphId: contextGraphId as ContextGraphIdV1,
              authorAddress: confirmedSeal.authorAddress,
              ctx: params.ctx,
            });
          }
        },
      );
    } catch (cause) {
      this.log.warn(
        params.ctx,
        `Confirmed ${params.publicationLabel} but RFC-64 SWM inventory shadow removal escaped its failure boundary: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  }

  readRfc64SwmAuthorInventorySnapshotV1(
    this: DKGAgent,
    params: Readonly<{
      inventoryScopeDigest: Digest32V1;
      authorAddress: EvmAddressV1;
    }>,
  ): SwmAuthorInventorySnapshotV1 | null {
    return this.rfc64PersistenceV1?.swmAuthorInventory.readSwmAuthorInventorySnapshotV1(
      params.inventoryScopeDigest,
      params.authorAddress,
    ) ?? null;
  }

  /** Read-only process-local evidence; authoritative state remains the signed SQLite snapshot. */
  rfc64SwmAuthorInventoryShadowStatusV1(
    this: DKGAgent,
  ): Readonly<Rfc64SwmAuthorInventoryShadowStatusV1> {
    return rfc64SwmInventoryShadowRuntimeV1(this).status();
  }

  /**
   * Observe an already-durable WM→SWM commit without participating in its outcome.
   * Unsupported/unselected graphs are dormant; every attempted failure is
   * counted and logged, then returned instead of crossing back into the user write.
   */
  async recordRfc64SwmAuthorInventoryShadowV1(
    this: DKGAgent,
    params: RecordRfc64SwmAuthorInventoryShadowParamsV1,
  ): Promise<Rfc64SwmAuthorInventoryShadowMutationResultV1> {
    let kaUal: string | null = null;
    try {
      const lane = this.resolveRfc64CatalogAuthoringLaneV1(
        params.contextGraphId,
        params.subGraphName,
      );
      if (lane === null) {
        return this.recordRfc64SwmAuthorInventoryShadowStatsV1(
          shadowResult('dormant', 'upsert', 0, null, null),
          params.contextGraphId,
          null,
        );
      }
      assertContextGraphIdV1(params.contextGraphId, 'SWM inventory contextGraphId');
      assertAssertionCoordinateV1(
        params.assertionCoordinate,
        'SWM inventory assertionCoordinate',
      );
      const shareOperationId = params.shareOperationId;
      assertSwmAuthorInventoryShareOperationIdV1(shareOperationId);
      const assertionUri = contextGraphAssertionUri(
        params.contextGraphId,
        params.lifecycleAgentAddress,
        params.assertionCoordinate,
        params.subGraphName ?? undefined,
      );
      const metaGraph = contextGraphMetaUri(params.contextGraphId);
      const sealResult = await this.store.query(
        `CONSTRUCT { <${assertSafeIri(assertionUri)}> ?p ?o } WHERE { GRAPH <${assertSafeIri(metaGraph)}> { <${assertSafeIri(assertionUri)}> ?p ?o } }`,
        { source: 'agent.rfc64.swmInventory.seal' },
      );
      const candidate = parseGraphScopedAssertionSealCandidate(
        sealResult.type === 'quads' ? sealResult.quads : [],
        assertionUri,
      );
      if (candidate === undefined) {
        throw new Error('durable SWM assertion has no strict graph-scoped author seal');
      }
      const expectedScope = params.subGraphName
        ? `${params.contextGraphId}/${params.subGraphName}`
        : params.contextGraphId;
      if (
        candidate.coordinate.scope !== expectedScope
        || candidate.coordinate.agentAddress.toLowerCase()
          !== params.lifecycleAgentAddress.toLowerCase()
        || candidate.coordinate.name !== params.assertionCoordinate
      ) {
        throw new Error('durable SWM author seal coordinate differs from the committed share');
      }
      const canonicalSeal = canonicalGraphScopedAuthorSealFromAssertionSealV1(candidate.seal);
      kaUal = canonicalSeal.kaUal;
      const assetKey = rfc64SwmInventoryAssetKeyV1({
        contextGraphId: params.contextGraphId,
        subGraphName: params.subGraphName,
        authorAddress: canonicalSeal.authorAddress,
        assertionCoordinate: params.assertionCoordinate,
      });
      if (rfc64SwmInventoryShadowRuntimeV1(this).isVmConfirmed(
        assetKey,
        canonicalSeal.assertionVersion,
      )) {
        return shadowResult('dormant', 'upsert', 0, null, null);
      }
      const graphManager = new GraphManager(this.store);
      const head = await resolvePublishedKnowledgeAssetWorkspaceHead({
        store: this.store,
        graphManager,
        contextGraphId: params.contextGraphId,
        kaUal: canonicalSeal.kaUal,
        subGraphName: params.subGraphName ?? undefined,
      });
      if (
        head === undefined
        || head.shareOperationId !== shareOperationId
        || head.assertionVersion !== canonicalSeal.assertionVersion
        || head.publicTripleCount !== Number(canonicalSeal.publicTripleCount)
        || head.privateTripleCount !== Number(canonicalSeal.privateTripleCount)
      ) throw new Error('durable SWM head does not match the committed share and author seal');
      // Public catalogs never reveal restricted individual shares. A selected
      // private CG instead carries the same public projection only through its
      // roster-authenticated V2 catalog transport.
      if (!rfc64CatalogLaneAcceptsWorkspaceHeadV1(lane, head.accessPolicy)) {
        return this.recordRfc64SwmAuthorInventoryShadowStatsV1(
          shadowResult('dormant', 'upsert', 0, null, null),
          params.contextGraphId,
          kaUal,
        );
      }
      const snapshot = await resolveKnowledgeAssetOperationPublicQuads({
        store: this.store,
        graphManager,
        contextGraphId: params.contextGraphId,
        shareOperationId,
        kaUal: canonicalSeal.kaUal,
        assertionVersion: canonicalSeal.assertionVersion,
        subGraphName: params.subGraphName ?? undefined,
        publicSnapshotStore: this.publicSnapshotStore,
      });
      const sharedAt = head.publishedAt;
      const projectionBytes = encodeCanonicalCgSharedPublicRootProjectionV1(snapshot.quads);
      const scope: SwmAuthorInventoryScopeV1 = Object.freeze({
        ...lane.scopeBase,
        authorAddress: canonicalSeal.authorAddress,
      });
      const persistence = this.rfc64PersistenceV1;
      if (persistence === undefined) throw new Error('RFC-64 persistence is unavailable');
      const signer = this.createRfc64CatalogAuthorSignerV1(canonicalSeal.authorAddress);
      const issuedAt = Math.max(Date.now(), Number(sharedAt)).toString() as TimestampMsV1;
      const inventoryScopeDigest = computeSwmAuthorInventoryScopeDigestV1(scope);
      const maintained = await rfc64SwmInventoryShadowRuntimeV1(this).runScopeExclusive(
        `${inventoryScopeDigest}\n${canonicalSeal.authorAddress}`,
        () => maintainRfc64SwmAuthorInventoryV1(
          persistence.swmAuthorInventory,
          {
            scope,
            row: Object.freeze({
              assertionCoordinate: params.assertionCoordinate as AssertionCoordinateV1,
              assertionVersion: canonicalSeal.assertionVersion,
              kaUal: canonicalSeal.kaUal,
              shareOperationId,
              projectionDigest: computeKaProjectionDigestV1(projectionBytes),
              publicTripleCount: canonicalSeal.publicTripleCount,
              privateTripleCount: canonicalSeal.privateTripleCount,
              sealDigest: computeCanonicalGraphScopedAuthorSealDigestV1(canonicalSeal),
              sharedAt,
              expiresAt: null,
            }),
            issuedAt,
            signer: Object.freeze({
              issuer: signer.address as EvmAddressV1,
              signDigest: signer.signMessage,
            }),
          },
        ),
      );
      return this.recordRfc64SwmAuthorInventoryShadowStatsV1(
        shadowResult(
          maintained.status,
          'upsert',
          maintained.attempts,
          maintained.snapshot.head.objectDigest,
          null,
        ),
        params.contextGraphId,
        kaUal,
      );
    } catch (cause) {
      return this.recordRfc64SwmAuthorInventoryShadowStatsV1(
        this.failRfc64SwmAuthorInventoryShadowV1('upsert', cause),
        params.contextGraphId,
        kaUal,
      );
    }
  }

  /** Remove a row after VM confirmation; the chain becomes the VM inventory. */
  async removeRfc64SwmAuthorInventoryShadowV1(
    this: DKGAgent,
    params: RemoveRfc64SwmAuthorInventoryShadowParamsV1,
  ): Promise<Rfc64SwmAuthorInventoryShadowMutationResultV1> {
    let kaUal: string | null = null;
    try {
      const lane = this.resolveRfc64CatalogAuthoringLaneV1(
        params.contextGraphId,
        params.subGraphName,
      );
      if (lane === null) {
        return this.recordRfc64SwmAuthorInventoryShadowStatsV1(
          shadowResult('dormant', 'remove', 0, null, null),
          params.contextGraphId,
          null,
        );
      }
      assertContextGraphIdV1(params.contextGraphId, 'SWM inventory contextGraphId');
      const seal = canonicalGraphScopedAuthorSealFromAssertionSealV1(params.seal);
      kaUal = seal.kaUal;
      const scope: SwmAuthorInventoryScopeV1 = Object.freeze({
        ...lane.scopeBase,
        authorAddress: seal.authorAddress,
      });
      const persistence = this.rfc64PersistenceV1;
      if (persistence === undefined) throw new Error('RFC-64 persistence is unavailable');
      const signer = this.createRfc64CatalogAuthorSignerV1(seal.authorAddress);
      const inventoryScopeDigest = computeSwmAuthorInventoryScopeDigestV1(scope);
      const removed = await rfc64SwmInventoryShadowRuntimeV1(this).runScopeExclusive(
        `${inventoryScopeDigest}\n${seal.authorAddress}`,
        () => removeRfc64SwmAuthorInventoryRowV1(
          persistence.swmAuthorInventory,
          {
            scope,
            expectedRow: Object.freeze({
              kaUal: seal.kaUal,
              assertionVersion: seal.assertionVersion,
              sealDigest: computeCanonicalGraphScopedAuthorSealDigestV1(seal),
            }),
            issuedAt: Date.now().toString() as TimestampMsV1,
            signer: Object.freeze({
              issuer: signer.address as EvmAddressV1,
              signDigest: signer.signMessage,
            }),
          },
        ),
      );
      return this.recordRfc64SwmAuthorInventoryShadowStatsV1(
        shadowResult(
          removed.status,
          'remove',
          removed.attempts,
          removed.snapshot?.head.objectDigest ?? null,
          null,
        ),
        params.contextGraphId,
        kaUal,
      );
    } catch (cause) {
      return this.recordRfc64SwmAuthorInventoryShadowStatsV1(
        this.failRfc64SwmAuthorInventoryShadowV1('remove', cause),
        params.contextGraphId,
        kaUal,
      );
    }
  }

  /**
   * Explicit low-level public-root catalog authoring entrypoint. This is kept
   * for catalog construction and the upcoming SWM producer lane; it is not a
   * VM lifecycle hook. Objects and bundles are staged before the applied head
   * advances, then peer availability hints are sent best-effort.
   */
  async recordRfc64PublicCatalogAssetV1(
    this: DKGAgent,
    params: RecordRfc64PublicCatalogAssetParamsV1,
  ): Promise<AppliedCatalogHeadSnapshotV1 | null> {
    const lane = this.resolveRfc64CatalogAuthoringLaneV1(
      params.contextGraphId,
      params.subGraphName,
    );
    if (lane === null) return null;
    if (lane.kind !== 'public') return null;
    const seal = canonicalGraphScopedAuthorSealFromAssertionSealV1(params.seal);
    // V1 deliberately catalogs public-only KA projections. Private-bearing
    // assets require the reserved cg-shared-v1 anchor/hash statements in the
    // author-sealed public projection; this entrypoint does not synthesize them.
    if (BigInt(seal.privateTripleCount) > 0n) return null;
    if (params.publicQuads.length !== Number(seal.publicTripleCount)) {
      throw new Error(
        'RFC-64 public projection count differs from the supplied author seal',
      );
    }
    const projectionBytes = encodeCanonicalCgSharedPublicRootProjectionV1(params.publicQuads);
    const scope: AuthorCatalogScopeV1 = Object.freeze({
      ...lane.scopeBase,
      authorAddress: seal.authorAddress,
      bucketCount: '1' as CountV1,
    });
    lane.service.acceptedPolicySnapshotForCatalogScope(scope);
    const asset: Rfc64CatalogSuccessorAssetInputV1 = Object.freeze({
      assertionCoordinate: params.assertionCoordinate,
      projectionBytes,
      seal,
    });
    return this.upsertConfirmedRfc64PublicRootCatalogAssetV1({
      scope,
      author: this.createRfc64CatalogAuthorSignerV1(seal.authorAddress),
      asset,
      deployment: await this.resolveRfc64AutoPublishDeploymentProfileV1(lane.networkId),
      peers: lane.announcementPeers,
      catalogIssuerDelegationEffectiveAt: lane.catalogIssuerDelegationEffectiveAt,
      catalogIssuerDelegationExpiresAt: lane.catalogIssuerDelegationExpiresAt,
    });
  }

  /**
   * @deprecated Explicit compatibility alias only. Ordinary VM confirmation
   * does not call this method; the chain remains the finalized-VM inventory.
   */
  recordConfirmedRfc64PublicCatalogAssetV1(
    this: DKGAgent,
    params: RecordConfirmedRfc64PublicCatalogAssetParamsV1,
  ): Promise<AppliedCatalogHeadSnapshotV1 | null> {
    return this.recordRfc64PublicCatalogAssetV1(params);
  }

  private failRfc64SwmAuthorInventoryShadowV1(
    this: DKGAgent,
    action: 'upsert' | 'remove',
    cause: unknown,
  ): Rfc64SwmAuthorInventoryShadowMutationResultV1 {
    const error = cause instanceof Error ? cause.message : String(cause);
    this.log.warn(
      createOperationContext('share'),
      `RFC-64 SWM inventory shadow ${action} failed after the user operation committed: ${error}`,
    );
    return shadowResult('failed', action, 0, null, error);
  }

  private recordRfc64SwmAuthorInventoryShadowStatsV1(
    this: DKGAgent,
    result: Rfc64SwmAuthorInventoryShadowMutationResultV1,
    contextGraphId: string,
    kaUal: string | null,
  ): Rfc64SwmAuthorInventoryShadowMutationResultV1 {
    if (result.status === 'dormant') return result;
    rfc64SwmInventoryShadowRuntimeV1(this).record(result, contextGraphId, kaUal);
    return result;
  }

}
