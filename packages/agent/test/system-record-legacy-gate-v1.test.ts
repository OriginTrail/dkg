/**
 * Contract tests for `LegacyAgentProfileGateV1`, plan lines 924-930.
 *
 * Both the module and this file are greenfield, so every assertion here is a contract
 * from day one rather than a characterization of observed behaviour. Each block cites the
 * plan sentence it pins.
 *
 * Fixture discipline that matters for the key contract: the applied projection is modelled
 * GRAPHLESS while the inbound legacy page carries the aggregate `agents` graph, because
 * that is how they really differ. Using one graph for both would let a regression that
 * started comparing `graph` pass every duplicate test while withholding real duplicates.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  deriveAgentProfileOwnedSubjectV1,
  SYSTEM_RECORD_MAX_OWNED_SUBJECTS,
  SYSTEM_RECORD_MAX_PROJECTION_QUADS,
} from '@origintrail-official/dkg-core/system-record-v1';
import type { Quad } from '@origintrail-official/dkg-storage';

import {
  createLegacyAgentProfileGateV1,
  deriveLegacyAgentProfileRootV1,
  LEGACY_AGENT_PROFILE_GATE_MAX_BATCH_ROOTS_V1,
  type LegacyAgentProfileAppliedRootV1,
  type LegacyAgentProfileGateLookupV1,
} from '../src/system-records/legacy-profile-gate-v1.js';

const AGENTS_GRAPH = 'did:dkg:context-graph:agents';

function rootAt(index: number): string {
  return `did:dkg:agent:0x${index.toString(16).padStart(40, '0')}`;
}

const ROOT = rootAt(1);
const OTHER_ROOT = rootAt(2);
const X25519_SUFFIX = 'a'.repeat(32);

/** An inbound legacy quad: carries the aggregate agents graph. */
function quad(subject: string, predicate: string, object: string): Quad {
  return { subject, predicate, object, graph: AGENTS_GRAPH };
}

/** An applied-projection row as the store really holds it: graphless. */
function projectionRow(subject: string, predicate: string, object: string): Quad {
  return { subject, predicate, object, graph: '' };
}

/**
 * A lookup that answers from an explicit applied set and records its call shape, so every
 * assertion about the store budget is made against calls that actually happened.
 *
 * `bounds` models an implementation that hit one of :926's byte caps. It is deliberately
 * expressed as a response the gate RECEIVES rather than as a shorter list, because the
 * whole point of the reported channel is that a short list is indistinguishable from
 * "no record here" — a fixture that simulated a byte cap by returning fewer records
 * would be testing the very confusion the contract exists to remove.
 */
function fakeLookup(
  records: readonly LegacyAgentProfileAppliedRootV1[],
  projection: readonly Quad[],
  bounds: { unclassifiedRoots?: readonly string[]; truncated?: boolean } = {},
) {
  const lookupAppliedRoots = vi.fn(async (roots: readonly string[]) => ({
    records: records.filter((record) => roots.includes(record.root)),
    unclassifiedRoots: (bounds.unclassifiedRoots ?? []).filter((root) => roots.includes(root)),
  }));
  const lookupProjectionMembership = vi.fn(async (subjects: readonly string[]) => ({
    rows: projection.filter((row) => subjects.includes(row.subject)),
    truncated: bounds.truncated ?? false,
  }));
  const lookup: LegacyAgentProfileGateLookupV1 = {
    projectionGraph: AGENTS_GRAPH,
    lookupAppliedRoots,
    lookupProjectionMembership,
  };
  return { lookup, lookupAppliedRoots, lookupProjectionMembership };
}

