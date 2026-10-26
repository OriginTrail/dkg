// G1b, the product check of the chosen S1 geometry (OT-RFC-73 plan 8.3 and decision D-15). Pure: no I/O.
//
// G1b re-runs G0b's two-publisher-slot cells on the real product code with the path on and the same five G0b seeds, and
// shows the product reproduces what G0b measured. Each cell is compared as the MEDIAN OF THE FIVE SEEDED REPEATS against
// the G0b cell median (Q12, harness 0.9 results/gate9/analysis, plan 8.2): per run, the share P95 is censored at the 20 s
// caller deadline, and the pick-up is accepted -> first claim, the p50 of the run, unclaimed jobs right-censored at the
// run end (pickup.mjs). The worker-free split (D-16) is G2/G3's, not G1b's.
// Pass margins (D-15), "within" read as two-sided (the product must REPRODUCE G0b, not only stay under it; the
// signed deviation is printed either way):
//   share P95 (g9L3, g9mix)       within 25 % of the G0b median
//   pick-up p50 (g9pub, g9mix)    within 25 % or 0.5 s of the G0b median, whichever is larger (g9mix's median is 267 ms,
//                                 so a 25 % band alone, about 67 ms, would be inside run-to-run noise)
// A miss stops P14 (plan 10). Strict like every rule here: a cell needs all five repeats, valid, with the G0b setup;
// anything less is INCOMPLETE, never a PASS.
import { median } from './verdict.mjs';

/** The seeds of the five G0b repeats: 20262901 + repeat (specs/gate9.json). */
export const G1B_SEED_BASE = 20_262_901;
export const G1B_REPEATS = 5;
/** Medians of the five Q12 repeats of each G0b cell, in ms. */
export const G0B_REFERENCE = Object.freeze({
  g9L3: Object.freeze({ shareP95: 713 }),
  g9mix: Object.freeze({ shareP95: 701, pickup: 267 }),
  g9pub: Object.freeze({ pickup: 1687 }),
});
/** G0b's cells: the stream(s), the named rung and its load, and what G1b compares. */
export const G1B_CELLS = Object.freeze({
  g9L3: {
    queue: 'share',
    rung: 'L3',
    load: { lambda: 8, mu: 0, content: 4, aggregate: 2 },
    metrics: ['shareP95'],
  },
  g9mix: {
    queue: 'both',
    rung: 'MIX',
    load: { lambda: 4, mu: 0.4, content: 3, aggregate: 1 },
    metrics: ['shareP95', 'pickup'],
  },
  g9pub: {
    queue: 'lift',
    rung: 'PSTAR',
    load: { lambda: 0, mu: 0.8, content: 4, aggregate: 2 },
    metrics: ['pickup'],
  },
});
export const G1B_METRICS = Object.freeze({
  shareP95: { label: 'share P95', field: 'p95Ms', band: (ref) => 0.25 * ref },
  pickup: {
    label: 'pick-up p50',
    field: 'pickupP50Ms',
    band: (ref) => Math.max(0.25 * ref, 500),
  },
});
/** The standard factors of every G0b run: windows, observer, empty histories, probe and ACK load, the chain-time model. */
export const G1B_SETUP = Object.freeze({
  windows: { warmupMs: 30_000, measureMs: 180_000, cooldownMs: 10_000 },
  observer: 'default',
  observerMs: 5000,
  loadFactors: {
    probes: true,
    ack: true,
    statusMs: 10_000,
    metricsMs: 30_000,
    countMs: 60_000,
    ackMs: 4000,
    ackPayload: 32,
  },
  liftModel: { wallets: 6, walletHoldMs: 3000, liftPollMs: 1000 },
});

const EPS = 1e-9; // a comparison at a band edge is inside, as in the other pre-registered rules
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const queueOf = (r) => r.queue ?? 'share';

