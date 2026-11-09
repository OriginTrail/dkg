// SPDX-License-Identifier: Apache-2.0

/**
 * When two write-preflight probes of one context graph are interchangeable (OT-RFC-73 S4a).
 *
 * The daemon may let concurrent callers share one `probeContextGraphWritePreflight` call, and may
 * keep a fast-accept result for a moment. Both are safe only while nothing the probe reads has
 * changed, so the agent says what a probe reads and when that moved:
 *
 *  - a generation counter, bumped when a write that settles may change a policy source the probe
 *    reads: the ontology graph, the agents graph or any context graph's `_meta` graph, as seen by the
 *    store's mutation observer (an ack of such a write follows its bump, so a caller that learns of
 *    the write can never share a probe that began before it);
 *  - the context graph's own subscription entry, which the probe also reads (in-memory state and the
 *    private participant list). The registry counts the writes made to each entry (a `set`, a `delete` or
 *    a `clear` moves that entry's version, even to an equal row), so a change that is reverted before the
 *    next caller arrives is still seen; the entry's value is compared as well, for a row edited in place.
 *
 * A policy write that ends with an UNKNOWN outcome (a store deadline, a lost response) may still be applied
 * by a remote store after the agent stopped waiting, and nothing then tells the agent that it was. The
 * generation moves when the outcome is reported, but a probe that begins after that and before the late commit
 * has read the old policy, and would be shared with a caller that arrives after the commit. So sharing is
 * off, not merely re-stamped, while an unknown outcome is unresolved: `writePreflightIdentity` hands out no
 * identity, every preflight probes directly (no join, no cache hit, no cache store), and sharing resumes
 * once the unresolved-write window (`WRITE_PREFLIGHT_UNRESOLVED_WRITE_WINDOW_MS`) has passed, under a
 * generation moved once more so that nothing begun in the window can be joined.
 * A confirmed write (`changed`, or `unchanged`) never suspends sharing. A write to the subscription registry
 * is synchronous and in memory, so it has no unknown outcome.
 *
 * THE WINDOW IS A POLICY, NOT A GUARANTEE. It is this module's own setting: 120 s unless the daemon passes
 * another (`DKG_WRITE_PREFLIGHT_UNRESOLVED_WRITE_WINDOW_MS`), and it is derived from nothing a store does.
 * No store promises when it stops working on a write its caller abandoned: a read can be given a server
 * deadline, but an insert or an update is sent with none, so no time bound is known for a write, and the
 * window is a best-effort estimate of how long a late commit takes. RESIDUAL RISK: a policy write that the
 * agent abandoned and that the backend applies later than the window can be missed by a caller that joins (or,
 * with the result cache on, is served from) a probe that began before the write landed. That lasts at most
 * one probe's join lifetime after the commit: the daemon joins a probe for 10 s from its start
 * (`WRITE_PREFLIGHT_FLIGHT_MAX_JOIN_MS`), and the cache TTL, 10 s at most, counts from the probe's start too.
 * An operator who needs a strict guarantee sets the window to 0 (`WRITE_PREFLIGHT_UNRESOLVED_WRITE_WINDOW_STRICT`):
 * after any unknown outcome of a policy write sharing then stays off for the rest of the process, at the cost
 * of every preflight probing the store itself from then on.
 *
 * The probe's other reads do NOT move the stamp: whether the graph exists (`contextGraphExists`), whether it
 * has local content, the persisted subscription row and on-chain identity IDs. Nothing marks a probe that
 * began before one of these changed as outdated, so a caller that learned of the change before it called may
 * still be given the older read, from a probe that began no earlier than the daemon's join limit ago (a fresh
 * read, started after the change, would have seen it). The coalescing and cache rules account for these
 * reads (the daemon's `write-preflight-coalescing.ts`): the join limit, the fresh second pass after a
 * readiness wait, and a result cache that never keeps an answer that consulted the chain or found the store
 * unavailable.
 */

