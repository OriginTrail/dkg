import type { Quad } from '@origintrail-official/dkg-storage';
import {
  assertSafeIri,
  assertSafeRdfTerm,
  canonicalBlankNodeIdMap,
} from '@origintrail-official/dkg-core';
import { isBlankNode } from './skolemize.js';

/**
 * Reserved skolem namespace for graph-scoped Knowledge Assets.
 *
 * The same skolem IRIs may occur in two independent KAs: their exact per-KA
 * named graphs provide the isolation that root-prefixed skolem IRIs used to
 * approximate. Callers must reject user-authored terms in this namespace.
 */
export const KNOWLEDGE_ASSET_SKOLEM_PREFIX = 'urn:dkg:ka-skolem:';

/**
 * Sub-namespace for blank nodes that occur only in the private partition.
 * Disjoint from the public `c14nN` labels so the two independently
 * canonicalised partitions can never mint the same skolem IRI.
 */
export const KNOWLEDGE_ASSET_PRIVATE_SKOLEM_PREFIX = `${KNOWLEDGE_ASSET_SKOLEM_PREFIX}private:`;

const CANONICAL_KA_SKOLEM_RE = /^urn:dkg:ka-skolem:(?:private:)?c14n[0-9]+$/;

export interface SkolemizeKnowledgeAssetOptions {
  /** Internal retry/promotion reads may already contain our exact RDFC output. */
  allowCanonicalSkolemTerms?: boolean;
}

export interface SkolemizedKnowledgeAssetParts {
  readonly publicQuads: Quad[];
  readonly privateQuads: Quad[];
}

/** Reject every user-authored occurrence of the protocol's KA-local namespace. */
export function assertNoUserAuthoredKnowledgeAssetSkolemTerms(
  quads: readonly Quad[],
): void {
  for (const quad of quads) {
    rejectReservedSkolemTerm(quad.subject, false);
    rejectReservedSkolemTerm(quad.predicate, false);
    if (!quad.object.startsWith('"')) rejectReservedSkolemTerm(quad.object, false);
    if (quad.graph) rejectReservedSkolemTerm(quad.graph, false);
  }
}

/**
 * Canonicalise one complete Knowledge Asset as an RDF triple set.
 *
 * RDFC-1.0 assigns blank-node identifiers from graph structure, not from the
 * parser-local labels. The canonical labels are then replaced with a reserved
 * KA-local skolem namespace. Input graph terms are placement metadata and are
 * flattened: a v2 KA owns one exact named graph containing a set of `(s,p,o)`
 * triples. Duplicate triples are removed and the result is deterministically
 * ordered.
 *
 * The common no-blank-node path stays a small O(quads log quads) sort/dedupe.
 * RDFC-1.0 is invoked only when blank nodes are actually present and carries a
 * bounded work-factor guard in core.
 */
export async function skolemizeKnowledgeAsset(
  quads: readonly Quad[],
  options: SkolemizeKnowledgeAssetOptions = {},
): Promise<Quad[]> {
  return (
    await skolemizeKnowledgeAssetParts(quads, [], options)
  ).publicQuads;
}

/**
 * Canonicalise the public and private partitions of one KA.
 *
 * The public partition is canonicalised alone, so its skolem IRIs are a pure
 * function of public content: a private-only blank node can neither shift the
 * visible `c14nN` labels (which would change public Merkle leaves) nor leak
 * that hidden blank-node state exists. Blank nodes shared across the boundary
 * are grounded by their public label; only then are the remaining private-only
 * blank nodes canonicalised, into the disjoint `private:c14nN` sub-namespace,
 * so the two passes can never mint the same identifier.
 */
export async function skolemizeKnowledgeAssetParts(
  publicQuads: readonly Quad[],
  privateQuads: readonly Quad[],
  options: SkolemizeKnowledgeAssetOptions = {},
): Promise<SkolemizedKnowledgeAssetParts> {
  const allowCanonical = options.allowCanonicalSkolemTerms === true;
  const publicScan = scanPartition(publicQuads, allowCanonical);
  const privateScan = scanPartition(privateQuads, allowCanonical);
  if (
    (publicScan.blankNodes.size > 0 || privateScan.blankNodes.size > 0) &&
    (publicScan.sawCanonicalSkolemTerm || privateScan.sawCanonicalSkolemTerm)
  ) {
    // RDFC labels only the blank nodes and cannot see the existing skolem
    // IRIs, so it may re-mint an already-used c14nN for a fresh blank node.
    // The mapping would then conflate two distinct nodes and dedupe their
    // triples, silently changing Merkle content — fail closed instead.
    throw new Error(
      'Knowledge Asset input mixes canonical skolem IRIs with blank nodes; ' +
      'a retry payload must be either fully canonical or fully unlabelled',
    );
  }

  const mapping = new Map<string, string>();
  await assignCanonicalSkolemIds(
    publicQuads,
    publicScan.blankNodes,
    KNOWLEDGE_ASSET_SKOLEM_PREFIX,
    mapping,
  );
  const privateOnlyBlankNodes = new Set(
    [...privateScan.blankNodes].filter((blankNode) => !mapping.has(blankNode)),
  );
  if (privateOnlyBlankNodes.size > 0) {
    // Shared blank nodes become ground public skolem IRIs before the private
    // pass, so private-only labels stay anchored to the boundary structure
    // without being able to influence (or collide with) the public labels.
    const grounded = privateQuads.map((quad) => substituteMappedTerms(quad, mapping));
    await assignCanonicalSkolemIds(
      grounded,
      privateOnlyBlankNodes,
      KNOWLEDGE_ASSET_PRIVATE_SKOLEM_PREFIX,
      mapping,
    );
  }

  const normalizePartition = (quads: readonly Quad[]): Quad[] => {
    const byTriple = new Map<string, Quad>();
    for (const quad of quads) {
      const normalized: Quad = {
        subject: mapping.get(quad.subject) ?? unwrapIri(quad.subject),
        predicate: unwrapIri(quad.predicate),
        object: mapping.get(quad.object) ?? normalizeObject(quad.object),
        graph: '',
      };
      const key = JSON.stringify([
        normalized.subject,
        normalized.predicate,
        normalized.object,
      ]);
      byTriple.set(key, normalized);
    }

    return [...byTriple.entries()]
      // Do not use localeCompare at a consensus boundary: ICU locale/version
      // differences can order the same Unicode RDF terms differently across
      // nodes. JavaScript's relational comparison is deterministic UTF-16
      // code-unit order on every runtime.
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([, quad]) => quad);
  };

  return {
    publicQuads: normalizePartition(publicQuads),
    privateQuads: normalizePartition(privateQuads),
  };
}

