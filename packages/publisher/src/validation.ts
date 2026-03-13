import type { Quad } from '@origintrail-official/dkg-storage';
import type { KAManifestEntry } from './publisher.js';
import { isBlankNode, isSkolemizedUri, rootEntityFromSkolemized } from './skolemize.js';

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export interface ValidationOptions {
  /** When true, skip Rule 4 for entities the current writer owns (listed in upsertableEntities). */
  allowUpsert?: boolean;
  /** Root entities the current writer is allowed to upsert (creator-only). */
  upsertableEntities?: Set<string>;
}

/**
 * Validates a publish request against the 8 rules from the spec.
 */
export function validatePublishRequest(
  nquads: Quad[],
  manifest: KAManifestEntry[],
  paranetId: string,
  existingEntities: Set<string>,
  options?: ValidationOptions,
): ValidationResult {
  const errors: string[] = [];
  const paranetGraph = `did:dkg:paranet:${paranetId}`;
  const rootEntities = new Set(manifest.map((m) => m.rootEntity));

  // Rule 1: Every quad's named graph MUST be the target paranet URI.
  for (const q of nquads) {
    if (q.graph && q.graph !== paranetGraph) {
      errors.push(
        `Rule 1: Quad graph "${q.graph}" does not match paranet "${paranetGraph}"`,
      );
    }
  }

  // Rule 2: Every triple's subject MUST be a rootEntity from the manifest
  // OR a skolemized URI whose prefix matches a rootEntity.
  for (const q of nquads) {
    const s = q.subject;
    if (rootEntities.has(s)) continue;
    if (isSkolemizedUri(s)) {
      const root = rootEntityFromSkolemized(s);
      if (root && rootEntities.has(root)) continue;
    }
    errors.push(
      `Rule 2: Subject "${s}" is not a rootEntity and not a skolemized child of one`,
    );
  }

  // Rule 3: Every manifest entry's rootEntity MUST appear as a subject in nquads
  // UNLESS it's a fully private KA (privateTripleCount > 0, no public triples).
  for (const m of manifest) {
    const hasPublicTriples = nquads.some(
      (q) =>
        q.subject === m.rootEntity ||
        (isSkolemizedUri(q.subject) &&
          rootEntityFromSkolemized(q.subject) === m.rootEntity),
    );
    const isFullyPrivate =
      (m.privateTripleCount ?? 0) > 0 && !hasPublicTriples;
    if (!hasPublicTriples && !isFullyPrivate) {
      errors.push(
        `Rule 3: rootEntity "${m.rootEntity}" has no triples in nquads`,
      );
    }
  }

  // Rule 4: Entity exclusivity — no rootEntity may already exist in this paranet.
  // With allowUpsert, the original creator can overwrite their own workspace entities.
  for (const m of manifest) {
    if (existingEntities.has(m.rootEntity)) {
      if (options?.allowUpsert && options.upsertableEntities?.has(m.rootEntity)) {
        continue;
      }
      errors.push(
        `Rule 4: rootEntity "${m.rootEntity}" already exists in paranet "${paranetId}"`,
      );
    }
  }

  // Rule 5: No blank node subjects in nquads (must be skolemized).
  for (const q of nquads) {
    if (isBlankNode(q.subject)) {
      errors.push(
        `Rule 5: Blank node subject "${q.subject}" found — must be skolemized before submission`,
      );
    }
  }

  return { valid: errors.length === 0, errors };
}
