import type { DKGAgent } from '../dkg-agent.js';
import type { ObserveRfc64DurableSwmPromotionParamsV1 } from '../dkg-agent-rfc64-catalog-auto-publish.js';
import type { ContextGraphIdV1, EvmAddressV1 } from '@origintrail-official/dkg-core';
import { rfc64SwmInventoryShadowRuntimeV1 } from '../rfc64/swm-inventory-shadow-runtime-v1.js';
import { rfc64SwmInventorySettlementCanConvergeV1 } from '../rfc64/swm-inventory-settlement-outlook-v1.js';

/** Shared bounded responsibility settlement, outside the inventory write lock. */
export async function settleDurableSwmInventoryV1<T extends { status: string; dormantReason?: string }>(
  agent: DKGAgent, params: ObserveRfc64DurableSwmPromotionParamsV1,
  attempt: () => Promise<T>, warn: (message: string) => void,
): Promise<T> {
  const observerRuntime = rfc64SwmInventoryShadowRuntimeV1(agent);
  const shutdownSignal = observerRuntime.shutdownSignal;
  let result = await attempt();
  let lastResponsibilityFailure: unknown = null;
  for (const delayMs of observerRuntime.responsibilitySettlementRetryDelaysMs) {
    if (result.status !== 'dormant' || (
      result.dormantReason !== 'inactive-lane'
      && result.dormantReason !== 'authority-transition'
    )) break;
    if (shutdownSignal.aborted) return result;
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
      if (shutdownSignal.aborted) return result;
      if (!await observerRuntime.waitForResponsibilitySettlement(
        delayMs,
        shutdownSignal,
      )) return result;
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
    )) return result;
    result = await attempt();
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
  return result;
}

/** Both background entry points use the same projection admission policy. */
export async function requestDurableSwmInventoryProjectionV1(
  agent: DKGAgent, params: ObserveRfc64DurableSwmPromotionParamsV1,
): Promise<boolean> {
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
      return agent.requestRfc64SwmCatalogProjectionV1(projection);
    }
    return false;
  }
  return true;
}
