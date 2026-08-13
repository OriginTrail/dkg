/**
 * The covering predicate for the inbound legacy `agents` gate (#2052 D-8).
 *
 * The headline here is the MODE COUNTERFACTUAL. "Pre-cutover the gate is inert" is only a
 * safety property if inertness is caused by the mode; an implementation that returns
 * nothing because its query is broken, its predicates are misspelled, or its root-claim
 * derivation is wrong is ALSO inert, and indistinguishable from the correct one by any
 * test that only ever runs in shadow. So every inertness assertion below is paired with an
 * authoritative run over the SAME fixture that must produce the record — the pair is the
 * discriminator, and neither half means anything alone.
 */
import { describe, expect, it } from 'vitest';

import {
  readLegacyAgentProfileAppliedRootsV1,
  readLegacyAgentProfileProjectionV1,
} from '../src/internal/system-record-legacy-gate-read-v1.js';
import {
  SYSTEM_RECORD_V1_JSON_DATATYPE,
  SYSTEM_RECORD_V1_PREDICATES,
  systemRecordProjectionGraphV1,
  systemRecordRootClaimSubjectV1,
} from '../src/system-record-rdf-schema-v1-internal.js';
import { SYSTEM_RECORD_V1_STATE_GRAPH } from '../src/internal-graph-policy.js';
// The REAL caps. A fixture that restated them would still pass against a reader that cut
// at a different bound, which is the whole property these cases exist to pin.
import {
  SYSTEM_RECORD_MAX_ATOMIC_RESERVED_INSPECTION_RESPONSE_BYTES,
  SYSTEM_RECORD_MAX_PROJECTION_BYTES,
  SYSTEM_RECORD_MAX_OWNED_SUBJECTS,
  SYSTEM_RECORD_MAX_PROJECTION_QUADS,
} from '@origintrail-official/dkg-core/system-record-v1';
import type { Quad, QueryResult, TripleStore } from '../src/triple-store.js';
import { OxigraphStore } from '../src/index.js';

const NETWORK_ID = 'otp:2043';
const ROOT = `did:dkg:agent:0x${'1'.repeat(40)}`;
const OTHER_ROOT = `did:dkg:agent:0x${'2'.repeat(40)}`;
// The REAL datatype, imported rather than restated: a fixture that pinned an invented IRI
// would pass against a reader that never checks it and prove nothing about the encoding.
const JSON_DATATYPE = SYSTEM_RECORD_V1_JSON_DATATYPE;

/**
 * A store that answers SELECT from an explicit quad set by honouring the two clauses these
 * queries actually use: a `VALUES` list and fixed predicates. It is deliberately literal —
 * matching on the same predicate IRIs the reader emits — so a reader that queried the
 * wrong predicate or the wrong graph gets nothing back, which is what lets the
 * authoritative half of each counterfactual fail loudly rather than pass vacuously.
 */
function fakeStore(
  quads: readonly Quad[],
): TripleStore & { queries: string[]; options: Array<Record<string, unknown>> } {
  const queries: string[] = [];
  const options: Array<Record<string, unknown>> = [];
  const store = {
    queries,
    options,
    async query(sparql: string, opts?: Record<string, unknown>): Promise<QueryResult> {
      queries.push(sparql);
      options.push(opts ?? {});
      const graph = /GRAPH <([^>]+)>/.exec(sparql)?.[1];
      const values = [...sparql.matchAll(/<([^>]+)>/g)].map((m) => m[1]!);
      const inGraph = quads.filter((quad) => quad.graph === graph);

      if (sparql.includes('?claim ?table')) {
        const bindings: Array<Record<string, string>> = [];
        for (const claim of values) {
          const position = inGraph.find((q) => q.subject === claim
            && q.predicate === SYSTEM_RECORD_V1_PREDICATES.claimPosition);
          if (position?.object !== '"current"') continue;
          const claimedBy = inGraph.find((q) => q.subject === claim
            && q.predicate === SYSTEM_RECORD_V1_PREDICATES.claimedBy);
          if (!claimedBy) continue;
          const table = inGraph.find((q) => q.subject === claimedBy.object
            && q.predicate === SYSTEM_RECORD_V1_PREDICATES.ownedSubjectTable);
          if (!table) continue;
          bindings.push({ claim, table: table.object });
        }
        return { type: 'bindings', bindings };
      }

      const subjects = new Set(values);
      return {
        type: 'bindings',
        bindings: inGraph
          .filter((quad) => subjects.has(quad.subject))
          .map((quad) => ({ s: quad.subject, p: quad.predicate, o: quad.object })),
      };
    },
  } as unknown as TripleStore & { queries: string[] };
  return store;
}