// :926 — exact `did:dkg:agent:<address>` roots; strip `/.well-known/` from allowed
// descendants; strip only a validated `#x25519-<32 lowercase hex>` fragment; unknown
// shapes remain uncovered.
describe('deriveLegacyAgentProfileRootV1 (:926 root derivation)', () => {
  it('accepts an exact agent root as its own root', () => {
    expect(deriveLegacyAgentProfileRootV1(ROOT)).toBe(ROOT);
  });

  it('round-trips every owned-subject shape core can derive', () => {
    // If core changes an existing shape, this fails. It cannot detect a NEW shape with a
    // new separator — core's policy table is module-private — which is why reverse
    // derivation belongs in core; recorded on the PR rather than silently accepted.
    expect(deriveLegacyAgentProfileRootV1(deriveAgentProfileOwnedSubjectV1(ROOT, 'hosting'))).toBe(ROOT);
    expect(deriveLegacyAgentProfileRootV1(deriveAgentProfileOwnedSubjectV1(ROOT, 'registration'))).toBe(ROOT);
    expect(deriveLegacyAgentProfileRootV1(deriveAgentProfileOwnedSubjectV1(ROOT, 'capability', 7))).toBe(ROOT);
    expect(deriveLegacyAgentProfileRootV1(deriveAgentProfileOwnedSubjectV1(ROOT, 'offering', 3))).toBe(ROOT);
    expect(deriveLegacyAgentProfileRootV1(`${ROOT}#x25519-${X25519_SUFFIX}`)).toBe(ROOT);
  });

  it('strips only a validated x25519 fragment', () => {
    expect(deriveLegacyAgentProfileRootV1(`${ROOT}#x25519-${X25519_SUFFIX}`)).toBe(ROOT);
    // One hex digit short, one too long, uppercase, and a non-x25519 fragment must all
    // stay uncovered rather than being stripped to a root that would then be gated.
    expect(deriveLegacyAgentProfileRootV1(`${ROOT}#x25519-${'a'.repeat(31)}`)).toBeNull();
    expect(deriveLegacyAgentProfileRootV1(`${ROOT}#x25519-${'a'.repeat(33)}`)).toBeNull();
    expect(deriveLegacyAgentProfileRootV1(`${ROOT}#x25519-${'A'.repeat(32)}`)).toBeNull();
    expect(deriveLegacyAgentProfileRootV1(`${ROOT}#other`)).toBeNull();
  });

  it('leaves unknown shapes uncovered', () => {
    expect(deriveLegacyAgentProfileRootV1('https://example.com/agent')).toBeNull();
    expect(deriveLegacyAgentProfileRootV1(`${ROOT}/other`)).toBeNull();
    expect(deriveLegacyAgentProfileRootV1(`${ROOT}/.well-known/genid/unknown`)).toBeNull();
    // Strips at `/.well-known/` but core's genid prefix is narrower, so this falls out.
    expect(deriveLegacyAgentProfileRootV1(`${ROOT}/.well-known/other/thing`)).toBeNull();
    expect(deriveLegacyAgentProfileRootV1(`did:dkg:agent:0x${'A'.repeat(40)}`)).toBeNull();
    expect(deriveLegacyAgentProfileRootV1('')).toBeNull();
  });

  it('does not strip a fragment sitting on a non-root path', () => {
    expect(deriveLegacyAgentProfileRootV1(`${ROOT}/.well-known/genid/hosting#x25519-${X25519_SUFFIX}`))
      .toBeNull();
  });
});

