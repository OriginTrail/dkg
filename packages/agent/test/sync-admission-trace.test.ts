import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOperationContext } from '@origintrail-official/dkg-core';
import { SYNC_ADMISSION_TRACE_HOLDING_MS, traceSyncAdmission } from '../src/sync/admission-trace.js';
import { resolveSyncGlobalBackpressure, withGlobalSyncBackpressure } from '../src/sync/backpressure.js';

interface TraceLine {
  event: 'start' | 'holding' | 'release';
  id: string;
  ids: string[];
  label: string;
  slot: string;
  limit: number | null;
  queueLimit: number | null;
  partitioned: boolean;
  at: number;
}

/** Every variable that overrides the policies these tests resolve. */
const SYNC_ENV = [
  'DKG_SYNC_ADMISSION_TRACE',
  'DKG_SYNC_GLOBAL_MAX_INFLIGHT',
  'DKG_SYNC_GLOBAL_LIMIT',
  'DKG_SYNC_GLOBAL_QUEUE_LIMIT',
  'DKG_SYNC_SHARED_MEMORY_RESERVED_INFLIGHT',
  'DKG_SYNC_CONTROL_PLANE_RESERVED_INFLIGHT',
] as const;
const ctx = createOperationContext('sync');
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const lines = (file: string): TraceLine[] => (existsSync(file)
  ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as TraceLine)
  : []);
/** The start and release lines only: a slow run may also have written a `holding` line. */
const admissionLines = (file: string): TraceLine[] => lines(file).filter((line) => line.event !== 'holding');

/** Work that holds its admission until `end()`. */
function heldWork(): { work: () => Promise<void>; started: Promise<void>; end: () => void } {
  let end!: () => void;
  let markStarted!: () => void;
  const ended = new Promise<void>((resolve) => { end = resolve; });
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  return { work: () => { markStarted(); return ended; }, started, end: () => end() };
}

