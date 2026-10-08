// SPDX-License-Identifier: Apache-2.0

/**
 * Why a Knowledge Asset version snapshot could not be established.
 *
 * `readKnowledgeAssetVersionSnapshot` answers `null` unless EVERY configured
 * endpoint produces a complete view at one pinned block: the endpoint that did
 * not answer may be the one that is ahead, so a partial poll must not decide
 * which version is current. This module does not touch that rule. It keeps
 * what the `null` used to drop: which endpoint contributed no view, at which
 * step of its read, and a closed class for why.
 *
 * The same three invariants as the failover log (rpc-failover-log.ts):
 *
 *  1. Host only. A configured RPC URL can carry a key in its path or query, and
 *     ethers embeds the request URL in the message of an HTTP-level error. So
 *     an endpoint is named by its position in the configured list and its
 *     host, and a cause by a closed class: never the URL, never error text.
 *  2. Observation only. The trace wraps the per-endpoint read and passes its
 *     answer, or its error, through as it is. Nothing recorded here is read by
 *     the decision.
 *  3. Never throwing. It sits on the read's result path, including the
 *     caller's callback.
 */

import type { ChainReadOptions } from './chain-adapter.js';
import { errorCode, errorStatus } from './evm-adapter-errors.js';
import { classifyRpcFailoverError, rpcHost } from './rpc-failover-log.js';

/** The step of one endpoint's read that produced no answer. */
export type KnowledgeAssetVersionSnapshotReadStage =
  | 'chain-id'
  | 'head-block'
  | 'pinned-block'
  | 'pinned-read'
  | 'storage-binding';

/** Why one endpoint contributed no view. Closed: never the provider's own words. */
export type KnowledgeAssetVersionSnapshotEndpointFailureClass =
  | 'http-client-error'
  | 'http-throttled'
  | 'http-server-error'
  | 'timeout'
  | 'network'
  | 'call-exception'
  | 'wrong-chain'
  | 'incomplete-view'
  | 'binding-changed'
  | 'no-answer'
  | 'other';

export interface KnowledgeAssetVersionSnapshotEndpointFailure {
  /** 1-based position in the configured endpoint list. */
  readonly position: number;
  /** Host only. */
  readonly host: string;
  readonly stage: KnowledgeAssetVersionSnapshotReadStage;
  readonly failure: KnowledgeAssetVersionSnapshotEndpointFailureClass;
  /** The HTTP status the endpoint answered with, when it answered with one. */
  readonly httpStatus?: number;
}

export type KnowledgeAssetVersionSnapshotUnavailableReason =
  /** At least one endpoint contributed no complete view; `endpoints` names each. */
  | 'endpoints-failed'
  /** The caller's signal ended the read; `endpoints` names those without a view by then. */
  | 'aborted'
  /** Every endpoint answered, with different block hashes at the same height. */
  | 'endpoints-disagree'
  /** The storage contract binding changed while the views were read. */
  | 'storage-binding-changed'
  /** No endpoint was asked: the storage contract is not resolved. */
  | 'no-storage-contract';

export interface KnowledgeAssetVersionSnapshotUnavailable {
  readonly reason: KnowledgeAssetVersionSnapshotUnavailableReason;
  /** Configured endpoints. The rule needs a complete view from every one. */
  readonly endpointCount: number;
  readonly endpoints: readonly KnowledgeAssetVersionSnapshotEndpointFailure[];
}

/** Read options for `ChainAdapter.readKnowledgeAssetVersionSnapshot`. */
export interface KnowledgeAssetVersionSnapshotReadOptions extends ChainReadOptions {
  /**
   * Called once, before the read answers `null`, with why no view could be
   * established. Diagnostic only: an adapter is free never to call it, and a
   * caller must not decide anything from it.
   */
  onUnavailable?(report: KnowledgeAssetVersionSnapshotUnavailable): void;
}

type EndpointCause = Pick<KnowledgeAssetVersionSnapshotEndpointFailure, 'failure' | 'httpStatus'>;

