// Regression coverage for the ETL's mixed-bucket split logic in
// `lib/etl.mjs`. The ADD/OBSERVE assignment is the highest-risk part of
// the ETL — it's the one piece whose behavior on real `BIKE_SOURCE`
// inputs differs from what the synthesized fixture exercises, so it
// needs explicit coverage to catch silent regressions in:
//
//   - duplicate eventIDs from sibling docs splitting one source record
//   - wrong `action` values when a status bucket mixes first-seen and
//     already-seen items
//   - unscoped status / action suffixes when a bucket doesn't actually
//     split (back-compat case for the committed fixtures)
//
// Run with `node demo/epcis-bike/test/etl-mixed-bucket.test.mjs`.
// Uses Node's built-in test runner (Node 18+); no extra deps needed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runEtl } from '../lib/etl.mjs';

const TRACE = '11111111-2222-4333-8444-555555555555';

// Run the ETL on a temp source file, then either:
//   - run the optional `fn` callback with `{ result, dir, source }`
//     BEFORE cleanup (so it can inspect the emitted JSON files on
//     disk), OR
//   - just return the in-memory result for tests that only assert on
//     manifest metadata.
// `dir` is removed in `finally` regardless, so callers must do all
// disk-touching assertions inside `fn`. Manifest-only assertions can
// use the returned `result.traceManifest` after the call returns
// (it's in-memory and survives the cleanup).
async function withSource(records, fn) {
  const dir = await mkdtemp(join(tmpdir(), 'epcis-bike-etl-test-'));
  const source = join(dir, 'source.json');
  await writeFile(source, JSON.stringify(records, null, 2), 'utf8');
  try {
    const result = await runEtl({ source, traceId: TRACE, outDir: dir });
    if (typeof fn === 'function') {
      await fn({ result, dir, source });
    }
    return { dir, result, source };
  } finally {
    // Clean up — the runEtl call wrote the source AND derived files
    // into `dir`. Leaving them around would leak /tmp space across
    // many runs. The `dir` field in the returned object is therefore
    // stale after this point; callers that need disk access must use
    // the `fn` callback above.
    await rm(dir, { recursive: true, force: true });
  }
}

test('uniform-status single-item-per-record produces stable eventIDs and no splits', async () => {
  const records = [
    { trace_id: TRACE, unit_id: 'c1', unit_name: 'WC1', process_name: 'StationA', ended: '2026-05-12T08:00:00.000Z', product_id: 'P', items: { A: { status: 'Passed' } } },
    { trace_id: TRACE, unit_id: 'c2', unit_name: 'WC2', process_name: 'StationB', ended: '2026-05-12T08:01:00.000Z', product_id: 'P', items: { A: { status: 'Passed' } } },
  ];
  const { dir, result } = await withSource(records, async () => {});
  // Inside the cleanup callback we already removed dir; the data we care
  // about for assertions is in `result.traceManifest.events`.
  const evts = result.traceManifest.events;
  assert.equal(evts.length, 2);
  assert.equal(evts[0].action, 'ADD');
  assert.equal(evts[1].action, 'OBSERVE');
  // Filenames have no status / action suffix on a non-splitting record.
  assert.match(evts[0].file, /^event-01-StationA\.json$/);
  assert.match(evts[1].file, /^event-02-StationB\.json$/);
  // Distinct eventIDs.
  assert.notEqual(evts[0].eventID, evts[1].eventID);
});

test('mixed status in one record splits into sibling docs with distinct dispositions and eventIDs', async () => {
  const records = [
    {
      trace_id: TRACE,
      unit_id: 'c1',
      unit_name: 'WC1',
      process_name: 'Mix',
      ended: '2026-05-12T08:00:00.000Z',
      product_id: 'P',
      items: { A: { status: 'Passed' }, B: { status: 'Rejected' } },
    },
  ];
  const { result } = await withSource(records);
  const evts = result.traceManifest.events;
  // Two sibling docs from one record → 2 events.
  assert.equal(evts.length, 2);
  // Status suffix appears on each filename (lowercased, safeName-encoded).
  const files = evts.map((e) => e.file).sort();
  assert.deepEqual(files, ['event-01-Mix-passed.json', 'event-02-Mix-rejected.json']);
  // Distinct dispositions: in_progress for Passed, damaged for Rejected.
  const byStatus = Object.fromEntries(evts.map((e) => [e.status, e]));
  assert.match(byStatus.Passed.disposition, /in_progress$/);
  assert.match(byStatus.Rejected.disposition, /damaged$/);
  // Distinct eventIDs (publisher's duplicate-root validator would
  // otherwise reject the second sibling).
  assert.notEqual(byStatus.Passed.eventID, byStatus.Rejected.eventID);
});

