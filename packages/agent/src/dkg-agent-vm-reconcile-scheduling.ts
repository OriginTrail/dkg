// SPDX-License-Identifier: Apache-2.0

/** Focused VM-reconcile candidate selection and sweep orchestration mixin. */

import { DKGAgentBase } from './dkg-agent-base.js';
import type { DKGAgent } from './dkg-agent.js';
import { SYSTEM_CONTEXT_GRAPHS } from '@origintrail-official/dkg-core';

const VM_RECONCILE_SYSTEM_CONTEXT_GRAPH_IDS = new Set<string>(
  Object.values(SYSTEM_CONTEXT_GRAPHS),
);

export class VmReconcileSchedulingMethods extends DKGAgentBase {
  protected selectVmReconcileTargets(this: DKGAgent) {
    const bound = new Set<string>();
    const unbound: string[] = [];
    for (const [localCgId, sub] of this.subscribedContextGraphs) {
      if (!sub.subscribed && !sub.coreHosted) continue;
      // AGENTS and ONTOLOGY are off-chain bootstrap/control graphs. Their
      // durable subscription rows intentionally have no numeric V10 binding;
      // treating them as unbound VM targets launches a full historical
      // name-hash scan on every sweep even though they can never reconcile
      // against ContextGraphStorage.
      if (VM_RECONCILE_SYSTEM_CONTEXT_GRAPH_IDS.has(localCgId)) continue;
      const hasBindingCandidate = this.contextGraphBindingState.hasBindingCandidate(
        localCgId,
        sub,
      );
      // A graph created on this node remains SWM-only until registration (or
      // authoritative registration recovery) installs its numeric binding.
      // The unbound VM lane exists for pre-subscribed remote PUBLIC graphs;
      // admitting local-origin graphs here races create -> register and turns
      // an explicitly off-chain graph into a historical reverse-name scan.
      if (
        this.localContextGraphProvenance.hasLocalCreate(localCgId)
        && !hasBindingCandidate
      ) continue;
      // Registration owns the binding transition. Avoid queueing a competing
      // cold resolver while its preparatory transaction may be awaiting a
      // delayed receipt; the registration completion path or next sweep will
      // make the newly authoritative target visible.
      if (this.contextGraphRegistrationsInFlight?.has(localCgId)) continue;
      if (hasBindingCandidate) bound.add(localCgId);
      else if (sub.subscribed) unbound.push(localCgId);
    }
    for (const localCgId of this.rfc64SelectedVmReconcileTargetIds()) {
      if (VM_RECONCILE_SYSTEM_CONTEXT_GRAPH_IDS.has(localCgId)) continue;
      const sub = this.subscribedContextGraphs.get(localCgId);
      if (
        this.localContextGraphProvenance.hasLocalCreate(localCgId)
        && (sub === undefined
          || !this.contextGraphBindingState.hasBindingCandidate(localCgId, sub))
      ) continue;
      if (this.contextGraphRegistrationsInFlight?.has(localCgId)) continue;
      bound.add(localCgId);
    }
    return {
      bound: [...bound],
      unbound: unbound.filter(key => !bound.has(key)),
    };
  }

  /** Whether a graph is selected for VM reconciliation, including unbound subscriptions.
   * This query performs no admission, chain reads, or lifecycle transition.
   */
  isVmReconcileTargetSelected(this: DKGAgent, contextGraphId: string): boolean {
    const { bound, unbound } = this.selectVmReconcileTargets();
    return bound.includes(contextGraphId) || unbound.includes(contextGraphId);
  }

  protected prepareVmReconcileSweep(this: DKGAgent) {
    if (this.started && !this.vmReconcileRuntimeReady) return;
    const lifecycleGeneration = this.vmReconcileLifecycleGeneration;
    const lifecycleSignal = this.vmReconcileLifecycleController?.signal;
    const isLifecycleCurrent = () => !this.vmReconcileRotationClosed
      && !lifecycleSignal?.aborted
      && this.vmReconcileLifecycleGeneration === lifecycleGeneration;
    const scheduling = this.vmReconcileScheduling;
    if (!isLifecycleCurrent() || !this.vmReconcileEnabled() || !scheduling) return;
    return { scheduling, isLifecycleCurrent, lifecycleSignal, ...this.selectVmReconcileTargets() };
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
