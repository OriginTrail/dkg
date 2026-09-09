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

// @ts-expect-error Sweep capacity waiting is internal, not a supported dispatcher operation.
dispatcher.schedulePeriodicWhenAvailable('cg');
// @ts-expect-error Internal admission capabilities must not be exported at the package root.
import { vmReconcileSweepAdmission } from '@origintrail-official/dkg-agent';
void vmReconcileSweepAdmission;

// @ts-expect-error internal sweep capability subpaths are deliberately blocked
import { vmReconcileSweepAdmission as internalAdmission } from '@origintrail-official/dkg-agent/dist/internal/vm-reconcile-sweep-admission.js';
void internalAdmission;

// @ts-expect-error Stateful sweep planning is not a package-root API.
import { VmReconcileSweepPlanner } from '@origintrail-official/dkg-agent';
void VmReconcileSweepPlanner;

// @ts-expect-error The former public deep subpath no longer exists.
import { VmReconcileSweepSelector as legacySelector } from '@origintrail-official/dkg-agent/dist/vm-reconcile-sweep.js';
void legacySelector;

// @ts-expect-error Internal sweep-planner subpaths are blocked by package exports.
import { VmReconcileSweepSelector as internalSelector } from '@origintrail-official/dkg-agent/dist/internal/vm-reconcile-sweep.js';
void internalSelector;