test('mixed action in one status bucket splits into ADD-only and OBSERVE-only siblings', async () => {
  // First record introduces item A. Second record's status bucket holds
  // both A (already-seen) and C (first-seen) — splitting should produce
  // two sibling docs at the second record: ADD with [C], OBSERVE with [A].
  const records = [
    { trace_id: TRACE, unit_id: 'c1', unit_name: 'WC1', process_name: 'Mix', ended: '2026-05-12T08:00:00.000Z', product_id: 'P', items: { A: { status: 'Passed' } } },
    { trace_id: TRACE, unit_id: 'c2', unit_name: 'WC1', process_name: 'Mix', ended: '2026-05-12T08:01:00.000Z', product_id: 'P', items: { A: { status: 'Passed' }, C: { status: 'Passed' } } },
  ];
  const { result } = await withSource(records);
  const evts = result.traceManifest.events;
  assert.equal(evts.length, 3, 'expected 3 events: record 1 (single ADD) + record 2 (split)');
  // Record 1: single doc, no suffix.
  assert.match(evts[0].file, /^event-01-Mix\.json$/);
  assert.equal(evts[0].action, 'ADD');
  assert.deepEqual(evts[0].item_ids, ['A']);
  // Record 2 splits: action suffix appears on both siblings (no status
  // suffix — only one status bucket).
  const r2 = evts.slice(1);
  const r2Files = r2.map((e) => e.file).sort();
  assert.deepEqual(r2Files, ['event-02-Mix-add.json', 'event-03-Mix-observe.json']);
  const byAction = Object.fromEntries(r2.map((e) => [e.action, e]));
  assert.deepEqual(byAction.ADD.item_ids, ['C']);
  assert.deepEqual(byAction.OBSERVE.item_ids, ['A']);
  // Distinct eventIDs across all 3 docs.
  const ids = new Set(evts.map((e) => e.eventID));
  assert.equal(ids.size, 3);
});

test('mixed status AND mixed action together produce up to 4 sibling docs with unique eventIDs', async () => {
  // Setup: first record introduces item A (Passed). Second record has
  // A (already-seen, Passed), B (first-seen, Passed), C (first-seen,
  // Rejected). Splits to 3 siblings on the second record:
  //   - Passed-add:    [B] (first-seen, Passed)
  //   - Passed-observe:[A] (already-seen, Passed)
  //   - Rejected-add:  [C] (first-seen, Rejected — no observed counterpart)
  const records = [
    { trace_id: TRACE, unit_id: 'c1', unit_name: 'WC1', process_name: 'Mix', ended: '2026-05-12T08:00:00.000Z', product_id: 'P', items: { A: { status: 'Passed' } } },
    {
      trace_id: TRACE,
      unit_id: 'c2',
      unit_name: 'WC1',
      process_name: 'Mix',
      ended: '2026-05-12T08:01:00.000Z',
      product_id: 'P',
      items: { A: { status: 'Passed' }, B: { status: 'Passed' }, C: { status: 'Rejected' } },
    },
  ];
  const { result } = await withSource(records);
  const evts = result.traceManifest.events;
  assert.equal(evts.length, 4, 'expected 1 + 3 events');
  const ids = new Set(evts.map((e) => e.eventID));
  assert.equal(ids.size, 4, 'all eventIDs must be unique (publisher\'s duplicate-root validator otherwise rejects siblings)');
  // Filenames carry both status and action suffixes ONLY on the splits.
  const r2Files = evts.slice(1).map((e) => e.file).sort();
  // Passed bucket has 2 sub-buckets (add+observe) → both action suffixes.
  // Rejected bucket has 1 sub-bucket (add only) → no action suffix.
  assert.deepEqual(r2Files, [
    'event-02-Mix-passed-add.json',
    'event-03-Mix-passed-observe.json',
    'event-04-Mix-rejected.json',
  ]);
});