import { SYSTEM_CONTEXT_GRAPHS, contextGraphDataGraphUri, isSafeIri } from '@origintrail-official/dkg-core';
import { normalizeWritePreflightCaller } from './context-graph-write-preflight.js';
import {
  WRITE_PREFLIGHT_UNRESOLVED_WRITE_WINDOW_MS,
  WRITE_PREFLIGHT_UNRESOLVED_WRITE_WINDOW_STRICT,
} from './write-preflight-unresolved-window.js';
import { DKGAgentBase } from './dkg-agent-base.js';
import type { DKGAgent } from './dkg-agent.js';
import type { ContextGraphSub } from './dkg-agent-types.js';
import type { StoreMutation, StoreMutationObserver } from './internal/store-mutation.js';
import { VersionedSubscriptionRegistry } from './internal/versioned-subscription-registry.js';

export { WRITE_PREFLIGHT_UNRESOLVED_WRITE_WINDOW_MS, WRITE_PREFLIGHT_UNRESOLVED_WRITE_WINDOW_STRICT };

const CONTEXT_GRAPH_PREFIX = 'did:dkg:context-graph:';
const ONTOLOGY_GRAPH = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
const AGENTS_GRAPH = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.AGENTS);

/** The ontology graph, the agents graph and any `_meta` graph: where the probe reads policy, curator and allowlist from. */
function isPreflightPolicyGraph(graph: string): boolean {
  const iri = graph.startsWith('<') && graph.endsWith('>') ? graph.slice(1, -1) : graph;
  // An adapter may rewrite an unsafe graph name into a real graph, so it cannot be ruled out.
  if (!isSafeIri(iri)) return true;
  return iri === ONTOLOGY_GRAPH
    || iri === AGENTS_GRAPH
    || (iri.startsWith(CONTEXT_GRAPH_PREFIX) && iri.endsWith('/_meta'));
}

/**
 * Whether a store write may change what the probe reads; true whenever that cannot be ruled out. It runs
 * before every write is dispatched, so it never throws, and a bulk write pays for each distinct graph once.
 */
export function mutationMayChangeWritePreflight(mutation: StoreMutation): boolean {
  try {
    if (mutation.everything) return true;
    if (mutation.removals?.some(({ graph }) => typeof graph !== 'string' || isPreflightPolicyGraph(graph))) return true;
    const checked = new Set<string>();
    for (const { graph } of mutation.quads ?? []) {
      // A quad without a graph goes to the default graph, which the probe never reads.
      if (typeof graph !== 'string' || graph === '' || checked.has(graph)) continue;
      if (isPreflightPolicyGraph(graph)) return true;
      checked.add(graph);
    }
    return false;
  } catch {
    return true;
  }
}

export interface WritePreflightGenerationOptions {
  /**
   * Whole milliseconds; defaults to `WRITE_PREFLIGHT_UNRESOLVED_WRITE_WINDOW_MS`.
   * `WRITE_PREFLIGHT_UNRESOLVED_WRITE_WINDOW_STRICT` (0) means strict: sharing never resumes after an unknown outcome.
   */
  readonly unresolvedWindowMs?: number;
  /** A monotonic clock in milliseconds; defaults to `performance.now`. */
  readonly now?: () => number;
}

/** Moves whenever a write that settles may have changed what a write preflight reads. */
export class WritePreflightGeneration {
  private value = 0;
  /** While a policy write has an unknown outcome: when its window ends (the latest of them); infinite when strict. */
  private unresolvedUntil: number | undefined;
  /** The window in force: whole milliseconds, 0 when strict. */
  readonly unresolvedWindowMs: number;
  private readonly now: () => number;

  constructor(options: WritePreflightGenerationOptions = {}) {
    const window = options.unresolvedWindowMs ?? WRITE_PREFLIGHT_UNRESOLVED_WRITE_WINDOW_MS;
    // A safety bound is never guessed at: a value that is not a whole, non-negative number of milliseconds is a mistake of the caller.
    if (!Number.isSafeInteger(window) || window < 0) {
      throw new RangeError(`The write preflight unresolved-write window must be a whole number of milliseconds, 0 or more (got ${String(window)}).`);
    }
    this.unresolvedWindowMs = window;
    this.now = options.now ?? (() => performance.now());
  }

  /** Whether sharing, once suspended by an unknown outcome, stays off for the rest of the process. */
  get strict(): boolean {
    return this.unresolvedWindowMs === WRITE_PREFLIGHT_UNRESOLVED_WRITE_WINDOW_STRICT;
  }

  get current(): number {
    return this.value;
  }

