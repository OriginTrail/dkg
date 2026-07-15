import {
  assertSafeIri,
  contextGraphDataUri,
  contextGraphMetaUri,
  contextGraphLayerUri,
  contextGraphSubGraphUri,
  createGraphKnowledgeAssetScope,
  GRAPH_KA_CONTENT_SCOPE_VERSION,
  knowledgeAssetLayerGraphUri,
  validateSubGraphName,
  MemoryLayer,
  hashTripleV10,
  TRUST_LEVEL_PREDICATE,
  LEGACY_TRUST_LEVEL_PREDICATE,
} from '@origintrail-official/dkg-core';
import type { Quad, TripleStore } from '@origintrail-official/dkg-storage';

const DKG = 'http://dkg.io/ontology/';
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const ONTOLOGY_GRAPH = 'did:dkg:context-graph:ontology';
const CONTEXT_GRAPH_ON_CHAIN_ID = 'https://dkg.network/ontology#ContextGraphOnChainId';
const CG_URI_PREFIX = 'did:dkg:context-graph:';

/**
 * Predicates that are stamped onto the data graph by the daemon AFTER a
 * KC has been published (verify-quorum's `dkg:trustLevel` write being the
 * canonical case). These are NOT part of the KC's commit-time leaf set
 * and must be excluded from extraction so the recomputed leaf set stays
 * bit-identical with the publisher's `merkleLeafCount`. Without this
 * filter, every single-node publish (which falls into
 * `stampBatchTrustLevel(..., SelfAttested)` because no remote ACK
 * lands) corrupts the prover with `V10ProofLeafCountMismatchError`.
 * The publisher already refuses user-authored trustLevel triples via
 * `assertNoUserAuthoredTrustLevelQuads`, so excluding them here is safe.
 */
export const POST_PUBLISH_PREDICATES_TO_SKIP: ReadonlySet<string> = new Set([
  TRUST_LEVEL_PREDICATE,
  LEGACY_TRUST_LEVEL_PREDICATE,
]);

/**
 * Quads pulled from the local triple store, post-publish, in the same
 * (subject, predicate, object) shape the V10 hash function consumes.
 * Graph IRI is intentionally absent — V10 leaves never include it
 * (`hashTripleV10` is `keccak256("<s> <p> <o> .")`).
 */
export interface KCTriple {
  subject: string;
  predicate: string;
  object: string;
  /**
   * Source graph the triple was actually read from (the per-cgId data graph,
   * the per-KA VM layer, or the bare sub-graph graph — #1367). Additive; the
   * V10 leaf hash excludes the graph, so this never affects proving — it exists
   * so `extractV10KCQuads` can report the true graph instead of rewriting every
   * row to the per-cgId data graph.
   */
  graph?: string;
}

export interface KCExtractionResult {
  /** Local context graph name resolved from the on-chain numeric id. */
  contextGraphName: string;
  /** Data graph URI that contained the public triples. */
  dataGraph: string;
  /**
   * Sub-graph the KA's content was found in, or `undefined` for a CG-root KA
   * (#1367). Discovered from `dkg:subGraphName` in `_meta`; lets the dRAG
   * citation path see which sub-graph was resolved. Additive — pre-existing
   * readers ignore it.
   */
  subGraphName?: string;
  /** UAL of the KC discovered via `dkg:batchId == kaId`. */
  ual: string;
  /** Root entities for each KA, in stable (sorted) order. */
  rootEntities: string[];
  /** Public triples that feed the V10 leaf set, in store-emit order. */
  triples: KCTriple[];
  /**
   * Private sub-root hashes recorded in `_meta` for each KA that has
   * one, in stable (sorted KA URI) order. Each entry is the raw 32-byte
   * keccak hash, ready to drop into the V10 leaf set as a synthetic
   * leaf alongside the public-triple leaves.
   */
  privateRoots: Uint8Array[];
  /**
   * V10 flat-KC leaves: `triples.map(hashTripleV10)` followed by
   * `privateRoots`. Hand directly to `buildV10ProofMaterial` from
   * `@origintrail-official/dkg-core` — the constructor sorts +
   * deduplicates, so callers can pass them unsorted.
   */
  leaves: Uint8Array[];
}

