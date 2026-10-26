// Known answers for the G1b rule of the async queue contention benchmark (OT-RFC-73 P2b, decision D-15): the product
// against G0b's two-publisher-slot cells. Pure: no backend and no dist.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  G0B_REFERENCE,
  G1B_CELLS,
  G1B_METRICS,
  G1B_REPEATS,
  G1B_SEED_BASE,
  G1B_SETUP,
  g1b,
  setupProblems,
} from '../../repro/async-queue-contention/g1b.mjs';

/** A valid G0b-conforming run record of cell `id`, repeat r; `o` overrides top-level fields, `cfg` the config's. */
const run = (id, r, o = {}, cfg = {}) => {
  const def = G1B_CELLS[id];
  return {
    runId: `${id}-r${r}`,
    repeat: r,
    valid: true,
    failedChecks: [],
    queue: def.queue,
    cell: {
      history: '0',
      liftHistory: '0',
      observer: 'default',
      rung: def.rung,
      repeat: r,
    },
    config: {
      windows: G1B_SETUP.windows,
      observerMs: 5000,
      loadFactors: G1B_SETUP.loadFactors,
      liftModel: def.queue === 'share' ? null : G1B_SETUP.liftModel,
      seed: G1B_SEED_BASE + r,
      calibrationSha256: null,
      ...def.load,
      env: { DKG_STORE_CONTROL_RESERVED_SLOTS: '2' },
      ...cfg,
    },
    p95Ms: G0B_REFERENCE[id].shareP95 ?? null,
    pickupP50Ms: G0B_REFERENCE[id].pickup ?? null,
    ...o,
  };
};
/** All five repeats of one cell; `values` maps a repeat to its overrides. */
const cell = (id, over = () => ({})) => Array.from({ length: G1B_REPEATS }, (_, r) => run(id, r, over(r)));
const everything = (over = {}) => ['g9L3', 'g9mix', 'g9pub'].flatMap((id) => cell(id, over[id]));

test('G0b is the reference: the Q12 medians, the five seeds and the three cells', () => {
  assert.deepEqual(G0B_REFERENCE, {
    g9L3: { shareP95: 713 },
    g9mix: { shareP95: 701, pickup: 267 },
    g9pub: { pickup: 1687 },
  });
  assert.equal(G1B_SEED_BASE, 20_262_901);
  assert.equal(G1B_REPEATS, 5);
  assert.deepEqual(
    Object.entries(G1B_CELLS).map(([id, c]) => [id, c.queue, c.rung, c.metrics]),
    [
      ['g9L3', 'share', 'L3', ['shareP95']],
      ['g9mix', 'both', 'MIX', ['shareP95', 'pickup']],
      ['g9pub', 'lift', 'PSTAR', ['pickup']],
    ],
  );
  assert.deepEqual(G1B_CELLS.g9L3.load, {
    lambda: 8,
    mu: 0,
    content: 4,
    aggregate: 2,
  });
  assert.deepEqual(G1B_CELLS.g9mix.load, {
    lambda: 4,
    mu: 0.4,
    content: 3,
    aggregate: 1,
  });
  assert.deepEqual(G1B_CELLS.g9pub.load, {
    lambda: 0,
    mu: 0.8,
    content: 4,
    aggregate: 2,
  });
});

test('the bands are 25 % of the G0b median, widened to 0.5 s for the pick-up', () => {
  assert.equal(G1B_METRICS.shareP95.band(713), 178.25);
  assert.equal(G1B_METRICS.pickup.band(1687), 500, '25 % is 422 ms, under the floor');
  assert.equal(G1B_METRICS.pickup.band(267), 500, '25 % is 67 ms, inside run-to-run noise');
  assert.equal(G1B_METRICS.pickup.band(10_000), 2500, 'a slow cell keeps its 25 %');
});

test('a product that reproduces G0b passes: the medians of the five repeats against the three cells', () => {
  const r = g1b(everything());
  assert.deepEqual([r.status, r.have, r.need], ['pass', 5, 5]);
  assert.match(r.label, /^g1b: /);
  assert.deepEqual(r.cells.g9L3.metrics.shareP95, {
    median: 713,
    ref: 713,
    deviation: 0,
    lo: 534.75,
    hi: 891.25,
    ok: true,
  });
  assert.deepEqual(Object.keys(r.cells.g9mix.metrics), ['shareP95', 'pickup']);
  assert.deepEqual(r.cells.g9pub.metrics.pickup, {
    median: 1687,
    ref: 1687,
    deviation: 0,
    lo: 1187,
    hi: 2187,
    ok: true,
  });
  assert.deepEqual(r.cells.g9mix.metrics.pickup, {
    median: 267,
    ref: 267,
    deviation: 0,
    lo: -233,
    hi: 767,
    ok: true,
  });
  assert.deepEqual(
    Object.values(r.cells).map((c) => [c.have, c.problems]),
    Array(3).fill([5, []]),
  );
});

