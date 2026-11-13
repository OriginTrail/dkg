// SPDX-License-Identifier: Apache-2.0

/**
 * Bring back at once a saved subscription row that StorageACK requests find
 * dormant.
 *
 * After a restart a core leaves most saved rows dormant. The activation cap
 * brings a few back and paces checks of the rest, and a row whose read
 * authority the startup budget could not read waits for background recovery.
 * The StorageACK gate declines a graph while its row is dormant, so a
 * publisher writing to one of those graphs was refused until the backlog
 * reached it. On testnet that took longer than a worker lived: the paced check
 * of a new graph waited 120 s on a name lookup while the authority index
 * caught up, then the row waited behind hundreds of others in recovery.
 *
 * The request names the graph's on-chain id, and the gate has checked that id
 * against the name the graph committed on chain. That is the binding the name
 * lookup is for. So the row is checked and activated now, on its own, with
 * that binding: the same read-authority check (current policy and roster) and
 * the same activation transaction as the paced owners, without their pause,
 * their slot limit or the name lookup. A row whose saved binding names
 * another id is left to them.
 *
 * Bounds: one check per row at a time and two checks at a time, for at most
 * 32 rows. A check that finds authority unavailable is tried again after a
 * growing pause while requests keep coming, for at most ten minutes (the
 * gate's transient window); a row that waits out a pause holds no check slot,
 * so it cannot hold up the next graph. A row whose requests stop is left to
 * the paced owners, as before.
 */

import { createOperationContext, type OperationContext } from '@origintrail-official/dkg-core';
import { withOwnedRpcRequestContext } from '@origintrail-official/dkg-chain';
import type { AgentWorkLifetime } from './agent-work-lifetime.js';
import {
  activateRollingSubscriptionPromotion,
  type RollingSubscriptionActivationPorts,
} from './context-graph-subscription-authority-recovery.js';
import {
  unavailableContextGraphReadAuthorityDecision,
  contextGraphReadAuthorityDependencyOf,
  type ContextGraphReadAuthorityDecision,
} from './context-graph-read-authority.js';
import {
  contextGraphDormancyAfterAuthority,
  type ContextGraphDormancyReason,
} from './context-graph-subscription-dormancy.js';
import type {
  ContextGraphSub,
  ContextGraphSubscriptionRecord,
  ContextGraphSubscriptionRehydrationInternalStatus,
  ContextGraphSubscriptionStore,
  DurableContextGraphSubscriptionBinding,
} from './dkg-agent-types.js';

/** Checks (and activations) in flight at the same time. */
export const STORAGE_ACK_DEMAND_MAX_CONCURRENT = 2;
/** Rows held at once; past this, requests fall back to the paced owners. */
export const STORAGE_ACK_DEMAND_MAX_ROWS = 32;
export const STORAGE_ACK_DEMAND_RETRY_MIN_MS = 1_000;
export const STORAGE_ACK_DEMAND_RETRY_MAX_MS = 10_000;
/** No request reached the row for this long: it is left to the paced owners. */
export const STORAGE_ACK_DEMAND_IDLE_MS = 2 * 60_000;
/** Longest one run of requests keeps a row checked (the gate's transient window). */
export const STORAGE_ACK_DEMAND_MAX_MS = 10 * 60_000;
/** One check's own deadline. */
export const STORAGE_ACK_DEMAND_CHECK_TIMEOUT_MS = 30_000;

type DemandReason = Extract<ContextGraphDormancyReason, 'activationCap' | 'authorityUnavailable'>;

/** Dormancy that clears on its own, which a request may hurry along. */
export function isStorageAckDemandReason(
  reason: ContextGraphDormancyReason | undefined,
): reason is DemandReason {
  return reason === 'activationCap' || reason === 'authorityUnavailable';
}

