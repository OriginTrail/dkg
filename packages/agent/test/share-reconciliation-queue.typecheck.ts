import type { DKGAgent } from '../src/dkg-agent.js';
import type {
  AsyncPromoteQueue, PromoteJobRetirer, PromoteShareReconciler, PromoteTerminalJobClearer,
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