test('the median decides, not the mean: two bad repeats of five pass, three fail', () => {
  const shares = (values) => (r) => ({ p95Ms: values[r] });
  const two = g1b(everything({ g9L3: shares([713, 5000, 5000, 700, 720]) }));
  assert.equal(two.status, 'pass');
  assert.equal(two.cells.g9L3.metrics.shareP95.median, 720);
  const three = g1b(everything({ g9L3: shares([713, 5000, 5000, 5000, 720]) }));
  assert.equal(three.status, 'fail');
  assert.deepEqual([three.cells.g9L3.metrics.shareP95.median, three.cells.g9L3.metrics.shareP95.ok], [5000, false]);
  assert.equal(three.cells.g9mix.metrics.shareP95.ok, true, 'the other cells are judged on their own');
});

test('the band is two-sided: reproducing G0b means a product that is much faster misses too, the edges are inside', () => {
  const at = (id, key, value) => g1b(everything({ [id]: () => ({ [key]: value }) }));
  for (const [id, key, name, value, ok] of [
    ['g9L3', 'p95Ms', 'shareP95', 891.25, true],
    ['g9L3', 'p95Ms', 'shareP95', 891.26, false],
    ['g9L3', 'p95Ms', 'shareP95', 534.75, true],
    ['g9L3', 'p95Ms', 'shareP95', 534.74, false],
    ['g9mix', 'p95Ms', 'shareP95', 876.25, true],
    ['g9mix', 'p95Ms', 'shareP95', 876.3, false],
    ['g9pub', 'pickupP50Ms', 'pickup', 2187, true],
    ['g9pub', 'pickupP50Ms', 'pickup', 2187.5, false],
    ['g9pub', 'pickupP50Ms', 'pickup', 1187, true],
    ['g9pub', 'pickupP50Ms', 'pickup', 1186.9, false],
    ['g9mix', 'pickupP50Ms', 'pickup', 767, true],
    ['g9mix', 'pickupP50Ms', 'pickup', 767.5, false],
    ['g9mix', 'pickupP50Ms', 'pickup', 0, true],
  ]) {
    const result = at(id, key, value);
    assert.equal(result.cells[id].metrics[name].ok, ok, `${id} ${name} ${value}`);
    assert.equal(result.status, ok ? 'pass' : 'fail', `${id} ${name} ${value}`);
  }
  const slow = at('g9pub', 'pickupP50Ms', 3374);
  assert.equal(slow.cells.g9pub.metrics.pickup.deviation, 1, 'twice the G0b median, +100 %');
  assert.equal(at('g9L3', 'p95Ms', 356.5).cells.g9L3.metrics.shareP95.deviation, -0.5);
});

test('fewer than five repeats of a cell is INCOMPLETE, whatever the repeats that exist say', () => {
  const runs = everything().filter((r) => !(r.runId === 'g9pub-r3'));
  const r = g1b(runs);
  assert.deepEqual([r.status, r.have], ['incomplete', 4]);
  assert.match(r.reason, /needs 5 valid G0b-conforming repeats in every cell \(g9pub 4\)/);
  assert.deepEqual(r.cells.g9pub.problems, ['repeat 3: no run']);
  assert.deepEqual(r.cells.g9pub.metrics, {}, 'no verdict on a thin cell');
  const failing = g1b(everything({ g9L3: () => ({ p95Ms: 9000 }) }).filter((r) => r.runId !== 'g9pub-r0'));
  assert.equal(failing.status, 'incomplete', 'a miss does not outrank missing evidence');
  assert.equal(g1b([]).status, 'incomplete');
  assert.equal(g1b([]).have, 0);
});

test('an invalid run does not count, and two valid runs of one repeat are ambiguous', () => {
  const bad = {
    valid: false,
    failedChecks: ['publisherQuiet', 'finitePublishMetrics'],
  };
  const runs = everything();
  runs[runs.findIndex((r) => r.runId === 'g9mix-r2')] = run('g9mix', 2, bad);
  const r = g1b(runs);
  assert.equal(r.status, 'incomplete');
  assert.match(r.cells.g9mix.problems[0], /repeat 2: no valid run \(g9mix-r2: publisherQuiet, finitePublishMetrics\)/);
  // a valid rerun beside the invalid one repairs the repeat
  assert.equal(g1b([...runs, { ...run('g9mix', 2), runId: 'g9mix-r2-rerun' }]).status, 'pass');
  // two valid ones: the one not meant to count has to be removed
  const twice = g1b([...everything(), { ...run('g9L3', 1), runId: 'g9L3-r1-again' }]);
  assert.equal(twice.status, 'incomplete');
  assert.match(
    twice.cells.g9L3.problems[0],
    /repeat 1: 2 valid runs \(g9L3-r1, g9L3-r1-again\); remove the ones that are not meant to count/,
  );
});

