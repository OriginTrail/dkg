import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fetchSyncPages } from '../src/sync/requester/page-fetch.js';
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
const PROTOCOL_ID = '/dkg/10.0.1/sync';

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
    promise.finally(() => {
      done = true;
    });
    while (!done) {
      await vi.runAllTimersAsync();
    }
    return promise;
  }

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
});
