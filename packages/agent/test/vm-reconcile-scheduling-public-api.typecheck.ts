import type { DKGAgent, VmReconcileDispatcher } from '@origintrail-official/dkg-agent';

declare const agent: DKGAgent;
declare const dispatcher: VmReconcileDispatcher<unknown>;
const admitted: boolean = dispatcher.tryTriggerPeriodic('cg');
// @ts-expect-error Timer admission is protected implementation plumbing.
agent.scheduleVmReconcileSweep();
const targeted: Promise<string | null> = agent.selfPrimeSubscriptionOnChainId(
  'cg', { subscribed: true, synced: false, syncMode: 'always-on' }, 500n,
);
const completed: Promise<void> = agent.runVmReconcileSweep();
void admitted;
void targeted;
void completed;