/**
 * Thrown when the on-chain `kaId` has no UAL recorded in the local
 * `_meta` graph for `cgId`. Almost always indicates the prover has not
 * yet synced this CG to the head; callers SHOULD skip the period and
 * trigger a sync, not retry the same proof.
 */
export class KCNotFoundError extends Error {
  readonly name = 'KCNotFoundError';
  constructor(readonly contextGraphId: bigint, readonly kaId: bigint) {
    super(`KC ${kaId} not found in _meta for context graph ${contextGraphId}`);
  }
}

/**
 * Thrown when the resolved UAL is present in `_meta` but no
 * `dkg:rootEntity` triples are linked to it. This is a meta-graph
 * integrity bug — the publisher must record at least one root entity
 * per KA — and the prover SHOULD log loudly rather than fabricate.
 */
export class KCRootEntitiesNotFoundError extends Error {
  readonly name = 'KCRootEntitiesNotFoundError';
  constructor(readonly contextGraphId: bigint, readonly kaId: bigint, readonly ual: string) {
    super(
      `KC ${kaId} (UAL ${ual}) in cg ${contextGraphId} has no dkg:rootEntity ` +
      `triples in _meta; meta-graph corruption or partial sync`,
    );
  }
}

/**
 * Thrown when the root entities resolve but the CG data graph yields
 * zero public triples for them. Caused by a sync gap between meta and
 * data graphs (data sync still in flight, or a sharded peer that owns
 * the KA we need). The Phase 3b mutual-aid path will live behind this
 * — for now the prover skips the period.
 */
export class KCDataMissingError extends Error {
  readonly name = 'KCDataMissingError';
  constructor(
    readonly contextGraphId: bigint,
    readonly kaId: bigint,
    readonly ual: string,
    readonly rootEntities: string[],
  ) {
    super(
      `KC ${kaId} (UAL ${ual}) has root entities ${JSON.stringify(rootEntities)} ` +
      `but CG data graph for cg ${contextGraphId} returned zero triples`,
    );
  }
}

/**
 * Resolve a KC's canonical V10 leaf set from a local `TripleStore`.
 *
 * Recipe (mirrors the publisher's publish path bit-for-bit so the
 * Merkle root is reproducible):
 *
 * 1. Map the on-chain `cgId` (numeric) to the local CG **name** via the
 *    ontology graph — `<did:dkg:context-graph:ontology>` carries
 *    `<cgUri> dkg.network/ontology#ContextGraphOnChainId "<cgId>"` triples
 *    written by `agent.registerContextGraph`. The publisher's V10
 *    "remap" flow then writes data under
 *    `did:dkg:context-graph:<NAME>/context/<cgId>` (and `.../_meta`),
 *    so the extractor MUST resolve the name before reading. Without
 *    the name lookup we'd query `did:dkg:context-graph:<cgId>/_meta`,
 *    which is a different URI than the one the publisher writes.
 *
 * 2. Resolve the KC's UAL from `_meta`: `?ual dkg:batchId "<kaId>"^^xsd:integer`.
 *    Mirrors `resolveUalByBatchId` in `@origintrail-official/dkg-publisher`
 *    (inlined here to avoid a publisher dep).
 *
 * 3. List KAs: `?ka dkg:partOf <ual>`. For each KA, read `dkg:rootEntity`
 *    (one per KA) and `dkg:privateMerkleRoot` (zero-or-one, hex literal).
 *
 * 4. CONSTRUCT public triples from `dataGraph` filtered by each root +
 *    its `<root>/.well-known/genid/` skolemized blank-node descendants.
 *    Same SPARQL shape the publisher used to assemble the SWM payload.
 *
 * 5. Compute V10 leaves: `triples.map(hashTripleV10)` + `privateRoots`.
 *    `V10MerkleTree` (used by `buildV10ProofMaterial`) sorts +
 *    deduplicates internally, so callers do not need to pre-sort.
 *
 * Throws {@link KCNotFoundError}, {@link KCRootEntitiesNotFoundError},
 * or {@link KCDataMissingError} on the named failure modes — each is a
 * skip-this-period signal for the prover, not a retry.
 *
 * #1367 — sub-graph awareness. A KA published into a named sub-graph is
 * sampled under the PARENT cgId (the chain has no sub-graph dimension) but
 * its public data does NOT live in the per-cgId data graph above: the
 * author keeps it in the per-KA verifiable-memory layer
 * (`<cg>/<sub>/_verifiable_memory/<author>/<number>`) and a replica keeps
 * it in the bare sub-graph graph (`<cg>/<sub>`). When the per-cgId graph
 * yields nothing for a root we DISCOVER the sub-graph name from `_meta`
 * (read-both: the per-cgId partition — populated on replicas — UNION the
 * default label `_meta` — where the originator keeps it, because its
 * per-cgId partition is the minimal `buildScopedMinimalMeta` shape that
 * omits `dkg:subGraphName`) and fall back to those two graphs. This is a
 * read-path change only: leaves are still `hashTripleV10` of the same
 * triple content, so anchored roots are unchanged.
 *
 * `subGraphNameHint` short-circuits discovery for callers that already know
 * the sub-graph (the dRAG citation path, which scans the graph URI first).
 * It is ADDITIVE: the (a)→(b1)→(b2) cascade still runs, so a stale/empty
 * hint can never cause under-inclusion or regress a root/remap KA.
 */
