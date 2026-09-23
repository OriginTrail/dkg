// SPDX-License-Identifier: Apache-2.0

/**
 * Core VM-promotion guarantees: the StorageACK finality gate, the backfill
 * that records historically ACKed public graphs as core-hosted, and the
 * watchdog for ACKed Knowledge Assets that do not reach Verifiable Memory.
 */

import {
  STORAGE_ACK_DECLINE_CODES,
  SYSTEM_CONTEXT_GRAPHS,
  contextGraphMetaUri,
  createOperationContext,
  getMetrics,
} from '@origintrail-official/dkg-core';
import type {
  StorageAckVmPromotionRequest,
  StorageAckVmPromotionVerdict,
} from '@origintrail-official/dkg-publisher';
import { DKGAgentBase } from './dkg-agent-base.js';
import type { DKGAgent } from './dkg-agent.js';
import type { CoreHostedPublicCgRecordOutcome } from './core-hosted-public-cg-record-decision.js';
import { DEFAULT_SWM_TTL_MS } from './dkg-agent-constants.js';
import { deterministicStartupJitterMs, scheduleAfterStartupJitter } from './startup-jitter.js';
import { resolveVmReconcilerEnabled } from './sync/backpressure.js';
import { STORAGE_ACK_UNREGISTERED_AT_PREDICATE } from './storage-ack-retention.js';
import {
  isCanonicalOnChainContextGraphId,
  knowledgeAssetIdFromUal,
  parseStorageAckCopyLocation,
  storageAckCopyLocationsQuery,
  unpromotedStorageAckCopiesQuery,
  type StorageAckCopyLocation,
  type VmPromotionAuditStatus,
} from './vm-promotion-audit.js';

const SYSTEM_CONTEXT_GRAPH_IDS = new Set<string>(Object.values(SYSTEM_CONTEXT_GRAPHS));
/** Distinct (graph, meta graph) locations one discovery query returns. */
const STORAGE_ACK_LOCATION_LIMIT = 1_024;
/** Unpromoted copies sampled per meta graph and ordering, per audit pass. */
const STORAGE_ACK_SAMPLE_LIMIT = 8;
/** Floor before the first audit, on top of the per-peer jitter. */
const VM_PROMOTION_AUDIT_MIN_STARTUP_DELAY_MS = 60_000;
const VM_PROMOTION_AUDIT_MAX_STARTUP_JITTER_MS = 5 * 60_000;
const XSD_DATE_TIME = 'http://www.w3.org/2001/XMLSchema#dateTime';

interface UnpromotedStorageAckCopy {
  readonly op: string;
  readonly ka: string;
  readonly publishedAtMs: number;
}

export class VmPromotionMethods extends DKGAgentBase {
  /**
   * Why chain-driven VM reconciliation cannot run on this node, or null when
   * it can. One owner for the StorageACK decline, the startup warning and
   * `/api/status`, so they cannot disagree.
   */
  vmReconcileUnavailableReason(this: DKGAgent): string | null {
    if (!resolveVmReconcilerEnabled(this.config.vmReconcilerEnabled)) {
      return 'switched off (vmReconcilerEnabled=false or DKG_VM_RECONCILER_ENABLED)';
    }
    if (this.chain.chainId === 'none') return 'no chain is configured';
    if (
      typeof this.chain.getContextGraphKCCount !== 'function'
      || typeof this.chain.getContextGraphKCAt !== 'function'
      || typeof this.chain.getLatestMerkleRoot !== 'function'
    ) {
      return 'the chain adapter lacks the per-graph registration reads';
    }
    return null;
  }