test("a run is G0b-conforming only with G0b's windows, observer, loads, wallets, seed and no calibration", () => {
  const def = (id) => G1B_CELLS[id];
  assert.deepEqual(setupProblems(run('g9mix', 0), def('g9mix')), []);
  const problem = (id, r, o, cfg, pattern) => {
    const problems = setupProblems(run(id, r, o, cfg), def(id));
    assert.equal(problems.length, 1, problems.join('; '));
    assert.match(problems[0], pattern);
  };
  problem('g9L3', 0, {}, { windows: { warmupMs: 30_000, measureMs: 60_000, cooldownMs: 10_000 } }, /^windows is /);
  problem('g9L3', 0, {}, { observerMs: 1000 }, /^observerMs is 1000/);
  problem(
    'g9L3',
    0,
    {
      cell: {
        history: '50k',
        liftHistory: '0',
        observer: 'default',
        rung: 'L3',
        repeat: 0,
      },
    },
    {},
    /^history is "50k"/,
  );
  problem(
    'g9mix',
    0,
    {
      cell: {
        history: '0',
        liftHistory: '10k',
        observer: 'default',
        rung: 'MIX',
        repeat: 0,
      },
    },
    {},
    /^lift history is "10k"/,
  );
  problem('g9L3', 0, { cell: { history: '0', observer: 'paged', rung: 'L3', repeat: 0 } }, {}, /^observer is "paged"/);
  problem(
    'g9pub',
    0,
    {},
    {
      loadFactors: {
        ...G1B_SETUP.loadFactors,
        ack: false,
        ackMs: null,
        ackPayload: null,
      },
    },
    /^probe and ACK load is /,
  );
  problem('g9pub', 0, {}, { loadFactors: { ...G1B_SETUP.loadFactors, statusMs: 5000 } }, /^probe and ACK load is /);
  problem('g9pub', 0, {}, { liftModel: { ...G1B_SETUP.liftModel, wallets: 3 } }, /^chain-time model is /);
  problem('g9mix', 1, {}, { seed: 7301 }, /^seed is 7301, G0b ran 20262902/);
  problem('g9L3', 0, {}, { calibrationSha256: 'abc' }, /^calibration is "abc"/);
  problem('g9L3', 0, {}, { lambda: 4 }, /^lambda is 4, G0b ran 8/);
  problem('g9pub', 0, {}, { mu: 0.4 }, /^mu is 0.4, G0b ran 0.8/);
  problem('g9mix', 0, {}, { content: 5 }, /^content is 5/);
  // a run from before P2b records none of this and cannot stand in for a G0b run
  const legacy = {
    ...run('g9L3', 0),
    queue: undefined,
    config: {
      windows: G1B_SETUP.windows,
      lambda: 8,
      content: 4,
      aggregate: 2,
      seed: G1B_SEED_BASE,
      observerMs: 5000,
    },
  };
  assert.ok(setupProblems(legacy, def('g9L3')).some((p) => p.startsWith('probe and ACK load is undefined')));
  // a share cell has no chain-time model to check
  assert.deepEqual(setupProblems(run('g9L3', 0, {}, { liftModel: { wallets: 99 } }), def('g9L3')), []);
});

test('a non-conforming repeat makes the cell INCOMPLETE and names why', () => {
  const runs = everything({
    g9pub: (r) => (r === 4 ? { config: { ...run('g9pub', 4).config, seed: 1 } } : {}),
  });
  const r = g1b(runs);
  assert.deepEqual([r.status, r.cells.g9pub.have, r.cells.g9L3.have], ['incomplete', 4, 5]);
  assert.match(r.cells.g9pub.problems[0], /repeat 4 \(g9pub-r4\): seed is 1, G0b ran 20262905/);
});

test("runs of other rungs or streams are not part of G0b's cells, and a repeat beyond the fifth is flagged", () => {
  const other = {
    ...run('g9L3', 0),
    runId: 'ladder',
    cell: { ...run('g9L3', 0).cell, rung: 'L2' },
  };
  assert.equal(g1b([...everything(), other]).status, 'pass');
  const sixth = { ...run('g9pub', 5), runId: 'g9pub-r5' };
  const r = g1b([...everything(), sixth]);
  assert.equal(r.status, 'pass', 'the five G0b repeats decide');
  assert.deepEqual(r.cells.g9pub.problems, ['run g9pub-r5: repeat 5 is outside the five G0b repeats']);
  const wrongStream = {
    ...run('g9pub', 0),
    runId: 'both-pstar',
    queue: 'both',
  };
  assert.equal(
    g1b([...everything().filter((x) => x.runId !== 'g9pub-r0'), wrongStream]).cells.g9pub.have,
    4,
    'PSTAR run as a mixed cell is not g9pub',
  );
});