test('repeated unit_id across stations does not collide on eventID', async () => {
  // Real BIKE_SOURCE exports often use per-station cycle counters where
  // each station's `unit_id` restarts at 1. Without `process_name` in
  // the eventID seed, `(trace, unit_id, ended)` would hash to the same
  // UUID across stations and trip the publisher's duplicate-root
  // rejection on the second sibling. This test pins the regression:
  // two records share unit_id (and even ended, by 1ms), differ only
  // in process_name → must produce distinct eventIDs.
  const records = [
    { trace_id: TRACE, unit_id: 'cycle-001', unit_name: 'WC1', process_name: 'StationA', ended: '2026-05-12T08:00:00.000Z', product_id: 'P', items: { X: { status: 'Passed' } } },
    { trace_id: TRACE, unit_id: 'cycle-001', unit_name: 'WC2', process_name: 'StationB', ended: '2026-05-12T08:00:00.000Z', product_id: 'P', items: { X: { status: 'Passed' } } },
  ];
  const { result } = await withSource(records);
  const evts = result.traceManifest.events;
  assert.equal(evts.length, 2);
  // Distinct eventIDs even though trace_id, unit_id, and ended are
  // byte-identical between the two records.
  assert.notEqual(evts[0].eventID, evts[1].eventID);
  // Filenames carry the process_name, not the unit_id, so they're
  // distinct on disk too.
  const files = evts.map((e) => e.file).sort();
  assert.deepEqual(files, ['event-01-StationA.json', 'event-02-StationB.json']);
});

