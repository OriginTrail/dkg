// SPDX-License-Identifier: Apache-2.0

import type { ChainReadOptions } from '@origintrail-official/dkg-chain';
import {
  resolveContextGraphReadAuthorityDecision,
  type ContextGraphReadAuthorityInput,
} from './context-graph-read-authority.js';

export type ContextGraphReadCheck = (id: string, signal: AbortSignal) => Promise<boolean>;

export interface UnscopedContextGraphReadCheckDependencies {
  createReadAuthorityInput(id: string, signal: AbortSignal): ContextGraphReadAuthorityInput;
  /** Undefined unless the current canonical route is cold name-hash lookup. */
  registrationNameHash(id: string): string | undefined;
  findContextGraphIdsWithReadAuthorityFacts(
    ids: readonly string[], signal: AbortSignal,
  ): Promise<ReadonlySet<string>>;
  readMetadataRevision(): number;
  resolveContextGraphIdsByNameHashes?: (
    nameHashes: readonly string[], options: ChainReadOptions,
  ) => Promise<ReadonlyMap<string, bigint | null>>;
}

class RegistrationBatchUnavailable extends Error {}

/**
 * Prepare request-local I/O evidence, then run every candidate through the
 * canonical read decision. Absence may replace a cold registration read or a
 * metadata read, never the live RFC64/pending/roster/peer/subscription branches.
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
    evidence?: { registration: bigint | 'unregistered' | 'unavailable'; isMetadataAbsent?: () => boolean },
  ): Promise<boolean> => {
    signal.throwIfAborted();
    readSignal.throwIfAborted();
    const input = deps.createReadAuthorityInput(id, readSignal);
    const result = await resolveContextGraphReadAuthorityDecision({
      ...input,
      ...(typeof evidence?.registration === 'bigint' && {
        expectedRegistrationId: evidence.registration,
      }),
      ...(evidence && typeof evidence.registration !== 'bigint' && {
        getRegisteredAuthority: async () => evidence.registration === 'unregistered'
          ? { kind: 'unregistered' as const }
          : { kind: 'unavailable' as const, reason: 'chain-name-binding-unavailable' as const },
      }),
      ...(evidence?.isMetadataAbsent && {
        isPrivateLocalGraph: () => evidence.isMetadataAbsent!()
          ? Promise.resolve(false)
          : input.isPrivateLocalGraph(),
      }),
    });
    signal.throwIfAborted();
    readSignal.throwIfAborted();
    return result.outcome === 'allowed';
  };
  const original: ContextGraphReadCheck = (id, readSignal) => decide(id, readSignal);
  const resolve = deps.resolveContextGraphIdsByNameHashes;
  if (resolve === undefined) return original;

  const hashesById = new Map<string, string>();
  let examined = 0;
  for (const id of new Set(ids)) {
    if (examined > 0 && examined % 512 === 0) {
      await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
    }
    examined += 1;
    signal.throwIfAborted();
    const hash = deps.registrationNameHash(id);
    if (hash === undefined) continue;
    if (!/^0x[0-9a-f]{64}$/.test(hash)) {
      throw new Error('Cannot authorize unscoped query: invalid Context Graph name commitment');
    }
    hashesById.set(id, hash);
  }
  if (hashesById.size === 0) return original;
  const candidates = [...hashesById.keys()];
  const names = [...new Set(hashesById.values())];
  const metadataRevision = deps.readMetadataRevision();
  const preparationStop = new AbortController();
  const preparationSignal = AbortSignal.any([signal, preparationStop.signal]);
  let registrations: ReadonlyMap<string, bigint | null>;
  let metadataIds: ReadonlySet<string>;
  try {
    [registrations, metadataIds] = await Promise.all([
      (async () => {
        try {
          return await resolve(names, { signal: preparationSignal });
        } catch (cause) {
          signal.throwIfAborted();
          throw new RegistrationBatchUnavailable('Context Graph registration is unavailable', { cause });
        }
      })(),
      deps.findContextGraphIdsWithReadAuthorityFacts(candidates, preparationSignal),
    ]);
  } catch (error) {
    signal.throwIfAborted();
    if (!(error instanceof RegistrationBatchUnavailable)) throw error;
    // Match the ordinary resolver's unavailable-registration denial. Never
    // retry these names through a more optimistic local-only authority path.
    return async (id, readSignal) => {
      signal.throwIfAborted();
      readSignal.throwIfAborted();
      const hash = hashesById.get(id);
      return hash !== undefined && deps.registrationNameHash(id) === hash
        ? decide(id, readSignal, { registration: 'unavailable' })
        : original(id, readSignal);
    };
  } finally {
    preparationStop.abort();
  }
  signal.throwIfAborted();

  // A missing, extra, or malformed result is uncertainty, never absence.
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
    signal.throwIfAborted();
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
  signal.throwIfAborted();
  const metadataCandidates = new Set(metadataIds);
  if ([...metadataCandidates].some((id) => !hashesById.has(id))) {
    throw new Error('Cannot authorize unscoped query: invalid local read-authority candidate');
  }

  return async (id, readSignal) => {
    signal.throwIfAborted();
    readSignal.throwIfAborted();
    const hash = hashesById.get(id);
    const expectedRegistrationId = hash === undefined ? undefined : registeredNames.get(hash);
    if (expectedRegistrationId !== undefined) {
      // A fresh positive binding must not become an optimistic scalar miss or
      // a different binding, even if a local route appears during preparation.
      // The canonical resolver still reads live policy/roster/peer authority.
      return decide(id, readSignal, { registration: expectedRegistrationId });
    }
    if (
      hash === undefined
      || !absentNames.has(hash)
      || deps.registrationNameHash(id) !== hash
    ) return original(id, readSignal);
    return decide(id, readSignal, {
      registration: 'unregistered',
      isMetadataAbsent: () => !metadataCandidates.has(id)
        && deps.readMetadataRevision() === metadataRevision,
    });
  };
}
