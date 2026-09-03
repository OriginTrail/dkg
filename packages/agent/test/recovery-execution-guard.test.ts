import { describe, expect, it, vi } from 'vitest';
import { createRecoveryExecutionBoundary } from
  '../src/sync/requester/recovery-execution-guard.js';

describe('RecoveryExecutionBoundary', () => {
  it('drains an admitted async durability unit without weakening concurrent reads', async () => {
    const revoked = new Error('recovery revoked');
    const controller = new AbortController();
    let current = true;
    let releaseCommit!: () => void;
    const commitGate = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    const operations: string[] = [];
    const read = vi.fn(async () => 'must-not-run');
    const boundary = createRecoveryExecutionBoundary({
      signal: controller.signal,
      assertCurrent: () => {
        if (!current) throw revoked;
      },
    });

    const admitted = boundary.commitAsync(async () => {
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
    const boundary = createRecoveryExecutionBoundary({
      signal: AbortSignal.abort(revoked),
      assertCurrent: () => { throw revoked; },
    });

    expect(() => boundary.commitSync(operation)).toThrow(revoked);
    expect(operation).not.toHaveBeenCalled();
    await expect(boundary.commitAsync(async () => {
      operation();
    })).rejects.toBe(revoked);
    expect(operation).not.toHaveBeenCalled();
  });
});
