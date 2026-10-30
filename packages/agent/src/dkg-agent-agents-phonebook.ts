// SPDX-License-Identifier: Apache-2.0

/**
 * On-demand `agents` phonebook mixin: the enable gate, the per-agent fetcher,
 * the subscribe/reconcile trigger, the public-policy read, and the fetcher's
 * agent-backed dependencies, with the lookup of a graph owner's current peers
 * and the broadcast of this node's own profile. The fetcher itself lives in
 * `sync/on-demand-agents-phonebook.ts`; re-scheduling VM recovery for graphs
 * whose curator now resolves stays with VM-reconcile scheduling.
 */

import { DKGAgentBase } from './dkg-agent-base.js';
import type { DKGAgent } from './dkg-agent.js';
import {
  AGENT_DID_PREFIX,
  createOperationContext,
  deriveCuratorDidFromCgId,
  SYSTEM_CONTEXT_GRAPHS,
  type OperationContext,
} from '@origintrail-official/dkg-core';
import { resolveWorkspaceAgentRecipientKeys, type PublishResult } from '@origintrail-official/dkg-publisher';
import { chainAuthorityReadBudgetsOf } from './chain-authority-read-budgets.js';
import { agentProfileResendsFor, AgentProfileResends } from './p2p/agent-profile-resends.js';
import { AGENT_REGISTRY_CONTEXT_GRAPH } from './profile.js';
import { resolveBooleanSwitch } from './sync/backpressure.js';
import { systemContextGraphSyncOptionsOf } from './sync/system-context-graph-policy.js';
import {
  OnDemandAgentsPhonebookFetcher,
  onDemandAgentsPhonebookFor,
  resolveOnDemandAgentsPhonebookFetch,
  type AgentsPhonebookAccessPolicy,
  type AgentsPhonebookFetchTrigger,
  type AgentsPhonebookWalletNeed,
  type OnDemandAgentsPhonebookDeps,
} from './sync/on-demand-agents-phonebook.js';
import { PeerProfileFollowUp, peerProfileFollowUpFor } from './sync/peer-profile-follow-up.js';
import type { GraphOwnerRoutePorts } from './swm/relay-only-share-routes.js';
import type { PeerSyncSession } from './sync/peer-sync-session.js';