function jsonLiteral(value: unknown): string {
  return `"${JSON.stringify(value).replace(/["\\]/g, (c) => `\\${c}`)}"^^<${JSON_DATATYPE}>`;
}

/** Reserved state for one record whose CURRENT root is `root`. */
function appliedRecordQuads(root: string, ownedSubjects: readonly string[]): Quad[] {
  const claim = systemRecordRootClaimSubjectV1(NETWORK_ID, root);
  const record = `urn:system-record:${root}`;
  return [
    { subject: claim, predicate: SYSTEM_RECORD_V1_PREDICATES.root, object: root, graph: SYSTEM_RECORD_V1_STATE_GRAPH },
    { subject: claim, predicate: SYSTEM_RECORD_V1_PREDICATES.claimedBy, object: record, graph: SYSTEM_RECORD_V1_STATE_GRAPH },
    { subject: claim, predicate: SYSTEM_RECORD_V1_PREDICATES.claimPosition, object: '"current"', graph: SYSTEM_RECORD_V1_STATE_GRAPH },
    {
      subject: record,
      predicate: SYSTEM_RECORD_V1_PREDICATES.ownedSubjectTable,
      object: jsonLiteral([...ownedSubjects]),
      graph: SYSTEM_RECORD_V1_STATE_GRAPH,
    },
  ];
}

