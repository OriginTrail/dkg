import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fetchSyncPages } from '../src/sync/requester/page-fetch.js';
import { getSyncCheckpointKey, MemorySyncCheckpointStore } from '../src/sync/checkpoint/state.js';
import { DURABLE_DATA_SYNC_SESSION_TTL_MS } from '../src/sync/durable-session.js';
import { didSyncPeerRespond, isSyncTransportFailure } from '../src/sync/error-tags.js';
import type { OperationContext } from '@origintrail-official/dkg-core';

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
const LEGACY_SYNC_BUSY_RESPONSE = '__DKG_SYNC_BUSY__';

function freshCheckpoint(offset: number, nowMs = Date.now()) {
  return {
    offset,
    updatedAtMs: nowMs,
    expiresAtMs: nowMs + DURABLE_DATA_SYNC_SESSION_TTL_MS,
  };
}

function noopLog(): void {}
function makeCtx(): OperationContext {
  return { kind: 'system', id: 'test', startedAt: Date.now() } as never;
}

async function singleQuadParser(nquadsText: string): Promise<{ quads: never[]; totalQuads: number }> {
  if (!nquadsText) return { quads: [], totalQuads: 0 };
  return { quads: [], totalQuads: 1 };
}

describe('sync checkpoint freshness', () => {
  it('expires in-memory checkpoints on read', () => {
    let now = 1_000;
    const store = new MemorySyncCheckpointStore({ clock: () => now, ttlMs: 100 });

    store.set('peer|cg|durable|data', 500);
    expect(store.get('peer|cg|durable|data')).toEqual({
      offset: 500,
      updatedAtMs: 1_000,
      expiresAtMs: 1_100,
    });

    now = 1_101;
    expect(store.get('peer|cg|durable|data')).toBeUndefined();
    expect(store.pruneExpired()).toBe(0);
  });

  it('resumes only from fresh checkpoint entries', async () => {
    let now = 1_000;
    const store = new MemorySyncCheckpointStore({ clock: () => now, ttlMs: 100 });
    const key = getSyncCheckpointKey(REMOTE_PEER_ID, CG_ID, false, 'snapshot');
    store.set(key, 500);

    const fetchOffset = async (): Promise<number> => {
      let observedOffset = -1;
      await fetchSyncPages({
        ctx: makeCtx(),
        remotePeerId: REMOTE_PEER_ID,
        contextGraphId: CG_ID,
        includeSharedMemory: false,
        phase: 'snapshot',
        graphUri: GRAPH_URI,
        deadline: Date.now() + 60_000,
        syncPageTimeoutMs: 5_000,
        syncRouterAttempts: 1,
        syncPageRetryAttempts: 1,
        syncPageSize: 100,
        syncDeniedResponse: '#DENIED',
        debugSyncProgress: false,
        protocolSync: PROTOCOL_ID,
        checkpointStore: store,
        buildSyncRequest: async (_contextGraphId, offset) => {
          observedOffset = offset;
          return new TextEncoder().encode('request');
        },
        parseAndFilter: singleQuadParser,
        send: async () => new Uint8Array(),
        logWarn: noopLog,
        logInfo: noopLog,
        logDebug: noopLog,
      });
      return observedOffset;
    };

    expect(await fetchOffset()).toBe(500);
    now = 1_101;
    expect(await fetchOffset()).toBe(0);
  });
});

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

  it('tags exhausted send failures as transport failures without a peer response', async () => {
    const transportError = new Error('dial failed');
    const promise = fetchSyncPages({
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
        get: () => undefined,
        set: () => {},
        delete: () => {},
      },
      buildSyncRequest: async () => new TextEncoder().encode('request'),
      parseAndFilter: singleQuadParser,
      send: async () => {
        throw transportError;
      },
      logWarn: noopLog,
      logInfo: noopLog,
      logDebug: noopLog,
    });

    await expect(promise).rejects.toBe(transportError);
    expect(isSyncTransportFailure(transportError)).toBe(true);
    expect(didSyncPeerRespond(transportError)).toBe(false);
  });

  it('backs a preferred 256-row page down to the 64-row frame-safe floor across retries', async () => {
    const limits: number[] = [];
    let attempts = 0;
    const promise = fetchSyncPages({
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
      syncPageSize: 256,
      syncDeniedResponse: '#DENIED',
      debugSyncProgress: false,
      protocolSync: PROTOCOL_ID,
      checkpointStore: {
        get: () => undefined,
        set: () => {},
        delete: () => {},
      },
      buildSyncRequest: async (
        _contextGraphId,
        _offset,
        limit,
      ) => {
        limits.push(limit);
        return new TextEncoder().encode(`request-${limit}`);
      },
      parseAndFilter: singleQuadParser,
      send: async () => {
        attempts += 1;
        if (attempts < 3) throw new Error('stream reset');
        return new Uint8Array();
      },
      logWarn: noopLog,
      logInfo: noopLog,
      logDebug: noopLog,
    });

    await expect(runFetchWithFakeTimers(promise)).resolves.toMatchObject({
      completed: true,
      nextOffset: 0,
    });
    expect(limits).toEqual([256, 128, 64]);
  });

  it('tags parser failures after response bytes as peer responses', async () => {
    const parseError = new Error('bad N-Quads');
    const promise = fetchSyncPages({
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
        get: () => undefined,
        set: () => {},
        delete: () => {},
      },
      buildSyncRequest: async () => new TextEncoder().encode('request'),
      parseAndFilter: async () => {
        throw parseError;
      },
      send: async () => new TextEncoder().encode('one-quad-line'),
      logWarn: noopLog,
      logInfo: noopLog,
      logDebug: noopLog,
    });

    await expect(promise).rejects.toBe(parseError);
    expect(didSyncPeerRespond(parseError)).toBe(true);
    expect(isSyncTransportFailure(parseError)).toBe(false);
  });

  async function captureDurableSyncSessionId(options: {
    remotePeerId?: string;
    contextGraphId?: string;
    sinceBatchId?: string;
  } = {}): Promise<string | undefined> {
    let observed: string | undefined;
    const checkpointStore = new MemorySyncCheckpointStore();
    const result = await runFetchWithFakeTimers(
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
        checkpointStore,
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
    // Model the verified/store-committed caller boundary. A completed round
    // deletes its checkpoint, which is what makes the next offset-zero round
    // mint a fresh responder snapshot token.
    checkpointStore.delete(result.checkpointKey);
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
          get: () => freshCheckpoint(0),
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
          get: () => freshCheckpoint(0),
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
          get: () => freshCheckpoint(0),
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
          get: () => freshCheckpoint(1),
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

  it('resumes a durable offset with its persisted responder session after requester restart', async () => {
    vi.setSystemTime(1_700_050_000_000);
    const contextGraphId = 'persisted-responder-session-cg';
    const checkpointKey = getSyncCheckpointKey(
      REMOTE_PEER_ID,
      contextGraphId,
      false,
      'data',
    );
    const checkpointStore = new MemorySyncCheckpointStore();
    const responderSessionId = 'durable-data:persisted-across-restart';
    checkpointStore.set(checkpointKey, 573235);
    checkpointStore.setResponderSession(
      checkpointKey,
      responderSessionId,
      Date.now() + DURABLE_DATA_SYNC_SESSION_TTL_MS,
    );

    const observedBuilds: Array<{
      offset: number;
      syncSessionId: string | undefined;
    }> = [];
    const result = await runFetchWithFakeTimers(fetchSyncPages({
      ctx: makeCtx(),
      remotePeerId: REMOTE_PEER_ID,
      contextGraphId,
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
      send: async () => new TextEncoder().encode(''),
      logWarn: noopLog,
      logInfo: noopLog,
      logDebug: noopLog,
    }));

    expect(result.resumedFromOffset).toBe(573235);
    expect(observedBuilds).toEqual([{
      offset: 573235,
      syncSessionId: responderSessionId,
    }]);
  });

  it('retains a transport-complete session when verification checkpoints a bounded prefix', async () => {
    vi.setSystemTime(1_700_060_000_000);
    const contextGraphId = 'bounded-rootless-prefix-cg';
    const checkpointKey = getSyncCheckpointKey(
      REMOTE_PEER_ID,
      contextGraphId,
      false,
      'data',
    );
    const checkpointStore = new MemorySyncCheckpointStore();
    const observedBuilds: Array<{
      offset: number;
      syncSessionId: string | undefined;
    }> = [];
    let firstPage = true;
    let advanceClockOnNextResponse = false;

    const run = () => runFetchWithFakeTimers(fetchSyncPages({
      ctx: makeCtx(),
      remotePeerId: REMOTE_PEER_ID,
      contextGraphId,
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
        if (advanceClockOnNextResponse) {
          advanceClockOnNextResponse = false;
          vi.setSystemTime(Date.now() + 9 * 60 * 1000);
        }
        if (firstPage) {
          firstPage = false;
          return new TextEncoder().encode('one-quad-line');
        }
        return new TextEncoder().encode('');
      },
      logWarn: noopLog,
      logInfo: noopLog,
      logDebug: noopLog,
    }));

    const first = await run();
    expect(first.completed).toBe(true);
    expect(first.nextOffset).toBe(1);
    const firstSessionId = observedBuilds[0].syncSessionId;
    expect(checkpointStore.get(checkpointKey)).toMatchObject({
      offset: 0,
      responderSessionId: firstSessionId,
    });

    // Mimic rootless manifest verification accepting only the complete graph
    // prefix after the transport itself ended cleanly.
    checkpointStore.set(checkpointKey, 1);
    const firstExpiry = checkpointStore.get(checkpointKey)?.responderSessionExpiresAtMs;
    observedBuilds.length = 0;
    advanceClockOnNextResponse = true;
    const resumed = await run();
    expect(resumed.resumedFromOffset).toBe(1);
    expect(observedBuilds[0]).toEqual({
      offset: 1,
      syncSessionId: firstSessionId,
    });
    expect(checkpointStore.get(checkpointKey)?.responderSessionExpiresAtMs)
      .toBeGreaterThan(firstExpiry ?? 0);

    // A fully verified/store-committed caller deletes the row. Its next round
    // must therefore mint a fresh row-list token, not replay the old snapshot.
    checkpointStore.delete(checkpointKey);
    observedBuilds.length = 0;
    const fresh = await run();
    expect(fresh.resumedFromOffset).toBe(0);
    expect(observedBuilds[0]?.syncSessionId).not.toBe(firstSessionId);
  });

  /**
   * Codex #1173: the contrast to the test above. A RECOVERY fetch must NOT
   * persist/resume the responder session across an incomplete round — recovery
   * rebuilds the COMPLETE state from offset 0 every try, so reusing the responder's
   * cached pre-timeout row list would converge to a STALE snapshot. On retry it
   * must reset to offset 0 and mint a FRESH syncSessionId so the responder
   * re-reads current state.
   */
  it('does NOT reuse the responder session across an incomplete RECOVERY round (mints fresh)', async () => {
    vi.setSystemTime(1_700_000_000_000);
    const observedBuilds: Array<{ offset: number; syncSessionId: string | undefined }> = [];
    let sendCalls = 0;

    const recoveryFetchOpts = (checkpointOffset: number, onSend: () => Uint8Array) => ({
      ctx: makeCtx(),
      remotePeerId: REMOTE_PEER_ID,
      contextGraphId: 'recovery-incomplete-cg',
      includeSharedMemory: true,
      phase: 'data' as const,
      graphUri: GRAPH_URI,
      deadline: Date.now() + 60_000,
      syncPageTimeoutMs: 5_000,
      syncRouterAttempts: 1,
      syncPageRetryAttempts: 1,
      syncPageSize: 1,
      syncDeniedResponse: '#DENIED',
      debugSyncProgress: false,
      protocolSync: PROTOCOL_ID,
      recovery: true,
      checkpointStore: { get: () => freshCheckpoint(checkpointOffset), set: () => {}, delete: () => {} },
      buildSyncRequest: async (
        _cg: string,
        offset: number,
        _l: number,
        _ism: boolean,
        _rp: string,
        _ph: unknown,
        _sr: unknown,
        _sb: unknown,
        syncSessionId?: string,
      ) => {
        observedBuilds.push({ offset, syncSessionId });
        return new TextEncoder().encode(`request-${offset}`);
      },
      parseAndFilter: singleQuadParser,
      send: async () => onSend(),
      logWarn: noopLog,
      logInfo: noopLog,
      logDebug: noopLog,
    });

    // First recovery round: one page, then the deadline passes ⇒ incomplete.
    const first = await runFetchWithFakeTimers(
      fetchSyncPages(recoveryFetchOpts(0, () => {
        sendCalls++;
        if (sendCalls === 1) {
          vi.setSystemTime(1_700_000_060_001);
          return new TextEncoder().encode('one-quad-line');
        }
        return new TextEncoder().encode('');
      })),
    );
    expect(first.completed).toBe(false);
    const recoverySessionId = observedBuilds[0].syncSessionId;
    expect(typeof recoverySessionId).toBe('string');

    // Retry. With NO persisted recovery session, the requester resets to offset 0
    // and mints a fresh syncSessionId (vs. the non-recovery test above, which reuses).
    await runFetchWithFakeTimers(
      fetchSyncPages(recoveryFetchOpts(1, () => new TextEncoder().encode(''))),
    );

    const last = observedBuilds[observedBuilds.length - 1];
    expect(last.offset).toBe(0); // reset — no resumable session for recovery
    expect(last.syncSessionId).not.toBe(recoverySessionId); // FRESH, not reused
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
          get: () => freshCheckpoint(0),
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
    // A successfully served page slides both responder and requester session
    // TTLs. Move beyond that refreshed expiry, not merely beyond round start.
    vi.setSystemTime(Date.now() + DURABLE_DATA_SYNC_SESSION_TTL_MS + 1);

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
          get: () => freshCheckpoint(1),
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
    const checkpointValues = new Map<string, ReturnType<typeof freshCheckpoint>>();
    const deletedCheckpoints: string[] = [];
    const checkpointKey = `${REMOTE_PEER_ID}|superseded-incomplete-session-cg|durable|data`;
    let sendMode: 'timeout' | 'superseded' | 'complete' = 'timeout';

    const checkpointStore = {
      get: (key: string) => checkpointValues.get(key),
      set: (key: string, value: number) => {
        checkpointValues.set(key, freshCheckpoint(value));
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
    checkpointValues.set(checkpointKey, freshCheckpoint(first.nextOffset));
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

  it('rotates an expired responder session immediately even when its checkpoint offset is zero', async () => {
    vi.setSystemTime(1_700_100_000_000);
    const contextGraphId = 'expired-offset-zero-session-cg';
    const checkpointKey = `${REMOTE_PEER_ID}|${contextGraphId}|durable|data`;
    const checkpointStore = new MemorySyncCheckpointStore({ clock: () => Date.now() });
    checkpointStore.set(checkpointKey, 0);
    checkpointStore.setResponderSession(
      checkpointKey,
      'expired-responder-token',
      Date.now() + DURABLE_DATA_SYNC_SESSION_TTL_MS,
    );
    const observedSessionIds: Array<string | undefined> = [];
    let expired = true;

    const runFetch = () => runFetchWithFakeTimers(fetchSyncPages({
      ctx: makeCtx(),
      remotePeerId: REMOTE_PEER_ID,
      contextGraphId,
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
        _offset,
        _limit,
        _includeSharedMemory,
        _remotePeerId,
        _phase,
        _snapshotRef,
        _sinceBatchId,
        syncSessionId,
      ) => {
        observedSessionIds.push(syncSessionId);
        return new TextEncoder().encode('request');
      },
      parseAndFilter: singleQuadParser,
      send: async () => {
        if (expired) throw new Error('Durable data sync session snapshot expired before page completion');
        return new TextEncoder().encode('');
      },
      logWarn: noopLog,
      logInfo: noopLog,
      logDebug: noopLog,
    }));

    await expect(runFetch()).rejects.toThrow('snapshot expired before page completion');
    expect(observedSessionIds.at(-1)).toBe('expired-responder-token');
    expect(checkpointStore.get(checkpointKey)).toBeUndefined();

    expired = false;
    const fresh = await runFetch();
    expect(fresh.resumedFromOffset).toBe(0);
    expect(observedSessionIds.at(-1)).not.toBe('expired-responder-token');
  });

  it('drops a RESUMED session that aborts with a GENERIC transport error (network-path R1 fix)', async () => {
    // 2026-07-07 sync storm. Over the wire the responder's "superseded" message
    // is destroyed by the router's stream.abort, so the requester sees a
    // GENERIC reset — not the text isSyncResponderSessionSupersededError
    // matches. Before the fix this re-saved the doomed session and the retry
    // resumed at offset>0 with a token the responder no longer honoured,
    // looping ~10 min. Now a RESUMED round that aborts drops the session +
    // checkpoint for a clean offset-0 restart, WITHOUT relying on the (lost)
    // superseded message.
    vi.setSystemTime(1_700_100_000_000);
    const observedBuilds: Array<{ offset: number; syncSessionId: string | undefined }> = [];
    const checkpointValues = new Map<string, ReturnType<typeof freshCheckpoint>>();
    const deletedCheckpoints: string[] = [];
    const checkpointKey = `${REMOTE_PEER_ID}|generic-abort-resume-cg|durable|data`;
    let sendMode: 'timeout' | 'abort' | 'complete' = 'timeout';

    const checkpointStore = {
      get: (key: string) => checkpointValues.get(key),
      set: (key: string, value: number) => { checkpointValues.set(key, freshCheckpoint(value)); },
      delete: (key: string) => { deletedCheckpoints.push(key); checkpointValues.delete(key); },
    };

    const runFetch = () => runFetchWithFakeTimers(
      fetchSyncPages({
        ctx: makeCtx(),
        remotePeerId: REMOTE_PEER_ID,
        contextGraphId: 'generic-abort-resume-cg',
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
          if (sendMode === 'abort') {
            // GENERIC transport error — deliberately NOT the "superseded" text.
            throw new Error('stream reset');
          }
          return new TextEncoder().encode('');
        },
        logWarn: noopLog,
        logInfo: noopLog,
        logDebug: noopLog,
      }),
    );

    // Round 1: partial progress then timeout — persists a resumable session.
    const first = await runFetch();
    expect(first.completed).toBe(false);
    expect(first.nextOffset).toBeGreaterThan(0);
    checkpointValues.set(checkpointKey, freshCheckpoint(first.nextOffset));
    const abortedSessionId = observedBuilds[0].syncSessionId;

    // Round 2: RESUME (resumedFromOffset>0), then abort with a generic error.
    sendMode = 'abort';
    const before = deletedCheckpoints.length;
    await expect(runFetch()).rejects.toThrow('stream reset');
    // The fix: the resumed-then-aborted session's checkpoint is DROPPED even
    // though no "superseded" message arrived — no 10-minute resume loop.
    expect(deletedCheckpoints.slice(before)).toContain(checkpointKey);

    // Round 3: clean restart at offset 0 with a FRESH session id.
    sendMode = 'complete';
    const resumed = await runFetch();
    expect(resumed.resumedFromOffset).toBe(0);
    expect(observedBuilds[observedBuilds.length - 1]).toMatchObject({ offset: 0 });
    expect(observedBuilds[observedBuilds.length - 1].syncSessionId).not.toBe(abortedSessionId);
  });

  it('preserves a resumed checkpoint when the responder accepted a page before a transport drop', async () => {
    vi.setSystemTime(1_700_100_000_000);
    const observedBuilds: Array<{ offset: number; syncSessionId: string | undefined }> = [];
    const checkpointValues = new Map<string, ReturnType<typeof freshCheckpoint>>();
    const deletedCheckpoints: string[] = [];
    const checkpointKey = `${REMOTE_PEER_ID}|accepted-page-then-drop-cg|durable|data`;
    let sendMode: 'timeout' | 'page-then-drop' | 'complete' = 'timeout';
    let callsThisRound = 0;

    const checkpointStore = {
      get: (key: string) => checkpointValues.get(key),
      set: (key: string, value: number) => { checkpointValues.set(key, freshCheckpoint(value)); },
      delete: (key: string) => { deletedCheckpoints.push(key); checkpointValues.delete(key); },
    };

    const runFetch = () => {
      callsThisRound = 0;
      return runFetchWithFakeTimers(fetchSyncPages({
        ctx: makeCtx(),
        remotePeerId: REMOTE_PEER_ID,
        contextGraphId: 'accepted-page-then-drop-cg',
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
        parseAndFilter: async (nquadsText) => nquadsText
          ? {
              quads: [{
                subject: 'urn:test:s',
                predicate: 'urn:test:p',
                object: '"value"',
                graph: GRAPH_URI,
              }],
              totalQuads: 1,
            }
          : { quads: [], totalQuads: 0 },
        send: async () => {
          callsThisRound += 1;
          if (sendMode === 'timeout') {
            vi.setSystemTime(1_700_100_060_001);
            return new TextEncoder().encode('one-quad-line');
          }
          if (sendMode === 'page-then-drop') {
            if (callsThisRound === 1) return new TextEncoder().encode('one-quad-line');
            throw new Error('peer-closed-stream; All multiaddr dials failed');
          }
          return new TextEncoder().encode('');
        },
        logWarn: noopLog,
        logInfo: noopLog,
        logDebug: noopLog,
      }));
    };

    // Establish a resumable offset/session pair.
    const first = await runFetch();
    expect(first.completed).toBe(false);
    checkpointValues.set(checkpointKey, freshCheckpoint(first.nextOffset));
    const establishedSessionId = observedBuilds[0].syncSessionId;

    // The resumed token is accepted for one page before the transport drops.
    // Keep the previously certified offset rather than treating this as an
    // immediate-token supersession and deleting the durable checkpoint.
    sendMode = 'page-then-drop';
    const before = deletedCheckpoints.length;
    const interrupted = await runFetch();
    expect(interrupted).toMatchObject({
      completed: false,
      timedOut: true,
      resumedFromOffset: first.nextOffset,
      nextOffset: first.nextOffset + 1,
    });
    expect(interrupted.quads).toHaveLength(1);
    expect(deletedCheckpoints.slice(before)).not.toContain(checkpointKey);
    expect(checkpointValues.get(checkpointKey)?.offset).toBe(first.nextOffset);

    // Model the durable caller certifying the complete prefix and committing
    // its safe boundary before the next bounded round.
    checkpointValues.set(checkpointKey, freshCheckpoint(interrupted.nextOffset));
    sendMode = 'complete';
    const resumed = await runFetch();
    expect(resumed.resumedFromOffset).toBe(interrupted.nextOffset);
    expect(observedBuilds[observedBuilds.length - 1]).toMatchObject({
      offset: interrupted.nextOffset,
      syncSessionId: establishedSessionId,
    });
  });

  it('restarts durable data checkpoints at offset zero with a stable sync session', async () => {
    const contextGraphId = 'orphaned-offset-without-session-cg';
    const observedBuilds: Array<{
      offset: number;
      syncSessionId: string | undefined;
    }> = [];
    const deletedCheckpoints: string[] = [];

    await runFetchWithFakeTimers(
      fetchSyncPages({
        ctx: makeCtx(),
        remotePeerId: REMOTE_PEER_ID,
        contextGraphId,
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
          get: () => freshCheckpoint(250),
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
    expect(deletedCheckpoints).toEqual([`${REMOTE_PEER_ID}|${contextGraphId}|durable|data`]);
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
          get: () => freshCheckpoint(0),
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
          get: () => undefined,
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
          get: () => undefined,
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
          get: () => undefined,
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
          get: () => undefined,
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

  it('retries responder overload transport failures before parsing a page', async () => {
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
          get: () => freshCheckpoint(0),
          set: () => {},
          delete: () => {},
        },
        buildSyncRequest: async () => new TextEncoder().encode('request'),
        parseAndFilter: singleQuadParser,
        send: async () => {
          sendCalls++;
          if (sendCalls === 1) throw new Error('sync responder queue full');
          return new TextEncoder().encode('one-quad-line');
        },
        logWarn: (_ctx, message) => { warnings.push(message); },
        logInfo: noopLog,
        logDebug: noopLog,
      }),
    );

    expect(sendCalls).toBe(2);
    expect(warnings.some((message) => message.includes('sync responder queue full'))).toBe(true);
  });

  it('retries legacy responder busy bodies before parsing a page', async () => {
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
          get: () => freshCheckpoint(0),
          set: () => {},
          delete: () => {},
        },
        buildSyncRequest: async () => new TextEncoder().encode('request'),
        parseAndFilter: singleQuadParser,
        send: async () => {
          sendCalls++;
          return new TextEncoder().encode(sendCalls === 1 ? LEGACY_SYNC_BUSY_RESPONSE : 'one-quad-line');
        },
        logWarn: (_ctx, message) => { warnings.push(message); },
        logInfo: noopLog,
        logDebug: noopLog,
      }),
    );

    expect(sendCalls).toBe(2);
    expect(warnings.some((message) => message.includes('Legacy sync responder busy'))).toBe(true);
  });

  it('retries transport AbortErrors while the caller signal is still live', async () => {
    const warnings: string[] = [];
    const controller = new AbortController();
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
        signal: controller.signal,
        debugSyncProgress: false,
        protocolSync: PROTOCOL_ID,
        checkpointStore: {
          get: () => freshCheckpoint(0),
          set: () => {},
          delete: () => {},
        },
        buildSyncRequest: async () => new TextEncoder().encode('request'),
        parseAndFilter: singleQuadParser,
        send: async () => {
          sendCalls++;
          if (sendCalls === 1) {
            const err = new Error('remote stream aborted');
            err.name = 'AbortError';
            throw err;
          }
          return new TextEncoder().encode('one-quad-line');
        },
        logWarn: (_ctx, message) => { warnings.push(message); },
        logInfo: noopLog,
        logDebug: noopLog,
      }),
    );

    expect(controller.signal.aborted).toBe(false);
    expect(sendCalls).toBe(2);
    expect(warnings.some((message) => message.includes('remote stream aborted'))).toBe(true);
  });

  it('passes caller abort signal to sync transport and does not retry aborts', async () => {
    const controller = new AbortController();
    let releaseSendStarted: () => void = () => {};
    const sendStarted = new Promise<void>((resolve) => {
      releaseSendStarted = resolve;
    });
    let observedSignal: AbortSignal | undefined;
    let sendCalls = 0;
    let retryWarnings = 0;

    const fetchPromise = fetchSyncPages({
      ctx: makeCtx(),
      remotePeerId: REMOTE_PEER_ID,
      contextGraphId: CG_ID,
      includeSharedMemory: false,
      phase: 'meta',
      graphUri: GRAPH_URI,
      deadline: Date.now() + 60_000,
      syncPageTimeoutMs: 10_000,
      syncRouterAttempts: 1,
      syncPageRetryAttempts: 3,
      syncPageSize: 100,
      syncDeniedResponse: '#DENIED',
      signal: controller.signal,
      debugSyncProgress: false,
      protocolSync: PROTOCOL_ID,
      checkpointStore: {
        get: () => freshCheckpoint(0),
        set: () => {},
        delete: () => {},
      },
      buildSyncRequest: async () => new TextEncoder().encode('request'),
      parseAndFilter: singleQuadParser,
      send: async (_peerId, _protocolId, _data, _timeoutMs, _messageId, signal) => {
        sendCalls++;
        observedSignal = signal;
        releaseSendStarted();
        return new Promise<Uint8Array>((_resolve, reject) => {
          if (signal?.aborted) {
            reject(signal.reason);
            return;
          }
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      },
      logWarn: () => { retryWarnings++; },
      logInfo: noopLog,
      logDebug: noopLog,
    });

    await sendStarted;
    const abortReason = new Error('request closed');
    abortReason.name = 'AbortError';
    controller.abort(abortReason);

    await expect(fetchPromise).rejects.toThrow('request closed');
    expect(observedSignal).toBe(controller.signal);
    expect(sendCalls).toBe(1);
    expect(retryWarnings).toBe(0);
  });

  it('rejects pre-aborted DOMException signals without mutating the reason', async () => {
    const controller = new AbortController();
    let buildCalls = 0;
    let sendCalls = 0;

    controller.abort();

    await expect(
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
        signal: controller.signal,
        debugSyncProgress: false,
        protocolSync: PROTOCOL_ID,
        checkpointStore: {
          get: () => freshCheckpoint(0),
          set: () => {},
          delete: () => {},
        },
        buildSyncRequest: async () => {
          buildCalls++;
          return new TextEncoder().encode('request');
        },
        parseAndFilter: singleQuadParser,
        send: async () => {
          sendCalls++;
          return new TextEncoder().encode('');
        },
        logWarn: noopLog,
        logInfo: noopLog,
        logDebug: noopLog,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(buildCalls).toBe(0);
    expect(sendCalls).toBe(0);
  });
});
