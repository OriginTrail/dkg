// SPDX-License-Identifier: Apache-2.0
/**
 * W1 §6.2 / §10 — the per-ATTEMPT contract (I1–I3), driven through the REAL
 * `sendSyncRequest`, plus the clamping and never-throws guarantees of the
 * shared record helpers.
 *
 * Acceptance covered here: A2, A3, A7 (attempt instruments), A10, A11, A14, A19.
 * Mutants these assertions are written to kill: M1, M2, M3, M9.
 *
 * A10/M9 is an INSTRUMENT-DECLARATION contract rather than a per-attempt one.
 * It lives here because this is the agent package's home for cross-cutting
 * instrument guarantees (clamping, never-throws) and because this file is named
 * in the §8.3 packet — a bucket assertion outside the packet would not be run
 * by the gate, which is the whole reason the property went unprotected.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { getMetrics } from '@origintrail-official/dkg-core';
import { sendSyncRequest } from '../src/p2p/sync-transport.js';
import {
  activeSyncAdmissionSource,
  normalizeSyncAttemptOutcome,
  normalizeSyncAttemptPhase,
  normalizeSyncAttemptPlane,
  normalizeSyncAttemptTransport,
  normalizeSyncOperationLane,
  normalizeSyncOperationOutcome,
  normalizeSyncOperationRejectionReason,
  normalizeSyncSingleFlightScope,
  recordSyncAttempt,
  recordSyncAttemptRequestBytes,
  recordSyncAttemptResponseBytes,
  recordSyncOperationDuration,
  recordSyncOperationRejected,
  recordSyncSingleFlightJoin,
  syncAttemptAttributes,
  syncOperationRejectionReason,
  syncPlaneFor,
  withSyncAdmissionSource,
} from '../src/sync/attempt-telemetry.js';
import { SyncBackpressureBusyError } from '../src/sync/backpressure.js';
import { W1MetricsHarness, I1, I2, I3, I9 } from './_helpers/w1-metrics.js';

const PROTO = '/dkg/10.0.2/sync';
const REQUEST_BYTES = new Uint8Array([1, 2, 3, 4]);
const RESPONSE_BYTES = new Uint8Array([9, 9]);

const harness = new W1MetricsHarness();

afterEach(async () => {
  await harness.dispose();
});

function attemptParams(overrides: Record<string, unknown> = {}): any {
  return {
    remotePeerId: 'remote-peer',
    timeoutMs: 1000,
    retryAttempts: 1,
    contextGraphId: 'cg-1',
    offset: 0,
    protocolId: PROTO,
    plane: 'durable',
    phase: 'data',
    requestFactory: async () => REQUEST_BYTES,
    send: async () => RESPONSE_BYTES,
    onRetry: () => {},
    ...overrides,
  };
}

describe('W1 I1–I3 — per-attempt accounting through the real sendSyncRequest', () => {
  it('A2/M1: three physical sends produce three attempt points, not one per call', async () => {
    harness.install();
    let sends = 0;
    await sendSyncRequest(attemptParams({
      retryAttempts: 3,
      send: async () => {
        sends += 1;
        if (sends < 3) throw new Error('stream reset');
        return RESPONSE_BYTES;
      },
    }));

    expect(sends).toBe(3);
    // Recording once per CALL (M1) yields 1; recording once per SEND yields 3.
    expect(await harness.total(I1)).toBe(3);
    expect((await harness.matching(I1, { outcome: 'transport_error' }))
      .reduce((sum, point) => sum + point.value, 0)).toBe(2);
    expect((await harness.matching(I1, { outcome: 'response' }))
      .reduce((sum, point) => sum + point.value, 0)).toBe(1);
    // Every send paid for its request bytes; only the one that came back has a response.
    expect(await harness.total(I2)).toBe(3 * REQUEST_BYTES.byteLength);
    expect(await harness.total(I3)).toBe(RESPONSE_BYTES.byteLength);
  }, 20_000);

  it('A3/M2: an attempt that receives NO response still counts its request bytes', async () => {
    harness.install();
    await expect(sendSyncRequest(attemptParams({
      send: async () => { throw new Error('all multiaddr dials failed'); },
    }))).rejects.toThrow(/multiaddr/);

    // M2 ("request bytes only on success") makes this zero.
    expect(await harness.total(I2)).toBe(REQUEST_BYTES.byteLength);
    expect(await harness.total(I1)).toBe(1);
    expect(await harness.matching(I1, { outcome: 'transport_error' })).toHaveLength(1);
    // I3 exists only when the send RESOLVED.
    expect(await harness.counter(I3)).toEqual([]);
  });

  it('A14/M3: a rejected response is validation_rejected, and its bytes are still counted', async () => {
    harness.install();
    await expect(sendSyncRequest(attemptParams({
      validateResponse: () => { throw new Error('Legacy sync responder busy at peer for "cg-1" (data)'); },
    }))).rejects.toThrow(/Legacy sync responder busy/);

    const attempts = await harness.matching(I1, { outcome: 'validation_rejected' });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.value).toBe(1);
    // M3 classifies the same attempt as `response`; asserting the exact label
    // AND the absence of `response` kills it from both sides.
    expect(await harness.matching(I1, { outcome: 'response' })).toEqual([]);

    const responseBytes = await harness.matching(I3, { outcome: 'validation_rejected' });
    expect(responseBytes).toHaveLength(1);
    expect(responseBytes[0]!.value).toBe(RESPONSE_BYTES.byteLength);
  });

  it('does not replace the validator\'s error, so downstream classifiers still see it', async () => {
    harness.install();
    // `isSyncBackoffWorthyError` matches this message; a minted replacement
    // would silently change peer backoff and failedPhases accounting.
    const message = 'Legacy sync responder busy at peer for "cg-1" (data)';
    const original = new Error(message);
    await expect(sendSyncRequest(attemptParams({
      validateResponse: () => { throw original; },
    }))).rejects.toBe(original);
    expect(original.message).toBe(message);
  });

  it('A19: a requestFactory failure mints ZERO I1/I2/I3 points', async () => {
    harness.install();
    let sends = 0;
    await expect(sendSyncRequest(attemptParams({
      requestFactory: async () => { throw new Error('signing key unavailable'); },
      send: async () => { sends += 1; return RESPONSE_BYTES; },
    }))).rejects.toThrow(/signing key/);

    expect(sends).toBe(0);
    // A closure-level `finally` would report this signing failure as a network attempt.
    expect(await harness.counter(I1)).toEqual([]);
    expect(await harness.counter(I2)).toEqual([]);
    expect(await harness.counter(I3)).toEqual([]);
  });

  it('an abort BEFORE the factory mints zero points; an abort during the send is `cancelled`', async () => {
    harness.install();
    const preAborted = AbortSignal.abort(new Error('caller gave up'));
    await expect(sendSyncRequest(attemptParams({ signal: preAborted })))
      .rejects.toBeTruthy();
    expect(await harness.counter(I1)).toEqual([]);

    const controller = new AbortController();
    await expect(sendSyncRequest(attemptParams({
      signal: controller.signal,
      send: async () => {
        controller.abort(new Error('caller gave up'));
        throw new Error('peer-closed-stream');
      },
    }))).rejects.toBeTruthy();

    expect(await harness.matching(I1, { outcome: 'cancelled' })).toHaveLength(1);
    // Request bytes were already committed before the send was invoked.
    expect(await harness.total(I2)).toBe(REQUEST_BYTES.byteLength);
    expect(await harness.counter(I3)).toEqual([]);
  });

  it('cancellation requested AFTER receipt is still a delivered `response`', async () => {
    harness.install();
    const controller = new AbortController();
    await expect(sendSyncRequest(attemptParams({
      signal: controller.signal,
      send: async () => {
        // The bytes crossed the wire; only then does the caller give up.
        controller.abort(new Error('caller gave up'));
        return RESPONSE_BYTES;
      },
    }))).rejects.toBeTruthy();

    expect(await harness.matching(I1, { outcome: 'response' })).toHaveLength(1);
    expect(await harness.matching(I1, { outcome: 'cancelled' })).toEqual([]);
    expect(await harness.total(I3)).toBe(RESPONSE_BYTES.byteLength);
  });

  it('A7: attempt points carry only the bounded label set — no CG id, no peer id', async () => {
    harness.install();
    await sendSyncRequest(attemptParams());

    expect(await harness.attributeKeys(I1)).toEqual(['outcome', 'phase', 'plane', 'source', 'transport']);
    expect(await harness.attributeKeys(I2)).toEqual(['phase', 'plane', 'source', 'transport']);
    expect(await harness.attributeKeys(I3)).toEqual(['outcome', 'phase', 'plane', 'source', 'transport']);

    const points = await harness.counter(I1);
    const values = points.flatMap((point) => Object.values(point.attributes).map(String));
    expect(values.some((value) => value.includes('cg-1'))).toBe(false);
    expect(values.some((value) => value.includes('remote-peer'))).toBe(false);
  });

  it('labels the attempt with the ambient admission source, and `unspecified` without one', async () => {
    harness.install();
    await withSyncAdmissionSource('catchup-foreground', () => sendSyncRequest(attemptParams()));
    await sendSyncRequest(attemptParams({ phase: 'meta' }));

    expect(await harness.matching(I1, { source: 'catchup-foreground', phase: 'data' })).toHaveLength(1);
    expect(await harness.matching(I1, { source: 'unspecified', phase: 'meta' })).toHaveLength(1);
  });

  it('propagates the ambient source across awaits and restores it afterwards', async () => {
    expect(activeSyncAdmissionSource()).toBe('unspecified');
    await withSyncAdmissionSource('reconcile', async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 1));
      expect(activeSyncAdmissionSource()).toBe('reconcile');
    });
    expect(activeSyncAdmissionSource()).toBe('unspecified');
  });
});

describe('W1 A11 — closed vocabularies clamp, and instrumentation never throws', () => {
  it('clamps every unknown label to `unspecified` instead of widening or throwing', () => {
    expect(normalizeSyncAttemptTransport('quic')).toBe('unspecified');
    expect(normalizeSyncAttemptTransport(undefined)).toBe('unspecified');
    expect(normalizeSyncAttemptTransport('changelog')).toBe('changelog');
    expect(normalizeSyncAttemptPlane('private')).toBe('unspecified');
    expect(normalizeSyncAttemptPlane('shared-memory')).toBe('shared-memory');
    expect(normalizeSyncAttemptPhase('delta')).toBe('delta');
    // `timeout` is deliberately NOT in the outcome vocabulary — no causal
    // deadline predicate exists, so it must clamp rather than be accepted.
    expect(normalizeSyncAttemptOutcome('timeout')).toBe('unspecified');
    expect(normalizeSyncAttemptOutcome('validation_rejected')).toBe('validation_rejected');
    // Responder and pre-authorization lanes are not logical sync operations.
    expect(normalizeSyncOperationLane('responder')).toBe('unspecified');
    expect(normalizeSyncOperationLane('pre_authorization')).toBe('unspecified');
    expect(normalizeSyncOperationLane('swm_recovery')).toBe('swm_recovery');
    expect(normalizeSyncOperationOutcome('success')).toBe('unspecified');
    expect(normalizeSyncOperationOutcome('resolved')).toBe('resolved');
    expect(normalizeSyncOperationRejectionReason('rejected')).toBe('unspecified');
    expect(normalizeSyncSingleFlightScope('cg')).toBe('unspecified');
    expect(normalizeSyncSingleFlightScope('context-graph')).toBe('context-graph');
  });

  it('clamps an out-of-set source that reached the attribute builder through a cast', () => {
    const attributes = syncAttemptAttributes({
      transport: 'legacy',
      plane: 'durable',
      phase: 'data',
      source: 'catchup-urgent' as never,
    });
    expect(attributes.source).toBe('unspecified');
  });

  it('maps the plane boolean both ways', () => {
    expect(syncPlaneFor(false)).toBe('durable');
    expect(syncPlaneFor(true)).toBe('shared-memory');
  });

  it('derives the I5 reason from the admission error TYPE, through the cause chain', () => {
    expect(syncOperationRejectionReason(new SyncBackpressureBusyError('full'))).toBe('queue_full');
    expect(syncOperationRejectionReason(new SyncBackpressureBusyError('bumped', 'displaced'))).toBe('displaced');
    expect(syncOperationRejectionReason(
      new Error('wrapped', { cause: new SyncBackpressureBusyError('full') }),
    )).toBe('queue_full');
    // A message that merely LOOKS like backpressure is not backpressure.
    expect(syncOperationRejectionReason(new Error('Sync backpressure rejected durable:cg')))
      .toBe('aborted_before_start');
    expect(syncOperationRejectionReason(undefined)).toBe('aborted_before_start');
  });

  it('swallows a throwing meter at every record site, and the send still succeeds', async () => {
    harness.install();
    const exploding = { add() { throw new Error('meter exploded'); }, record() { throw new Error('meter exploded'); } };
    const instruments = getMetrics() as unknown as Record<string, unknown>;
    for (const name of [
      'syncAttemptTotal', 'syncAttemptRequestBytes', 'syncAttemptResponseBytes',
      'syncOperationDurationMs', 'syncOperationRejectedTotal', 'syncSingleflightJoinsTotal',
    ]) {
      instruments[name] = exploding;
    }

    const attributes = syncAttemptAttributes({ transport: 'legacy', plane: 'durable', phase: 'data' });
    expect(() => recordSyncAttempt(attributes, 'response')).not.toThrow();
    expect(() => recordSyncAttemptRequestBytes(attributes, 10)).not.toThrow();
    expect(() => recordSyncAttemptResponseBytes(attributes, 10, 'response')).not.toThrow();
    expect(() => recordSyncOperationDuration({
      lane: 'durable', source: 'reconcile', outcome: 'resolved', durationMs: 5,
    })).not.toThrow();
    expect(() => recordSyncOperationRejected({
      lane: 'durable', source: 'reconcile', reason: 'queue_full',
    })).not.toThrow();
    expect(() => recordSyncSingleFlightJoin({
      scope: 'page', ownerSource: 'on-connect', joinerSource: 'reconcile',
    })).not.toThrow();

    // The hot path itself must be unaffected.
    const result = await sendSyncRequest(attemptParams());
    expect(Array.from(result)).toEqual(Array.from(RESPONSE_BYTES));
  });

  it('A10/M9: the catch-up buckets resolve the longest observed job, not +Inf', async () => {
    harness.install();
    // §6.1 gave I9 its own `CATCHUP_DURATION_BUCKETS` because `OP_DURATION_BUCKETS`
    // stops at 120 s while observed foreground catch-up jobs ran 305 s and 382 s —
    // both would land in the `+Inf` overflow and become unresolvable.
    //
    // Nothing asserted that until now. The only 305 s sample in the repo is in
    // node-ui's attribute-allow-list test, which reads attribute KEYS only, so it
    // passes identically whether the sample resolves or overflows — and reusing
    // `OP_DURATION_BUCKETS` here survived every suite in the repo.
    const OBSERVED_CATCHUP_JOB_MS = [305_000, 382_000];
    for (const ms of OBSERVED_CATCHUP_JOB_MS) {
      getMetrics().contextGraphCatchupJobDurationMs.record(ms, { admission: 'walk' });
    }

    const [point] = await harness.buckets(I9);
    expect(point).toBeDefined();
    // Precondition, not decoration: an empty histogram would satisfy the overflow
    // assertion below for the wrong reason.
    expect(point!.counts.reduce((sum, n) => sum + n, 0)).toBe(OBSERVED_CATCHUP_JOB_MS.length);

    // Asserted against the TOP FINITE BOUNDARY, never a bucket index: a legitimate
    // retune of the boundary list must keep passing, and only a list that stops
    // too low may fail.
    const { boundaries, counts } = point!;
    expect(boundaries[boundaries.length - 1]!).toBeGreaterThanOrEqual(Math.max(...OBSERVED_CATCHUP_JOB_MS));
    // `counts` carries one entry more than `boundaries` — the trailing `+Inf`
    // overflow. Every observed job must be resolvable, so it must be empty.
    expect(counts[counts.length - 1]!).toBe(0);
  });

  it('drops non-finite byte counts rather than poisoning a counter', async () => {
    harness.install();
    const attributes = syncAttemptAttributes({ transport: 'legacy', plane: 'durable', phase: 'data' });
    recordSyncAttemptRequestBytes(attributes, Number.NaN);
    recordSyncAttemptResponseBytes(attributes, -1, 'response');
    recordSyncOperationDuration({ lane: 'durable', source: 'reconcile', outcome: 'resolved', durationMs: Number.NaN });
    expect(await harness.counter(I2)).toEqual([]);
    expect(await harness.counter(I3)).toEqual([]);
  });
});