export interface StorageAckDemandActivationPorts {
  /** Aborts when the node stops. */
  readonly signal: AbortSignal;
  /** This node run still owns subscription state. */
  isCurrent(): boolean;
  dormancy(contextGraphId: string): ContextGraphDormancyReason | undefined;
  revision(contextGraphId: string): number;
  subscription(contextGraphId: string): ContextGraphSub | undefined;
  load(contextGraphId: string): Promise<ContextGraphSubscriptionRecord | null>;
  resolveAuthority(
    binding: Readonly<DurableContextGraphSubscriptionBinding>,
    signal: AbortSignal,
  ): Promise<ContextGraphReadAuthorityDecision>;
  activate(
    row: ContextGraphSubscriptionRecord,
    onChainId: string,
    isCurrent: (subscription: ContextGraphSub) => boolean,
  ): Promise<void>;
  /** Record the dormancy a final answer leaves the row in. */
  retire(contextGraphId: string, reason: ContextGraphDormancyReason): void;
  track(run: Promise<unknown>): void;
  readonly log: {
    info(message: string): void;
    warn(message: string): void;
    debug(message: string): void;
  };
}

export interface StorageAckDemandActivationOptions {
  readonly maxConcurrent?: number;
  readonly maxRows?: number;
  readonly retryMinMs?: number;
  readonly retryMaxMs?: number;
  readonly idleMs?: number;
  readonly maxMs?: number;
  readonly checkTimeoutMs?: number;
  readonly now?: () => number;
}

interface Demand {
  readonly contextGraphId: string;
  onChainId: string;
  readonly firstAt: number;
  lastAt: number;
}

type AttemptOutcome =
  | { kind: 'activated'; reason: DemandReason }
  /** Authority unavailable, or the activation failed: try again after a growing pause. */
  | { kind: 'retry'; why: string }
  /** The row or its state moved under the check. */
  | { kind: 'again' }
  | { kind: 'done' };

function sameRow(
  left: ContextGraphSubscriptionRecord,
  right: ContextGraphSubscriptionRecord | null,
): boolean {
  return right !== null
    && left.id === right.id
    && left.onChainId === right.onChainId
    && left.onChainHash === right.onChainHash
    && left.subscribed === right.subscribed
    && (left.coreHosted === true) === (right.coreHosted === true);
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    timer.unref?.();
    signal.addEventListener('abort', done, { once: true });
  });
}

/** Demand activations of one node run. */
export class StorageAckDemandActivations {
  readonly #ports: StorageAckDemandActivationPorts;
  readonly #maxConcurrent: number;
  readonly #maxRows: number;
  readonly #retryMinMs: number;
  readonly #retryMaxMs: number;
  readonly #idleMs: number;
  readonly #maxMs: number;
  readonly #checkTimeoutMs: number;
  readonly #now: () => number;
  /** Rows a demand activation holds, checking or pausing. */
  readonly #rows = new Map<string, Demand>();
  readonly #runs = new Set<Promise<void>>();
  /** Check slots in use, and the rows waiting for one, first come first served. */
  #checking = 0;
  readonly #waiting: Array<() => void> = [];

  constructor(ports: StorageAckDemandActivationPorts, options: StorageAckDemandActivationOptions = {}) {
    this.#ports = ports;
    this.#maxConcurrent = options.maxConcurrent ?? STORAGE_ACK_DEMAND_MAX_CONCURRENT;
    this.#maxRows = options.maxRows ?? STORAGE_ACK_DEMAND_MAX_ROWS;
    this.#retryMinMs = options.retryMinMs ?? STORAGE_ACK_DEMAND_RETRY_MIN_MS;
    this.#retryMaxMs = options.retryMaxMs ?? STORAGE_ACK_DEMAND_RETRY_MAX_MS;
    this.#idleMs = options.idleMs ?? STORAGE_ACK_DEMAND_IDLE_MS;
    this.#maxMs = options.maxMs ?? STORAGE_ACK_DEMAND_MAX_MS;
    this.#checkTimeoutMs = options.checkTimeoutMs ?? STORAGE_ACK_DEMAND_CHECK_TIMEOUT_MS;
    this.#now = options.now ?? Date.now;
  }

