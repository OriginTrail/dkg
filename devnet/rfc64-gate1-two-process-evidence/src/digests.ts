import { canonicalize, sha256Hex, UTF8 } from './canonical.ts';
import type { QuadV1 } from './schema.ts';

// Domain-separated so no digest in the chain can collide with another stage or
// with a bare content hash. Versioned so the algorithm can evolve unambiguously.
const QUAD_LEAF_DOMAIN = 'rfc64-gate1-two-process-evidence:quad-leaf:v1\n';
const CONTENT_DOMAIN = 'rfc64-gate1-two-process-evidence:content:v1\n';
const BUNDLE_DOMAIN = 'rfc64-gate1-two-process-evidence:bundle:v1\n';
const ROW_DOMAIN = 'rfc64-gate1-two-process-evidence:row:v1\n';
const HEAD_DOMAIN = 'rfc64-gate1-two-process-evidence:head:v1\n';

/** The all-zero digest that terminates the head chain at genesis. */
export const GENESIS_HEAD_DIGEST = '0'.repeat(64);

/** Canonical serialization of one quad, used both for ordering and for hashing. */
export function canonicalQuad(quad: QuadV1): string {
  return canonicalize({
    graph: quad.graph,
    object: quad.object,
    predicate: quad.predicate,
    subject: quad.subject,
  });
}

/**
 * Total canonical order over quads: ascending by canonical serialization. The
 * verifier requires the evidence array to already be in this order, so a
 * complete-but-misordered quad set is still rejected.
 */
export function compareQuads(a: QuadV1, b: QuadV1): number {
  const left = canonicalQuad(a);
  const right = canonicalQuad(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

function quadLeafHex(quad: QuadV1): string {
  return sha256Hex(UTF8.encode(QUAD_LEAF_DOMAIN + canonicalQuad(quad)));
}

/**
 * Order-independent commitment to the quad SET: hash the sorted leaf digests
 * under a domain tag with an explicit count prefix, so two different partitions
 * can never concatenate to the same preimage.
 */
export function computeContentDigest(quads: readonly QuadV1[]): string {
  const sortedLeaves = quads.map(quadLeafHex).sort();
  const preimage = `${CONTENT_DOMAIN}${sortedLeaves.length}\n${sortedLeaves.join('\n')}`;
  return sha256Hex(UTF8.encode(preimage));
}

/** Bundle digest binds the content digest to the exact serialized byte length. */
export function computeBundleDigest(contentDigest: string, bundleLength: number): string {
  const preimage = `${BUNDLE_DOMAIN}${canonicalize({ bundleLength, contentDigest })}`;
  return sha256Hex(UTF8.encode(preimage));
}

/** Row digest binds identity (UAL) to the content/bundle commitments and count. */
export function computeRowDigest(input: {
  readonly ual: string;
  readonly contentDigest: string;
  readonly bundleDigest: string;
  readonly bundleLength: number;
  readonly quadCount: number;
}): string {
  const preimage = `${ROW_DOMAIN}${canonicalize({
    bundleDigest: input.bundleDigest,
    bundleLength: input.bundleLength,
    contentDigest: input.contentDigest,
    quadCount: input.quadCount,
    ual: input.ual,
  })}`;
  return sha256Hex(UTF8.encode(preimage));
}

/**
 * Head digest chains the previous head to this row at an explicit sequence, so
 * a row cannot be replayed at a different position or reordered in the chain.
 */
export function computeHeadDigest(input: {
  readonly previousHeadDigest: string;
  readonly rowDigest: string;
  readonly headSequence: number;
}): string {
  const preimage = `${HEAD_DOMAIN}${canonicalize({
    headSequence: input.headSequence,
    previousHeadDigest: input.previousHeadDigest,
    rowDigest: input.rowDigest,
  })}`;
  return sha256Hex(UTF8.encode(preimage));
}
