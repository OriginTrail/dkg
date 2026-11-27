/**
 * OT-RFC-73 P11: random lifecycle-key populations and the INDEPENDENT oracles the retention and bulk-clear property tests judge them by.
 *
 * The oracles are written from the spec, not from the product's predicates: `bindingOracle` restates the documented admission rule (which records bind a key) over the generator's
 * own knowledge of each record's STATE, and `prefixOracle` the D-6 rule (the oldest records of a key, up to the first that is not a finalized record old enough and not dated
 * after now). Neither imports anything from the sweep or from `selectLifecycleBindingJobs`.
 *
 * Two kinds of old finalized record are ones the sweep can NEVER delete, and so stand in front of every record behind them for good: a pre-upgrade payload (`compat`: the decoder
 * reads it as `compatibility`) and a record whose finish-time index triple is missing (`unindexed`: the scan never meets it). The oracle knows them by the generator's own flags.
 */
import { DAY, NOW, WINDOW, pick, type KeyedSpec, type KeyedState } from './lift-retention-fixtures.js';

export interface Rec { readonly spec: KeyedSpec; readonly kind: 'old' | 'young' | 'future-update' | 'future-finish' | 'live' | 'failed' | 'compat' | 'unindexed' }

export const FAILED_STATES: ReadonlySet<KeyedState> = new Set(['retryable', 'held', 'terminal', 'recovery']);

/** The order of a key, restated from the spec: by acceptance time, then by job id (two records of a key may be accepted in the same millisecond). */
export const keyOrder = (a: KeyedSpec, b: KeyedSpec): number => a.acceptedAt - b.acceptedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** The documented admission rule, restated from the spec: which records of one key bind it, in the order admission answers for them. */
export function bindingOracle(records: readonly KeyedSpec[]): string[] {
  const ordered = [...records].sort(keyOrder);
  const newest = ordered.at(-1);
  const occupying = (r: KeyedSpec) => r.state === 'accepted' || r.state === 'claimed' || r.state === 'retryable' || r.state === 'held' || r.state === 'recovery';
  const binds = ordered.filter((r) => occupying(r) && !(FAILED_STATES.has(r.state) && r.state !== 'held' && r !== newest));
  return [...binds.filter((r) => r.state === 'held').reverse(), ...binds.filter((r) => r.state !== 'held').reverse()].map((r) => r.id);
}

/** What the spec says a full run deletes from one key: the oldest records, up to the first that is not a finalized record old enough and not dated after now. */
export function prefixOracle(records: readonly KeyedSpec[], now: number): KeyedSpec[] {
  const ordered = [...records].sort(keyOrder);
  const prefix: KeyedSpec[] = [];
  for (const r of ordered) {
    const finished = r.finalizedAt ?? Number.NaN;
    const ok = r.state === 'finalized' && r.compat !== true && r.unindexed !== true && finished <= now && (r.updatedAt ?? finished) <= now && now - finished >= WINDOW;
    if (!ok) break;
    prefix.push(r);
  }
  return prefix;
}

export const keyedOf = (recs: readonly Rec[]): Map<string, KeyedSpec[]> => {
  const byKey = new Map<string, KeyedSpec[]>();
  for (const { spec } of recs) if (spec.kind !== 'raw') byKey.set(spec.key, [...(byKey.get(spec.key) ?? []), spec]);
  return byKey;
};