export async function extractV10KCFromStore(
  store: TripleStore,
  cgId: bigint,
  kaId: bigint,
  subGraphNameHint?: string,
): Promise<KCExtractionResult> {
  const cgIdStr = cgId.toString();
  // Map cgId (numeric) → local CG name via the ontology graph. The
  // publisher's V10 path writes `<NAME>/context/<cgId>/_meta`, so
  // without the name lookup we'd query the wrong URI and report
  // KCNotFound for every KC the agent has actually synced.
  const cgName = await resolveContextGraphNameFromOnChainId(store, cgIdStr);
  if (cgName === null) {
    throw new KCNotFoundError(cgId, kaId);
  }

  // V2/rootless KAs are atomic graphs. Resolve their constant-size label
  // metadata first and read the exact per-KA VM graph directly; no subject
  // discovery or shared per-cgId data copy is involved. A missing V2 row falls
  // through to the legacy root-based extractor below so historical KAs remain
  // readable during the transition.
  const graphScoped = await extractGraphScopedV10KC(
    store,
    cgName,
    cgId,
    kaId,
    subGraphNameHint,
  );
  if (graphScoped) return graphScoped;

  const metaGraph = contextGraphMetaUri(cgName, cgIdStr);
  const dataGraph = contextGraphDataUri(cgName, cgIdStr);
  // No assertSafeIri on derived URIs — `cgIdStr` is a bigint stringification
  // and `cgName` was already gated by an `assertSafeIri(contextGraphMetaUri(name, '0'))`
  // probe inside `resolveContextGraphNameFromOnChainId`, so the derived URIs
  // are safe by construction.

  // 1. Resolve UAL via dkg:batchId. Use a typed integer literal to
  //    avoid string-prefix collisions (kaId 1 vs 10) — same lookup
  //    discipline as the publisher's resolveUalByBatchId (P-18 lesson).
  const ualResult = await store.query(
    `SELECT ?ual WHERE {
       GRAPH <${metaGraph}> {
         ?ual <${DKG}batchId> "${kaId}"^^<${XSD}integer> .
       }
     } LIMIT 1`,
  );
  if (ualResult.type !== 'bindings' || ualResult.bindings.length === 0) {
    throw new KCNotFoundError(cgId, kaId);
  }
  const ual = stripQuotes(ualResult.bindings[0]['ual'] ?? '');
  if (!ual) throw new KCNotFoundError(cgId, kaId);
  assertSafeIri(ual);

  // 2. List KAs + root entities + private sub-roots. Read-both
  //    (RFC ka-metadata-trim P3.1): the collapsed shape carries
  //    `dkg:rootEntity` + `dkg:privateMerkleRoot` directly on the UAL subject
  //    (no `<ual>/<n>` + `dkg:partOf` token rows); legacy-shape rows synced
  //    from older nodes still use the token-row form. Old-shape stores can
  //    match BOTH branches (the aggregate UAL node also carried the entity
  //    pair) — the dedupe below keeps roots and private leaves unique.
  const kaResult = await store.query(
    `SELECT ?ka ?root ?privRoot WHERE {
       GRAPH <${metaGraph}> {
         {
           ?ka <${DKG}partOf> <${ual}> ;
               <${DKG}rootEntity> ?root .
           OPTIONAL { ?ka <${DKG}privateMerkleRoot> ?privRoot }
         }
         UNION
         {
           <${ual}> <${DKG}rootEntity> ?root .
           BIND(<${ual}> AS ?ka)
           OPTIONAL { <${ual}> <${DKG}privateMerkleRoot> ?privRoot }
         }
       }
     }`,
  );
  if (kaResult.type !== 'bindings' || kaResult.bindings.length === 0) {
    throw new KCRootEntitiesNotFoundError(cgId, kaId, ual);
  }

  // Stable order: sort by KA URI so leaves are deterministic across
  // store backends. Sort + dedupe inside V10MerkleTree handles final
  // canonicalisation, but a deterministic input keeps debug logs sane.
  const sortedRows = [...kaResult.bindings].sort((a, b) =>
    (a['ka'] ?? '').localeCompare(b['ka'] ?? ''),
  );

  const rootEntities: string[] = [];
  const privateRoots: Uint8Array[] = [];
  const seenRoots = new Set<string>();
  // Distinct-hex dedupe: with the read-both UNION an old-shape store binds
  // the same private root from BOTH the token row and the aggregate UAL row.
  // V10MerkleTree dedupes leaves anyway, so dropping repeats here is
  // semantics-preserving (and keeps debug output sane).
  const seenPrivRoots = new Set<string>();
  for (const row of sortedRows) {
    const root = stripQuotes(row['root'] ?? '');
    if (root && !seenRoots.has(root)) {
      assertSafeIri(root);
      rootEntities.push(root);
      seenRoots.add(root);
    }
    const privHex = stripQuotes(row['privRoot'] ?? '');
    if (privHex && !seenPrivRoots.has(privHex)) {
      seenPrivRoots.add(privHex);
      privateRoots.push(parseHexBytes(privHex));
    }
  }
  if (rootEntities.length === 0) {
    throw new KCRootEntitiesNotFoundError(cgId, kaId, ual);
  }

  // 3. Pull public triples per root entity, with the #1367 sub-graph
  //    cascade. For each root: read the per-cgId data graph (a) FIRST — the
  //    sole home for CG-root and remapped KAs. Only when (a) yields nothing
  //    for some root do we discover the sub-graph and fall back to the
  //    per-KA verifiable-memory layer (b1, author publish) then the bare
  //    sub-graph graph (b2, replica finalization). FIRST non-empty source
  //    per root wins — never a UNION: two co-resident copies with divergent
  //    literal escaping would not collapse under set semantics and would
  //    inflate the leaf set → V10ProofLeafCountMismatch. The root+genid
  //    subject filter and POST_PUBLISH_PREDICATES_TO_SKIP exclusion (the VM
  //    layer carries self-attested trust stamps) apply to every source.
  const readRoot = async (graph: string, root: string): Promise<KCTriple[]> => {
    const genidPrefix = `${root}/.well-known/genid/`;
    const result = await store.query(
      `CONSTRUCT { ?s ?p ?o } WHERE {
         GRAPH <${graph}> {
           ?s ?p ?o .
           FILTER(?s = <${root}> || STRSTARTS(STR(?s), "${escapeSparqlString(genidPrefix)}"))
         }
       }`,
    );
    if (result.type !== 'quads') return [];
    const out: KCTriple[] = [];
    for (const q of result.quads) {
      if (POST_PUBLISH_PREDICATES_TO_SKIP.has(q.predicate)) continue;
      out.push({ subject: q.subject, predicate: q.predicate, object: q.object, graph });
    }
    return out;
  };

  const triples: KCTriple[] = [];
  const unresolvedRoots: string[] = [];
  for (const root of rootEntities) {
    const fromRoot = await readRoot(dataGraph, root);
    if (fromRoot.length > 0) triples.push(...fromRoot);
    else unresolvedRoots.push(root);
  }

  // Hot path: CG-root / remapped KAs satisfy every root from (a), so we never
  // discover or touch any sub-graph graph — identical work to pre-#1367.
  let subGraphName: string | undefined;
  if (unresolvedRoots.length > 0) {
    // #1367 sub-graph cascade for the still-unresolved roots: the per-KA
    // verifiable-memory layer (b1, author publish) then the bare sub-graph graph
    // (b2, replica finalization). FIRST non-empty source per root wins — never a
    // UNION: two co-resident copies with divergent literal escaping would not
    // collapse under set semantics and would inflate the leaf set →
    // V10ProofLeafCountMismatch.
    const resolveFrom = async (sg: string): Promise<void> => {
      // (author, number) is globally unique per chain (ka_numbers is keyed on
      // author only; the contract reverts KaIdNamespaceMismatch otherwise), so
      // these constructed URIs can only ever name THIS KA's graphs. All parts are
      // safe-by-construction: cgName was assertSafeIri-probed, sg is
      // validateSubGraphName'd, author is hex and number numeric — no
      // store-returned IRI is interpolated into SPARQL.
      const vmAuthor = '0x' + (kaId >> 96n).toString(16).padStart(40, '0');
      const vmNumber = kaId & ((1n << 96n) - 1n);
      const subSources = [
        contextGraphLayerUri(cgName, MemoryLayer.VerifiableMemory, vmAuthor, vmNumber, sg), // (b1)
        contextGraphSubGraphUri(cgName, sg), // (b2)
      ];
      for (const root of [...unresolvedRoots]) {
        for (const g of subSources) {
          const fromSub = await readRoot(g, root);
          if (fromSub.length > 0) {
            triples.push(...fromSub);
            unresolvedRoots.splice(unresolvedRoots.indexOf(root), 1);
            if (subGraphName === undefined) subGraphName = sg;
            break;
          }
        }
      }
    };

    // The `subGraphNameHint` (dRAG citation path scanned the graph URI) is a
    // FAST-PATH candidate, NOT authoritative: a stale or invalid hint must never
    // hide the canonical `dkg:subGraphName` in `_meta`. Try the hint first, then
    // fall back to the meta pointer for any root the hint can't satisfy.
    const hint = subGraphNameHint && validateSubGraphName(subGraphNameHint).valid ? subGraphNameHint : undefined;
    if (hint) await resolveFrom(hint);
    if (unresolvedRoots.length > 0) {
      const metaSg = await resolveSubGraphNameFromMeta(store, metaGraph, cgName, ual);
      if (metaSg && metaSg !== hint) await resolveFrom(metaSg);
    }
  }

  // Partial-root guard (#1367): if ANY root is still unresolved, the KA is not
  // fully synced locally. Returning the partial set would build a V10 root over a
  // SUBSET of leaves → mismatch with the on-chain root → on-chain `data-corrupted`
  // on submit instead of a benign skip. Throw KCDataMissingError so the prover
  // emits `kc-not-synced` and re-tries later.
  if (unresolvedRoots.length > 0 || triples.length === 0) {
    throw new KCDataMissingError(
      cgId, kaId, ual,
      unresolvedRoots.length > 0 ? unresolvedRoots : rootEntities,
    );
  }

  // 4. Compute V10 leaves: public triples first, private sub-roots next.
  //    V10MerkleTree sorts + dedupes internally; we keep insertion
  //    order here purely for debuggability.
  const leaves: Uint8Array[] = triples.map((t) => hashTripleV10(t.subject, t.predicate, t.object));
  for (const root of privateRoots) leaves.push(root);

  return { contextGraphName: cgName, dataGraph, subGraphName, ual, rootEntities, triples, privateRoots, leaves };
}

