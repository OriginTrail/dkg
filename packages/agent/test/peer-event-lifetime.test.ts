import { PeerEventLifetime } from '../src/p2p/peer-event-lifetime.js';
import { PeerSyncSession } from '../src/sync/peer-sync-session.js';
import { describe, expect, it, vi } from 'vitest';

describe('peer event lifetime', () => {
  it('supplies the fully constructed session when a lazy peer job is created', async () => {
    let observedSession: PeerSyncSession | undefined;
    const createJob = vi.fn((_remotePeer: string, session: PeerSyncSession) => {
      observedSession = session;
      return {
        runAutomaticSelectedThenOrdinary: async () => 'not-started' as const,
        runSelected: async () => 'not-started' as const,
        cancel: () => undefined,
        finish: () => undefined,
      };
    });
    const session = new PeerSyncSession({
      createJob,
      onInternalError: () => undefined,
    });
    try {
      const scheduler = session.getScheduler();
      expect(createJob).not.toHaveBeenCalled();
      expect(scheduler.enqueueOrdinary('peer-a', () => undefined, 0)).toBe(true);
      await vi.waitFor(() => expect(createJob).toHaveBeenCalledExactlyOnceWith('peer-a', session));
      expect(observedSession).toBe(session);
    } finally {
      session.close();
    }
  });

  it('surfaces live supervised errors and prevents work admitted after retirement', async () => {
    const lifetime = new PeerEventLifetime();
    const failure = new Error('live task failed');
    await expect(lifetime.run(async () => { throw failure; })).rejects.toBe(failure);
    lifetime.close();
    const release = vi.fn();
    const unregister = lifetime.onClose(release);
    expect(release).toHaveBeenCalledOnce();
    unregister();
    const work = vi.fn(async () => {});
    await lifetime.run(work);
    const commit = vi.fn(() => {});
    lifetime.commit(commit);
    expect(commit).not.toHaveBeenCalled();
    expect(work).not.toHaveBeenCalled();
  });
});
