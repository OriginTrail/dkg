// SPDX-License-Identifier: Apache-2.0

export type ContextGraphReadCheck = (id: string, signal: AbortSignal) => Promise<boolean>;

export interface UnscopedContextGraphReadCheckDependencies {
  canReadContextGraph: ContextGraphReadCheck;
  contextGraphNameCommitment(id: string): string;
  requiresIndividualRead(id: string): boolean;
  findContextGraphIdsWithReadAuthorityFacts(
    ids: readonly string[], signal: AbortSignal,
  ): Promise<ReadonlySet<string>>;
  readMetadataRevision(): number;
  resolveContextGraphIdsByNameHashes?: (
    nameHashes: readonly string[], options: { signal: AbortSignal },
  ) => Promise<ReadonlyMap<string, bigint | null>>;
}

class RegistrationBatchUnavailable extends Error {}

/**
 * Avoid per-KA cold lookups only for proven unregistered, metadata-free names.
 * Positive/known/restricted candidates retain the existing authority resolver.
 * The returned checker owns no persistent cache and accepts no caller grants.
 */
export async function prepareUnscopedContextGraphReadChecks(
  deps: UnscopedContextGraphReadCheckDependencies,
  ids: readonly string[],
  signal: AbortSignal,
): Promise<ContextGraphReadCheck> {
  signal.throwIfAborted();
  const original: ContextGraphReadCheck = async (id, readSignal) => {
    signal.throwIfAborted();
    readSignal.throwIfAborted();
    const allowed = await deps.canReadContextGraph(id, readSignal);
    signal.throwIfAborted();
    readSignal.throwIfAborted();
    return allowed;
  };
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
    if (deps.requiresIndividualRead(id)) continue;
    const hash = deps.contextGraphNameCommitment(id);
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
    return async (_id, readSignal) => {
      signal.throwIfAborted();
      readSignal.throwIfAborted();
      return false;
    };
  } finally {
    preparationStop.abort();
  }
  signal.throwIfAborted();

  // A missing, extra, or malformed result is uncertainty, never absence.
  const expected = new Set(names);
  const registrationMap = registrations as ReadonlyMap<string, bigint | null> | null;
  if (
    registrationMap === null
    || typeof registrationMap !== 'object'
    || !Number.isSafeInteger(registrationMap.size)
    || registrationMap.size < 0
    || typeof registrationMap[Symbol.iterator] !== 'function'
    || registrationMap.size !== expected.size
  ) {
    throw new Error('Cannot authorize unscoped query: incomplete Context Graph registration batch');
  }
  const absentNames = new Set<string>();
  for (const [name, id] of registrationMap) {
    if (!expected.has(name) || (id !== null && (
      typeof id !== 'bigint' || id <= 0n || id >= (1n << 256n)
    ))) {
      throw new Error('Cannot authorize unscoped query: invalid Context Graph registration batch');
    }
    if (id === null) absentNames.add(name);
  }
  const metadataCandidates = new Set(metadataIds);
  if ([...metadataCandidates].some((id) => !hashesById.has(id))) {
    throw new Error('Cannot authorize unscoped query: invalid local read-authority candidate');
  }

  return async (id, readSignal) => {
    signal.throwIfAborted();
    readSignal.throwIfAborted();
    const hash = hashesById.get(id);
    if (
      hash === undefined
      || !absentNames.has(hash)
      || metadataCandidates.has(id)
      || deps.readMetadataRevision() !== metadataRevision
      || deps.requiresIndividualRead(id)
    ) return original(id, readSignal);
    // This is the existing legacy-local-public fallback: current registration
    // was absent, and neither metadata nor runtime state can impose a gate.
    return true;
  };
}
