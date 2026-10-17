import type { DKGAgent } from '../dkg-agent.js';
import type { ObserveRfc64DurableSwmPromotionParamsV1 } from '../dkg-agent-rfc64-catalog-auto-publish.js';
import type { ContextGraphIdV1, EvmAddressV1 } from '@origintrail-official/dkg-core';
import { withDefaultStoreWorkPriority } from '@origintrail-official/dkg-storage';
import { withOwnedRpcRequestContext } from '@origintrail-official/dkg-chain';
import { rfc64SwmInventoryShadowRuntimeV1 } from '../rfc64/swm-inventory-shadow-runtime-v1.js';
import { rfc64SwmInventorySettlementCanConvergeV1 } from '../rfc64/swm-inventory-settlement-outlook-v1.js';
import type { Rfc64SwmInventoryObservationVerdictV1 } from '../rfc64/swm-inventory-observation-retry-v1.js';

/** One ordinary observation attempt; the runtime owns preparation-read retry lifetime. */
export async function observeDurableSwmPromotionV1(
  agent: DKGAgent,
  params: ObserveRfc64DurableSwmPromotionParamsV1,
  warn: (message: string) => void,
): Promise<Rfc64SwmInventoryObservationVerdictV1> {
  const observerRuntime = rfc64SwmInventoryShadowRuntimeV1(agent);
  const observerSignal = observerRuntime.shutdownSignal;
  return withDefaultStoreWorkPriority('background', () => withOwnedRpcRequestContext({
    requestClass: 'background',
    signal: observerSignal,
  }, async () => {
    const shutdownSignal = observerSignal;
    try {
      if (shutdownSignal.aborted) return;
      let result = await agent.recordRfc64SwmAuthorInventoryShadowV1(params);
      let lastResponsibilityFailure: unknown = null;
      for (const delayMs of observerRuntime.responsibilitySettlementRetryDelaysMs) {
        if (result.status !== 'dormant' || (
          result.dormantReason !== 'inactive-lane'
          && result.dormantReason !== 'authority-transition'
        )) break;
        if (shutdownSignal.aborted) return;
        // Registered-chain conditions outlast this window; the refresh owner retries them.
        if (!rfc64SwmInventorySettlementCanConvergeV1(
          agent.rfc64CatalogAuthorityRefreshFailureReasonV1(params.contextGraphId),
        )) break;
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
          responsibility = await agent.reconcileRfc64CatalogResponsibilityV1(
            params.contextGraphId,
          );
          lastResponsibilityFailure = null;
        } catch (cause) {
          lastResponsibilityFailure = cause;
          if (shutdownSignal.aborted) return;
          if (!await observerRuntime.waitForResponsibilitySettlement(
            delayMs,
            shutdownSignal,
          )) return;
          continue;
        }
        if (responsibility.mode === 'legacy' || (
          result.dormantReason === 'inactive-lane'
          && (responsibility.selectionSource !== 'default'
            || responsibility.mode !== 'catalog')
        )) {
          break;
        }
        if (!await observerRuntime.waitForResponsibilitySettlement(
          delayMs,
          shutdownSignal,
        )) return;
        result = await agent.recordRfc64SwmAuthorInventoryShadowV1(params);
      }
      if (
        result.status === 'dormant'
        && (result.dormantReason === 'inactive-lane'
          || result.dormantReason === 'authority-transition')
        && lastResponsibilityFailure !== null
      ) {
        throw lastResponsibilityFailure;
      }
      if (result.status === 'dormant'
        && result.dormantReason === 'authority-transition') {
        warn(
          'RFC-64 SWM inventory authority did not settle after bounded post-commit retries',
        );
      }
      if (result.failurePhase === 'preparation-read') return 'retry-preparation-read';
      if (result.status === 'applied' || result.status === 'existing') {
        const projection = {
          contextGraphId: params.contextGraphId as ContextGraphIdV1,
          authorAddress: params.lifecycleAgentAddress.toLowerCase() as EvmAddressV1,
          ctx: params.ctx,
        } as const;
        if (!agent.requestRfc64SwmCatalogProjectionV1(projection)) {
          // The authority can turn over between the durable inventory CAS and
          // projection admission. Reconcile once and retry the exact scope;
          // ordinary supervisor backoff owns any later transient failure.
          const responsibility = await agent.reconcileRfc64CatalogResponsibilityV1(
            params.contextGraphId,
          );
          if (responsibility.active && responsibility.mode !== 'legacy') {
            agent.requestRfc64SwmCatalogProjectionV1(projection);
          }
        }
      }
    } catch (cause) {
      if (shutdownSignal.aborted) return;
      warn(
        `RFC-64 SWM inventory/catalog lifecycle escaped its failure boundary: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  }));
}