/** Reduce an endpoint's thrown error to a closed class. HTTP status first: it is the endpoint's own answer. */
export function classifyKnowledgeAssetVersionSnapshotEndpointError(err: unknown): EndpointCause {
  try {
    const status = errorStatus(err);
    if (status !== undefined && Number.isInteger(status) && status >= 100 && status <= 599) {
      if (status === 429) return { failure: 'http-throttled', httpStatus: status };
      if (status >= 500) return { failure: 'http-server-error', httpStatus: status };
      if (status >= 400) return { failure: 'http-client-error', httpStatus: status };
      return { failure: 'other', httpStatus: status };
    }
    const code = errorCode(err);
    // ethers reports any JSON-RPC error answer to an `eth_call` as a call exception.
    if (code === 'CALL_EXCEPTION') return { failure: 'call-exception' };
    if (code === 'BAD_DATA') return { failure: 'incomplete-view' };
    switch (classifyRpcFailoverError(err)) {
      case 'THROTTLE_429': return { failure: 'http-throttled' };
      case 'SERVER_5XX': return { failure: 'http-server-error' };
      case 'TIMEOUT': return { failure: 'timeout' };
      case 'NETWORK': return { failure: 'network' };
      default: return { failure: 'other' };
    }
  } catch {
    return { failure: 'other' };
  }
}

interface EndpointSlot {
  stage: KnowledgeAssetVersionSnapshotReadStage;
  /** How the endpoint's latest attempt ended. Unset while one is in flight. */
  outcome?: 'view' | EndpointCause;
}

/**
 * One read's record of what each endpoint did. The adapter wraps its
 * per-endpoint read in {@link observe} and returns through {@link established}
 * or {@link unavailable}; both hand back exactly the value the read would have
 * returned without the trace.
 */
export class KnowledgeAssetVersionSnapshotTrace<TProvider> {
  readonly #providers: readonly TProvider[];
  readonly #rpcUrls: readonly string[];
  readonly #options: KnowledgeAssetVersionSnapshotReadOptions;
  readonly #slots = new Map<TProvider, EndpointSlot>();

  constructor(
    providers: readonly TProvider[],
    rpcUrls: readonly string[],
    options: KnowledgeAssetVersionSnapshotReadOptions,
  ) {
    this.#providers = providers;
    this.#rpcUrls = rpcUrls;
    this.#options = options;
  }

  /**
   * The per-endpoint read, observed. `readOne` names each step it enters through
   * `step`. A transient failure is retried in place, so each attempt starts a
   * new record and the last one stands.
   */
  observe<TView>(
    readOne: (
      provider: TProvider,
      step: (stage: KnowledgeAssetVersionSnapshotReadStage) => void,
    ) => Promise<TView | null>,
  ): (provider: TProvider) => Promise<TView | null> {
    return async (provider) => {
      const slot: EndpointSlot = { stage: 'chain-id' };
      this.#slots.set(provider, slot);
      try {
        const view = await readOne(provider, (stage) => { slot.stage = stage; });
        slot.outcome = view === null ? this.#withoutView(slot.stage) : 'view';
        return view;
      } catch (error) {
        slot.outcome = this.#options.signal?.aborted
          ? { failure: 'no-answer' }
          : classifyKnowledgeAssetVersionSnapshotEndpointError(error);
        throw error;
      }
    };
  }

