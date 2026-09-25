// SPDX-License-Identifier: Apache-2.0

/**
 * Core VM-promotion guarantees: the StorageACK finality gate, the signed-ACK
 * ledger that retention and the audit key on, the backfill that records
 * historically ACKed public graphs as core-hosted, the promotion of ACKed
 * updates once they land on chain, and the watchdog for ACKed Knowledge
 * Assets that do not reach Verifiable Memory.
 */

import {
  STORAGE_ACK_DECLINE_CODES,
  SYSTEM_CONTEXT_GRAPHS,
  createOperationContext,
  getMetrics,
  validateSubGraphName,
} from '@origintrail-official/dkg-core';
import {
  STORAGE_ACK_LEDGER_GRAPH,
  STORAGE_ACK_LEDGER_PREDICATES as LEDGER,
  storageAckLedgerMarkUpdate,
  storageAckOperationId,
  xsdDateTimeLiteral,
  type StorageAckPriorVersionRequest,
  type StorageAckVmPromotionRequest,
  type StorageAckVmPromotionVerdict,
} from '@origintrail-official/dkg-publisher';
import { withDefaultStoreWorkPriority } from '@origintrail-official/dkg-storage';
import { withOwnedRpcRequestContext, withRpcRequestContext } from '@origintrail-official/dkg-chain';
import { ethers } from 'ethers';
import { DKGAgentBase } from './dkg-agent-base.js';
import type { DKGAgent } from './dkg-agent.js';
import {
  resolveCoreHostedPublicCgLocalId,
  type CoreHostedPublicCgRecordOutcome,
} from './core-hosted-public-cg-record-decision.js';
import { DEFAULT_SWM_TTL_MS } from './dkg-agent-constants.js';
import { deterministicStartupJitterMs, scheduleAfterStartupJitter } from './startup-jitter.js';
import { resolveVmReconcilerEnabled } from './sync/backpressure.js';
import { storageAckGrandfatherUpdate } from './storage-ack-retention.js';
import {
  isCanonicalOnChainContextGraphId,
  isStorageAckNamespace,
  knowledgeAssetIdFromUal,
  parseStorageAckLedgerCandidate,
  storageAckAssetSubGraphsQuery,
  storageAckAuditCandidatesQuery,
  storageAckLedgerNamespacesQuery,
  storageAckNamespaceSubGraphsQuery,
  storageAckLedgerOrphansDeleteUpdate,
  storageAckLedgerOrphansQuery,
  storageAckLedgerStateQuery,
  storageAckPendingUpdatesQuery,
  storageAckNamespaceTargetsQuery,
  storageAckPromotedQuery,
  stripLiteral,
  type StorageAckLedgerCandidate,
  type VmPromotionAuditStatus,
} from './vm-promotion-audit.js';

const SYSTEM_CONTEXT_GRAPH_IDS = new Set<string>(Object.values(SYSTEM_CONTEXT_GRAPHS));
/** Floor before the first audit, on top of the per-peer jitter. */
const VM_PROMOTION_AUDIT_MIN_STARTUP_DELAY_MS = 60_000;
const VM_PROMOTION_AUDIT_MAX_STARTUP_JITTER_MS = 5 * 60_000;
/** Ledger rows of retired copies one pass removes. */
const STORAGE_ACK_LEDGER_ORPHAN_BATCH = 2_000;
/** On-chain ids read per namespace when choosing its backfill target. */
const STORAGE_ACK_TARGETS_PER_NAMESPACE = 4;
/** A pending update is first checked this long after its ACK. */
const PENDING_UPDATE_MIN_AGE_MS = 60_000;
/**
 * A gap this long since a ledger-keeping version last ran means another
 * version (a rollback) may have signed ACKs meanwhile: grandfather that window.
 */
const STORAGE_ACK_LEDGER_REGRANDFATHER_GAP_MS = 60 * 60_000;
/**
 * Every ledger update below writes only the ledger graph. Naming it keeps a
 * graph-set index current with one bounded probe; an undeclared update makes
 * the next graph listing rescan the whole store.
 */
const STORAGE_ACK_LEDGER_TOUCHED_GRAPHS: readonly string[] =
  Object.freeze([STORAGE_ACK_LEDGER_GRAPH]);
/** Per-asset promotions requested by declined update ACKs that run at once. */
const PRIOR_VERSION_PROMOTION_CONCURRENCY = 8;
/** Further requests queue (single-flight per asset); beyond this they are left to the lanes. */
const PRIOR_VERSION_PROMOTION_QUEUE_MAX = 512;
/**
 * A namespace whose persisted subscription row stays dormant this long for
 * a reason that normally clears (authority retry, activation slot) is then
 * declined finally rather than transiently, so publishers stop waiting on it.
 */
const STORAGE_ACK_DORMANT_TRANSIENT_MS = 10 * 60_000;
const BACKOFF_BASE_MS = 60_000;
const BACKOFF_MAX_MS = 24 * 60 * 60_000;
const DECLINE_WINDOW_MINUTES = 60;

/**
 * `landed`: the chain's latest version is this copy's version, so it can be
 * promoted. `superseded`: a later version landed; the copy can never be
 * promoted as-is and is released. `absent`: the chain does not have it (yet).
 */
