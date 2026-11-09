/**
 * OT-RFC-73 AC2, share queue: with the control path off, the share workload's lane choice is that of the code before the
 * tagging. The same scripted workload (test/_helpers/share-control-workload.ts) is recorded and its multiset of (resolved lane,
 * operation family) compared with
 *   1. the multiset the unchanged code produced (BASE below, captured by running this workload against packages/publisher/src
 *      at the commit before OT-RFC-73 P4, with the control path off and no ambient lane), and
 *   2. the same workload with `controlQueue` removed at the store boundary, which is the untagged behavior.
 * Labels map as `publisher.asyncPromote.ownershipReader` -> `publisher.asyncPromote.findActiveConflict` (the lock-free reader
 * has its own source now); the operation family (first two segments) does not move.
 */
import { describe, expect, it } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { laneTrace, recordShareStore, withControlPath, type RecordedStoreCall } from './_helpers/share-control-recorder.js';
import { driveShareWorkload } from './_helpers/share-control-workload.js';

const LABEL_MAPPING: Readonly<Record<string, string>> = {
  'publisher.asyncPromote.ownershipReader': 'publisher.asyncPromote.findActiveConflict',
};

/**
 * Captured from the code before P4: `{ lane|family: calls }` and `{ method|label: calls }` over the whole workload.
 * OT-RFC-73 P8a added exactly seven calls, all `normal` with the path off like every other queue call. A listing reads the keys
 * (`list`) and then the payloads of its page (`list.payloads`): the workload's `list` was one read and is now two (+1), its two
 * `listPage` pages are two reads each (+4), and `listForSelector` is one `selectorLookup` (+1). The post-commit sweep finds its one
 * candidate (`recoverPostCommit`, as before) and then decides it in a hold that reads the row again by subject
 * (`recoverPostCommit.payloads`, +1). Every other count is the pre-P4 capture.
 */
const BASE = {
  atomic: {
    total: 94,
    trace: {
      'background|publisher.queueUsage': 1,
      'normal|(unlabelled createGraph)': 1,
      'normal|(unlabelled flush)': 23,
      'normal|publisher.asyncPromote': 67,
      'normal|test.share': 2,
    },
    shape: {
      'createGraph|-': 1,
      'deleteByPatternWithoutCount|publisher.asyncPromote.deleteJob': 1,
      'flush|-': 23,
      'insert|test.share.dataPlane': 1,
      'query|publisher.asyncPromote.claimNext.candidates': 5,
      'query|publisher.asyncPromote.clearTerminalJob': 2,
      'query|publisher.asyncPromote.findActiveConflict': 10,
      'query|publisher.asyncPromote.list': 3,
      'query|publisher.asyncPromote.list.payloads': 3,
      'query|publisher.asyncPromote.readJob': 10,
      'query|publisher.asyncPromote.reconcile': 1,
      'query|publisher.asyncPromote.recoverExpired': 6,
      'query|publisher.asyncPromote.recoverPostCommit': 1,
      'query|publisher.asyncPromote.recoverPostCommit.payloads': 1,
      'query|publisher.asyncPromote.selectorLookup': 1,
      'query|publisher.asyncPromote.stats': 1,
      'query|publisher.queueUsage.share': 1,
      'query|test.share.dataPlane': 1,
      'replaceSubject|publisher.asyncPromote.writeJob': 22,
    },
  },
  fallback: {
    total: 95,
    trace: {
      'background|publisher.queueUsage': 1,
      'normal|(unlabelled createGraph)': 1,
      'normal|(unlabelled flush)': 18,
      'normal|publisher.asyncPromote': 73,
      'normal|test.share': 2,
    },
    shape: {
      'createGraph|-': 1,
      'deleteByPatternWithoutCount|publisher.asyncPromote.deleteJob': 1,
      'deleteByPatternWithoutCount|publisher.asyncPromote.writeJob': 17,
      'flush|-': 18,
      'insert|publisher.asyncPromote.writeJob': 17,
      'insert|test.share.dataPlane': 1,
      'query|publisher.asyncPromote.claimNext.candidates': 4,
      'query|publisher.asyncPromote.clearTerminalJob': 2,
      'query|publisher.asyncPromote.findActiveConflict': 8,
      'query|publisher.asyncPromote.list': 3,
      'query|publisher.asyncPromote.list.payloads': 3,
      'query|publisher.asyncPromote.readJob': 8,
      'query|publisher.asyncPromote.reconcile': 1,
      'query|publisher.asyncPromote.recoverExpired': 5,
      'query|publisher.asyncPromote.recoverPostCommit': 1,
      'query|publisher.asyncPromote.recoverPostCommit.payloads': 1,
      'query|publisher.asyncPromote.selectorLookup': 1,
      'query|publisher.asyncPromote.stats': 1,
      'query|publisher.queueUsage.share': 1,
      'query|test.share.dataPlane': 1,
    },
  },
} as const;

