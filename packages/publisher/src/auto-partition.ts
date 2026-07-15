import type { Quad } from '@origintrail-official/dkg-storage';
import {
  assertSafeIri,
  assertSafeRdfTerm,
  canonicalBlankNodeIdMap,
} from '@origintrail-official/dkg-core';
import { skolemize, isSkolemizedUri, rootEntityFromSkolemized, isBlankNode } from './skolemize.js';

/**
 * Reserved skolem namespace for graph-scoped Knowledge Assets.
 *
 * The same skolem IRIs may occur in two independent KAs: their exact per-KA
 * named graphs provide the isolation that root-prefixed skolem IRIs used to
 * approximate. Callers must reject user-authored terms in this namespace.
 */
export const KNOWLEDGE_ASSET_SKOLEM_PREFIX = 'urn:dkg:ka-skolem:';
const CANONICAL_KA_SKOLEM_RE = /^urn:dkg:ka-skolem:c14n[0-9]+$/;

export interface SkolemizeKnowledgeAssetOptions {
  /** Internal retry/promotion reads may already contain our exact RDFC output. */
  allowCanonicalSkolemTerms?: boolean;
}

export interface SkolemizedKnowledgeAssetParts {
  readonly publicQuads: Quad[];
  readonly privateQuads: Quad[];
}

const PUBLIC_CANONICALIZATION_GRAPH = 'urn:dkg:ka-canonicalization:public';
const PRIVATE_CANONICALIZATION_GRAPH = 'urn:dkg:ka-canonicalization:private';

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
 * Canonicalise the public and private partitions of one KA in a single RDFC
 * dataset. Fixed internal graph names preserve the visibility boundary during
 * canonical labelling, while one shared blank-node map guarantees that the two
 * partitions cannot independently mint the same `c14nN` skolem identifier.
 * The graph names are discarded after canonicalisation and never become KA
 * content or Merkle leaves.
 */
