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
 *    private participant list). The registry is a plain map written from many places, so the entry is
 *    compared by value when a call arrives instead of being hooked.
 *
 * The probe's other reads (whether the graph has content, the persisted subscription row, on-chain
 * identity IDs) do not move the stamp; the coalescing and cache rules account for them (the daemon's
 * `write-preflight-coalescing.ts`).
 */

import { SYSTEM_CONTEXT_GRAPHS, contextGraphDataGraphUri, isSafeIri } from '@origintrail-official/dkg-core';
import { normalizeWritePreflightCaller } from './context-graph-write-preflight.js';
import { DKGAgentBase } from './dkg-agent-base.js';
import type { DKGAgent } from './dkg-agent.js';
import type { ContextGraphSub } from './dkg-agent-types.js';
import type { StoreMutation, StoreMutationObserver } from './internal/store-mutation.js';

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

/** Moves whenever a write that settles may have changed what a write preflight reads. */
export class WritePreflightGeneration {
  private value = 0;

  get current(): number {
    return this.value;
  }

  bump(): void {
    this.value += 1;
  }
}

/**
 * Wraps the store's mutation observer: a write that may change a policy source bumps `generation`
 * when it settles, unless it provably changed nothing. An indeterminate outcome (a timeout, a lost
 * response) bumps too, because the write may still have committed.
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
          if (relevant && outcome !== 'unchanged') generation.bump();
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
  /** The policy generation and this context graph's subscription state. */
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
   * generation (an agent not built by `DKGAgent.create`): nothing may then be shared.
   */
  writePreflightIdentity(
    this: DKGAgent,
    contextGraphId: string,
    callerAgentAddress?: string | null,
  ): WritePreflightIdentity | undefined {
    const generation = generations.get(this);
    if (!generation) return undefined;
    return {
      key: `${normalizeWritePreflightCaller(callerAgentAddress) ?? '-'}\n${contextGraphId}`,
      stamp: `${generation.current}:${subscriptionStamp(this.getSubscribedContextGraphs().get(contextGraphId))}`,
    };
  }
}
