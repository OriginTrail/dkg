// SPDX-License-Identifier: Apache-2.0

/** Focused VM-reconcile candidate selection and sweep orchestration mixin. */

import { DKGAgentBase } from './dkg-agent-base.js';
import type { DKGAgent } from './dkg-agent.js';
import {
  createOperationContext,
  deriveCuratorDidFromCgId,
  SYSTEM_CONTEXT_GRAPHS,
} from '@origintrail-official/dkg-core';
import { chainAuthorityReadBudgetsOf } from './chain-authority-read-budgets.js';
import { resolveBooleanSwitch } from './sync/backpressure.js';
import {
  OnDemandAgentsPhonebookFetcher,
  onDemandAgentsPhonebookFor,
  resolveOnDemandAgentsPhonebookFetch,
  type AgentsPhonebookAccessPolicy,
  type AgentsPhonebookFetchTrigger,
  type OnDemandAgentsPhonebookDeps,
} from './sync/on-demand-agents-phonebook.js';

const AGENT_DID_PREFIX = 'did:dkg:agent:';

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
      const binding = this.contextGraphBindingState.currentBindingFor(
        localCgId,
        sub,
      );
      const hasBindingCandidate = binding !== undefined;
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
      // An accepted owner-signed unregistered authority is terminal evidence
      // that this subscription has no finalized VM inventory. Do not turn the
      // periodic safety net into a fresh historical name-hash crawl each tick.
      if (
        binding?.bindingKind !== 'authoritative'
        && this.hasAcceptedRfc64UnregisteredAuthorityV1(localCgId)
      ) {
        continue;
      }
      if (hasBindingCandidate) bound.add(localCgId);
      else if (sub.subscribed) unbound.push(localCgId);
    }
    for (const localCgId of this.rfc64SelectedVmReconcileTargetIds()) {
      if (VM_RECONCILE_SYSTEM_CONTEXT_GRAPH_IDS.has(localCgId)) continue;
      const sub = this.subscribedContextGraphs.get(localCgId);
      const binding = sub === undefined
        ? undefined
        : this.contextGraphBindingState.currentBindingFor(localCgId, sub);
      if (
        binding?.bindingKind !== 'authoritative'
        && this.hasAcceptedRfc64UnregisteredAuthorityV1(localCgId)
      ) continue;
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

  /**
   * Whether this node may fetch the `agents` phonebook on demand right now:
   * running, durable sync on, and no automatic on-connect system-graph sync
   * (which already keeps the phonebook).
   */
  onDemandAgentsPhonebookEnabled(this: DKGAgent): boolean {
    return this.started === true
      && resolveBooleanSwitch(this.config.durableSyncEnabled, 'DKG_DURABLE_SYNC_ENABLED', true)
      && resolveOnDemandAgentsPhonebookFetch({
        nodeRole: this.config.nodeRole,
        configValue: this.config.syncSystemContextGraphsOnConnect,
        envValue: process.env.DKG_SYNC_SYSTEM_CONTEXT_GRAPHS_ON_CONNECT,
        onDemandConfigValue: this.config.onDemandAgentsPhonebook,
        onDemandEnvValue: process.env.DKG_ON_DEMAND_AGENTS_PHONEBOOK,
      });
  }

  /** The process-local on-demand phonebook fetcher, created on first use. */
  onDemandAgentsPhonebook(this: DKGAgent): OnDemandAgentsPhonebookFetcher {
    return onDemandAgentsPhonebookFor(
      this,
      () => new OnDemandAgentsPhonebookFetcher(this.createOnDemandAgentsPhonebookDeps()),
    );
  }

  /**
   * Ask for one bounded `agents` phonebook fetch on behalf of a graph whose
   * owner the local phonebook cannot map to a peer. Synchronous and never
   * throws; `sync/on-demand-agents-phonebook.ts` owns every bound.
   */
  requestOnDemandAgentsPhonebook(
    this: DKGAgent,
    contextGraphId: string,
    trigger: AgentsPhonebookFetchTrigger,
  ): void {
    try {
      this.onDemandAgentsPhonebook().request(contextGraphId, trigger);
    } catch {
      // Advisory only: a narrow host without the agent runtime skips it.
    }
  }

  /**
   * The phonebook now resolves these graphs' curators. Re-rank their exact
   * recovery now: pre-network suppression sees only connected peers and cached
   * curators, so a resolvable but unconnected curator would otherwise wait out
   * an earlier negative backoff (up to ten minutes) before its first attempt.
   */
  scheduleVmRecoveryForResolvedCurators(
    this: DKGAgent,
    contextGraphIds: readonly string[],
  ): void {
    for (const contextGraphId of contextGraphIds) {
      if (!this.subscribedContextGraphs.has(contextGraphId)) continue;
      this.clearVmReconcileRotationStateForContextGraph(contextGraphId);
      this.clearVmReconcileActiveFetchCooldown(contextGraphId);
      this.vmReconcileCuratorPeersByCg.delete(contextGraphId);
      this.vmReconcileCuratorPageCursorByCg.delete(contextGraphId);
      this.vmReconcileScheduling?.releaseLiveHold(contextGraphId);
      this.vmReconcileScheduling?.triggerLive(contextGraphId);
    }
  }

  /**
   * Read-only public-policy check for the phonebook trigger. A wrong answer
   * costs at most one bounded fetch or one skipped fetch that the next trigger
   * corrects, so the finalized authority projection may answer, else one
   * bounded current-state read.
   */
  async readAgentsPhonebookAccessPolicy(
    this: DKGAgent,
    contextGraphId: string,
    signal: AbortSignal,
  ): Promise<AgentsPhonebookAccessPolicy> {
    const { requestTimeoutMs, coldResolutionTimeoutMs } = chainAuthorityReadBudgetsOf(this);
    try {
      const authority = await this.resolveRegisteredContextGraphAuthority(contextGraphId, {
        signal: AbortSignal.any([
          signal,
          AbortSignal.timeout(coldResolutionTimeoutMs + requestTimeoutMs),
        ]),
        registrationTimeoutMs: coldResolutionTimeoutMs,
        authorityReadMode: 'finalized-index-or-live',
        freshness: 'bounded',
      });
      if (authority.kind === 'public') return 'public';
      return authority.kind === 'unavailable' ? 'unknown' : 'not-public';
    } catch {
      return 'unknown';
    }
  }

  createOnDemandAgentsPhonebookDeps(this: DKGAgent): OnDemandAgentsPhonebookDeps {
    const ctx = createOperationContext('sync');
    return {
      isEnabled: () => this.onDemandAgentsPhonebookEnabled(),
      remoteCuratorWallet: (contextGraphId) => {
        const curatorDid = deriveCuratorDidFromCgId(contextGraphId);
        if (curatorDid === null) return null;
        const wallet = curatorDid.slice(AGENT_DID_PREFIX.length);
        const walletKey = wallet.toLowerCase();
        for (const address of this.localAgents.keys()) {
          if (address.toLowerCase() === walletKey) return null;
        }
        return wallet;
      },
      isActiveSubscription: (contextGraphId) => {
        const subscription = this.subscribedContextGraphs.get(contextGraphId);
        return subscription?.subscribed === true || subscription?.coreHosted === true;
      },
      phonebookHasWallet: async (wallet, signal) => (
        await this.discovery.findAgentPeerPageByAddress(wallet, { limit: 1, signal })
      ).peerIds.length > 0,
      readAccessPolicy: (contextGraphId, signal) => (
        this.readAgentsPhonebookAccessPolicy(contextGraphId, signal)
      ),
      listConnectedPeers: () => {
        const peers = new Map<string, { peerId: string; core: boolean }>();
        for (const connection of this.node.libp2p.getConnections()) {
          const peerId = connection.remotePeer.toString();
          if (peerId === this.peerId || peers.has(peerId)) continue;
          peers.set(peerId, { peerId, core: this.knownCorePeerIds.has(peerId) });
        }
        return [...peers.values()];
      },
      // Network admission first (#2740): a peer of another DKG network, or
      // one that failed the identity proof, never feeds the phonebook.
      preparePeer: async (peerId, signal) => (
        await this.ensurePeerAdmittedForRecovery(peerId, ctx, 'Agents phonebook peer', signal)
        && await this.waitForSyncProtocol({ toString: () => peerId }, signal)
      ),
      // A caller signal and wall-clock budget select the row-paged legacy
      // durable lane, which is the right lane for the large `agents` graph.
      syncAgentsFromPeer: async (peerId, { signal, totalTimeoutMs }) => {
        const result = await this.syncFromPeerDetailed(
          peerId,
          [SYSTEM_CONTEXT_GRAPHS.AGENTS],
          undefined,
          undefined,
          undefined,
          {
            signal,
            totalTimeoutMs,
            stopOnBackoffWorthyFailure: true,
            source: 'catchup-background',
          },
        );
        return {
          fetchedTriples: result.fetchedDataTriples + result.fetchedMetaTriples,
          insertedTriples: result.insertedTriples,
          complete: result.complete,
        };
      },
      countProfiles: (signal) => this.discovery.countAgents({ signal }),
      onCuratorsResolved: (contextGraphIds) => {
        this.scheduleVmRecoveryForResolvedCurators(contextGraphIds);
      },
      logInfo: (message) => this.log.info(ctx, message),
      logDebug: (message) => this.log.debug(ctx, message),
    };
  }
}
