/**
 * A fresh shared-memory sync round (`freshSnapshot`) reads the peer's state at
 * the call: none of its page fetches may join a fetch another round started
 * before it, which could hold the peer's state from before a change the caller
 * was told of (#1611). Page fetches are joined by their sharing identity
 * (`dkg-agent-lifecycle.ts`, `fetchSyncPages`), so a fresh round has one of its
 * own and every other round the shared one.
 */
import { describe, expect, it } from 'vitest';
import type { OperationContext } from '@origintrail-official/dkg-core';
import { runSharedMemorySync } from '../src/sync/requester/shared-memory-sync.js';
import type { SyncPhase } from '../src/sync/auth/request-build.js';
import type { SyncPageFetchOptions } from '../src/sync/requester/page-fetch.js';
import { ctx, noop, pageResult, sharedMemoryProcessResult } from './_helpers/sync-requester-fixtures.js';

describe('the page fetches of a shared-memory sync round', () => {
  it('are shared between ordinary rounds, and a fresh round has its own', async () => {
    const identities: unknown[][] = [];
    const round = async (freshSnapshot?: boolean) => {
      const seen: unknown[] = [];
      identities.push(seen);
      await runSharedMemorySync({
        mode: { kind: 'ordinary' },
        ...(freshSnapshot === undefined ? {} : { freshSnapshot }),
        ctx,
        remotePeerId: 'peer-a',
        contextGraphIds: ['open-swm'],
        createContextGraphSyncDeadline: () => Date.now() + 60_000,
        fetchSyncPages: async (
          _ctx: OperationContext,
          _peer: string,
          contextGraphId: string,
          _includeSharedMemory: boolean,
          phase: SyncPhase,
          _graphUri: string,
          _deadline: number,
          options?: SyncPageFetchOptions,
        ) => {
          seen.push(options?.workAdmission?.fetchSharingIdentity);
          return pageResult(contextGraphId, phase);
        },
        processSharedMemoryBatch: async () => sharedMemoryProcessResult(),
        ensureContextGraph: async () => {},
        storeInsert: async () => {},
        deleteCheckpoint: () => {},
        setCheckpoint: () => {},
        ensureOwnedMap: () => new Map(),
        logInfo: noop,
        logWarn: noop,
        logDebug: noop,
      });
    };

    await round();
    await round(false);
    await round(true);
    await round(true);

    const [ordinary, ordinaryAgain, fresh, freshAgain] = identities.map((seen) => {
      // The metadata and the data fetch of one round carry one identity.
      expect(seen).toHaveLength(2);
      expect(seen[1]).toBe(seen[0]);
      expect(seen[0]).toBeDefined();
      return seen[0];
    });
    expect(ordinaryAgain, 'two ordinary rounds share their page fetches').toBe(ordinary);
    expect(fresh, 'a fresh round joins no ordinary round\'s page fetch').not.toBe(ordinary);
    expect(freshAgain, 'a fresh round joins no ordinary round\'s page fetch').not.toBe(ordinary);
    expect(freshAgain, 'a fresh round joins no other fresh round\'s page fetch').not.toBe(fresh);
  });
});