  /** The read established `view`. Returns it. */
  established<TView>(view: TView): TView {
    noteEstablished(() => this.#endpointKeys());
    return view;
  }

  /** The read could not establish a view, for `reason`. Returns the read's `null`. */
  unavailable(reason: KnowledgeAssetVersionSnapshotUnavailableReason): null {
    try {
      const endpointCount = this.#providers.length;
      const endpoints: KnowledgeAssetVersionSnapshotEndpointFailure[] = [];
      const answered: string[] = [];
      this.#providers.forEach((provider, index) => {
        const slot = this.#slots.get(provider);
        const position = index + 1;
        const host = rpcHost(this.#rpcUrls[index]!);
        if (slot === undefined) return;
        if (slot.outcome === 'view') {
          answered.push(endpointKey(position, endpointCount, host));
          return;
        }
        // No outcome: the read ended while this endpoint's attempt was in flight.
        endpoints.push({ position, host, stage: slot.stage, ...(slot.outcome ?? { failure: 'no-answer' }) });
      });
      const report: KnowledgeAssetVersionSnapshotUnavailable = { reason, endpointCount, endpoints };
      // A cancelled read enters the process-wide record only when it singles endpoints out.
      // One that ends with every endpoint still in flight says nothing about any of them,
      // and would leave healthy endpoints listed until the next read.
      if (reason !== 'aborted' || (endpoints.length > 0 && answered.length > 0)) {
        noteUnavailable(report, answered);
      }
      this.#options.onUnavailable?.(report);
    } catch {
      // Observability must never change what the read answers.
    }
    return null;
  }

  /** Why an endpoint that returned no view did so, from the step it was in. */
  #withoutView(stage: KnowledgeAssetVersionSnapshotReadStage): EndpointCause {
    if (this.#options.signal?.aborted) return { failure: 'no-answer' };
    if (stage === 'chain-id') return { failure: 'wrong-chain' };
    if (stage === 'storage-binding') return { failure: 'binding-changed' };
    return { failure: 'incomplete-view' };
  }

  #endpointKeys(): string[] {
    return this.#providers.map(
      (_, index) => endpointKey(index + 1, this.#providers.length, rpcHost(this.#rpcUrls[index]!)),
    );
  }
}

// --- Wording (host only) -----------------------------------------------------

const READ_NAME: Record<KnowledgeAssetVersionSnapshotReadStage, string> = {
  'chain-id': 'the chain id read',
  'head-block': 'the head block read',
  'pinned-block': 'the pinned block header read',
  'pinned-read': 'a block-pinned read',
  'storage-binding': 'a block-pinned read',
};

/** One endpoint's failure in words, e.g. `endpoint 3 of 5 (host) refused a block-pinned read (http 400)`. */
export function describeKnowledgeAssetVersionSnapshotEndpointFailure(
  endpoint: KnowledgeAssetVersionSnapshotEndpointFailure,
  endpointCount: number,
): string {
  const who = `endpoint ${endpoint.position} of ${endpointCount} (${endpoint.host})`;
  const read = READ_NAME[endpoint.stage];
  const http = endpoint.httpStatus === undefined ? undefined : `http ${endpoint.httpStatus}`;
  switch (endpoint.failure) {
    case 'http-client-error': return `${who} refused ${read} (${http ?? 'client error'})`;
    case 'http-throttled': return `${who} throttled ${read} (${http ?? 'rate limited'})`;
    case 'http-server-error': return `${who} failed ${read} (${http ?? 'server error'})`;
    case 'timeout': return `${who} timed out on ${read}`;
    case 'network': return `${who} could not be reached for ${read}`;
    case 'call-exception': return `${who} rejected ${read} (call exception)`;
    case 'wrong-chain': return `${who} answered for a different chain`;
    case 'incomplete-view': return `${who} returned an incomplete answer to ${read}`;
    case 'binding-changed': return `${who} was read while the storage contract binding changed`;
    case 'no-answer': return `${who} had not answered ${read} when the read was cancelled`;
    default: return `${who} failed ${read} (${http ?? 'unclassified error'})`;
  }
}

/** Why no view could be established, in words. Names every endpoint that contributed none. */
export function describeKnowledgeAssetVersionSnapshotUnavailable(
  report: KnowledgeAssetVersionSnapshotUnavailable,
): string {
  if (report.endpoints.length > 0) {
    return report.endpoints
      .map((endpoint) => describeKnowledgeAssetVersionSnapshotEndpointFailure(endpoint, report.endpointCount))
      .join('; ');
  }
  switch (report.reason) {
    case 'aborted': return 'the read was cancelled before it completed';
    case 'endpoints-disagree':
      return `the ${report.endpointCount} endpoints returned different block hashes at the same height`;
    case 'storage-binding-changed': return 'the storage contract binding changed during the read';
    case 'no-storage-contract': return 'the knowledge asset storage contract is not resolved';
    default: return 'not every endpoint returned a complete view';
  }
}