  /**
   * StorageACK finality gate for public ACKs. Answers `ok` only when the
   * chain-driven VM reconciler is enabled and running and the graph is
   * durably recorded as core-hosted, so the reconciler promotes the ACKed
   * Knowledge Asset into this core's Verifiable Memory once the chain
   * finalizes it (for a graph-scoped publish the handler has already stored
   * the ACKed SWM copy and its head).
   *
   * Operator configuration that can never promote is a permanent decline;
   * startup, shutdown and store/RPC blips are transient. Never throws for an
   * expected condition: the handler treats a throw as a transient decline.
   */
  async ensureStorageAckVmPromotion(
    this: DKGAgent,
    request: StorageAckVmPromotionRequest,
  ): Promise<StorageAckVmPromotionVerdict> {
    const disabled = (message: string): StorageAckVmPromotionVerdict => ({
      ok: false,
      code: STORAGE_ACK_DECLINE_CODES.CORE_VM_PROMOTION_DISABLED,
      message,
    });
    const unavailable = (message: string): StorageAckVmPromotionVerdict => ({
      ok: false,
      code: STORAGE_ACK_DECLINE_CODES.CORE_VM_PROMOTION_UNAVAILABLE,
      message,
    });
    if (!this.vmReconcileEnabled()) {
      return disabled('VM reconciliation is disabled on this core');
    }
    if (this.coreHostRecordingsClosed || (this.started && !this.vmReconcileRuntimeReady)) {
      return unavailable('VM reconciliation is not running on this core yet');
    }
    let outcome: CoreHostedPublicCgRecordOutcome;
    try {
      // A burst of first ACKs for one graph shares a single liveness/policy
      // read and store write instead of one per ACK.
      const flightKey = `${request.contextGraphId}\0${request.swmGraphId ?? ''}`;
      let flight = this.storageAckVmPromotionFlights.get(flightKey) as
        Promise<CoreHostedPublicCgRecordOutcome> | undefined;
      if (flight === undefined) {
        const started: Promise<CoreHostedPublicCgRecordOutcome> = this.awaitTrackedCoreHostRecording(
          this.recordCoreHostedPublicCg(
            request.contextGraphId,
            request.swmGraphId,
            { durable: true },
          ),
        ).finally(() => {
          if (this.storageAckVmPromotionFlights.get(flightKey) === started) {
            this.storageAckVmPromotionFlights.delete(flightKey);
          }
        });
        this.storageAckVmPromotionFlights.set(flightKey, started);
        flight = started;
      }
      outcome = await flight;
    } catch (err) {
      this.log.warn(
        createOperationContext('system'),
        `StorageACK finality gate: core-hosted record for cg=${request.contextGraphId} failed: ` +
        `${err instanceof Error ? err.message : String(err)}`,
      );
      return unavailable('core-hosted record unavailable');
    }
    switch (outcome) {
      case 'recorded':
      case 'already-recorded':
        return { ok: true };
      case 'curated':
        // A curated graph's plaintext never belongs in a core's VM; curated
        // publishers use the catalog ACK path, which this gate does not guard.
        return disabled('context graph is curated; request a curated catalog ACK instead');
      case 'vm-reconcile-disabled':
        return disabled('VM reconciliation is disabled on this core');
      case 'invalid-id':
        return disabled('context graph id is not a positive on-chain id');
      case 'policy-unknown':
        return unavailable('context graph liveness or access policy is unavailable');
      case 'persist-failed':
        return unavailable('core-hosted record could not be persisted');
      case 'closed':
        return unavailable('VM reconciliation is stopping');
    }
  }

  /**
   * Await a core-host recording while keeping it visible to `stop()`, which
   * drains in-flight recordings before tearing down the subscription store.
   */
  async awaitTrackedCoreHostRecording<T>(this: DKGAgent, recording: Promise<T>): Promise<T> {
    const tracked: Promise<void> = recording.then(() => undefined, () => undefined)
      .finally(() => { this.coreHostRecordings.delete(tracked); });
    this.coreHostRecordings.add(tracked);
    return recording;
  }

  /** Effective VM-promotion state of this node, for `/api/status`. */
  getVmPromotionStatus(this: DKGAgent): {
    vmReconcilerEnabled: boolean;
    vmReconcileActive: boolean;
    unavailableReason: string | null;
    runtimeReady: boolean;
    storageAckGate: 'signing' | 'declining' | 'starting' | 'not-core';
    coreHostedGraphs: number;
    audit: VmPromotionAuditStatus;
  } {
    const active = this.vmReconcileEnabled();
    const runtimeReady = this.vmReconcileRuntimeReady;
    let coreHostedGraphs = 0;
    for (const sub of this.subscribedContextGraphs.values()) {
      if (sub.coreHosted === true) coreHostedGraphs += 1;
    }
    return {
      vmReconcilerEnabled: resolveVmReconcilerEnabled(this.config.vmReconcilerEnabled),
      vmReconcileActive: active,
      unavailableReason: active ? null : this.vmReconcileUnavailableReason(),
      runtimeReady,
      storageAckGate: (this.config.nodeRole ?? 'edge') !== 'core'
        ? 'not-core'
        : !active ? 'declining' : runtimeReady ? 'signing' : 'starting',
      coreHostedGraphs,
      audit: { ...this.vmPromotionAuditStatus },
    };
  }

