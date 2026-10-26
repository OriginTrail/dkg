// G1b REHEARSAL on the repo benchmark (OT-RFC-73 plan 8.3 and decision D-15). Pure: no I/O.
//
// NOT THE G1b GATE. The plan fixes G1b to harness 0.9 (the harness archive), adapted only to set the P3 env value and
// drive the P4/P5 tagging, with the backend limited to 3 CPUs (--expect-backend-cpus 3, as G0b stamped and required)
// and the harness's own recording scheduler and fixture. This benchmark is a different instrument: P2a's share replay
// and fixture, the real default scheduler, no backend CPU gate. Its medians are therefore not the medians G0b's harness
// produced, and a PASS or a MISS here neither releases nor stops P14. The rule below only says whether this
// benchmark's product runs land inside the D-15 bands: a way to rehearse the cells and to catch a gross regression
// before the real G1b. Making it the G1b instrument would be a plan change (it would also have to gate on the backend
// CPU limit and the host, as G0b did).
//
// What it rehearses: G0b's two-publisher-slot cells on the real product code with the path on and the same five G0b
// seeds. Each cell is compared as the MEDIAN OF THE FIVE SEEDED REPEATS against the G0b cell median (Q12, harness 0.9
// results/gate9/analysis, plan 8.2): per run, the share P95 is censored at the 20 s caller deadline, and the pick-up is
// accepted -> first claim, the p50 of the run, unclaimed jobs right-censored at the run end (pickup.mjs). The worker-free
// split (D-16) is G2/G3's, not G1b's.
// Pass margins (D-15), "within" read as two-sided (the product must REPRODUCE G0b, not only stay under it; the
// signed deviation is printed either way):
//   share P95 (g9L3, g9mix)       within 25 % of the G0b median
//   pick-up p50 (g9pub, g9mix)    within 25 % or 0.5 s of the G0b median, whichever is larger (g9mix's median is 267 ms,
//                                 so a 25 % band alone, about 67 ms, would be inside run-to-run noise)
// Strict like every rule here: a cell needs all five repeats, valid, with the G0b setup AND the control path on (every
// run must record DKG_STORE_CONTROL_RESERVED_SLOTS at the S1 geometry: a run with the variable unset, 0 or malformed ran
// the path off and is not a G1b run); anything less is INCOMPLETE, never a PASS.
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
/** The setting that switches the control path (plan 5.1) and the geometry the rehearsal needs it at (D-3). */
export const CONTROL_SLOTS_ENV = 'DKG_STORE_CONTROL_RESERVED_SLOTS';
export const G1B_SLOTS = Object.freeze({ share: 1, publisher: 2 });
export const G1B_SLOTS_VALUE = 'share:1,publisher:2';
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

/**
 * Why a recorded DKG_STORE_CONTROL_RESERVED_SLOTS is not the control path on at the G1b geometry (null when it is).
 * The setting takes per-queue values ("share:1,publisher:2"); "0" turns the whole path off, a malformed value leaves it
 * off (plan 5.1, no silent fallback), and a value above a queue's maximum is clamped to it. So only a value whose
 * effective share and publisher slots are G1B_SLOTS counts, and a variable the run did not record is no evidence that
 * the path was on.
 */
export function controlSlotsProblem(value) {
  const want = `G1b needs the control path on (${CONTROL_SLOTS_ENV}=${G1B_SLOTS_VALUE})`;
  if (value === undefined || value === null) return `${CONTROL_SLOTS_ENV} is not recorded: ${want}`;
  const slots = {};
  let wellFormed = true;
  for (const part of String(value).split(',')) {
    const m = /^\s*(share|publisher)\s*:\s*(\d+)\s*$/.exec(part);
    if (!m || Object.hasOwn(slots, m[1])) wellFormed = false;
    else slots[m[1]] = Math.min(Number(m[2]), G1B_SLOTS[m[1]]);
  }
  if (wellFormed && Object.entries(G1B_SLOTS).every(([queue, n]) => slots[queue] === n)) return null;
  return `${CONTROL_SLOTS_ENV} is ${JSON.stringify(String(value))}, which is the path off or another geometry: ${want}`;
}

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
  // G1b is judged with the path on: the setting is part of the run's setup, so a run without it is non-conforming and
  // its cell is INCOMPLETE (no warning that lets a path-off run grade)
  const slots = controlSlotsProblem(config.env?.[CONTROL_SLOTS_ENV]);
  if (slots) problems.push(slots);
  return problems;
}

export const REHEARSAL_NOTE =
  'rehearsal on the repo benchmark, NOT the D-15 G1b: G1b runs harness 0.9 (backend limited to 3 CPUs, its recording ' +
  'scheduler and fixture), adapted only to set the P3 env and drive the P4/P5 tagging (plan 8.3). This is another ' +
  "instrument, so its medians are not comparable with G0b's as G1b requires, and a PASS or a MISS here neither " +
  'releases nor stops P14';

/**
 * The G1b rehearsal verdict over the runs of the product arm. Result: { label, gating: false, note, status, need,
 * have (the thinnest cell's usable repeats), cells: { id: { have, problems, metrics: { name: { median, ref, deviation,
 * lo, hi, ok } } } }, reason }.
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
  const label = 'g1b rehearsal (not the D-15 gate): median of the five seeded repeats within the G0b band';
  const head = { label, gating: false, note: REHEARSAL_NOTE };
  if (have < G1B_REPEATS) {
    const thin = Object.entries(cells)
      .filter(([, c]) => c.have < G1B_REPEATS)
      .map(([id, c]) => `${id} ${c.have}`);
    return {
      ...head,
      status: 'incomplete',
      need: G1B_REPEATS,
      have,
      cells,
      reason: `needs ${G1B_REPEATS} valid G0b-conforming repeats in every cell (${thin.join(', ')})`,
    };
  }
  const ok = Object.values(cells).every((c) => Object.values(c.metrics).every((m) => m.ok));
  return {
    ...head,
    status: ok ? 'pass' : 'fail',
    need: G1B_REPEATS,
    have,
    cells,
  };
}
