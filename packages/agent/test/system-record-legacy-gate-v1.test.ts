/**
 * Contract tests for `LegacyAgentProfileGateV1`, plan lines 924-930.
 *
 * Both the module and this file are greenfield, so every assertion here is a contract
 * from day one rather than a characterization of observed behaviour. Each block cites the
 * plan sentence it pins.
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

function quad(subject: string, predicate: string, object: string): Quad {
  return { subject, predicate, object, graph: AGENTS_GRAPH };
}

/**
 * A lookup that answers from an explicit applied set and records its call shape, so every
 * assertion about the store budget is made against calls that actually happened.
 */
function fakeLookup(records: readonly LegacyAgentProfileAppliedRootV1[], projection: readonly Quad[]) {
  const lookupAppliedRoots = vi.fn(async (roots: readonly string[]) =>
    records.filter((record) => roots.includes(record.root)));
  const lookupProjectionMembership = vi.fn(async (subjects: readonly string[]) =>
    projection.filter((row) => subjects.includes(row.subject)));
  const lookup: LegacyAgentProfileGateLookupV1 = { lookupAppliedRoots, lookupProjectionMembership };
  return { lookup, lookupAppliedRoots, lookupProjectionMembership };
}

// :926 — exact `did:dkg:agent:<address>` roots; strip `/.well-known/` from allowed
// descendants; strip only a validated `#x25519-<32 lowercase hex>` fragment; unknown
// shapes remain uncovered.
describe('deriveLegacyAgentProfileRootV1 (:926 root derivation)', () => {
  it('accepts an exact agent root as its own root', () => {
    expect(deriveLegacyAgentProfileRootV1(ROOT)).toBe(ROOT);
  });

  it('strips a /.well-known/ descendant back to its root', () => {
    expect(deriveLegacyAgentProfileRootV1(deriveAgentProfileOwnedSubjectV1(ROOT, 'hosting'))).toBe(ROOT);
    expect(deriveLegacyAgentProfileRootV1(deriveAgentProfileOwnedSubjectV1(ROOT, 'capability', 7))).toBe(ROOT);
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
});

// :924 — exact duplicates discarded before store insertion; conflicting quads held aside.
// :925 — streaming per quad, never page equality.
describe('LegacyAgentProfileGateV1 — covered roots (:924, :925)', () => {
  const applied: LegacyAgentProfileAppliedRootV1 = { root: ROOT, ownedSubjects: [ROOT] };
  const projection = [quad(ROOT, 'p', 'o1'), quad(ROOT, 'p', 'o2')];

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
    const owned = [ROOT, deriveAgentProfileOwnedSubjectV1(ROOT, 'hosting')];
    const applied: LegacyAgentProfileAppliedRootV1 = { root: ROOT, ownedSubjects: owned };
    const projection = [quad(ROOT, 'p', 'o1'), quad(owned[1] as string, 'p', 'o2')];

    const pages: Quad[][] = [
      [quad(ROOT, 'p', 'o1')],
      [quad(ROOT, 'p', 'rewritten')],
      [quad(owned[1] as string, 'p', 'o2'), quad(owned[1] as string, 'p', 'extra')],
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
    const projection = [quad(ROOT, 'p', 'o1'), quad(hosting, 'p', 'o2')];

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
    const projection = roots.map((root) => quad(root, 'p', 'o'));
    const { lookup, lookupAppliedRoots, lookupProjectionMembership } = fakeLookup(applied, projection);

    const result = await createLegacyAgentProfileGateV1(lookup).filterPage(projection.map((row) => ({ ...row })));

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
    const projection = roots.map((root) => quad(root, 'p', 'o'));
    const { lookup, lookupAppliedRoots, lookupProjectionMembership } = fakeLookup(applied, projection);

    const result = await createLegacyAgentProfileGateV1(lookup).filterPage(projection.map((row) => ({ ...row })));

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
    // Sorted selection takes the numerically-lowest roots; index 1 and 2 are in-batch.
    const roots = Array.from({ length: total }, (_, i) => rootAt(i + 1));
    const applied = roots.map((root) => ({ root, ownedSubjects: [root] }));
    const projection = roots.map((root) => quad(root, 'p', 'o'));
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
    const owned = Array.from(
      { length: SYSTEM_RECORD_MAX_OWNED_SUBJECTS + 1 },
      (_, i) => deriveAgentProfileOwnedSubjectV1(ROOT, 'capability', i + 1),
    );
    const applied: LegacyAgentProfileAppliedRootV1 = { root: ROOT, ownedSubjects: owned };
    const { lookup, lookupProjectionMembership } = fakeLookup([applied], []);

    const result = await createLegacyAgentProfileGateV1(lookup)
      .filterPage(owned.map((subject) => quad(subject, 'p', 'o')));

    expect(result.insert).toEqual([]);
    expect(result.withheld).toHaveLength(owned.length);
    expect(result.unclassifiedRoots).toBe(1);
    // The over-cap membership read is never issued.
    expect(lookupProjectionMembership).not.toHaveBeenCalled();
    expect(result.storeRequests).toBe(1);
  });

  it('withholds covered roots when the membership response exceeds the projection cap', async () => {
    const applied: LegacyAgentProfileAppliedRootV1 = { root: ROOT, ownedSubjects: [ROOT] };
    const oversized = Array.from(
      { length: SYSTEM_RECORD_MAX_PROJECTION_QUADS + 1 },
      (_, i) => quad(ROOT, 'p', `o${i}`),
    );
    const { lookup } = fakeLookup([applied], oversized);

    const result = await createLegacyAgentProfileGateV1(lookup).filterPage([quad(ROOT, 'p', 'o0')]);

    expect(result.insert).toEqual([]);
    expect(result.withheld).toHaveLength(1);
    expect(result.unclassifiedRoots).toBe(1);
    expect(result.discardedDuplicates).toBe(0);
    expect(result.storeRequests).toBe(2);
  });
});
