// SPDX-License-Identifier: Apache-2.0

/**
 * On-demand `agents` phonebook mixin: the enable gate, the per-agent fetcher,
 * the subscribe/reconcile trigger, the public-policy read, and the fetcher's
 * agent-backed dependencies. The fetcher itself lives in
 * `sync/on-demand-agents-phonebook.ts`; re-scheduling VM recovery for graphs
 * whose curator now resolves stays with VM-reconcile scheduling.
 */

import { DKGAgentBase } from './dkg-agent-base.js';
import type { DKGAgent } from './dkg-agent.js';
import {
  createOperationContext,
  deriveCuratorDidFromCgId,
  SYSTEM_CONTEXT_GRAPHS,
} from '@origintrail-official/dkg-core';
import { chainAuthorityReadBudgetsOf } from './chain-authority-read-budgets.js';
import { resolveBooleanSwitch } from './sync/backpressure.js';
import { systemContextGraphSyncOptionsOf } from './sync/system-context-graph-policy.js';
import {
  OnDemandAgentsPhonebookFetcher,
  onDemandAgentsPhonebookFor,
  resolveOnDemandAgentsPhonebookFetch,
  type AgentsPhonebookAccessPolicy,
  type AgentsPhonebookFetchTrigger,
  type OnDemandAgentsPhonebookDeps,
} from './sync/on-demand-agents-phonebook.js';

const AGENT_DID_PREFIX = 'did:dkg:agent:';

export class AgentsPhonebookMethods extends DKGAgentBase {
  /**
   * Whether this node may fetch the `agents` phonebook on demand right now:
   * running, durable sync on, and no automatic on-connect system-graph sync
   * (which already keeps the phonebook).
   */
  onDemandAgentsPhonebookEnabled(this: DKGAgent): boolean {
    return this.started === true
      && resolveBooleanSwitch(this.config.durableSyncEnabled, 'DKG_DURABLE_SYNC_ENABLED', true)
      && resolveOnDemandAgentsPhonebookFetch({
        ...systemContextGraphSyncOptionsOf(this.config),
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
      onCuratorsResolved: (contextGraphIds) => {
        this.scheduleVmRecoveryForResolvedCurators(contextGraphIds);
      },
      logInfo: (message) => this.log.info(ctx, message),
      logDebug: (message) => this.log.debug(ctx, message),
    };
  }
}
