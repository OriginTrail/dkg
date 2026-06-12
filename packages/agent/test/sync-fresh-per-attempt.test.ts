import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fetchSyncPages } from '../src/sync/requester/page-fetch.js';
import { DURABLE_DATA_SYNC_SESSION_TTL_MS } from '../src/sync/durable-session.js';
import type { OperationContext } from '@origintrail-official/dkg-core';
import { SYNC_BUSY_RESPONSE } from '../src/dkg-agent-constants.js';

/**
 * Regression tests for the rc.9 PR-E codex review chain on #569.
 *
 * Over the review cycle codex flagged seven distinct correctness
 * issues with intermediate "stable messageId" / "build envelope
 * once" designs. The final design — described in
 * `sendSyncRequest`'s jsdoc — is "fresh envelope + fresh messageId
 * per retry attempt", because sync's app-layer auth envelope
 * carries `issuedAtMs` + `requestId` with a 90s freshness TTL +
 * per-`requestId` replay protection, and any design that tried to
 * keep a stable messageId across attempts had at least one timing
 * scenario where a stale envelope got delivered late (via the
 * substrate's 24h-default outbox-retry window) and the resulting
 * cached denial replayed onto a later attempt.
 *
 * These tests pin the per-attempt freshness invariant. Each one
 * covers a specific codex finding so a regression that tries to
 * reintroduce stable-messageId optimization can't ship without
 * deleting these assertions.
 */

const REMOTE_PEER_ID = '12D3KooWSmU3owJvB9sFw8uApDgKrv2VBMecsGGvgAc4Gq6hB57M';
const CG_ID = 'urn:test:cg';
const GRAPH_URI = `urn:test:cg/graph`;
const PROTOCOL_ID = '/dkg/10.0.2/sync';

function noopLog(): void {}
function makeCtx(): OperationContext {
  return { kind: 'system', id: 'test', startedAt: Date.now() } as never;
}

async function singleQuadParser(nquadsText: string): Promise<{ quads: never[]; totalQuads: number }> {
  if (!nquadsText) return { quads: [], totalQuads: 0 };
  return { quads: [], totalQuads: 1 };
}

