import canonize from 'rdf-canonize';
import { sha256 } from './hashing.js';
import { keccak256 } from './keccak.js';
import { canonicalizeObjectTermForHash } from './term-canon.js';

const textEncoder = new TextEncoder();

/**
 * Canonicalize an N-Quads string using the RDFC-1.0 algorithm (successor to URDNA2015).
 * Input and output are both N-Quads strings.
 */
export async function canonicalize(nquads: string): Promise<string> {
  return canonize.canonize(nquads, {
    algorithm: 'RDFC-1.0',
    inputFormat: 'application/n-quads',
    format: 'application/n-quads',
  });
}

/**
 * Return the RDFC-1.0 blank-node identifier mapping for an RDF dataset.
 *
 * The map keys and values omit the `_:` prefix (for example `b0 -> c14n0`).
 * Keeping this primitive in core prevents feature packages from inventing
 * label-order based "canonicalization", which is not invariant when a parser
 * or triple store assigns different blank-node labels to the same RDF graph.
 */
export async function canonicalBlankNodeIdMap(
  nquads: string,
): Promise<ReadonlyMap<string, string>> {
  const canonicalIdMap = new Map<string, string>();
  await canonize.canonize(nquads, {
    algorithm: 'RDFC-1.0',
    inputFormat: 'application/n-quads',
    format: 'application/n-quads',
    canonicalIdMap,
    // Bound pathological N-degree blank-node work. This is rdf-canonize's
    // linear work-factor guard and is also its safe default; spell it out so
    // this consensus boundary cannot silently become unbounded on upgrade.
    maxWorkFactor: 1,
  });
  return canonicalIdMap;
}

/**
 * Compute a deterministic hash for a single triple (s, p, o).
 * The graph component is excluded per spec — only subject, predicate, object participate.
 * The triple is formatted as a canonical N-Triple line before hashing.
 */
export function hashTriple(
  subject: string,
  predicate: string,
  object: string,
): Uint8Array {
  const ntriple = formatNTriple(subject, predicate, object);
  return sha256(textEncoder.encode(ntriple));
}

/**
 * Format a single triple as an N-Triple line (without graph, without trailing newline).
 * URIs are wrapped in angle brackets, literals and blank nodes are passed through.
 */
function formatNTriple(
  subject: string,
  predicate: string,
  object: string,
): string {
  const s = formatTerm(subject);
  const p = formatTerm(predicate);
  const o = formatTerm(object);
  return `${s} ${p} ${o} .`;
}

/**
 * Canonical V10 leaf CONTENT bytes for a triple — exactly the bytes the Random
 * Sampling prover submits to `submitProof(bytes content, ...)` and that the chain
 * hashes: `leaf = keccak256(tripleContentV10(s,p,o)) === hashTripleV10(s,p,o)`.
 * Single source of truth for the content<->leaf relationship (no drift).
 */
export function tripleContentV10(
  subject: string,
  predicate: string,
  object: string,
): Uint8Array {
  // Backend-independent leaf canonicalization (spec §9.0.2): the object literal
  // is normalized to its protocol-canonical value-space form BEFORE serialization
  // so the leaf — and the `content` bytes submitted on-chain — are identical on
  // every node regardless of triple-store backend or version. See term-canon.ts.
  return textEncoder.encode(
    formatNTriple(subject, predicate, canonicalizeObjectTermForHash(object)),
  );
}

/**
 * V10 triple hash using keccak256 (spec §9.0.2).
 * Used for V10 merkle trees that match on-chain Solidity verification.
 */
export function hashTripleV10(
  subject: string,
  predicate: string,
  object: string,
): Uint8Array {
  return keccak256(tripleContentV10(subject, predicate, object));
}

function formatTerm(term: string): string {
  if (term.startsWith('"')) return term; // literal (already N-Triples formatted)
  if (term.startsWith('_:')) return term; // blank node
  if (term.startsWith('<')) return term; // already wrapped
  return `<${term}>`; // bare URI -> wrap
}
