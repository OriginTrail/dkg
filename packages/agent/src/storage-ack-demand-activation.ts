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

import { checkSubscriptionAuthority } from './subscription-authority-check.js';
import { recoverPersistedSubscriptionRow, type SubscriptionRecoveryRowPorts } from './context-graph-subscription-recover-row.js';
import { SubscriptionRetryExecutor, type SubscriptionRetryRow, type SubscriptionRetryLease } from './subscription-retry-executor.js';
import type { ContextGraphDormancyReason } from './context-graph-subscription-dormancy.js';

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

export interface StorageAckDemandActivationPorts extends SubscriptionRecoveryRowPorts {
  readonly signal: AbortSignal;
  track(run: Promise<unknown>): void;
  readonly log: { info(message: string): void; warn(message: string): void; debug(message: string): void };
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
  onChainId: string;
  readonly firstAt: number;
  lastAt: number;
  checks: number;
  retries: number;
  lastWhy: string;
}

/** Request-specific policy over the same bounded queue used by name-binding recovery. */
export class StorageAckDemandActivations {
  readonly #executor: SubscriptionRetryExecutor<Demand>;
  readonly #now: () => number;
  readonly #retryMinMs: number;
  readonly #retryMaxMs: number;
  readonly #idleMs: number;
  readonly #maxMs: number;
  constructor(private readonly ports: StorageAckDemandActivationPorts, options: StorageAckDemandActivationOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#retryMinMs = options.retryMinMs ?? STORAGE_ACK_DEMAND_RETRY_MIN_MS;
    this.#retryMaxMs = options.retryMaxMs ?? STORAGE_ACK_DEMAND_RETRY_MAX_MS;
    this.#idleMs = options.idleMs ?? STORAGE_ACK_DEMAND_IDLE_MS;
    this.#maxMs = options.maxMs ?? STORAGE_ACK_DEMAND_MAX_MS;
    this.#executor = new SubscriptionRetryExecutor({
      recovery: ports.recovery, priority: 2,
      signal: ports.signal, isCurrent: () => ports.isCurrent(), now: this.#now,
      maxRows: options.maxRows ?? STORAGE_ACK_DEMAND_MAX_ROWS,
      maxConcurrent: options.maxConcurrent ?? STORAGE_ACK_DEMAND_MAX_CONCURRENT,
      checkTimeoutMs: options.checkTimeoutMs ?? STORAGE_ACK_DEMAND_CHECK_TIMEOUT_MS,
      track: run => ports.track(run), eligible: row => isStorageAckDemandReason(ports.dormancy(row.id)),
      attempt: (row, lease) => this.#attempt(row, lease),
      retired: (row, expired) => {
        if (expired && this.#executor.current()) ports.log.debug(
          `StorageACK requests no longer hold persisted context-graph subscription "${row.id}" `
          + `(${ports.dormancy(row.id)}, ${row.value.checks} check(s)${row.value.lastWhy ? `, last: ${row.value.lastWhy}` : ''}); it is left to paced activation`);
      },
      failed: (row, error) => {
        if (this.#executor.current()) ports.log.warn(`Could not activate persisted context-graph subscription "${row.id}" `
          + `for StorageACK requests: ${error instanceof Error ? error.message : String(error)}`);
      },
    });
  }

  request(id: string, onChainId: string): boolean {
    if (!this.#executor.current() || !isStorageAckDemandReason(this.ports.dormancy(id))) return false;
    const now = this.#now(), known = this.#executor.get(id);
    if (known) {
      known.value.lastAt = now; known.value.onChainId = onChainId;
      this.#executor.reschedule(row => row.id === id
        ? { expiresAt: Math.min(known.value.firstAt + this.#maxMs, now + this.#idleMs) } : undefined);
      return true;
    }
    return this.#executor.take(id, { onChainId, firstAt: now, lastAt: now, checks: 0, retries: 0, lastWhy: '' },
      now + Math.min(this.#maxMs, this.#idleMs));
  }
  get size(): number { return this.#executor.size; }
  whenIdle(): Promise<void> { return this.#executor.whenIdle(); }

  async #attempt(row: Readonly<SubscriptionRetryRow<Demand>>, lease: SubscriptionRetryLease): Promise<number | undefined> {
    const reason = this.ports.dormancy(row.id);
    if (!isStorageAckDemandReason(reason)) return undefined;
    const demand = row.value, onChainId = demand.onChainId;
    demand.checks += 1;
    const outcome = await recoverPersistedSubscriptionRow(row.id, {
      ...this.ports,
      isCurrent: () => lease.isCurrent() && demand.onChainId === onChainId,
      resolveAuthority: saved => checkSubscriptionAuthority(lease, signal => this.ports.resolveAuthority(saved, signal)),
    }, lease.owner, { reason, verifiedOnChainId: onChainId });
    if (outcome.kind === 'done') return undefined;
    if (outcome.kind === 'activated') {
      this.ports.log.info(`Activated persisted context-graph subscription "${row.id}" for StorageACK requests `
        + `${this.#now() - demand.firstAt} ms after the first (was ${reason}; ${demand.checks} check(s))`);
      return undefined;
    }
    if (outcome.kind === 'again') return this.#now() + this.#retryMinMs;
    demand.lastWhy = outcome.kind === 'activation-failed'
      ? outcome.error instanceof Error ? outcome.error.message : String(outcome.error)
      : `${outcome.authority.outcome} by ${outcome.authority.source} (${outcome.authority.reason})`;
    return this.#now() + Math.min(this.#retryMaxMs, this.#retryMinMs * 2 ** Math.min(demand.retries++, 16));
  }
}

const owners = new WeakMap<object, { signal: AbortSignal; activations: StorageAckDemandActivations }>();

/** The caller supplies compiler-checked ports from the agent's protected boundary. */
export function requestStorageAckDemandActivation(
  ownerKey: object, ports: StorageAckDemandActivationPorts, contextGraphId: string, onChainId: string,
): boolean {
  if (ports.signal.aborted || !ports.isCurrent()) return false;
  let canonical: bigint;
  try { canonical = BigInt(onChainId); } catch { return false; }
  if (canonical <= 0n) return false;
  let owner = owners.get(ownerKey);
  if (owner === undefined || owner.signal !== ports.signal) {
    owner = { signal: ports.signal, activations: new StorageAckDemandActivations(ports) };
    owners.set(ownerKey, owner);
  }
  return owner.activations.request(contextGraphId, canonical.toString());
}

/** The agent's demand activations of this run, if any started (for tests and status). */
export function peekStorageAckDemandActivations(ownerKey: object): StorageAckDemandActivations | undefined {
  return owners.get(ownerKey)?.activations;
}