  bump(): void {
    this.value += 1;
  }

  /**
   * A policy write ended with an unknown outcome: it may be applied later, with nothing to say so. Moves the
   * generation, and keeps sharing off until the window has passed (a further unknown outcome extends it), or
   * for the rest of the process when the window is strict.
   */
  bumpUnresolved(): void {
    // The window is set first, so that a bump that cannot run still leaves sharing off.
    const until = this.strict ? Number.POSITIVE_INFINITY : this.now() + this.unresolvedWindowMs;
    if (this.unresolvedUntil === undefined || until > this.unresolvedUntil) this.unresolvedUntil = until;
    this.bump();
  }

  /**
   * Whether probes may be shared now: false while a policy write has an unknown outcome (for good, when strict).
   * The first call after the window has passed moves the generation once more, so that no probe begun inside the
   * window is joinable.
   */
  sharingAllowed(): boolean {
    if (this.unresolvedUntil === undefined) return true;
    if (this.now() < this.unresolvedUntil) return false;
    this.unresolvedUntil = undefined;
    this.bump();
    return true;
  }
}

/**
 * Wraps the store's mutation observer: a write that may change a policy source bumps `generation`
 * when it settles, unless it provably changed nothing. An indeterminate outcome (a timeout, a lost
 * response) bumps too, because the write may still have committed, and also keeps sharing off until
 * the unresolved-write window has passed, or for good when it is strict (see the header).
 */
export function withWritePreflightGeneration(
  inner: StoreMutationObserver,
  generation: WritePreflightGeneration,
): StoreMutationObserver {
  return {
    begin(mutation) {
      const relevant = mutationMayChangeWritePreflight(mutation);
      const settle = inner.begin(mutation);
      return (outcome) => {
        try {
          if (relevant && outcome === 'indeterminate') generation.bumpUnresolved();
          else if (relevant && outcome !== 'unchanged') generation.bump();
        } finally {
          settle(outcome);
        }
      };
    },
  };
}

/** Per agent, set by `DKGAgent.create` once its store observer feeds the generation. */
const generations = new WeakMap<object, WritePreflightGeneration>();

/** Declares that `agent`'s store observer feeds `generation`; only such an agent hands out an identity. */
export function attachWritePreflightGeneration<T extends object>(agent: T, generation: WritePreflightGeneration): T {
  generations.set(agent, generation);
  return agent;
}

/** What makes two probe calls interchangeable: both `key` and `stamp` equal. */
export interface WritePreflightIdentity {
  /** The context graph and the caller as the probe judges it (a string that names no address judges as no caller). */
  readonly key: string;
  /** The policy generation and this context graph's subscription entry (its version and its value). */
  readonly stamp: string;
}

function subscriptionStamp(sub: Partial<ContextGraphSub> | undefined): string {
  if (!sub) return '-';
  const flag = (value: boolean | undefined): string => (value === undefined ? '-' : value ? '1' : '0');
  return `${flag(sub.subscribed)}${flag(sub.synced)}${flag(sub.metaSynced)}${flag(sub.coreHosted)}:${(sub.participantAgents ?? []).join(',')}`;
}

export class WritePreflightIdentityMethods extends DKGAgentBase {
  /**
   * Two probe calls with an equal key and an equal stamp read the same answer, so the second may use the
   * first's result while the stamp holds. Undefined when this agent's store observer does not feed the
   * generation (an agent not built by `DKGAgent.create`), when its subscription registry does not count
   * its writes, or while a policy write has an unknown outcome: nothing may then be shared.
   */
  writePreflightIdentity(
    this: DKGAgent,
    contextGraphId: string,
    callerAgentAddress?: string | null,
  ): WritePreflightIdentity | undefined {
    const generation = generations.get(this);
    const registry = this.subscribedContextGraphs;
    if (!generation || !(registry instanceof VersionedSubscriptionRegistry)) return undefined;
    if (!generation.sharingAllowed()) return undefined;
    return {
      key: `${normalizeWritePreflightCaller(callerAgentAddress) ?? '-'}\n${contextGraphId}`,
      stamp: `${generation.current}:${registry.versionOf(contextGraphId)}:${subscriptionStamp(registry.get(contextGraphId))}`,
    };
  }
}