  /**
   * Arm the ACK promotion audit on a core whose VM reconciler runs: first
   * after a per-peer jitter (so a fleet restart does not scan in lockstep),
   * then every `VM_PROMOTION_AUDIT_INTERVAL_MS`.
   */
  armVmPromotionAudit(this: DKGAgent): void {
    this.clearVmPromotionAuditTimers();
    if ((this.config.nodeRole ?? 'edge') !== 'core' || !this.vmReconcileEnabled()) return;
    const run = (): void => {
      void this.runVmPromotionAudit().catch(() => undefined);
    };
    const startupDelayMs = VM_PROMOTION_AUDIT_MIN_STARTUP_DELAY_MS + deterministicStartupJitterMs(
      `vm-promotion-audit\0${this.node.peerId.toString()}\0${this.chain.chainId}`,
      VM_PROMOTION_AUDIT_MAX_STARTUP_JITTER_MS,
    );
    this.vmPromotionAuditStartupTimer = scheduleAfterStartupJitter(
      () => {
        this.vmPromotionAuditStartupTimer = null;
        run();
      },
      startupDelayMs,
      DKGAgentBase.VM_PROMOTION_AUDIT_INTERVAL_MS,
      (timer) => {
        this.vmPromotionAuditTimer = timer;
        timer.unref?.();
      },
    );
    this.vmPromotionAuditStartupTimer.unref?.();
  }

  clearVmPromotionAuditTimers(this: DKGAgent): void {
    if (this.vmPromotionAuditStartupTimer) {
      clearTimeout(this.vmPromotionAuditStartupTimer);
      this.vmPromotionAuditStartupTimer = null;
    }
    if (this.vmPromotionAuditTimer) {
      clearInterval(this.vmPromotionAuditTimer);
      this.vmPromotionAuditTimer = null;
    }
  }

  /**
   * One ACK promotion audit pass, single-flight. It finds every graph that
   * holds StorageACK copies (one row query), records graphs this core ACKed
   * while its VM reconciler was off as core-hosted (backfill), and samples
   * copies still not in VM past the stall threshold: a sampled KA registered
   * on chain to its graph is a stall (logged, reconcile re-triggered,
   * counted); one registered nowhere, past the SWM TTL, is stamped so the
   * TTL cleanup may expire it. Bounded per pass in graphs recorded and chain
   * reads, and every chain read goes through the shared RPC governor.
   */
  async runVmPromotionAudit(this: DKGAgent): Promise<VmPromotionAuditStatus> {
    if (!this.vmPromotionAuditInFlight) {
      const run: Promise<void> = this.executeVmPromotionAudit().finally(() => {
        if (this.vmPromotionAuditInFlight === run) this.vmPromotionAuditInFlight = null;
      });
      this.vmPromotionAuditInFlight = run;
    }
    await this.vmPromotionAuditInFlight;
    return { ...this.vmPromotionAuditStatus };
  }

  async executeVmPromotionAudit(this: DKGAgent): Promise<void> {
    const active = () => this.vmReconcileEnabled()
      && !this.coreHostRecordingsClosed
      && (!this.started || this.vmReconcileRuntimeReady);
    if ((this.config.nodeRole ?? 'edge') !== 'core' || !active()) return;
    const status = this.vmPromotionAuditStatus;
    const ctx = createOperationContext('system');
    const startedAt = Date.now();
    try {
      const byGraph = new Map<string, string[]>();
      for (const location of await this.discoverStorageAckCopyLocations()) {
        const metaGraphs = byGraph.get(location.contextGraphId) ?? [];
        metaGraphs.push(location.metaGraph);
        byGraph.set(location.contextGraphId, metaGraphs);
      }
      status.graphsWithAckCopies = byGraph.size;
      const backfill = await this.backfillCoreHostedStorageAckGraphs([...byGraph.keys()], active);
      status.backfilledGraphs += backfill.recorded;
      status.unresolvedGraphs = backfill.unresolved;
      const watch = await this.watchStorageAckPromotion(byGraph, startedAt, active);
      status.staleUnpromotedCopies = watch.stale;
      status.stalledOnChain = watch.stalled;
      status.notRegisteredOnChain = watch.notRegistered;
      status.expiredUnregisteredCopies += watch.expired;
      status.retriesTriggered += watch.retries;
      status.lastError = null;
      const metrics = getMetrics();
      metrics.vmPromotionStalledAcks.record(watch.stalled);
      if (backfill.recorded > 0) metrics.vmPromotionBackfillRecordedTotal.add(backfill.recorded);
      if (watch.retries > 0) metrics.vmPromotionRetriesTotal.add(watch.retries);
      if (backfill.recorded > 0 || backfill.unresolved > 0 || watch.expired > 0) {
        this.log.info(
          ctx,
          `ACK promotion audit: graphsWithAckCopies=${byGraph.size} backfilled=${backfill.recorded} ` +
          `unresolved=${backfill.unresolved} stale=${watch.stale} stalled=${watch.stalled} ` +
          `notRegistered=${watch.notRegistered} expiredUnregistered=${watch.expired}`,
        );
      }
    } catch (err) {
      status.lastError = err instanceof Error ? err.message : String(err);
      this.log.warn(ctx, `ACK promotion audit failed: ${status.lastError}`);
    } finally {
      status.lastRunAt = Date.now();
      status.lastDurationMs = status.lastRunAt - startedAt;
    }
  }

