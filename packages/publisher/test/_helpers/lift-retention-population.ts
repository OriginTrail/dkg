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

/** The documented admission rule, restated from the spec: which records of one key bind it, in the order admission answers for them. */
export function bindingOracle(records: readonly KeyedSpec[]): string[] {
  const ordered = [...records].sort((a, b) => a.acceptedAt - b.acceptedAt || (a.id < b.id ? -1 : 1));
  const newest = ordered.at(-1);
  const occupying = (r: KeyedSpec) => r.state === 'accepted' || r.state === 'claimed' || r.state === 'retryable' || r.state === 'held' || r.state === 'recovery';
  const binds = ordered.filter((r) => occupying(r) && !(FAILED_STATES.has(r.state) && r.state !== 'held' && r !== newest));
  return [...binds.filter((r) => r.state === 'held').reverse(), ...binds.filter((r) => r.state !== 'held').reverse()].map((r) => r.id);
}

/** What the spec says a full run deletes from one key: the oldest records, up to the first that is not a finalized record old enough and not dated after now. */
export function prefixOracle(records: readonly KeyedSpec[], now: number): KeyedSpec[] {
  const ordered = [...records].sort((a, b) => a.acceptedAt - b.acceptedAt || (a.id < b.id ? -1 : 1));
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
      day += 1 + r() * 12;                                                                    // strictly increasing acceptedAt within the key
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
  return recs;
}

