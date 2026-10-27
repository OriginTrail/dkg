/**
 * OT-RFC-73 P11: the sibling rules, as pure functions of the records of a lifecycle key (async-lift-lifecycle-siblings.ts). The engine and bulk clear read the
 * records under the claim lock and ask these; here the records are stamped from real jobs and the answers are pinned case by case, with the binding selector of
 * admission as the reference for what "binds the key" means.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { LiftJob, PersistedLiftJob } from '../src/lift-job.js';
import { lifecycleKeyOfJob } from '../src/lift-job-store-selectors.js';
import {
  bindingJobIds, bindingUnchanged, bulkClearKeepsBinding, planKeyDeletion, recordsOfKey, removalPromotesSibling,
} from '../src/async-lift-lifecycle-siblings.js';
import { judgeFinalizedRecord } from '../src/async-lift-retention-policy.js';
import { DAY, NOW, WINDOW, at, createRetentionTemplates, fin, stampKeyed, type KeyedSpec, type RetentionTemplates } from './_helpers/lift-retention-fixtures.js';

let templates: RetentionTemplates;
beforeAll(async () => { templates = await createRetentionTemplates(); });

const jobs = (...specs: KeyedSpec[]): PersistedLiftJob[] => specs.map((spec) => stampKeyed(templates, spec) as PersistedLiftJob);
const keyOf = (records: readonly PersistedLiftJob[]): string => lifecycleKeyOfJob(records[0]!)!;
const ids = (records: readonly { jobId: string }[]): string[] => records.map((job) => job.jobId);
const verdict = (job: PersistedLiftJob) => judgeFinalizedRecord(job, NOW, { finalizedMaxAgeMs: WINDOW });
const plan = (records: PersistedLiftJob[]) => planKeyDeletion(records, keyOf(records), verdict);
/** A finalized record that is old enough (finished 90 days ago and more) / one that finished a day ago. */
const old = (id: string, acceptedDay: number) => fin(id, 'k', acceptedDay);
const young = (id: string, acceptedDay: number) => fin(id, 'k', acceptedDay, 99);

describe('recordsOfKey', () => {
  it('takes the records of one key, oldest first by acceptedAt and then by id, whatever the order it is given', () => {
    const records = jobs(fin('b', 'k', 20), fin('z', 'k', 10), fin('a', 'k', 10), fin('other', 'other-key', 5));
    expect(ids(recordsOfKey(records, keyOf(records)))).toEqual(['a', 'z', 'b']);
    expect(ids(recordsOfKey(records, lifecycleKeyOfJob(records[3]!)!))).toEqual(['other']);
    expect(recordsOfKey(records, 'no such key')).toEqual([]);
  });

  it('leaves a job without a lifecycle key out of every group', () => {
    const records = jobs({ ...fin('raw', 'k', 5), kind: 'raw' }, fin('v', 'k', 6));
    expect(lifecycleKeyOfJob(records[0]!)).toBeNull();
    expect(ids(recordsOfKey(records, lifecycleKeyOfJob(records[1]!)!))).toEqual(['v']);
  });
});