interface PartitionScan {
  readonly blankNodes: Set<string>;
  readonly sawCanonicalSkolemTerm: boolean;
}

function scanPartition(quads: readonly Quad[], allowCanonical: boolean): PartitionScan {
  const blankNodes = new Set<string>();
  let sawCanonicalSkolemTerm = false;
  for (const quad of quads) {
    rejectReservedSkolemTerm(quad.subject, allowCanonical);
    // RDFC skolemization can only generate resources in subject/object position.
    rejectReservedSkolemTerm(quad.predicate, false);
    if (!quad.object.startsWith('"')) {
      rejectReservedSkolemTerm(quad.object, allowCanonical);
    }
    if (quad.graph) rejectReservedSkolemTerm(quad.graph, false);
    if (isBlankNode(quad.subject)) blankNodes.add(quad.subject);
    if (isBlankNode(quad.object)) blankNodes.add(quad.object);
    sawCanonicalSkolemTerm ||= isCanonicalSkolemTerm(quad.subject)
      || (!quad.object.startsWith('"') && isCanonicalSkolemTerm(quad.object));
  }
  return { blankNodes, sawCanonicalSkolemTerm };
}

/**
 * RDFC-1.0 over one partition's triples (placement graph terms are metadata
 * and already flattened), assigning `<skolemPrefix><c14nN>` to each listed
 * blank node.
 */
async function assignCanonicalSkolemIds(
  quads: readonly Quad[],
  blankNodes: ReadonlySet<string>,
  skolemPrefix: string,
  mapping: Map<string, string>,
): Promise<void> {
  if (blankNodes.size === 0) return;
  const nquads = quads
    .map((quad) => quadToCanonicalizationNQuad(quad))
    .join('\n');
  const canonicalIds = await canonicalBlankNodeIdMap(`${nquads}\n`);
  for (const blankNode of blankNodes) {
    const canonicalId = canonicalIds.get(blankNode.slice(2));
    if (!canonicalId) {
      throw new Error(`RDFC-1.0 did not assign a canonical identifier to ${blankNode}`);
    }
    mapping.set(blankNode, `${skolemPrefix}${canonicalId}`);
  }
}

function substituteMappedTerms(quad: Quad, mapping: ReadonlyMap<string, string>): Quad {
  return {
    ...quad,
    subject: mapping.get(quad.subject) ?? quad.subject,
    object: quad.object.startsWith('"')
      ? quad.object
      : mapping.get(quad.object) ?? quad.object,
  };
}

function isCanonicalSkolemTerm(term: string): boolean {
  return CANONICAL_KA_SKOLEM_RE.test(unwrapIri(term));
}

function rejectReservedSkolemTerm(term: string, allowCanonical: boolean): void {
  const bare = unwrapIri(term);
  if (bare.toLowerCase().startsWith(KNOWLEDGE_ASSET_SKOLEM_PREFIX)) {
    if (allowCanonical && CANONICAL_KA_SKOLEM_RE.test(bare)) return;
    throw Object.assign(
      new Error(
        `RDF term ${term} uses the protocol-reserved KA skolem namespace ` +
        KNOWLEDGE_ASSET_SKOLEM_PREFIX,
      ),
      { code: 'KA_SKOLEM_NAMESPACE_RESERVED' },
    );
  }
}

function quadToCanonicalizationNQuad(quad: Quad): string {
  return `${formatResource(quad.subject)} ${formatResource(quad.predicate)} ${formatObject(quad.object)} .`;
}

function formatResource(term: string): string {
  if (isBlankNode(term)) return term;
  const iri = unwrapIri(term);
  assertSafeIri(iri);
  return `<${iri}>`;
}

function formatObject(term: string): string {
  if (term.startsWith('"')) {
    const normalized = normalizeObject(term);
    assertSafeRdfTerm(normalized);
    return normalized;
  }
  return formatResource(term);
}

function normalizeObject(term: string): string {
  if (!term.startsWith('"')) return unwrapIri(term);
  const bareDatatype = term.match(/^("(?:[^"\\]|\\.)*")\^\^(?!<)(.+)$/);
  return bareDatatype
    ? `${bareDatatype[1]}^^<${unwrapIri(bareDatatype[2])}>`
    : term;
}

function unwrapIri(term: string): string {
  return term.startsWith('<') && term.endsWith('>') ? term.slice(1, -1) : term;
}
