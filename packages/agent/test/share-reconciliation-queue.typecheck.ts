import type { DKGAgent } from '../src/dkg-agent.js';
import type { AsyncPromoteQueue, PromoteTerminalJobClearer, PromoteShareReconciler } from '@origintrail-official/dkg-publisher';

declare const legacy: AsyncPromoteQueue & PromoteTerminalJobClearer;
declare const complete: AsyncPromoteQueue & PromoteTerminalJobClearer & PromoteShareReconciler;
declare function acceptAgentQueue(queue: DKGAgent['promoteQueue']): void;
// @ts-expect-error The always-exposed agent read requires its queue capability.
acceptAgentQueue(legacy);
acceptAgentQueue(complete);