describe('legacy agent-profile gate read — the mode counterfactual (#2052 D-8)', () => {
  it('reports the applied record under authoritative mode', async () => {
    const store = fakeStore(appliedRecordQuads(ROOT, [ROOT]));

    const read = await readLegacyAgentProfileAppliedRootsV1({
      store, networkId: NETWORK_ID, mode: 'authoritative', roots: [ROOT],
    });

    expect(read.records).toEqual([{ root: ROOT, ownedSubjects: [ROOT] }]);
    expect(read.unclassifiedRoots).toEqual([]);
  });

  // The other half. Same fixture, same root, only the mode differs — so this passing while
  // the test above passes is the evidence that inertness is caused by the mode and not by
  // a reader that cannot find anything.
  it('reports nothing under shadow mode, and issues no query at all', async () => {
    const store = fakeStore(appliedRecordQuads(ROOT, [ROOT]));

    const read = await readLegacyAgentProfileAppliedRootsV1({
      store, networkId: NETWORK_ID, mode: 'shadow', roots: [ROOT],
    });

    expect(read.records).toEqual([]);
    expect(read.unclassifiedRoots).toEqual([]);
    // Inert by mode means it does not even ask: pre-cutover the gate costs nothing.
    expect(store.queries).toEqual([]);
  });

  it('answers "no applied record" for an uncovered root without calling it undecided', async () => {
    const store = fakeStore(appliedRecordQuads(ROOT, [ROOT]));

    const read = await readLegacyAgentProfileAppliedRootsV1({
      store, networkId: NETWORK_ID, mode: 'authoritative', roots: [ROOT, OTHER_ROOT],
    });

    expect(read.records.map((record) => record.root)).toEqual([ROOT]);
    // The distinction the whole port contract exists for: absent from `records` is an
    // ANSWER, and must not be reported as an inability to decide.
    expect(read.unclassifiedRoots).toEqual([]);
  });

  // plan :1503 — an authority transition removes the old projection atomically, so a
  // historical root has no signed state left to protect and the legacy path is correct.
  it('does not cover a root whose claim is historical rather than current', async () => {
    const quads = appliedRecordQuads(ROOT, [ROOT]).map((quad) => (
      quad.predicate === SYSTEM_RECORD_V1_PREDICATES.claimPosition
        ? { ...quad, object: '"historical:0"' }
        : quad
    ));
    const store = fakeStore(quads);

    const read = await readLegacyAgentProfileAppliedRootsV1({
      store, networkId: NETWORK_ID, mode: 'authoritative', roots: [ROOT],
    });

    expect(read.records).toEqual([]);
    expect(read.unclassifiedRoots).toEqual([]);
  });

  // Adopted from review. The reader used to take any literal's VALUE, so a table carrying
  // a perfectly valid JSON payload under a datatype the writer never emits was accepted as
  // a real applied record. The payload here is valid on purpose — only the datatype is
  // wrong — so this fails for exactly one reason.
  it('reports a root undecided when the table literal carries the wrong datatype', async () => {
    const quads = appliedRecordQuads(ROOT, [ROOT]).map((quad) => (
      quad.predicate === SYSTEM_RECORD_V1_PREDICATES.ownedSubjectTable
        ? { ...quad, object: `"[\\"${ROOT}\\"]"^^<urn:not-the-canonical-datatype>` }
        : quad
    ));
    const store = fakeStore(quads);

    const read = await readLegacyAgentProfileAppliedRootsV1({
      store, networkId: NETWORK_ID, mode: 'authoritative', roots: [ROOT],
    });

    // Undecided, NOT "no applied record" — the distinction that keeps legacy quads out.
    expect(read.records).toEqual([]);
    expect(read.unclassifiedRoots).toEqual([ROOT]);
  });

  it('reports a root undecided when its owned-subject table will not decode', async () => {
    const quads = appliedRecordQuads(ROOT, [ROOT]).map((quad) => (
      quad.predicate === SYSTEM_RECORD_V1_PREDICATES.ownedSubjectTable
        ? { ...quad, object: jsonLiteral(['did:dkg:agent:0xnot-this-record']) }
        : quad
    ));
    const store = fakeStore(quads);

    const read = await readLegacyAgentProfileAppliedRootsV1({
      store, networkId: NETWORK_ID, mode: 'authoritative', roots: [ROOT],
    });

    // Undecided, never uncovered: a table that cannot be validated against its own root
    // cannot be used to classify that root's quads, and guessing would insert.
    expect(read.records).toEqual([]);
    expect(read.unclassifiedRoots).toEqual([ROOT]);
  });
});

describe('legacy agent-profile gate read — projection membership', () => {
  const projectionGraph = systemRecordProjectionGraphV1('authoritative');

  it('returns the projection rows under authoritative mode', async () => {
    const store = fakeStore([
      { subject: ROOT, predicate: 'urn:p', object: '"signed"', graph: projectionGraph },
    ]);

    const read = await readLegacyAgentProfileProjectionV1({
      store, mode: 'authoritative', subjects: [ROOT],
    });

    expect(read.truncated).toBe(false);
    expect(read.rows).toEqual([
      { subject: ROOT, predicate: 'urn:p', object: '"signed"', graph: projectionGraph },
    ]);
  });

  it('reports nothing under shadow mode, and issues no query at all', async () => {
    const store = fakeStore([
      { subject: ROOT, predicate: 'urn:p', object: '"signed"', graph: projectionGraph },
    ]);

    const read = await readLegacyAgentProfileProjectionV1({
      store, mode: 'shadow', subjects: [ROOT],
    });

    expect(read.rows).toEqual([]);
    expect(read.truncated).toBe(false);
    expect(store.queries).toEqual([]);
  });

  it('reports truncated rather than asking a partial question above the subject bound', async () => {
    const store = fakeStore([]);
    const subjects = Array.from({ length: 2_049 }, (_, i) => `${ROOT}/.well-known/genid/capability${i + 1}`);

    const read = await readLegacyAgentProfileProjectionV1({
      store, mode: 'authoritative', subjects,
    });

    expect(read.truncated).toBe(true);
    expect(read.rows).toEqual([]);
    expect(store.queries).toEqual([]);
  });
});