/** Wall-clock budget of one follow-up pull of a peer's `agents` graph. */
const PEER_PROFILE_PULL_TIMEOUT_MS = 60_000;
/** Peers of a wallet one lookup returns; the route tries them a few at a time. */
const AGENT_CURRENT_PEERS_LIMIT = 64;

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
   * Fetch the `agents` phonebook for agents a caller cannot resolve, and wait
   * for it: a private share with no key for a recipient (#2849), or with `need`
   * at `peer` a route with no current peer of an owner. Resolves with the
   * lower-cased wallets that resolve afterwards; never throws.
   */
  async ensureAgentsInOnDemandPhonebook(
    this: DKGAgent,
    wallets: readonly string[],
    signal?: AbortSignal,
    need?: AgentsPhonebookWalletNeed,
  ): Promise<ReadonlySet<string>> {
    try {
      return await this.onDemandAgentsPhonebook().ensureWallets(wallets, signal, need);
    } catch {
      return new Set();
    }
  }

  /**
   * The peers of a graph's owner for the owner route, newest first and without
   * stale ones. An Edge keeps no `agents` phonebook, so when no peer is left
   * that is connected or has not failed lately, this fetches the owner's profile
   * from a Core's and looks the owner's peers up again.
   */
  async lookUpGraphOwnerPeers(
    this: DKGAgent,
    contextGraphId: string,
    peers: Pick<GraphOwnerRoutePorts, 'isConnected' | 'failedRecently'>,
    signal?: AbortSignal,
  ): Promise<readonly string[]> {
    const ownerDid = deriveCuratorDidFromCgId(contextGraphId);
    const wallet = ownerDid === null ? undefined : ownerDid.slice(AGENT_DID_PREFIX.length);
    const lookUp = async () => {
      const resolution = await this.resolveCuratorPeerIdsForCg(contextGraphId, { maxPeerIds: 16, signal });
      const fromPhonebook = wallet !== undefined && !resolution.curatorIsLocal;
      const peerIds = fromPhonebook
        ? await this.discovery.findCurrentAgentPeerIds(wallet, { limit: AGENT_CURRENT_PEERS_LIMIT, signal, isLive: peers.isConnected })
        : resolution.peerIds;
      return { fromPhonebook, peerIds: peerIds.filter((peerId) => peerId !== this.peerId) };
    };
    const owner = await lookUp();
    const noneLeft = owner.peerIds.every((peerId) => !peers.isConnected(peerId) && peers.failedRecently(peerId));
    if (wallet === undefined || !owner.fromPhonebook || !noneLeft) return owner.peerIds;
    await this.ensureAgentsInOnDemandPhonebook([wallet], signal, 'peer');
    return (await lookUp()).peerIds;
  }

  /**
   * Broadcast this node's profile. A broadcast no admitted peer got is sent
   * again, a bounded number of times, until one does or a newer profile takes
   * over (`p2p/agent-profile-resends.ts`). Never throws for a lack of peers.
   */
  async broadcastAgentProfile(this: DKGAgent, result: PublishResult, ctx: OperationContext): Promise<void> {
    const send = () => this.broadcastPublish(AGENT_REGISTRY_CONTEXT_GRAPH, result, ctx);
    const resends = agentProfileResendsFor(this, () => new AgentProfileResends({
      isRunning: () => this.started === true,
      isAdmitted: (peerId) => this.networkAdmissionCoordinator.isAcceptedPeer(peerId),
      logInfo: (message) => this.log.info(ctx, message),
      logWarn: (message) => this.log.warn(ctx, message),
    }));
    resends.track(await send(), send);
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

  /**
   * The connect-time pass has just pulled the `agents` graph from `peerId`:
   * while that peer's own profile is still missing, pull the graph from it
   * again shortly after (`sync/peer-profile-follow-up.ts`). Never throws.
   */
  followUpPeerAgentProfile(this: DKGAgent, peerId: string, session: PeerSyncSession): void {
    const followUp = peerProfileFollowUpFor(session, () => new PeerProfileFollowUp({
      hasProfile: async (peer, signal) => (await this.discovery.findAgentByPeerId(peer, { signal })) !== null,
      isConnected: (peer) => this.node.isStarted
        && this.node.libp2p.getConnections().some((connection) => connection.remotePeer.toString() === peer),
      pullAgents: async (peer, signal) => {
        await this.syncFromPeerDetailed(peer, [SYSTEM_CONTEXT_GRAPHS.AGENTS], undefined, undefined, undefined, {
          signal,
          totalTimeoutMs: PEER_PROFILE_PULL_TIMEOUT_MS,
          stopOnBackoffWorthyFailure: true,
          source: 'catchup-background',
        });
      },
      logInfo: (message) => this.log.info(createOperationContext('sync'), message),
    }));
    void followUp.observePull(peerId);
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
      phonebookHasWallet: async (wallet, signal) => {
        const route = this.graphOwnerRoutePortsV1();
        const peerIds = await this.discovery.findCurrentAgentPeerIds(wallet, { limit: AGENT_CURRENT_PEERS_LIMIT, signal, isLive: route.isConnected });
        return peerIds.some((peerId) => route.isConnected(peerId) || !route.failedRecently(peerId));
      },
      // The same resolution a private share runs: a verified, unrevoked key.
      recipientKeyKnown: async (wallet) => {
        try {
          return (await resolveWorkspaceAgentRecipientKeys(this.store, wallet)).length > 0;
        } catch {
          return false;
        }
      },
      readAccessPolicy: (contextGraphId, signal) => (
        this.readAgentsPhonebookAccessPolicy(contextGraphId, signal)
      ),
      listConnectedPeers: () => {
        const peers = new Map<string, { peerId: string; core: boolean }>();
        for (const connection of this.node.libp2p.getConnections()) {
          const peerId = connection.remotePeer.toString();
          if (peerId === this.peerId || peers.has(peerId)) continue;
          peers.set(peerId, { peerId, core: this.peerCapabilityRegistry?.supportsCore(peerId) === true });
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
          deferred: (result.deferredBackpressure ?? 0) > 0,
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
