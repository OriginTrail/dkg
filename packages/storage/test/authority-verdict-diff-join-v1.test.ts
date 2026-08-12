import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { enumerateVerdictDiffCellsV1 } from './helpers/authority-verdict-diff-cells-v1.js';
import { resolveConstructibilityV1 } from './helpers/authority-verdict-diff-constructibility-v1.js';
import { runCoreSweepV1 } from './helpers/authority-verdict-diff-core-sweep-v1.js';
import {
  CORE_DELEGATED_REJECT_REASON_SITES_V1,
  CORE_QUARANTINE_REASONS_V1,
  CORE_REJECT_REASON_SITES_V1,
} from './helpers/authority-verdict-diff-fixture-v1.js';
import {
  adjudicatePairV1,
  coreOutcomeLabelV1,
  JOIN_BUCKET_V1,
  JOIN_LEVEL1_MAP_V1,
  JOIN_NOT_COMPARABLE_CAUSE_V1,
  JOIN_SEMANTICS_V1,
  JOIN_UNADJUDICATED_V1,
  JOIN_VERDICT_V1,
  joinVerdictDiffV1,
  STORAGE_OUTCOME_CODOMAIN_V1,
  type JoinRowV1,
} from './helpers/authority-verdict-diff-join-v1.js';
import {
  JOIN_ADJUDICATED_CELLS_V1,
  JOIN_CELLS_PER_STORAGE_PROJECTION_V1,
  JOIN_CORE_ONLY_SPLIT_V1,
  JOIN_DIVERGENCES_V1,
  JOIN_FINDINGS_V1,
  JOIN_IMPOSSIBILITY_PROOFS_V1,
  JOIN_LEVEL1_PER_ENTRY_V1,
  JOIN_LEVEL1_TABLE_V1,
  JOIN_LEVEL2_REASON_PAIRS_V1,
  JOIN_NO_HEAD_SPLIT_V1,
  JOIN_NON_VACUITY_MUTANTS_V1,
  JOIN_NOT_COMPARABLE_CAUSE_TOTALS_V1,
  JOIN_PARTITION_V1,
  JOIN_PINNED_AGAINST_CORE_DIGEST_V1,
  JOIN_PRECONDITION_DISCRIMINATION_V1,
  JOIN_ROWS_V1,
  JOIN_SEMANTICS_CHANGING_ENTRIES_V1,
  JOIN_STALE_ROUTES_V1,
  JOIN_STORAGE_LABEL_REACH_V1,
  JOIN_TABLE_DIGEST_V1,
  JOIN_TOTAL_CELLS_V1,
  JOIN_UNREACHED_OUTCOMES_V1,
  JOIN_VERDICT_TOTALS_V1,
} from './helpers/authority-verdict-diff-join-table-v1.js';
import { runStorageSweepV1 } from './helpers/authority-verdict-diff-storage-sweep-v1.js';

/**
 * THE JOIN, PINNED.
 *
 * The core half of this diff is pinned by
 * `authority-verdict-diff-core-table-v1.test.ts`; the storage half is driven by
 * `authority-verdict-diff-storage-driver-v1.test.ts` and its refusal ladder.
 * This suite is the JOIN, and it is the deliverable: a per-cell verdict on how
 * the two implementations relate, pinned as fixture data rather than emitted as
 * a report.
 *
 * EVERY DISTRIBUTION IS COLLECTED THEN ASSERTED ONCE. A per-cell loop over
 * 164,160 cells with an expect() inside has timed this lane out before, and a
 * suite that times out says nothing about the thing it was measuring.
 */
const JOIN_SUITE_TIMEOUT_MS = 600_000;

/**
 * Swept ONCE. Three tests re-running a 164,160-cell join would cost three times
 * the wall clock for the same measurement, and the sweeps are pure.
 */
type SweptV1 = ReturnType<typeof joinVerdictDiffV1>
  & { readonly coreRows: Awaited<ReturnType<typeof runCoreSweepV1>> };

let cached: Promise<SweptV1> | undefined;
function join(): Promise<SweptV1> {
  cached ??= (async () => {
    const cells = resolveConstructibilityV1(enumerateVerdictDiffCellsV1()).constructible;
    const coreRows = await runCoreSweepV1(cells);
    const storageRows = await runStorageSweepV1(cells);
    return { ...joinVerdictDiffV1({ cells, coreRows, storageRows }), coreRows };
  })();
  return cached;
}

