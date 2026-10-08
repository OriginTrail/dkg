// SPDX-License-Identifier: Apache-2.0

/**
 * Why a Knowledge Asset version snapshot could not be established, and which
 * endpoint a read that did succeed had to pass over.
 *
 * `readKnowledgeAssetVersionSnapshot` asks the primary endpoint for a complete
 * view at one pinned block and falls back through the configured endpoints in
 * order (GH#3098); it answers `null` when none supplies one. This module does
 * not touch that rule. It keeps what the read otherwise drops: an endpoint
 * that fails is passed over silently, and a `null` says nothing about which
 * endpoint failed, at which step of its read, or why.
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
import { classifyRpcRetryDisposition } from './evm-adapter-rpc.js';
import { classifyRpcFailoverError, rpcHost } from './rpc-failover-log.js';

/** The step of one endpoint's read that produced no answer. */
export type KnowledgeAssetVersionSnapshotReadStage =
  | 'chain-id'
  | 'head-block'
  | 'pinned-block'
  | 'pinned-read'
  | 'storage-binding';

/** Why one endpoint supplied no view. Closed: never the provider's own words. */
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
  /** No endpoint supplied a complete view; `endpoints` names each one that was asked. */
  | 'endpoints-failed'
  /** The caller's signal ended the read; `endpoints` names those without a view by then. */
  | 'aborted'
  /** The node's own RPC request budget stopped the read before another endpoint was asked. */
  | 'local-pressure'
  /** The storage contract binding changed while the view was read. */
  | 'storage-binding-changed'
  /** No endpoint was asked: the storage contract is not resolved. */
  | 'no-storage-contract';

export interface KnowledgeAssetVersionSnapshotUnavailable {
  readonly reason: KnowledgeAssetVersionSnapshotUnavailableReason;
  /** Configured endpoints. They are asked in order until one supplies a view. */
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

/** True when the node's own request budget refused the request: nothing reached the endpoint. */
function isLocalPressure(err: unknown): boolean {
  try {
    return classifyRpcRetryDisposition(err) === 'retry-later';
  } catch {
    return false;
  }
}

interface EndpointSlot {
  stage: KnowledgeAssetVersionSnapshotReadStage;
  /** How the endpoint's latest attempt ended. Unset while one is in flight. */
  outcome?: 'view' | EndpointCause;
}

export interface KnowledgeAssetVersionSnapshotTraceOptions {
  onUnavailable?: KnowledgeAssetVersionSnapshotReadOptions['onUnavailable'];
  /** True once the caller has cancelled the read: what ends after that is no endpoint's failure. */
  cancelled: () => boolean;
}

/**
 * One read's record of what each endpoint did. The adapter wraps its
 * per-endpoint read in {@link observe} and returns through {@link established},
 * {@link noView} or {@link unavailable}; each hands back exactly the value the
 * read would have returned without the trace.
 */
export class KnowledgeAssetVersionSnapshotTrace<TProvider> {
  readonly #providers: readonly TProvider[];
  readonly #rpcUrls: readonly string[];
  readonly #options: KnowledgeAssetVersionSnapshotTraceOptions;
  readonly #slots = new Map<TProvider, EndpointSlot>();
  #localPressure = false;

  constructor(
    providers: readonly TProvider[],
    rpcUrls: readonly string[],
    options: KnowledgeAssetVersionSnapshotTraceOptions,
  ) {
    this.#providers = providers;
    this.#rpcUrls = rpcUrls;
    this.#options = options;
  }

  /**
   * The per-endpoint read, observed. `readOne` starts at its storage binding
   * check and names each later step it enters through `step`. A transient
   * failure is retried in place, so each attempt starts a new record and the
   * last one stands.
   */
  observe<TView, TSignal>(
    readOne: (
      provider: TProvider,
      signal: TSignal,
      step: (stage: KnowledgeAssetVersionSnapshotReadStage) => void,
    ) => Promise<TView | null>,
  ): (provider: TProvider, signal: TSignal) => Promise<TView | null> {
    return async (provider, signal) => {
      const slot: EndpointSlot = { stage: 'storage-binding' };
      this.#slots.set(provider, slot);
      try {
        const view = await readOne(provider, signal, (stage) => { slot.stage = stage; });
        slot.outcome = view === null ? this.#withoutView(slot.stage) : 'view';
        return view;
      } catch (error) {
        if (this.#cancelled()) {
          slot.outcome = { failure: 'no-answer' };
        } else if (isLocalPressure(error)) {
          // Nothing reached the endpoint, so this is not something it did.
          this.#localPressure = true;
          this.#slots.delete(provider);
        } else {
          slot.outcome = classifyKnowledgeAssetVersionSnapshotEndpointError(error);
        }
        throw error;
      }
    };
  }