// --- Process-wide record (host only) -----------------------------------------

/** One endpoint whose latest pinned read contributed no view. */
export interface KnowledgeAssetVersionSnapshotFailingEndpoint
  extends KnowledgeAssetVersionSnapshotEndpointFailure {
  readonly endpointCount: number;
  /** Reads in a row that ended this way for this endpoint. */
  readonly consecutive: number;
  /** Epoch ms of the first and the latest of them. */
  readonly since: number;
  readonly last: number;
}

/** Snapshot for `/api/status`: host only, plain JSON. */
export interface KnowledgeAssetVersionSnapshotHealth {
  /**
   * Reads that established a view, and reads that could not, since start. A read its caller
   * cancelled counts as one that could not only when it left some endpoint waiting while
   * another had answered.
   */
  established: number;
  unavailable: number;
  /** Reads that could not since the last one that did, and when that run began (epoch ms). */
  consecutiveUnavailable: number;
  unavailableSince: number | null;
  lastUnavailableReason: KnowledgeAssetVersionSnapshotUnavailableReason | null;
  failingEndpoints: KnowledgeAssetVersionSnapshotFailingEndpoint[];
}

/** Real configurations have a handful of endpoints per chain; this is a ceiling. */
const MAX_FAILING_ENDPOINTS = 64;

interface MutableHealth extends Omit<KnowledgeAssetVersionSnapshotHealth, 'failingEndpoints'> {
  failing: Map<string, KnowledgeAssetVersionSnapshotFailingEndpoint>;
}

function freshHealth(): MutableHealth {
  return {
    established: 0,
    unavailable: 0,
    consecutiveUnavailable: 0,
    unavailableSince: null,
    lastUnavailableReason: null,
    failing: new Map(),
  };
}

// Process-wide, like the failover counters: the daemon builds one adapter per
// agent and per publisher wallet, and `/api/status` reads the aggregate.
let health = freshHealth();

function endpointKey(position: number, endpointCount: number, host: string): string {
  return `${position}/${endpointCount}|${host}`;
}

function noteEstablished(endpointKeys: () => readonly string[]): void {
  health.established += 1;
  health.consecutiveUnavailable = 0;
  health.unavailableSince = null;
  health.lastUnavailableReason = null;
  // The common read has nothing to clear and must not pay for the keys.
  if (health.failing.size === 0) return;
  for (const key of endpointKeys()) health.failing.delete(key);
}

function noteUnavailable(
  report: KnowledgeAssetVersionSnapshotUnavailable,
  answered: readonly string[],
): void {
  const now = Date.now();
  health.unavailable += 1;
  health.consecutiveUnavailable += 1;
  health.unavailableSince ??= now;
  health.lastUnavailableReason = report.reason;
  for (const key of answered) health.failing.delete(key);
  for (const endpoint of report.endpoints) {
    const key = endpointKey(endpoint.position, report.endpointCount, endpoint.host);
    const prior = health.failing.get(key);
    const same = prior !== undefined
      && prior.stage === endpoint.stage
      && prior.failure === endpoint.failure
      && prior.httpStatus === endpoint.httpStatus;
    // Most recently failing last, so the ceiling drops the stalest entry.
    health.failing.delete(key);
    health.failing.set(key, {
      ...endpoint,
      endpointCount: report.endpointCount,
      consecutive: same ? prior.consecutive + 1 : 1,
      since: same ? prior.since : now,
      last: now,
    });
  }
  while (health.failing.size > MAX_FAILING_ENDPOINTS) {
    health.failing.delete(health.failing.keys().next().value!);
  }
}

export function getKnowledgeAssetVersionSnapshotHealth(): KnowledgeAssetVersionSnapshotHealth {
  const { failing, ...counts } = health;
  return { ...counts, failingEndpoints: [...failing.values()] };
}

/** Test-only reset of the process-wide record. */
export function _resetKnowledgeAssetVersionSnapshotHealthForTest(): void {
  health = freshHealth();
}