async function extractGraphScopedV10KC(
  store: TripleStore,
  cgName: string,
  cgId: bigint,
  kaId: bigint,
  _subGraphNameHint?: string,
): Promise<KCExtractionResult | null> {
  const labelMetaGraph = contextGraphMetaUri(cgName);
  const result = await store.query(
    `SELECT ?ual ?scope ?version ?publicCount ?privateCount ?privateRoot ?assertionGraph ?subGraph WHERE {
       GRAPH <${labelMetaGraph}> {
         ?ual <${DKG}batchId> "${kaId}"^^<${XSD}integer> ;
           <${DKG}contentScopeVersion> ?scope ;
           <${DKG}assertionVersion> ?version ;
           <${DKG}publicTripleCount> ?publicCount ;
           <${DKG}privateTripleCount> ?privateCount ;
           <${DKG}assertionGraph> ?assertionGraph .
         OPTIONAL { ?ual <${DKG}privateMerkleRoot> ?privateRoot }
         OPTIONAL { ?ual <${DKG}subGraphName> ?subGraph }
       }
     } LIMIT 1`,
  );
  if (result.type !== 'bindings' || result.bindings.length === 0) return null;

  const row = result.bindings[0];
  const contentScopeVersion = Number(stripQuotes(row['scope'] ?? ''));
  if (contentScopeVersion !== GRAPH_KA_CONTENT_SCOPE_VERSION) {
    throw new Error(
      `Unsupported content scope version ${contentScopeVersion} for KC ${kaId} in cg ${cgId}`,
    );
  }
  const ual = stripQuotes(row['ual'] ?? '');
  const assertionVersion = stripQuotes(row['version'] ?? '');
  const scope = createGraphKnowledgeAssetScope(ual, assertionVersion);
  const packedKaId = (BigInt(scope.agentAddress) << 96n) | BigInt(scope.kaNumber);
  if (scope.ual !== ual || packedKaId !== kaId) {
    throw new Error(`Graph-scoped KC identity does not match kaId ${kaId} in cg ${cgId}`);
  }

  const publicTripleCount = Number(stripQuotes(row['publicCount'] ?? ''));
  const privateTripleCount = Number(stripQuotes(row['privateCount'] ?? ''));
  if (
    !Number.isSafeInteger(publicTripleCount)
    || publicTripleCount < 0
    || !Number.isSafeInteger(privateTripleCount)
    || privateTripleCount < 0
    || (publicTripleCount === 0 && privateTripleCount === 0)
  ) {
    throw new Error(`Invalid graph-scoped content counts for KC ${kaId} in cg ${cgId}`);
  }

  const metaSubGraph = stripQuotes(row['subGraph'] ?? '') || undefined;
  if (metaSubGraph && !validateSubGraphName(metaSubGraph).valid) {
    throw new Error(`Invalid graph-scoped sub-graph metadata for KC ${kaId} in cg ${cgId}`);
  }
  // V2 metadata is authoritative: an absent subGraphName means the CG root.
  // Caller hints are only a legacy discovery optimization and must never move
  // an atomic KA to a different physical graph.
  const subGraphName = metaSubGraph;
  const assertionGraph = row['assertionGraph'] ?? '';
  const expectedGraph = knowledgeAssetLayerGraphUri(
    cgName,
    MemoryLayer.VerifiableMemory,
    scope,
    subGraphName,
  );
  if (assertionGraph !== expectedGraph) {
    throw new Error(`Graph-scoped assertion graph mismatch for KC ${kaId} in cg ${cgId}`);
  }

  const privateRootLiteral = stripQuotes(row['privateRoot'] ?? '');
  const privateRoots = privateRootLiteral ? [parseHexBytes(privateRootLiteral)] : [];
  if (
    (privateTripleCount > 0 && (privateRoots.length !== 1 || privateRoots[0].length !== 32))
    || (privateTripleCount === 0 && privateRoots.length !== 0)
  ) {
    throw new Error(`Invalid graph-scoped private commitment for KC ${kaId} in cg ${cgId}`);
  }

  const graphResult = await store.query(
    `CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${assertionGraph}> { ?s ?p ?o } }`,
  );
  const triples: KCTriple[] = graphResult.type === 'quads'
    ? graphResult.quads
      .filter((quad) => !POST_PUBLISH_PREDICATES_TO_SKIP.has(quad.predicate))
      .map((quad) => ({
        subject: quad.subject,
        predicate: quad.predicate,
        object: quad.object,
        graph: assertionGraph,
      }))
    : [];
  if (triples.length !== publicTripleCount) {
    throw new KCDataMissingError(cgId, kaId, ual, []);
  }

  const leaves = triples.map((triple) =>
    hashTripleV10(triple.subject, triple.predicate, triple.object));
  leaves.push(...privateRoots);
  return {
    contextGraphName: cgName,
    dataGraph: assertionGraph,
    subGraphName,
    ual,
    rootEntities: [],
    triples,
    privateRoots,
    leaves,
  };
}