const VARIANTS = [
  { name: 'atomic', atomic: true, hidden: [] as string[] },
  { name: 'fallback', atomic: false, hidden: ['replaceSubject', 'replaceSubjectAndInsert'] },
] as const;

const sorted = (counts: Record<string, number>) => Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));

function callShape(calls: readonly RecordedStoreCall[]): Record<string, number> {
  const shape: Record<string, number> = {};
  for (const call of calls) {
    const key = `${call.method}|${LABEL_MAPPING[call.source ?? ''] ?? call.source ?? '-'}`;
    shape[key] = (shape[key] ?? 0) + 1;
  }
  return sorted(shape);
}

async function record(variant: (typeof VARIANTS)[number], options: { pathOn: boolean; strip?: boolean }) {
  const recorder = recordShareStore(new OxigraphStore(), { hidden: variant.hidden, stripControlQueue: options.strip === true });
  let trace: Record<string, number> = {};
  await withControlPath(options.pathOn, async () => {
    await driveShareWorkload(recorder, { atomic: variant.atomic });
    trace = laneTrace(recorder.calls);
  });
  return { calls: recorder.calls, trace };
}

describe.each(VARIANTS)('AC2 lane trace of the share workload, path off ($name branch)', (variant) => {
  it('equals the multiset the code before the tagging produced', async () => {
    const { calls, trace } = await record(variant, { pathOn: false });
    expect(trace).toEqual(BASE[variant.name].trace);
    expect(calls).toHaveLength(BASE[variant.name].total);
    // Same store calls, same labels (after the mapping): nothing was added, dropped or relabelled apart from the reader.
    expect(callShape(calls)).toEqual(BASE[variant.name].shape);
  });

  it('equals the untagged run, where controlQueue is removed at the store boundary', async () => {
    const tagged = await record(variant, { pathOn: false });
    const untagged = await record(variant, { pathOn: false, strip: true });
    expect(tagged.calls.some((call) => call.options?.controlQueue === 'share')).toBe(true);
    expect(untagged.calls.some((call) => call.options?.controlQueue !== undefined)).toBe(false);
    expect(tagged.trace).toEqual(untagged.trace);
    expect(callShape(tagged.calls)).toEqual(callShape(untagged.calls));
    // The tag adds nothing but controlQueue: the explicit priority of every call is what it was.
    expect(tagged.calls.map((call) => call.options?.priority)).toEqual(untagged.calls.map((call) => call.options?.priority));
  });

  it('moves only the control rows when the path is on: the reader, the COUNT and the data plane stay where they were', async () => {
    const off = await record(variant, { pathOn: false });
    const on = await record(variant, { pathOn: true });
    const control = on.trace['control:share|publisher.asyncPromote'] ?? 0;
    expect(control).toBeGreaterThan(0);
    // One publisher.asyncPromote call stays on the caller's lane: the lock-free ownership reader.
    expect(on.trace['normal|publisher.asyncPromote']).toBe(1);
    expect(control + on.trace['normal|publisher.asyncPromote']!).toBe(off.trace['normal|publisher.asyncPromote']);
    const { 'control:share|publisher.asyncPromote': _moved, 'normal|publisher.asyncPromote': _stayed, ...restOn } = on.trace;
    const { 'normal|publisher.asyncPromote': _all, ...restOff } = off.trace;
    expect(restOn).toEqual(restOff);
  });
});