// :924 — "Uncovered roots use legacy insertion." :78 — "Uncovered roots keep current
// legacy behavior."
describe('LegacyAgentProfileGateV1 — uncovered roots keep legacy behaviour (:924, :78)', () => {
  it('inserts every quad and performs no store read when nothing derives a root', async () => {
    const { lookup, lookupAppliedRoots, lookupProjectionMembership } = fakeLookup([], []);
    const quads = [quad('https://example.com/a', 'p', 'o'), quad('urn:x', 'p', 'o')];

    const result = await createLegacyAgentProfileGateV1(lookup).filterPage(quads);

    expect(result.insert).toEqual(quads);
    expect(result.withheld).toEqual([]);
    expect(result.conflictedRoots).toBe(0);
    expect(result.unclassifiedRoots).toBe(0);
    expect(result.storeRequests).toBe(0);
    expect(lookupAppliedRoots).not.toHaveBeenCalled();
    expect(lookupProjectionMembership).not.toHaveBeenCalled();
  });

  it('inserts quads for a derived root that carries no applied record', async () => {
    const { lookup, lookupProjectionMembership } = fakeLookup([], []);
    const quads = [quad(ROOT, 'p', 'o')];

    const result = await createLegacyAgentProfileGateV1(lookup).filterPage(quads);

    expect(result.insert).toEqual(quads);
    expect(result.conflictedRoots).toBe(0);
    // The root resolved to no record, so no membership read is owed.
    expect(lookupProjectionMembership).not.toHaveBeenCalled();
    expect(result.storeRequests).toBe(1);
  });

  // A passthrough page must come out in the order it went in: "unchanged" includes order,
  // and root selection is sorted for batching, which must not leak into emission.
  it('preserves arrival order across interleaved unknown-shape and derived-root quads', async () => {
    const { lookup } = fakeLookup([], []);
    const quads = [
      quad(OTHER_ROOT, 'p', 'o'),
      quad('urn:x', 'p', 'o'),
      quad(ROOT, 'p', 'o'),
      quad('https://example.com/a', 'p', 'o'),
    ];

    const result = await createLegacyAgentProfileGateV1(lookup).filterPage(quads);

    expect(result.insert).toEqual(quads);
  });
});