// ── Internal helpers ───────────────────────────────────────────────────

/**
 * Resolve the CANONICAL sub-graph a KA's content lives in (#1367) from `_meta`,
 * or `undefined` for a CG-root KA. Read `dkg:subGraphName` keyed on the UAL with
 * a READ-BOTH union: the per-cgId `_meta` carries it on REPLICAS (the full
 * confirmed meta is remapped there), while the ORIGINATOR keeps it only in the
 * default label `_meta` — its per-cgId partition is the minimal
 * `buildScopedMinimalMeta` shape, which omits `dkg:subGraphName`. The value is
 * validated before use; an absent/invalid value returns `undefined` so the
 * caller safely degrades (a legacy sub-graph KA with no pointer stays
 * `kc-not-synced`, never a wrong root).
 *
 * The dRAG citation-path `hint` is handled by the CALLER as an additive
 * fast-path candidate, never here — so a stale hint can never suppress this
 * canonical lookup.
 */
async function resolveSubGraphNameFromMeta(
  store: TripleStore,
  perCgIdMetaGraph: string,
  cgName: string,
  ual: string,
): Promise<string | undefined> {
  const defaultMetaGraph = contextGraphMetaUri(cgName); // did:dkg:context-graph:<NAME>/_meta
  const result = await store.query(
    `SELECT ?sg WHERE {
       { GRAPH <${perCgIdMetaGraph}> { <${ual}> <${DKG}subGraphName> ?sg } }
       UNION
       { GRAPH <${defaultMetaGraph}> { <${ual}> <${DKG}subGraphName> ?sg } }
     } LIMIT 1`,
  );
  if (result.type !== 'bindings' || result.bindings.length === 0) return undefined;
  const sg = stripQuotes(result.bindings[0]['sg'] ?? '');
  if (!sg || !validateSubGraphName(sg).valid) return undefined;
  return sg;
}

