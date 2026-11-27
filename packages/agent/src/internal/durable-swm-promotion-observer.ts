import type { DKGAgent } from '../dkg-agent.js';
import type { ObserveRfc64DurableSwmPromotionParamsV1 } from '../dkg-agent-rfc64-catalog-auto-publish.js';
import { withDefaultStoreWorkPriority } from '@origintrail-official/dkg-storage';
import { withOwnedRpcRequestContext } from '@origintrail-official/dkg-chain';
import { rfc64SwmInventoryShadowRuntimeV1 } from '../rfc64/swm-inventory-shadow-runtime-v1.js';
import { settleDurableSwmInventoryV1, requestDurableSwmInventoryProjectionV1 } from './durable-swm-inventory-execution.js';
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
      const result = await settleDurableSwmInventoryV1(agent, params,
        () => agent.recordRfc64SwmAuthorInventoryShadowV1(params), warn);
      if (result.failurePhase === 'preparation-read') return 'retry-preparation-read';
      if (result.status === 'applied' || result.status === 'existing') {
        await requestDurableSwmInventoryProjectionV1(agent, params);
      }
    } catch (cause) {
      if (shutdownSignal.aborted) return;
      warn(
        `RFC-64 SWM inventory/catalog lifecycle escaped its failure boundary: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  }));
}