// :924 — exact duplicates discarded before store insertion; conflicting quads held aside.
// :925 — streaming per quad, never page equality.
describe('LegacyAgentProfileGateV1 — covered roots (:924, :925)', () => {
  const applied: LegacyAgentProfileAppliedRootV1 = { root: ROOT, ownedSubjects: [ROOT] };
  const projection = [projectionRow(ROOT, 'p', 'o1'), projectionRow(ROOT, 'p', 'o2')];

  it('discards exact duplicates before insertion', async () => {
    const { lookup } = fakeLookup([applied], projection);

    const result = await createLegacyAgentProfileGateV1(lookup).filterPage([
      quad(ROOT, 'p', 'o1'),
      quad(ROOT, 'p', 'o2'),
    ]);

    expect(result.discardedDuplicates).toBe(2);
    expect(result.insert).toEqual([]);
    expect(result.withheld).toEqual([]);
    expect(result.conflictedRoots).toBe(0);
    expect(result.storeRequests).toBe(2);
  });

  // The applied projection is graphless and the legacy page carries the agents graph, so
  // this fails the moment membership identity starts including `graph`.
  it('matches duplicates across differing graphs', async () => {
    const { lookup } = fakeLookup([applied], projection);

    const result = await createLegacyAgentProfileGateV1(lookup)
      .filterPage([{ subject: ROOT, predicate: 'p', object: 'o1', graph: AGENTS_GRAPH }]);

    expect(result.discardedDuplicates).toBe(1);
    expect(result.withheld).toEqual([]);
    expect(result.conflictedRoots).toBe(0);
  });

  // T1, half B — the half that scoping by SUBJECT ALONE gets wrong, and the reason the
  // two conjuncts are independent. This quad names a covered agent root and would
  // conflict with the projection on content, but it is bound for a different context
  // graph, where the signed projection does not live. Nothing can be overwritten there,
  // so withholding it would be pure data loss in an unrelated graph.
  //
  // The zero-read assertion is what makes it a scope test rather than a duplicate of the
  // pass-through case: a gate that consulted the store and then decided to pass would
  // also satisfy the offer assertion, while spending :926's budget on a page that cannot
  // collide with anything.
  it('passes an agent-root quad bound for another context graph, and reads nothing', async () => {
    const { lookup, lookupAppliedRoots } = fakeLookup([applied], projection);
    const elsewhere = {
      subject: ROOT, predicate: 'p', object: 'different', graph: 'did:dkg:context-graph:project-x',
    };

    const result = await createLegacyAgentProfileGateV1(lookup).filterPage([elsewhere]);

    expect(result.insert).toEqual([elsewhere]);
    expect(result.withheld).toEqual([]);
    expect(result.conflictedRoots).toBe(0);
    expect(result.storeRequests).toBe(0);
    expect(lookupAppliedRoots).not.toHaveBeenCalled();
  });

  it('withholds a conflicting quad and counts the root as conflicted', async () => {
    const { lookup } = fakeLookup([applied], projection);
    const conflicting = quad(ROOT, 'p', 'different');

    const result = await createLegacyAgentProfileGateV1(lookup).filterPage([
      quad(ROOT, 'p', 'o1'),
      conflicting,
    ]);

    expect(result.discardedDuplicates).toBe(1);
    expect(result.withheld).toEqual([conflicting]);
    expect(result.conflictedRoots).toBe(1);
    expect(result.unclassifiedRoots).toBe(0);
    expect(result.insert).toEqual([]);
  });

  it('treats a quad on an unowned subject of a covered root as a conflict', async () => {
    const { lookup } = fakeLookup([applied], projection);
    // Derives to a covered root but is absent from the record's owned-subject table.
    const foreign = quad(deriveAgentProfileOwnedSubjectV1(ROOT, 'hosting'), 'p', 'o');

    const result = await createLegacyAgentProfileGateV1(lookup).filterPage([foreign]);

    expect(result.withheld).toEqual([foreign]);
    expect(result.insert).toEqual([]);
    expect(result.conflictedRoots).toBe(1);
  });

  // :925 — "a page that omits other record quads has no deletion/conflict meaning".
  it('reads omission as neither deletion nor conflict', async () => {
    const { lookup } = fakeLookup([applied], projection);

    // The page carries a strict subset of the applied projection.
    const result = await createLegacyAgentProfileGateV1(lookup).filterPage([quad(ROOT, 'p', 'o1')]);

    expect(result.discardedDuplicates).toBe(1);
    expect(result.withheld).toEqual([]);
    expect(result.conflictedRoots).toBe(0);
    expect(result.unclassifiedRoots).toBe(0);
  });

  it('classifies a covered and an uncovered root independently in one page', async () => {
    const { lookup } = fakeLookup([applied], projection);
    const uncoveredQuad = quad(OTHER_ROOT, 'p', 'o');

    const result = await createLegacyAgentProfileGateV1(lookup).filterPage([
      quad(ROOT, 'p', 'o1'),
      uncoveredQuad,
      quad(ROOT, 'p', 'conflict'),
    ]);

    expect(result.insert).toEqual([uncoveredQuad]);
    expect(result.discardedDuplicates).toBe(1);
    expect(result.conflictedRoots).toBe(1);
  });
});

// :1505 — "signed state cannot be overwritten".
describe('LegacyAgentProfileGateV1 — signed state cannot be overwritten (:1505)', () => {
  it('never offers a quad of a covered root for insertion, under any page shape', async () => {
    const hosting = deriveAgentProfileOwnedSubjectV1(ROOT, 'hosting');
    const applied: LegacyAgentProfileAppliedRootV1 = { root: ROOT, ownedSubjects: [ROOT, hosting] };
    const projection = [projectionRow(ROOT, 'p', 'o1'), projectionRow(hosting, 'p', 'o2')];

    const pages: Quad[][] = [
      [quad(ROOT, 'p', 'o1')],
      [quad(ROOT, 'p', 'rewritten')],
      [quad(hosting, 'p', 'o2'), quad(hosting, 'p', 'extra')],
      [quad(`${ROOT}#x25519-${X25519_SUFFIX}`, 'p', 'o')],
      [quad(ROOT, 'p', 'o1'), quad(ROOT, 'p', 'rewritten'), quad(OTHER_ROOT, 'p', 'o')],
    ];

    for (const page of pages) {
      const { lookup } = fakeLookup([applied], projection);
      const result = await createLegacyAgentProfileGateV1(lookup).filterPage(page);
      // Leakage is detected with an independent literal prefix rather than by calling the
      // production deriver: an assertion routed through the code under test would pass
      // vacuously the moment that deriver regressed to returning null.
      const leaked = result.insert.filter((row) => row.subject.startsWith(ROOT));
      expect(leaked).toEqual([]);
    }
  });
});

