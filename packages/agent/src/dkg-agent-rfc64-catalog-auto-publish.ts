// SPDX-License-Identifier: Apache-2.0

/**
 * Selected-CG RFC-64 SWM inventory and public-catalog authoring support.
 * Finalized VM remains inventoried by the chain. Public/owner-signed lanes
 * retract confirmed SWM-only rows; finalized private lanes publish the
 * authenticated recovery placement only after confirmation.
 */

import {
  assertAssertionCoordinateV1,
  assertContextGraphIdV1,
  assertSubGraphNameV1,
  assertSwmAuthorInventoryShareOperationIdV1,
  canonicalGraphScopedAuthorSealFromAssertionSealV1,
  computeCanonicalGraphScopedAuthorSealDigestV1,
  computeAuthorCatalogScopeDigestV1,
  computeKaProjectionDigestV1,
  computeSwmAuthorInventoryScopeDigestV1,
  contextGraphMetaUri,
  createOperationContext,
  encodeCanonicalCgSharedPublicRootProjectionV1,
  assertSafeIri,
  parseCanonicalDecimalU64,
  parseDeterministicKnowledgeAssetUal,
  type AssertionCoordinateV1,
  type AssertionSeal,
  type AuthorCatalogScopeV1,
  type ContextGraphIdV1,
  type CountV1,
  type Digest32V1,
  type EvmAddressV1,
  type OperationContext,
  type SubGraphNameV1,
  type SwmAuthorInventoryRowV1,
  type SwmAuthorInventoryScopeV1,
  type SwmAuthorInventorySnapshotV1,
  type TimestampMsV1,
} from '@origintrail-official/dkg-core';
import { GraphManager, type Quad } from '@origintrail-official/dkg-storage';
import {
  verifyControlEnvelopeIssuerSignatureV1,
  withOwnedRpcRequestContext,
} from '@origintrail-official/dkg-chain';
import {
  readConfirmedGraphKnowledgeAssetMetadataEnvelope,
  resolveKnowledgeAssetOperationPublicQuads,
  resolvePublishedKnowledgeAssetWorkspaceHead,
  workspaceHeadIncludesShareOperationId,
} from '@origintrail-official/dkg-publisher';
import { DKGAgentBase } from './dkg-agent-base.js';
import type { DKGAgent } from './dkg-agent.js';
import {
  rfc64CatalogLaneAcceptsWorkspaceHeadV1,
} from './dkg-agent-rfc64-swm-catalog-projection.js';
import type {
  Rfc64CatalogSuccessorAssetInputV1,
} from './dkg-agent-rfc64-catalog.js';
import {
  InventoryV1CandidateError,
  type AppliedCatalogHeadSnapshotV1,
} from './rfc64/inventory-v1/index.js';
import {
  maintainRfc64SwmAuthorInventoryV1,
  mergeRfc64SwmAuthorInventoryRowsV1,
  removeRfc64SwmAuthorInventoryRowV1,
  type Rfc64ConfirmedSwmAuthorInventoryRowIdentityV1,
  type RemoveRfc64SwmAuthorInventoryResultV1,
} from './rfc64/swm-author-inventory-producer-v1.js';
import {
  rfc64SwmInventoryShadowRuntimeV1,
  type Rfc64SwmAuthorInventoryShadowMutationResultV1,
  type Rfc64SwmAuthorInventoryShadowStatusV1,
} from './rfc64/swm-inventory-shadow-runtime-v1.js';
import { resolveDurableGraphScopedAuthorSealCandidateV1 } from
  './durable-author-seal-resolver-v1.js';
import { throwIfRfc64AbortedV1 as throwIfAbortedV1 } from './rfc64/abort-v1.js';
import {
  snapshotRfc64FinalizedPrivatePlacementRepairV1,
  type Rfc64FinalizedPrivatePlacementRepairV1,
} from './rfc64/finalized-private-placement-repair-store-v1.js';
import { loadExactAppliedCatalogRowsV1 } from
  './rfc64/applied-catalog-authority-transition-v1.js';

export type {
  Rfc64SwmAuthorInventoryShadowMutationResultV1,
  Rfc64SwmAuthorInventoryShadowStatusV1,
} from './rfc64/swm-inventory-shadow-runtime-v1.js';

const RFC64_OWNER_INVENTORY_PROMOTION_MAX_SOURCE_PASSES_V1 = 4;

export interface PromoteRfc64OwnerInventoryAuthorityResultV1 {
  readonly authors: number;
  readonly rows: number;
}

type PreparedRfc64SwmAuthorInventoryRowV1 = Readonly<{
  status: 'live';
  laneKind: 'public' | 'private';
  scope: SwmAuthorInventoryScopeV1;
  row: SwmAuthorInventoryRowV1;
  issuedAt: TimestampMsV1;
}> | Readonly<{
  status: 'stale';
  reason: 'vm-confirmed' | 'missing-seal' | 'workspace-mismatch' | 'policy-mismatch';
}>;