  /**
   * A StorageACK request for `onChainId` found the saved row of
   * `contextGraphId` dormant. True when a demand activation now owns the row;
   * false leaves it to the paced owners.
   */
  request(contextGraphId: string, onChainId: string): boolean {
    const ports = this.#ports;
    if (ports.signal.aborted || !ports.isCurrent()) return false;
    if (!isStorageAckDemandReason(ports.dormancy(contextGraphId))) return false;
    const now = this.#now();
    const known = this.#rows.get(contextGraphId);
    if (known !== undefined) {
      known.lastAt = now;
      known.onChainId = onChainId;
      return true;
    }
    if (this.#rows.size >= this.#maxRows) return false;
    this.#start({ contextGraphId, onChainId, firstAt: now, lastAt: now });
    return true;
  }

  /** Rows a demand activation holds now, checking, waiting or pausing. */
  get size(): number {
    return this.#rows.size;
  }

  /** Settles when no demand activation runs. */
  async whenIdle(): Promise<void> {
    while (this.#runs.size > 0) await Promise.allSettled(this.#runs);
  }

  #start(demand: Demand): void {
    this.#rows.set(demand.contextGraphId, demand);
    const run: Promise<void> = this.#run(demand)
      .catch((error: unknown) => {
        if (this.#ports.signal.aborted) return;
        this.#ports.log.warn(
          `Could not activate persisted context-graph subscription "${demand.contextGraphId}" ` +
          `for StorageACK requests: ${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(() => {
        this.#rows.delete(demand.contextGraphId);
        this.#runs.delete(run);
      });
    this.#runs.add(run);
    this.#ports.track(run);
  }

  /** Take a check slot; false when the node stops first. */
  #acquire(signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false);
    if (this.#checking < this.#maxConcurrent) {
      this.#checking += 1;
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const grant = (): void => {
        signal.removeEventListener('abort', cancel);
        resolve(true);
      };
      const cancel = (): void => {
        const index = this.#waiting.indexOf(grant);
        if (index >= 0) this.#waiting.splice(index, 1);
        resolve(false);
      };
      this.#waiting.push(grant);
      signal.addEventListener('abort', cancel, { once: true });
    });
  }

  /** Hand the slot to the next row waiting for one, if any. */
  #release(): void {
    const next = this.#waiting.shift();
    if (next !== undefined) next();
    else this.#checking -= 1;
  }

  #current(): boolean {
    return !this.#ports.signal.aborted && this.#ports.isCurrent();
  }

  async #run(demand: Demand): Promise<void> {
    const ports = this.#ports;
    const id = demand.contextGraphId;
    let checks = 0;
    let retries = 0;
    let lastWhy = '';
    for (;;) {
      if (!this.#current()) return;
      const reason = ports.dormancy(id);
      // Active again, or an owner gave a final answer meanwhile.
      if (!isStorageAckDemandReason(reason)) return;
      const now = this.#now();
      if (now - demand.lastAt >= this.#idleMs || now - demand.firstAt >= this.#maxMs) {
        ports.log.debug(
          `StorageACK requests no longer hold persisted context-graph subscription "${id}" ` +
          `(${reason}, ${checks} check(s)${lastWhy ? `, last: ${lastWhy}` : ''}); it is left to paced activation`,
        );
        return;
      }
      if (!(await this.#acquire(ports.signal))) return;
      let outcome: AttemptOutcome;
      try {
        // Waiting for the slot may have taken a while.
        const current = ports.dormancy(id);
        if (!this.#current() || !isStorageAckDemandReason(current)) {
          outcome = { kind: 'done' };
        } else {
          checks += 1;
          outcome = await this.#attempt(demand, current);
        }
      } finally {
        this.#release();
      }
      if (outcome.kind === 'done') return;
      if (outcome.kind === 'activated') {
        ports.log.info(
          `Activated persisted context-graph subscription "${id}" for StorageACK requests ` +
          `${this.#now() - demand.firstAt} ms after the first (was ${outcome.reason}; ${checks} check(s))`,
        );
        return;
      }
      // The row moved under the check, or another owner is installing it:
      // look again shortly, without growing the pause.
      if (outcome.kind === 'again') {
        await pause(this.#retryMinMs, ports.signal);
        continue;
      }
      lastWhy = outcome.why;
      const waitMs = Math.min(this.#retryMaxMs, this.#retryMinMs * 2 ** Math.min(retries, 16));
      retries += 1;
      await pause(waitMs, ports.signal);
    }
  }

  async #attempt(demand: Demand, reason: DemandReason): Promise<AttemptOutcome> {
    const ports = this.#ports;
    const id = demand.contextGraphId;
    const row = await ports.load(id);
    if (!this.#current()) return { kind: 'done' };
    // No saved intent: the owners clear the row.
    if (row === null || (!row.subscribed && row.coreHosted !== true)) return { kind: 'done' };
    if (row.onChainId !== undefined && row.onChainId !== demand.onChainId) {
      ports.log.debug(
        `Persisted context-graph subscription "${id}" is bound to ${row.onChainId}, ` +
        `not to ${demand.onChainId} as a StorageACK request names; it is left to paced activation`,
      );
      return { kind: 'done' };
    }
    const revision = ports.revision(id);
    const binding: DurableContextGraphSubscriptionBinding = {
      contextGraphId: row.id,
      onChainId: row.onChainId ?? demand.onChainId,
      ...(row.onChainHash === undefined ? {} : { onChainHash: row.onChainHash }),
    };
    const checkSignal = AbortSignal.any([ports.signal, AbortSignal.timeout(this.#checkTimeoutMs)]);
    const authority = await ports.resolveAuthority(binding, checkSignal).catch((error: unknown) => (
      unavailableContextGraphReadAuthorityDecision(
        'legacy-local',
        'unexpected-authority-error',
        contextGraphReadAuthorityDependencyOf(error),
      )
    ));
    if (!this.#current()) return { kind: 'done' };
    // The answer belongs to the row as it was read; if it moved, decide again.
    const fresh = await ports.load(id);
    if (!this.#current()) return { kind: 'done' };
    if (
      ports.dormancy(id) !== reason
      || ports.revision(id) !== revision
      || !sameRow(row, fresh)
    ) return { kind: 'again' };
    const live = ports.subscription(id);
    if (live?.subscribed === true || live?.coreHosted === true) return { kind: 'again' };
    if (authority.outcome !== 'allowed') {
      const next = contextGraphDormancyAfterAuthority(authority);
      if (next === 'authorityUnavailable') {
        return { kind: 'retry', why: `${authority.outcome} by ${authority.source} (${authority.reason})` };
      }
      ports.retire(id, next);
      ports.log.info(
        `Left persisted context-graph subscription "${id}" dormant for StorageACK requests: ` +
        `${authority.outcome} by ${authority.source} (${authority.reason})`,
      );
      return { kind: 'done' };
    }
    const onChainId = authority.onChainId?.toString() ?? binding.onChainId!;
    const isCurrentActivation = (subscription: ContextGraphSub): boolean => (
      this.#current()
      && ports.dormancy(id) === reason
      && ports.revision(id) === revision
      && ports.subscription(id) === subscription
    );
    try {
      await ports.activate(fresh!, onChainId, isCurrentActivation);
    } catch (error) {
      if (!this.#current()) return { kind: 'done' };
      // Another owner may be activating the same row; the next turn sees it.
      return { kind: 'retry', why: error instanceof Error ? error.message : String(error) };
    }
    return { kind: 'activated', reason };
  }
}

interface DemandActivationAgent {
  readonly config: {
    readonly contextGraphSubscriptionStore?: Pick<ContextGraphSubscriptionStore, 'load' | 'loadAll'>;
  };
  readonly workLifetime: AgentWorkLifetime;
  readonly coreHostRecordingsClosed: boolean;
  contextGraphSubscriptionRehydrationStatus: ContextGraphSubscriptionRehydrationInternalStatus | null;
  readonly contextGraphSubscriptionDormancyById: ReadonlyMap<string, ContextGraphDormancyReason>;
  readonly contextGraphSubscriptionPersistRevisions: ReadonlyMap<string, number>;
  readonly subscribedContextGraphs: ReadonlyMap<string, ContextGraphSub>;
  readonly log: {
    info(ctx: OperationContext, message: string): void;
    warn(ctx: OperationContext, message: string): void;
    debug(ctx: OperationContext, message: string): void;
  };
  resolveContextGraphSubscriptionBootstrapAuthority(
    contextGraphId: string,
    options: {
      allowSubscriptionFallback?: boolean;
      signal?: AbortSignal;
      durableSubscriptionBinding?: Readonly<DurableContextGraphSubscriptionBinding>;
    },
  ): Promise<ContextGraphReadAuthorityDecision>;
  activatePersistedContextGraphSubscriptionRecord: RollingSubscriptionActivationPorts['activate'];
  reconcileRfc64CatalogResponsibilityV1(contextGraphId: string): Promise<unknown>;
  transitionContextGraphSubscriptionDormancy(
    contextGraphId: string,
    reason: ContextGraphDormancyReason | undefined,
  ): void;
}

const owners = new WeakMap<object, { signal: AbortSignal; activations: StorageAckDemandActivations }>();

function demandActivationPorts(agent: DemandActivationAgent, signal: AbortSignal): StorageAckDemandActivationPorts {
  const ctx = createOperationContext('init');
  const store = agent.config.contextGraphSubscriptionStore!;
  // Requests come from an ACK handler: its deadline must not end the check.
  const owned = <T>(fn: () => Promise<T>): Promise<T> => withOwnedRpcRequestContext(
    { requestClass: 'foreground', admissionPriority: 'authority', signal },
    fn,
  );
  return {
    signal,
    isCurrent: () => agent.workLifetime.signal === signal
      && agent.contextGraphSubscriptionRehydrationStatus !== null
      && !agent.coreHostRecordingsClosed,
    dormancy: (id) => agent.contextGraphSubscriptionDormancyById.get(id),
    revision: (id) => agent.contextGraphSubscriptionPersistRevisions.get(id) ?? 0,
    subscription: (id) => agent.subscribedContextGraphs.get(id),
    load: async (id) => (store.load
      ? store.load(id)
      : (await store.loadAll()).find((row) => row.id === id) ?? null),
    resolveAuthority: (binding, checkSignal) => owned(() => (
      agent.resolveContextGraphSubscriptionBootstrapAuthority(binding.contextGraphId, {
        allowSubscriptionFallback: false,
        signal: checkSignal,
        durableSubscriptionBinding: binding,
      })
    )),
    activate: (row, onChainId, isCurrent) => owned(() => activateRollingSubscriptionPromotion({
      activate: agent.activatePersistedContextGraphSubscriptionRecord.bind(agent),
      reconcile: agent.reconcileRfc64CatalogResponsibilityV1.bind(agent),
    }, row, onChainId, isCurrent)),
    retire: (id, reason) => {
      agent.transitionContextGraphSubscriptionDormancy(id, reason);
      const status = agent.contextGraphSubscriptionRehydrationStatus;
      if (status !== null) agent.contextGraphSubscriptionRehydrationStatus = { ...status, updatedAt: Date.now() };
    },
    track: (run) => { agent.workLifetime.track(run); },
    log: {
      info: (message) => agent.log.info(ctx, message),
      warn: (message) => agent.log.warn(ctx, message),
      debug: (message) => agent.log.debug(ctx, message),
    },
  };
}

/**
 * Activate now the dormant saved row of `contextGraphId`, which a StorageACK
 * request for the on-chain graph `onChainId` found. The caller has checked
 * that the namespace names that graph on chain. False leaves the row to the
 * paced owners.
 */
export function requestStorageAckDemandActivation(
  agentObject: object,
  contextGraphId: string,
  onChainId: string,
): boolean {
  const agent = agentObject as DemandActivationAgent;
  const lifetime = agent.workLifetime;
  if (lifetime.closed || agent.config.contextGraphSubscriptionStore === undefined) return false;
  let canonical: bigint;
  try {
    canonical = BigInt(onChainId);
  } catch {
    return false;
  }
  if (canonical <= 0n) return false;
  let owner = owners.get(agentObject);
  if (owner === undefined || owner.signal !== lifetime.signal) {
    owner = {
      signal: lifetime.signal,
      activations: new StorageAckDemandActivations(demandActivationPorts(agent, lifetime.signal)),
    };
    owners.set(agentObject, owner);
  }
  return owner.activations.request(contextGraphId, canonical.toString());
}

/** The agent's demand activations of this run, if any started (for tests and status). */
export function peekStorageAckDemandActivations(agentObject: object): StorageAckDemandActivations | undefined {
  return owners.get(agentObject)?.activations;
}