// :925 — "Page splits across root, nested, and key subjects are expected."
describe('LegacyAgentProfileGateV1 — a profile split across conflicting legacy pages (:925)', () => {
  it('classifies each page independently and only the conflicting page reports a conflict', async () => {
    const hosting = deriveAgentProfileOwnedSubjectV1(ROOT, 'hosting');
    const applied: LegacyAgentProfileAppliedRootV1 = { root: ROOT, ownedSubjects: [ROOT, hosting] };
    const projection = [projectionRow(ROOT, 'p', 'o1'), projectionRow(hosting, 'p', 'o2')];

    const first = fakeLookup([applied], projection);
    const clean = await createLegacyAgentProfileGateV1(first.lookup).filterPage([quad(ROOT, 'p', 'o1')]);

    const second = fakeLookup([applied], projection);
    const dirty = await createLegacyAgentProfileGateV1(second.lookup)
      .filterPage([quad(hosting, 'p', 'rewritten')]);

    expect(clean.discardedDuplicates).toBe(1);
    expect(clean.conflictedRoots).toBe(0);
    expect(dirty.withheld).toHaveLength(1);
    expect(dirty.conflictedRoots).toBe(1);
    // Neither page inserted anything for the covered root.
    expect(clean.insert).toEqual([]);
    expect(dirty.insert).toEqual([]);
  });
});

