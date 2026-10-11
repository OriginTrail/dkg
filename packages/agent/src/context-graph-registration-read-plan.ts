// SPDX-License-Identifier: Apache-2.0

import type { RegisteredContextGraphAuthority } from
  './registered-context-graph-authority.js';

export interface PreparedContextGraphRegistrationRead {
  resolve(
    contextGraphId: string,
    live: () => Promise<RegisteredContextGraphAuthority>,
    signal: AbortSignal,
  ): Promise<{
    authority: RegisteredContextGraphAuthority;
    metadataAbsenceEligible: boolean;
  }>;
}

export type ContextGraphRegistrationReadPreparation = Readonly<
  | { kind: 'ready'; prepared: PreparedContextGraphRegistrationRead }
  | { kind: 'unavailable'; prepared: PreparedContextGraphRegistrationRead }
>;

export interface ContextGraphRegistrationReadPlan {
  readonly contextGraphIds: readonly string[];
  prepare(signal: AbortSignal): Promise<ContextGraphRegistrationReadPreparation>;
}

interface ContextGraphRegistrationReadPlanDependencies {
  nameHashForBatch(contextGraphId: string): string | undefined;
  resolveByNameHashes?: (
    nameHashes: readonly string[],
    options: { signal?: AbortSignal },
  ) => Promise<ReadonlyMap<string, bigint | null>>;
}

/** Build one request-local, route-fenced bulk registration plan. */
export async function createContextGraphRegistrationReadPlan(
  deps: ContextGraphRegistrationReadPlanDependencies,
  contextGraphIds: readonly string[],
  signal: AbortSignal,
): Promise<ContextGraphRegistrationReadPlan | null> {
  signal.throwIfAborted();
  const resolve = deps.resolveByNameHashes;
  if (resolve === undefined) return null;

  const hashesById = new Map<string, string>();
  let examined = 0;
  for (const id of new Set(contextGraphIds)) {
    if (examined > 0 && examined % 512 === 0) {
      await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
    }
    examined += 1;
    signal.throwIfAborted();
    const hash = deps.nameHashForBatch(id);
    if (hash === undefined) continue;
    if (!/^0x[0-9a-f]{64}$/.test(hash)) {
      throw new Error('Cannot authorize unscoped query: invalid Context Graph name commitment');
    }
    hashesById.set(id, hash);
  }
  if (hashesById.size === 0) return null;

  const candidates = Object.freeze([...hashesById.keys()]);
  const names = Object.freeze([...new Set(hashesById.values())]);
  const resolveLive = async (
    live: () => Promise<RegisteredContextGraphAuthority>,
    readSignal: AbortSignal,
  ): Promise<RegisteredContextGraphAuthority> => {
    const authority = await live();
    readSignal.throwIfAborted();
    return authority;
  };

  const unavailableProvider = (): PreparedContextGraphRegistrationRead => ({
    async resolve(contextGraphId, live, readSignal) {
      readSignal.throwIfAborted();
      if (!hashesById.has(contextGraphId)) {
        return {
          authority: await resolveLive(live, readSignal),
          metadataAbsenceEligible: false,
        };
      }
      const hash = hashesById.get(contextGraphId)!;
      return deps.nameHashForBatch(contextGraphId) === hash
        ? {
            authority: { kind: 'unavailable', reason: 'chain-name-binding-unavailable' },
            metadataAbsenceEligible: false,
          }
        : {
            authority: await resolveLive(live, readSignal),
            metadataAbsenceEligible: false,
          };
    },
  });

  return {
    contextGraphIds: candidates,
    async prepare(readSignal) {
      readSignal.throwIfAborted();
      let registrations: ReadonlyMap<string, bigint | null>;
      try {
        registrations = await resolve(names, { signal: readSignal });
      } catch {
        readSignal.throwIfAborted();
        return Object.freeze({ kind: 'unavailable', prepared: unavailableProvider() });
      }
      readSignal.throwIfAborted();

      const expected = new Set(names);
      if (
        registrations == null
        || typeof registrations[Symbol.iterator] !== 'function'
        || registrations.size !== expected.size
      ) {
        throw new Error('Cannot authorize unscoped query: incomplete Context Graph registration batch');
      }
      const absentNames = new Set<string>();
      const registeredNames = new Map<string, bigint>();
      const seenNames = new Set<string>();
      for (const entry of registrations) {
        readSignal.throwIfAborted();
        if (seenNames.size >= expected.size || !Array.isArray(entry) || entry.length !== 2) {
          throw new Error('Cannot authorize unscoped query: invalid Context Graph registration batch');
        }
        const [name, id] = entry;
        if (!expected.has(name) || seenNames.has(name) || (id !== null && (
          typeof id !== 'bigint' || id <= 0n || id >= (1n << 256n)
        ))) {
          throw new Error('Cannot authorize unscoped query: invalid Context Graph registration batch');
        }
        seenNames.add(name);
        if (id === null) absentNames.add(name);
        else registeredNames.set(name, id);
        if (seenNames.size % 512 === 0) {
          await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
        }
      }
      if (seenNames.size !== expected.size) {
        throw new Error('Cannot authorize unscoped query: incomplete Context Graph registration batch');
      }
      readSignal.throwIfAborted();

      const prepared: PreparedContextGraphRegistrationRead = {
        async resolve(contextGraphId, live, authoritySignal) {
          authoritySignal.throwIfAborted();
          if (!hashesById.has(contextGraphId)) {
            return {
              authority: await resolveLive(live, authoritySignal),
              metadataAbsenceEligible: false,
            };
          }
          const hash = hashesById.get(contextGraphId)!;
          const expectedRegistrationId = registeredNames.get(hash);
          if (expectedRegistrationId !== undefined) {
            const authority = await live();
            authoritySignal.throwIfAborted();
            if (
              authority.kind === 'unregistered'
              || authority.onChainId !== expectedRegistrationId
            ) {
              return {
                authority: {
                  kind: 'unavailable',
                  reason: 'chain-name-binding-unavailable',
                  onChainId: expectedRegistrationId,
                  detail: 'prepared chain name binding changed before authority resolution',
                },
                metadataAbsenceEligible: false,
              };
            }
            return { authority, metadataAbsenceEligible: false };
          }
          if (absentNames.has(hash) && deps.nameHashForBatch(contextGraphId) === hash) {
            return {
              authority: { kind: 'unregistered' },
              metadataAbsenceEligible: true,
            };
          }
          return {
            authority: await resolveLive(live, authoritySignal),
            metadataAbsenceEligible: false,
          };
        },
      };
      return Object.freeze({ kind: 'ready', prepared });
    },
  };
}