function rfc64PromotionInventoryRowIdentityV1(row: SwmAuthorInventoryRowV1): string {
  const parsed = parseDeterministicKnowledgeAssetUal(row.kaUal);
  const packedKaId = (BigInt(parsed.agentAddress) << 96n) | BigInt(parsed.kaNumber);
  return [
    packedKaId.toString(),
    row.assertionCoordinate,
    row.assertionVersion,
    row.projectionDigest,
    row.sealDigest,
  ].join('\n');
}

// A freshly-created private CG can durably accept its first shares before the
// membership-derived default responsibility and accepted authority converge.
// Keep the detached observer alive across that bounded lifecycle gap so an
// otherwise successful share cannot be omitted from the authoritative head.
const RFC64_DEFAULT_RESPONSIBILITY_SETTLE_RETRY_DELAYS_MS_V1 = Object.freeze([
  0,
  100,
  250,
  500,
  1_000,
  2_000,
  4_000,
  8_000,
] as const);

function waitForRfc64DefaultResponsibilitySettlementV1(
  delayMs: number,
  signal: AbortSignal,
): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  if (delayMs === 0) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, delayMs);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve(false);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

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
  dormantReason?: Rfc64SwmAuthorInventoryShadowMutationResultV1['dormantReason'],
): Rfc64SwmAuthorInventoryShadowMutationResultV1 {
  return Object.freeze({
    status,
    action,
    attempts,
    headObjectDigest,
    error,
    ...(dormantReason === undefined ? {} : { dormantReason }),
  });
}

function rfc64InventoryFailureDetailV1(cause: unknown): string {
  const messages: string[] = [];
  let current: unknown = cause;
  for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
    messages.push(current.message);
    current = current.cause;
  }
  return messages.join(' <- ');
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
  readonly shareOperationId?: string;
  readonly seal: AssertionSeal;
  readonly assertionUri: string;
  readonly ctx: OperationContext;
  readonly publicationLabel: 'publish' | 'queued publish';
}