export function genPopulation(r: () => number): Rec[] {
  const recs: Rec[] = [];
  const keys = 1 + Math.floor(r() * 5);
  for (let k = 0; k < keys; k++) {
    const n = Math.floor(r() * 7);
    let day = 1 + r() * 5;
    for (let i = 0; i < n; i++) {
      // acceptedAt rises within the key, but now and then a record is accepted in the same millisecond as the one before it: the key's order is then the job id (a
      // lower id is older), and the two finish in either order, so half of those pairs are met by the walk NEWER first (online review round 1)
      if (i === 0 || r() >= 0.15) day += 1 + r() * 12;
      const id = `k${k}-${i}`;
      const roll = r();
      const acceptedAt = Math.round(day * DAY);
      if (roll < 0.38) {
        const finishedDay = day + 0.05 + r() * 0.4;
        recs.push({ kind: 'old', spec: { id, key: `key${k}`, state: 'finalized', acceptedAt, finalizedAt: Math.round(finishedDay * DAY) } });
      } else if (roll < 0.42) {
        recs.push({ kind: 'compat', spec: { id, key: `key${k}`, state: 'finalized', acceptedAt, finalizedAt: Math.round((day + 0.1) * DAY), compat: true } });
      } else if (roll < 0.46) {
        recs.push({ kind: 'unindexed', spec: { id, key: `key${k}`, state: 'finalized', acceptedAt, finalizedAt: Math.round((day + 0.1) * DAY), unindexed: true } });
      } else if (roll < 0.56) {
        recs.push({ kind: 'young', spec: { id, key: `key${k}`, state: 'finalized', acceptedAt, finalizedAt: NOW - Math.round(r() * 6.5 * DAY) } });
      } else if (roll < 0.60) {
        const finishedDay = day + 0.1;
        recs.push({ kind: 'future-update', spec: { id, key: `key${k}`, state: 'finalized', acceptedAt, finalizedAt: Math.round(finishedDay * DAY), updatedAt: NOW + Math.round((0.5 + r()) * DAY) } });
      } else if (roll < 0.63) {
        recs.push({ kind: 'future-finish', spec: { id, key: `key${k}`, state: 'finalized', acceptedAt, finalizedAt: NOW + Math.round((0.5 + r()) * DAY) } });
      } else if (roll < 0.72) {
        recs.push({ kind: 'live', spec: { id, key: `key${k}`, state: pick(r, ['accepted', 'claimed'] as const), acceptedAt } });
      } else {
        recs.push({ kind: 'failed', spec: { id, key: `key${k}`, state: pick(r, ['retryable', 'held', 'terminal', 'recovery'] as const), acceptedAt } });
      }
    }
  }
  // a few keyless raw lifts, old and young
  for (let i = 0; i < Math.floor(r() * 3); i++) {
    const old = r() < 0.6;
    recs.push({ kind: old ? 'old' : 'young', spec: { id: `raw${i}`, key: 'raw', kind: 'raw', state: 'finalized', acceptedAt: Math.round((2 + i) * DAY), finalizedAt: old ? Math.round((3 + i) * DAY) : NOW - Math.round(DAY) } });
  }
  // finished out of order: swap the finish times of two finalized records of one key now and then
  if (r() < 0.25) {
    const byKey = new Map<string, Rec[]>();
    for (const rec of recs) if (rec.spec.state === 'finalized' && rec.kind === 'old' && rec.spec.kind !== 'raw') byKey.set(rec.spec.key, [...(byKey.get(rec.spec.key) ?? []), rec]);
    const pair = [...byKey.values()].find((group) => group.length >= 2);
    if (pair) {
      const [a, b] = [pair[0]!, pair[1]!];
      const swap = a.spec.finalizedAt;
      recs[recs.indexOf(a)] = { ...a, spec: { ...a.spec, finalizedAt: b.spec.finalizedAt } };
      recs[recs.indexOf(b)] = { ...b, spec: { ...b.spec, finalizedAt: swap } };
    }
  }
  // finished at the same instant: now and then two or three old finalized records of one key share one finish time, preferably in the run of old records a key
  // starts with (where the sweep can reach them). The scan walks the rows of one finish time by subject when they are more than a batch (ORDER BY STR(?job)), and in
  // the engine's order inside one batch, so half the time their ids are renamed to sort against the key's order: a walk by subject then meets the NEWEST of them first.
  if (r() < 0.4) {
    const byKey = new Map<string, Rec[]>(), leading = new Map<string, { open: boolean; run: Rec[] }>();
    for (const rec of recs) {
      if (rec.spec.kind === 'raw') continue;
      if (rec.kind === 'old') byKey.set(rec.spec.key, [...(byKey.get(rec.spec.key) ?? []), rec]);
      const lead = leading.get(rec.spec.key) ?? { open: true, run: [] };
      if (lead.open && rec.kind === 'old') lead.run.push(rec); else lead.open = false;
      leading.set(rec.spec.key, lead);
    }
    const reachable = [...leading.values()].map((lead) => lead.run).filter((run) => run.length >= 2);
    const groups = reachable.length > 0 ? reachable : [...byKey.values()].filter((group) => group.length >= 2);
    if (groups.length > 0) {
      const group = pick(r, groups);                                                          // in acceptance order (recs are pushed so)
      const start = Math.floor(r() * (group.length - 1));
      const tied = group.slice(start, start + (group.length - start >= 3 && r() < 0.3 ? 3 : 2));
      const finish = Math.max(...tied.map((rec) => rec.spec.finalizedAt!));
      const newestFirst = r() < 0.5;
      tied.forEach((rec, i) => {
        const id = newestFirst ? `${rec.spec.key.replace('key', 'k')}-t${tied.length - i}-${rec.spec.id}` : rec.spec.id;
        recs[recs.indexOf(rec)] = { ...rec, spec: { ...rec.spec, id, finalizedAt: finish } };
      });
    }
  }
  return recs;
}

/** Keys two of whose finalized records finished at the same instant. */
export const tiedKeys = (recs: readonly Rec[]): Set<string> => {
  const seen = new Set<string>(), tied = new Set<string>();
  for (const { spec } of recs) {
    if (spec.state !== 'finalized' || spec.kind === 'raw') continue;
    const mark = `${spec.key}\u0000${spec.finalizedAt}`;
    if (seen.has(mark)) tied.add(spec.key); else seen.add(mark);
  }
  return tied;
};

