// SPDX-License-Identifier: Apache-2.0

import {
  resolveContextGraphReadAuthorityDecision,
  type ContextGraphReadAuthorityInput,
} from './context-graph-read-authority.js';
import type { ContextGraphReadAuthorityFactsSnapshot } from './context-graph-meta-projection.js';
import {
  type ContextGraphRegistrationReadPlan,
  type PreparedContextGraphRegistrationRead,
} from './context-graph-registration-read-plan.js';
import type { RegisteredContextGraphAuthority } from
  './registered-context-graph-authority.js';

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

const SCALAR_REGISTRATION_PREPARATION_CONCURRENCY = 32;

async function prepareScalarRegistrationRead(
  deps: UnscopedContextGraphReadCheckDependencies,
  ids: readonly string[],
  signal: AbortSignal,
): Promise<PreparedContextGraphRegistrationRead> {
  const candidates = [...new Set(ids)];
  const authorities = new Map<string, RegisteredContextGraphAuthority>();
  let cursor = 0;
  const workers = Array.from({
    length: Math.min(SCALAR_REGISTRATION_PREPARATION_CONCURRENCY, candidates.length),
  }, async () => {
    while (cursor < candidates.length) {
      const id = candidates[cursor]!;
      cursor += 1;
      signal.throwIfAborted();
      const input = deps.createReadAuthorityInput(id, signal);
      try {
        authorities.set(id, await input.getRegisteredAuthority());
      } catch (error) {
        authorities.set(id, {
          kind: 'unavailable',
          reason: 'chain-name-binding-unavailable',
          detail: error instanceof Error ? error.message : String(error),
        });
      }
      signal.throwIfAborted();
    }
  });
  await Promise.all(workers);
  return {
    async resolve(contextGraphId, live, readSignal) {
      readSignal.throwIfAborted();
      const prepared = authorities.get(contextGraphId);
      if (prepared === undefined) {
        return { authority: await live(), metadataAbsenceEligible: false };
      }
      if (prepared.kind === 'unregistered') {
        return { authority: prepared, metadataAbsenceEligible: true };
      }
      if (prepared.kind === 'unavailable') {
        return { authority: prepared, metadataAbsenceEligible: false };
      }
      const current = await live();
      readSignal.throwIfAborted();
      if (current.kind === 'unregistered' || current.onChainId !== prepared.onChainId) {
        return {
          authority: {
            kind: 'unavailable',
            reason: 'chain-name-binding-unavailable',
            onChainId: prepared.onChainId,
            detail: 'prepared scalar registration changed before authority resolution',
          },
          metadataAbsenceEligible: false,
        };
      }
      return { authority: current, metadataAbsenceEligible: false };
    },
  };
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
  const plan = await deps.prepareRegistrationReadPlan(ids, signal);

  const preparationStop = new AbortController();
  const preparationSignal = AbortSignal.any([signal, preparationStop.signal]);
  let registration: PreparedContextGraphRegistrationRead;
  let metadata: ContextGraphReadAuthorityFactsSnapshot | undefined;
  try {
    if (plan === null) {
      [registration, metadata] = await Promise.all([
        Promise.resolve().then(() => (
          prepareScalarRegistrationRead(deps, ids, preparationSignal)
        )),
        Promise.resolve().then(() => (
          deps.prepareReadAuthorityFactsSnapshot(ids, preparationSignal)
        )),
      ]);
    } else {
      const metadataPromise = Promise.resolve().then(() => (
        deps.prepareReadAuthorityFactsSnapshot(plan.contextGraphIds, preparationSignal)
      ));
      // Registration preparation may reject before this task is otherwise
      // awaited. Observe metadata failures from creation so aborting that
      // concurrent task cannot surface as an unhandled rejection; the
      // original promise still rejects when the ready path awaits it below.
      void metadataPromise.catch(() => undefined);
      const prepared = await plan.prepare(preparationSignal);
      registration = prepared.prepared;
      if (prepared.kind === 'ready') {
        metadata = await metadataPromise;
      } else {
        preparationStop.abort();
        void metadataPromise.catch(() => undefined);
      }
    }
  } finally {
    preparationStop.abort();
  }
  signal.throwIfAborted();

  return (id, readSignal) => decide(id, readSignal, registration, metadata);
}
