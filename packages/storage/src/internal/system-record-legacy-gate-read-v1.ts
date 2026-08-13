/**
 * Storage read path for the inbound legacy `agents` gate (#2052 D-8; plan :924, :926, :1505).
 *
 * The gate lives in the agent package and owns the decision; this module owns the two
 * bounded reads that decision needs, because only storage knows where reserved state and
 * projections live and what a bounded response looks like.
 *
 * WHY THIS IS NOT THE ATOMIC-APPLY INSPECTION PATH. `readReserved`/`readProjection` in
 * `system-record-atomic-apply-executor-v1-internal.ts` are bound to a managed-Oxigraph
 * HTTP client and get their byte caps enforced at the transport. Riding that path would
 * make the gate work only on daemon-managed leased endpoints, so a node on any other
 * backend would have no gate at all — and an invariant that holds only on some backends
 * is not an invariant. These reads go through `TripleStore.query`, which every store
 * implements.
 *
 * WHERE THE BYTE CAPS LAND, AND WHY THAT IS A DERIVATION RATHER THAN PLAN LETTER. :926
 * caps request one at 1 MiB and request two at 2 MiB as *response* caps, which presumes a
 * wire. An embedded store has no wire, so the faithful analogue is the retained size of
 * the decoded answer, measured after it arrives. That is late by construction — the bytes
 * exist before anything can refuse them — so these functions never pretend to have
 * prevented an oversized answer. They report what they could not classify and let the gate
 * withhold, which is exactly :926's own remedy ("signed-root quads not classified within
 * the selected bounded batch are withheld").
 *
 * MODE. Covered means an applied record whose projection is AUTHORITATIVE. Pre-cutover the
 * projection lives in its own shadow graph, so legacy insertion into the aggregate `agents`
 * graph cannot collide with it, and `SYSTEM_RECORD_V1_SHADOW_AGENTS_GRAPH`'s own contract
 * is that shadow rows "never make the legacy lane non-authoritative". A gate that withheld
 * legacy quads on the strength of a shadow row would violate that directly. So under
 * `shadow` these reads answer empty WITHOUT querying, and the mode is supplied by the
 * caller from the materializer's own lane activation rather than inferred here — an
 * absent lane controller proves nothing can apply a record *now*, not that none persists
 * from an earlier process.
 */

import { parseRdfLiteralTerm } from '@origintrail-official/dkg-rdf-utils';
import { isSafeIri } from '@origintrail-official/dkg-core';
import {
  parseCanonicalOwnedSubjectTableObjectV1,
  SYSTEM_RECORD_MAX_ATOMIC_RESERVED_INSPECTION_RESPONSE_BYTES,
  SYSTEM_RECORD_MAX_OWNED_SUBJECTS,
  SYSTEM_RECORD_MAX_PROJECTION_BYTES,
  SYSTEM_RECORD_MAX_PROJECTION_QUADS,
} from '@origintrail-official/dkg-core/system-record-v1';
import type { Quad, TripleStore } from '../triple-store.js';
import { SYSTEM_RECORD_V1_STATE_GRAPH } from '../internal-graph-policy.js';
// The canonical retained-byte accounting, shared with the inspection path rather than
// re-derived here. Request one measures a literal rather than quads, so it keeps its own
// term measurement; request two measures rows, which is exactly what this helper counts.
import {
  buildSystemRecordProjectionInspectionQueryV1,
  retainedSystemRecordInspectionQuadsBytesV1,
} from '../system-record-inspection-v1-internal.js';
import {
  SYSTEM_RECORD_V1_JSON_DATATYPE,
  SYSTEM_RECORD_V1_PREDICATES,
  systemRecordProjectionGraphV1,
  systemRecordRootClaimSubjectV1,
  type SystemRecordMaterializationModeV1,
} from '../system-record-rdf-schema-v1-internal.js';

/**
 * Re-exported so a consumer names the mode with the materializer's own type rather than
 * restating the union. There is exactly one mode, and it has exactly one definition here.
 */
export type { SystemRecordMaterializationModeV1 };

