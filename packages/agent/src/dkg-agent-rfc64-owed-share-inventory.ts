// SPDX-License-Identifier: Apache-2.0

/**
 * The signed inventory row a synchronous share owes when it is admitted while this node's
 * catalog authority for the graph cannot author (refresh-fenced, or not responsible).
 *
 * Such a share completes without the inventory handoff, so that it does not wait on a lane that
 * only an authority refresh or a responsibility change can open. Before it reports success it
 * leaves a durable marker; the owed-inventory owner writes the row through the same writer and
 * under the same per-asset lock as the handoff once the lane opens, at a later start included.
 * The detached observer still runs for the share; whichever comes second finds the row present.
 */

import type { OperationContext } from '@origintrail-official/dkg-core';
import { withOwnedRpcRequestContext } from '@origintrail-official/dkg-chain';
import { withDefaultStoreWorkPriority } from '@origintrail-official/dkg-storage';

import { DKGAgentBase } from './dkg-agent-base.js';
import type { DKGAgent } from './dkg-agent.js';
import type { BoundDurableSwmPromotionParamsV1 } from './internal/promote/swm-handoff-types.js';
import {
  Rfc64OwedShareInventoryOwnerV1,
  type OwedShareInventoryDrainOutcomeV1,
} from './internal/owed-share-inventory-owner.js';
import {
  SwmCatalogAuthorityNotReady,
  SwmInventoryShareSuperseded,
  SwmInventoryWriteFailure,
  type SwmInventoryWriteOutcome,
} from './internal/swm-inventory-write.js';
import {
  snapshotRfc64OwedShareInventoryV1,
  type Rfc64OwedShareInventoryV1,
} from './rfc64/owed-share-inventory-store-v1.js';
import { rfc64SwmInventoryShadowRuntimeV1 } from './rfc64/swm-inventory-shadow-runtime-v1.js';
import { DEFAULT_PROJECTION_RETRY_INTERVAL_MS_V1 } from './dkg-agent-rfc64-swm-catalog-projection-supervisor.js';

const ownersV1 = new WeakMap<DKGAgent, Rfc64OwedShareInventoryOwnerV1>();

export class Rfc64OwedShareInventoryMethods extends DKGAgentBase {
  /** This agent's owner of owed rows, run by the catalog runtime with its other workloads at the projection's retry interval. */
  createRfc64OwedShareInventoryOwnerV1(
    this: DKGAgent, resolvePartition: () => Readonly<{ retryIntervalMs?: number }> | undefined,
  ): Rfc64OwedShareInventoryOwnerV1 {
    const owner = new Rfc64OwedShareInventoryOwnerV1({
      list: () => this.rfc64PersistenceV1?.owedShareInventories.list() ?? [],
      unreadableAtOpen: () => this.rfc64PersistenceV1?.owedShareInventories.unreadableAtOpen ?? 0,
      drain: (marker, ctx) => this.drainRfc64OwedShareInventoryV1(marker, ctx),
      remove: async (marker) => { await this.rfc64PersistenceV1?.owedShareInventories.delete(marker); },
      retryIntervalMs: () => resolvePartition()?.retryIntervalMs ?? DEFAULT_PROJECTION_RETRY_INTERVAL_MS_V1,
      warn: (ctx, line) => this.log.warn(ctx, line),
    });
    ownersV1.set(this, owner);
    return owner;
  }

  /** Try every owed row now, e.g. once a graph's catalog authority is accepted. */
  requestRfc64OwedShareInventoryDrainV1(this: DKGAgent): void {
    ownersV1.get(this)?.request();
  }

  /**
   * Keep the row a committed share admitted without the inventory handoff still owes. Durable
   * when it resolves; a graph without a catalog obligation, or without RFC-64 persistence, owes
   * nothing here.
   */
  async recordRfc64OwedShareInventoryV1(this: DKGAgent, params: BoundDurableSwmPromotionParamsV1): Promise<void> {
    const store = this.rfc64PersistenceV1?.owedShareInventories;
    if (store === undefined) return;
    let owed: boolean;
    // An authority that is not ready yet cannot rule the obligation out.
    try { owed = this.requiresRfc64ShareInventoryV1(params.contextGraphId, params.subGraphName ?? undefined); }
    catch (cause) { if (!(cause instanceof SwmCatalogAuthorityNotReady)) throw cause; owed = true; }
    if (!owed) return;
    let marker: Readonly<Rfc64OwedShareInventoryV1>;
    try {
      marker = snapshotRfc64OwedShareInventoryV1({
        version: 1,
        contextGraphId: params.contextGraphId as Rfc64OwedShareInventoryV1['contextGraphId'],
        subGraphName: (params.subGraphName ?? null) as Rfc64OwedShareInventoryV1['subGraphName'],
        authorAddress: params.lifecycleAgentAddress.toLowerCase() as Rfc64OwedShareInventoryV1['authorAddress'],
        assertionCoordinate: params.assertionCoordinate as Rfc64OwedShareInventoryV1['assertionCoordinate'],
        sealDigest: params.recoveryBinding.sealDigest as Rfc64OwedShareInventoryV1['sealDigest'],
        shareOperationId: params.recoveryBinding.intent.operationId,
      });
    } catch (cause) {
      // The catalog writer refuses the same identifiers, so no row could ever be written.
      this.log.warn(params.ctx, `Share ${params.recoveryBinding.intent.operationId} owes no catalog inventory row: `
        + (cause instanceof Error ? cause.message : String(cause)));
      return;
    }
    await store.put(marker);
    this.requestRfc64OwedShareInventoryDrainV1();
  }

  /** One attempt at an owed row, under the asset's inventory write lock. */
  async drainRfc64OwedShareInventoryV1(
    this: DKGAgent, marker: Readonly<Rfc64OwedShareInventoryV1>, ctx: OperationContext,
  ): Promise<OwedShareInventoryDrainOutcomeV1> {
    const runtime = rfc64SwmInventoryShadowRuntimeV1(this);
    const signal = runtime.shutdownSignal;
    if (signal.aborted) return 'waiting';
    const asset = { contextGraphId: marker.contextGraphId, subGraphName: marker.subGraphName,
      authorAddress: marker.authorAddress, assertionCoordinate: marker.assertionCoordinate };
    return withDefaultStoreWorkPriority('background', () => withOwnedRpcRequestContext({
      requestClass: 'background', signal,
    }, () => runtime.runInventoryWriteExclusive(asset, async (): Promise<OwedShareInventoryDrainOutcomeV1> => {
      let result: SwmInventoryWriteOutcome;
      try {
        result = await this.commitRfc64SwmAuthorInventoryV1({ ...asset, lifecycleAgentAddress: marker.authorAddress,
          shareOperationId: marker.shareOperationId }, { staleShareIsTerminal: true });
      } catch (error) {
        const cause = error instanceof SwmInventoryWriteFailure ? error.cause : error;
        if (cause instanceof SwmInventoryShareSuperseded) return 'superseded';
        if (cause instanceof SwmCatalogAuthorityNotReady) return 'waiting';
        throw error;
      }
      if (result.status === 'dormant') {
        return result.dormantReason === 'inactive-lane' || result.dormantReason === 'authority-transition'
          ? 'waiting' : result.dormantReason;
      }
      // The row is durable; a projection the supervisor does not admit now is found by its next discovery.
      this.requestRfc64SwmCatalogProjectionV1({ contextGraphId: marker.contextGraphId, authorAddress: marker.authorAddress, ctx });
      return 'written';
    })));
  }
}
