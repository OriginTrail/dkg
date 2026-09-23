// SPDX-License-Identifier: Apache-2.0

/**
 * On-chain Context Graph observation ingestion.
 *
 * Every chain observation of a Context Graph takes one path here: the live
 * `ContextGraphCreated` tail, ContextGraphStorage id enumeration (historical
 * discovery, see context-graph-storage-discovery.ts) and boot restore of the
 * enumeration checkpoint. The path binds the observation to a local row,
 * seeds the authorization caches, nudges host mode for curated graphs and
 * merges the chain-public facts that `listContextGraphs` rows carry.
 */

import {
  SUBSCRIPTION_SOURCES,
  createOperationContext,
  type OperationContext,
} from '@origintrail-official/dkg-core';

import {
  CONTEXT_GRAPH_STORAGE_DISCOVERY_ID_BUDGET,
  CONTEXT_GRAPH_STORAGE_REFRESH_INTERVAL_MS,
  ContextGraphStorageDiscovery,
  createInMemoryContextGraphStorageDiscoveryStore,
  mergeOnChainContextGraphFacts,
  onChainContextGraphFactsFromObservation,
  onChainContextGraphIdentityDiffers,
  sameOnChainContextGraphFacts,
  type ContextGraphStorageDiscoveryApplyResult,
  type OnChainContextGraphFacts,
  type OnChainContextGraphObservation,
} from './context-graph-storage-discovery.js';
import { DKGAgentBase } from './dkg-agent-base.js';
import type { DKGAgent } from './dkg-agent.js';

/** Where an on-chain observation came from. */
export type OnChainContextGraphObservationSource = 'event' | 'storage' | 'checkpoint';

export class ContextGraphChainObservationMethods extends DKGAgentBase {
  /**
   * Whether a ContextGraphNameRegistry is bound in the Hub. The registry is
   * archived and neither mainnet registers it, so its `NameClaimed` scans find
   * nothing there; this says so once rather than scanning an absent contract
   * in silence. Adapters without the probe keep the legacy registry lanes.
   */
  async hasContextGraphNameRegistry(this: DKGAgent): Promise<boolean> {
    const probe = this.chain.hasContextGraphNameRegistry;
    if (typeof probe !== 'function') return true;
    const bound = await probe.call(this.chain);
    if (!bound && !this.contextGraphNameRegistryAbsenceLogged) {
      this.contextGraphNameRegistryAbsenceLogged = true;
      this.log.info(
        createOperationContext('system'),
        'ContextGraphNameRegistry is not registered in the Hub on this chain; its NameClaimed '
          + 'discovery scan and repair audit find nothing and are skipped. Historical Context '
          + 'Graph discovery enumerates ContextGraphStorage by id instead.',
      );
    }
    return bound;
  }

