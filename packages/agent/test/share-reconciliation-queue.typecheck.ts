import type { DKGAgent } from '../src/dkg-agent.js';
import type {
  AsyncPromoteQueue, PromoteJobRetirer, PromoteRetirementResult, PromoteShareReconciler, PromoteTerminalJobClearer,
} from '@origintrail-official/dkg-publisher';

type ClearableQueue = AsyncPromoteQueue & PromoteTerminalJobClearer;
declare const lacksReconciliation: ClearableQueue & PromoteJobRetirer;
declare const lacksRetirement: ClearableQueue & PromoteShareReconciler;
declare const complete: ClearableQueue & PromoteShareReconciler & PromoteJobRetirer;
declare function acceptAgentQueue(queue: DKGAgent['promoteQueue']): void;

// @ts-expect-error The agent exposes reconciliation on its queue.
acceptAgentQueue(lacksReconciliation);
// @ts-expect-error The agent exposes operator retirement on its queue.
acceptAgentQueue(lacksRetirement);
acceptAgentQueue(complete);

declare const result: PromoteRetirementResult;
declare function acceptTimestamp(value: number): void;
if (result.outcome === 'observed' || result.outcome === 'retired') acceptTimestamp(result.retiredAt);
if (result.outcome === 'eligible') {
  // @ts-expect-error A preview has no retirement timestamp.
  acceptTimestamp(result.retiredAt);
}
