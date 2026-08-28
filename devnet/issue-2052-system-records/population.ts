import type {
  CharacterizationFixtureV1,
  RedactedProfileEvidenceV1,
} from './model.js';

export interface ProfilePopulationRecordV1 {
  readonly root: string;
  readonly peerKeys: readonly string[];
  readonly freshness: 'active' | 'stale' | 'unknown';
}

export function deriveProfilePopulationV1(
  records: readonly ProfilePopulationRecordV1[],
  profiles: readonly RedactedProfileEvidenceV1[],
): CharacterizationFixtureV1['profilePopulation'] {
  const roots = new Set<string>();
  const peerToRoots = new Map<string, Set<string>>();
  for (const record of records) {
    if (roots.has(record.root)) throw new TypeError('population roots must be unique');
    roots.add(record.root);
    for (const peerKey of new Set(record.peerKeys)) {
      const peerRoots = peerToRoots.get(peerKey) ?? new Set<string>();
      peerRoots.add(record.root);
      peerToRoots.set(peerKey, peerRoots);
    }
  }
  return {
    observedRoots: roots.size,
    observedPeerKeys: peerToRoots.size,
    activeRoots: records.filter((record) => record.freshness === 'active').length,
    activeProfiles: profiles.length,
    candidateProfiles: profiles.filter((profile) => profile.disposition === 'candidate').length,
    ambiguousProfiles: profiles.filter((profile) => profile.disposition !== 'candidate').length,
    staleProfiles: records.filter((record) => record.freshness === 'stale').length,
    unknownFreshnessProfiles: records.filter((record) => record.freshness === 'unknown').length,
    missingPeerRoots: records.filter((record) => record.peerKeys.length === 0).length,
    duplicatePeerKeys: [...peerToRoots.values()].filter((peerRoots) => peerRoots.size > 1).length,
    sharedRootSubjects: records.filter((record) => new Set(record.peerKeys).size > 1).length,
    detailedProfileScope: 'active',
  };
}