/**
 * The overflow channels the gate acts on, driven through the REAL reader.
 *
 * Everything above this point either fakes the reported channel at the gate layer or
 * exercises a pre-query shortcut that returns before the store is touched. Neither reaches
 * the code that DECIDES a response was too large — the running byte total, the cut, and
 * the row-count detection. Those are the branches the whole byte-cap argument rests on,
 * and until now they could have been deleted with the suite still green.
 *
 * The caps are the real imported constants, so these cannot pass against a reader that
 * invented its own bound.
 */
describe('bounded-read overflow, computed by the real reader', () => {
  /**
   * A bulky but entirely VALID owned-subject table: the root plus the largest run of
   * capability subjects the record may own, UTF-8 sorted and duplicate-free.
   *
   * Bulk has to come from many real subjects rather than one long one. A padded IRI is
   * rejected as a table that cannot be decoded against its own root, and an over-long
   * table trips its own 256 KiB cap — either way the root lands in `unclassifiedRoots`
   * for a reason that has nothing to do with the response budget, and the test would pass
   * while proving nothing about the cut.
   */
  function bulkOwnedSubjects(root: string): string[] {
    const capabilities = Array.from(
      { length: SYSTEM_RECORD_MAX_OWNED_SUBJECTS - 1 },
      // `cap<n>` is the REAL indexed-genid shape. `capability<n>` looks plausible and is
      // rejected: it starts with the `cap` prefix but leaves `ability<n>`, which is not an
      // ordinal. A fixture using it lands every root in `unclassifiedRoots` for a
      // validation reason and the byte-budget assertion would never be reached.
      (_, i) => `${root}/.well-known/genid/cap${i + 1}`,
    ).sort();
    return [root, ...capabilities];
  }

  function bulkRecordQuads(root: string): Quad[] {
    return appliedRecordQuads(root, bulkOwnedSubjects(root));
  }

  it('reports the roots that cross the applied-roots byte budget, and keeps the ones before', async () => {
    // No SINGLE table can cross the response budget — an owned-subject table has its own
    // smaller cap, and an over-cap table is rejected as undecodable for a different
    // reason entirely. The response budget is a RUNNING total across roots, so crossing
    // it is inherently a multi-root property and the fixture has to be built that way.
    //
    // Asserting BOTH halves is the point: a reader that gave up on the whole batch as
    // soon as any budget was touched would also "withhold safely", while destroying the
    // coverage this gate exists to provide.
    const root = (i: number) => `did:dkg:agent:0x${(i + 1).toString(16).repeat(40).slice(0, 40)}`;
    // The budget is measured against the literal the reader actually retains, so the cut
    // point is derived from that same literal rather than from a guessed table size.
    const per = jsonLiteral(bulkOwnedSubjects(root(0))).length;
    const fits = Math.floor(SYSTEM_RECORD_MAX_ATOMIC_RESERVED_INSPECTION_RESPONSE_BYTES / per);
    const roots = Array.from({ length: fits + 2 }, (_, i) => root(i));
    const ordered = [...roots].sort();
    const store = fakeStore(ordered.flatMap(bulkRecordQuads));

    const read = await readLegacyAgentProfileAppliedRootsV1({
      store, networkId: NETWORK_ID, mode: 'authoritative', roots,
    });

    // Deterministic in sorted root order, so WHICH roots fall outside the budget is a
    // function of the request rather than of result ordering.
    expect(read.records.map((record) => record.root)).toEqual(ordered.slice(0, fits));
    expect(read.unclassifiedRoots).toEqual(ordered.slice(fits));
    expect(read.unclassifiedRoots.length).toBeGreaterThan(0);
  });

  it('reports truncated when the projection response exceeds the row cap', async () => {
    const rows = Array.from({ length: SYSTEM_RECORD_MAX_PROJECTION_QUADS + 1 }, (_, i) => ({
      subject: ROOT,
      predicate: `urn:p${i}`,
      object: '"o"',
      graph: systemRecordProjectionGraphV1('authoritative'),
    }));
    const store = fakeStore(rows);

    const read = await readLegacyAgentProfileProjectionV1({
      store, mode: 'authoritative', subjects: [ROOT],
    });

    expect(read.truncated).toBe(true);
    expect(read.rows).toEqual([]);
    // It really asked — this is the post-decode branch, not the pre-query shortcut the
    // subject-bound case above takes.
    expect(store.queries).toHaveLength(1);
  });

  /** A store whose transport refuses the body before parsing, the way a real one does. */
  function refusingStore(): TripleStore {
    return {
      async query(): Promise<QueryResult> {
        throw Object.assign(new Error('Triple-store response exceeds byte limit'), {
          code: 'STORE_RESPONSE_TOO_LARGE',
        });
      },
    } as unknown as TripleStore;
  }

  // The transport cap is only a contract if it is actually REQUESTED. Deleting the option
  // from either call leaves every other case in this file green, because a fake store that
  // ignores options behaves identically with and without it.
  it('asks the store to enforce each read\'s response cap', async () => {
    const store = fakeStore(appliedRecordQuads(ROOT, [ROOT]));

    await readLegacyAgentProfileAppliedRootsV1({
      store, networkId: NETWORK_ID, mode: 'authoritative', roots: [ROOT],
    });
    await readLegacyAgentProfileProjectionV1({
      store, mode: 'authoritative', subjects: [ROOT],
    });

    expect(store.options[0]?.maxResponseBytes)
      .toBe(SYSTEM_RECORD_MAX_ATOMIC_RESERVED_INSPECTION_RESPONSE_BYTES);
    expect(store.options[1]?.maxResponseBytes).toBe(SYSTEM_RECORD_MAX_PROJECTION_BYTES);
  });

  // ...and only a contract if the refusal is TRANSLATED. Rethrowing instead would drop the
  // whole page at the seam, which is the retry-storm the port contract exists to avoid —
  // and no test here would have noticed, because no fake store threw the canonical error.
  it('turns a transport cap refusal into undecided roots rather than throwing', async () => {
    const read = await readLegacyAgentProfileAppliedRootsV1({
      store: refusingStore(), networkId: NETWORK_ID, mode: 'authoritative', roots: [ROOT, OTHER_ROOT],
    });

    expect(read.records).toEqual([]);
    expect([...read.unclassifiedRoots].sort()).toEqual([ROOT, OTHER_ROOT].sort());
  });

  it('turns a transport cap refusal into a truncated projection rather than throwing', async () => {
    const read = await readLegacyAgentProfileProjectionV1({
      store: refusingStore(), mode: 'authoritative', subjects: [ROOT],
    });

    expect(read.rows).toEqual([]);
    expect(read.truncated).toBe(true);
  });

  // The DISCRIMINATOR between the canonical retained-byte accounting and a hand-rolled
  // `s + p + o` sum. This payload is deliberately UNDER the cap by the naive measure and
  // OVER it by the real one, so a reader counting bytes locally would hand back these rows
  // as an exact projection while the process retains well past the bound. It asserts the
  // observable (`truncated`), not the formula.
  it('counts retained bytes the way the rest of system-record does, not a local sum', async () => {
    const rows = Array.from({ length: 3 }, (_, i) => ({
      subject: ROOT,
      predicate: `urn:p${i}`,
      object: `"${'z'.repeat(480_000)}"`,
      graph: systemRecordProjectionGraphV1('authoritative'),
    }));
    const naive = rows.reduce((n, r) => n
      + Buffer.byteLength(r.subject) + Buffer.byteLength(r.predicate) + Buffer.byteLength(r.object), 0);
    // The premise, asserted rather than assumed: naive accounting would NOT have tripped.
    expect(naive).toBeLessThan(SYSTEM_RECORD_MAX_PROJECTION_BYTES);

    const read = await readLegacyAgentProfileProjectionV1({
      store: fakeStore(rows), mode: 'authoritative', subjects: [ROOT],
    });

    expect(read.truncated).toBe(true);
    expect(read.rows).toEqual([]);
  });

  it('reports truncated when the projection response exceeds the byte cap under the row cap', async () => {
    // Deliberately FEW rows, so only the byte accounting can detect this. A reader that
    // implemented the row cap alone passes every other case in this file and fails here.
    const wide = Math.ceil(SYSTEM_RECORD_MAX_PROJECTION_BYTES / 4);
    const rows = Array.from({ length: 5 }, (_, i) => ({
      subject: ROOT,
      predicate: `urn:p${i}`,
      object: `"${'y'.repeat(wide)}"`,
      graph: systemRecordProjectionGraphV1('authoritative'),
    }));
    const store = fakeStore(rows);

    const read = await readLegacyAgentProfileProjectionV1({
      store, mode: 'authoritative', subjects: [ROOT],
    });

    expect(rows.length).toBeLessThan(SYSTEM_RECORD_MAX_PROJECTION_QUADS);
    expect(read.truncated).toBe(true);
    expect(read.rows).toEqual([]);
  });
});

