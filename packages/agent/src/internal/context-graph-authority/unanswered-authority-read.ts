// SPDX-License-Identifier: Apache-2.0

/**
 * An authority check that got no answer from the chain, told apart from one
 * the chain answered.
 *
 * Several checks reduce their decision to a boolean or a roster, and a chain
 * read that was never answered then looks like "no": the node's own RPC budget
 * did not admit it, or the endpoint did not reply in time. That says nothing
 * about the graph, and the same question may be answered a moment later. A
 * caller that changes state on "no" opens an observation around its check and
 * can then leave the state alone and ask again.
 *
 * The check keeps its signature and its fail-closed result. Outside an
 * observation a report goes nowhere.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { registeredContextGraphAuthorityUnavailableDependency } from '../../context-graph-authority-dependency.js';
import type {
  ContextGraphReadAuthorityDecision,
  UnavailableContextGraphReadAuthorityDecision,
} from '../../context-graph-read-authority.js';
import type { RegisteredContextGraphAuthority } from '../../registered-context-graph-authority.js';

/**
 * On a current-state read these reasons only come from a chain read that
 * timed out or that the transport rejected. `chain-access-policy-unknown` is
 * absent on purpose: there the chain answered, and the answer is final.
 */
const UNANSWERED_CHAIN_READ_REASONS: ReadonlySet<string> = new Set([
  'chain-access-policy-timeout',
  'chain-access-policy-unavailable',
  'chain-participant-authority-unavailable',
]);

/** Whether the decision is "no answer from the chain" rather than a refusal. */
export function isUnansweredChainReadAuthorityDecision(
  decision: ContextGraphReadAuthorityDecision | undefined,
): decision is UnavailableContextGraphReadAuthorityDecision {
  return decision?.outcome === 'unavailable'
    && decision.dependency === 'chain'
    && UNANSWERED_CHAIN_READ_REASONS.has(decision.reason);
}

/** One caller's observation of the authority reads behind one check of one graph. */
export class UnansweredAuthorityObservation {
  #unanswered: string | undefined;

  constructor(private readonly contextGraphId: string) {}

  /**
   * Run `check` inside the observation and return exactly what it returns:
   * awaiting a check through here takes no more turns than awaiting it
   * directly.
   */
  run<T>(check: () => T): T {
    return observations.run(this, check);
  }

  /**
   * The first read behind the check that got no answer, named for the node's
   * log, or undefined when every read was answered. Read it when the check
   * has ended.
   */
  get unanswered(): string | undefined {
    return this.#unanswered;
  }

  /** Only a read of the observed graph counts. */
  report(contextGraphId: string, detail: string): void {
    if (contextGraphId === this.contextGraphId) this.#unanswered ??= detail;
  }
}

const observations = new AsyncLocalStorage<UnansweredAuthorityObservation>();

function report(contextGraphId: string, detail: string): void {
  observations.getStore()?.report(contextGraphId, detail);
}

/** Report a read-authority decision that is "no answer from the chain". */
export function reportUnansweredReadAuthorityDecision(
  contextGraphId: string,
  decision: ContextGraphReadAuthorityDecision,
): void {
  if (!isUnansweredChainReadAuthorityDecision(decision)) return;
  report(contextGraphId, `${decision.source}/${decision.reason}/${decision.dependency}`);
}

/** Report a registered authority that is "no answer from the chain". */
export function reportUnansweredRegisteredAuthority(
  contextGraphId: string,
  authority: RegisteredContextGraphAuthority,
): void {
  if (
    authority.kind !== 'unavailable'
    || !UNANSWERED_CHAIN_READ_REASONS.has(authority.reason)
    || registeredContextGraphAuthorityUnavailableDependency(authority) !== 'chain'
  ) return;
  report(contextGraphId, `registered-authority/${authority.reason}/chain`);
}