describe('planKeyDeletion: the deletable prefix', () => {
  const cases: Array<[string, KeyedSpec[], string[], Record<string, string>]> = [
    ['every record finalized and old: all of them, the newest too', [old('f1', 10), old('f2', 20), old('f3', 30)], ['f1', 'f2', 'f3'], {}],
    ['a single old finalized record: the key is vacated', [old('f1', 10)], ['f1'], {}],
    ['an older failed sibling keeps every record behind it, whatever they are', [at('x', 'k', 'retryable', 5), old('f1', 10), old('f2', 20)], [], { x: 'not_terminal', f1: 'blocked', f2: 'blocked' }],
    ['a failed record in the middle ends the prefix after the records in front of it', [old('f1', 10), at('x', 'k', 'terminal', 15), old('f2', 20)], ['f1'], { x: 'not_terminal', f2: 'blocked' }],
    ['a held failed sibling blocks like any other failed one', [at('h', 'k', 'held', 5), old('f1', 10)], [], { h: 'not_terminal', f1: 'blocked' }],
    ['a recovery-lane sibling blocks too', [at('r', 'k', 'recovery', 5), old('f1', 10)], [], { r: 'not_terminal', f1: 'blocked' }],
    ['an older record that is not terminal blocks (an accepted one, a claimed one)', [at('a', 'k', 'accepted', 5), old('f1', 10)], [], { a: 'not_terminal', f1: 'blocked' }],
    ['a younger finalized record in front ends the prefix: its newer, older-looking sibling waits', [young('f1', 5), old('f2', 10)], [], { f1: 'too_recent', f2: 'blocked' }],
    ['a failed or live record NEWER than the old finalized ones does not hold them', [old('f1', 10), old('f2', 20), at('x', 'k', 'retryable', 30)], ['f1', 'f2'], { x: 'not_terminal' }],
    ['a live successor does not hold the finalized record before it', [old('f1', 10), at('a', 'k', 'accepted', 50)], ['f1'], { a: 'not_terminal' }],
    ['a record finalized in the future ends the prefix', [fin('f1', 'k', 10, 200), old('f2', 20)], [], { f1: 'future_dated', f2: 'blocked' }],
    ['a record updated in the future ends the prefix', [{ ...old('f1', 10), updatedAt: NOW + DAY }, old('f2', 20)], [], { f1: 'future_dated', f2: 'blocked' }],
  ];

  it.each(cases)('%s', (_name, specs, prefix, kept) => {
    const records = jobs(...specs);
    const result = plan(records);
    expect(ids(result.prefix)).toEqual(prefix);
    expect(Object.fromEntries(result.kept)).toEqual(kept);
    expect(result.bindingStable).toBe(true);
  });

  it('is a prefix of the oldest-first order: nothing is deletable behind a record that is not', () => {
    const records = jobs(old('f1', 10), old('f2', 20), at('x', 'k', 'terminal', 25), old('f3', 30), old('f4', 40));
    const result = plan(records);
    expect(ids(result.order)).toEqual(['f1', 'f2', 'x', 'f3', 'f4']);
    expect(ids(result.prefix)).toEqual(['f1', 'f2']);
    for (const id of ['x', 'f3', 'f4']) expect(result.kept.has(id), id).toBe(true);
  });

  it('judges the records of its key only', () => {
    const records = jobs(old('f1', 10), fin('o1', 'other', 5), at('ox', 'other', 'retryable', 4));
    expect(ids(plan(records).prefix)).toEqual(['f1']);
  });

  it('keeps the key\'s newest record in every intermediate state: a prefix never skips an older record', () => {
    const records = jobs(old('f1', 10), old('f2', 20), old('f3', 30));
    const { prefix, order } = plan(records);
    for (let deleted = 0; deleted < prefix.length; deleted++) {
      const remaining = order.filter((job) => !prefix.slice(0, deleted + 1).some((gone) => gone.jobId === job.jobId));
      // after deleting the first `deleted + 1` records the newest of the key is still there until the last one goes
      expect(ids(remaining).includes('f3') || deleted + 1 === order.length, `after ${deleted + 1} deletes`).toBe(true);
    }
  });
});