const isAdjudicated = (row: JoinRowV1): boolean =>
  row.bucket === JOIN_BUCKET_V1.COMPARABLE && row.verdict !== JOIN_VERDICT_V1.NOT_COMPARABLE;

function tally<T>(rows: readonly JoinRowV1[], key: (row: JoinRowV1) => T | undefined) {
  const out: Record<string, number> = {};
  for (const row of rows) {
    const k = key(row);
    if (k === undefined) continue;
    out[String(k)] = (out[String(k)] ?? 0) + row.cells;
  }
  return out;
}

/** Resolves a `path` or `path:N` or `path:N-M` citation against the real source. */
function resolveCitation(citation: string): { exists: boolean; lineInRange: boolean } {
  const separator = citation.lastIndexOf(':');
  const hasLine = separator > 0 && /^\d+(-\d+)?$/u.test(citation.slice(separator + 1));
  const path = hasLine ? citation.slice(0, separator) : citation;
  let source: string[];
  try {
    source = readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8').split('\n');
  } catch {
    return { exists: false, lineInRange: false };
  }
  if (!hasLine) return { exists: true, lineInRange: true };
  const first = Number(citation.slice(separator + 1).split('-')[0]);
  return { exists: true, lineInRange: first >= 1 && first <= source.length };
}