/**
 * The queries actually PARSE AND RUN.
 *
 * Adopted from review. Every case above answers through a string-scanning fake, which
 * validates this module's expectations about its own SPARQL rather than the SPARQL. A
 * regression emitting malformed text that still contained `GRAPH <...>`, `?claim ?table`
 * and the right IRIs would satisfy that fake completely — and a real store would reject
 * it, which at the seam means the lookup THROWS and the per-context-graph catch drops the
 * whole page. Silent loss of legacy sync, from a suite that stayed green.
 *
 * So this seeds a real Oxigraph and runs both reads end to end. It is deliberately a
 * smoke test: the bounded/overflow edges stay on the fake, where they can be driven
 * precisely. What this adds is the one property the fake structurally cannot give —
 * that the emitted query is valid against the engine production uses.
 */
describe('the generated SPARQL against a real store', () => {
  const PROJECTION_GRAPH = systemRecordProjectionGraphV1('authoritative');

  async function seededStore(): Promise<OxigraphStore> {
    const store = new OxigraphStore();
    await store.insert([
      ...appliedRecordQuads(ROOT, [ROOT]),
      { subject: ROOT, predicate: 'urn:p', object: '"signed"', graph: PROJECTION_GRAPH },
    ]);
    return store;
  }

  it('resolves the applied root through a real engine, and stays inert under shadow', async () => {
    const store = await seededStore();

    const live = await readLegacyAgentProfileAppliedRootsV1({
      store, networkId: NETWORK_ID, mode: 'authoritative', roots: [ROOT],
    });
    const shadow = await readLegacyAgentProfileAppliedRootsV1({
      store, networkId: NETWORK_ID, mode: 'shadow', roots: [ROOT],
    });

    expect(live.records).toEqual([{ root: ROOT, ownedSubjects: [ROOT] }]);
    expect(live.unclassifiedRoots).toEqual([]);
    // The mode counterfactual again, but here the authoritative half proves the query is
    // executable rather than merely well-scanned — so the shadow half's emptiness is
    // known to be the mode and not a query the engine refused.
    expect(shadow.records).toEqual([]);
  });

  it('reads the projection row through a real engine, and stays inert under shadow', async () => {
    const store = await seededStore();

    const live = await readLegacyAgentProfileProjectionV1({
      store, mode: 'authoritative', subjects: [ROOT],
    });
    const shadow = await readLegacyAgentProfileProjectionV1({
      store, mode: 'shadow', subjects: [ROOT],
    });

    expect(live.truncated).toBe(false);
    expect(live.rows).toEqual([
      { subject: ROOT, predicate: 'urn:p', object: '"signed"', graph: PROJECTION_GRAPH },
    ]);
    expect(shadow.rows).toEqual([]);
  });
});
