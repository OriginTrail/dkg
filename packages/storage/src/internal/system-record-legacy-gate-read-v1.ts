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
import {
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

  const tableByRoot = new Map<string, string>();
  for (const binding of bindings) {
    const root = binding.claim === undefined ? undefined : rootByClaim.get(binding.claim);
    // A row for a claim nobody asked about, or a duplicate current claim, means the
    // reserved graph is not the shape this reader assumes. Ignore the row rather than
    // guess: an unrecognised row can only make coverage narrower, and the roots it would
    // have covered stay unclassified below.
    if (root === undefined || binding.table === undefined) continue;
    if (!tableByRoot.has(root)) tableByRoot.set(root, binding.table);
  }

  const records: LegacyAgentProfileAppliedRootV1[] = [];
  const unclassifiedRoots: string[] = [];
  let retainedBytes = 0;
  for (const root of ordered) {
    const table = tableByRoot.get(root);
    if (table === undefined) continue; // Asked, answered: no applied record.
    retainedBytes += termBytes(table);
    if (retainedBytes > SYSTEM_RECORD_MAX_ATOMIC_RESERVED_INSPECTION_RESPONSE_BYTES) {
      // Past the budget the answer is no longer one this reader will vouch for. Every
      // remaining root is reported undecided, never as "no record".
      unclassifiedRoots.push(root);
      continue;
    }
    const literal = parseRdfLiteralTerm(table);
    if (literal === null) {
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
  assertQueryableIri(graph);
  const ordered = [...subjects].sort();
  const query = `SELECT ?s ?p ?o WHERE {\n`
    + `  GRAPH <${graph}> {\n`
    + `    ${valuesClause('?s', ordered)}\n`
    + `    ?s ?p ?o .\n`
    + `  }\n`
    + `}\nLIMIT ${SYSTEM_RECORD_MAX_PROJECTION_QUADS + 1}`;

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
    retainedBytes += termBytes(s) + termBytes(p) + termBytes(o);
    if (retainedBytes > SYSTEM_RECORD_MAX_PROJECTION_BYTES) {
      return Object.freeze({ rows: [], truncated: true });
    }
    rows.push({ subject: s, predicate: p, object: o, graph });
  }
  return Object.freeze({ rows: Object.freeze(rows), truncated: false }) as LegacyAgentProfileProjectionV1;
}