/**
 * Look up the local CG name for a given on-chain id.
 *
 * The ontology graph carries triples of the form
 *   `<did:dkg:context-graph:<name>> <ContextGraphOnChainId> "<cgId>"`
 * written by `agent.registerContextGraph` and
 * `discoverContextGraphsFromChain`. We invert that mapping here so
 * the extractor can reach the right `<NAME>/context/<cgId>/_meta` URI.
 *
 * Returns `null` (not throw) when there's no match — the prover treats
 * that as a sync miss and emits `kc-not-synced`.
 */
async function resolveContextGraphNameFromOnChainId(
  store: TripleStore,
  cgIdStr: string,
): Promise<string | null> {
  const result = await store.query(
    `SELECT ?cgUri WHERE {
       GRAPH <${ONTOLOGY_GRAPH}> {
         ?cgUri <${CONTEXT_GRAPH_ON_CHAIN_ID}> "${cgIdStr}" .
       }
     } LIMIT 1`,
  );
  if (result.type !== 'bindings' || result.bindings.length === 0) {
    return null;
  }
  const cgUri = stripQuotes(result.bindings[0]['cgUri'] ?? '');
  if (!cgUri.startsWith(CG_URI_PREFIX)) return null;
  const name = cgUri.slice(CG_URI_PREFIX.length);
  if (!name) return null;
  // The name is later interpolated into a SPARQL IRI (`<did:dkg:context-graph:<name>/...>`),
  // so we must reject anything that would break out of an IRI literal — but we cannot
  // reject `/` here, because v9-style CG names use the `<owner_address>/<slug>` namespacing
  // pattern (e.g. "0xb08…4794c/laptop-smoke") and would otherwise be silently dropped,
  // surfacing as `KCNotFoundError` even when the FinalizationHandler has already promoted
  // the data to canonical. That mismatch broke RS proof submission across the entire
  // testnet — see PR notes for the on-chain reproduction.
  // Validate via `assertSafeIri` on the *derived* meta-graph URI, which is the actual
  // injection surface; rely on it instead of an overly tight name-level allowlist.
  try {
    assertSafeIri(contextGraphMetaUri(name, '0'));
  } catch {
    return null;
  }
  return name;
}