type CopyClassification = 'landed' | 'superseded' | 'absent' | 'unknown';

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
   * chain-driven VM reconciler is enabled and running and the SWM namespace
   * holding the ACK copy is durably recorded as core-hosted. The handler
   * then persists the copy and its head, records the signature in the
   * node-local ledger, and signs; retention keeps the copy until it is in
   * VM, and the reconciler (publishes) or the pending-update lane (updates)
   * promotes it once the chain finalizes it.
   *
   * Operator configuration that can never promote is a permanent decline;
   * startup, shutdown, dormant rows and store/RPC blips are transient. Never
   * throws for an expected condition: the handler treats a throw as a
   * transient decline.
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
    const binding = await this.checkStorageAckNamespaceBinding(request);
    if (binding !== undefined) return binding;
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
            // The namespace binding was just verified on chain above.
            { durable: true, namespaceVerified: true },
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
    // The namespace the recorder keyed the row (and its dormancy) under.
    const localCgId = resolveCoreHostedPublicCgLocalId({
      onChainId: request.contextGraphId,
      swmGraphId: request.swmGraphId,
    });
    if (outcome !== 'dormant') this.storageAckDormantSince.delete(localCgId);
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
      case 'namespace-conflict':
        return disabled('the SWM namespace is bound to another context graph on this core');
      case 'policy-unknown':
        return unavailable('context graph liveness or access policy is unavailable');
      case 'persist-failed':
        return unavailable('core-hosted record could not be persisted');
      case 'dormant': {
        // The persisted row is never overwritten from an ACK. Dormancy that
        // clears on its own (authority retry, rolling activation slot) is
        // transient for a while; anything else is final and says why.
        const reason = this.contextGraphSubscriptionDormancyById.get(localCgId);
        const now = Date.now();
        const since = this.storageAckDormantSince.get(localCgId) ?? now;
        this.storageAckDormantSince.set(localCgId, since);
        const selfClearing = reason === 'authorityUnavailable' || reason === 'activationCap';
        if (selfClearing && now - since < STORAGE_ACK_DORMANT_TRANSIENT_MS) {
          if (reason === 'activationCap') this.contextGraphSubscriptionRehydrationPromotionRuntime?.request();
          return unavailable(`the graph subscription on this core is not active yet (${reason})`);
        }
        return disabled(
          `the persisted subscription for "${localCgId}" is dormant on this core (${reason ?? 'unknown'})` +
          (reason === 'rehydrationDisabled' ? '; subscription rehydration is disabled' : ''),
        );
      }
      case 'binding-pending':
        return unavailable('the graph subscription on this core has no on-chain binding yet');
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

  /** Count one StorageACK decline under its (log/metric) code. */
  recordStorageAckDecline(this: DKGAgent, code: string, now = Date.now()): void {
    const minute = Math.floor(now / 60_000);
    const bucket = this.storageAckDeclineBuckets.get(minute) ?? new Map<string, number>();
    bucket.set(code, (bucket.get(code) ?? 0) + 1);
    this.storageAckDeclineBuckets.set(minute, bucket);
    for (const key of this.storageAckDeclineBuckets.keys()) {
      if (key <= minute - DECLINE_WINDOW_MINUTES) this.storageAckDeclineBuckets.delete(key);
    }
  }

  /** StorageACK declines per code over the last hour. */
  storageAckDeclinesLastHour(this: DKGAgent, now = Date.now()): Record<string, number> {
    const minute = Math.floor(now / 60_000);
    const counts: Record<string, number> = {};
    for (const [key, bucket] of this.storageAckDeclineBuckets) {
      if (key <= minute - DECLINE_WINDOW_MINUTES) continue;
      for (const [code, count] of bucket) counts[code] = (counts[code] ?? 0) + count;
    }
    return counts;
  }

  /** Effective VM-promotion state of this node, for `/api/status`. */
  getVmPromotionStatus(this: DKGAgent): {
    vmReconcilerEnabled: boolean;
    vmReconcileActive: boolean;
    unavailableReason: string | null;
    runtimeReady: boolean;
    storageAckGate: 'ready' | 'declining' | 'starting' | 'not-core';
    storageAckHandler: 'registered' | 'not-registered' | 'not-core';
    coreHostedGraphs: number;
    storageAckDeclinesLastHour: Record<string, number>;
    audit: VmPromotionAuditStatus;
  } {
    const active = this.vmReconcileEnabled();
    const runtimeReady = this.vmReconcileRuntimeReady;
    const core = (this.config.nodeRole ?? 'edge') === 'core';
    let coreHostedGraphs = 0;
    for (const sub of this.subscribedContextGraphs.values()) {
      if (sub.coreHosted === true) coreHostedGraphs += 1;
    }
    return {
      vmReconcilerEnabled: resolveVmReconcilerEnabled(this.config.vmReconcilerEnabled),
      vmReconcileActive: active,
      unavailableReason: active ? null : this.vmReconcileUnavailableReason(),
      runtimeReady,
      storageAckGate: !core
        ? 'not-core'
        : !active ? 'declining' : runtimeReady ? 'ready' : 'starting',
      storageAckHandler: !core
        ? 'not-core'
        : this.storageAckHandlerRegistered ? 'registered' : 'not-registered',
      coreHostedGraphs,
      storageAckDeclinesLastHour: this.storageAckDeclinesLastHour(),
      audit: { ...this.vmPromotionAuditStatus },
    };
  }

  /**
   * Arm the ACK promotion audit on a core whose VM reconciler runs: first
   * after a per-peer jitter (so a fleet restart does not scan in lockstep),
   * then every `VM_PROMOTION_AUDIT_INTERVAL_MS`; and the pending-update lane
   * at the VM sweep cadence.
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
    this.vmPromotionUpdateTimer = setInterval(() => {
      void this.runPendingStorageAckUpdates().catch(() => undefined);
    }, DKGAgentBase.VM_RECONCILE_SWEEP_INTERVAL_MS);
    this.vmPromotionUpdateTimer.unref?.();
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
    if (this.vmPromotionUpdateTimer) {
      clearInterval(this.vmPromotionUpdateTimer);
      this.vmPromotionUpdateTimer = null;
    }
  }

  /** Background RPC class and store lane for every audit read and write. */
  runVmPromotionInBackground<T>(this: DKGAgent, work: () => Promise<T>): Promise<T> {
    const signal = this.vmReconcileLifecycleController?.signal;
    return withOwnedRpcRequestContext(
      { requestClass: 'background', ...(signal ? { signal } : {}) },
      () => withDefaultStoreWorkPriority('background', work),
    );
  }

  vmPromotionAuditActive(this: DKGAgent): boolean {
    return (this.config.nodeRole ?? 'edge') === 'core'
      && this.vmReconcileEnabled()
      && !this.coreHostRecordingsClosed
      && (!this.started || this.vmReconcileRuntimeReady);
  }

  /**
   * Make the signed-ACK ledger usable. The first time a store is used by a
   * ledger-keeping version, every `storage-ack-` copy stored before now is
   * grandfathered in one store-side INSERT, and the bound is persisted so
   * later restarts skip it. If the node has not run a ledger-keeping version
   * for over an hour (for example after a rollback), copies stored since it
   * last ran are grandfathered too. Until this succeeds the TTL cleanup keeps
   * every young `storage-ack-` copy; the promotion lanes do not wait for it.
   */
  async ensureStorageAckLedgerReady(this: DKGAgent): Promise<boolean> {
    if (this.storageAckLedgerReady) return true;
    if (this.storageAckLedgerReadyFlight) return this.storageAckLedgerReadyFlight;
    const flight = (async (): Promise<boolean> => {
      try {
        if (typeof this.store.update !== 'function') {
          throw new Error('the triple store cannot run SPARQL updates');
        }
        const state = await this.store.query(storageAckLedgerStateQuery(), {
          source: 'agent.storageAckLedger.state',
          priority: 'background',
        });
        const row = state.type === 'bindings' ? state.bindings[0] : undefined;
        const instant = (value: string | undefined): string | undefined => {
          const iso = value === undefined ? undefined : stripLiteral(value);
          return iso !== undefined && Number.isFinite(Date.parse(iso)) ? iso : undefined;
        };
        const through = instant(row?.['through']);
        const lastSeen = instant(row?.['seen']) ?? through;
        const now = new Date();
        const options = {
          source: 'agent.storageAckLedger.grandfather',
          priority: 'background' as const,
          touchedGraphs: STORAGE_ACK_LEDGER_TOUCHED_GRAPHS,
        };
        let since: string | undefined | null = null;
        if (through === undefined) {
          since = undefined;
        } else if (
          lastSeen !== undefined
          && now.getTime() - Date.parse(lastSeen) > STORAGE_ACK_LEDGER_REGRANDFATHER_GAP_MS
        ) {
          since = lastSeen;
        }
        if (since !== null) {
          await this.store.update(storageAckGrandfatherUpdate(now.toISOString(), since), options);
          await this.store.update(
            storageAckLedgerMarkUpdate(STORAGE_ACK_LEDGER_GRAPH, LEDGER.grandfatheredThrough, now),
            options,
          );
        }
        if (instant(row?.['epoch']) === undefined) {
          await this.store.update(storageAckLedgerMarkUpdate(STORAGE_ACK_LEDGER_GRAPH, LEDGER.epoch, now), options);
        }
        await this.store.update(storageAckLedgerMarkUpdate(STORAGE_ACK_LEDGER_GRAPH, LEDGER.seenAt, now), options);
        this.storageAckLedgerReady = true;
        this.vmPromotionAuditStatus.ledgerReady = true;
        return true;
      } catch (err) {
        this.log.warn(
          createOperationContext('system'),
          `StorageACK ledger is not ready; keeping every young ACK copy: ` +
          `${err instanceof Error ? err.message : String(err)}`,
        );
        return false;
      } finally {
        this.storageAckLedgerReadyFlight = null;
      }
    })();
    this.storageAckLedgerReadyFlight = flight;
    return flight;
  }

  /**
   * The sub-graph this core's StorageACK copy of an asset sits in, when its
   * ledger names exactly one. Only cores keep a ledger.
   */
  async storageAckLedgerSubGraphName(
    this: DKGAgent,
    namespace: string,
    kaUal: string,
  ): Promise<string | undefined> {
    if ((this.config.nodeRole ?? 'edge') !== 'core') return undefined;
    try {
      const result = await this.store.query(storageAckAssetSubGraphsQuery(namespace, kaUal), {
        source: 'agent.storageAckLedger.assetSubGraph',
      });
      if (result.type !== 'bindings' || result.bindings.length !== 1) return undefined;
      const value = result.bindings[0]?.['subGraph'];
      const subGraphName = value === undefined ? undefined : stripLiteral(value);
      return subGraphName !== undefined && validateSubGraphName(subGraphName).valid ? subGraphName : undefined;
    } catch {
      return undefined;
    }
  }

  /** Sub-graphs of a namespace that hold this core's StorageACK copies. */
  async storageAckLedgerNamespaceSubGraphs(this: DKGAgent, namespace: string): Promise<string[]> {
    if ((this.config.nodeRole ?? 'edge') !== 'core') return [];
    try {
      const result = await this.store.query(storageAckNamespaceSubGraphsQuery(namespace, 256), {
        source: 'agent.storageAckLedger.namespaceSubGraphs',
      });
      if (result.type !== 'bindings') return [];
      return result.bindings
        .map((row) => (row['subGraph'] === undefined ? '' : stripLiteral(row['subGraph'])))
        .filter((name) => name.length > 0 && validateSubGraphName(name).valid);
    } catch {
      return [];
    }
  }

  /** Every SWM namespace that holds ledgered ACK copies. */
  async listStorageAckLedgerNamespaces(this: DKGAgent): Promise<string[]> {
    const namespaces: string[] = [];
    let after: string | undefined = '';
    while (after !== undefined) {
      const page = await this.queryStorageAckLedgerNamespaces(after, 1_000);
      namespaces.push(...page.namespaces);
      after = page.next;
    }
    return namespaces;
  }

  /**
   * One keyset page of ledger namespaces: the usable ones, and the cursor of
   * the next page (absent after the last). The cursor follows the raw rows, so
   * a namespace dropped here never ends or resets the walk.
   */
  async queryStorageAckLedgerNamespaces(
    this: DKGAgent,
    after: string,
    limit: number,
  ): Promise<{ namespaces: string[]; next?: string }> {
    const result = await this.store.query(storageAckLedgerNamespacesQuery(after, limit), {
      source: 'agent.storageAckLedger.namespaces',
      priority: 'background',
    });
    if (result.type !== 'bindings') return { namespaces: [] };
    const namespaces: string[] = [];
    let last = after;
    for (const row of result.bindings) {
      const namespace = row['namespace'] === undefined ? '' : stripLiteral(row['namespace']);
      if (namespace > last) last = namespace;
      if (isStorageAckNamespace(namespace)) namespaces.push(namespace);
    }
    return result.bindings.length < limit || last === after ? { namespaces } : { namespaces, next: last };
  }

  /**
   * One ACK promotion audit pass, single-flight, in the background lanes:
   * ready the ledger, drop ledger rows of retired copies, backfill core-hosted
   * rows for namespaces this core ACKed into, then examine a keyset page of
   * ledgered copies past the stall threshold (see {@link auditStorageAckCopies}).
   */
  async runVmPromotionAudit(this: DKGAgent): Promise<VmPromotionAuditStatus> {
    if (!this.vmPromotionAuditInFlight) {
      const run: Promise<void> = this.runVmPromotionInBackground(() => this.executeVmPromotionAudit())
        .finally(() => {
          if (this.vmPromotionAuditInFlight === run) this.vmPromotionAuditInFlight = null;
        });
      this.vmPromotionAuditInFlight = run;
    }
    await this.vmPromotionAuditInFlight;
    return { ...this.vmPromotionAuditStatus };
  }

  async executeVmPromotionAudit(this: DKGAgent): Promise<void> {
    if (!this.vmPromotionAuditActive()) return;
    const status = this.vmPromotionAuditStatus;
    const ctx = createOperationContext('system');
    const startedAt = Date.now();
    const active = () => this.vmPromotionAuditActive();
    try {
      // Rows the handler writes are valid without grandfathering, so the pass
      // runs either way; only pre-ledger copies wait for it.
      const ledgerReady = await this.ensureStorageAckLedgerReady();
      await this.pruneStorageAckLedgerOrphans();
      const backfill = await this.backfillCoreHostedStorageAckGraphs(startedAt, active);
      status.namespacesWithAckCopies = backfill.namespaces;
      status.discoveryWrapped = backfill.wrapped;
      status.backfilledGraphs += backfill.recorded;
      status.backfillPending = backfill.pending;
      status.unresolvedGraphs = backfill.unresolved;
      const audit = await this.auditStorageAckCopies(startedAt, active);
      status.auditedCopies = audit.examined;
      status.staleUnpromotedCopies = audit.stale;
      status.stalledOnChain = audit.stalled;
      status.notRegisteredOnChain = audit.absent;
      status.expiredUnregisteredCopies += audit.expired;
      status.supersededCopies += audit.superseded;
      status.retriesTriggered += audit.reconciled;
      status.promotedByAudit += audit.promoted;
      status.lastError = ledgerReady ? null : 'StorageACK ledger is not ready (pre-ledger copies not grandfathered yet)';
      if (ledgerReady) {
        await this.store.update?.(
          storageAckLedgerMarkUpdate(STORAGE_ACK_LEDGER_GRAPH, LEDGER.seenAt, new Date()),
          {
            source: 'agent.storageAckLedger.seen',
            priority: 'background',
            touchedGraphs: STORAGE_ACK_LEDGER_TOUCHED_GRAPHS,
          },
        );
      }
      const metrics = getMetrics();
      metrics.vmPromotionStalledAcks.record(audit.stalled);
      if (backfill.recorded > 0) metrics.vmPromotionBackfillRecordedTotal.add(backfill.recorded);
      if (audit.reconciled > 0) metrics.vmPromotionRetriesTotal.add(audit.reconciled);
      if (
        backfill.recorded > 0 || backfill.unresolved > 0 || audit.stalled > 0 || audit.expired > 0
        || audit.superseded > 0
      ) {
        this.log.info(
          ctx,
          `ACK promotion audit: namespaces=${backfill.namespaces} backfilled=${backfill.recorded} ` +
          `pending=${backfill.pending} unresolved=${backfill.unresolved} examined=${audit.examined} ` +
          `stale=${audit.stale} stalled=${audit.stalled} absent=${audit.absent} ` +
          `superseded=${audit.superseded} ` +
          `expired=${audit.expired} reconciled=${audit.reconciled} promoted=${audit.promoted}`,
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

  /** Drop ledger rows whose ACK copy was retired after promotion or expired. */
  async pruneStorageAckLedgerOrphans(this: DKGAgent): Promise<number> {
    if (typeof this.store.update === 'function') {
      await this.store.update(storageAckLedgerOrphansDeleteUpdate(), {
        source: 'agent.storageAckLedger.orphans',
        priority: 'background',
        touchedGraphs: STORAGE_ACK_LEDGER_TOUCHED_GRAPHS,
      });
      return 0;
    }
    const result = await this.store.query(storageAckLedgerOrphansQuery(STORAGE_ACK_LEDGER_ORPHAN_BATCH), {
      source: 'agent.storageAckLedger.orphans',
    });
    if (result.type !== 'bindings') return 0;
    let pruned = 0;
    for (const row of result.bindings) {
      const op = row['op'];
      if (!op) continue;
      await this.store.deleteByPattern({ graph: STORAGE_ACK_LEDGER_GRAPH, subject: op });
      pruned += 1;
    }
    return pruned;
  }

  /**
   * Record namespaces holding ledgered ACK copies as core-hosted, through the
   * same live access-policy check the gate uses, so curated graphs stay
   * excluded. Namespaces are paged by keyset across passes, and one that
   * cannot be resolved backs off exponentially, so a run of unresolvable
   * graphs cannot hold every pass's slots. The chain reconciler then promotes
   * only Knowledge Assets registered on chain; copies of publishes that never
   * landed are left to retention.
   */
  async backfillCoreHostedStorageAckGraphs(
    this: DKGAgent,
    now: number,
    active: () => boolean,
  ): Promise<{ namespaces: number; wrapped: boolean; recorded: number; pending: number; unresolved: number }> {
    const limit = DKGAgentBase.VM_PROMOTION_BACKFILL_PAGE_SIZE;
    const raw = await this.queryStorageAckLedgerNamespaces(this.vmPromotionBackfillCursor, limit);
    const page = raw.namespaces.filter((namespace) => !SYSTEM_CONTEXT_GRAPH_IDS.has(namespace));
    const wrapped = raw.next === undefined;
    this.vmPromotionBackfillCursor = raw.next ?? '';
    let recorded = 0;
    let unresolved = 0;
    const pending: string[] = [];
    for (const namespace of page) {
      if (this.vmPromotionBackfillSettled.has(namespace)) continue;
      const sub = this.subscribedContextGraphs.get(namespace);
      if (
        (sub?.coreHosted === true && sub.onChainId !== undefined)
        || (sub?.subscribed === true
          && this.contextGraphBindingState.hasBindingCandidate(namespace, sub))
      ) {
        this.vmPromotionBackfillSettled.add(namespace);
        continue;
      }
      const backoff = this.vmPromotionBackfillBackoff.get(namespace);
      if (backoff !== undefined && backoff.nextAttemptAt > now) {
        unresolved += 1;
        continue;
      }
      pending.push(namespace);
    }
    const attempt = pending.slice(0, DKGAgentBase.VM_PROMOTION_AUDIT_MAX_RECORDS);
    const targets = await this.resolveStorageAckNamespaceTargets(attempt);
    const ctx = createOperationContext('system');
    const backOff = (namespace: string): void => {
      const failures = (this.vmPromotionBackfillBackoff.get(namespace)?.failures ?? 0) + 1;
      this.vmPromotionBackfillBackoff.set(namespace, {
        failures,
        nextAttemptAt: now + Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.min(failures, 16)),
      });
      unresolved += 1;
    };
    for (const namespace of attempt) {
      if (!active()) break;
      const onChainId = targets.get(namespace);
      if (onChainId === undefined) {
        backOff(namespace);
        continue;
      }
      const outcome = await this.awaitTrackedCoreHostRecording(
        this.recordCoreHostedPublicCg(onChainId, namespace, { durable: true, nudge: false }),
      );
      switch (outcome) {
        case 'recorded':
          recorded += 1;
          this.vmPromotionBackfillSettled.add(namespace);
          this.vmPromotionBackfillBackoff.delete(namespace);
          this.log.info(
            ctx,
            `ACK promotion backfill: recorded "${namespace}" (cg=${onChainId}) as core-hosted; ` +
            'the VM reconcile sweep promotes its KAs registered on chain',
          );
          break;
        case 'already-recorded':
          this.vmPromotionBackfillSettled.add(namespace);
          this.vmPromotionBackfillBackoff.delete(namespace);
          break;
        case 'curated':
        case 'invalid-id':
          // Ineligible for good: nothing this core can promote there.
          this.vmPromotionBackfillSettled.add(namespace);
          this.vmPromotionBackfillBackoff.delete(namespace);
          break;
        case 'namespace-conflict':
          // Clears once the other graph is gone from the chain or the member
          // binding settles, so retry; it counts as unresolved meanwhile.
        case 'policy-unknown':
        case 'persist-failed':
        case 'dormant':
        case 'binding-pending':
          backOff(namespace);
          break;
        case 'closed':
        case 'vm-reconcile-disabled':
          return { namespaces: page.length, wrapped, recorded, pending: pending.length, unresolved };
      }
    }
    return {
      namespaces: page.length,
      wrapped,
      recorded,
      pending: pending.length - recorded,
      unresolved,
    };
  }

  /**
   * On-chain id per namespace: the id this core signed its ACKs there for
   * (from the ledger); for grandfathered copies with none, a numeric
   * namespace is its own id and a cleartext one resolves through the
   * finalized authority index (batched, through the shared authority-read
   * governor) or, without an index, local bindings only — never a chain
   * history scan.
   */
  async resolveStorageAckNamespaceTargets(
    this: DKGAgent,
    namespaces: readonly string[],
  ): Promise<Map<string, string>> {
    const resolved = new Map<string, string>();
    const named: string[] = [];
    for (const namespace of namespaces) {
      const result = await this.store.query(
        storageAckNamespaceTargetsQuery(namespace, STORAGE_ACK_TARGETS_PER_NAMESPACE),
        { source: 'agent.storageAckLedger.targets' },
      );
      const signed = result.type === 'bindings'
        ? result.bindings
          .map((row) => (row['target'] === undefined ? '' : stripLiteral(row['target'])))
          .filter(isCanonicalOnChainContextGraphId)
        : [];
      if (signed.length > 0) {
        // One namespace reconciles one graph; any other target there is
        // declined by the gate as a namespace conflict.
        resolved.set(namespace, signed[0]!);
      } else if (isCanonicalOnChainContextGraphId(namespace)) {
        resolved.set(namespace, namespace);
      } else {
        named.push(namespace);
      }
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
          // Unresolved this pass; the namespace backs off.
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
        // Unresolved this pass; the namespace backs off.
      }
    }
    return resolved;
  }

  /**
   * Watchdog over a keyset page of ledgered copies signed before the stall
   * threshold. The page rotates through every copy regardless of age. A copy
   * not in its namespace's VM at its version is classified against the chain
   * (bounded reads per pass and per namespace): registered (or, for an
   * update, landed) copies are marked so retention never drops them, counted
   * as stalled, and promoted with a per-asset VM reconcile; copies the chain
   * does not have are marked on a first observation and stamped chain-absent
   * only on a second one, past the SWM TTL.
   */
  async auditStorageAckCopies(
    this: DKGAgent,
    now: number,
    active: () => boolean,
  ): Promise<{
    examined: number;
    stale: number;
    stalled: number;
    absent: number;
    expired: number;
    superseded: number;
    reconciled: number;
    promoted: number;
  }> {
    const totals = {
      examined: 0, stale: 0, stalled: 0, absent: 0, expired: 0, superseded: 0, reconciled: 0, promoted: 0,
    };
    const pageSize = DKGAgentBase.VM_PROMOTION_AUDIT_PAGE_SIZE;
    const result = await this.store.query(storageAckAuditCandidatesQuery({
      after: this.vmPromotionAuditCursor,
      signedBeforeIso: new Date(now - DKGAgentBase.VM_PROMOTION_STALL_THRESHOLD_MS).toISOString(),
      limit: pageSize,
    }), { source: 'agent.vmPromotionAudit.candidates' });
    const rows = result.type === 'bindings' ? result.bindings : [];
    const ttl = this.config.sharedMemoryTtlMs ?? DEFAULT_SWM_TTL_MS;
    let chainChecks = DKGAgentBase.VM_PROMOTION_AUDIT_MAX_CHAIN_CHECKS;
    const reconcile: Array<{ candidate: StorageAckLedgerCandidate; onChainId: string }> = [];
    const stalledNamespaces = new Map<string, string>();
    // Where the next pass resumes: after the last row this pass fully handled.
    // Stopping at the first row the budget cannot cover (instead of skipping
    // it) keeps the rotation from passing over the same rows every time.
    let resumeAfter = this.vmPromotionAuditCursor;
    let exhausted = false;
    for (const row of rows) {
      if (!active()) {
        exhausted = true;
        break;
      }
      const candidate = parseStorageAckLedgerCandidate(row);
      if (candidate === null) {
        resumeAfter = row['op'] ?? resumeAfter;
        continue;
      }
      if (await this.isStorageAckCopyPromoted(candidate)) {
        totals.examined += 1;
        resumeAfter = candidate.operationSubject;
        continue;
      }
      const onChainId = this.storageAckCopyTarget(candidate);
      if (onChainId !== undefined && (
        reconcile.length >= DKGAgentBase.VM_PROMOTION_AUDIT_MAX_RECONCILES
        || chainChecks <= 0
      )) {
        exhausted = true;
        break;
      }
      totals.examined += 1;
      totals.stale += 1;
      resumeAfter = candidate.operationSubject;
      if (onChainId === undefined) continue;
      // A registered copy is classified again too: a later version may have
      // landed since, and then the copy can never be promoted as-is.
      chainChecks -= 1;
      const classification = await this.classifyStorageAckCopy(candidate, onChainId);
      if (classification === 'landed') {
        if (!candidate.registered) {
          await this.markStorageAckLedger(candidate.operationSubject, LEDGER.registeredAt, now);
        }
        totals.stalled += 1;
        stalledNamespaces.set(candidate.namespace, candidate.kaUal);
        reconcile.push({ candidate, onChainId });
      } else if (classification === 'superseded') {
        await this.markStorageAckLedger(candidate.operationSubject, LEDGER.supersededAt, now);
        totals.superseded += 1;
      } else if (classification === 'absent') {
        totals.absent += 1;
        if (await this.recordStorageAckAbsence(candidate, now, ttl)) totals.expired += 1;
      }
    }
    this.vmPromotionAuditCursor = exhausted || rows.length >= pageSize ? resumeAfter : '';
    for (const { candidate, onChainId } of reconcile) {
      if (!active()) break;
      totals.reconciled += 1;
      if (await this.reconcileStorageAckCopy(candidate, onChainId)) totals.promoted += 1;
    }
    const ctx = createOperationContext('system');
    for (const [namespace, sample] of stalledNamespaces) {
      const scheduling = this.vmReconcileScheduling;
      const retried = scheduling !== undefined && this.isVmReconcileTargetSelected(namespace);
      if (retried) scheduling.triggerPeriodic(namespace);
      this.log.warn(
        ctx,
        `VM promotion watchdog: "${namespace}" has ACKed Knowledge Assets registered on chain but not in VM ` +
        `after ${Math.round(DKGAgentBase.VM_PROMOTION_STALL_THRESHOLD_MS / 60_000)}min (e.g. ${sample}); ` +
        (retried ? 'VM reconcile re-triggered' : 'per-asset promotion attempted'),
      );
    }
    return totals;
  }

  /**
   * Pending-update lane (VM sweep cadence): ledgered update copies that are
   * not in VM at their version are checked against the chain with per-copy
   * backoff, and promoted with a per-asset VM reconcile once the update has
   * landed. The chain reconciler's ordinal walk never revisits an updated
   * asset, so this lane is what carries an ACKed update into VM.
   */
  async runPendingStorageAckUpdates(this: DKGAgent): Promise<void> {
    if (!this.vmPromotionUpdateInFlight) {
      const run: Promise<void> = this.runVmPromotionInBackground(() => this.promotePendingStorageAckUpdates())
        .then(() => undefined)
        .finally(() => {
          if (this.vmPromotionUpdateInFlight === run) this.vmPromotionUpdateInFlight = null;
        });
      this.vmPromotionUpdateInFlight = run;
    }
    await this.vmPromotionUpdateInFlight;
  }

  async promotePendingStorageAckUpdates(
    this: DKGAgent,
    now = Date.now(),
  ): Promise<{ checked: number; promoted: number; superseded: number }> {
    const totals = { checked: 0, promoted: 0, superseded: 0 };
    if (!this.vmPromotionAuditActive()) return totals;
    // Keyset rotation (like the audit): rows that are promoted, backing off or
    // unresolvable are passed over cheaply, so they cannot hold the page.
    const result = await this.store.query(storageAckPendingUpdatesQuery({
      after: this.vmPromotionUpdateCursor,
      signedBeforeIso: new Date(now - PENDING_UPDATE_MIN_AGE_MS).toISOString(),
      limit: DKGAgentBase.VM_PROMOTION_UPDATE_PAGE_SIZE,
    }), { source: 'agent.vmPromotionUpdates.candidates' });
    const rows = result.type === 'bindings' ? result.bindings : [];
    let resumeAfter = this.vmPromotionUpdateCursor;
    let exhausted = false;
    for (const row of rows) {
      if (!this.vmPromotionAuditActive()) {
        exhausted = true;
        break;
      }
      const candidate = parseStorageAckLedgerCandidate(row);
      if (candidate === null) {
        resumeAfter = row['op'] ?? resumeAfter;
        continue;
      }
      const backoff = this.vmPromotionUpdateBackoff.get(candidate.operationSubject);
      if (backoff !== undefined && backoff.nextAttemptAt > now) {
        resumeAfter = candidate.operationSubject;
        continue;
      }
      if (await this.isStorageAckCopyPromoted(candidate)) {
        this.vmPromotionUpdateBackoff.delete(candidate.operationSubject);
        resumeAfter = candidate.operationSubject;
        continue;
      }
      const onChainId = this.storageAckCopyTarget(candidate);
      if (onChainId === undefined) {
        resumeAfter = candidate.operationSubject;
        continue;
      }
      if (totals.checked >= DKGAgentBase.VM_PROMOTION_UPDATE_MAX_CHECKS) {
        exhausted = true;
        break;
      }
      totals.checked += 1;
      resumeAfter = candidate.operationSubject;
      const classification = await this.classifyStorageAckCopy(candidate, onChainId);
      if (classification === 'superseded') {
        await this.markStorageAckLedger(candidate.operationSubject, LEDGER.supersededAt, now);
        this.vmPromotionUpdateBackoff.delete(candidate.operationSubject);
        totals.superseded += 1;
        continue;
      }
      let promoted = false;
      if (classification === 'landed') {
        if (!candidate.registered) {
          await this.markStorageAckLedger(candidate.operationSubject, LEDGER.registeredAt, now);
        }
        promoted = await this.reconcileStorageAckCopy(candidate, onChainId);
      }
      if (promoted) {
        totals.promoted += 1;
        this.vmPromotionUpdateBackoff.delete(candidate.operationSubject);
      } else {
        const failures = (backoff?.failures ?? 0) + 1;
        this.vmPromotionUpdateBackoff.set(candidate.operationSubject, {
          failures,
          nextAttemptAt: now + Math.min(
            DKGAgentBase.VM_PROMOTION_AUDIT_INTERVAL_MS,
            BACKOFF_BASE_MS * 2 ** Math.min(failures - 1, 16),
          ),
        });
      }
    }
    this.vmPromotionUpdateCursor = exhausted || rows.length >= DKGAgentBase.VM_PROMOTION_UPDATE_PAGE_SIZE ? resumeAfter : '';
    return totals;
  }

  async isStorageAckCopyPromoted(this: DKGAgent, candidate: StorageAckLedgerCandidate): Promise<boolean> {
    const result = await this.store.query(
      storageAckPromotedQuery(candidate.namespace, candidate.kaUal, candidate.assertionVersion),
      { source: 'agent.vmPromotionAudit.promoted' },
    );
    return result.type === 'boolean' && result.value;
  }

  /** The on-chain graph a ledgered copy was ACKed for. */
  storageAckCopyTarget(this: DKGAgent, candidate: StorageAckLedgerCandidate): string | undefined {
    if (candidate.contextGraphId !== undefined) return candidate.contextGraphId;
    const sub = this.subscribedContextGraphs.get(candidate.namespace);
    if ((sub?.coreHosted === true || sub?.subscribed === true) && sub.onChainId !== undefined) {
      return sub.onChainId;
    }
    return isCanonicalOnChainContextGraphId(candidate.namespace) ? candidate.namespace : undefined;
  }

  /**
   * Classify one copy against the chain. A publish copy has landed when the
   * asset is registered to the ACKed graph, and is absent only when the chain
   * explicitly answers that the asset is registered nowhere and has no root
   * (or is registered to another graph, which this core's ACK cannot have
   * produced). An update copy has landed when the asset's root count reached
   * its version. Anything unanswered is unknown.
   */
  async classifyStorageAckCopy(
    this: DKGAgent,
    candidate: StorageAckLedgerCandidate,
    onChainId: string,
  ): Promise<CopyClassification> {
    const kaId = knowledgeAssetIdFromUal(candidate.kaUal);
    if (kaId === null) return 'unknown';
    // The copy's operation id commits to its Merkle root; a version that
    // landed with a different root can never be promoted from this copy.
    const copyOperationId = /:(storage-ack-[0-9a-f]{64})$/.exec(candidate.operationSubject)?.[1];
    const landedRootMatches = async (): Promise<boolean> => {
      if (copyOperationId === undefined || typeof this.chain.getLatestMerkleRoot !== 'function') return true;
      const root = await this.chain.getLatestMerkleRoot(kaId);
      return storageAckOperationId(candidate.kaUal, candidate.assertionVersion, root) === copyOperationId;
    };
    const byRootCount = async (rootCount: bigint): Promise<CopyClassification> => {
      if (rootCount === candidate.assertionVersion) {
        return await landedRootMatches() ? 'landed' : 'superseded';
      }
      return rootCount > candidate.assertionVersion ? 'superseded' : 'absent';
    };
    try {
      if (candidate.assertionVersion > 1n) {
        const rootCount = await this.chain.getMerkleRootCount?.(kaId);
        if (typeof rootCount !== 'bigint') return 'unknown';
        return await byRootCount(rootCount);
      }
      const readRegistration = this.chain.getKAContextGraphId;
      if (typeof readRegistration !== 'function') return 'unknown';
      const registeredTo = await readRegistration.call(this.chain, kaId);
      if (registeredTo.toString() === onChainId) {
        const rootCount = await this.chain.getMerkleRootCount?.(kaId);
        return typeof rootCount === 'bigint' ? await byRootCount(rootCount) : 'landed';
      }
      if (registeredTo !== 0n) return 'absent';
      const rootCount = await this.chain.getMerkleRootCount?.(kaId);
      return rootCount === 0n ? 'absent' : 'unknown';
    } catch {
      return 'unknown';
    }
  }

  /**
   * Record one chain-absence observation. The copy is stamped (and may then
   * expire) only on a second observation at least one audit interval after
   * the first, both past the SWM TTL. Returns whether it was stamped.
   */
  async recordStorageAckAbsence(
    this: DKGAgent,
    candidate: StorageAckLedgerCandidate,
    now: number,
    ttl: number,
  ): Promise<boolean> {
    if (ttl <= 0 || candidate.signedAtMs > now - ttl) return false;
    if (
      candidate.absentSeenAtMs === undefined
      || candidate.absentSeenAtMs < candidate.signedAtMs + ttl
    ) {
      await this.markStorageAckLedger(candidate.operationSubject, LEDGER.absentSeenAt, now);
      return false;
    }
    if (now - candidate.absentSeenAtMs < DKGAgentBase.VM_PROMOTION_AUDIT_INTERVAL_MS) return false;
    await this.markStorageAckLedger(candidate.operationSubject, LEDGER.unregisteredAt, now);
    return true;
  }

  /** Set one timestamp on a ledger row in a single store update (no delete-then-insert window). */
  async markStorageAckLedger(this: DKGAgent, operationSubject: string, predicate: string, at: number): Promise<void> {
    if (typeof this.store.update === 'function') {
      await this.store.update(storageAckLedgerMarkUpdate(operationSubject, predicate, new Date(at)), {
        source: 'agent.storageAckLedger.mark',
        touchedGraphs: STORAGE_ACK_LEDGER_TOUCHED_GRAPHS,
      });
      return;
    }
    await this.store.insert([{
      subject: operationSubject,
      predicate,
      object: xsdDateTimeLiteral(new Date(at)),
      graph: STORAGE_ACK_LEDGER_GRAPH,
    }], { source: 'agent.storageAckLedger.mark' });
  }

  /**
   * An update ACK was declined because the version it would replace is not in
   * this core's VM yet. That version is registered on chain (an update needs
   * it), so promote it now with a per-asset reconcile. A publisher is waiting
   * on this (about 31 s of retries on 10.0.18), so it runs in the foreground
   * RPC class at authority admission priority and the normal store lane,
   * ahead of the background catch-up walk. Single-flight per asset, a few at
   * a time, the rest queued.
   */
  promoteStorageAckPriorVersion(this: DKGAgent, request: StorageAckPriorVersionRequest): void {
    if (!this.vmPromotionAuditActive()) return;
    if (!isCanonicalOnChainContextGraphId(request.contextGraphId)) return;
    if (!isStorageAckNamespace(request.swmGraphId)) return;
    if (request.subGraphName !== undefined && !validateSubGraphName(request.subGraphName).valid) return;
    let assertionVersion: bigint;
    try {
      assertionVersion = BigInt(request.assertionVersion);
    } catch {
      return;
    }
    const key = `${request.swmGraphId}\0${request.subGraphName ?? ''}\0${request.kaUal}`;
    if (this.storageAckPriorVersionFlights.has(key) || this.storageAckPriorVersionQueue.has(key)) return;
    if (this.storageAckPriorVersionQueue.size >= PRIOR_VERSION_PROMOTION_QUEUE_MAX) return;
    this.storageAckPriorVersionQueue.set(key, {
      candidate: {
        operationSubject: '',
        namespace: request.swmGraphId,
        kaUal: request.kaUal,
        assertionVersion,
        signedAtMs: Date.now(),
        contextGraphId: request.contextGraphId,
        registered: true,
        ...(request.subGraphName ? { subGraphName: request.subGraphName } : {}),
      },
      onChainId: request.contextGraphId,
    });
    this.drainStorageAckPriorVersionQueue();
  }

  drainStorageAckPriorVersionQueue(this: DKGAgent): void {
    if (!this.vmPromotionAuditActive()) {
      this.storageAckPriorVersionQueue.clear();
      return;
    }
    while (
      this.storageAckPriorVersionFlights.size < PRIOR_VERSION_PROMOTION_CONCURRENCY
      && this.storageAckPriorVersionQueue.size > 0
    ) {
      const [key, next] = this.storageAckPriorVersionQueue.entries().next().value as [
        string,
        { candidate: StorageAckLedgerCandidate; onChainId: string },
      ];
      this.storageAckPriorVersionQueue.delete(key);
      const flight: Promise<unknown> = this.runStorageAckPriorVersionPromotion(
        () => this.reconcileStorageAckCopy(next.candidate, next.onChainId),
      )
        .catch(() => false)
        .finally(() => {
          if (this.storageAckPriorVersionFlights.get(key) === flight) {
            this.storageAckPriorVersionFlights.delete(key);
          }
          this.drainStorageAckPriorVersionQueue();
        });
      this.storageAckPriorVersionFlights.set(key, flight);
    }
  }

  /** The lane a declined update's prior-version promotion runs in (see {@link promoteStorageAckPriorVersion}). */
  runStorageAckPriorVersionPromotion<T>(this: DKGAgent, work: () => Promise<T>): Promise<T> {
    const signal = this.vmReconcileLifecycleController?.signal;
    return withOwnedRpcRequestContext(
      { requestClass: 'foreground', admissionPriority: 'authority', ...(signal ? { signal } : {}) },
      () => withDefaultStoreWorkPriority('normal', work),
    );
  }

  /**
   * The asset's on-chain Merkle-root count, for the handler's decision to
   * release a held ACK copy. An asset registered to no graph has none.
   */
  async readStorageAckKnowledgeAssetRootCount(
    this: DKGAgent,
    kaUal: string,
    signal?: AbortSignal,
  ): Promise<bigint> {
    const kaId = knowledgeAssetIdFromUal(kaUal);
    if (kaId === null) throw new Error(`not a graph-scoped Knowledge Asset UAL: ${kaUal}`);
    const readRegistration = this.chain.getKAContextGraphId;
    const readRootCount = this.chain.getMerkleRootCount;
    if (typeof readRegistration !== 'function' || typeof readRootCount !== 'function') {
      throw new Error('the chain adapter cannot read Knowledge Asset versions');
    }
    return withRpcRequestContext({ admissionPriority: 'authority', ...(signal ? { signal } : {}) }, async () => {
      if (await readRegistration.call(this.chain, kaId) === 0n) return 0n;
      return readRootCount.call(this.chain, kaId);
    });
  }

  /**
   * The SWM namespace an ACK names must belong to the graph it is signed
   * for, or one request could bind another graph's namespace to its own
   * graph (and get that graph's ACKs declined, or its VM written). A numeric
   * namespace must be the graph id itself; a cleartext one must be the
   * graph's committed on-chain name, or, for a graph without one, a local
   * binding to it.
   */
  async checkStorageAckNamespaceBinding(
    this: DKGAgent,
    request: StorageAckVmPromotionRequest,
  ): Promise<StorageAckVmPromotionVerdict | undefined> {
    const namespace = request.swmGraphId;
    const cgId = request.contextGraphId;
    if (namespace === undefined || namespace === '' || namespace === cgId) return undefined;
    if (!isCanonicalOnChainContextGraphId(cgId)) return undefined;
    const disabled = (message: string): StorageAckVmPromotionVerdict => ({
      ok: false,
      code: STORAGE_ACK_DECLINE_CODES.CORE_VM_PROMOTION_DISABLED,
      message,
    });
    if (/^[0-9]+$/.test(namespace)) {
      return disabled(`SWM graph id "${namespace}" names a different context graph than ${cgId}`);
    }
    const bindingKey = `${namespace}\0${cgId}`;
    if (this.storageAckNamespaceBindings.has(bindingKey)) return undefined;
    const row = this.subscribedContextGraphs.get(namespace);
    if (row?.onChainId === cgId && (row.coreHosted === true || row.subscribed === true)) {
      this.storageAckNamespaceBindings.add(bindingKey);
      return undefined;
    }
    let committed: string | null = null;
    const readNameHash = this.chain.getContextGraphNameHash;
    if (typeof readNameHash === 'function') {
      try {
        committed = await withRpcRequestContext(
          { admissionPriority: 'authority' },
          () => readNameHash.call(this.chain, BigInt(cgId)),
        );
      } catch {
        return {
          ok: false,
          code: STORAGE_ACK_DECLINE_CODES.CORE_VM_PROMOTION_UNAVAILABLE,
          message: 'the on-chain name of the context graph could not be read',
        };
      }
    }
    if (typeof committed === 'string') {
      if (committed.toLowerCase() === ethers.keccak256(ethers.toUtf8Bytes(namespace)).toLowerCase()) {
        this.storageAckNamespaceBindings.add(bindingKey);
        return undefined;
      }
      return disabled(`SWM graph id "${namespace}" is not the on-chain name of context graph ${cgId}`);
    }
    let local: string | null = row?.onChainId ?? null;
    if (local === null) {
      local = await this.getContextGraphOnChainId(namespace, {
        source: 'agent.storageAckGate.namespaceBinding',
      }).catch(() => null);
    }
    if (local === cgId) {
      this.storageAckNamespaceBindings.add(bindingKey);
      return undefined;
    }
    if (local !== null) {
      return disabled(`SWM graph id "${namespace}" is bound to context graph ${local} on this core, not ${cgId}`);
    }
    // Nothing contradicts the name yet: a brand-new graph's registration may
    // not be visible here. Retryable, not final.
    return {
      ok: false,
      code: STORAGE_ACK_DECLINE_CODES.CORE_VM_PROMOTION_UNAVAILABLE,
      message: `the on-chain name of context graph ${cgId} cannot be confirmed yet`,
    };
  }

  /**
   * Promote one landed ACK copy with a per-asset VM reconcile in its own
   * namespace, independent of the ordinal walk (which never revisits an
   * updated asset, or an ordinal below its watermark). Returns whether the
   * asset is now in VM at the chain's current version.
   */
  async reconcileStorageAckCopy(
    this: DKGAgent,
    candidate: StorageAckLedgerCandidate,
    onChainId: string,
  ): Promise<boolean> {
    const kaId = knowledgeAssetIdFromUal(candidate.kaUal);
    if (kaId === null || typeof this.chain.getLatestMerkleRoot !== 'function') return false;
    const ctx = createOperationContext('system');
    try {
      const merkleRoot = await this.chain.getLatestMerkleRoot(kaId);
      const publisherAddress = (this.chain.getLatestMerkleRootPublisher
        ? await this.chain.getLatestMerkleRootPublisher(kaId)
        : '') ?? '';
      const versionBlock = typeof this.chain.getBlockNumber === 'function'
        ? await this.chain.getBlockNumber()
        : 0;
      const outcome = await this.getOrCreateFinalizationHandler().handleChainReconciledKC({
        contextGraphId: candidate.namespace,
        onChainCgId: onChainId,
        ual: candidate.kaUal,
        merkleRoot,
        publisherAddress,
        kaId,
        batchId: kaId,
        versionBlock,
        ...(candidate.subGraphName ? { subGraphName: candidate.subGraphName } : {}),
      }, ctx);
      if (outcome === 'promoted' || outcome === 'already-confirmed') {
        await this.store.flush?.({ priority: 'background', source: 'agent.vmPromotionAudit.flush' });
      }
      return outcome === 'promoted' || outcome === 'already-confirmed';
    } catch (err) {
      this.log.warn(
        ctx,
        `VM promotion watchdog: per-asset reconcile of ${candidate.kaUal} in "${candidate.namespace}" failed: ` +
        `${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }
}
