import {
  SYSTEM_RECORD_MAX_FRAME_BYTES,
  SYSTEM_RECORD_MAX_FRAME_PAYLOAD_BYTES,
  SYSTEM_RECORD_DIGEST_DOMAINS_V1,
  decodeSystemRecordResponseFrameV1,
  digestSystemRecordBytesV1,
  encodeSystemRecordRequestFrameV1,
  type SystemRecordRequestHeaderV1,
} from '@origintrail-official/dkg-core/system-record-v1';
import { describe, expect, it, vi } from 'vitest';

import {
  createSystemRecordProviderV1,
  type SystemRecordProviderArtifactV1,
  type SystemRecordProviderExchangeV1,
  type SystemRecordProviderRepositoryV1,
} from '../src/system-records/provider-v1.js';
import {
  createSystemRecordProviderTokenBucketV1,
  type SystemRecordProviderFrameAdmissionV1,
} from '../src/system-records/transport-v1.js';

const NETWORK = 'base:84532' as const;
const PAYLOAD = Uint8Array.of(1, 2, 3);
const DIGEST = digestSystemRecordBytesV1(
  SYSTEM_RECORD_DIGEST_DOMAINS_V1.profileBundle,
  PAYLOAD,
);

describe('system-record provider V1', () => {
  it('serves one exact object under a full-frame reservation and releases every resource', async () => {
    const admission = frameAdmission();
    const artifact = Object.freeze({
      objectKind: 'profile-bundle' as const,
      objectDigest: DIGEST,
      canonicalBytes: PAYLOAD,
    });
    const provider = createSystemRecordProviderV1({
      networkId: NETWORK,
      repository: repository(artifact),
      frameAdmission: admission,
    });
    const exchange = fixtureExchange(bundleRequest());
    await expect(provider.serve(exchange.value)).resolves.toBe('served');
    const response = decodeSystemRecordResponseFrameV1(exchange.written[0]!);
    expect(response.header).toMatchObject({ status: 'ok', objectDigest: DIGEST });
    expect(response.payload).toEqual(PAYLOAD);
    expect(admission.active()).toBe(0);
    expect(admission.reservations[0]?.requested).toBe(SYSTEM_RECORD_MAX_FRAME_BYTES);
    expect(admission.reservations[0]?.shrunk).toBe(exchange.written[0]!.byteLength);
    expect(provider.stats()).toMatchObject({ served: 1, active: 0, peakActive: 1, queued: 0 });
  });

  it('does not queue a second stream behind the one provider permit', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const resolveStarted = Promise.withResolvers<void>();
    const repo: SystemRecordProviderRepositoryV1 = {
      async resolve() {
        resolveStarted.resolve();
        await blocked;
        return null;
      },
    };
    const provider = createSystemRecordProviderV1({
      networkId: NETWORK,
      repository: repo,
      frameAdmission: frameAdmission(),
    });
    const firstExchange = fixtureExchange(bundleRequest());
    const first = provider.serve(firstExchange.value);
    await resolveStarted.promise;
    const secondExchange = fixtureExchange(bundleRequest('2'.repeat(32)));
    await expect(provider.serve(secondExchange.value)).resolves.toBe('reset-busy');
    expect(secondExchange.reset).toHaveBeenCalledWith('busy');
    release();
    await expect(first).resolves.toBe('served');
    expect(provider.stats().queued).toBe(0);
  });

  it('bounds slow headers, response-rate exhaustion, malformed frames, and close', async () => {
    const provider = createSystemRecordProviderV1({
      networkId: NETWORK,
      repository: repository(null),
      frameAdmission: frameAdmission(),
      timeoutMs: 10,
      tokenBucket: createSystemRecordProviderTokenBucketV1({
        requestCapacity: 8,
        requestRefillPerMinute: 1,
        responseCapacity: 1,
        responseRefillPerMinute: 1,
      }),
    });
    const slow = fixtureExchange(bundleRequest(), () => new Promise<Uint8Array>(() => {}));
    await expect(provider.serve(slow.value)).resolves.toBe('reset-deadline');
    expect(slow.reset).toHaveBeenCalledWith('deadline');

    const malformed = fixtureExchange(bundleRequest(), async () => Uint8Array.of(0));
    await expect(provider.serve(malformed.value)).resolves.toBe('reset-invalid-frame');

    const rateLimited = fixtureExchange(bundleRequest('3'.repeat(32)));
    await expect(provider.serve(rateLimited.value)).resolves.toBe('reset-response-rate');
    provider.close();
    const closed = fixtureExchange(bundleRequest('4'.repeat(32)));
    await expect(provider.serve(closed.value)).resolves.toBe('reset-closed');
    expect(provider.stats().active).toBe(0);
  });

  it('charges request tokens at entry and never creates rate-limit waiters', async () => {
    const bucket = createSystemRecordProviderTokenBucketV1({
      requestCapacity: 1,
      requestRefillPerMinute: 0.000001,
      responseCapacity: 1024,
      responseRefillPerMinute: 1,
    });
    const provider = createSystemRecordProviderV1({
      networkId: NETWORK,
      repository: repository(null),
      frameAdmission: frameAdmission(),
      tokenBucket: bucket,
    });
    await expect(provider.serve(fixtureExchange(bundleRequest()).value)).resolves.toBe('served');
    const second = fixtureExchange(bundleRequest('5'.repeat(32)));
    await expect(provider.serve(second.value)).resolves.toBe('reset-request-rate');
    expect(second.reset).toHaveBeenCalledWith('request-rate');
    expect(provider.stats().queued).toBe(0);
  });

  it('refuses a corrupted cache object instead of serving bytes under its requested digest', async () => {
    const corruptedBytes = Uint8Array.of(9, 9, 9);
    expect(digestSystemRecordBytesV1(
      SYSTEM_RECORD_DIGEST_DOMAINS_V1.profileBundle,
      corruptedBytes,
    )).not.toBe(DIGEST);
    const provider = createSystemRecordProviderV1({
      networkId: NETWORK,
      repository: repository({
        objectKind: 'profile-bundle',
        objectDigest: DIGEST,
        canonicalBytes: corruptedBytes,
      }),
      frameAdmission: frameAdmission(),
    });
    const exchange = fixtureExchange(bundleRequest());
    await expect(provider.serve(exchange.value)).resolves.toBe('served');
    const response = decodeSystemRecordResponseFrameV1(exchange.written[0]!);
    expect(response.header.status).toBe('internal');
    expect(response.payload).toHaveLength(0);
  });

  it('refunds response bytes and frame admission when shutdown aborts a blocked write', async () => {
    const admission = frameAdmission();
    const bucket = createSystemRecordProviderTokenBucketV1({
      requestCapacity: 2,
      requestRefillPerMinute: 1,
      responseCapacity: 1024,
      responseRefillPerMinute: 1,
    });
    const provider = createSystemRecordProviderV1({
      networkId: NETWORK,
      repository: repository({
        objectKind: 'profile-bundle',
        objectDigest: DIGEST,
        canonicalBytes: PAYLOAD,
      }),
      frameAdmission: admission,
      tokenBucket: bucket,
    });
    const writeStarted = Promise.withResolvers<void>();
    const exchange = fixtureExchange(bundleRequest());
    exchange.value.writeResponseFrame = async (_frame, signal) => {
      writeStarted.resolve();
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    };
    const before = bucket.snapshot().responseTokens;
    const active = provider.serve(exchange.value);
    await writeStarted.promise;
    provider.close();

    await expect(active).resolves.toBe('reset-closed');
    expect(exchange.reset).toHaveBeenCalledWith('closed');
    expect(bucket.snapshot().responseTokens).toBe(before);
    expect(admission.active()).toBe(0);
    expect(provider.stats()).toMatchObject({ active: 0, queued: 0 });
  });

  it('refills only on requests and charges the exact encoded response bytes', async () => {
    let now = 0;
    const bucket = createSystemRecordProviderTokenBucketV1({
      now: () => now,
      requestCapacity: 2,
      requestRefillPerMinute: 60,
      responseCapacity: 1024,
      responseRefillPerMinute: 120,
    });
    expect(bucket.tryTakeRequest()).toBe(true);
    expect(bucket.tryTakeRequest()).toBe(true);
    expect(bucket.tryTakeRequest()).toBe(false);
    now = 1_000;
    expect(bucket.tryTakeRequest()).toBe(true);

    const chargedBucket = createSystemRecordProviderTokenBucketV1({
      now: () => 0,
      requestCapacity: 1,
      requestRefillPerMinute: 1,
      responseCapacity: 1024,
      responseRefillPerMinute: 1,
    });
    const exactProvider = createSystemRecordProviderV1({
      networkId: NETWORK,
      repository: repository({
        objectKind: 'profile-bundle', objectDigest: DIGEST, canonicalBytes: PAYLOAD,
      }),
      frameAdmission: frameAdmission(),
      tokenBucket: chargedBucket,
    });
    const exactExchange = fixtureExchange(bundleRequest('6'.repeat(32)));
    const responseBefore = chargedBucket.snapshot().responseTokens;
    await expect(exactProvider.serve(exactExchange.value)).resolves.toBe('served');
    expect(chargedBucket.snapshot().responseTokens)
      .toBe(responseBefore - exactExchange.written[0]!.byteLength);
  });

  it('serves the maximum legal bundle in one bounded frame and rejects relaxed limits', async () => {
    const payload = new Uint8Array(SYSTEM_RECORD_MAX_FRAME_PAYLOAD_BYTES);
    const digest = digestSystemRecordBytesV1(
      SYSTEM_RECORD_DIGEST_DOMAINS_V1.profileBundle,
      payload,
    );
    const admission = frameAdmission();
    const provider = createSystemRecordProviderV1({
      networkId: NETWORK,
      repository: repository({
        objectKind: 'profile-bundle', objectDigest: digest, canonicalBytes: payload,
      }),
      frameAdmission: admission,
    });
    const exchange = fixtureExchange({ ...bundleRequest('7'.repeat(32)), objectDigest: digest });
    await expect(provider.serve(exchange.value)).resolves.toBe('served');
    expect(exchange.written[0]!.byteLength).toBeLessThanOrEqual(SYSTEM_RECORD_MAX_FRAME_BYTES);
    expect(admission.reservations[0]?.requested).toBe(SYSTEM_RECORD_MAX_FRAME_BYTES);
    expect(admission.active()).toBe(0);

    expect(() => createSystemRecordProviderTokenBucketV1({ requestCapacity: 33 }))
      .toThrow(/frozen V1 limit/);
    expect(() => createSystemRecordProviderTokenBucketV1({
      responseCapacity: 4 * SYSTEM_RECORD_MAX_FRAME_BYTES + 1,
    })).toThrow(/frozen V1 limit/);
  });
});