describe('fetchSyncPages: fresh envelope + fresh messageId per retry attempt', () => {
  // Fake timers eliminate the real `withRetry` exponential backoff
  // (~1s + 2s between attempts for syncPageRetryAttempts=3), which
  // would otherwise add ~12s of wall-clock to the suite for the
  // four tests below that each force 3 retries. Codex review
  // follow-up #11 on #569.
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * Runs `fetchSyncPages` while pumping the fake-timer clock until
   * the promise resolves. `vi.runAllTimersAsync()` flushes one
   * round of timers AND awaits microtasks they schedule, so calling
   * it in a loop lets us drain a chain of `setTimeout` calls (one
   * per `withRetry` attempt) without paying the real wall-clock
   * cost.
   */
  async function runFetchWithFakeTimers<T>(promise: Promise<T>): Promise<T> {
    let done = false;
    promise.then(
      () => {
        done = true;
      },
      () => {
        done = true;
      },
    );
    while (!done) {
      await vi.runAllTimersAsync();
    }
    return promise;
  }

  async function captureDurableSyncSessionId(options: {
    remotePeerId?: string;
    contextGraphId?: string;
    sinceBatchId?: string;
  } = {}): Promise<string | undefined> {
    let observed: string | undefined;
    await runFetchWithFakeTimers(
      fetchSyncPages({
        ctx: makeCtx(),
        remotePeerId: options.remotePeerId ?? REMOTE_PEER_ID,
        contextGraphId: options.contextGraphId ?? CG_ID,
        includeSharedMemory: false,
        phase: 'data',
        graphUri: GRAPH_URI,
        deadline: Date.now() + 60_000,
        syncPageTimeoutMs: 5_000,
        syncRouterAttempts: 1,
        syncPageRetryAttempts: 1,
        syncPageSize: 100,
        syncDeniedResponse: '#DENIED',
        debugSyncProgress: false,
        protocolSync: PROTOCOL_ID,
        checkpointStore: {
          get: () => 0,
          set: () => {},
          delete: () => {},
        },
        sinceBatchId: options.sinceBatchId,
        buildSyncRequest: async (
          _contextGraphId,
          _offset,
          _limit,
          _includeSharedMemory,
          _remotePeerId,
          _phase,
          _snapshotRef,
          _sinceBatchId,
          syncSessionId,
        ) => {
          observed = syncSessionId;
          return new TextEncoder().encode('request');
        },
        parseAndFilter: singleQuadParser,
        send: async () => new TextEncoder().encode(''),
        logWarn: noopLog,
        logInfo: noopLog,
        logDebug: noopLog,
      }),
    );
    return observed;
  }

  it('keeps parsed quads even when they do not advance the page cursor', async () => {
    const parsedQuad = {
      graph: `${CG_ID}/_meta`,
      subject: `${CG_ID}/registered`,
      predicate: 'http://schema.org/name',
      object: '"registered"',
    } as never;

    const result = await runFetchWithFakeTimers(
      fetchSyncPages({
        ctx: makeCtx(),
        remotePeerId: REMOTE_PEER_ID,
        contextGraphId: CG_ID,
        includeSharedMemory: true,
        phase: 'meta',
        graphUri: GRAPH_URI,
        deadline: Date.now() + 60_000,
        syncPageTimeoutMs: 5_000,
        syncRouterAttempts: 1,
        syncPageRetryAttempts: 1,
        syncPageSize: 100,
        syncDeniedResponse: '#DENIED',
        debugSyncProgress: false,
        protocolSync: PROTOCOL_ID,
        checkpointStore: {
          get: () => 0,
          set: () => {},
          delete: () => {},
        },
        buildSyncRequest: async () => new TextEncoder().encode('request'),
        parseAndFilter: async () => ({ quads: [parsedQuad], totalQuads: 0 }),
        send: async () => new TextEncoder().encode('zero-count-page'),
        logWarn: noopLog,
        logInfo: noopLog,
        logDebug: noopLog,
      }),
    );

    expect(result.quads).toEqual([parsedQuad]);
    expect(result.nextOffset).toBe(0);
    expect(result.completed).toBe(true);
  });

  it('uses one stable sync session id across pages for full durable data sync', async () => {
    const observedBuilds: Array<{
      offset: number;
      includeSharedMemory: boolean;
      phase: string | undefined;
      sinceBatchId: string | undefined;
      syncSessionId: string | undefined;
    }> = [];
    let sendCalls = 0;

    await runFetchWithFakeTimers(
      fetchSyncPages({
        ctx: makeCtx(),
        remotePeerId: REMOTE_PEER_ID,
        contextGraphId: CG_ID,
        includeSharedMemory: false,
        phase: 'data',
        graphUri: GRAPH_URI,
        deadline: Date.now() + 60_000,
        syncPageTimeoutMs: 5_000,
        syncRouterAttempts: 1,
        syncPageRetryAttempts: 1,
        syncPageSize: 1,
        syncDeniedResponse: '#DENIED',
        debugSyncProgress: false,
        protocolSync: PROTOCOL_ID,
        checkpointStore: {
          get: () => 0,
          set: () => {},
          delete: () => {},
        },
        buildSyncRequest: async (
          _contextGraphId,
          offset,
          _limit,
          includeSharedMemory,
          _remotePeerId,
          phase,
          _snapshotRef,
          sinceBatchId,
          syncSessionId,
        ) => {
          observedBuilds.push({
            offset,
            includeSharedMemory,
            phase,
            sinceBatchId,
            syncSessionId,
          });
          return new TextEncoder().encode(`request-${offset}`);
        },
        parseAndFilter: singleQuadParser,
        send: async () => {
          sendCalls++;
          return new TextEncoder().encode(sendCalls === 1 ? 'one-quad-line' : '');
        },
        logWarn: noopLog,
        logInfo: noopLog,
        logDebug: noopLog,
      }),
    );

    expect(observedBuilds).toHaveLength(2);
    expect(observedBuilds.map((build) => build.offset)).toEqual([0, 1]);
    expect(observedBuilds.every((build) => build.includeSharedMemory === false)).toBe(true);
    expect(observedBuilds.every((build) => build.phase === 'data')).toBe(true);
    expect(observedBuilds.every((build) => build.sinceBatchId === undefined)).toBe(true);
    expect(typeof observedBuilds[0].syncSessionId).toBe('string');
    expect(observedBuilds[0].syncSessionId?.length).toBeGreaterThan(0);
    expect(observedBuilds[1].syncSessionId).toBe(observedBuilds[0].syncSessionId);
  });

  it('uses a fresh durable sync session id for each completed fetch round', async () => {
    const first = await captureDurableSyncSessionId();
    const second = await captureDurableSyncSessionId();

    expect(typeof first).toBe('string');
    expect(first?.length).toBeGreaterThan(0);
    expect(second).not.toBe(first);
  });

  it('reuses the durable sync session id after an incomplete fetch round', async () => {
    vi.setSystemTime(1_700_000_000_000);
    const observedBuilds: Array<{
      offset: number;
      syncSessionId: string | undefined;
    }> = [];
    let sendCalls = 0;

    const first = await runFetchWithFakeTimers(
      fetchSyncPages({
        ctx: makeCtx(),
        remotePeerId: REMOTE_PEER_ID,
        contextGraphId: 'incomplete-session-cg',
        includeSharedMemory: false,
        phase: 'data',
        graphUri: GRAPH_URI,
        deadline: Date.now() + 60_000,
        syncPageTimeoutMs: 5_000,
        syncRouterAttempts: 1,
        syncPageRetryAttempts: 1,
        syncPageSize: 1,
        syncDeniedResponse: '#DENIED',
        debugSyncProgress: false,
        protocolSync: PROTOCOL_ID,
        checkpointStore: {
          get: () => 0,
          set: () => {},
          delete: () => {},
        },
        buildSyncRequest: async (
          _contextGraphId,
          offset,
          _limit,
          _includeSharedMemory,
          _remotePeerId,
          _phase,
          _snapshotRef,
          _sinceBatchId,
          syncSessionId,
        ) => {
          observedBuilds.push({ offset, syncSessionId });
          return new TextEncoder().encode(`request-${offset}`);
        },
        parseAndFilter: singleQuadParser,
        send: async () => {
          sendCalls++;
          if (sendCalls === 1) {
            vi.setSystemTime(1_700_000_060_001);
            return new TextEncoder().encode('one-quad-line');
          }
          return new TextEncoder().encode('');
        },
        logWarn: noopLog,
        logInfo: noopLog,
        logDebug: noopLog,
      }),
    );

    expect(first.completed).toBe(false);
    expect(first.nextOffset).toBe(1);
    const unfinishedSessionId = observedBuilds[0].syncSessionId;
    expect(typeof unfinishedSessionId).toBe('string');

    await runFetchWithFakeTimers(
      fetchSyncPages({
        ctx: makeCtx(),
        remotePeerId: REMOTE_PEER_ID,
        contextGraphId: 'incomplete-session-cg',
        includeSharedMemory: false,
        phase: 'data',
        graphUri: GRAPH_URI,
        deadline: Date.now() + 60_000,
        syncPageTimeoutMs: 5_000,
        syncRouterAttempts: 1,
        syncPageRetryAttempts: 1,
        syncPageSize: 1,
        syncDeniedResponse: '#DENIED',
        debugSyncProgress: false,
        protocolSync: PROTOCOL_ID,
        checkpointStore: {
          get: () => 1,
          set: () => {},
          delete: () => {},
        },
        buildSyncRequest: async (
          _contextGraphId,
          offset,
          _limit,
          _includeSharedMemory,
          _remotePeerId,
          _phase,
          _snapshotRef,
          _sinceBatchId,
          syncSessionId,
        ) => {
          observedBuilds.push({ offset, syncSessionId });
          return new TextEncoder().encode(`request-${offset}`);
        },
        parseAndFilter: singleQuadParser,
        send: async () => new TextEncoder().encode(''),
        logWarn: noopLog,
        logInfo: noopLog,
        logDebug: noopLog,
      }),
    );

    expect(observedBuilds[observedBuilds.length - 1]).toEqual({
      offset: 1,
      syncSessionId: unfinishedSessionId,
    });
  });

  it('restarts durable data checkpoints when the saved unfinished session expires', async () => {
    vi.setSystemTime(1_700_000_000_000);
    const observedBuilds: Array<{
      contextGraphId: string;
      offset: number;
      syncSessionId: string | undefined;
    }> = [];
    const deletedCheckpoints: string[] = [];
    const checkpointKey = `${REMOTE_PEER_ID}|expired-incomplete-session-cg|durable|data`;

    await runFetchWithFakeTimers(
      fetchSyncPages({
        ctx: makeCtx(),
        remotePeerId: REMOTE_PEER_ID,
        contextGraphId: 'expired-incomplete-session-cg',
        includeSharedMemory: false,
        phase: 'data',
        graphUri: GRAPH_URI,
        deadline: Date.now() + 60_000,
        syncPageTimeoutMs: 5_000,
        syncRouterAttempts: 1,
        syncPageRetryAttempts: 1,
        syncPageSize: 1,
        syncDeniedResponse: '#DENIED',
        debugSyncProgress: false,
        protocolSync: PROTOCOL_ID,
        checkpointStore: {
          get: () => 0,
          set: () => {},
          delete: () => {},
        },
        buildSyncRequest: async (
          contextGraphId,
          offset,
          _limit,
          _includeSharedMemory,
          _remotePeerId,
          _phase,
          _snapshotRef,
          _sinceBatchId,
          syncSessionId,
        ) => {
          observedBuilds.push({ contextGraphId, offset, syncSessionId });
          return new TextEncoder().encode(`request-${offset}`);
        },
        parseAndFilter: singleQuadParser,
        send: async () => {
          vi.setSystemTime(1_700_000_060_001);
          return new TextEncoder().encode('one-quad-line');
        },
        logWarn: noopLog,
        logInfo: noopLog,
        logDebug: noopLog,
      }),
    );

    const expiredSessionId = observedBuilds[0].syncSessionId;
    vi.setSystemTime(1_700_000_000_000 + DURABLE_DATA_SYNC_SESSION_TTL_MS + 1);

    await runFetchWithFakeTimers(
      fetchSyncPages({
        ctx: makeCtx(),
        remotePeerId: REMOTE_PEER_ID,
        contextGraphId: 'expired-incomplete-session-cg',
        includeSharedMemory: false,
        phase: 'data',
        graphUri: GRAPH_URI,
        deadline: Date.now() + 60_000,
        syncPageTimeoutMs: 5_000,
        syncRouterAttempts: 1,
        syncPageRetryAttempts: 1,
        syncPageSize: 1,
        syncDeniedResponse: '#DENIED',
        debugSyncProgress: false,
        protocolSync: PROTOCOL_ID,
        checkpointStore: {
          get: () => 1,
          set: () => {},
          delete: (key) => {
            deletedCheckpoints.push(key);
          },
        },
        buildSyncRequest: async (
          contextGraphId,
          offset,
          _limit,
          _includeSharedMemory,
          _remotePeerId,
          _phase,
          _snapshotRef,
          _sinceBatchId,
          syncSessionId,
        ) => {
          observedBuilds.push({ contextGraphId, offset, syncSessionId });
          return new TextEncoder().encode(`request-${offset}`);
        },
        parseAndFilter: singleQuadParser,
        send: async () => new TextEncoder().encode(''),
        logWarn: noopLog,
        logInfo: noopLog,
        logDebug: noopLog,
      }),
    );

    expect(observedBuilds[observedBuilds.length - 1]).toMatchObject({
      contextGraphId: 'expired-incomplete-session-cg',
      offset: 0,
    });
    expect(observedBuilds[observedBuilds.length - 1].syncSessionId).not.toBe(expiredSessionId);
    expect(deletedCheckpoints).toEqual([checkpointKey]);
  });

  it('clears durable data checkpoints when the saved unfinished session is superseded', async () => {
    vi.setSystemTime(1_700_100_000_000);
    const observedBuilds: Array<{
      offset: number;
      syncSessionId: string | undefined;
    }> = [];
    const checkpointValues = new Map<string, number>();
    const deletedCheckpoints: string[] = [];
    const checkpointKey = `${REMOTE_PEER_ID}|superseded-incomplete-session-cg|durable|data`;
    let sendMode: 'timeout' | 'superseded' | 'complete' = 'timeout';

    const checkpointStore = {
      get: (key: string) => checkpointValues.get(key),
      set: (key: string, value: number) => {
        checkpointValues.set(key, value);
      },
      delete: (key: string) => {
        deletedCheckpoints.push(key);
        checkpointValues.delete(key);
      },
    };

    const runSupersededFetch = () => runFetchWithFakeTimers(
      fetchSyncPages({
        ctx: makeCtx(),
        remotePeerId: REMOTE_PEER_ID,
        contextGraphId: 'superseded-incomplete-session-cg',
        includeSharedMemory: false,
        phase: 'data',
        graphUri: GRAPH_URI,
        deadline: Date.now() + 60_000,
        syncPageTimeoutMs: 5_000,
        syncRouterAttempts: 1,
        syncPageRetryAttempts: 1,
        syncPageSize: 1,
        syncDeniedResponse: '#DENIED',
        debugSyncProgress: false,
        protocolSync: PROTOCOL_ID,
        checkpointStore,
        buildSyncRequest: async (
          _contextGraphId,
          offset,
          _limit,
          _includeSharedMemory,
          _remotePeerId,
          _phase,
          _snapshotRef,
          _sinceBatchId,
          syncSessionId,
        ) => {
          observedBuilds.push({ offset, syncSessionId });
          return new TextEncoder().encode(`request-${offset}`);
        },
        parseAndFilter: singleQuadParser,
        send: async () => {
          if (sendMode === 'timeout') {
            vi.setSystemTime(1_700_100_060_001);
            return new TextEncoder().encode('one-quad-line');
          }
          if (sendMode === 'superseded') {
            throw new Error('Durable data sync session was superseded before page completion');
          }
          return new TextEncoder().encode('');
        },
        logWarn: noopLog,
        logInfo: noopLog,
        logDebug: noopLog,
      }),
    );

    const first = await runSupersededFetch();
    expect(first.completed).toBe(false);
    checkpointValues.set(checkpointKey, first.nextOffset);
    const supersededSessionId = observedBuilds[0].syncSessionId;

    sendMode = 'superseded';
    await expect(runSupersededFetch()).rejects.toThrow('Durable data sync session was superseded');
    expect(deletedCheckpoints).toEqual([checkpointKey]);

    sendMode = 'complete';
    const resumed = await runSupersededFetch();
    expect(resumed.resumedFromOffset).toBe(0);
    expect(observedBuilds[observedBuilds.length - 1]).toMatchObject({ offset: 0 });
    expect(observedBuilds[observedBuilds.length - 1].syncSessionId).not.toBe(supersededSessionId);
  });

  it('restarts durable data checkpoints at offset zero with a stable sync session', async () => {
    const observedBuilds: Array<{
      offset: number;
      syncSessionId: string | undefined;
    }> = [];
    const deletedCheckpoints: string[] = [];

    await runFetchWithFakeTimers(
      fetchSyncPages({
        ctx: makeCtx(),
        remotePeerId: REMOTE_PEER_ID,
        contextGraphId: CG_ID,
        includeSharedMemory: false,
        phase: 'data',
        graphUri: GRAPH_URI,
        deadline: Date.now() + 60_000,
        syncPageTimeoutMs: 5_000,
        syncRouterAttempts: 1,
        syncPageRetryAttempts: 1,
        syncPageSize: 100,
        syncDeniedResponse: '#DENIED',
        debugSyncProgress: false,
        protocolSync: PROTOCOL_ID,
        checkpointStore: {
          get: () => 250,
          set: () => {},
          delete: (key) => {
            deletedCheckpoints.push(key);
          },
        },
        buildSyncRequest: async (
          _contextGraphId,
          offset,
          _limit,
          _includeSharedMemory,
          _remotePeerId,
          _phase,
          _snapshotRef,
          _sinceBatchId,
          syncSessionId,
        ) => {
          observedBuilds.push({ offset, syncSessionId });
          return new TextEncoder().encode(`request-${offset}`);
        },
        parseAndFilter: singleQuadParser,
        send: async () => new TextEncoder().encode(''),
        logWarn: noopLog,
        logInfo: noopLog,
        logDebug: noopLog,
      }),
    );

    expect(observedBuilds).toHaveLength(1);
    expect(observedBuilds[0].offset).toBe(0);
    expect(typeof observedBuilds[0].syncSessionId).toBe('string');
    expect(observedBuilds[0].syncSessionId?.length).toBeGreaterThan(0);
    expect(deletedCheckpoints).toEqual([`${REMOTE_PEER_ID}|${CG_ID}|durable|data`]);
  });

  it('uses one stable sync session id across pages for durable delta sync', async () => {
    const observedBuilds: Array<{
      offset: number;
      sinceBatchId: string | undefined;
      syncSessionId: string | undefined;
    }> = [];
    let sendCalls = 0;

    await runFetchWithFakeTimers(
      fetchSyncPages({
        ctx: makeCtx(),
        remotePeerId: REMOTE_PEER_ID,
        contextGraphId: CG_ID,
        includeSharedMemory: false,
        phase: 'data',
        graphUri: GRAPH_URI,
        deadline: Date.now() + 60_000,
        syncPageTimeoutMs: 5_000,
        syncRouterAttempts: 1,
        syncPageRetryAttempts: 1,
        syncPageSize: 1,
        syncDeniedResponse: '#DENIED',
        debugSyncProgress: false,
        protocolSync: PROTOCOL_ID,
        checkpointStore: {
          get: () => 0,
          set: () => {},
          delete: () => {},
        },
        sinceBatchId: '42',
        buildSyncRequest: async (
          _contextGraphId,
          offset,
          _limit,
          _includeSharedMemory,
          _remotePeerId,
          _phase,
          _snapshotRef,
          sinceBatchId,
          syncSessionId,
        ) => {
          observedBuilds.push({ offset, sinceBatchId, syncSessionId });
          return new TextEncoder().encode(`request-${offset}`);
        },
        parseAndFilter: singleQuadParser,
        send: async () => {
          sendCalls++;
          return new TextEncoder().encode(sendCalls === 1 ? 'one-quad-line' : '');
        },
        logWarn: noopLog,
        logInfo: noopLog,
        logDebug: noopLog,
      }),
    );

    expect(observedBuilds).toHaveLength(2);
    expect(observedBuilds.map((build) => build.offset)).toEqual([0, 1]);
    expect(observedBuilds.every((build) => build.sinceBatchId === '42')).toBe(true);
    expect(typeof observedBuilds[0].syncSessionId).toBe('string');
    expect(observedBuilds[0].syncSessionId?.length).toBeGreaterThan(0);
    expect(observedBuilds[1].syncSessionId).toBe(observedBuilds[0].syncSessionId);
  });

  /**
   * Codex review #569 follow-up #1: original PR called
   * `sendReliable` without any `messageId` plumbing. Final design
   * intentionally goes the other way — a FRESH `messageId` per
   * attempt — but it's still a different bug if the substrate
   * adapter receives `undefined`/empty; the page-fetch contract
   * is "always a non-empty string". This pins that.
   */
  it('passes a non-empty messageId on every send invocation', async () => {
    const observedMessageIds: string[] = [];
    let sendAttempts = 0;

    await runFetchWithFakeTimers(
      fetchSyncPages({
        ctx: makeCtx(),
        remotePeerId: REMOTE_PEER_ID,
        contextGraphId: CG_ID,
        includeSharedMemory: false,
        phase: 'data',
        graphUri: GRAPH_URI,
        deadline: Date.now() + 60_000,
        syncPageTimeoutMs: 5_000,
        syncRouterAttempts: 1,
        syncPageRetryAttempts: 3,
        syncPageSize: 100,
        syncDeniedResponse: '#DENIED',
        debugSyncProgress: false,
        protocolSync: PROTOCOL_ID,
        checkpointStore: {
          get: () => 0,
          set: () => {},
          delete: () => {},
        },
        buildSyncRequest: async () => new TextEncoder().encode('request'),
        parseAndFilter: singleQuadParser,
        send: async (_peerId, _protocolId, _data, _timeoutMs, messageId) => {
          observedMessageIds.push(messageId);
          sendAttempts++;
          if (sendAttempts < 3) {
            throw new Error(`transient failure ${sendAttempts}`);
          }
          return new TextEncoder().encode('one-quad-line');
        },
        logWarn: noopLog,
        logInfo: noopLog,
        logDebug: noopLog,
      }),
    );

    expect(observedMessageIds.length).toBe(3);
    for (const id of observedMessageIds) {
      expect(typeof id).toBe('string');
      expect(id.length).toBeGreaterThan(0);
    }
  });

  /**
   * Codex review #569 follow-up #8: stable messageId across retries
   * is unsafe because the substrate's 24h outbox-retry window can
   * deliver a stale envelope long after `SYNC_AUTH_MAX_AGE_MS`
   * (90s), and the cached denial would replay onto later attempts.
   * Final design uses a FRESH messageId per attempt so a cached
   * denial under one attempt's id can never be served back to a
   * different attempt.
   *
   * Forces 3 retries and asserts all 3 messageIds are distinct.
   */
  it('mints a DIFFERENT messageId on every withRetry attempt for the same page', async () => {
    const observedMessageIds: string[] = [];
    let sendAttempts = 0;

    await runFetchWithFakeTimers(
      fetchSyncPages({
        ctx: makeCtx(),
        remotePeerId: REMOTE_PEER_ID,
        contextGraphId: CG_ID,
        includeSharedMemory: false,
        phase: 'data',
        graphUri: GRAPH_URI,
        deadline: Date.now() + 60_000,
        syncPageTimeoutMs: 5_000,
        syncRouterAttempts: 1,
        syncPageRetryAttempts: 3,
        syncPageSize: 100,
        syncDeniedResponse: '#DENIED',
        debugSyncProgress: false,
        protocolSync: PROTOCOL_ID,
        checkpointStore: {
          get: () => 0,
          set: () => {},
          delete: () => {},
        },
        buildSyncRequest: async () => new TextEncoder().encode('request'),
        parseAndFilter: singleQuadParser,
        send: async (_peerId, _protocolId, _data, _timeoutMs, messageId) => {
          observedMessageIds.push(messageId);
          sendAttempts++;
          if (sendAttempts < 3) {
            throw new Error(`transient failure ${sendAttempts}`);
          }
          return new TextEncoder().encode('one-quad-line');
        },
        logWarn: noopLog,
        logInfo: noopLog,
        logDebug: noopLog,
      }),
    );

    expect(observedMessageIds.length).toBe(3);
    expect(new Set(observedMessageIds).size).toBe(3);
  });

  /**
   * Codex review #569 follow-ups #5 + #8: sync's auth envelope
   * carries `issuedAtMs`, and the responder rejects envelopes older
   * than `SYNC_AUTH_MAX_AGE_MS`. With 3 attempts × 45s timeouts,
   * the total retry budget exceeds the auth TTL — so reusing one
   * envelope across attempts would let a slow attempt N arrive at
   * the responder with `now - issuedAtMs > 90s` and be denied as
   * stale. Final design rebuilds the envelope per attempt so each
   * one carries a fresh `issuedAtMs`.
   *
   * Forces 3 retries and asserts `buildSyncRequest` was invoked 3
   * times (matching the attempt count) and that the per-call
   * captured bytes differ (proving "fresh build", not just "build
   * count matches").
   */
  it('rebuilds the request envelope on every withRetry attempt (fresh issuedAtMs/requestId)', async () => {
    let buildCalls = 0;
    let sendAttempts = 0;
    const builtPayloads: string[] = [];

    await runFetchWithFakeTimers(
      fetchSyncPages({
        ctx: makeCtx(),
        remotePeerId: REMOTE_PEER_ID,
        contextGraphId: CG_ID,
        includeSharedMemory: false,
        phase: 'data',
        graphUri: GRAPH_URI,
        deadline: Date.now() + 60_000,
        syncPageTimeoutMs: 5_000,
        syncRouterAttempts: 1,
        syncPageRetryAttempts: 3,
        syncPageSize: 100,
        syncDeniedResponse: '#DENIED',
        debugSyncProgress: false,
        protocolSync: PROTOCOL_ID,
        checkpointStore: {
          get: () => 0,
          set: () => {},
          delete: () => {},
        },
        buildSyncRequest: async () => {
          buildCalls++;
          const payload = `request-attempt-${buildCalls}-${Math.random()}`;
          builtPayloads.push(payload);
          return new TextEncoder().encode(payload);
        },
        parseAndFilter: singleQuadParser,
        send: async (_peerId, _protocolId, data) => {
          sendAttempts++;
          // Capture which build the send received, so the assertion
          // is checking real per-attempt-build behaviour and not just
          // a call count.
          const received = new TextDecoder().decode(data);
          expect(received).toBe(builtPayloads[sendAttempts - 1]);
          if (sendAttempts < 3) {
            throw new Error(`transient failure ${sendAttempts}`);
          }
          return new TextEncoder().encode('one-quad-line');
        },
        logWarn: noopLog,
        logInfo: noopLog,
        logDebug: noopLog,
      }),
    );

    expect(buildCalls).toBe(3);
    expect(sendAttempts).toBe(3);
    expect(new Set(builtPayloads).size).toBe(3);
  });

  /**
   * Codex review #569 follow-up #7: hoisting `buildSyncRequest`
   * out of `withRetry` removed automatic retry coverage for
   * transient build-time failures (`isPrivateContextGraph`,
   * `getIdentityId()`, signing). Final design keeps
   * `requestFactory()` INSIDE `withRetry` — same as the pre-PR
   * baseline — so a build-time throw is treated the same as a
   * send-time throw: `withRetry` backs off and tries again.
   */
  it('retries transient envelope-build failures (build inside withRetry)', async () => {
    let buildCalls = 0;
    let sendCalls = 0;

    await runFetchWithFakeTimers(
      fetchSyncPages({
        ctx: makeCtx(),
        remotePeerId: REMOTE_PEER_ID,
        contextGraphId: CG_ID,
        includeSharedMemory: false,
        phase: 'data',
        graphUri: GRAPH_URI,
        deadline: Date.now() + 60_000,
        syncPageTimeoutMs: 5_000,
        syncRouterAttempts: 1,
        syncPageRetryAttempts: 5,
        syncPageSize: 100,
        syncDeniedResponse: '#DENIED',
        debugSyncProgress: false,
        protocolSync: PROTOCOL_ID,
        checkpointStore: {
          get: () => 0,
          set: () => {},
          delete: () => {},
        },
        buildSyncRequest: async () => {
          buildCalls++;
          if (buildCalls < 3) {
            throw new Error(`transient build failure ${buildCalls}`);
          }
          return new TextEncoder().encode('request');
        },
        parseAndFilter: singleQuadParser,
        send: async () => {
          sendCalls++;
          return new TextEncoder().encode('one-quad-line');
        },
        logWarn: noopLog,
        logInfo: noopLog,
        logDebug: noopLog,
      }),
    );

    // 3 build attempts (2 throws + 1 success), 1 send. The send
    // call count proves the build retries gated the send (a build
    // failure should not bypass to a send).
    expect(buildCalls).toBe(3);
    expect(sendCalls).toBe(1);
  });

  it('retries explicit responder busy sentinels before parsing a page', async () => {
    const warnings: string[] = [];
    let sendCalls = 0;

    await runFetchWithFakeTimers(
      fetchSyncPages({
        ctx: makeCtx(),
        remotePeerId: REMOTE_PEER_ID,
        contextGraphId: CG_ID,
        includeSharedMemory: false,
        phase: 'data',
        graphUri: GRAPH_URI,
        deadline: Date.now() + 60_000,
        syncPageTimeoutMs: 5_000,
        syncRouterAttempts: 1,
        syncPageRetryAttempts: 3,
        syncPageSize: 100,
        syncDeniedResponse: '#DENIED',
        debugSyncProgress: false,
        protocolSync: PROTOCOL_ID,
        checkpointStore: {
          get: () => 0,
          set: () => {},
          delete: () => {},
        },
        buildSyncRequest: async () => new TextEncoder().encode('request'),
        parseAndFilter: singleQuadParser,
        send: async () => {
          sendCalls++;
          return new TextEncoder().encode(sendCalls === 1 ? SYNC_BUSY_RESPONSE : 'one-quad-line');
        },
        logWarn: (_ctx, message) => { warnings.push(message); },
        logInfo: noopLog,
        logDebug: noopLog,
      }),
    );

    expect(sendCalls).toBe(2);
    expect(warnings.some((message) => message.includes('responder busy'))).toBe(true);
  });
});
