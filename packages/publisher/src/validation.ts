import type { Quad } from '@origintrail-official/dkg-storage';
import { assertSafeRdfTerm, isSafeIri } from '@origintrail-official/dkg-core';
import type { KAManifestEntry } from './publisher.js';
import { isBlankNode, isSkolemizedUri, rootEntityFromSkolemized } from './skolemize.js';
import {
  catalogTripleKey,
  trustedCatalogTripleKeySet,
  type TrustedCatalogTripleKeys,
} from './catalog-trust.js';
import { KNOWLEDGE_ASSET_SKOLEM_PREFIX } from './auto-partition.js';

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export interface ValidationOptions {
  /** When true, skip Rule 4 for entities the current writer owns (listed in upsertableEntities). */
  allowUpsert?: boolean;
  /** Root entities the current writer is allowed to upsert (creator-only). */
  upsertableEntities?: Set<string>;
  /** Override the expected named graph URI for Rule 1 (default: `did:dkg:context-graph:{contextGraphId}`). */
  expectedGraph?: string;
  /**
   * Exact generated public-catalog triples allowed to be present in nquads
   * without a manifest root. This is not a generic metadata bypass.
   */
  trustedNonManifestCatalogTriples?: TrustedCatalogTripleKeys;
}

/**
 * Validate one complete graph-scoped KA payload.
 *
 * Unlike {@link validatePublishRequest}, RDF subjects are ordinary KA data:
 * they do not define storage ownership or membership. The control-plane
 * identity is the UAL plus assertion version carried by the v2 envelope.
 */