export class Rfc64CatalogAutoPublishMethods extends DKGAgentBase {
  /**
   * Rebind still-live public SWM inventory from the owner-signed generation
   * into the accepted finalized-chain generation.
   *
   * Registration changes the inventory scope digest. The old signed snapshot
   * therefore remains durable but is invisible to the ordinary projection
   * lookup for the new authority. Re-observe every row through the normal
   * workspace/seal/VM-confirmation boundary instead of copying signed state.
   * A stale source row fails the whole source snapshot closed: selectively
   * dropping it would publish a smaller exact catalog before cross-generation
   * cleanup has durably established that omission. The old generation remains
   * the durable retry marker until the complete new projection commits, then
   * an exact-head CAS retires it.
   */
  async promoteRfc64OwnerSignedSwmInventoriesV1(
    this: DKGAgent,
    contextGraphId: string,
    signal?: AbortSignal,
  ): Promise<Readonly<PromoteRfc64OwnerInventoryAuthorityResultV1>> {
    assertContextGraphIdV1(contextGraphId, 'SWM inventory promotion contextGraphId');
    throwIfAbortedV1(signal);
    const lane = this.resolveRfc64CatalogAuthoringLaneV1(contextGraphId, null);
    if (
      lane === null
      || lane.kind !== 'public'
      || lane.policySourceKind !== 'finalized-chain'
    ) return Object.freeze({ authors: 0, rows: 0 });

    const persistence = this.rfc64PersistenceV1;
    if (persistence === undefined) throw new Error('RFC-64 persistence is unavailable');
    const authors = [...new Set([
      ...this.localAgents.keys(),
      ...(this.defaultAgentAddress === undefined ? [] : [this.defaultAgentAddress]),
    ].map((address) => address.toLowerCase()))]
      .filter((address): address is EvmAddressV1 => /^0x[0-9a-f]{40}$/u.test(address))
      .sort();

    let promotedAuthors = 0;
    let promotedRows = 0;
    for (const authorAddress of authors) {
      throwIfAbortedV1(signal);
      const ownerScope = Object.freeze({
        networkId: lane.networkId,
        contextGraphId: contextGraphId as ContextGraphIdV1,
        governanceChainId: null,
        governanceContractAddress: null,
        ownershipTransitionDigest: null,
        subGraphName: null,
        authorAddress,
        era: '0',
      }) as SwmAuthorInventoryScopeV1;
      const ownerScopeDigest = computeSwmAuthorInventoryScopeDigestV1(ownerScope);
      const ownerScopeKey = `${ownerScopeDigest}\n${authorAddress}`;
      const readOwnerSnapshot = () => rfc64SwmInventoryShadowRuntimeV1(this)
        .runScopeExclusive(
          ownerScopeKey,
          () => Promise.resolve(
            persistence.swmAuthorInventory.readSwmAuthorInventorySnapshotV1(
              ownerScopeDigest,
              authorAddress,
            ),
          ),
          signal,
        );
      let promoted = false;
      for (
        let pass = 0;
        pass < RFC64_OWNER_INVENTORY_PROMOTION_MAX_SOURCE_PASSES_V1;
        pass += 1
      ) {
        throwIfAbortedV1(signal);
        const source = await readOwnerSnapshot();
        if (source === null) {
          promoted = true;
          break;
        }
        const current = await readOwnerSnapshot();
        if (current?.head.objectDigest !== source.head.objectDigest) continue;

        // The owner inventory starts at v0 with one row. Every later upsert or
        // removal advances the version once while adding at most one row, so
        // version + 1 === row count proves the entire durable source lineage
        // is additions-only. Without this proof, even a missing/reset applied
        // catalog could have announced an earlier row that is absent now.
        if (
          BigInt(source.head.payload.version) + 1n
            !== BigInt(source.head.payload.totalRows)
        ) {
          throw new Error(
            'RFC-64 owner inventory promotion requires an additions-only source lineage',
          );
        }

        // An owner catalog can momentarily lag its inventory because inventory
        // commits before detached catalog projection. It can also have remote
        // receivers on any earlier announced head. Only an additions-only
        // lineage proves every earlier receiver row is a subset of this exact
        // source snapshot; a removal/replacement increments catalogVersion
        // without increasing inventoryRowCount and therefore fails closed.
        const ownerCatalogScope = Object.freeze({
          ...ownerScope,
          bucketCount: '1',
        }) as AuthorCatalogScopeV1;
        const ownerApplied = persistence.inventory.readAppliedCatalogHeadV1(
          computeAuthorCatalogScopeDigestV1(ownerCatalogScope),
          authorAddress,
        );
        if (ownerApplied !== null) {
          if (BigInt(ownerApplied.catalogVersion) !== BigInt(ownerApplied.inventoryRowCount)) {
            throw new Error(
              'RFC-64 owner inventory promotion requires an additions-only applied catalog lineage',
            );
          }
          const storedOwnerHead = await persistence.controlObjects.getVerifiedObjectByDigest({
            objectDigest: ownerApplied.currentCatalogHeadDigest,
            verifyIssuerSignature: verifyControlEnvelopeIssuerSignatureV1,
          });
          if (storedOwnerHead === null) {
            throw new Error('RFC-64 owner inventory applied catalog head is not staged');
          }
          const appliedRows = await loadExactAppliedCatalogRowsV1(
            persistence.controlObjects,
            storedOwnerHead,
            ownerCatalogScope,
            verifyControlEnvelopeIssuerSignatureV1,
          );
          const sourceIdentities = source.rows
            .map(rfc64PromotionInventoryRowIdentityV1)
            .sort();
          const appliedIdentities = appliedRows.map((row) => [
            row.kaId,
            row.assertionCoordinate,
            row.assertionVersion,
            row.projectionDigest,
            row.sealDigest,
          ].join('\n')).sort();
          if (
            sourceIdentities.length !== appliedIdentities.length
            || sourceIdentities.some((identity, index) => identity !== appliedIdentities[index])
          ) {
            throw new Error(
              'RFC-64 owner inventory differs from its exact applied catalog row set',
            );
          }
        }
        const targetScope = Object.freeze({
          ...lane.scopeBase,
          authorAddress,
        }) as SwmAuthorInventoryScopeV1;
        const targetScopeDigest = computeSwmAuthorInventoryScopeDigestV1(targetScope);
        const targetScopeKey = `${targetScopeDigest}\n${authorAddress}`;
        const signer = this.createRfc64CatalogAuthorSignerV1(authorAddress, signal);
        let newlyMergedRows = 0;
        await rfc64SwmInventoryShadowRuntimeV1(this).runScopeExclusive(
          targetScopeKey,
          async () => {
            const currentLane = this.resolveRfc64CatalogAuthoringLaneV1(contextGraphId, null);
            const currentScope = currentLane === null
              ? null
              : Object.freeze({
                ...currentLane.scopeBase,
                authorAddress,
              }) as SwmAuthorInventoryScopeV1;
            if (
              currentLane === null
              || currentLane.kind !== 'public'
              || currentLane.policySourceKind !== 'finalized-chain'
              || currentScope === null
              || computeSwmAuthorInventoryScopeDigestV1(currentScope) !== targetScopeDigest
            ) throw new Error('RFC-64 catalog authority changed during inventory promotion');

            // Revalidate under the target-generation lock. A VM confirmation
            // or target write/removal that wins this lock must not be undone by
            // a source candidate prepared under the prior generation.
            const graphManager = new GraphManager(this.store);
            const liveRows = new Map<string, SwmAuthorInventoryRowV1>();
            const staleRows: Array<Readonly<{
              assertionCoordinate: AssertionCoordinateV1;
              reason: Extract<
                PreparedRfc64SwmAuthorInventoryRowV1,
                { status: 'stale' }
              >['reason'];
            }>> = [];
            let issuedAt = '0' as TimestampMsV1;
            for (const row of source.rows) {
              throwIfAbortedV1(signal);
              const prepared = await this.prepareRfc64SwmAuthorInventoryRowV1(
                {
                  contextGraphId,
                  subGraphName: null,
                  assertionCoordinate: row.assertionCoordinate,
                  lifecycleAgentAddress: authorAddress,
                  shareOperationId: row.shareOperationId,
                },
                { allowTerminalStale: true, graphManager },
              );
              if (prepared.status === 'stale') {
                staleRows.push(Object.freeze({
                  assertionCoordinate: row.assertionCoordinate,
                  reason: prepared.reason,
                }));
                continue;
              }
              if (computeSwmAuthorInventoryScopeDigestV1(prepared.scope) !== targetScopeDigest) {
                throw new Error('RFC-64 owner inventory promotion changed target scope');
              }
              liveRows.set(prepared.row.kaUal, prepared.row);
              if (BigInt(prepared.issuedAt) > BigInt(issuedAt)) issuedAt = prepared.issuedAt;
            }
            if (staleRows.length > 0) {
              const first = staleRows[0]!;
              throw new Error(
                `RFC-64 owner inventory promotion found ${staleRows.length} stale source row(s); `
                + `first=${first.assertionCoordinate}:${first.reason}`,
              );
            }

            // The finalized generation is authoritative for any duplicate
            // UAL. Keeping its row prevents a delayed source migration from
            // overwriting a newer target update. A target removal is protected
            // by the same lock and the liveness revalidation above.
            const target = persistence.swmAuthorInventory.readSwmAuthorInventorySnapshotV1(
              targetScopeDigest,
              authorAddress,
            );
            for (const targetRow of target?.rows ?? []) liveRows.delete(targetRow.kaUal);
            newlyMergedRows = liveRows.size;
            if (liveRows.size === 0) return;
            await mergeRfc64SwmAuthorInventoryRowsV1(
              persistence.swmAuthorInventory,
              {
                scope: currentScope,
                rows: Object.freeze([...liveRows.values()]),
                issuedAt,
                signer: Object.freeze({
                  issuer: signer.address as EvmAddressV1,
                  signDigest: signer.signMessage,
                }),
              },
            );
          },
          signal,
        );
        // Build and announce the finalized-generation head before retiring
        // the source marker or requesting peer replay.
        await this.reconcileRfc64PublicCatalogFromSwmInventoryV1({
          contextGraphId: contextGraphId as ContextGraphIdV1,
          authorAddress,
          signal,
        });

        try {
          await rfc64SwmInventoryShadowRuntimeV1(this).runScopeExclusive(
            ownerScopeKey,
            () => {
              const currentLane = this.resolveRfc64CatalogAuthoringLaneV1(contextGraphId, null);
              if (
                currentLane === null
                || currentLane.kind !== 'public'
                || currentLane.policySourceKind !== 'finalized-chain'
                || computeSwmAuthorInventoryScopeDigestV1(Object.freeze({
                  ...currentLane.scopeBase,
                  authorAddress,
                }) as SwmAuthorInventoryScopeV1)
                  !== computeSwmAuthorInventoryScopeDigestV1(Object.freeze({
                    ...lane.scopeBase,
                    authorAddress,
                  }) as SwmAuthorInventoryScopeV1)
              ) throw new Error('RFC-64 catalog authority changed during inventory promotion');
              persistence.swmAuthorInventory.deleteSwmAuthorInventoryV1({
                inventoryScopeDigest: ownerScopeDigest,
                authorAddress,
                expectedCurrentHeadDigest: source.head.objectDigest as Digest32V1,
              });
              return Promise.resolve();
            },
            signal,
          );
        } catch (cause) {
          if (
            cause instanceof InventoryV1CandidateError
            && cause.code === 'swm-inventory-cas-conflict'
          ) continue;
          throw cause;
        }
        promotedAuthors += 1;
        promotedRows += newlyMergedRows;
        promoted = true;
        break;
      }
      if (!promoted) {
        throw new Error(
          `RFC-64 owner inventory changed during ${
            RFC64_OWNER_INVENTORY_PROMOTION_MAX_SOURCE_PASSES_V1
          } promotion pass(es)`,
        );
      }
    }
    return Object.freeze({ authors: promotedAuthors, rows: promotedRows });
  }