/** Why a run is not a G0b-conforming run of this cell ([] when it is). */
export function setupProblems(r, def) {
  const problems = [];
  const check = (name, got, want) => {
    if (!same(got, want)) problems.push(`${name} is ${JSON.stringify(got)}, G0b ran ${JSON.stringify(want)}`);
  };
  const cell = r.cell ?? {};
  const config = r.config ?? {};
  check('windows', config.windows, G1B_SETUP.windows);
  check('observer', cell.observer, G1B_SETUP.observer);
  check('observerMs', config.observerMs, G1B_SETUP.observerMs);
  check('history', String(cell.history), '0');
  check('lift history', String(cell.liftHistory ?? '0'), '0');
  check('probe and ACK load', config.loadFactors, G1B_SETUP.loadFactors);
  if (def.queue !== 'share') check('chain-time model', config.liftModel, G1B_SETUP.liftModel);
  check('seed', config.seed, G1B_SEED_BASE + r.repeat);
  check('calibration', config.calibrationSha256, null);
  for (const [k, want] of Object.entries(def.load)) check(k, config[k], want);
  return problems;
}

/**
 * The G1b verdict over the runs of the product arm. Result: { label, status, need, have (the thinnest cell's usable
 * repeats), cells: { id: { have, problems, metrics: { name: { median, ref, deviation, lo, hi, ok } } } }, reason }.
 */
export function g1b(records) {
  const cells = {};
  for (const [id, def] of Object.entries(G1B_CELLS)) {
    const mine = records.filter((r) => queueOf(r) === def.queue && r.cell?.rung === def.rung);
    const problems = [];
    const usable = [];
    for (let repeat = 0; repeat < G1B_REPEATS; repeat++) {
      const runs = mine.filter((r) => r.repeat === repeat);
      const valid = runs.filter((r) => r.valid);
      if (!runs.length) problems.push(`repeat ${repeat}: no run`);
      else if (!valid.length) {
        problems.push(
          `repeat ${repeat}: no valid run (${runs.map((r) => `${r.runId}: ${r.failedChecks.join(', ')}`).join('; ')})`,
        );
      } else if (valid.length > 1) {
        problems.push(
          `repeat ${repeat}: ${valid.length} valid runs (${valid.map((r) => r.runId).join(', ')}); remove the ones that are not meant to count`,
        );
      } else {
        const off = setupProblems(valid[0], def);
        if (off.length) problems.push(`repeat ${repeat} (${valid[0].runId}): ${off.join('; ')}`);
        else usable.push(valid[0]);
      }
    }
    for (const r of mine.filter((x) => !(x.repeat >= 0 && x.repeat < G1B_REPEATS)))
      problems.push(`run ${r.runId}: repeat ${r.repeat} is outside the five G0b repeats`);
    const metrics = {};
    if (usable.length === G1B_REPEATS) {
      for (const name of def.metrics) {
        const { field, band } = G1B_METRICS[name];
        const ref = G0B_REFERENCE[id][name];
        const m = median(usable.map((r) => r[field]));
        const lo = ref - band(ref);
        const hi = ref + band(ref);
        const ok = m >= lo - EPS && m <= hi + EPS;
        metrics[name] = {
          median: m,
          ref,
          deviation: Math.round(((m - ref) / ref) * 1e4) / 1e4,
          lo,
          hi,
          ok,
        };
      }
    }
    cells[id] = {
      queue: def.queue,
      rung: def.rung,
      have: usable.length,
      problems,
      metrics,
    };
  }
  const have = Math.min(...Object.values(cells).map((c) => c.have));
  const label = 'g1b: median of the five seeded repeats within the G0b band (D-15)';
  if (have < G1B_REPEATS) {
    const thin = Object.entries(cells)
      .filter(([, c]) => c.have < G1B_REPEATS)
      .map(([id, c]) => `${id} ${c.have}`);
    return {
      label,
      status: 'incomplete',
      need: G1B_REPEATS,
      have,
      cells,
      reason: `needs ${G1B_REPEATS} valid G0b-conforming repeats in every cell (${thin.join(', ')})`,
    };
  }
  const ok = Object.values(cells).every((c) => Object.values(c.metrics).every((m) => m.ok));
  return {
    label,
    status: ok ? 'pass' : 'fail',
    need: G1B_REPEATS,
    have,
    cells,
  };
}
