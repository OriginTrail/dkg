// SPDX-License-Identifier: Apache-2.0

export type SparqlHttpConsistencyProfile =
  | 'best-effort'
  | 'atomic-update'
  | 'atomic-readback';

function normalizeConsistencyProfile(value: unknown): SparqlHttpConsistencyProfile {
  if (value === undefined) return 'best-effort';
  if (value === 'best-effort' || value === 'atomic-update' || value === 'atomic-readback') {
    return value;
  }
  throw new Error(
    'sparql-http consistencyProfile must be best-effort, atomic-update, or atomic-readback',
  );
}

export function resolveConsistencyProfile(
  options: { consistencyProfile?: SparqlHttpConsistencyProfile; atomicUpdates?: boolean },
): SparqlHttpConsistencyProfile {
  const profile = normalizeConsistencyProfile(options.consistencyProfile);
  if (options.atomicUpdates === undefined) return profile;

  const legacyProfile: SparqlHttpConsistencyProfile = options.atomicUpdates
    ? 'atomic-update'
    : 'best-effort';
  if (options.consistencyProfile === undefined) return legacyProfile;

  const compatible = options.atomicUpdates
    ? profile === 'atomic-update' || profile === 'atomic-readback'
    : profile === 'best-effort';
  if (!compatible) {
    throw new Error(
      'sparql-http atomicUpdates conflicts with consistencyProfile; remove the deprecated alias',
    );
  }
  return profile;
}