  /** The read established `view`. Returns it. */
  established<TView>(view: TView): TView {
    try {
      noteEstablished(this.#outcomes());
    } catch {
      // Observability must never change what the read answers.
    }
    return view;
  }

  /** No endpoint supplied a view. Returns the read's `null`. */
  noView(): null {
    if (this.#cancelled()) return this.unavailable('aborted');
    return this.unavailable(this.#localPressure ? 'local-pressure' : 'endpoints-failed');
  }

  /** The read could not establish a view, for `reason`. Returns the read's `null`. */
  unavailable(reason: KnowledgeAssetVersionSnapshotUnavailableReason): null {
    try {
      const outcomes = this.#outcomes();
      const report: KnowledgeAssetVersionSnapshotUnavailable = {
        reason,
        endpointCount: outcomes.endpointCount,
        endpoints: outcomes.failed.map(({ endpoint }) => endpoint),
      };
      noteUnavailable(reason, outcomes);
      this.#options.onUnavailable?.(report);
    } catch {
      // Observability must never change what the read answers.
    }
    return null;
  }

  #cancelled(): boolean {
    try {
      return this.#options.cancelled();
    } catch {
      return false;
    }
  }

  /** Why an endpoint that returned no view did so, from the step it was in. */
  #withoutView(stage: KnowledgeAssetVersionSnapshotReadStage): EndpointCause {
    if (stage === 'chain-id') return { failure: 'wrong-chain' };
    if (stage === 'storage-binding') return { failure: 'binding-changed' };
    return { failure: 'incomplete-view' };
  }

  /** What each endpoint that was asked did, in configured order. */
  #outcomes(): EndpointOutcomes {
    const failed: TrackedFailure[] = [];
    const answered: string[] = [];
    const endpointCount = this.#providers.length;
    this.#providers.forEach((provider, index) => {
      const slot = this.#slots.get(provider);
      if (slot === undefined) return;
      const url = this.#rpcUrls[index]!;
      const key = endpointKey(index + 1, endpointCount, url);
      if (slot.outcome === 'view') {
        answered.push(key);
        return;
      }
      failed.push({
        key,
        endpoint: {
          position: index + 1,
          host: rpcHost(url),
          stage: slot.stage,
          // No outcome: the read ended while this endpoint's attempt was in flight.
          ...(slot.outcome ?? { failure: 'no-answer' }),
        },
      });
    });
    return { endpointCount, failed, answered };
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

/** One endpoint's failure in words, e.g. `endpoint 1 of 3 (host) refused a block-pinned read (http 400)`. */
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

/** Why no view could be established, in words. Names every endpoint that was asked and supplied none. */
export function describeKnowledgeAssetVersionSnapshotUnavailable(
  report: KnowledgeAssetVersionSnapshotUnavailable,
): string {
  const parts = report.endpoints
    .map((endpoint) => describeKnowledgeAssetVersionSnapshotEndpointFailure(endpoint, report.endpointCount));
  if (report.reason === 'local-pressure') {
    parts.push("the node's own RPC request budget was full before another endpoint could be asked");
  }
  if (parts.length > 0) return parts.join('; ');
  switch (report.reason) {
    case 'aborted': return 'the read was cancelled before it completed';
    case 'storage-binding-changed': return 'the storage contract binding changed during the read';
    case 'no-storage-contract': return 'the knowledge asset storage contract is not resolved';
    default: return 'no endpoint returned a complete view';
  }
}

// --- Process-wide record (host only) -----------------------------------------

/** One endpoint whose latest pinned read supplied no view. */
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
   * Reads that established a view, and reads that could not, since start. A
   * read its caller cancelled is neither.
   */
  established: number;
  unavailable: number;
  /** Reads that could not since the last one that did, and when that run began (epoch ms). */
  consecutiveUnavailable: number;
  unavailableSince: number | null;
  lastUnavailableReason: KnowledgeAssetVersionSnapshotUnavailableReason | null;
  /**
   * Endpoints whose latest pinned read failed. When reads still succeed, an
   * entry here is an endpoint that every read passes over first.
   */
  failingEndpoints: KnowledgeAssetVersionSnapshotFailingEndpoint[];
}

/** Real configurations have a handful of endpoints per chain; this is a ceiling. */
const MAX_FAILING_ENDPOINTS = 64;

interface TrackedFailure {
  /** Private identity of the configured endpoint. Never part of any output. */
  readonly key: string;
  readonly endpoint: KnowledgeAssetVersionSnapshotEndpointFailure;
}

interface EndpointOutcomes {
  readonly endpointCount: number;
  /** Endpoints that were asked and supplied no view, in configured order. */
  readonly failed: readonly TrackedFailure[];
  /** Private identities of the endpoints that supplied a view. */
  readonly answered: readonly string[];
}

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

/**
 * Bookkeeping identity of one configured endpoint: the whole URL, so that two
 * endpoints on one host stay apart. It is a map key only and is never output.
 */
function endpointKey(position: number, endpointCount: number, rpcUrl: string): string {
  return `${position}/${endpointCount}|${rpcUrl}`;
}

function noteEstablished(outcomes: EndpointOutcomes): void {
  health.established += 1;
  health.consecutiveUnavailable = 0;
  health.unavailableSince = null;
  health.lastUnavailableReason = null;
  // The common read passed over nothing and has nothing to clear.
  if (outcomes.failed.length === 0 && health.failing.size === 0) return;
  noteEndpoints(outcomes.failed, outcomes);
}

function noteUnavailable(
  reason: KnowledgeAssetVersionSnapshotUnavailableReason,
  outcomes: EndpointOutcomes,
): void {
  // A cancelled read says nothing about whether a view can be established. What an
  // endpoint had already failed with is still recorded; one still in flight is not.
  if (reason === 'aborted') {
    noteEndpoints(outcomes.failed.filter(({ endpoint }) => endpoint.failure !== 'no-answer'), outcomes);
    return;
  }
  health.unavailable += 1;
  health.consecutiveUnavailable += 1;
  health.unavailableSince ??= Date.now();
  health.lastUnavailableReason = reason;
  noteEndpoints(outcomes.failed, outcomes);
}

function noteEndpoints(failed: readonly TrackedFailure[], outcomes: EndpointOutcomes): void {
  const now = Date.now();
  for (const key of outcomes.answered) health.failing.delete(key);
  for (const { key, endpoint } of failed) {
    const prior = health.failing.get(key);
    const same = prior !== undefined
      && prior.stage === endpoint.stage
      && prior.failure === endpoint.failure
      && prior.httpStatus === endpoint.httpStatus;
    // Most recently failing last, so the ceiling drops the stalest entry.
    health.failing.delete(key);
    health.failing.set(key, {
      ...endpoint,
      endpointCount: outcomes.endpointCount,
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