/**
 * The graph an applied projection occupies for a mode — the ONLY graph in which legacy
 * insertion can physically collide with signed state.
 *
 * Exported for the gate's destination-graph scope. It is deliberately the materializer's
 * own function rather than a constant restated agent-side: the gate must decide "would
 * this insert land where the projection lives" against the same answer the projection
 * itself uses, or the two could disagree about which graph is authoritative.
 *
 * Under `shadow` this is the namespace-hidden reserved graph, which no legacy page ever
 * targets — so the mode keeps the gate inert here too, and for the same reason as the
 * reads: pre-cutover there is nothing for legacy insertion to collide with.
 */
export { systemRecordProjectionGraphV1 };

/**
 * The canonical typed-literal datatype an owned-subject table must carry.
 *
 * Exported because this reader now ENFORCES it: a table literal of any other datatype is
 * reported undecided rather than accepted. A consumer constructing or asserting against
 * reserved state needs the same constant the reader compares to, or its fixtures test a
 * shape production never produces — which is exactly how the missing check was found.
 */
export { SYSTEM_RECORD_V1_JSON_DATATYPE };

/** One applied signed record, keyed by the agent root the caller asked about. */
export interface LegacyAgentProfileAppliedRootV1 {
  readonly root: string;
  readonly ownedSubjects: readonly string[];
}

export interface LegacyAgentProfileAppliedRootsV1 {
  readonly records: readonly LegacyAgentProfileAppliedRootV1[];
  /**
   * Roots that were asked about and NOT decided. Distinct from roots simply absent from
   * `records`, which means "no applied record" and is a real answer.
   */
  readonly unclassifiedRoots: readonly string[];
}

export interface LegacyAgentProfileProjectionV1 {
  readonly rows: readonly Quad[];
  readonly truncated: boolean;
}

const UTF8 = new TextEncoder();

function termBytes(value: string): number {
  return UTF8.encode(value).length;
}

function assertQueryableIri(iri: string): void {
  if (!isSafeIri(iri)) throw new Error('legacy agent-profile gate read built an unsafe IRI');
}

/**
 * The transport's own refusal to buffer an oversized body, recognised by its stable
 * `code` rather than by its message.
 *
 * Only the canonical `StoreResponseTooLargeError` counts. A store whose client reports
 * the overrun as an untyped error still propagates — which fails CLOSED (the page is
 * dropped, nothing is inserted), just more bluntly. That is named as a known residual
 * rather than papered over with message matching, which would silently widen to
 * unrelated failures and start reporting real errors as "could not classify".
 */
function isStoreResponseTooLargeV1(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && (error as { code?: unknown }).code === 'STORE_RESPONSE_TOO_LARGE';
}

/**
 * The canonical query builder's own refusal to emit an over-bound REQUEST.
 *
 * Distinguished from its accounting-mismatch throws, which would be defects in this
 * module and must keep propagating. Matching the bound suffix rather than the label keeps
 * this from widening if the label is ever reworded.
 */
function isBoundedBuilderOverflowV1(error: unknown): boolean {
  return error instanceof Error
    && / exceeds its (encoded|retained)-byte bound$/.test(error.message);
}

function valuesClause(variable: string, iris: readonly string[]): string {
  for (const iri of iris) assertQueryableIri(iri);
  return `VALUES ${variable} { ${iris.map((iri) => `<${iri}>`).join(' ')} }`;
}

function selectBindings(result: {
  type: string;
  bindings?: Array<Record<string, string>>;
}): Array<Record<string, string>> {
  // A non-SELECT answer here means the query text and the reader disagree, which is a
  // defect in this module rather than a condition to tolerate.
  if (result.type !== 'bindings' || !Array.isArray(result.bindings)) {
    throw new Error('legacy agent-profile gate read expected SPARQL bindings');
  }
  return result.bindings;
}

/**
 * Request one — map derived agent roots to their applied record's owned-subject table.
 *
 * Two hops in ONE physical request, which is what keeps :926's two-request budget
 * reachable: a root-claim subject is derivable from the root with no read
 * (`systemRecordRootClaimSubjectV1`), the claim names its record through `claimedBy`, and
 * the record carries the table. A per-root or per-quad query is never issued.
 *
 * COVERAGE IS SCOPED TO THE CURRENT CLAIM. `claimPosition` distinguishes a record's
 * current root from roots it held before an authority transition, whose projection was
 * "removed atomically" (plan :1503) — so a historical root has no signed state left to
 * protect, and the legacy path is correct for it. It is also the only case that can be
 * verified: the owned-subject table is canonicalized against the record's CURRENT root,
 * so validating it against a historical root would fail by construction.
 */
