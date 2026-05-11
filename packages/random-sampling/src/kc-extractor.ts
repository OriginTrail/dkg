import {
  assertSafeIri,
  contextGraphDataUri,
  contextGraphMetaUri,
  hashTripleV10,
} from '@origintrail-official/dkg-core';
import type { Quad, TripleStore } from '@origintrail-official/dkg-storage';

const DKG = 'http://dkg.io/ontology/';
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const ONTOLOGY_GRAPH = 'did:dkg:context-graph:ontology';
const CONTEXT_GRAPH_ON_CHAIN_ID = 'https://dkg.network/ontology#ContextGraphOnChainId';
const CG_URI_PREFIX = 'did:dkg:context-graph:';

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
}

export interface KCExtractionResult {
  /** Local context graph name resolved from the on-chain numeric id. */
  contextGraphName: string;
  /** Data graph URI that contained the public triples. */
  dataGraph: string;
  /** UAL of the KC discovered via `dkg:batchId == kcId`. */
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
 * Thrown when the on-chain `kcId` has no UAL recorded in the local
 * `_meta` graph for `cgId`. Almost always indicates the prover has not
 * yet synced this CG to the head; callers SHOULD skip the period and
 * trigger a sync, not retry the same proof.
 */
export class KCNotFoundError extends Error {
  readonly name = 'KCNotFoundError';
  constructor(readonly contextGraphId: bigint, readonly kcId: bigint) {
    super(`KC ${kcId} not found in _meta for context graph ${contextGraphId}`);
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
  constructor(readonly contextGraphId: bigint, readonly kcId: bigint, readonly ual: string) {
    super(
      `KC ${kcId} (UAL ${ual}) in cg ${contextGraphId} has no dkg:rootEntity ` +
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
    readonly kcId: bigint,
    readonly ual: string,
    readonly rootEntities: string[],
  ) {
    super(
      `KC ${kcId} (UAL ${ual}) has root entities ${JSON.stringify(rootEntities)} ` +
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
 * 2. Resolve the KC's UAL from `_meta`: `?ual dkg:batchId "<kcId>"^^xsd:integer`.
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
 */
export async function extractV10KCFromStore(
  store: TripleStore,
  cgId: bigint,
  kcId: bigint,
): Promise<KCExtractionResult> {
  const cgIdStr = cgId.toString();
  // Map cgId (numeric) → local CG name via the ontology graph. The
  // publisher's V10 path writes `<NAME>/context/<cgId>/_meta`, so
  // without the name lookup we'd query the wrong URI and report
  // KCNotFound for every KC the agent has actually synced.
  const cgName = await resolveContextGraphNameFromOnChainId(store, cgIdStr);
  if (cgName === null) {
    throw new KCNotFoundError(cgId, kcId);
  }
  const metaGraph = contextGraphMetaUri(cgName, cgIdStr);
  const dataGraph = contextGraphDataUri(cgName, cgIdStr);
  // No assertSafeIri on derived URIs — `cgIdStr` is a bigint stringification
  // and `cgName` was already gated by an `assertSafeIri(contextGraphMetaUri(name, '0'))`
  // probe inside `resolveContextGraphNameFromOnChainId`, so the derived URIs
  // are safe by construction.

  // 1. Resolve UAL via dkg:batchId. Use a typed integer literal to
  //    avoid string-prefix collisions (kcId 1 vs 10) — same lookup
  //    discipline as the publisher's resolveUalByBatchId (P-18 lesson).
  const ualResult = await store.query(
    `SELECT ?ual WHERE {
       GRAPH <${metaGraph}> {
         ?ual <${DKG}batchId> "${kcId}"^^<${XSD}integer> .
       }
     } LIMIT 1`,
  );
  if (ualResult.type !== 'bindings' || ualResult.bindings.length === 0) {
    throw new KCNotFoundError(cgId, kcId);
  }
  const ual = stripQuotes(ualResult.bindings[0]['ual'] ?? '');
  if (!ual) throw new KCNotFoundError(cgId, kcId);
  assertSafeIri(ual);

  // 2. List KAs + root entities + private sub-roots.
  const kaResult = await store.query(
    `SELECT ?ka ?root ?privRoot WHERE {
       GRAPH <${metaGraph}> {
         ?ka <${DKG}partOf> <${ual}> ;
             <${DKG}rootEntity> ?root .
         OPTIONAL { ?ka <${DKG}privateMerkleRoot> ?privRoot }
       }
     }`,
  );
  if (kaResult.type !== 'bindings' || kaResult.bindings.length === 0) {
    throw new KCRootEntitiesNotFoundError(cgId, kcId, ual);
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
  for (const row of sortedRows) {
    const root = stripQuotes(row['root'] ?? '');
    if (root && !seenRoots.has(root)) {
      assertSafeIri(root);
      rootEntities.push(root);
      seenRoots.add(root);
    }
    const privHex = stripQuotes(row['privRoot'] ?? '');
    if (privHex) {
      privateRoots.push(parseHexBytes(privHex));
    }
  }
  if (rootEntities.length === 0) {
    throw new KCRootEntitiesNotFoundError(cgId, kcId, ual);
  }

  // 3. Pull public triples per root entity. Same filter the publisher
  //    used to gather SWM quads; keeps the leaf set bit-for-bit.
  const triples: KCTriple[] = [];
  for (const root of rootEntities) {
    const genidPrefix = `${root}/.well-known/genid/`;
    const result = await store.query(
      `CONSTRUCT { ?s ?p ?o } WHERE {
         GRAPH <${dataGraph}> {
           ?s ?p ?o .
           FILTER(?s = <${root}> || STRSTARTS(STR(?s), "${escapeSparqlString(genidPrefix)}"))
         }
       }`,
    );
    if (result.type === 'quads') {
      for (const q of result.quads) {
        triples.push({ subject: q.subject, predicate: q.predicate, object: q.object });
      }
    }
  }
  if (triples.length === 0) {
    throw new KCDataMissingError(cgId, kcId, ual, rootEntities);
  }

  // 4. Compute V10 leaves: public triples first, private sub-roots next.
  //    V10MerkleTree sorts + dedupes internally; we keep insertion
  //    order here purely for debuggability.
  const leaves: Uint8Array[] = triples.map((t) => hashTripleV10(t.subject, t.predicate, t.object));
  for (const root of privateRoots) leaves.push(root);

  return { contextGraphName: cgName, dataGraph, ual, rootEntities, triples, privateRoots, leaves };
}

// ── Internal helpers ───────────────────────────────────────────────────

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
  kcId: bigint,
): Promise<Quad[]> {
  const result = await extractV10KCFromStore(store, cgId, kcId);
  return result.triples.map((t) => ({ ...t, graph: result.dataGraph }));
}
