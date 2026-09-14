// SPDX-License-Identifier: Apache-2.0

import {
  resolveContextGraphReadAuthorityDecision,
  type ContextGraphReadAuthorityInput,
} from './context-graph-read-authority.js';
import type { ContextGraphReadAuthorityFactsSnapshot } from './context-graph-meta-projection.js';
import {
  ContextGraphRegistrationBatchUnavailable,
  type ContextGraphRegistrationReadPlan,
  type PreparedContextGraphRegistrationRead,
} from './dkg-agent-cg-registry.js';

export type ContextGraphReadCheck = (id: string, signal: AbortSignal) => Promise<boolean>;

export interface UnscopedContextGraphReadCheckDependencies {
  createReadAuthorityInput(id: string, signal: AbortSignal): ContextGraphReadAuthorityInput;
  prepareRegistrationReadPlan(
    ids: readonly string[], signal: AbortSignal,
  ): Promise<ContextGraphRegistrationReadPlan | null>;
  prepareReadAuthorityFactsSnapshot(
    ids: readonly string[], signal: AbortSignal,
  ): Promise<ContextGraphReadAuthorityFactsSnapshot>;
}

/**
 * Prepare request-local registration and metadata providers, then run every
 * candidate through the canonical read decision. The registry owns batch
 * routing and validation; the metadata projection owns its absence snapshot.
 */
export async function prepareUnscopedContextGraphReadChecks(
  deps: UnscopedContextGraphReadCheckDependencies,
  ids: readonly string[],
  signal: AbortSignal,
): Promise<ContextGraphReadCheck> {
  signal.throwIfAborted();

  const decide = async (
    id: string,
    readSignal: AbortSignal,
    registration?: PreparedContextGraphRegistrationRead,
    metadata?: ContextGraphReadAuthorityFactsSnapshot,
  ): Promise<boolean> => {
    signal.throwIfAborted();
    readSignal.throwIfAborted();
    const input = deps.createReadAuthorityInput(id, readSignal);
    const liveRegistration = input.getRegisteredAuthority;
    const livePrivateMetadata = input.isPrivateLocalGraph;
    let metadataAbsenceEligible = false;
    const preparedInput: ContextGraphReadAuthorityInput = {
      ...input,
      getRegisteredAuthority: registration
        ? async () => {
            const prepared = await registration.resolve(id, liveRegistration, readSignal);
            metadataAbsenceEligible = prepared.metadataAbsenceEligible;
            return prepared.authority;
          }
        : liveRegistration,
      isPrivateLocalGraph: metadata
        ? async () => {
            if (metadataAbsenceEligible && metadata.assertCurrent() && metadata.isAbsent(id)) {
              return false;
            }
            return livePrivateMetadata();
          }
        : livePrivateMetadata,
    };
    const result = await resolveContextGraphReadAuthorityDecision(preparedInput);
    signal.throwIfAborted();
    readSignal.throwIfAborted();
    return result.outcome === 'allowed';
  };
  const original: ContextGraphReadCheck = (id, readSignal) => decide(id, readSignal);

  const plan = await deps.prepareRegistrationReadPlan(ids, signal);
  if (plan === null) return original;

  const preparationStop = new AbortController();
  const preparationSignal = AbortSignal.any([signal, preparationStop.signal]);
  let registration: PreparedContextGraphRegistrationRead;
  let metadata: ContextGraphReadAuthorityFactsSnapshot | undefined;
  try {
    [registration, metadata] = await Promise.all([
      plan.prepare(preparationSignal),
      deps.prepareReadAuthorityFactsSnapshot(plan.contextGraphIds, preparationSignal),
    ]);
  } catch (error) {
    signal.throwIfAborted();
    if (!(error instanceof ContextGraphRegistrationBatchUnavailable)) throw error;
    registration = error.prepared;
  } finally {
    preparationStop.abort();
  }
  signal.throwIfAborted();

  return (id, readSignal) => decide(id, readSignal, registration, metadata);
}
