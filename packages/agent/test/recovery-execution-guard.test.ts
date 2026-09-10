import { describe, expect, it, vi } from 'vitest';
import { createRecoveryExecutionAdmission } from
  '../src/sync/requester/recovery-execution-guard.js';

describe('RecoveryExecutionAdmission', () => {
  it('drains an admitted async mutation sequence without weakening concurrent reads', async () => {
    const revoked = new Error('recovery revoked');
    const controller = new AbortController();
    let current = true;
    let releaseCommit!: () => void;
    const commitGate = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    const operations: string[] = [];
    const read = vi.fn(async () => 'must-not-run');
    const boundary = createRecoveryExecutionAdmission({
      signal: controller.signal,
      assertCurrent: () => {
        if (!current) throw revoked;
      },
    });

    const admitted = boundary.admitAsyncMutation(async () => {
      operations.push('commit-start');
      await commitGate;
      operations.push('commit-finish');
      return 'committed';
    });
    current = false;
    controller.abort(revoked);

    await expect(boundary.read(read)).rejects.toBe(revoked);
    expect(read).not.toHaveBeenCalled();
    releaseCommit();
    await expect(admitted).resolves.toBe('committed');
    expect(operations).toEqual(['commit-start', 'commit-finish']);
  });

  it('rejects both sync and async durability units before admission', async () => {
    const revoked = new Error('recovery revoked');
    const operation = vi.fn();
    const boundary = createRecoveryExecutionAdmission({
      signal: AbortSignal.abort(revoked),
      assertCurrent: () => { throw revoked; },
    });

    expect(() => boundary.admitSyncMutation(operation)).toThrow(revoked);
    expect(operation).not.toHaveBeenCalled();
    await expect(boundary.admitAsyncMutation(async () => {
      operation();
    })).rejects.toBe(revoked);
    expect(operation).not.toHaveBeenCalled();
  });
});