/**
 * Strip surrounding quotes from a SPARQL SELECT binding value. Some
 * adapters return literal IRIs as `"..."` because the result row
 * format is JSON-ish; downstream code expects bare strings.
 */
function stripQuotes(v: string): string {
  if (v.startsWith('"') && v.endsWith('"')) {
    return v.slice(1, -1);
  }
  // Some SELECT adapters wrap typed literals as `"value"^^<datatype>`.
  // We only care about the value before the double-caret.
  const ix = v.indexOf('"^^');
  if (v.startsWith('"') && ix !== -1) {
    return v.slice(1, ix);
  }
  return v;
}

/**
 * Parse a hex literal recorded in `_meta` (no `0x` prefix; lowercase
 * 64-char string). The publisher's `metadata.ts:toHex` writes the hex
 * **without** `0x`; tolerate both for robustness.
 */
function parseHexBytes(hex: string): Uint8Array {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (h.length === 0 || h.length % 2 !== 0) {
    throw new Error(`Invalid hex literal length: "${hex}"`);
  }
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = parseInt(h.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) {
      throw new Error(`Invalid hex literal: "${hex}"`);
    }
    out[i] = byte;
  }
  return out;
}

/**
 * Escape a string for use inside a SPARQL `"..."` literal. Same set as
 * `metadata.ts:lit`, mirrored here so the random-sampling package does
 * not depend on the publisher.
 */
function escapeSparqlString(val: string): string {
  return val
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
}

/**
 * Convenience: pull KC quads but return the raw `Quad[]` (with graph
 * IRI) — useful for debug logging and serialization. The proof builder
 * itself uses {@link extractV10KCFromStore} for the leaves.
 */
export async function extractV10KCQuads(
  store: TripleStore,
  cgId: bigint,
  kaId: bigint,
  subGraphNameHint?: string,
): Promise<Quad[]> {
  const result = await extractV10KCFromStore(store, cgId, kaId, subGraphNameHint);
  // Report each triple's ACTUAL source graph (#1367): per-cgId data graph, per-KA
  // VM layer, or bare sub-graph graph. Fall back to the per-cgId data graph only
  // for any triple that predates source tagging.
  return result.triples.map((t) => ({
    subject: t.subject,
    predicate: t.predicate,
    object: t.object,
    graph: t.graph ?? result.dataGraph,
  }));
}
