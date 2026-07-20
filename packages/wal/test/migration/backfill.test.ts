import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FileWalBackfillJournalV1,
  WalBackfillCoordinatorV1,
  planWalBackfillV1,
  type WalBackfillLocalLaneV1,
  type WalBackfillOperationsV1,
  type WalBackfillTargetLaneV1,
} from '../../src/index.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

function bytes(label: string, length = 32): Uint8Array {
  return new Uint8Array(createHash('sha256').update(`wal-backfill-test-v1\0${label}`).digest().subarray(0, length));
}

function target(label: string, overrides: Partial<WalBackfillTargetLaneV1> = {}): WalBackfillTargetLaneV1 {
  return {
    namespaceId: bytes(`namespace:${label}`),
    writerId: bytes(`writer:${label}`, 20),
    writerEpoch: 1n,
    checkpointId: bytes(`checkpoint:${label}`),
    objectSetRoot: bytes(`root:${label}`),
    objectCount: 10n,
    compactionFloor: 0n,
    baselineSnapshotObjectId: null,
    genesisBaseline: false,
    ...overrides,
  };
}

function local(overrides: Partial<WalBackfillLocalLaneV1> = {}): WalBackfillLocalLaneV1 {
  return {
    present: true,
    writerEpoch: 1n,
    objectCount: 5n,
    checkpointId: bytes('local-checkpoint'),
    completeWal: false,
    projection: 'complete',
    ...overrides,
  };
}

async function temporary(label: string): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), `wal-backfill-${label}-`));
  roots.push(value);
  return value;
}

function object(label: string, length: number) {
  return { objectId: bytes(label), canonicalBytes: new Uint8Array(length).fill(7) };
}

function operations() {
  const calls: string[] = [];
  const value: WalBackfillOperationsV1 = {
    fetchBaseline: vi.fn(async lane => {
      calls.push(`baseline:${lane.genesisBaseline ? 'genesis' : 'snapshot'}`);
      return [object(`baseline:${Buffer.from(lane.writerId).toString('hex')}`, 11)];
    }),
    fetchDelta: vi.fn(async lane => {
      calls.push(`delta:${Buffer.from(lane.writerId).toString('hex')}`);
      return [object(`delta:${Buffer.from(lane.writerId).toString('hex')}`, 13)];
    }),
    loadLocalObjects: vi.fn(async lane => {
      calls.push(`local:${Buffer.from(lane.writerId).toString('hex')}`);
      return [object(`local:${Buffer.from(lane.writerId).toString('hex')}`, 17)];
    }),
    verifyAndAdmit: vi.fn(async (_value, ingress) => { calls.push(`admit:${ingress}`); }),
    replayAndMaterialize: vi.fn(async lane => { calls.push(`replay:${Buffer.from(lane.writerId).toString('hex')}`); }),
    verifyTarget: vi.fn(async lane => {
      calls.push(`verify:${Buffer.from(lane.writerId).toString('hex')}`);
      return { objectRoot: true, completeObjects: true, rdf: true, conflicts: true, tombstones: true, vm: true };
    }),
  };
  return { value, calls };
}

