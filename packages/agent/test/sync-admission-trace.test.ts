import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createOperationContext } from '@origintrail-official/dkg-core';
import { traceSyncAdmission } from '../src/sync/admission-trace.js';
import { resolveSyncGlobalBackpressure, withGlobalSyncBackpressure } from '../src/sync/backpressure.js';

interface TraceLine {
  event: 'start' | 'release';
  id: string;
  label: string;
  reserved: boolean;
  limit: number | null;
  queueLimit: number | null;
  partitioned: boolean;
  at: number;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const lines = (file: string): TraceLine[] => (existsSync(file)
  ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as TraceLine)
  : []);

describe('sync admission trace (DKG_SYNC_ADMISSION_TRACE)', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dkg-admission-trace-'));
    file = join(dir, 'sync-admissions.jsonl');
  });
  afterEach(() => {
    delete process.env.DKG_SYNC_ADMISSION_TRACE;
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes nothing unless the variable names a file', async () => {
    expect(await traceSyncAdmission('shared-memory:g:peer', async () => 'done')).toBe('done');
    expect(existsSync(file)).toBe(false);
  });

  it('records no policy it was not given', async () => {
    process.env.DKG_SYNC_ADMISSION_TRACE = file;
    await traceSyncAdmission('shared-memory:g:peer', async () => undefined);
    expect(lines(file).map((line) => [line.reserved, line.limit, line.queueLimit, line.partitioned])).toEqual([[false, null, null, false], [false, null, null, false]]);
  });

  it('brackets each admission\'s work: its start once it holds the slot, its release before the next admission starts', async () => {
    process.env.DKG_SYNC_ADMISSION_TRACE = file;
    const ctx = createOperationContext('sync');
    const policy = resolveSyncGlobalBackpressure({ syncGlobalMaxInflight: 1, syncGlobalQueueLimit: 1 });
    let releaseFirst!: () => void;
    const first = withGlobalSyncBackpressure({ policy, ctx, label: 'shared-memory:large:peer1' },
      () => new Promise<string>((resolve) => { releaseFirst = () => resolve('first'); }));
    await tick();
    const second = withGlobalSyncBackpressure({ policy, ctx, label: 'shared-memory:public:peer1' }, async () => 'second');
    await tick();
    // The second admission waits in the queue: only the first holds the slot.
    expect(lines(file).map((line) => [line.event, line.label])).toEqual([['start', 'shared-memory:large:peer1']]);
    releaseFirst();
    expect(await Promise.all([first, second])).toEqual(['first', 'second']);
    const trace = lines(file);
    expect(trace.map((line) => [line.event, line.label])).toEqual([
      ['start', 'shared-memory:large:peer1'],
      ['release', 'shared-memory:large:peer1'],
      ['start', 'shared-memory:public:peer1'],
      ['release', 'shared-memory:public:peer1'],
    ]);
    expect(trace[1].id).toBe(trace[0].id);
    expect(trace[3].id).toBe(trace[2].id);
    expect(trace[2].id).not.toBe(trace[0].id);
    expect(trace[2].at).toBeGreaterThanOrEqual(trace[1].at);
    expect(trace.every((line) => line.reserved === false)).toBe(true);
    // The general pool's effective policy, on every line.
    expect(trace.map((line) => [line.limit, line.queueLimit, line.partitioned])).toEqual(Array(4).fill([1, 1, false]));
  });

  it('says which admission holds a reserved shared-memory slot beside a large transfer in the only global slot', async () => {
    process.env.DKG_SYNC_ADMISSION_TRACE = file;
    const ctx = createOperationContext('sync');
    const policy = resolveSyncGlobalBackpressure({ syncGlobalMaxInflight: 1, syncGlobalQueueLimit: 0 });
    let releaseTransfer!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const transfer = withGlobalSyncBackpressure(
      { policy, ctx, contextGraphId: 'urn:cg:large', label: 'durable:urn:cg:large:peer', lane: 'durable', source: 'vm-recovery' },
      () => new Promise<void>((resolve) => { releaseTransfer = resolve; markStarted(); }),
    );
    await started;
    await withGlobalSyncBackpressure(
      { policy, ctx, contextGraphId: 'urn:cg:small', label: 'shared-memory:urn:cg:small:peer', lane: 'shared_memory', source: 'on-connect' },
      async () => undefined,
    );
    releaseTransfer();
    await transfer;
    expect(lines(file).map((line) => [line.event, line.label, line.reserved])).toEqual([
      ['start', 'durable:urn:cg:large:peer', false],
      ['start', 'shared-memory:urn:cg:small:peer', true],
      ['release', 'shared-memory:urn:cg:small:peer', true],
      ['release', 'durable:urn:cg:large:peer', false],
    ]);
    // The general pool stays one slot and no queue, whatever the reserved slot adds to the reported capacity.
    expect(lines(file).every((line) => line.limit === 1 && line.queueLimit === 0 && line.partitioned === false)).toBe(true);
  });

  it('records the release of work that fails, and the failure still reaches the caller', async () => {
    process.env.DKG_SYNC_ADMISSION_TRACE = file;
    await expect(traceSyncAdmission('shared-memory:g:peer', async () => { throw new Error('pull failed'); })).rejects.toThrow('pull failed');
    expect(lines(file).map((line) => line.event)).toEqual(['start', 'release']);
  });

  it('a trace that cannot be written does not stand in the way of the work', async () => {
    process.env.DKG_SYNC_ADMISSION_TRACE = join(dir, 'missing-directory', 'sync-admissions.jsonl');
    expect(await traceSyncAdmission('shared-memory:g:peer', async () => 'done')).toBe('done');
  });
});
