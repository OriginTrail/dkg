// Boundary validation for the quads the Knowledge Asset lifecycle write routes
// store: `POST /api/knowledge-assets` (create) and
// `POST /api/knowledge-assets/{name}/wm/write`. Both call
// `validateWritableQuads` before any create or write.

import {
  isAbsoluteIriTerm,
  isSafeBlankNodeLabel,
  isSafeIri,
  isSafeLiteralTerm,
} from '@origintrail-official/dkg-core';
import {
  WRITABLE_QUAD_TERMS,
  type KnowledgeAssetWritableQuad,
  type WritableTermKind,
} from '../knowledge-asset-write-contract.js';
import { validateWritableQuadLiteralSizes } from './http-utils.js';

/**
 * GH #306 / #787 — shape guard for the lifecycle write routes. The `graph`
 * term is OPTIONAL here: those routes legitimately accept `{subject,predicate,object}`
 * and fill the graph internally. Without this guard, a string-shaped quad
 * (e.g. an N-Quad line `"<s> <p> <o> ."`) slips past a bare `Array.isArray`
 * check and crashes the agent write path with a TypeError → HTTP 500 instead
 * of an actionable 4xx.
 */
export function isWritableQuad(value: unknown): value is KnowledgeAssetWritableQuad {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.subject === "string" &&
    typeof v.predicate === "string" &&
    typeof v.object === "string" &&
    (v.graph === undefined || typeof v.graph === "string")
  );
}

/** Classify a term exactly as written: no trimming, since nothing downstream trims. */
function writableTermKind(term: string): WritableTermKind | null {
  if (isSafeLiteralTerm(term)) return 'literal';
  if (isSafeBlankNodeLabel(term)) return 'blank-node';
  if (isAbsoluteIriTerm(term)) return 'iri';
  return null;
}

/**
 * GH #306 / #787 — the boundary check for quads a lifecycle write route stores
 * (create and wm/write): shape, then every term against
 * {@link WRITABLE_QUAD_TERMS} and an optional bare graph IRI, then literal
 * size. A string-shaped quad, a bare word, an unterminated literal or a
 * malformed IRI such as `urn:a b` or `…/na^me` would otherwise reach the store,
 * which either fails the write (HTTP 500), or, for characters it strips,
 * stores the triple under a different IRI. A literal carrying a raw line break
 * could even add statements of its own. Returns the 400 body for the first
 * failure, or null.
 */
export function validateWritableQuads(
  label: string,
  quads: unknown[],
): Record<string, unknown> | null {
  if (!quads.every(isWritableQuad)) {
    return {
      error: `"${label}" must be an array of { subject, predicate, object } objects (graph optional); string-shaped quads are not accepted`,
    };
  }
  for (const [index, quad] of quads.entries()) {
    for (const field of ['subject', 'predicate', 'object'] as const) {
      const rule = WRITABLE_QUAD_TERMS[field];
      const kind = writableTermKind(quad[field]);
      if (kind === null || !rule.accepts.includes(kind)) {
        return { error: `Invalid "${label}[${index}].${field}": RDF ${field} must be ${rule.expected}` };
      }
    }
    // The publisher writes a supplied graph as a bare IRI; empty means none.
    if (quad.graph !== undefined && quad.graph !== '' && !isSafeIri(quad.graph)) {
      return { error: `Invalid "${label}[${index}].graph": RDF graph must be an absolute IRI` };
    }
  }
  const literalSize = validateWritableQuadLiteralSizes(label, quads);
  return literalSize.ok ? null : literalSize.body;
}