export async function readLegacyAgentProfileAppliedRootsV1(input: {
  readonly store: TripleStore;
  readonly networkId: string;
  readonly mode: SystemRecordMaterializationModeV1;
  readonly roots: readonly string[];
  readonly signal?: AbortSignal;
}): Promise<LegacyAgentProfileAppliedRootsV1> {
  const { store, networkId, mode, roots, signal } = input;
  if (mode !== 'authoritative' || roots.length === 0) {
    return Object.freeze({ records: [], unclassifiedRoots: [] });
  }

  // Deterministic order, and the same order the gate selects in, so which roots fall
  // outside the byte budget is a function of the request rather than of result ordering.
  const ordered = [...roots].sort();
  const claimByRoot = new Map<string, string>();
  for (const root of ordered) {
    claimByRoot.set(root, systemRecordRootClaimSubjectV1(networkId, root));
  }
  const rootByClaim = new Map([...claimByRoot].map(([root, claim]) => [claim, root]));

  assertQueryableIri(SYSTEM_RECORD_V1_STATE_GRAPH);
  const query = `SELECT ?claim ?table WHERE {\n`
    + `  GRAPH <${SYSTEM_RECORD_V1_STATE_GRAPH}> {\n`
    + `    ${valuesClause('?claim', [...claimByRoot.values()])}\n`
    + `    ?claim <${SYSTEM_RECORD_V1_PREDICATES.claimPosition}> "current" .\n`
    + `    ?claim <${SYSTEM_RECORD_V1_PREDICATES.claimedBy}> ?record .\n`
    + `    ?record <${SYSTEM_RECORD_V1_PREDICATES.ownedSubjectTable}> ?table .\n`
    + `  }\n`
    + `}\nLIMIT ${ordered.length + 1}`;

  let bindings: Array<Record<string, string>>;
  try {
    bindings = selectBindings(await store.query(query, {
      source: 'storage.systemRecord.legacyGate.appliedRoots',
      priority: 'background',
      maxResponseBytes: SYSTEM_RECORD_MAX_ATOMIC_RESERVED_INSPECTION_RESPONSE_BYTES,
      signal,
    }) as { type: string; bindings?: Array<Record<string, string>> });
  } catch (error) {
    if (!isStoreResponseTooLargeV1(error)) throw error;
    // The transport refused the body before parsing it. Report rather than rethrow: at
    // the seam a throw drops the whole page, which is the retry-storm this port contract
    // was rewritten to avoid, and "could not classify" is already the answer the gate
    // knows how to act on.
    return Object.freeze({ records: [], unclassifiedRoots: Object.freeze([...ordered]) });
  }

  // THE RESPONSE MAY NOT BE THE EXACT SET, AND THAT CHANGES WHAT ABSENCE MEANS.
  //
  // The query asks for `LIMIT ordered.length + 1`, so at most one row per requested root
  // plus one. More rows than roots means either duplicates or a bound that cut the answer
  // short — and a cut answer can have pushed a DIFFERENT root's row out of the result.
  // Reading that root as "no applied record" would classify it uncovered and insert
  // unsigned legacy quads over signed state, which is the exact fail-open this port
  // contract exists to close. So when the answer is not exact, absence stops being an
  // answer and every undecided root is reported undecided.
  const saturated = bindings.length > ordered.length;

  const tableByRoot = new Map<string, string>();
  // Roots the reserved graph answered for more than once. A duplicate current claim means
  // the graph is not the shape this reader can classify, and picking whichever row arrived
  // first would be deciding insert-or-discard from an arbitrary one.
  const ambiguousRoots = new Set<string>();
  for (const binding of bindings) {
    const root = binding.claim === undefined ? undefined : rootByClaim.get(binding.claim);
    // A row for a claim nobody asked about cannot narrow or widen coverage; ignore it.
    if (root === undefined || binding.table === undefined) continue;
    if (tableByRoot.has(root)) {
      ambiguousRoots.add(root);
      continue;
    }
    tableByRoot.set(root, binding.table);
  }

  const records: LegacyAgentProfileAppliedRootV1[] = [];
  const unclassifiedRoots: string[] = [];
  let retainedBytes = 0;
  for (const root of ordered) {
    if (ambiguousRoots.has(root)) {
      unclassifiedRoots.push(root);
      continue;
    }
    const table = tableByRoot.get(root);
    if (table === undefined) {
      // Asked, answered: no applied record — but ONLY when the answer was exact. Under a
      // saturated response the row for this root may simply not have fitted.
      if (saturated) unclassifiedRoots.push(root);
      continue;
    }
    // DELIBERATELY NOT `retainedSystemRecordInspectionQuadsBytesV1`, which request two
    // uses. That helper measures QUADS; what is retained here is a single literal — the
    // owned-subject table — so wrapping it in a synthetic quad to reuse the helper would
    // inflate the count with subject, predicate and graph terms this response never
    // carries. Same cap, different measured object.
    retainedBytes += termBytes(table);
    if (retainedBytes > SYSTEM_RECORD_MAX_ATOMIC_RESERVED_INSPECTION_RESPONSE_BYTES) {
      // Past the budget the answer is no longer one this reader will vouch for. Every
      // remaining root is reported undecided, never as "no record".
      unclassifiedRoots.push(root);
      continue;
    }
    const literal = parseRdfLiteralTerm(table);
    // The DATATYPE is part of the contract, not decoration. Adopted from review, which
    // caught it with a fixture typed `urn:json` that passed anyway: this reader used to
    // take any literal's value, so reserved state the writer could never emit — a plain
    // literal, a language-tagged one, any datatype at all — was accepted as a valid
    // applied record. The canonical decode below still bounded what such a table could
    // SAY, but a reader looser than its writer's encoding is a hole on its own.
    //
    // A mismatch is UNDECIDED, never "no record" — treated exactly like a table that will
    // not decode, for the same reason: an answer this reader cannot vouch for must not
    // become the `uncovered` that lets legacy quads through.
    //
    // (Wording note: a sibling slice pins that this package produces none of core's
    // authority-classification vocabulary, and it does so with a raw substring scan over
    // every `.ts` file in `src`. That scan cannot tell a term of art from the same word in
    // ordinary English, so prose here avoids the vocabulary entirely — including in this
    // note. Their invariant is correct; the collision is purely lexical.)
    if (literal === null
      || literal.kind !== 'typed'
      || literal.datatype !== SYSTEM_RECORD_V1_JSON_DATATYPE) {
      unclassifiedRoots.push(root);
      continue;
    }
    let ownedSubjects: readonly string[];
    try {
      ownedSubjects = parseCanonicalOwnedSubjectTableObjectV1(root, literal.value);
    } catch {
      // A table that will not decode against its own root cannot be used to classify that
      // root's quads. Undecided, not uncovered.
      unclassifiedRoots.push(root);
      continue;
    }
    if (ownedSubjects.length > SYSTEM_RECORD_MAX_OWNED_SUBJECTS) {
      unclassifiedRoots.push(root);
      continue;
    }
    records.push(Object.freeze({ root, ownedSubjects: Object.freeze([...ownedSubjects]) }));
  }

  return Object.freeze({
    records: Object.freeze(records),
    unclassifiedRoots: Object.freeze(unclassifiedRoots),
  }) as LegacyAgentProfileAppliedRootsV1;
}