// :926 — at most two physical store requests for one legacy page; cap exceeded means the
// unclassified signed-root quads are withheld, and "absence never conflicts, so received
// quads in the batch are classified independently against the exact applied set".
describe('LegacyAgentProfileGateV1 — bounded store requests (:926)', () => {
  it('classifies a cold page spanning 256 signed roots with exactly two store requests', async () => {
    const roots = Array.from({ length: LEGACY_AGENT_PROFILE_GATE_MAX_BATCH_ROOTS_V1 }, (_, i) => rootAt(i + 1));
    const applied = roots.map((root) => ({ root, ownedSubjects: [root] }));
    const projection = roots.map((root) => projectionRow(root, 'p', 'o'));
    const page = roots.map((root) => quad(root, 'p', 'o'));
    const { lookup, lookupAppliedRoots, lookupProjectionMembership } = fakeLookup(applied, projection);

    const result = await createLegacyAgentProfileGateV1(lookup).filterPage(page);

    expect(result.discardedDuplicates).toBe(LEGACY_AGENT_PROFILE_GATE_MAX_BATCH_ROOTS_V1);
    expect(result.insert).toEqual([]);
    expect(result.conflictedRoots).toBe(0);
    expect(result.storeRequests).toBe(2);
    expect(lookupAppliedRoots).toHaveBeenCalledTimes(1);
    expect(lookupProjectionMembership).toHaveBeenCalledTimes(1);
    expect(lookupAppliedRoots.mock.calls[0]?.[0]).toHaveLength(LEGACY_AGENT_PROFILE_GATE_MAX_BATCH_ROOTS_V1);
  });

  it('withholds roots beyond the batch instead of inserting them unclassified', async () => {
    const total = LEGACY_AGENT_PROFILE_GATE_MAX_BATCH_ROOTS_V1 + 2;
    const roots = Array.from({ length: total }, (_, i) => rootAt(i + 1));
    const applied = roots.map((root) => ({ root, ownedSubjects: [root] }));
    const projection = roots.map((root) => projectionRow(root, 'p', 'o'));
    const page = roots.map((root) => quad(root, 'p', 'o'));
    const { lookup, lookupAppliedRoots, lookupProjectionMembership } = fakeLookup(applied, projection);

    const result = await createLegacyAgentProfileGateV1(lookup).filterPage(page);

    expect(result.withheld).toHaveLength(2);
    expect(result.unclassifiedRoots).toBe(2);
    expect(result.insert).toEqual([]);
    // Still at most two physical reads, however many roots the page derived.
    expect(result.storeRequests).toBe(2);
    expect(lookupAppliedRoots).toHaveBeenCalledTimes(1);
    expect(lookupProjectionMembership).toHaveBeenCalledTimes(1);
  });

  // The composition of the two rules: exceeding the root cap must not degrade the
  // classification of the quads that DID fit in the batch.
  it('still classifies in-batch quads exactly while withholding the out-of-batch remainder', async () => {
    const total = LEGACY_AGENT_PROFILE_GATE_MAX_BATCH_ROOTS_V1 + 1;
    const roots = Array.from({ length: total }, (_, i) => rootAt(i + 1));
    const applied = roots.map((root) => ({ root, ownedSubjects: [root] }));
    const projection = roots.map((root) => projectionRow(root, 'p', 'o'));
    const { lookup } = fakeLookup(applied, projection);

    // The page itself must derive more than one batch of roots — the cap is on roots the
    // PAGE derives, not on records that exist. Root index 1 carries a conflicting object;
    // every other in-batch root repeats its applied quad exactly.
    const page: Quad[] = roots.map((root, index) =>
      quad(root, 'p', index === 1 ? 'rewritten' : 'o'));
    const result = await createLegacyAgentProfileGateV1(lookup).filterPage(page);

    // 256 selected roots: one conflicts, the other 255 are exact duplicates. The single
    // out-of-batch root is withheld unverified without being called a conflict.
    expect(result.discardedDuplicates).toBe(LEGACY_AGENT_PROFILE_GATE_MAX_BATCH_ROOTS_V1 - 1);
    expect(result.conflictedRoots).toBe(1);
    expect(result.unclassifiedRoots).toBe(1);
    expect(result.withheld).toHaveLength(2);
    expect(result.insert).toEqual([]);
    expect(result.storeRequests).toBe(2);
  });

  it('withholds covered roots whose page subjects exceed the membership batch', async () => {
    // TWO records, each with a VALID owned-subject table, whose combined page subjects
    // exceed the membership cap. Deliberately kept under the per-record cap so this
    // exercises the aggregate guard and not the untrusted-response guard below — without
    // that separation, one guard would silently take credit for the other's kill.
    const each = Math.floor(SYSTEM_RECORD_MAX_OWNED_SUBJECTS / 2) + 100;
    const ownedFor = (root: string) => Array.from(
      { length: each },
      (_, i) => deriveAgentProfileOwnedSubjectV1(root, 'capability', i + 1),
    );
    const first = ownedFor(ROOT);
    const second = ownedFor(OTHER_ROOT);
    const applied = [
      { root: ROOT, ownedSubjects: first },
      { root: OTHER_ROOT, ownedSubjects: second },
    ];
    const { lookup, lookupProjectionMembership } = fakeLookup(applied, []);
    const page = [...first, ...second].map((subject) => quad(subject, 'p', 'o'));

    const result = await createLegacyAgentProfileGateV1(lookup).filterPage(page);

    expect(each).toBeLessThanOrEqual(SYSTEM_RECORD_MAX_OWNED_SUBJECTS);
    expect(first.length + second.length).toBeGreaterThan(SYSTEM_RECORD_MAX_OWNED_SUBJECTS);
    expect(result.insert).toEqual([]);
    expect(result.withheld).toHaveLength(page.length);
    expect(result.unclassifiedRoots).toBe(2);
    // The over-cap membership read is never issued.
    expect(lookupProjectionMembership).not.toHaveBeenCalled();
    expect(result.storeRequests).toBe(1);
  });

  // The lookup port is an injected boundary, so its answer is incoming input. A
  // well-formed record cannot exceed the owned-subject cap, so an over-cap table means
  // the response is not the exact applied set; withholding is the only safe reading.
  it('refuses an applied record whose owned-subject table exceeds the cap', async () => {
    const oversized = Array.from(
      { length: SYSTEM_RECORD_MAX_OWNED_SUBJECTS + 1 },
      (_, i) => deriveAgentProfileOwnedSubjectV1(ROOT, 'capability', i + 1),
    );
    const applied: LegacyAgentProfileAppliedRootV1 = { root: ROOT, ownedSubjects: oversized };
    const { lookup, lookupProjectionMembership } = fakeLookup([applied], []);

    const result = await createLegacyAgentProfileGateV1(lookup).filterPage([quad(ROOT, 'p', 'o')]);

    expect(result.insert).toEqual([]);
    expect(result.withheld).toHaveLength(1);
    expect(result.unclassifiedRoots).toBe(1);
    expect(lookupProjectionMembership).not.toHaveBeenCalled();
    expect(result.storeRequests).toBe(1);
  });

  it('withholds covered roots when the membership response exceeds the projection cap', async () => {
    const applied: LegacyAgentProfileAppliedRootV1 = { root: ROOT, ownedSubjects: [ROOT] };
    const oversized = Array.from(
      { length: SYSTEM_RECORD_MAX_PROJECTION_QUADS + 1 },
      (_, i) => projectionRow(ROOT, 'p', `o${i}`),
    );
    const { lookup } = fakeLookup([applied], oversized);

    const result = await createLegacyAgentProfileGateV1(lookup).filterPage([quad(ROOT, 'p', 'o0')]);

    expect(result.insert).toEqual([]);
    expect(result.withheld).toHaveLength(1);
    expect(result.unclassifiedRoots).toBe(1);
    expect(result.discardedDuplicates).toBe(0);
    expect(result.storeRequests).toBe(2);
  });

  // :926 request one — "one batched VALUES query ... with a 1-MiB response cap".
  //
  // The cap can only be honoured by answering about fewer roots, and an unmentioned root
  // is otherwise indistinguishable from one that simply has no applied record. The two
  // roots below are BOTH absent from `records`; the reported channel is the only thing
  // that differs between them, so this fails if the gate ever reads omission as absence.
  it('withholds a root the applied-roots response reports it could not classify', async () => {
    const { lookup, lookupProjectionMembership } = fakeLookup([], [], {
      unclassifiedRoots: [OTHER_ROOT],
    });
    const page = [quad(ROOT, 'p', 'o'), quad(OTHER_ROOT, 'p', 'o')];

    const result = await createLegacyAgentProfileGateV1(lookup).filterPage(page);

    expect(result.insert).toEqual([page[0]]);
    expect(result.withheld).toEqual([page[1]]);
    expect(result.unclassifiedRoots).toBe(1);
    expect(result.conflictedRoots).toBe(0);
    // No root was classified as covered, so the membership read is never issued.
    expect(lookupProjectionMembership).not.toHaveBeenCalled();
    expect(result.storeRequests).toBe(1);
  });

  // :926 request two — "10,000 quads, and 2 MiB". The row count is visible to the gate;
  // the byte bound is not. The single row below IS the page's quad, so without the
  // reported flag this quad is an exact duplicate and is DISCARDED. The flag is therefore
  // the only difference between discarding and withholding.
  it('withholds covered roots when the membership response reports it was truncated', async () => {
    const applied: LegacyAgentProfileAppliedRootV1 = { root: ROOT, ownedSubjects: [ROOT] };
    const { lookup } = fakeLookup([applied], [projectionRow(ROOT, 'p', 'o')], { truncated: true });

    const result = await createLegacyAgentProfileGateV1(lookup).filterPage([quad(ROOT, 'p', 'o')]);

    expect(result.discardedDuplicates).toBe(0);
    expect(result.withheld).toHaveLength(1);
    expect(result.insert).toEqual([]);
    expect(result.unclassifiedRoots).toBe(1);
    expect(result.storeRequests).toBe(2);
  });
});
