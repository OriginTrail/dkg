import { PromoteJobLeaseError, type AsyncPromoteQueue, type PromoteExecutionAuthority } from '@origintrail-official/dkg-publisher';

// The daemon is the sole queue executor. Reconstructed queue instances share this
// fence; a replacement may claim/heartbeat while old domain work finishes, but
// cannot execute concurrently. Process exit drops both work and this fence.
// This is not a distributed lock for multiple daemons sharing a queue namespace.
const activeSections = new Map<string, Promise<void>>();

export function createPromoteExecutionAuthority(queue: AsyncPromoteQueue, jobId: string,
  claimToken: string, now: () => number, assertRunning: () => void): PromoteExecutionAuthority {
  const assertCurrent = async () => {
    assertRunning();
    const current = await queue.getStatus(jobId);
    assertRunning();
    if (current?.state !== 'running' || current.lease?.claimToken !== claimToken
      || current.lease.expiresAt <= now()) {
      throw new PromoteJobLeaseError(jobId, 'execution authority no longer held');
    }
  };
  return { assertCurrent, async run<T>(mutation: () => Promise<T>): Promise<T> {
    const previous = activeSections.get(jobId) ?? Promise.resolve();
    let release!: () => void;
    const section = new Promise<void>(resolve => { release = resolve; });
    activeSections.set(jobId, section);
    await previous;
    try { await assertCurrent(); return await mutation(); }
    finally { release(); if (activeSections.get(jobId) === section) activeSections.delete(jobId); }
  } };
}