describe('authority verdict diff: the join', { timeout: JOIN_SUITE_TIMEOUT_MS }, () => {
  // THE PROVENANCE GATE, and it is deliberately the first thing here. Every
  // count in the join table was measured against ONE set of core verdicts.
  // Core's constructibility rules are under active revision -- retiring the S1
  // rule alone turns 61,920 refusals into real decisions -- and a join pinned
  // against superseded core verdicts would stay internally consistent while
  // describing outcomes that no longer exist: conserved, green, and about
  // nothing. This fails on one line naming the reason instead of on a dozen
  // distribution rows that look like a defect in the join.
  //
  // TAKEN OVER THE SWEEP'S OWN OUTPUT, never over the core table's published
  // constant. The two move at different times: when core's behaviour changes,
  // its published digest is stale until someone re-pins it, and a gate that read
  // the constant would sit green through exactly the window this gate exists
  // for. The formula matches the core table's, so the two agree once both are
  // current.
  it('is pinned against known core verdicts, and says so the moment they move', async () => {
    const { coreRows } = await join();
    const observed = createHash('sha256')
      .update(coreRows
        .map((row) => `${row.projectionKey}=>${coreOutcomeLabelV1(row.outcome)}`)
        .sort()
        .join('\n'))
      .digest('hex');
    expect(observed).toBe(JOIN_PINNED_AGAINST_CORE_DIGEST_V1);
  });

  it('pins the four-bucket partition, and derives it a second way from the projection width', async () => {
    const { rows } = await join();

    const observed: Record<string, { cells: number; storageProjections: number }> = {};
    const projections: Record<string, Set<string>> = {};
    for (const row of rows) {
      const entry = observed[row.bucket] ?? { cells: 0, storageProjections: 0 };
      entry.cells += row.cells;
      observed[row.bucket] = entry;
      (projections[row.bucket] ??= new Set()).add(row.storageProjectionKey);
    }
    for (const [bucket, set] of Object.entries(projections)) {
      observed[bucket]!.storageProjections = set.size;
    }
    expect(observed).toStrictEqual(JOIN_PARTITION_V1);

    // THE INDEPENDENT DERIVATION. Every storage projection covers exactly 192
    // cells -- min AND max, asserted by the projection suite -- so the two
    // pinned columns must reproduce each other. Without this the cell counts and
    // the projection counts could drift apart and both rows would still look
    // well formed.
    for (const [bucket, row] of Object.entries(JOIN_PARTITION_V1)) {
      expect({ bucket, cells: row.storageProjections * JOIN_CELLS_PER_STORAGE_PROJECTION_V1 })
        .toStrictEqual({ bucket, cells: row.cells });
    }

    const totals = Object.values(JOIN_PARTITION_V1);
    expect(totals.reduce((sum, row) => sum + row.cells, 0)).toBe(JOIN_TOTAL_CELLS_V1);
    expect(totals.reduce((sum, row) => sum + row.storageProjections, 0))
      .toBe(JOIN_TOTAL_CELLS_V1 / JOIN_CELLS_PER_STORAGE_PROJECTION_V1);

    // The CORE-ONLY half that names `verifiedAuthoritySummary` is the half core
    // retires; the other half core decides and storage still cannot be driven.
    const split = tally(rows, (row) => (row.bucket === JOIN_BUCKET_V1.CORE_ONLY
      ? `namesSummary=${row.namesSummary}` : undefined));
    expect(split).toStrictEqual(
      Object.fromEntries(Object.entries(JOIN_CORE_ONLY_SPLIT_V1).map(([k, v]) => [k, v.cells])),
    );

    // The NO-HEAD bucket's own harness/system discriminator. Half of it retires
    // cells against this fixture's current-head properties rather than against
    // anything the system forbids, and the split is pinned so it cannot quietly
    // collapse back into one cause.
    const noHead = tally(rows, (row) => (row.bucket === JOIN_BUCKET_V1.NO_HEAD
      ? (row.cause === JOIN_NOT_COMPARABLE_CAUSE_V1.NO_CANDIDATE_HEAD_SYSTEM
        ? 'system-forbids-the-input' : 'fixture-cannot-build-the-referent')
      : undefined));
    expect(noHead).toStrictEqual(JOIN_NO_HEAD_SPLIT_V1);
    expect(Object.values(JOIN_NO_HEAD_SPLIT_V1).reduce((a, b) => a + b, 0))
      .toBe(JOIN_PARTITION_V1['NO-HEAD']!.cells);
  });

  it('pins every join row exactly, and the verdict distribution that localises a move', async () => {
    const { rows } = await join();
    expect(rows).toHaveLength(JOIN_ROWS_V1);

    // The digest DETECTS a change: two rows swapping verdicts with compensating
    // counts leaves every distribution below untouched and moves this hash.
    const digest = createHash('sha256')
      .update(rows
        .map((row) => `${row.coreProjectionKey}>>${row.storageProjectionKey}`
          + `=>${row.verdict}|${row.coreLabel}|${row.storageLabel}`)
        .sort()
        .join('\n'))
      .digest('hex');
    expect(digest).toBe(JOIN_TABLE_DIGEST_V1);

    // The distributions LOCALISE it.
    expect(tally(rows, (row) => row.verdict)).toStrictEqual(JOIN_VERDICT_TOTALS_V1);
    expect(tally(rows, (row) => (row.verdict === JOIN_VERDICT_V1.NOT_COMPARABLE
      ? row.cause : undefined))).toStrictEqual(JOIN_NOT_COMPARABLE_CAUSE_TOTALS_V1);
    expect(tally(rows, (row) => (isAdjudicated(row)
      ? `${row.verdict} ${row.coreDecisionKey} -> ${row.storageLabel}` : undefined)))
      .toStrictEqual(JOIN_LEVEL1_TABLE_V1);
    expect(tally(rows, (row) => (row.verdict === JOIN_VERDICT_V1.DIVERGENCE
      ? `${row.coreLabel} -> ${row.storageLabel}` : undefined)))
      .toStrictEqual(JOIN_DIVERGENCES_V1);

    // CONSERVATION, ASSERTED RATHER THAN COMPUTED IN A COMMENT. Every
    // constructible cell carries exactly one verdict, and the adjudicated
    // sub-total is what the level-1 map was actually asked about.
    const verdictTotal = Object.values(JOIN_VERDICT_TOTALS_V1).reduce((a, b) => a + b, 0);
    expect(verdictTotal).toBe(JOIN_TOTAL_CELLS_V1);
    expect(rows.reduce((sum, row) => sum + (isAdjudicated(row) ? row.cells : 0), 0))
      .toBe(JOIN_ADJUDICATED_CELLS_V1);
    expect(JOIN_ADJUDICATED_CELLS_V1
      + JOIN_NOT_COMPARABLE_CAUSE_TOTALS_V1[
        JOIN_NOT_COMPARABLE_CAUSE_V1.APPLIED_ROW_SHORT_CIRCUIT]!)
      .toBe(JOIN_PARTITION_V1.COMPARABLE!.cells);
  });

  it('keeps the level-1 map LIVE, PARTIAL and PROPER, and refuses a pair it has not declared', async () => {
    const { rows, unadjudicated } = await join();

    // THE GUARD. An observed (core, storage) pair the map does not adjudicate is
    // a FAILURE, never a row: it means core returned a decision this map has
    // never been shown, and a table that absorbed it would claim a codomain it
    // does not cover.
    expect(unadjudicated).toStrictEqual([]);

    // AND THE GUARD IS FIRED, not merely observed silent. `toStrictEqual([])` is
    // exactly the shape that passes when a helper always returns empty, so the
    // adjudicator is called directly with a decision the map has never been
    // shown. If this ever returns a verdict, the assertion above is decoration.
    expect(JOIN_LEVEL1_MAP_V1.map((entry) => entry.coreDecisionKey))
      .not.toContain('quarantine|a-decision-core-does-not-have');
    expect(adjudicatePairV1('quarantine|a-decision-core-does-not-have', 'ready'))
      .toBe(JOIN_UNADJUDICATED_V1);
    // ...and the same call on a declared key does NOT answer UNADJUDICATED, so
    // the check above discriminates rather than always failing closed.
    expect(adjudicatePairV1('accept', 'ready')).toBe(JOIN_VERDICT_V1.AGREEMENT);
    expect(adjudicatePairV1('accept', 'stale')).toBe(JOIN_VERDICT_V1.DIVERGENCE);

    // LIVE: every declared entry matches cells. An entry matching nothing is
    // decoration that can never be wrong.
    const perEntry: Record<string, { cells: number; members: Record<string, number> }> = {};
    for (const entry of JOIN_LEVEL1_MAP_V1) {
      perEntry[entry.coreDecisionKey] = {
        cells: 0,
        members: Object.fromEntries((entry.image ?? []).map((member) => [member, 0])),
      };
    }
    for (const row of rows) {
      if (!isAdjudicated(row)) continue;
      const entry = perEntry[row.coreDecisionKey];
      expect({ key: row.coreDecisionKey, declared: entry !== undefined })
        .toStrictEqual({ key: row.coreDecisionKey, declared: true });
      entry!.cells += row.cells;
      if (row.storageLabel in entry!.members) entry!.members[row.storageLabel]! += row.cells;
    }
    expect(perEntry).toStrictEqual(JOIN_LEVEL1_PER_ENTRY_V1);
    for (const [key, entry] of Object.entries(JOIN_LEVEL1_PER_ENTRY_V1)) {
      expect({ key, live: entry.cells > 0 }).toStrictEqual({ key, live: true });
    }

    // PARTIAL: at least one entry can ground NO image, and at least one can. A
    // map with an image everywhere would be a claim that every core decision has
    // a storage counterpart, which is the claim this diff exists to test.
    expect(JOIN_LEVEL1_MAP_V1.filter((entry) => entry.image === null).length)
      .toBeGreaterThan(0);
    expect(JOIN_LEVEL1_MAP_V1.filter((entry) => entry.image !== null).length)
      .toBeGreaterThan(0);

    // PROPER: no image is the whole codomain. An image that covered everything
    // would make DIVERGENCE unreachable under that entry -- a check that cannot
    // fail, wearing the shape of a mapping.
    for (const entry of JOIN_LEVEL1_MAP_V1) {
      if (entry.image === null) continue;
      expect({ key: entry.coreDecisionKey, proper: entry.image.length < STORAGE_OUTCOME_CODOMAIN_V1.length })
        .toStrictEqual({ key: entry.coreDecisionKey, proper: true });
      for (const member of entry.image) expect(STORAGE_OUTCOME_CODOMAIN_V1).toContain(member);
    }

    // CITED: every entry names sites, and every site resolves against the real
    // source. A well-formed citation naming a file that does not exist satisfies
    // a shape check and nothing else.
    for (const entry of JOIN_LEVEL1_MAP_V1) {
      expect(entry.citations.length).toBeGreaterThan(0);
      expect(entry.note.length).toBeGreaterThan(120);
      for (const citation of entry.citations) {
        expect({ citation, ...resolveCitation(citation) })
          .toStrictEqual({ citation, exists: true, lineInRange: true });
      }
    }

    // The headline carries the semantics-changing count beside the divergence
    // count, and it is over ENTRIES because it is a fact about the systems, not
    // about how many cells the fixture generated.
    expect(JOIN_LEVEL1_MAP_V1.filter((e) => e.semantics === JOIN_SEMANTICS_V1.CHANGING).length)
      .toBe(JOIN_SEMANTICS_CHANGING_ENTRIES_V1);
    expect(JOIN_LEVEL1_MAP_V1.filter((e) => e.semantics === JOIN_SEMANTICS_V1.PRESERVING).length)
      .toBeGreaterThan(0);
  });

  it('shows the precondition DISCRIMINATES, predicting the short-circuit from the axes', async () => {
    const { rows } = await join();
    // The predicate is computed from the CELL AXES and two cited gates, never
    // from the storage answer. This cross-tab is what proves it is neither
    // vacuous nor wrong: BOTH off-diagonal keys must be absent, so it predicts
    // `deferred('non-active-state')` in both directions. A gate that admitted
    // one row too many, or refused one it should have admitted, adds a key.
    const observed = tally(rows, (row) => (row.bucket === JOIN_BUCKET_V1.COMPARABLE
      ? `shortCircuit=${row.cause === JOIN_NOT_COMPARABLE_CAUSE_V1.APPLIED_ROW_SHORT_CIRCUIT}`
        + ` isNonActiveState=${row.storageLabel === 'deferred|non-active-state'}`
      : undefined));
    expect(observed).toStrictEqual(JOIN_PRECONDITION_DISCRIMINATION_V1);
    expect(Object.keys(observed)).toHaveLength(2);
  });

  it("separates core's two stale sub-causes and pins which storage outcome each took", async () => {
    const { rows } = await join();
    const observed = tally(rows, (row) => (row.coreDecisionKey === 'stale'
      && row.bucket === JOIN_BUCKET_V1.COMPARABLE
      ? `${row.staleRoute} -> ${row.verdict === JOIN_VERDICT_V1.NOT_COMPARABLE
        ? 'NOT-COMPARABLE(applied-row-short-circuit)' : row.storageLabel}`
      : undefined));
    expect(observed).toStrictEqual(JOIN_STALE_ROUTES_V1);
    // No stale cell may be unrouted: an `unclassified` route would mean core
    // reached `stale` by a path this join does not know about, and the two
    // sub-causes would no longer account for the entry.
    expect(Object.keys(observed).filter((key) => key.startsWith('unclassified'))).toStrictEqual([]);
  });

  it('records the reason pairs verbatim and states NO-MAPPING at the reason level', async () => {
    const { rows } = await join();
    expect(tally(rows, (row) => (isAdjudicated(row)
      ? `${row.coreReason} :: ${row.storageReason}` : undefined)))
      .toStrictEqual(JOIN_LEVEL2_REASON_PAIRS_V1);

    // NO-MAPPING AT THE REASON LEVEL, ASSERTED RATHER THAN ASSERTED AWAY. The
    // two unions are disjoint: core's reasons are sentences about authority,
    // storage's are closed materialisation tokens. Both are checked non-empty
    // first, because an empty set is disjoint from everything and that would be
    // a check that cannot fail.
    const coreReasons = new Set([
      ...Object.keys(CORE_REJECT_REASON_SITES_V1),
      ...Object.keys(CORE_DELEGATED_REJECT_REASON_SITES_V1),
      ...Object.keys(CORE_QUARANTINE_REASONS_V1),
    ]);
    const storageReasons = new Set(
      STORAGE_OUTCOME_CODOMAIN_V1
        .filter((label) => label.includes('|'))
        .map((label) => label.slice(label.indexOf('|') + 1)),
    );
    expect(coreReasons.size).toBeGreaterThan(0);
    expect(storageReasons.size).toBeGreaterThan(0);
    expect([...coreReasons].filter((reason) => storageReasons.has(reason))).toStrictEqual([]);
  });

  it('pins the storage codomain reach, including every outcome the diff never exercised', async () => {
    const { rows } = await join();
    const reached = tally(rows, (row) => (row.bucket === JOIN_BUCKET_V1.COMPARABLE
      ? row.storageLabel : undefined));
    // Zeros are pinned rather than omitted: an omitted row and an unreachable
    // row look identical in a pin, and only one of them is a claim.
    const observed = Object.fromEntries(
      STORAGE_OUTCOME_CODOMAIN_V1.map((label) => [label, reached[label] ?? 0]),
    );
    expect(observed).toStrictEqual(JOIN_STORAGE_LABEL_REACH_V1);
    // ...and nothing outside the declared codomain was observed, which is what
    // makes the enumerated codomain a pin on the two CLOSED reason unions rather
    // than a list that quietly falls behind them.
    expect(Object.keys(reached).filter((label) => !STORAGE_OUTCOME_CODOMAIN_V1.includes(label)))
      .toStrictEqual([]);

    // The unreached inventory must agree with the measurement it explains. An
    // entry claiming an outcome was never exercised, while that outcome now
    // fires, is a stale note wearing the shape of a finding.
    for (const entry of JOIN_UNREACHED_OUTCOMES_V1) {
      if (entry.side !== 'storage') continue;
      const labels = STORAGE_OUTCOME_CODOMAIN_V1.filter(
        (label) => label === entry.outcome || label.startsWith(`${entry.outcome.split(' ')[0]}|`),
      );
      expect({ outcome: entry.outcome, labels: labels.length > 0 })
        .toStrictEqual({ outcome: entry.outcome, labels: true });
      for (const label of labels) {
        expect({ label, cells: reached[label] ?? 0 }).toStrictEqual({ label, cells: 0 });
      }
    }
    expect(JOIN_UNREACHED_OUTCOMES_V1.filter((e) => e.why === 'system-forbids').length)
      .toBeGreaterThan(0);
    expect(JOIN_UNREACHED_OUTCOMES_V1.filter((e) => e.why === 'harness-never-builds').length)
      .toBeGreaterThan(0);
  });

  it('anchors every impossibility claim to the closed set it depends on', () => {
    expect(JOIN_IMPOSSIBILITY_PROOFS_V1.length).toBeGreaterThan(0);
    for (const proof of JOIN_IMPOSSIBILITY_PROOFS_V1) {
      expect(proof.breaksIf.length).toBeGreaterThan(40);
      for (const citation of proof.citations) {
        expect({ citation, ...resolveCitation(citation) })
          .toStrictEqual({ citation, exists: true, lineInRange: true });
      }
    }

    // THE PREMISE IS EXECUTED, NOT READ. The recorded proof holds only while
    // `SystemRecordAppliedSnapshotV1` is a CLOSED two-variant union: with a
    // third variant, `reuse` still implies not-absent but the throw at
    // :241-243 becomes reachable and the record becomes false. So the premise
    // is re-derived from the source here, which is where that future change
    // will land.
    const snapshotSource = readFileSync(
      new URL('../src/system-record-state-snapshot-v1-internal.ts', import.meta.url),
      'utf8',
    );
    const declaration = /export type SystemRecordAppliedSnapshotV1 =([^;]*);/u.exec(snapshotSource);
    expect(declaration).not.toBeNull();
    expect(snapshotSource.match(/export type SystemRecordAppliedSnapshotV1 =/gu)).toHaveLength(1);
    expect(declaration![1]!.split('|').map((part) => part.trim()).filter(Boolean))
      .toStrictEqual(['SystemRecordAbsentSnapshotV1', 'SystemRecordPresentSnapshotV1']);

    // And the single-production-site premise, with its own control: if the
    // instrument found nothing at all, a count of one would be meaningless.
    const nextStateSource = readFileSync(
      new URL('../src/system-record-next-state-v1-internal.ts', import.meta.url),
      'utf8',
    );
    expect(nextStateSource.match(/'reuse'/gu)).toHaveLength(3);
    expect(nextStateSource.match(/'rematerialize'/gu)).toHaveLength(5);
  });

  // WHAT EACH PIN ABOVE ACTUALLY CATCHES, kept anchored to the live source.
  // A mutation ledger that rots is worse than none: the recorded result and
  // "the experiment was never run" become indistinguishable from the notes.
  it('anchors every non-vacuity mutant to a site that still exists, exactly once', () => {
    expect(JOIN_NON_VACUITY_MUTANTS_V1.length).toBeGreaterThan(0);
    for (const mutant of JOIN_NON_VACUITY_MUTANTS_V1) {
      expect(mutant.before).not.toBe(mutant.after);
      expect(mutant.prediction.length).toBeGreaterThan(40);
      expect(mutant.observed.length).toBeGreaterThan(40);
      const source = readFileSync(new URL(`../../../${mutant.file}`, import.meta.url), 'utf8');
      // EXACTLY ONCE is the anchor. At two occurrences "the string is present"
      // is compatible with the mutation having moved a line other than the one
      // the record names, and the whole result becomes unattributable.
      const occurrences = source.split(mutant.before).length - 1;
      expect({ id: mutant.id, occurrences }).toStrictEqual({ id: mutant.id, occurrences: 1 });
      // And the mutant is NOT still applied.
      expect({ id: mutant.id, applied: source.includes(mutant.after) })
        .toStrictEqual({ id: mutant.id, applied: false });
    }
  });

  it('carries its findings as data rather than as a commit message', () => {
    expect(JOIN_FINDINGS_V1).toHaveLength(13);
    for (const finding of JOIN_FINDINGS_V1) expect(finding.length).toBeGreaterThan(200);
  });
});
