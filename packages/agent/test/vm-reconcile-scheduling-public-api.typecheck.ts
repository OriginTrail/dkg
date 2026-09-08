import type { DKGAgent, VmReconcileDispatcher } from '@origintrail-official/dkg-agent';

declare const agent: DKGAgent;
declare const dispatcher: VmReconcileDispatcher<unknown>;
const admitted: boolean = dispatcher.tryTriggerPeriodic('cg');
const scheduled: void = agent.scheduleVmReconcileSweep();
const completed: Promise<void> = agent.runVmReconcileSweep();
void admitted;
void scheduled;
void completed;
