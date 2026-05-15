import { TrustLevel } from './memory-model.js';

export const TRUST_LEVEL_PREDICATE = 'http://dkg.io/ontology/trustLevel';
export const LEGACY_TRUST_LEVEL_PREDICATE = 'https://dkg.network/ontology#trustLevel';
export const TRUST_LEVEL_VALUES = [
  TrustLevel.SelfAttested,
  TrustLevel.Endorsed,
  TrustLevel.PartiallyVerified,
  TrustLevel.ConsensusVerified,
] as const;

const TRUST_LEVEL_PREDICATES = new Set([
  TRUST_LEVEL_PREDICATE,
  LEGACY_TRUST_LEVEL_PREDICATE,
]);

type TrustLevelQuadLike = {
  subject: string;
  predicate: string;
  object: string;
  graph: string;
};

export function isTrustLevelQuad(quad: Pick<TrustLevelQuadLike, 'predicate'>): boolean {
  return TRUST_LEVEL_PREDICATES.has(quad.predicate);
}

export function isTrustLevel(value: unknown): value is TrustLevel {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    (TRUST_LEVEL_VALUES as readonly number[]).includes(value);
}

function trustLevelLiteral(level: TrustLevel): string {
  if (!isTrustLevel(level)) {
    throw new Error(`Invalid TrustLevel ${String(level)}`);
  }
  return `"${level}"^^<http://www.w3.org/2001/XMLSchema#integer>`;
}

export function buildTrustLevelQuads(
  subjects: Iterable<string>,
  level: TrustLevel,
  graph: string,
): TrustLevelQuadLike[] {
  const uniqueSubjects = [...new Set([...subjects].filter(Boolean))];
  return uniqueSubjects.map((subject) => ({
    subject,
    predicate: TRUST_LEVEL_PREDICATE,
    object: trustLevelLiteral(level),
    graph,
  }));
}

export function assertNoUserAuthoredTrustLevelQuads(
  quads: Iterable<Pick<TrustLevelQuadLike, 'subject' | 'predicate'>>,
): void {
  for (const quad of quads) {
    if (isTrustLevelQuad(quad)) {
      throw new Error(
        `User-authored dkg:trustLevel metadata is not allowed for subject ${quad.subject}. ` +
        'Trust metadata is protocol-generated after publish, endorse, or verify confirmation.',
      );
    }
  }
}