function repository(
  artifact: SystemRecordProviderArtifactV1 | null,
): SystemRecordProviderRepositoryV1 {
  return { resolve: async () => artifact };
}

function bundleRequest(requestId = '1'.repeat(32)): SystemRecordRequestHeaderV1 {
  return {
    wireVersion: '1', requestId, kind: 'agents', networkId: NETWORK,
    operation: 'get-bundle', objectKind: 'profile-bundle', objectDigest: DIGEST,
    payloadBytes: '0',
  };
}

function fixtureExchange(
  request: SystemRecordRequestHeaderV1,
  read = async () => encodeSystemRecordRequestFrameV1(request),
) {
  const written: Uint8Array[] = [];
  const reset = vi.fn();
  const value: SystemRecordProviderExchangeV1 = {
    readRequestFrame: read,
    writeResponseFrame: async (frame) => { written.push(Uint8Array.from(frame)); },
    reset,
  };
  return { value, written, reset };
}

function frameAdmission(): SystemRecordProviderFrameAdmissionV1 & {
  active(): number;
  reservations: Array<{ requested: number; shrunk?: number }>;
} {
  let active = 0;
  const reservations: Array<{ requested: number; shrunk?: number }> = [];
  return {
    reservations,
    active: () => active,
    tryReserve(bytes) {
      active += 1;
      const observation = { requested: bytes, shrunk: undefined as number | undefined };
      reservations.push(observation);
      let released = false;
      return {
        shrinkTo(next) { observation.shrunk = next; },
        release() {
          if (released) return;
          released = true;
          active -= 1;
        },
      };
    },
  };
}
