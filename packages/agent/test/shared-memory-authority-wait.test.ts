// SPDX-License-Identifier: Apache-2.0

/**
 * The pieces that tell a shared-memory check's "no" that only waits for the
 * graph's RFC-64 authority from a refusal, and that keep the node's log of
 * such waits to one line where an operator sees it. The production check and
 * reconcile that use them are covered in swm-gossip-authority-wait.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';
import { createOperationContext } from '@origintrail-official/dkg-core';
import {
  describeSharedMemoryAuthorityWait,
  rfc64SharedMemoryAuthorityWaitV1,
  SHARED_MEMORY_AUTHORITY_WAITS_MAX,
  SharedMemoryAuthorityWaitObservation,
  SharedMemoryAuthorityWaits,
  sharedMemoryAuthorityNo,
  sharedMemoryAuthorityWaitsOf,
  SharedMemorySyncAuthorityCheck,
  type SharedMemoryAuthorityWait,
} from '../src/internal/shared-memory-authority-wait.js';

const CG = 'did:example:authority-wait';
const OTHER_CG = 'did:example:another-graph';
const NOT_ACCEPTED: SharedMemoryAuthorityWait = {
  waitingFor: 'the graph\'s RFC-64 authority',
  detail: 'not accepted on this node yet',
};
const UNFINALIZED: SharedMemoryAuthorityWait = {
  waitingFor: 'the graph\'s RFC-64 authority',
  detail: 'last refresh: registered-authority-unfinalized',
};

function rfc64Reads(state: {
  transportActive: boolean;
  accepted: boolean;
  refreshFailure?: string;
}) {
  return {
    isRfc64CatalogTransportAuthorityActiveV1: vi.fn(() => state.transportActive),
    readAcceptedRfc64CatalogAccessSnapshotV1: vi.fn(() => (state.accepted ? { policy: {} } : null)),
    rfc64CatalogAuthorityRefreshFailureReasonV1: vi.fn(() => state.refreshFailure ?? null),
  };
}

describe('what a "no" from the graph\'s RFC-64 authority waits for', () => {
  it('waits while the graph\'s authority does not govern its transport, accepted policy or not', () => {
    for (const accepted of [false, true]) {
      expect(rfc64SharedMemoryAuthorityWaitV1(rfc64Reads({ transportActive: false, accepted }), CG))
        .toEqual(NOT_ACCEPTED);
    }
  });

  it('waits while no policy is accepted for a governed transport', () => {
    expect(rfc64SharedMemoryAuthorityWaitV1(rfc64Reads({ transportActive: true, accepted: false }), CG))
      .toEqual(NOT_ACCEPTED);
  });

  it('names the last failed refresh', () => {
    expect(rfc64SharedMemoryAuthorityWaitV1(rfc64Reads({
      transportActive: false,
      accepted: false,
      refreshFailure: 'registered-authority-unfinalized',
    }), CG)).toEqual(UNFINALIZED);
  });

  it('is a refusal when an accepted policy governs the transport', () => {
    const reads = rfc64Reads({ transportActive: true, accepted: true, refreshFailure: 'stale' });
    expect(rfc64SharedMemoryAuthorityWaitV1(reads, CG)).toBeUndefined();
    expect(reads.isRfc64CatalogTransportAuthorityActiveV1).toHaveBeenCalledWith(CG);
    expect(reads.readAcceptedRfc64CatalogAccessSnapshotV1).toHaveBeenCalledWith(CG);
    expect(reads.rfc64CatalogAuthorityRefreshFailureReasonV1).not.toHaveBeenCalled();
  });

  it('describes a wait for a log line', () => {
    expect(describeSharedMemoryAuthorityWait(UNFINALIZED))
      .toBe('the graph\'s RFC-64 authority (last refresh: registered-authority-unfinalized)');
  });
});

describe('observing one check', () => {
  it('returns exactly what the check returns', async () => {
    const result = Promise.resolve(true);
    const observation = new SharedMemoryAuthorityWaitObservation(CG);
    expect(observation.run(() => result)).toBe(result);
    await expect(result).resolves.toBe(true);
    expect(observation.wait).toBeUndefined();
  });

  it('learns a wait the check reports, after its awaits too', async () => {
    const observation = new SharedMemoryAuthorityWaitObservation(CG);
    const canUse = await observation.run(async () => {
      await Promise.resolve();
      return sharedMemoryAuthorityNo(CG, NOT_ACCEPTED);
    });
    expect(canUse).toBe(false);
    expect(observation.wait).toEqual(NOT_ACCEPTED);
  });

  it('keeps the first wait of the check, and only for the observed graph', () => {
    const observation = new SharedMemoryAuthorityWaitObservation(CG);
    observation.run(() => {
      sharedMemoryAuthorityNo(OTHER_CG, UNFINALIZED);
      sharedMemoryAuthorityNo(CG, NOT_ACCEPTED);
      sharedMemoryAuthorityNo(CG, UNFINALIZED);
    });
    expect(observation.wait).toEqual(NOT_ACCEPTED);
  });

  it('learns nothing from a refusal, or from a check it does not run', () => {
    const observation = new SharedMemoryAuthorityWaitObservation(CG);
    expect(observation.run(() => sharedMemoryAuthorityNo(CG, undefined))).toBe(false);
    // Outside any observation the report goes nowhere.
    expect(sharedMemoryAuthorityNo(CG, NOT_ACCEPTED)).toBe(false);
    expect(observation.wait).toBeUndefined();
  });
});

describe('the waits one owner\'s log has reported', () => {
  it('says a new wait at info, a repeat at debug, and a changed one at info again', () => {
    const waits = new SharedMemoryAuthorityWaits();
    expect(waits.wait(CG, NOT_ACCEPTED)).toBe('info');
    expect(waits.wait(CG, { ...NOT_ACCEPTED })).toBe('debug');
    expect(waits.wait(CG, UNFINALIZED)).toBe('info');
    expect(waits.wait(CG, { ...UNFINALIZED, waitingFor: 'something else' })).toBe('info');
    expect(waits.wait(OTHER_CG, NOT_ACCEPTED)).toBe('info');
    expect(waits.size).toBe(2);
  });

  it('ends a wait with what was waited for, and starts the next one anew', () => {
    const waits = new SharedMemoryAuthorityWaits();
    expect(waits.settle(CG)).toBeUndefined();
    waits.wait(CG, NOT_ACCEPTED);
    expect(waits.settle(CG)).toEqual(NOT_ACCEPTED);
    expect(waits.settle(CG)).toBeUndefined();
    expect(waits.size).toBe(0);
    expect(waits.wait(CG, NOT_ACCEPTED)).toBe('info');
  });

  it('forgets the wait reported longest ago when it holds as many graphs as it may', () => {
    const waits = new SharedMemoryAuthorityWaits();
    for (let graph = 0; graph < SHARED_MEMORY_AUTHORITY_WAITS_MAX; graph += 1) {
      waits.wait(`graph-${graph}`, NOT_ACCEPTED);
    }
    // A repeat moves a graph to the back: graph-1 is now the oldest.
    expect(waits.wait('graph-0', NOT_ACCEPTED)).toBe('debug');
    expect(waits.size).toBe(SHARED_MEMORY_AUTHORITY_WAITS_MAX);

    expect(waits.wait('one-more', NOT_ACCEPTED)).toBe('info');
    expect(waits.size).toBe(SHARED_MEMORY_AUTHORITY_WAITS_MAX);
    expect(waits.settle('graph-1')).toBeUndefined();
    expect(waits.wait('graph-0', NOT_ACCEPTED)).toBe('debug');
    expect(waits.wait('graph-2', NOT_ACCEPTED)).toBe('debug');
  });

  it('is one per owner', () => {
    const session = {};
    expect(sharedMemoryAuthorityWaitsOf(session)).toBe(sharedMemoryAuthorityWaitsOf(session));
    expect(sharedMemoryAuthorityWaitsOf(session)).not.toBe(sharedMemoryAuthorityWaitsOf({}));
  });
});

describe('the SWM sync planning\'s check of one graph', () => {
  const ctx = createOperationContext('sync');
  const refused = `Skipping SWM sync for unauthorized or unconfirmed context graph "${CG}"`;
  const waiting = (wait: SharedMemoryAuthorityWait) => (
    `Skipping SWM sync for "${CG}" for now: it waits for ${describeSharedMemoryAuthorityWait(wait)}`
  );

  function logger() {
    return { info: vi.fn(), debug: vi.fn(), warn: vi.fn() };
  }

  async function check(
    waits: SharedMemoryAuthorityWaits,
    log: ReturnType<typeof logger>,
    answer: () => boolean,
  ): Promise<boolean> {
    const syncCheck = new SharedMemorySyncAuthorityCheck(CG, waits);
    return syncCheck.answer(await syncCheck.run(async () => answer()), log, ctx);
  }

  it('says nothing for a "yes" and returns it', async () => {
    const log = logger();
    await expect(check(new SharedMemoryAuthorityWaits(), log, () => true)).resolves.toBe(true);
    expect(log.info).not.toHaveBeenCalled();
    expect(log.debug).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('says a wait at info once, its repeats at debug, and a wait after a "yes" at info again', async () => {
    const waits = new SharedMemoryAuthorityWaits();
    const log = logger();
    const wait = () => sharedMemoryAuthorityNo(CG, NOT_ACCEPTED);
    await expect(check(waits, log, wait)).resolves.toBe(false);
    await expect(check(waits, log, wait)).resolves.toBe(false);
    expect(log.info.mock.calls).toEqual([[ctx, waiting(NOT_ACCEPTED)]]);
    expect(log.debug.mock.calls).toEqual([[ctx, waiting(NOT_ACCEPTED)]]);

    await expect(check(waits, log, () => true)).resolves.toBe(true);
    expect(waits.size).toBe(0);
    await check(waits, log, wait);
    expect(log.info).toHaveBeenCalledTimes(2);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('keeps a refusal at warn, and a refusal ends the wait', async () => {
    const waits = new SharedMemoryAuthorityWaits();
    const log = logger();
    await check(waits, log, () => sharedMemoryAuthorityNo(CG, NOT_ACCEPTED));
    await expect(check(waits, log, () => sharedMemoryAuthorityNo(CG, undefined))).resolves.toBe(false);
    expect(log.warn.mock.calls).toEqual([[ctx, refused]]);
    expect(waits.size).toBe(0);
  });
});