  /**
   * Durable finalization fence for observers that outlive the bounded
   * process-local tombstone cache (or the process itself).
   */
  private async hasRfc64DurableVmConfirmationV1(
    this: DKGAgent,
    contextGraphId: string,
    subGraphName: string | null,
    kaUal: string,
    candidateAssertionVersion: string,
  ): Promise<boolean> {
    const confirmed = await readConfirmedGraphKnowledgeAssetMetadataEnvelope(this.store, {
      contextGraphId,
      ual: kaUal,
    });
    const safeUal = assertSafeIri(kaUal);
    const labelMetaGraph = assertSafeIri(contextGraphMetaUri(contextGraphId));
    const partitionMetaGraph = assertSafeIri(contextGraphMetaUri(
      contextGraphId,
      subGraphName ?? undefined,
    ));
    if (
      confirmed.state === 'confirmed'
      && (confirmed.envelope.subGraphName ?? null) === subGraphName
    ) {
      try {
        const durableVersion = parseCanonicalDecimalU64(
          confirmed.envelope.assertionVersion,
          'durable VM assertionVersion',
        );
        const candidateVersion = parseCanonicalDecimalU64(
          candidateAssertionVersion,
          'candidate SWM assertionVersion',
        );
        if (durableVersion >= candidateVersion) return true;
        // The strict root-label envelope definitively proves this exact
        // partition has only an older confirmation. Do not let its own status
        // marker collapse the comparison back to UAL-only semantics.
        if (partitionMetaGraph === labelMetaGraph) return false;
      } catch {
        // Fall through to the conservative legacy marker fence below.
      }
    }

    // Older/subgraph writers may have persisted only the confirmation status.
    // Preserve that conservative restart fence: uncertainty suppresses replay
    // rather than resurrecting a possibly finalized public placement. When a
    // strict older root-label version was proven above, only a distinct
    // partition marker remains ambiguous.
    const status = '<http://dkg.io/ontology/status> "confirmed"';
    const partitionPattern = `GRAPH <${partitionMetaGraph}> { <${safeUal}> ${status} }`;
    const strictOlderVersion = confirmed.state === 'confirmed'
      && (confirmed.envelope.subGraphName ?? null) === subGraphName
      && (() => {
        try {
          return parseCanonicalDecimalU64(confirmed.envelope.assertionVersion)
            < parseCanonicalDecimalU64(candidateAssertionVersion);
        } catch {
          return false;
        }
      })();
    const ask = partitionMetaGraph === labelMetaGraph || strictOlderVersion
      ? `ASK { ${partitionPattern} }`
      : `ASK { { ${partitionPattern} } UNION { GRAPH <${labelMetaGraph}> { <${safeUal}> ${status} } } }`;
    const result = await this.store.query(ask, {
      source: 'agent.rfc64.swmInventory.durableVmConfirmation',
    });
    if (result.type !== 'boolean') {
      throw new Error('RFC-64 durable VM confirmation ASK did not return a boolean');
    }
    return result.value === true;
  }

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
   * inventory mutation for a selected CG requests its scope-owned signed
   * catalog target. Public lanes reconcile an exact SWM set; finalized private
   * lanes monotonically merge the same tier-neutral rows so VM placement does
   * not remove authored content. Retrying an already-present row also
   * re-requests a catalog reconciliation that may have failed after the prior
   * inventory commit, without making the detached observer own projection
   * lifetime.
   */
  async observeRfc64DurableSwmPromotionV1(
    this: DKGAgent,
    params: ObserveRfc64DurableSwmPromotionParamsV1,
  ): Promise<void> {
    const observerSignal = rfc64SwmInventoryShadowRuntimeV1(this).shutdownSignal;
    return withOwnedRpcRequestContext({
      requestClass: 'background',
      signal: observerSignal,
    }, async () => {
      const shutdownSignal = observerSignal;
      try {
        if (shutdownSignal.aborted) return;
        let result = await this.recordRfc64SwmAuthorInventoryShadowV1(params);
        let lastResponsibilityFailure: unknown = null;
        for (const delayMs of RFC64_DEFAULT_RESPONSIBILITY_SETTLE_RETRY_DELAYS_MS_V1) {
          if (result.status !== 'dormant' || result.dormantReason !== 'inactive-lane') break;
          if (shutdownSignal.aborted) return;
          // A durable promotion can race the asynchronous default-responsibility
          // and authority transition for a newly created CG. Refresh and retry
          // that normal lifecycle boundary for a bounded settlement window before
          // classifying the row as deliberately unselected. The durable workspace
          // and VM-confirmation fence are re-read by every retry, so this cannot
          // resurrect a finalized public row.
          let responsibility: Awaited<ReturnType<
            DKGAgent['reconcileRfc64CatalogResponsibilityV1']
          >>;
          try {
            responsibility = await this.reconcileRfc64CatalogResponsibilityV1(
              params.contextGraphId,
            );
            lastResponsibilityFailure = null;
          } catch (cause) {
            lastResponsibilityFailure = cause;
            if (shutdownSignal.aborted) return;
            if (!await waitForRfc64DefaultResponsibilitySettlementV1(
              delayMs,
              shutdownSignal,
            )) return;
            continue;
          }
          if (
            responsibility.selectionSource !== 'default'
            || responsibility.mode !== 'catalog'
          ) {
            break;
          }
          if (!await waitForRfc64DefaultResponsibilitySettlementV1(
            delayMs,
            shutdownSignal,
          )) return;
          result = await this.recordRfc64SwmAuthorInventoryShadowV1(params);
        }
        if (
          result.status === 'dormant'
          && result.dormantReason === 'inactive-lane'
          && lastResponsibilityFailure !== null
        ) {
          throw lastResponsibilityFailure;
        }
        if (result.status === 'applied' || result.status === 'existing') {
          const projection = {
            contextGraphId: params.contextGraphId as ContextGraphIdV1,
            authorAddress: params.lifecycleAgentAddress.toLowerCase() as EvmAddressV1,
            ctx: params.ctx,
          } as const;
          if (!this.requestRfc64SwmCatalogProjectionV1(projection)) {
            // The authority can turn over between the durable inventory CAS and
            // projection admission. Reconcile once and retry the exact scope;
            // ordinary supervisor backoff owns any later transient failure.
            const responsibility = await this.reconcileRfc64CatalogResponsibilityV1(
              params.contextGraphId,
            );
            if (responsibility.active && responsibility.mode !== 'legacy') {
              this.requestRfc64SwmCatalogProjectionV1(projection);
            }
          }
        }
      } catch (cause) {
        if (shutdownSignal.aborted) return;
        this.log.warn(
          params.ctx,
          `RFC-64 SWM inventory/catalog lifecycle escaped its failure boundary: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }
    });
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
   * Canonical post-confirmation observer. Public SWM-only lanes retract the
   * pending row. A finalized private lane appends the now-chain-backed
   * placement to its durable recovery catalog while retaining its tier-neutral
   * author-inventory row. The irreversible publish response never waits for
   * this observer.
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
    let finalizedPrivateInventoryScope: SwmAuthorInventoryScopeV1 | null = null;
    try {
      const lane = this.resolveRfc64CatalogAuthoringLaneV1(contextGraphId, subGraphName);
      if (lane?.acceptsFinalizedVmRepair === true) {
        finalizedPrivateInventoryScope = Object.freeze({
          ...lane.scopeBase,
          authorAddress: confirmedSeal.authorAddress,
        }) as SwmAuthorInventoryScopeV1;
      }
    } catch (cause) {
      this.log.warn(
        params.ctx,
        `Confirmed ${params.publicationLabel} but RFC-64 catalog authority was unavailable: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
      return;
    }
    // Fence every confirmed version, including confirmation-gated finalized
    // private repairs, until the asset-tail repair and queued observers drain.
    // Newer assertion versions use distinct fence entries and remain eligible.
    if (params.shareOperationId !== undefined) {
      shadowRuntime.markVmConfirmed(
        assetKey,
        confirmedSeal.assertionVersion,
        params.shareOperationId,
      );
    }
    let finalizedPrivateAttempt: Promise<void> | null = null;
    try {
      await shadowRuntime.runExclusive(
        assetKey,
        async () => {
          if (finalizedPrivateInventoryScope !== null) {
            const persistence = this.rfc64PersistenceV1;
            if (persistence === undefined) throw new Error('RFC-64 persistence is unavailable');
            const repair = snapshotRfc64FinalizedPrivatePlacementRepairV1({
              version: 1,
              contextGraphId: contextGraphId as ContextGraphIdV1,
              authorAddress: confirmedSeal.authorAddress,
              inventoryScope: finalizedPrivateInventoryScope,
              assertionCoordinate,
              assertionVersion: confirmedSeal.assertionVersion,
              kaUal: confirmedSeal.kaUal,
              sealDigest: computeCanonicalGraphScopedAuthorSealDigestV1(confirmedSeal),
            });
            // This durable marker is the restart boundary: pre-confirmation
            // rows have none, while every admitted post-confirmation placement
            // survives a crash or transient signing/catalog failure.
            await persistence.finalizedPrivatePlacementRepairs.put(repair);
            finalizedPrivateAttempt = this.requestRfc64FinalizedPrivateCatalogPlacementRepairV1({
              repair,
              ctx: params.ctx,
            }).whenAttempted;
            return;
          }
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
      await finalizedPrivateAttempt;
    } catch (cause) {
      this.log.warn(
        params.ctx,
        `Confirmed ${params.publicationLabel} but RFC-64 SWM inventory shadow removal escaped its failure boundary: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  }

  /** Idempotent durable repair body owned by the catalog supervisor. */
  async repairRfc64FinalizedPrivateCatalogPlacementV1(
    this: DKGAgent,
    repair: Readonly<Rfc64FinalizedPrivatePlacementRepairV1>,
  ): Promise<'repaired' | 'already-complete'> {
    const persistence = this.rfc64PersistenceV1;
    if (persistence === undefined) throw new Error('RFC-64 persistence is unavailable');
    const assetKey = rfc64SwmInventoryAssetKeyV1({
      contextGraphId: repair.contextGraphId,
      authorAddress: repair.authorAddress,
      assertionCoordinate: repair.assertionCoordinate,
    });
    let outcome: 'repaired' | 'already-complete' | null = null;
    await rfc64SwmInventoryShadowRuntimeV1(this).runExclusive(assetKey, async () => {
      const applied = await this.publishRfc64FinalizedPrivateCatalogPlacementV1(repair);
      if (applied === null) {
        await persistence.finalizedPrivatePlacementRepairs.delete(repair);
        outcome = 'already-complete';
        return;
      }
      await persistence.finalizedPrivatePlacementRepairs.delete(repair);
      outcome = 'repaired';
    });
    if (outcome === null) throw new Error('RFC-64 finalized-private placement repair did not run');
    return outcome;
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
   * Reconstruct one live inventory row from durable semantic state without
   * mutating either authority generation. Promotion may treat missing or
   * superseded local evidence as a terminal stale source row; the ordinary
   * post-share observer keeps its stricter error reporting.
   */
  private async prepareRfc64SwmAuthorInventoryRowV1(
    this: DKGAgent,
    params: RecordRfc64SwmAuthorInventoryShadowParamsV1,
    options: Readonly<{
      allowTerminalStale: boolean;
      graphManager?: GraphManager;
    }>,
  ): Promise<PreparedRfc64SwmAuthorInventoryRowV1> {
    const lane = this.resolveRfc64CatalogAuthoringLaneV1(
      params.contextGraphId,
      params.subGraphName,
    );
    if (lane === null) {
      throw new Error('RFC-64 SWM inventory lane is inactive');
    }
    assertContextGraphIdV1(params.contextGraphId, 'SWM inventory contextGraphId');
    assertAssertionCoordinateV1(
      params.assertionCoordinate,
      'SWM inventory assertionCoordinate',
    );
    const shareOperationId = params.shareOperationId;
    assertSwmAuthorInventoryShareOperationIdV1(shareOperationId);
    const candidate = await resolveDurableGraphScopedAuthorSealCandidateV1({
      store: this.store,
      contextGraphId: params.contextGraphId,
      agentAddress: params.lifecycleAgentAddress,
      assertionCoordinate: params.assertionCoordinate,
      subGraphName: params.subGraphName ?? undefined,
      source: 'agent.rfc64.swmInventory.seal',
    });
    if (candidate === undefined) {
      if (options.allowTerminalStale) {
        return Object.freeze({ status: 'stale', reason: 'missing-seal' });
      }
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
    const assetKey = rfc64SwmInventoryAssetKeyV1({
      contextGraphId: params.contextGraphId,
      subGraphName: params.subGraphName,
      authorAddress: canonicalSeal.authorAddress,
      assertionCoordinate: params.assertionCoordinate,
    });
    const exactPromotionWasConfirmed = rfc64SwmInventoryShadowRuntimeV1(this).isVmConfirmed(
      assetKey,
      canonicalSeal.assertionVersion,
      shareOperationId,
    );
    const publicPlacementWasConfirmed = !lane.acceptsFinalizedVmRepair
      && await this.hasRfc64DurableVmConfirmationV1(
        params.contextGraphId,
        params.subGraphName ?? null,
        canonicalSeal.kaUal,
        canonicalSeal.assertionVersion,
      );
    if (exactPromotionWasConfirmed || publicPlacementWasConfirmed) {
      return Object.freeze({ status: 'stale', reason: 'vm-confirmed' });
    }
    const graphManager = options.graphManager ?? new GraphManager(this.store);
    const head = await resolvePublishedKnowledgeAssetWorkspaceHead({
      store: this.store,
      graphManager,
      contextGraphId: params.contextGraphId,
      kaUal: canonicalSeal.kaUal,
      subGraphName: params.subGraphName ?? undefined,
    });
    if (
      head === undefined
      || !workspaceHeadIncludesShareOperationId(head, shareOperationId)
      || head.assertionVersion !== canonicalSeal.assertionVersion
      || head.publicTripleCount !== Number(canonicalSeal.publicTripleCount)
      || head.privateTripleCount !== Number(canonicalSeal.privateTripleCount)
    ) {
      if (options.allowTerminalStale) {
        return Object.freeze({ status: 'stale', reason: 'workspace-mismatch' });
      }
      throw new Error('durable SWM head does not match the committed share and author seal');
    }
    if (!rfc64CatalogLaneAcceptsWorkspaceHeadV1(lane, head.access.accessPolicy)) {
      return Object.freeze({ status: 'stale', reason: 'policy-mismatch' });
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
    return Object.freeze({
      status: 'live',
      laneKind: lane.kind,
      scope: Object.freeze({
        ...lane.scopeBase,
        authorAddress: canonicalSeal.authorAddress,
      }) as SwmAuthorInventoryScopeV1,
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
      issuedAt: Math.max(Date.now(), Number(sharedAt)).toString() as TimestampMsV1,
    });
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
      if (this.resolveRfc64CatalogAuthoringLaneV1(
        params.contextGraphId,
        params.subGraphName,
      ) === null) {
        return this.recordRfc64SwmAuthorInventoryShadowStatsV1(
          shadowResult('dormant', 'upsert', 0, null, null, 'inactive-lane'),
          params.contextGraphId,
          null,
        );
      }
      const prepared = await this.prepareRfc64SwmAuthorInventoryRowV1(
        params,
        { allowTerminalStale: false },
      );
      if (prepared.status === 'stale') {
        const dormantReason = prepared.reason === 'policy-mismatch'
          ? 'policy-mismatch'
          : 'vm-confirmed';
        return shadowResult('dormant', 'upsert', 0, null, null, dormantReason);
      }
      kaUal = prepared.row.kaUal;
      const persistence = this.rfc64PersistenceV1;
      if (persistence === undefined) throw new Error('RFC-64 persistence is unavailable');
      const signer = this.createRfc64CatalogAuthorSignerV1(prepared.scope.authorAddress);
      const inventoryScopeDigest = computeSwmAuthorInventoryScopeDigestV1(prepared.scope);
      const maintained = await rfc64SwmInventoryShadowRuntimeV1(this).runScopeExclusive(
        `${inventoryScopeDigest}\n${prepared.scope.authorAddress}`,
        async () => {
          // Authority may advance while workspace/seal evidence is loading.
          // Re-resolve it under the exact source-scope lock so no old-generation
          // writer can commit after promotion has taken its stable snapshot.
          const currentLane = this.resolveRfc64CatalogAuthoringLaneV1(
            params.contextGraphId,
            params.subGraphName,
          );
          if (
            currentLane === null
            || currentLane.kind !== prepared.laneKind
          ) throw new Error('RFC-64 SWM inventory authority changed before commit');
          const currentScope = Object.freeze({
            ...currentLane.scopeBase,
            authorAddress: prepared.scope.authorAddress,
          }) as SwmAuthorInventoryScopeV1;
          if (
            computeSwmAuthorInventoryScopeDigestV1(currentScope)
            !== inventoryScopeDigest
          ) throw new Error('RFC-64 SWM inventory scope changed before commit');
          return maintainRfc64SwmAuthorInventoryV1(
            persistence.swmAuthorInventory,
            {
              scope: currentScope,
              row: prepared.row,
              issuedAt: prepared.issuedAt,
              signer: Object.freeze({
                issuer: signer.address as EvmAddressV1,
                signDigest: signer.signMessage,
              }),
            },
          );
        },
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

  /** Remove one pending SWM-inventory row after its lane-specific confirmation work. */
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
          shadowResult('dormant', 'remove', 0, null, null, 'inactive-lane'),
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
      const removed = await this.removeRfc64SwmAuthorInventoryConfirmedRowV1({
        scope,
        expectedRow: Object.freeze({
          assertionVersion: seal.assertionVersion,
          kaUal: seal.kaUal,
          sealDigest: computeCanonicalGraphScopedAuthorSealDigestV1(seal),
        }),
      });
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

  /** Remove the exact confirmed row without requiring its transient AssertionSeal object. */
  async removeRfc64SwmAuthorInventoryConfirmedRowV1(
    this: DKGAgent,
    params: Readonly<{
      readonly scope: SwmAuthorInventoryScopeV1;
      readonly expectedRow: Rfc64ConfirmedSwmAuthorInventoryRowIdentityV1;
    }>,
  ): Promise<RemoveRfc64SwmAuthorInventoryResultV1> {
    const persistence = this.rfc64PersistenceV1;
    if (persistence === undefined) throw new Error('RFC-64 persistence is unavailable');
    const signer = this.createRfc64CatalogAuthorSignerV1(params.scope.authorAddress);
    const inventoryScopeDigest = computeSwmAuthorInventoryScopeDigestV1(params.scope);
    return rfc64SwmInventoryShadowRuntimeV1(this).runScopeExclusive(
      `${inventoryScopeDigest}\n${params.scope.authorAddress}`,
      async () => {
        // A VM confirmation may begin under owner authority and reach this
        // lock after registration. Never mutate that obsolete generation: the
        // promotion pass will observe the durable VM confirmation and omit it.
        const currentLane = this.resolveRfc64CatalogAuthoringLaneV1(
          params.scope.contextGraphId,
          params.scope.subGraphName,
        );
        if (currentLane === null) {
          throw new Error('RFC-64 SWM inventory authority changed before removal');
        }
        const currentScope = Object.freeze({
          ...currentLane.scopeBase,
          authorAddress: params.scope.authorAddress,
        }) as SwmAuthorInventoryScopeV1;
        if (computeSwmAuthorInventoryScopeDigestV1(currentScope) !== inventoryScopeDigest) {
          throw new Error('RFC-64 SWM inventory scope changed before removal');
        }
        return removeRfc64SwmAuthorInventoryRowV1(
          persistence.swmAuthorInventory,
          {
            scope: currentScope,
            expectedRow: params.expectedRow,
            issuedAt: Date.now().toString() as TimestampMsV1,
            signer: Object.freeze({
              issuer: signer.address as EvmAddressV1,
              signDigest: signer.signMessage,
            }),
          },
        );
      },
    );
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
      peers: this.resolveRfc64CatalogAnnouncementPeersV1(lane.announcementPeers),
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
    const error = cause instanceof Error ? rfc64InventoryFailureDetailV1(cause) : String(cause);
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