export async function skolemizeKnowledgeAssetParts(
  publicQuads: readonly Quad[],
  privateQuads: readonly Quad[],
  options: SkolemizeKnowledgeAssetOptions = {},
): Promise<SkolemizedKnowledgeAssetParts> {
  const allQuads = [
    ...publicQuads.map((quad) => ({ quad, partition: 'public' as const })),
    ...privateQuads.map((quad) => ({ quad, partition: 'private' as const })),
  ];
  const blankNodes = new Set<string>();
  let sawCanonicalSkolemTerm = false;
  for (const { quad } of allQuads) {
    rejectReservedSkolemTerm(quad.subject, options.allowCanonicalSkolemTerms === true);
    // RDFC skolemization can only generate resources in subject/object position.
    rejectReservedSkolemTerm(quad.predicate, false);
    if (!quad.object.startsWith('"')) {
      rejectReservedSkolemTerm(quad.object, options.allowCanonicalSkolemTerms === true);
    }
    if (quad.graph) rejectReservedSkolemTerm(quad.graph, false);
    if (isBlankNode(quad.subject)) blankNodes.add(quad.subject);
    if (isBlankNode(quad.object)) blankNodes.add(quad.object);
    sawCanonicalSkolemTerm ||= isCanonicalSkolemTerm(quad.subject)
      || (!quad.object.startsWith('"') && isCanonicalSkolemTerm(quad.object));
  }
  if (blankNodes.size > 0 && sawCanonicalSkolemTerm) {
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
  if (blankNodes.size > 0) {
    const nquads = allQuads
      .map(({ quad, partition }) => quadToCanonicalizationNQuad(
        quad,
        partition === 'public'
          ? PUBLIC_CANONICALIZATION_GRAPH
          : PRIVATE_CANONICALIZATION_GRAPH,
      ))
      .join('\n');
    const canonicalIds = await canonicalBlankNodeIdMap(`${nquads}\n`);
    for (const blankNode of blankNodes) {
      const canonicalId = canonicalIds.get(blankNode.slice(2));
      if (!canonicalId) {
        throw new Error(`RDFC-1.0 did not assign a canonical identifier to ${blankNode}`);
      }
      mapping.set(blankNode, `${KNOWLEDGE_ASSET_SKOLEM_PREFIX}${canonicalId}`);
    }
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

function quadToCanonicalizationNQuad(quad: Quad, graph: string): string {
  return `${formatResource(quad.subject)} ${formatResource(quad.predicate)} ${formatObject(quad.object)} <${graph}> .`;
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

/**
 * Skolemizes blank nodes under their parent entity and INDEXES the result by
 * entity. It does NOT partition into Knowledge Assets — the name `autoPartition`
 * was a misnomer that led readers (and patches) to treat the entity index as a
 * list of KAs (OT-RFC-44 §4 / OT-RFC-43 §10.4). Under Design B one file = one KA
 * whose member entities are exactly the keys of this map.
 *
 * 1. Identifies root entities (non-blank, non-skolemized subjects)
 * 2. Skolemizes blank nodes under their parent entity (`<entity>/.well-known/genid/N`)
 * 3. Groups triples by entity: skolemized children belong to the entity whose
 *    URI is their prefix
 *
 * The skolemization is load-bearing for consensus (canonical subject hashes for
 * the flat Merkle, validation, the SWM gather, and the RS prover); the grouping
 * is just an index. Returns a Map of entity → Quad[].
 */
export function skolemizeByEntity(quads: Quad[]): Map<string, Quad[]> {
  // Phase 1: Find root entities (non-blank, non-skolemized unique subjects)
  const rootEntities = new Set<string>();
  for (const q of quads) {
    if (!isBlankNode(q.subject) && !isSkolemizedUri(q.subject)) {
      rootEntities.add(q.subject);
    }
  }

  // Phase 2: Skolemize blank nodes under their parent root entity.
  // For each blank node, we need to determine which root entity it belongs to.
  // Heuristic: a blank node belongs to the root entity that references it as an object.
  const blankToRoot = new Map<string, string>();
  for (const q of quads) {
    if (rootEntities.has(q.subject) && isBlankNode(q.object)) {
      blankToRoot.set(q.object, q.subject);
    }
  }

  // Propagate: blank nodes referenced by other blank nodes
  let changed = true;
  while (changed) {
    changed = false;
    for (const q of quads) {
      if (
        isBlankNode(q.subject) &&
        blankToRoot.has(q.subject) &&
        isBlankNode(q.object) &&
        !blankToRoot.has(q.object)
      ) {
        blankToRoot.set(q.object, blankToRoot.get(q.subject)!);
        changed = true;
      }
    }
  }

  // Skolemize per root entity
  const skolemized: Quad[] = [];
  const perRoot = new Map<string, Quad[]>();
  for (const root of rootEntities) {
    perRoot.set(root, []);
  }

  // Collect which quads belong to which root, skolemizing as we go
  const rootQuadsMap = new Map<string, Quad[]>();
  for (const root of rootEntities) {
    const rootQuads = quads.filter(
      (q) =>
        q.subject === root ||
        (isBlankNode(q.subject) && blankToRoot.get(q.subject) === root),
    );
    const sk = skolemize(root, rootQuads);
    rootQuadsMap.set(root, sk);
  }

  // Also handle already-skolemized quads (no blank nodes)
  for (const q of quads) {
    if (isSkolemizedUri(q.subject)) {
      const root = rootEntityFromSkolemized(q.subject);
      if (root && rootQuadsMap.has(root)) {
        rootQuadsMap.get(root)!.push(q);
      }
    }
  }

  return rootQuadsMap;
}

/**
 * @deprecated Misnomer — this skolemizes and indexes by entity; it does not
 * partition into Knowledge Assets (OT-RFC-44 §4). Use {@link skolemizeByEntity}.
 * Kept as an alias for one release so external consumers (test fixtures,
 * scripts) can migrate; will be removed once no callers reference it.
 */
export const autoPartition = skolemizeByEntity;