test('malformed `items` shapes are rejected with precise errors instead of producing invalid EPCIS', async () => {
  // BIKE_SOURCE is external input. Without explicit shape-validation
  // the ETL would silently turn arrays into synthetic numeric EPC IDs
  // (`Object.keys(["A","B"])` → `["0","1"]`) and strings into per-
  // character IDs. Both produce malformed EPCIS documents the publisher
  // would later reject with confusing errors. The validator should
  // fail loud at ETL time instead.
  const cases = [
    { label: 'items = array', items: ['A', 'B'] },
    { label: 'items = string', items: 'A' },
    { label: 'items = number', items: 42 },
    { label: 'items.A = array', items: { A: ['Passed'] } },
    { label: 'items.A = string', items: { A: 'Passed' } },
    { label: 'items.A = null', items: { A: null } },
  ];
  for (const c of cases) {
    const records = [{
      trace_id: TRACE,
      unit_id: 'c1',
      unit_name: 'WC',
      process_name: 'S',
      ended: '2026-05-12T08:00:00Z',
      product_id: 'P',
      items: c.items,
    }];
    let threw = false;
    try {
      await withSource(records);
    } catch (err) {
      threw = true;
      assert.match(err.message, /malformed `items/, `expected validation error for case "${c.label}", got: ${err.message}`);
    }
    assert.equal(threw, true, `expected ETL to throw on case "${c.label}"`);
  }
});

test('shared outDir rejects a second trace upfront (single-trace-per-outDir invariant)', async () => {
  // Two traces can't safely coexist in the same outDir: the event-NN-
  // *.json filenames are scoped only by ordinal + station, so trace B
  // would silently overwrite trace A's events while leaving A's
  // `trace-<A>-bike-line.json` manifest pointing at the corrupted
  // files. The ETL refuses the second regen with a precise error
  // pointing at the stale manifest. (Earlier cycles tried to preserve
  // sibling traces and failed — overwrites + manifest-pointer drift
  // — so the design now enforces one-trace-per-dir at the ETL.)
  const dir = await mkdtemp(join(tmpdir(), 'epcis-bike-shared-'));
  try {
    const TRACE_A = 'aaaa1111-2222-4333-8444-555555555555';
    const TRACE_B = 'bbbb2222-3333-4444-8555-666666666666';
    const recA = [{
      trace_id: TRACE_A, unit_id: 'a1', unit_name: 'WC', process_name: 'StationA',
      ended: '2026-05-12T08:00:00Z', product_id: 'P', items: { X: { status: 'Passed' } },
    }];
    const recB = [{
      trace_id: TRACE_B, unit_id: 'b1', unit_name: 'WC', process_name: 'StationB',
      ended: '2026-05-12T09:00:00Z', product_id: 'P', items: { Y: { status: 'Passed' } },
    }];
    const srcA = join(dir, 'src-A.json');
    const srcB = join(dir, 'src-B.json');
    await writeFile(srcA, JSON.stringify(recA), 'utf8');
    await writeFile(srcB, JSON.stringify(recB), 'utf8');
    const { runEtl } = await import('../lib/etl.mjs');
    // Trace A into the dir succeeds.
    await runEtl({ source: srcA, traceId: TRACE_A, outDir: dir });
    // Trace B into the SAME dir must throw with a precise message.
    let threw = false;
    try {
      await runEtl({ source: srcB, traceId: TRACE_B, outDir: dir });
    } catch (err) {
      threw = true;
      assert.match(err.message, /already contains a different trace's manifest/, `expected single-trace-per-outDir error, got: ${err.message}`);
    }
    assert.equal(threw, true, 'expected the second ETL to throw');
    // Trace A's fixtures are still intact (the second ETL aborted
    // before touching anything).
    const filenames = (await readdir(dir)).sort();
    assert.ok(filenames.includes(`trace-${TRACE_A}-bike-line.json`), 'trace A manifest preserved');
    assert.ok(filenames.includes('event-01-StationA.json'), 'trace A event preserved');
    assert.ok(!filenames.includes(`trace-${TRACE_B}-bike-line.json`), 'trace B manifest never written');
    assert.ok(!filenames.includes('event-01-StationB.json'), 'trace B event never written');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('regenerating the same traceId into the same outDir still succeeds (idempotent)', async () => {
  // Same-trace re-regeneration must work — the single-trace-per-outDir
  // guard above mustn't accidentally reject the legitimate "user re-
  // runs ETL on the same source" case. The guard fires only on a
  // DIFFERENT trace's manifest sitting in the dir; THIS trace's prior
  // manifest is treated as expected and cleaned up by the existing
  // path-traversal-safe cleanup logic.
  const dir = await mkdtemp(join(tmpdir(), 'epcis-bike-idempotent-'));
  try {
    const T = 'aaaa1111-2222-4333-8444-555555555555';
    const records = [{
      trace_id: T, unit_id: 'c1', unit_name: 'WC', process_name: 'S',
      ended: '2026-05-12T08:00:00Z', product_id: 'P', items: { X: { status: 'Passed' } },
    }];
    const src = join(dir, 'src.json');
    await writeFile(src, JSON.stringify(records), 'utf8');
    const { runEtl } = await import('../lib/etl.mjs');
    const r1 = await runEtl({ source: src, traceId: T, outDir: dir });
    const r2 = await runEtl({ source: src, traceId: T, outDir: dir });
    assert.equal(r1.traceManifest.events[0].eventID, r2.traceManifest.events[0].eventID,
      'eventID must be stable across same-trace re-runs');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('eventID determinism: re-running the ETL on the same source yields identical eventIDs', async () => {
  const records = [
    { trace_id: TRACE, unit_id: 'c1', unit_name: 'WC1', process_name: 'StationA', ended: '2026-05-12T08:00:00.000Z', product_id: 'P', items: { A: { status: 'Passed' } } },
    { trace_id: TRACE, unit_id: 'c2', unit_name: 'WC2', process_name: 'StationB', ended: '2026-05-12T08:01:00.000Z', product_id: 'P', items: { B: { status: 'Passed' } } },
  ];
  const r1 = await withSource(records);
  const r2 = await withSource(records);
  const ids1 = r1.result.traceManifest.events.map((e) => e.eventID);
  const ids2 = r2.result.traceManifest.events.map((e) => e.eventID);
  assert.deepEqual(ids1, ids2, 'eventIDs must be byte-identical across runs of the same source');
});