  async discoverStorageAckCopyLocations(this: DKGAgent): Promise<StorageAckCopyLocation[]> {
    const result = await this.store.query(storageAckCopyLocationsQuery(STORAGE_ACK_LOCATION_LIMIT), {
      source: 'agent.vmPromotionAudit.discover',
      priority: 'background',
    });
    if (result.type !== 'bindings') return [];
    const locations: StorageAckCopyLocation[] = [];
    for (const row of result.bindings) {
      const location = parseStorageAckCopyLocation(row['cg'], row['meta']);
      if (location && !SYSTEM_CONTEXT_GRAPH_IDS.has(location.contextGraphId)) locations.push(location);
    }
    return locations;
  }

  /**
   * Record discovered graphs as core-hosted through the same live access-policy
   * check the StorageACK gate uses, so curated graphs stay excluded. Graphs
   * that are already VM targets (core-hosted, or a bound member subscription)
   * need nothing. The chain reconciler then promotes only KAs registered on
   * chain; copies of publishes that never landed are left to retention.
   */
  async backfillCoreHostedStorageAckGraphs(
    this: DKGAgent,
    contextGraphIds: readonly string[],
    active: () => boolean,
  ): Promise<{ recorded: number; unresolved: number }> {
    let recorded = 0;
    let unresolved = 0;
    const pending: string[] = [];
    for (const contextGraphId of contextGraphIds) {
      if (this.vmPromotionBackfillSettled.has(contextGraphId)) continue;
      const sub = this.subscribedContextGraphs.get(contextGraphId);
      if (
        (sub?.coreHosted === true && sub.onChainId !== undefined)
        || (sub?.subscribed === true
          && this.contextGraphBindingState.hasBindingCandidate(contextGraphId, sub))
      ) {
        this.vmPromotionBackfillSettled.add(contextGraphId);
        continue;
      }
      pending.push(contextGraphId);
      if (pending.length >= DKGAgentBase.VM_PROMOTION_AUDIT_MAX_RECORDS) break;
    }
    if (pending.length === 0 || !active()) return { recorded, unresolved };
    const onChainIds = await this.resolveStorageAckGraphOnChainIds(pending);
    const ctx = createOperationContext('system');
    for (const contextGraphId of pending) {
      if (!active()) break;
      const onChainId = onChainIds.get(contextGraphId);
      if (onChainId === undefined) {
        unresolved += 1;
        continue;
      }
      const outcome = await this.awaitTrackedCoreHostRecording(
        this.recordCoreHostedPublicCg(onChainId, contextGraphId, { durable: true, nudge: false }),
      );
      switch (outcome) {
        case 'recorded':
          recorded += 1;
          this.vmPromotionBackfillSettled.add(contextGraphId);
          this.log.info(
            ctx,
            `ACK promotion backfill: recorded "${contextGraphId}" (cg=${onChainId}) as core-hosted; ` +
            'the VM reconcile sweep promotes its KAs registered on chain',
          );
          break;
        case 'already-recorded':
        case 'curated':
        case 'invalid-id':
          this.vmPromotionBackfillSettled.add(contextGraphId);
          break;
        case 'policy-unknown':
        case 'persist-failed':
          unresolved += 1;
          break;
        case 'closed':
        case 'vm-reconcile-disabled':
          return { recorded, unresolved };
      }
    }
    return { recorded, unresolved };
  }

