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

/**
 * Workspace-owner bookkeeping predicate. Stamped onto SWM quads during
 * ingestion to record which agent owns a shared-memory entry; it is NOT part
 * of the author's payload.
 */
export const WORKSPACE_OWNER_PREDICATE = 'http://dkg.io/ontology/workspaceOwner';

/**
 * A quad that lives in SWM but MUST be excluded from the KC merkle-root
 * recompute. Trust-level annotations and workspace-owner bookkeeping are added
 * by SWM ingestion, not by the author, so hashing them into the root diverges
 * the publisher's root from the core responder's on the exact same content.
 *
 * This is the SINGLE SOURCE OF TRUTH for that exclusion set: the publisher
 * (`DKGPublisher` SWM read) and the core responder (`StorageACKHandler`
 * `loadSWMQuads`) both filter on it, so the two recompute paths can never
 * drift — the drift being the 2026-07-07 `MERKLE_MISMATCH_IN_SWM` incident,
 * where the responder hashed trust-level/workspace-owner quads the publisher
 * had filtered out and declined every folded-private ACK.
 */
export function isSwmMerkleExcludedQuad(quad: Pick<TrustLevelQuadLike, 'predicate'>): boolean {
  return isTrustLevelQuad(quad) || quad.predicate === WORKSPACE_OWNER_PREDICATE;
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
