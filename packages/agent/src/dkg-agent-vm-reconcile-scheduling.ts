// SPDX-License-Identifier: Apache-2.0

/** Focused VM-reconcile candidate selection and sweep orchestration mixin. */

import { DKGAgentBase } from './dkg-agent-base.js';
import type { DKGAgent } from './dkg-agent.js';

export class VmReconcileSchedulingMethods extends DKGAgentBase {
  protected prepareVmReconcileSweep(this: DKGAgent) {
    if (this.started && !this.vmReconcileRuntimeReady) return;
    const lifecycleGeneration = this.vmReconcileLifecycleGeneration;
    const lifecycleSignal = this.vmReconcileLifecycleController?.signal;
    const isLifecycleCurrent = () => !this.vmReconcileRotationClosed
      && !lifecycleSignal?.aborted
      && this.vmReconcileLifecycleGeneration === lifecycleGeneration;
    const scheduling = this.vmReconcileScheduling;
    if (!isLifecycleCurrent() || !this.vmReconcileEnabled() || !scheduling) return;

    const bound = new Set<string>();
    const unbound: string[] = [];
    for (const [localCgId, sub] of this.subscribedContextGraphs) {
      if (!sub.subscribed && !sub.coreHosted) continue;
      if (this.contextGraphBindingState.hasBindingCandidate(localCgId, sub)) bound.add(localCgId);
      else if (sub.subscribed) unbound.push(localCgId);
    }
    for (const localCgId of this.rfc64SelectedVmReconcileTargetIds()) bound.add(localCgId);
    return {
      scheduling,
      isLifecycleCurrent,
      lifecycleSignal,
      bound: [...bound],
      unbound: unbound.filter(key => !bound.has(key)),
    };
  }

  /** Timer-only admission turn; physical workers never serialize later ticks. */
  protected scheduleVmReconcileSweep(this: DKGAgent): void {
    const sweep = this.prepareVmReconcileSweep();
    if (!sweep) return;
    sweep.scheduling.scheduleSweep(sweep.bound, sweep.unbound, sweep.isLifecycleCurrent);
  }

  /** Complete one finite selected rotation and its bounded discovery allowance. */
  async runVmReconcileSweep(this: DKGAgent): Promise<void> {
    const sweep = this.prepareVmReconcileSweep();
    if (!sweep) return;
    await sweep.scheduling.completeSweep(
      sweep.bound,
      sweep.unbound,
      sweep.isLifecycleCurrent,
      sweep.lifecycleSignal,
    );
  }
}