  /**
   * On-chain ids for discovered graphs. A numeric SWM namespace is the id
   * itself; a cleartext one resolves through the finalized authority index,
   * in one batch where possible, via the shared authority-read governor.
   * Adapters without the index use only local bindings and the ontology: the
   * audit never starts a chain history scan.
   */
  async resolveStorageAckGraphOnChainIds(
    this: DKGAgent,
    contextGraphIds: readonly string[],
  ): Promise<Map<string, string>> {
    const resolved = new Map<string, string>();
    const named: string[] = [];
    for (const contextGraphId of contextGraphIds) {
      if (isCanonicalOnChainContextGraphId(contextGraphId)) resolved.set(contextGraphId, contextGraphId);
      else named.push(contextGraphId);
    }
    if (named.length === 0) return resolved;
    const resolveLocally = async (ids: readonly string[]): Promise<void> => {
      for (const contextGraphId of ids) {
        try {
          const onChainId = await this.getContextGraphOnChainId(contextGraphId, {
            source: 'agent.vmPromotionAudit.onChainId',
          });
          if (onChainId !== null && isCanonicalOnChainContextGraphId(onChainId)) {
            resolved.set(contextGraphId, onChainId);
          }
        } catch {
          // Unresolved this pass; the next audit retries.
        }
      }
    };
    const indexReader = this.chain.contextGraphAuthorityIndexRevisionReader;
    if (indexReader === undefined) {
      await resolveLocally(named);
      return resolved;
    }
    const resolveIndexed = async (ids: readonly string[]): Promise<'resolved' | 'legacy'> => {
      const resolution = await this.rfc64AuthorityReadCoordinatorV1.run(
        undefined,
        async (readSignal, evidence) => {
          try {
            return await this.resolveFinalizedContextGraphAuthorityTargetsV1(
              ids,
              evidence.agentResolverReadOptions(readSignal),
            );
          } finally {
            await indexReader.whenIdle();
          }
        },
      );
      if (resolution.kind !== 'finalized-index') return 'legacy';
      for (const [contextGraphId, target] of resolution.targets) {
        if (target.kind === 'resolved-snapshot' && !target.finalizedSnapshot.active) continue;
        resolved.set(contextGraphId, target.expectedOnChainId.toString());
      }
      return 'resolved';
    };
    try {
      if (await resolveIndexed(named) === 'legacy') await resolveLocally(named);
      return resolved;
    } catch {
      // One ambiguous or unreadable name must not block the rest: retry singly.
    }
    for (const contextGraphId of named) {
      try {
        if (await resolveIndexed([contextGraphId]) === 'legacy') await resolveLocally([contextGraphId]);
      } catch {
        // Unresolved this pass; the next audit retries.
      }
    }
    return resolved;
  }