describe('binding: the same list, or a promoted sibling', () => {
  it('lists what the admission selector binds, in its order', () => {
    const records = jobs(at('x', 'k', 'retryable', 10), at('h', 'k', 'held', 5), at('y', 'k', 'retryable', 20));
    expect(bindingJobIds(records, keyOf(records))).toEqual(['h', 'y']);              // held first, then the newest; x is history behind y
  });

  it('removing a finalized record in front of the key\'s history changes nothing', () => {
    const records = jobs(old('f1', 10), old('f2', 20), at('a', 'k', 'accepted', 30));
    expect(bindingUnchanged(records, keyOf(records), new Set(['f1', 'f2']))).toBe(true);
    expect(removalPromotesSibling(records, keyOf(records), new Set(['f1', 'f2']))).toBe(false);
  });

  it('removing the newest record that demoted an older failed one promotes it: the binding changes and the guard sees it', () => {
    const records = jobs(at('x', 'k', 'retryable', 10), old('f', 20));
    expect(bindingJobIds(records, keyOf(records))).toEqual([]);
    expect(bindingUnchanged(records, keyOf(records), new Set(['f']))).toBe(false);
    expect(removalPromotesSibling(records, keyOf(records), new Set(['f']))).toBe(true);
  });

  it('removing the binding job itself vacates the key: a change, but no sibling is promoted', () => {
    const records = jobs(at('x', 'k', 'retryable', 10));
    expect(bindingUnchanged(records, keyOf(records), new Set(['x']))).toBe(false);
    expect(removalPromotesSibling(records, keyOf(records), new Set(['x']))).toBe(false);
  });

  it('refuses a plan the binding check refuses: nothing is deletable and every record says why', () => {
    const records = jobs(old('f1', 10), old('f2', 20));
    const refused = planKeyDeletion(records, keyOf(records), verdict, () => false);
    expect(refused.bindingStable).toBe(false);
    expect(refused.prefix).toEqual([]);
    expect(Object.fromEntries(refused.kept)).toEqual({ f1: 'binding_would_change', f2: 'binding_would_change' });
    // and the check is asked about exactly the prefix
    const asked: string[][] = [];
    planKeyDeletion(records, keyOf(records), verdict, (_c, _k, removed) => { asked.push([...removed]); return true; });
    expect(asked).toEqual([['f1', 'f2']]);
  });
});

describe('bulkClearKeepsBinding', () => {
  const clear = (records: PersistedLiftJob[], id: string) => bulkClearKeepsBinding(records, records.find((job) => job.jobId === id)!);

  it('keeps a finalized record while an older failed sibling is kept: that sibling could bind the key again', () => {
    const records = jobs(at('x', 'k', 'retryable', 10), old('f', 20));
    expect(clear(records, 'f')).toBe(false);
    for (const state of ['terminal', 'held', 'recovery'] as const) {
      const others = jobs(at('x', 'k', state, 10), old('f', 20));
      expect(clear(others, 'f'), state).toBe(false);                       // the rule is the blanket one: any older failed sibling
    }
  });

  it('removes a finalized record that has no older failed sibling, whatever is newer', () => {
    expect(clear(jobs(old('f1', 10), old('f2', 20)), 'f1')).toBe(true);
    expect(clear(jobs(old('f1', 10), old('f2', 20)), 'f2')).toBe(true);
    expect(clear(jobs(old('f', 10), at('x', 'k', 'retryable', 20)), 'f')).toBe(true);
    expect(clear(jobs(old('f', 10), at('a', 'k', 'accepted', 20)), 'f')).toBe(true);
  });

  it('keeps a failed record whose removal would make an older kept one bind the key', () => {
    // the recovery-lane job is older and stays (clear leaves it); the terminal one is newer, so the older is history until the newer goes
    const records = jobs(at('x', 'k', 'recovery', 10), at('t', 'k', 'terminal', 20));
    expect(clear(records, 't')).toBe(false);
  });

  it('removes a failed record that binds the key itself (that is what clearing a failed job is for)', () => {
    expect(clear(jobs(at('x', 'k', 'retryable', 10)), 'x')).toBe(true);
    expect(clear(jobs(at('x', 'k', 'retryable', 10), at('y', 'k', 'retryable', 20)), 'x')).toBe(true);
    expect(clear(jobs(at('x', 'k', 'retryable', 10), at('y', 'k', 'retryable', 20)), 'y')).toBe(false);
  });

  it('removes a failed record that was history anyway', () => {
    expect(clear(jobs(at('x', 'k', 'terminal', 10), old('f', 20)), 'x')).toBe(true);
    expect(clear(jobs(at('x', 'k', 'retryable', 10), at('y', 'k', 'terminal', 20)), 'x')).toBe(true);
  });

  it('has nothing to say about a job without a lifecycle key', () => {
    const [raw, sibling] = jobs({ ...fin('raw', 'k', 5), kind: 'raw' }, at('x', 'k', 'retryable', 1));
    expect(bulkClearKeepsBinding([raw!, sibling!], raw as LiftJob as PersistedLiftJob)).toBe(true);
  });
});