export function validateKnowledgeAssetPublishRequest(
  nquads: readonly Quad[],
  expectedGraph: string,
  publicTripleCount: number,
  options: { allowCanonicalSkolemTerms?: boolean } = {},
): ValidationResult {
  const errors: string[] = [];

  if (!Number.isSafeInteger(publicTripleCount) || publicTripleCount < 0) {
    errors.push(
      `Graph-scoped KA publicTripleCount must be a non-negative safe integer, got ${publicTripleCount}`,
    );
  } else if (nquads.length !== publicTripleCount) {
    errors.push(
      `Graph-scoped KA public triple count mismatch: envelope=${publicTripleCount}, parsed=${nquads.length}`,
    );
  }

  if (!isSafeIri(expectedGraph)) {
    errors.push(`Graph-scoped KA expected graph is not a safe IRI: ${expectedGraph}`);
  }

  for (const [index, quad] of nquads.entries()) {
    if (quad.graph !== expectedGraph) {
      errors.push(
        `Graph-scoped KA quad ${index} graph "${quad.graph}" does not match expected graph "${expectedGraph}"`,
      );
    }
    if (isBlankNode(quad.subject)) {
      errors.push(
        `Graph-scoped KA quad ${index} has blank-node subject "${quad.subject}"; ` +
        'the sender must canonicalize blank nodes before transmission',
      );
    } else if (!isSafeIri(quad.subject)) {
      errors.push(`Graph-scoped KA quad ${index} has an unsafe subject IRI`);
    } else if (isForbiddenKnowledgeAssetSkolemTerm(quad.subject, options)) {
      errors.push(`Graph-scoped KA quad ${index} uses the reserved KA skolem namespace in its subject`);
    }
    if (!isSafeIri(quad.predicate)) {
      errors.push(`Graph-scoped KA quad ${index} has an unsafe predicate IRI`);
    } else if (quad.predicate.toLowerCase().startsWith(KNOWLEDGE_ASSET_SKOLEM_PREFIX)) {
      errors.push(`Graph-scoped KA quad ${index} uses the reserved KA skolem namespace in its predicate`);
    }
    if (isBlankNode(quad.object)) {
      errors.push(
        `Graph-scoped KA quad ${index} has blank-node object "${quad.object}"; ` +
        'the sender must canonicalize blank nodes before transmission',
      );
    } else {
      try {
        assertSafeRdfTerm(
          quad.object.startsWith('"') ? quad.object : `<${quad.object}>`,
        );
      } catch {
        errors.push(`Graph-scoped KA quad ${index} has an unsafe RDF object`);
      }
      if (
        !quad.object.startsWith('"')
        && isForbiddenKnowledgeAssetSkolemTerm(quad.object, options)
      ) {
        errors.push(`Graph-scoped KA quad ${index} uses the reserved KA skolem namespace in its object`);
      }
    }
    if (quad.graph.toLowerCase().startsWith(KNOWLEDGE_ASSET_SKOLEM_PREFIX)) {
      errors.push(`Graph-scoped KA quad ${index} uses the reserved KA skolem namespace as its graph`);
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validate a canonical graph-scoped KA at a trusted protocol boundary.
 *
 * Graph-scoped senders canonicalize Markdown and other RDF blank nodes before
 * transmission, so exact public `urn:dkg:ka-skolem:c14nN` terms are standard
 * wire data. User-authored input should continue to use the strict validator
 * above; this named policy keeps receiver/update/ACK call sites consistent
 * while still rejecting blank nodes and every private, forged, predicate, or
 * graph use of the reserved namespace.
 */
export function validateCanonicalGraphScopedKnowledgeAssetPayload(
  nquads: readonly Quad[],
  expectedGraph: string,
  publicTripleCount: number,
): ValidationResult {
  return validateKnowledgeAssetPublishRequest(
    nquads,
    expectedGraph,
    publicTripleCount,
    { allowCanonicalSkolemTerms: true },
  );
}

function isForbiddenKnowledgeAssetSkolemTerm(
  term: string,
  options: { allowCanonicalSkolemTerms?: boolean },
): boolean {
  if (!term.toLowerCase().startsWith(KNOWLEDGE_ASSET_SKOLEM_PREFIX)) return false;
  return !(
    options.allowCanonicalSkolemTerms === true
    && /^urn:dkg:ka-skolem:c14n[0-9]+$/.test(term)
  );
}

/**
 * Validates a publish request against the 8 rules from the spec.
 */
export function validatePublishRequest(
  nquads: Quad[],
  manifest: KAManifestEntry[],
  contextGraphId: string,
  existingEntities: Set<string>,
  options?: ValidationOptions,
): ValidationResult {
  const errors: string[] = [];
  const contextGraph = options?.expectedGraph ?? `did:dkg:context-graph:${contextGraphId}`;
  const rootEntities = new Set(manifest.map((m) => m.rootEntity));
  const trustedCatalogTriples = trustedCatalogTripleKeySet(
    options?.trustedNonManifestCatalogTriples,
  );

  // Rule 1: Every quad's named graph MUST be the target context graph URI
  // (or the sub-graph URI when expectedGraph is overridden).
  for (const q of nquads) {
    if (q.graph && q.graph !== contextGraph) {
      errors.push(
        `Rule 1: Quad graph "${q.graph}" does not match context graph "${contextGraph}"`,
      );
    }
  }

  // Rule 2: Every triple's subject MUST be a rootEntity from the manifest
  // OR a skolemized URI whose prefix matches a rootEntity.
  for (const q of nquads) {
    if (trustedCatalogTriples.has(catalogTripleKey(q))) continue;
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

  // Rule 4: Entity exclusivity — no rootEntity may already exist in this context graph.
  // With allowUpsert, the original creator can overwrite their own shared memory entities.
  for (const m of manifest) {
    if (existingEntities.has(m.rootEntity)) {
      if (options?.allowUpsert && options.upsertableEntities?.has(m.rootEntity)) {
        continue;
      }
      errors.push(
        `Rule 4: rootEntity "${m.rootEntity}" already exists in context graph "${contextGraphId}". ` +
        `Use /api/update with the existing kaId to modify it, or use a unique rootEntity URI.`,
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
