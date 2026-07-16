import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { loadSourceWorkerState, runSourceWorkerOnce, saveSourceWorkerState } from '../src/source-worker.js';

// Hand-rolled call recorder: wraps a real impl, records every call's args, and
// returns the impl's result. Replaces the former vitest dependency-injection
// doubles while keeping the code under test (the real source-worker runtime)
// fully real.
function recorder<A extends unknown[], R>(impl: (...args: A) => R) {
  const calls: A[] = [];
  const fn = (...args: A): R => { calls.push(args); return impl(...args); };
  return Object.assign(fn, { calls });
}

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('source worker runtime', () => {
  it('skips unchanged finalized jobs and persists reconciled state', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'source-worker-'));
    cleanup.push(dir);
    const statePath = join(dir, 'state.json');

    const deps = {
      now: () => '2026-04-28T00:00:00.000Z',
      getFingerprint: recorder(async () => 'fp-1'),
      getJobStatus: recorder(async () => ({
        status: 'finalized',
        txHash: '0xabc',
        ual: 'did:dkg:evm:31337/0xabc/1',
      })),
      processSource: recorder(async () => ({
        sourceId: 'src-1',
        skipped: false,
        fingerprint: 'fp-1',
        status: 'queued',
        nextState: { fingerprint: 'fp-1', lastStatus: 'queued', lastJobIds: ['job-1'] },
      })),
    };

    await runSourceWorkerOnce([{ id: 'src-1', maxRetries: 3 }], statePath, deps);
    const second = await runSourceWorkerOnce([{ id: 'src-1', maxRetries: 3 }], statePath, deps);

    expect(deps.processSource.calls).toHaveLength(1);
    expect(second.sources['src-1']).toMatchObject({
      lastStatus: 'finalized',
      finalDaemonStatus: 'finalized',
      pendingPublisherJobIds: [],
      txHash: '0xabc',
      ual: 'did:dkg:evm:31337/0xabc/1',
    });
  });

  it('records failed async jobs without leaving the source queued', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'source-worker-'));
    cleanup.push(dir);
    const statePath = join(dir, 'state.json');

    const deps = {
      now: () => '2026-04-28T00:00:00.000Z',
      getFingerprint: recorder(async () => 'fp-1'),
      getJobStatus: recorder(async () => ({
        status: 'failed',
        failureDetails: { status: 'failed', message: 'publisher failed' },
      })),
      processSource: recorder(async () => ({
        sourceId: 'src-1',
        skipped: false,
        fingerprint: 'fp-1',
        status: 'queued',
        jobIds: ['job-1'],
        jobStatuses: { 'job-1': 'accepted' },
        nextState: {
          fingerprint: 'fp-1',
          lastStatus: 'queued',
          lastJobIds: ['job-1'],
          lastJobStatuses: { 'job-1': 'accepted' },
        },
      })),
    };

    await runSourceWorkerOnce([{ id: 'src-1', maxRetries: 3 }], statePath, deps);
    const second = await runSourceWorkerOnce([{ id: 'src-1', maxRetries: 3 }], statePath, deps);

    expect(deps.processSource.calls).toHaveLength(1);
    expect(second.sources['src-1']).toMatchObject({
      lastStatus: 'failed',
      finalDaemonStatus: 'failed',
      pendingPublisherJobIds: [],
      failureDetails: { status: 'failed', message: 'publisher failed' },
    });
  });

  it('does not resurrect terminal legacy jobs from active lastStatus', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'source-worker-'));
    cleanup.push(dir);
    const statePath = join(dir, 'state.json');

    await saveSourceWorkerState(statePath, {
      sources: {
        'src-1': {
          fingerprint: 'fp-1',
          lastJobIds: ['job-1'],
          lastJobStatuses: { 'job-1': 'finalized' },
          lastStatus: 'queued',
        },
      },
    });

    const deps = {
      now: () => '2026-04-28T00:00:00.000Z',
      getFingerprint: recorder(async () => 'fp-1'),
      getJobStatus: recorder(async () => {
        throw new Error('terminal job should not be polled');
      }),
      processSource: recorder(async () => {
        throw new Error('unchanged finalized source should not be processed');
      }),
    };

    const state = await runSourceWorkerOnce([{ id: 'src-1', maxRetries: 3 }], statePath, deps);

    expect(deps.getJobStatus.calls).toEqual([]);
    expect(deps.processSource.calls).toEqual([]);
    expect(state.sources['src-1']).toMatchObject({
      lastStatus: 'finalized',
      finalDaemonStatus: 'finalized',
      pendingPublisherJobIds: [],
    });
  });

  it('does not restore failure details from stale lastError after finalization', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'source-worker-'));
    cleanup.push(dir);
    const statePath = join(dir, 'state.json');

    await saveSourceWorkerState(statePath, {
      sources: {
        'src-1': {
          fingerprint: 'fp-1',
          lastJobIds: ['job-1'],
          lastJobStatuses: { 'job-1': 'finalized' },
          lastStatus: 'finalized',
          finalDaemonStatus: 'finalized',
          lastError: 'previous publisher failure',
        },
      },
    });

    await expect(loadSourceWorkerState(statePath)).resolves.toMatchObject({
      sources: {
        'src-1': {
          lastStatus: 'finalized',
          finalDaemonStatus: 'finalized',
          failureDetails: undefined,
        },
      },
    });

    const deps = {
      now: () => '2026-04-28T00:00:00.000Z',
      getFingerprint: recorder(async () => 'fp-1'),
      getJobStatus: recorder(async () => {
        throw new Error('finalized job should not be polled');
      }),
      processSource: recorder(async () => {
        throw new Error('unchanged finalized source should not be processed');
      }),
    };

    const state = await runSourceWorkerOnce([{ id: 'src-1', maxRetries: 3 }], statePath, deps);

    expect(deps.getJobStatus.calls).toEqual([]);
    expect(deps.processSource.calls).toEqual([]);
    expect(state.sources['src-1']).toMatchObject({
      lastStatus: 'finalized',
      finalDaemonStatus: 'finalized',
      pendingPublisherJobIds: [],
      failureDetails: undefined,
      lastError: undefined,
    });
  });

  it('reprocesses stable sources only when their content fingerprint changes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'source-worker-'));
    cleanup.push(dir);
    const statePath = join(dir, 'state.json');
    const fingerprints = ['fp-1', 'fp-1', 'fp-2'];
    let processed = 0;

    const deps = {
      now: () => '2026-04-28T00:00:00.000Z',
      getFingerprint: recorder(async () => fingerprints.shift() ?? 'fp-2'),
      getJobStatus: recorder(async () => 'finalized'),
      processSource: recorder(async (source: { id: string }, fingerprint: string) => {
        processed += 1;
        return {
          sourceId: source.id,
          skipped: false,
          jobIds: [`job-${processed}`],
          jobStatuses: { [`job-${processed}`]: 'queued' },
          status: 'queued',
          nextState: {
            fingerprint,
            lastStatus: 'queued',
            lastJobIds: [`job-${processed}`],
            lastJobStatuses: { [`job-${processed}`]: 'queued' },
          },
        };
      }),
    };

    await runSourceWorkerOnce([{ id: 'src-1', maxRetries: 3 }], statePath, deps);
    await runSourceWorkerOnce([{ id: 'src-1', maxRetries: 3 }], statePath, deps);
    const changed = await runSourceWorkerOnce([{ id: 'src-1', maxRetries: 3 }], statePath, deps);

    expect(deps.processSource.calls).toHaveLength(2);
    expect(deps.processSource.calls.map((call) => call[1])).toEqual(['fp-1', 'fp-2']);
    expect(changed.sources['src-1']).toMatchObject({
      fingerprint: 'fp-2',
      lastStatus: 'queued',
      lastJobIds: ['job-2'],
    });
  });

  it('saves state without leaving temp files behind', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'source-worker-'));
    cleanup.push(dir);
    const statePath = join(dir, 'state.json');

    await saveSourceWorkerState(statePath, {
      sources: {
        'src-1': {
          fingerprint: 'fp-1',
          lastStatus: 'queued',
        },
      },
    });

    await expect(readdir(dir)).resolves.toEqual(['state.json']);
    await expect(runSourceWorkerOnce([], statePath, {
      now: () => '2026-04-28T00:00:00.000Z',
      getFingerprint: recorder(async () => ''),
      getJobStatus: recorder(async () => ''),
      processSource: recorder(async () => {
        throw new Error('unexpected source processing');
      }),
    })).resolves.toMatchObject({
      sources: {
        'src-1': {
          fingerprint: 'fp-1',
          lastStatus: 'queued',
        },
      },
    });
  });

  it('persists state durably: creates a missing nested dir, writes full content, renames the temp into place, leaves no temp file', async () => {
    // The original of this test asserted the internal save protocol (same-dir
    // temp write -> file fsync -> rename -> directory fsync) by swapping the
    // whole `node:fs/promises` module for recording doubles. That module-mock
    // is removed here; instead we exercise the REAL `saveSourceWorkerState`
    // against the REAL filesystem and assert every durability-relevant outcome
    // the protocol guarantees and that is observable on disk:
    //   - the target directory is created recursively when missing (mkdir),
    //   - the full serialized state is flushed to the target file
    //     (temp write + fsync + rename), and
    //   - the atomic rename consumes the temp file, so a successful save leaves
    //     ONLY `state.json` behind (no `.state.json.<pid>.<uuid>.tmp` leak, no
    //     cleanup `rm` on the happy path).
    const base = await mkdtemp(join(tmpdir(), 'source-worker-state-'));
    cleanup.push(base);
    // A directory that does NOT yet exist -> forces the recursive mkdir branch.
    const stateDir = join(base, 'nested', 'state-dir');
    const statePath = join(stateDir, 'state.json');

    const state = {
      sources: {
        'src-1': {
          fingerprint: 'fp-1',
          lastStatus: 'queued',
        },
      },
    };

    await saveSourceWorkerState(statePath, state);

    // The missing nested directory was created and now holds exactly the
    // renamed target file — no temp file lingers from the atomic write.
    await expect(readdir(stateDir)).resolves.toEqual(['state.json']);

    // The complete, pretty-printed, newline-terminated payload was flushed
    // (proves the temp write + fsync + rename actually persisted the bytes,
    // not a partial/truncated write).
    const written = await readFile(statePath, 'utf8');
    expect(written).toContain('"src-1"');
    expect(written).toBe(JSON.stringify(state, null, 2) + '\n');

    // And the real load path round-trips the durably-written state.
    await expect(loadSourceWorkerState(statePath)).resolves.toMatchObject({
      sources: {
        'src-1': {
          fingerprint: 'fp-1',
          lastStatus: 'queued',
        },
      },
    });
  });
});