  /**
   * Sample StorageACK copies still not in VM past the stall threshold and
   * classify them against the chain, with a bounded number of reads per pass.
   */
  async watchStorageAckPromotion(
    this: DKGAgent,
    byGraph: ReadonlyMap<string, readonly string[]>,
    now: number,
    active: () => boolean,
  ): Promise<{ stale: number; stalled: number; notRegistered: number; expired: number; retries: number }> {
    const totals = { stale: 0, stalled: 0, notRegistered: 0, expired: 0, retries: 0 };
    const thresholdIso = new Date(now - DKGAgentBase.VM_PROMOTION_STALL_THRESHOLD_MS).toISOString();
    const ttl = this.config.sharedMemoryTtlMs ?? DEFAULT_SWM_TTL_MS;
    const getKnowledgeAssetContextGraphId = this.chain.getKAContextGraphId;
    let chainChecks = DKGAgentBase.VM_PROMOTION_AUDIT_MAX_CHAIN_CHECKS;
    const ctx = createOperationContext('system');
    // Start each pass at a different graph so a large historical backlog in
    // one graph cannot spend every pass's chain-read budget.
    const graphs = [...byGraph.entries()];
    const offset = graphs.length === 0 ? 0 : this.vmPromotionAuditRotation++ % graphs.length;
    for (const [contextGraphId, metaGraphs] of [...graphs.slice(offset), ...graphs.slice(0, offset)]) {
      if (!active()) break;
      let graphChainChecks = DKGAgentBase.VM_PROMOTION_AUDIT_MAX_CHAIN_CHECKS_PER_GRAPH;
      const sub = this.subscribedContextGraphs.get(contextGraphId);
      const onChainId = (sub?.coreHosted === true || sub?.subscribed === true) && sub.onChainId
        ? sub.onChainId
        : isCanonicalOnChainContextGraphId(contextGraphId) ? contextGraphId : undefined;
      const rootMetaGraph = contextGraphMetaUri(contextGraphId);
      let graphStalled = 0;
      let stalledSample: string | undefined;
      for (const metaGraph of metaGraphs) {
        const copies = new Map<string, UnpromotedStorageAckCopy>();
        // Newest first finds fresh stalls; oldest past the TTL finds the
        // copies retention would otherwise keep until its ceiling.
        const samples = [
          { beforeIso: thresholdIso, newestFirst: true },
          ...(ttl > 0 ? [{ beforeIso: new Date(now - ttl).toISOString(), newestFirst: false }] : []),
        ];
        for (const sample of samples) {
          for (const copy of await this.queryUnpromotedStorageAckCopies(
            metaGraph,
            rootMetaGraph,
            sample.beforeIso,
            sample.newestFirst,
          )) copies.set(copy.op, copy);
        }
        totals.stale += copies.size;
        if (onChainId === undefined || typeof getKnowledgeAssetContextGraphId !== 'function') continue;
        for (const copy of copies.values()) {
          if (chainChecks <= 0 || graphChainChecks <= 0 || !active()) break;
          const kaId = knowledgeAssetIdFromUal(copy.ka);
          if (kaId === null) continue;
          chainChecks -= 1;
          graphChainChecks -= 1;
          let registeredTo: bigint;
          try {
            registeredTo = await getKnowledgeAssetContextGraphId.call(this.chain, kaId);
          } catch {
            continue;
          }
          if (registeredTo.toString() === onChainId) {
            totals.stalled += 1;
            graphStalled += 1;
            stalledSample ??= copy.ka;
            continue;
          }
          totals.notRegistered += 1;
          // Stamp only a copy of a KA registered nowhere and already past the
          // ordinary TTL: a younger one may belong to a publish still in flight.
          if (registeredTo === 0n && ttl > 0 && copy.publishedAtMs <= now - ttl) {
            await this.store.insert([{
              subject: copy.op,
              predicate: STORAGE_ACK_UNREGISTERED_AT_PREDICATE,
              object: `"${new Date(now).toISOString()}"^^<${XSD_DATE_TIME}>`,
              graph: metaGraph,
            }]);
            totals.expired += 1;
          }
        }
      }
      if (graphStalled > 0) {
        const scheduling = this.vmReconcileScheduling;
        const retried = scheduling !== undefined && this.isVmReconcileTargetSelected(contextGraphId);
        if (retried) {
          scheduling.triggerPeriodic(contextGraphId);
          totals.retries += 1;
        }
        this.log.warn(
          ctx,
          `VM promotion watchdog: "${contextGraphId}" (cg=${onChainId}) has ${graphStalled} ACKed KA(s) ` +
          `registered on chain but not in VM after ` +
          `${Math.round(DKGAgentBase.VM_PROMOTION_STALL_THRESHOLD_MS / 60_000)}min ` +
          `(e.g. ${stalledSample}; watermark=${sub?.lastReconciledOrdinal ?? 0}); ` +
          (retried ? 'VM reconcile re-triggered' : 'graph is not a VM reconcile target yet'),
        );
      }
    }
    return totals;
  }

  async queryUnpromotedStorageAckCopies(
    this: DKGAgent,
    metaGraph: string,
    rootMetaGraph: string,
    beforeIso: string,
    newestFirst: boolean,
  ): Promise<UnpromotedStorageAckCopy[]> {
    const result = await this.store.query(
      unpromotedStorageAckCopiesQuery({
        metaGraph,
        rootMetaGraph,
        beforeIso,
        newestFirst,
        limit: STORAGE_ACK_SAMPLE_LIMIT,
      }),
      { source: 'agent.vmPromotionAudit.unpromotedCopies', priority: 'background' },
    );
    if (result.type !== 'bindings') return [];
    const copies: UnpromotedStorageAckCopy[] = [];
    for (const row of result.bindings) {
      const op = row['op'];
      const ka = row['ka'];
      const publishedAtMs = Date.parse(stripTypedLiteral(row['ts'] ?? ''));
      if (!op || !ka || !Number.isFinite(publishedAtMs)) continue;
      copies.push({ op, ka, publishedAtMs });
    }
    return copies;
  }
}

function stripTypedLiteral(value: string): string {
  const match = /^"([^"]*)"/.exec(value);
  return match ? match[1] : value;
}