describe('WAL-018 backfill and rebuild', () => {
  it('plans and resumes all four paths while local complete-WAL rebuild transfers zero network bytes', async () => {
    const incremental = target('incremental');
    const snapshot = target('snapshot', {
      writerEpoch: 2n,
      compactionFloor: 5n,
      baselineSnapshotObjectId: bytes('snapshot-object'),
    });
    const genesis = target('genesis', { genesisBaseline: true });
    const projection = target('projection');
    const localByWriter = new Map([
      [Buffer.from(incremental.writerId).toString('hex'), local()],
      [Buffer.from(snapshot.writerId).toString('hex'), local({ present: false, writerEpoch: null, objectCount: 0n, checkpointId: null })],
      [Buffer.from(genesis.writerId).toString('hex'), local({ present: false, writerEpoch: null, objectCount: 0n, checkpointId: null })],
      [Buffer.from(projection.writerId).toString('hex'), local({ completeWal: true, objectCount: 10n, checkpointId: projection.checkpointId, projection: 'missing' })],
    ]);
    const plan = await planWalBackfillV1({
      sessionId: 'session-1',
      targetVectorId: bytes('target-vector'),
      targets: [projection, genesis, snapshot, incremental],
      inspectLocal: lane => localByWriter.get(Buffer.from(lane.writerId).toString('hex'))!,
    });
    expect(new Set(plan.lanes.map(lane => lane.path))).toEqual(new Set([
      'INCREMENTAL', 'SNAPSHOT_PLUS_DELTA', 'GENESIS_BOOTSTRAP', 'PROJECTION_REBUILD',
    ]));

    const root = await temporary('resume');
    const journal = new FileWalBackfillJournalV1({ path: join(root, 'journal.json') });
    const active = operations();
    const result = await new WalBackfillCoordinatorV1(active.value, journal).run(plan);
    expect(result).toEqual({
      sessionId: 'session-1',
      networkPayloadBytes: 61n,
      admittedObjects: 6,
      completedLanes: 4,
    });
    expect(active.value.loadLocalObjects).toHaveBeenCalledTimes(1);
    expect(active.calls.filter(call => call.startsWith('baseline:'))).toHaveLength(2);

    const resumed = operations();
    await expect(new WalBackfillCoordinatorV1(resumed.value, journal).run(plan)).resolves.toEqual({
      sessionId: 'session-1',
      networkPayloadBytes: 0n,
      admittedObjects: 0,
      completedLanes: 4,
    });
    expect(resumed.calls).toEqual([]);
  });

  it('keeps local-only rebuild network accounting lane-local after an earlier networked lane', async () => {
    const incremental = target('network-first', { writerId: new Uint8Array(20).fill(1) });
    const projection = target('local-second', { writerId: new Uint8Array(20).fill(2) });
    const plan = await planWalBackfillV1({
      sessionId: 'lane-local-network-accounting',
      targetVectorId: bytes('accounting-vector'),
      targets: [incremental, projection],
      inspectLocal: lane => lane.writerId[19] === 1
        ? local()
        : local({ completeWal: true, objectCount: 10n, checkpointId: projection.checkpointId, projection: 'missing' }),
    });
    expect(plan.lanes.map(lane => lane.path)).toEqual(['INCREMENTAL', 'PROJECTION_REBUILD']);
    const active = operations();
    const root = await temporary('lane-local-network-accounting');
    await expect(new WalBackfillCoordinatorV1(active.value, new FileWalBackfillJournalV1({
      path: join(root, 'journal.json'),
    })).run(plan)).resolves.toMatchObject({ networkPayloadBytes: 13n, completedLanes: 2 });
  });

  it('persists a completed stage across a post-rename crash and fails closed on parity or abort', async () => {
    const root = await temporary('crash');
    let crash = true;
    const journal = new FileWalBackfillJournalV1({
      path: join(root, 'journal.json'),
      transactionHook: phase => {
        if (crash && phase === 'after-rename') {
          crash = false;
          throw new Error('simulated post-rename crash');
        }
      },
    });
    await expect(journal.markCompleted('session', 'lane', 'BASELINE')).rejects.toThrow('simulated');
    await expect(new FileWalBackfillJournalV1({ path: join(root, 'journal.json') }).completedStages('session', 'lane'))
      .resolves.toEqual(new Set(['BASELINE']));

    const lane = target('parity');
    const plan = await planWalBackfillV1({
      sessionId: 'parity-session',
      targetVectorId: bytes('parity-vector'),
      targets: [lane],
      inspectLocal: () => local(),
    });
    const failed = operations();
    failed.value.verifyTarget = vi.fn(async () => ({
      objectRoot: true, completeObjects: true, rdf: true, conflicts: false, tombstones: true, vm: true,
    }));
    await expect(new WalBackfillCoordinatorV1(failed.value, new FileWalBackfillJournalV1({
      path: join(root, 'parity.json'),
    })).run(plan)).rejects.toMatchObject({ code: 'WAL_MIGRATION_INCOMPLETE_TARGET' });

    const aborted = new AbortController();
    aborted.abort();
    await expect(new WalBackfillCoordinatorV1(operations().value, new FileWalBackfillJournalV1({
      path: join(root, 'abort.json'),
    })).run(plan, { signal: aborted.signal })).rejects.toMatchObject({ code: 'WAL_MIGRATION_ABORTED' });
  });

  it('rejects below-floor lanes without snapshots and corrupt or unsafe journals', async () => {
    await expect(planWalBackfillV1({
      sessionId: 'missing-baseline',
      targetVectorId: bytes('vector'),
      targets: [target('missing', { compactionFloor: 5n })],
      inspectLocal: () => local({ present: false, writerEpoch: null, objectCount: 0n, checkpointId: null }),
    })).rejects.toMatchObject({ code: 'WAL_MIGRATION_INCOMPLETE_TARGET' });

    const root = await temporary('journal-invalid');
    const path = join(root, 'journal.json');
    await writeFile(path, '{"version":2,"sessions":{}}\n');
    await expect(new FileWalBackfillJournalV1({ path }).completedStages('session', 'lane'))
      .rejects.toMatchObject({ code: 'WAL_MIGRATION_JOURNAL_CONFLICT' });

    const targetPath = join(root, 'target.json');
    await writeFile(targetPath, '{}');
    const link = join(root, 'link.json');
    await symlink(targetPath, link);
    expect(() => new FileWalBackfillJournalV1({ path: link }))
      .toThrow(expect.objectContaining({ code: 'WAL_MIGRATION_INVALID' }));
    expect(() => new FileWalBackfillJournalV1({ path: 'relative.json' }))
      .toThrow(expect.objectContaining({ code: 'WAL_MIGRATION_INVALID' }));
    expect(await readFile(path, 'utf8')).toContain('"version":2');
  });

  it('rejects every malformed target, local inspection, planner coordinate, and duplicate lane', async () => {
    const base = {
      sessionId: 'validation',
      targetVectorId: bytes('validation-vector'),
      targets: [target('validation')],
      inspectLocal: () => local(),
    };
    const reject = (overrides: Record<string, unknown>) => expect(planWalBackfillV1({
      ...base,
      ...overrides,
    } as never)).rejects.toMatchObject({ code: 'WAL_MIGRATION_INVALID' });
    await reject({ sessionId: 1 });
    await reject({ sessionId: '' });
    await reject({ sessionId: 'x'.repeat(257) });
    await reject({ sessionId: 'e\u0301' });
    await reject({ targetVectorId: 'not-bytes' });
    await reject({ targetVectorId: new Uint8Array(31) });
    await reject({ targets: 'not-an-array' });
    await reject({ inspectLocal: null });

    const invalidTarget = async (overrides: Record<string, unknown>) => reject({
      targets: [{ ...target('invalid-target'), ...overrides }],
    });
    await invalidTarget({ objectCount: 1 });
    await invalidTarget({ objectCount: -1n });
    await invalidTarget({ objectCount: 0x1_0000_0000_0000_0000n });
    await invalidTarget({ compactionFloor: 11n });
    await invalidTarget({ namespaceId: 'not-bytes' });
    await invalidTarget({ namespaceId: new Uint8Array(31) });
    await invalidTarget({ writerId: new Uint8Array(19) });
    await invalidTarget({ writerEpoch: -1n });
    await invalidTarget({ checkpointId: new Uint8Array(31) });
    await invalidTarget({ objectSetRoot: new Uint8Array(31) });
    await invalidTarget({ baselineSnapshotObjectId: new Uint8Array(31) });

    const invalidLocal = async (value: unknown) => reject({ inspectLocal: () => value });
    await invalidLocal(null);
    await invalidLocal({ ...local(), present: 'yes' });
    await invalidLocal({ ...local(), completeWal: 'yes' });
    await invalidLocal({ ...local(), projection: 'unknown' });
    await invalidLocal(local({ present: false, writerEpoch: 1n, checkpointId: null, objectCount: 0n }));
    await invalidLocal(local({ present: false, writerEpoch: null, checkpointId: bytes('contradiction'), objectCount: 0n }));
    await invalidLocal(local({ present: false, writerEpoch: null, checkpointId: null, objectCount: 1n }));
    await invalidLocal(local({ present: false, writerEpoch: null, checkpointId: null, objectCount: 0n, completeWal: true }));
    await invalidLocal(local({ writerEpoch: -1n }));
    await invalidLocal(local({ objectCount: -1n }));
    await invalidLocal(local({ checkpointId: new Uint8Array(31) }));

    await expect(planWalBackfillV1({
      ...base,
      targets: [target('same'), target('same')],
    })).rejects.toMatchObject({ code: 'WAL_MIGRATION_DUPLICATE_STATE' });
  });

  it('rejects malformed byte batches and every incomplete target parity dimension', async () => {
    const lane = target('object-validation');
    const plan = await planWalBackfillV1({
      sessionId: 'object-validation', targetVectorId: bytes('object-validation-vector'),
      targets: [lane], inspectLocal: () => local(),
    });
    const invalidBatches: unknown[] = [
      'not-an-array',
      [{ objectId: new Uint8Array(31), canonicalBytes: new Uint8Array([1]) }],
      [{ objectId: bytes('bad-byte-type'), canonicalBytes: 'not-bytes' }],
      [{ objectId: bytes('empty-bytes'), canonicalBytes: new Uint8Array() }],
      [object('duplicate', 1), object('duplicate', 1)],
    ];
    for (const batch of invalidBatches) {
      const active = operations();
      active.value.fetchDelta = vi.fn(async () => batch as never);
      await expect(new WalBackfillCoordinatorV1(active.value, new FileWalBackfillJournalV1({
        path: join(await temporary('invalid-batch'), 'journal.json'),
      })).run(plan)).rejects.toMatchObject({
        code: batch === invalidBatches.at(-1) ? 'WAL_MIGRATION_DUPLICATE_STATE' : 'WAL_MIGRATION_INVALID',
      });
    }

    const dimensions = ['objectRoot', 'completeObjects', 'rdf', 'conflicts', 'tombstones', 'vm'] as const;
    for (const dimension of dimensions) {
      const active = operations();
      active.value.verifyTarget = vi.fn(async () => ({
        objectRoot: true, completeObjects: true, rdf: true,
        conflicts: true, tombstones: true, vm: true, [dimension]: false,
      }));
      await expect(new WalBackfillCoordinatorV1(active.value, new FileWalBackfillJournalV1({
        path: join(await temporary(`parity-${dimension}`), 'journal.json'),
      })).run(plan)).rejects.toMatchObject({ code: 'WAL_MIGRATION_INCOMPLETE_TARGET' });
    }
  });

  it('fails closed for invalid coordinator inputs, plans, journal calls, paths, and persisted JSON shapes', async () => {
    expect(() => new WalBackfillCoordinatorV1(null as never, {} as never))
      .toThrow(expect.objectContaining({ code: 'WAL_MIGRATION_INVALID' }));
    expect(() => new WalBackfillCoordinatorV1(operations().value, null as never))
      .toThrow(expect.objectContaining({ code: 'WAL_MIGRATION_INVALID' }));
    expect(() => new FileWalBackfillJournalV1({ path: 'relative.json' }))
      .toThrow(expect.objectContaining({ code: 'WAL_MIGRATION_INVALID' }));
    const directory = await temporary('journal-directory');
    expect(() => new FileWalBackfillJournalV1({ path: directory }))
      .toThrow(expect.objectContaining({ code: 'WAL_MIGRATION_INVALID' }));

    const root = await temporary('journal-boundaries');
    const file = new FileWalBackfillJournalV1({ path: join(root, 'journal.json') });
    await expect(file.completedStages('', 'lane')).rejects.toMatchObject({ code: 'WAL_MIGRATION_INVALID' });
    await expect(file.completedStages('session', '')).rejects.toMatchObject({ code: 'WAL_MIGRATION_INVALID' });
    expect(() => file.markCompleted('session', 'lane', 'UNKNOWN' as never))
      .toThrow(expect.objectContaining({ code: 'WAL_MIGRATION_INVALID' }));

    const malformed: unknown[] = [
      null, 1, [], {}, { version: 2, sessions: {} }, { version: 1 },
      { version: 1, sessions: [] }, { version: 1, sessions: { session: null } },
      { version: 1, sessions: { session: [] } },
      { version: 1, sessions: { session: { lane: 'BASELINE' } } },
      { version: 1, sessions: { session: { lane: ['UNKNOWN'] } } },
    ];
    for (const [index, value] of malformed.entries()) {
      const path = join(root, `malformed-${index}.json`);
      await writeFile(path, JSON.stringify(value));
      await expect(new FileWalBackfillJournalV1({ path }).completedStages('session', 'lane'))
        .rejects.toMatchObject({ code: 'WAL_MIGRATION_JOURNAL_CONFLICT' });
    }
    const invalidJson = join(root, 'invalid-json.json');
    await writeFile(invalidJson, '{');
    await expect(new FileWalBackfillJournalV1({ path: invalidJson }).completedStages('session', 'lane'))
      .rejects.toMatchObject({ code: 'WAL_MIGRATION_JOURNAL_CONFLICT' });

    const active = operations();
    const coordinator = new WalBackfillCoordinatorV1(active.value, file);
    await expect(coordinator.run({ sessionId: '', targetVectorId: bytes('run-vector'), lanes: [] }))
      .rejects.toMatchObject({ code: 'WAL_MIGRATION_INVALID' });
    await expect(coordinator.run({ sessionId: 'run', targetVectorId: new Uint8Array(31), lanes: [] }))
      .rejects.toMatchObject({ code: 'WAL_MIGRATION_INVALID' });
  });
});