  /**
   * Discover Context Graphs that already exist on chain, not only those created
   * after this node started: enumerate ContextGraphStorage ids from a durable
   * cursor (see context-graph-storage-discovery.ts). Each entry takes the same
   * path as the live `ContextGraphCreated` tail, so a graph seen by both lanes
   * yields one row. Reads at most `idBudget` ids per call. Returns the number of
   * on-chain ids this call made known to the node.
   */
  async discoverContextGraphsFromStorage(
    this: DKGAgent,
    options: { idBudget?: number; signal?: AbortSignal } = {},
  ): Promise<number> {
    options.signal?.throwIfAborted();
    const discovery = this.getContextGraphStorageDiscovery();
    if (discovery === null) return 0;
    const result = await discovery.discover({
      idBudget: options.idBudget ?? CONTEXT_GRAPH_STORAGE_DISCOVERY_ID_BUDGET,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (result.read > 0) {
      this.log.info(
        createOperationContext('system'),
        `Context Graph storage discovery: read ${result.read} id(s) up to ${result.nextId - 1n}`
          + `${result.latestId === undefined ? '' : ` of ${result.latestId}`}; `
          + `${result.discovered} new; ${result.complete ? 'caught up' : 'continuing next pass'}`,
      );
    }
    return result.discovered;
  }

  /**
   * Re-read already enumerated ContextGraphStorage ids so the mutable facts
   * (active flag, owner, publish policy) stay current. A new generation starts
   * at most once per `minimumIntervalMs`; an unfinished one resumes on each
   * call. Returns the number of graphs whose facts changed.
   */
  async refreshContextGraphsFromStorage(
    this: DKGAgent,
    options: { idBudget?: number; minimumIntervalMs?: number; signal?: AbortSignal } = {},
  ): Promise<number> {
    options.signal?.throwIfAborted();
    const discovery = this.getContextGraphStorageDiscovery();
    if (discovery === null) return 0;
    const result = await discovery.refresh({
      idBudget: options.idBudget ?? CONTEXT_GRAPH_STORAGE_DISCOVERY_ID_BUDGET,
      minimumIntervalMs: options.minimumIntervalMs ?? CONTEXT_GRAPH_STORAGE_REFRESH_INTERVAL_MS,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (result.read > 0) {
      this.log.info(
        createOperationContext('system'),
        `Context Graph storage refresh: re-read ${result.read} id(s); ${result.changed} changed`
          + `${result.complete ? '; generation complete' : ''}`,
      );
    }
    return result.changed;
  }

  /**
   * Re-stage every graph the durable enumeration checkpoint recorded. Runs at
   * start before the chain poller, after durable subscriptions are restored so
   * a known cleartext row binds instead of a duplicate placeholder. Reads the
   * store only: no chain calls, and none of the authorization caches that a
   * fresh chain observation seeds.
   */
  async hydrateContextGraphsFromStorageCheckpoint(this: DKGAgent): Promise<number> {
    const discovery = this.getContextGraphStorageDiscovery();
    if (discovery === null) return 0;
    const ctx = createOperationContext('init');
    const records = await discovery.loadRecords();
    for (const record of records) {
      this.applyOnChainContextGraphObservation({
        contextGraphId: record.contextGraphId,
        owner: record.owner,
        accessPolicy: record.accessPolicy,
        publishPolicy: record.publishPolicy,
        publishAuthority: record.publishAuthority,
        nameHash: record.nameHash,
        blockNumber: record.observedAtBlock,
        createdAt: record.createdAt,
        active: record.active,
      }, { source: 'checkpoint', ctx });
    }
    if (records.length > 0) {
      this.log.info(
        ctx,
        `Restored ${records.length} on-chain context graph(s) from the storage discovery checkpoint `
          + `(next id ${await discovery.cursor()})`,
      );
    }
    return records.length;
  }

  /** The ContextGraphStorage enumeration, or null when the adapter cannot enumerate. */
  protected getContextGraphStorageDiscovery(this: DKGAgent): ContextGraphStorageDiscovery | null {
    if (this.contextGraphStorageDiscovery !== undefined) return this.contextGraphStorageDiscovery;
    const chain = this.chain;
    if (chain.chainId === 'none' || typeof chain.readContextGraphStorageRange !== 'function') {
      this.contextGraphStorageDiscovery = null;
      return null;
    }
    const ctx = createOperationContext('system');
    this.contextGraphStorageDiscovery = new ContextGraphStorageDiscovery({
      store: this.config.contextGraphStorageDiscoveryStore
        ?? createInMemoryContextGraphStorageDiscoveryStore(),
      readRange: (fromId, maxIds, signal) => chain.readContextGraphStorageRange!({
        fromId,
        maxIds,
        ...(signal ? { signal } : {}),
      }),
      apply: (record) => this.applyOnChainContextGraphObservation({
        contextGraphId: record.contextGraphId,
        owner: record.owner,
        accessPolicy: record.accessPolicy,
        publishPolicy: record.publishPolicy,
        publishAuthority: record.publishAuthority,
        nameHash: record.nameHash,
        blockNumber: record.observedAtBlock,
        createdAt: record.createdAt,
        active: record.active,
      }, { source: 'storage', ctx }),
      log: (message) => this.log.warn(ctx, message),
    });
    return this.contextGraphStorageDiscovery;
  }

  /**
   * The one path every on-chain Context Graph observation takes: the live
   * `ContextGraphCreated` tail (`source: 'event'`), ContextGraphStorage
   * enumeration (`'storage'`) and boot hydration of the enumeration checkpoint
   * (`'checkpoint'`). Applying an observation twice is a no-op, so the lanes
   * can overlap freely. Only fresh observations seed the authorization caches
   * or nudge host mode; a checkpoint may be days old.
   */
  applyOnChainContextGraphObservation(
    this: DKGAgent,
    observation: OnChainContextGraphObservation,
    options: {
      source: OnChainContextGraphObservationSource;
      ctx?: OperationContext;
      signal?: AbortSignal;
    },
  ): ContextGraphStorageDiscoveryApplyResult {
    options.signal?.throwIfAborted();
    const ctx = options.ctx ?? createOperationContext('system');
    const incoming = onChainContextGraphFactsFromObservation(observation);
    const previous = this.onChainContextGraphFacts.get(incoming.onChainId);
    if (!this.admitOnChainContextGraphIdentity(previous, incoming, ctx)) {
      return { isNew: false, changed: false };
    }
    const knownBefore = this.isOnChainContextGraphKnown(incoming.onChainId, previous);
    const localId = this.bindOnChainContextGraphObservation(incoming, options.source, knownBefore, ctx);
    this.seenOnChainIds.add(incoming.onChainId);
    if (options.source !== 'checkpoint') {
      this.seedOnChainContextGraphPolicyCaches(incoming);
      // Nudged once per graph: by the live event, or by the enumeration pass
      // that first finds it.
      if (options.source === 'event' || !knownBefore) {
        this.nudgeOnChainContextGraphHostMode(incoming, localId, ctx, options.signal);
      }
    }
    return {
      isNew: !knownBefore,
      changed: this.recordOnChainContextGraphFacts(previous, incoming),
    };
  }

  /**
   * False when a write-once field disagrees with what the node already holds
   * and the incoming observation is the older one. The id then names a
   * different graph (a reorg replaced the slot), and only the newer
   * observation may stage anything; when the incoming one is newer, the stale
   * identity's untouched placeholder is retired first.
   */
  private admitOnChainContextGraphIdentity(
    this: DKGAgent,
    previous: OnChainContextGraphFacts | undefined,
    incoming: OnChainContextGraphFacts,
    ctx: OperationContext,
  ): boolean {
    if (previous === undefined || !onChainContextGraphIdentityDiffers(previous, incoming)) return true;
    if (previous.observedAtBlock > incoming.observedAtBlock) return false;
    this.retireStaleOnChainContextGraphPlaceholder(previous, ctx);
    return true;
  }

  /** Whether the node knew this on-chain id before the current observation. */
  private isOnChainContextGraphKnown(
    this: DKGAgent,
    onChainId: string,
    previous: OnChainContextGraphFacts | undefined,
  ): boolean {
    return previous !== undefined
      || this.seenOnChainIds.has(onChainId)
      || [...this.subscribedContextGraphs.values()].some((s) => s.onChainId === onChainId);
  }

  /**
   * Bind the observation to its local row and return that row's id, or null
   * when the graph opted out of the name hash or the binding is ambiguous.
   *
   * The observation can arrive before or after the explicit local
   * subscription. Bind an already-indexed cleartext row immediately;
   * otherwise retain a process-local wire-only placeholder that the canonical
   * setter will promote when create/join/subscribe supplies the matching
   * cleartext id. This applies to public graphs too: they do not enter the
   * curated host-mode nudge, and a cold Edge must not lose its only
   * authoritative chain-id/policy binding while waiting for an ontology
   * announcement it may have missed.
   */
  private bindOnChainContextGraphObservation(
    this: DKGAgent,
    incoming: OnChainContextGraphFacts,
    source: OnChainContextGraphObservationSource,
    knownBefore: boolean,
    ctx: OperationContext,
  ): string | null {
    const { onChainId, nameHash } = incoming;
    let localId: string | null = null;
    if (nameHash !== null) {
      // The live event keeps the canonical setter call it always made (a write
      // site for the row's onChainHash). Enumeration and hydration skip it when
      // the row is already bound, so passes do not re-persist every row.
      localId = (source === 'event'
        ? null
        : this.onChainContextGraphBoundLocalId(nameHash, onChainId))
        ?? this.stageOnChainContextGraphBindingFromNameHash(nameHash, onChainId);
      if (localId === null) {
        this.log.warn(
          ctx,
          `Skipped ambiguous Context Graph name-hash binding ${nameHash.slice(0, 18)}…`,
        );
      }
    }
    if (!knownBefore && localId === null && source === 'event') {
      this.log.info(ctx, `Noted on-chain context graph ${onChainId.slice(0, 16)}… — will subscribe once cleartext name is resolved`);
    }
    return localId;
  }

  /**
   * Seed the on-chain policy caches from a fresh observation.
   *
   * OT-RFC-38 / LU-5: the access-policy cache lets the StorageACK
   * encrypted-payload guard answer `isCgCurated` from local state without an
   * extra RPC. Keyed by the on-chain numeric id, which is also what a publish
   * intent carries. Issue #872: the same eager cache for `publishPolicy` lets
   * daemon routes recognise a public + open CG from local state; the TTL stamp
   * keeps a later on-chain policy change from being trusted forever.
   */
  private seedOnChainContextGraphPolicyCaches(
    this: DKGAgent,
    incoming: OnChainContextGraphFacts,
  ): void {
    const { onChainId, accessPolicy, publishPolicy } = incoming;
    if (accessPolicy === 0 || accessPolicy === 1) {
      this.onChainAccessPolicyCache.set(onChainId, accessPolicy);
    }
    if (publishPolicy === 0 || publishPolicy === 1) {
      this.onChainPublishPolicyCache.set(onChainId, publishPolicy);
      this.onChainPublishPolicyCacheUpdatedAt.set(onChainId, Date.now());
    }
  }

  /**
   * OT-RFC-38 / LU-6 Phase B — host-mode auto-subscribe for sharding-table
   * cores. The committed wire id (`nameHash`) lets a core derive the SWM
   * gossip topic and host ciphertext for a curated graph without its
   * cleartext name. The reconciler owns the core-role, swmHostMode and
   * sharding-table checks and is robust to graphs it cannot act on; a missed
   * nudge heals on its periodic sweep.
   */
  private nudgeOnChainContextGraphHostMode(
    this: DKGAgent,
    incoming: OnChainContextGraphFacts,
    localId: string | null,
    ctx: OperationContext,
    signal: AbortSignal | undefined,
  ): void {
    if (
      incoming.nameHash === null
      || incoming.accessPolicy !== 1
      || localId === null
      || incoming.active === false
    ) {
      return;
    }
    signal?.throwIfAborted();
    const hashLower = this.contextGraphWireId(incoming.nameHash);
    void this.reconcileSwmHostModeSubscription(
      localId,
      SUBSCRIPTION_SOURCES.CHAIN_EVENT,
    ).catch((err) => {
      this.log.warn(
        ctx,
        `Phase B chain-event auto-subscribe for ${hashLower.slice(0, 18)}… failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  /** Merge the observation into the listed facts; true when they changed. */
  private recordOnChainContextGraphFacts(
    this: DKGAgent,
    previous: OnChainContextGraphFacts | undefined,
    incoming: OnChainContextGraphFacts,
  ): boolean {
    const merged = mergeOnChainContextGraphFacts(previous, incoming);
    if (sameOnChainContextGraphFacts(previous, merged)) return false;
    this.onChainContextGraphFacts.set(incoming.onChainId, merged);
    this.invalidateListContextGraphsCache();
    return true;
  }

  /** The local row already bound to exactly this name hash and on-chain id. */
  private onChainContextGraphBoundLocalId(
    this: DKGAgent,
    nameHash: string,
    onChainId: string,
  ): string | null {
    const localId = this.wireIdToLocalCgId.get(this.contextGraphWireId(nameHash));
    if (localId === undefined) return null;
    return this.subscribedContextGraphs.get(localId)?.onChainId === onChainId ? localId : null;
  }

  /**
   * Drop the hash-only placeholder of an identity the chain no longer reports
   * for this id. Only an untouched placeholder qualifies: never a cleartext
   * row, a subscription, or a Core-hosted graph.
   */
  private retireStaleOnChainContextGraphPlaceholder(
    this: DKGAgent,
    stale: OnChainContextGraphFacts,
    ctx: OperationContext,
  ): void {
    if (stale.nameHash === null) return;
    const wireId = this.contextGraphWireId(stale.nameHash);
    const sub = this.subscribedContextGraphs.get(wireId);
    if (
      sub === undefined
      || sub.onChainId !== stale.onChainId
      || sub.subscribed === true
      || sub.coreHosted === true
      || sub.onChainHash === undefined
      || this.contextGraphWireId(sub.onChainHash) !== wireId
      || this.wireIdToLocalCgId.get(wireId) !== wireId
    ) {
      return;
    }
    this.deleteContextGraphSubscription(wireId);
    this.wireIdToLocalCgId.delete(wireId);
    this.log.warn(
      ctx,
      `On-chain Context Graph ${stale.onChainId} now commits a different name hash; `
        + `retired the stale hash-only row ${wireId.slice(0, 18)}…`,
    );
  }
}