describe('sync admission trace (DKG_SYNC_ADMISSION_TRACE)', () => {
  let dir: string;
  let file: string;
  let savedEnv: Partial<Record<(typeof SYNC_ENV)[number], string>> = {};
  beforeEach(() => {
    savedEnv = {};
    for (const name of SYNC_ENV) {
      if (process.env[name] !== undefined) savedEnv[name] = process.env[name];
      delete process.env[name];
    }
    dir = mkdtempSync(join(tmpdir(), 'dkg-admission-trace-'));
    file = join(dir, 'sync-admissions.jsonl');
  });
  afterEach(() => {
    vi.useRealTimers();
    for (const name of SYNC_ENV) {
      if (savedEnv[name] === undefined) delete process.env[name];
      else process.env[name] = savedEnv[name];
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes nothing unless the variable names a file', async () => {
    expect(await traceSyncAdmission('shared-memory:g:peer', async () => 'done')).toBe('done');
    expect(existsSync(file)).toBe(false);
  });

  it('records no policy it was not given, and the general slot by default', async () => {
    process.env.DKG_SYNC_ADMISSION_TRACE = file;
    await traceSyncAdmission('shared-memory:g:peer', async () => undefined);
    expect(admissionLines(file).map((line) => [line.slot, line.limit, line.queueLimit, line.partitioned])).toEqual([['general', null, null, false], ['general', null, null, false]]);
  });

  it('brackets each admission\'s work: its start once it holds the slot, its release before the next admission starts', async () => {
    process.env.DKG_SYNC_ADMISSION_TRACE = file;
    const policy = resolveSyncGlobalBackpressure({ syncGlobalMaxInflight: 1, syncGlobalQueueLimit: 1 });
    const large = heldWork();
    const first = withGlobalSyncBackpressure({ policy, ctx, label: 'durable:large:peer1' }, large.work);
    try {
      await large.started;
      const second = withGlobalSyncBackpressure({ policy, ctx, label: 'durable:public:peer1' }, async () => 'second');
      await tick();
      // The second admission waits in the queue: only the first holds the slot.
      expect(admissionLines(file).map((line) => [line.event, line.label])).toEqual([['start', 'durable:large:peer1']]);
      large.end();
      await Promise.all([first, second]);
    } finally {
      large.end();
      await first;
    }
    const trace = admissionLines(file);
    expect(trace.map((line) => [line.event, line.label])).toEqual([
      ['start', 'durable:large:peer1'],
      ['release', 'durable:large:peer1'],
      ['start', 'durable:public:peer1'],
      ['release', 'durable:public:peer1'],
    ]);
    expect(trace[1].id).toBe(trace[0].id);
    expect(trace[3].id).toBe(trace[2].id);
    expect(trace[2].id).not.toBe(trace[0].id);
    expect(trace[2].at).toBeGreaterThanOrEqual(trace[1].at);
    expect(trace.every((line) => line.slot === 'general')).toBe(true);
    // The general pool's effective policy, on every line.
    expect(trace.map((line) => [line.limit, line.queueLimit, line.partitioned])).toEqual(Array(4).fill([1, 1, false]));
  });

  it('names the reserve whose slot an admission holds beside a large transfer in the only general slot', async () => {
    process.env.DKG_SYNC_ADMISSION_TRACE = file;
    const policy = resolveSyncGlobalBackpressure({ syncGlobalMaxInflight: 1, syncGlobalQueueLimit: 0 });
    const large = heldWork();
    const transfer = withGlobalSyncBackpressure(
      { policy, ctx, contextGraphId: 'urn:cg:large', label: 'durable:urn:cg:large:peer', lane: 'durable', source: 'vm-recovery' },
      large.work,
    );
    try {
      await large.started;
      await withGlobalSyncBackpressure(
        { policy, ctx, contextGraphId: 'urn:cg:small', label: 'shared-memory:urn:cg:small:peer', lane: 'shared_memory', source: 'on-connect' },
        async () => undefined,
      );
      await withGlobalSyncBackpressure(
        { policy, ctx, contextGraphId: 'urn:cg:small', label: 'durable:control-plane', lane: 'durable', source: 'control-plane' },
        async () => undefined,
      );
    } finally {
      large.end();
      await transfer;
    }
    expect(admissionLines(file).map((line) => [line.event, line.label, line.slot])).toEqual([
      ['start', 'durable:urn:cg:large:peer', 'general'],
      ['start', 'shared-memory:urn:cg:small:peer', 'shared-memory'],
      ['release', 'shared-memory:urn:cg:small:peer', 'shared-memory'],
      ['start', 'durable:control-plane', 'control-plane'],
      ['release', 'durable:control-plane', 'control-plane'],
      ['release', 'durable:urn:cg:large:peer', 'general'],
    ]);
    // The general pool stays one slot and no queue, whatever the reserved slots add to the reported capacity.
    expect(admissionLines(file).every((line) => line.limit === 1 && line.queueLimit === 0 && line.partitioned === false)).toBe(true);
  });

  it('lists the admissions that hold a slot once a second, and nothing once none does', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(100_000);
    process.env.DKG_SYNC_ADMISSION_TRACE = file;
    const large = heldWork();
    const small = heldWork();
    const first = traceSyncAdmission('shared-memory:large:peer', large.work);
    vi.advanceTimersByTime(SYNC_ADMISSION_TRACE_HOLDING_MS);
    const second = traceSyncAdmission('shared-memory:public:peer', small.work);
    vi.advanceTimersByTime(SYNC_ADMISSION_TRACE_HOLDING_MS);
    small.end();
    await second;
    vi.advanceTimersByTime(SYNC_ADMISSION_TRACE_HOLDING_MS);
    large.end();
    await first;
    vi.advanceTimersByTime(5 * SYNC_ADMISSION_TRACE_HOLDING_MS);
    const trace = lines(file);
    const [largeId, smallId] = trace.filter((line) => line.event === 'start').map((line) => line.id);
    expect(trace.map((line) => [line.event, line.event === 'holding' ? line.ids : line.id, line.at])).toEqual([
      ['start', largeId, 100_000],
      ['holding', [largeId], 101_000],
      ['start', smallId, 101_000],
      ['holding', [largeId, smallId], 102_000],
      ['release', smallId, 102_000],
      ['holding', [largeId], 103_000],
      ['release', largeId, 103_000],
    ]);
  });

  it('a release that cannot be written ends the admission in the trace: no later line lists it as holding', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(100_000);
    process.env.DKG_SYNC_ADMISSION_TRACE = file;
    const large = heldWork();
    const small = heldWork();
    const first = traceSyncAdmission('shared-memory:large:peer', large.work);
    const second = traceSyncAdmission('shared-memory:public:peer', small.work);
    vi.advanceTimersByTime(SYNC_ADMISSION_TRACE_HOLDING_MS);
    const [largeId, smallId] = lines(file).filter((line) => line.event === 'start').map((line) => line.id);
    expect(lines(file).at(-1)).toMatchObject({ event: 'holding', ids: [largeId, smallId] });
    // The trace file is a directory while the large transfer ends: its release is lost.
    rmSync(file);
    mkdirSync(file);
    large.end();
    await first;
    rmSync(file, { recursive: true });
    vi.advanceTimersByTime(SYNC_ADMISSION_TRACE_HOLDING_MS);
    small.end();
    await second;
    expect(lines(file).map((line) => [line.event, line.event === 'holding' ? line.ids : line.id])).toEqual([
      ['holding', [smallId]],
      ['release', smallId],
    ]);
  });

  it('records the release of work that fails, and the failure still reaches the caller', async () => {
    process.env.DKG_SYNC_ADMISSION_TRACE = file;
    await expect(traceSyncAdmission('shared-memory:g:peer', async () => { throw new Error('pull failed'); })).rejects.toThrow('pull failed');
    expect(admissionLines(file).map((line) => line.event)).toEqual(['start', 'release']);
  });

  it('a trace that cannot be written does not stand in the way of the work', async () => {
    process.env.DKG_SYNC_ADMISSION_TRACE = join(dir, 'missing-directory', 'sync-admissions.jsonl');
    expect(await traceSyncAdmission('shared-memory:g:peer', async () => 'done')).toBe('done');
  });
});