/**
 * Request two — the exact projection triples owned by these subjects.
 *
 * `truncated` covers both bounds that can stop this response short of the exact
 * projection: the row count, which the gate could see for itself, and the 2-MiB retained
 * size, which it cannot. Reporting them through one flag keeps the gate's fallback single:
 * a partial projection is never compared against, because a missing row would read as a
 * conflict and withhold on manufactured evidence.
 */
export async function readLegacyAgentProfileProjectionV1(input: {
  readonly store: TripleStore;
  readonly mode: SystemRecordMaterializationModeV1;
  readonly subjects: readonly string[];
  readonly signal?: AbortSignal;
}): Promise<LegacyAgentProfileProjectionV1> {
  const { store, mode, subjects, signal } = input;
  if (mode !== 'authoritative' || subjects.length === 0) {
    return Object.freeze({ rows: [], truncated: false });
  }
  if (subjects.length > SYSTEM_RECORD_MAX_OWNED_SUBJECTS) {
    // :926 bounds request two at 2,048 subjects. Over that this reader cannot ask an
    // exact question, so it reports a truncated answer instead of asking a partial one.
    return Object.freeze({ rows: [], truncated: true });
  }

  const graph = systemRecordProjectionGraphV1(mode);
  // THE CANONICAL BUILDER, not a local one. Adopted from review after measuring the two
  // against each other rather than arguing layering: it emits the same graph, the same
  // exact-subject shape, and the same bound (its
  // `SYSTEM_RECORD_MAX_PROJECTION_INSPECTION_ROWS_V1` resolves to
  // `SYSTEM_RECORD_MAX_PROJECTION_QUADS + 1`), and it is STRICTLY STRONGER on three
  // counts the local version lacked — it rejects duplicate subjects, orders them
  // deterministically, and bounds the ENCODED REQUEST at the atomic SPARQL byte cap.
  // That last one was a real gap: 2,048 arbitrarily long subjects could previously build
  // an unbounded request string, and only the RESPONSE was ever capped.
  //
  // Its own preconditions are already satisfied above: it throws below one subject and
  // above the owned-subject bound, and both are returned early.
  //
  // AND ITS REFUSAL IS TRANSLATED, NOT PROPAGATED. Adopted from review, which caught a
  // defect this adoption itself introduced: the builder refuses an over-bound request by
  // THROWING, where the previous local construction had no request bound at all. So
  // adopting it turned "no cap" into "a cap that kills the page" — the throw escapes
  // through the gate, the per-context-graph catch drops the whole page, and durable sync
  // retries it forever. A request this reader cannot ask is exactly the case the gate
  // already has an answer for: report it undecidable and let the gate withhold.
  //
  // Valid long owned subjects reach this: the subject count can sit under its bound while
  // the encoded VALUES clause crosses the request cap.
  const ordered = [...subjects].sort();
  let query: string;
  try {
    query = buildSystemRecordProjectionInspectionQueryV1(mode, ordered);
  } catch (error) {
    if (!isBoundedBuilderOverflowV1(error)) throw error;
    return Object.freeze({ rows: [], truncated: true });
  }

  let bindings: Array<Record<string, string>>;
  try {
    bindings = selectBindings(await store.query(query, {
      source: 'storage.systemRecord.legacyGate.projection',
      priority: 'background',
      maxResponseBytes: SYSTEM_RECORD_MAX_PROJECTION_BYTES,
      signal,
    }) as { type: string; bindings?: Array<Record<string, string>> });
  } catch (error) {
    if (!isStoreResponseTooLargeV1(error)) throw error;
    return Object.freeze({ rows: [], truncated: true });
  }

  if (bindings.length > SYSTEM_RECORD_MAX_PROJECTION_QUADS) {
    return Object.freeze({ rows: [], truncated: true });
  }

  const rows: Quad[] = [];
  let retainedBytes = 0;
  for (const binding of bindings) {
    const { s, p, o } = binding;
    if (s === undefined || p === undefined || o === undefined) continue;
    const row = { subject: s, predicate: p, object: o, graph };
    // The system's OWN definition of retained bytes, not a local sum. Adopted from review:
    // a hand-rolled `s + p + o` in UTF-8 under-counts what is actually retained by more
    // than half — it ignores the graph term, JS string retention, and per-entry container
    // overhead — so a cap measured that way lets the process hold materially more than
    // the bound intends. Reusing the canonical helper also keeps this path from drifting
    // away from the accounting the sibling inspection path uses.
    retainedBytes += retainedSystemRecordInspectionQuadsBytesV1([row]);
    if (retainedBytes > SYSTEM_RECORD_MAX_PROJECTION_BYTES) {
      return Object.freeze({ rows: [], truncated: true });
    }
    rows.push(row);
  }
  return Object.freeze({ rows: Object.freeze(rows), truncated: false }) as LegacyAgentProfileProjectionV1;
}
