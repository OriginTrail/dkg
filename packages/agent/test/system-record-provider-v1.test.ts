import {
  SYSTEM_RECORD_MAX_FRAME_BYTES,
  SYSTEM_RECORD_MAX_FRAME_PAYLOAD_BYTES,
  SYSTEM_RECORD_DIGEST_DOMAINS_V1,
  buildSystemRecordInventoryTreeV1,
  canonicalizeSignedSystemRecordRootDescriptorEnvelopeV1,
  decodeSystemRecordResponseFrameV1,
  digestSystemRecordBytesV1,
  encodeSystemRecordRequestFrameV1,
  type SystemRecordRequestHeaderV1,
} from '@origintrail-official/dkg-core/system-record-v1';
import { describe, expect, it, vi } from 'vitest';

import {
  type SystemRecordArtifactLookupV1,
  type SystemRecordArtifactRepositoryV1,
  type SystemRecordArtifactV1,
} from '../src/system-records/artifact-v1.js';
import {
  createSystemRecordProviderV1,
  type SystemRecordProviderExchangeV1,
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
    const expectedLookup = Object.freeze({
      type: 'object' as const,
      objectKind: 'profile-bundle' as const,
      objectDigest: DIGEST,
    });
    const exact = exactRepository(expectedLookup, artifact);
    const provider = createSystemRecordProviderV1({
      networkId: NETWORK,
      repository: exact.repository,
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
    expect(exact.resolve).toHaveBeenCalledWith(expectedLookup, expect.any(AbortSignal));
  });

  it('routes an exact control-object request to its repository lookup', async () => {
    const payload = new TextEncoder().encode('[]');
    const digest = digestSystemRecordBytesV1(
      SYSTEM_RECORD_DIGEST_DOMAINS_V1.ownedSubjectTable,
      payload,
    );
    const artifact = Object.freeze({
      objectKind: 'owned-subject-table' as const,
      objectDigest: digest,
      canonicalBytes: payload,
    });
    const expectedLookup = Object.freeze({
      type: 'object' as const,
      objectKind: artifact.objectKind,
      objectDigest: digest,
    });
    const exact = exactRepository(expectedLookup, artifact);
    const provider = createSystemRecordProviderV1({
      networkId: NETWORK,
      repository: exact.repository,
      frameAdmission: frameAdmission(),
    });
    const exchange = fixtureExchange(controlRequest(digest));

    await expect(provider.serve(exchange.value)).resolves.toBe('served');
    const response = decodeSystemRecordResponseFrameV1(exchange.written[0]!);
    expect(response.header).toMatchObject({
      status: 'ok',
      objectKind: artifact.objectKind,
      objectDigest: digest,
    });
    expect(response.payload).toEqual(payload);
    expect(exact.resolve).toHaveBeenCalledWith(expectedLookup, expect.any(AbortSignal));
  });

  it('does not queue a second stream behind the one provider permit', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const resolveStarted = Promise.withResolvers<void>();
    const repo: SystemRecordArtifactRepositoryV1 = {
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

  it('resets before repository lookup when success-frame admission is exhausted', async () => {
    const resolve = vi.fn(async () => null);
    const tryReserve = vi.fn(() => null);
    const provider = createSystemRecordProviderV1({
      networkId: NETWORK,
      repository: { resolve },
      frameAdmission: { tryReserve },
    });
    const exchange = fixtureExchange(bundleRequest());

    await expect(provider.serve(exchange.value)).resolves.toBe('reset-memory-capacity');
    expect(exchange.reset).toHaveBeenCalledWith('memory-capacity');
    expect(tryReserve).toHaveBeenCalledWith(SYSTEM_RECORD_MAX_FRAME_BYTES);
    expect(resolve).not.toHaveBeenCalled();
    expect(provider.stats()).toMatchObject({ active: 0, queued: 0 });
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

  it('returns unsupported without resolving local objects for another network', async () => {
    const resolve = vi.fn(async () => null);
    const provider = createSystemRecordProviderV1({
      networkId: NETWORK,
      repository: { resolve },
      frameAdmission: frameAdmission(),
    });
    const exchange = fixtureExchange({
      ...bundleRequest(),
      networkId: 'base:1',
    });

    await expect(provider.serve(exchange.value)).resolves.toBe('served');
    const response = decodeSystemRecordResponseFrameV1(exchange.written[0]!);
    expect(response.header.status).toBe('unsupported');
    expect(response.payload).toHaveLength(0);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('resets a schema-invalid canonical request before admission or repository lookup', async () => {
    const headerBytes = new TextEncoder().encode(
      `{"kind":"agents","networkId":"${NETWORK}","operation":"bogus",`
      + `"payloadBytes":"0","requestId":"${'a'.repeat(32)}","wireVersion":"1"}`,
    );
    const requestFrame = new Uint8Array(4 + headerBytes.byteLength);
    new DataView(requestFrame.buffer).setUint32(0, headerBytes.byteLength, false);
    requestFrame.set(headerBytes, 4);
    const resolve = vi.fn(async () => null);
    const tryReserve = vi.fn(frameAdmission().tryReserve);
    const provider = createSystemRecordProviderV1({
      networkId: NETWORK,
      repository: { resolve },
      frameAdmission: { tryReserve },
    });
    const exchange = fixtureExchange(bundleRequest(), async () => requestFrame);

    await expect(provider.serve(exchange.value)).resolves.toBe('reset-invalid-frame');
    expect(exchange.reset).toHaveBeenCalledWith('invalid-frame');
    expect(tryReserve).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
    expect(provider.stats()).toMatchObject({ active: 0, queued: 0 });
  });

  it('returns an empty not-found response for a missing object', async () => {
    const provider = createSystemRecordProviderV1({
      networkId: NETWORK,
      repository: repository(null),
      frameAdmission: frameAdmission(),
    });
    const exchange = fixtureExchange(bundleRequest());

    await expect(provider.serve(exchange.value)).resolves.toBe('served');
    const response = decodeSystemRecordResponseFrameV1(exchange.written[0]!);
    expect(response.header).toMatchObject({
      status: 'not-found',
      errorCode: 'not_found',
      payloadBytes: '0',
    });
    expect(response.payload).toHaveLength(0);
    expect(provider.stats()).toMatchObject({ served: 1, active: 0, queued: 0 });
  });

  it('returns an internal response and releases resources when repository lookup fails', async () => {
    const admission = frameAdmission();
    const provider = createSystemRecordProviderV1({
      networkId: NETWORK,
      repository: { resolve: async () => { throw new Error('backend failed'); } },
      frameAdmission: admission,
    });
    const exchange = fixtureExchange(bundleRequest());

    await expect(provider.serve(exchange.value)).resolves.toBe('served');
    const response = decodeSystemRecordResponseFrameV1(exchange.written[0]!);
    expect(response.header.status).toBe('internal');
    expect(response.payload).toHaveLength(0);
    expect(admission.active()).toBe(0);
    expect(provider.stats()).toMatchObject({ served: 1, active: 0, queued: 0 });
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

  it('refuses a root descriptor for another network', async () => {
    const foreignInventory = buildSystemRecordInventoryTreeV1('base:1', []);
    const foreignRootEnvelope = Object.freeze({
      object: foreignInventory.descriptor,
      objectDigest: foreignInventory.descriptorDigest,
      providerPeerId: '12D3KooWJ1TsijH7H5F74hfAD5XishQz3sxrmAtVY37GtNd9CqYf',
      signatureSuite: 'ed25519-v1' as const,
      signature: Buffer.alloc(64).toString('base64url'),
    });
    const admission = frameAdmission();
    const provider = createSystemRecordProviderV1({
      networkId: NETWORK,
      repository: repository({
        objectKind: 'root-descriptor',
        objectDigest: foreignInventory.descriptorDigest,
        canonicalBytes: canonicalizeSignedSystemRecordRootDescriptorEnvelopeV1(
          foreignRootEnvelope,
        ),
      }),
      frameAdmission: admission,
    });
    const exchange = fixtureExchange(rootRequest('b'.repeat(32)));

    await expect(provider.serve(exchange.value)).resolves.toBe('served');
    const response = decodeSystemRecordResponseFrameV1(exchange.written[0]!);
    expect(response.header).toMatchObject({ status: 'internal', payloadBytes: '0' });
    expect(response.payload).toHaveLength(0);
    expect(admission.active()).toBe(0);
    expect(provider.stats()).toMatchObject({ served: 1, active: 0, queued: 0 });
  });

  it('serves the root descriptor and its requested inventory object', async () => {
    const inventory = buildSystemRecordInventoryTreeV1(NETWORK, []);
    const rootEnvelope = Object.freeze({
      object: inventory.descriptor,
      objectDigest: inventory.descriptorDigest,
      providerPeerId: '12D3KooWJ1TsijH7H5F74hfAD5XishQz3sxrmAtVY37GtNd9CqYf',
      signatureSuite: 'ed25519-v1' as const,
      signature: Buffer.alloc(64).toString('base64url'),
    });
    const rootBytes = canonicalizeSignedSystemRecordRootDescriptorEnvelopeV1(rootEnvelope);
    const inventoryObject = inventory.objects.get(inventory.descriptor.treeRootDigest)!;
    const admission = frameAdmission();
    const lookups: SystemRecordArtifactLookupV1[] = [];
    const provider = createSystemRecordProviderV1({
      networkId: NETWORK,
      repository: {
        resolve: async (lookup) => {
          lookups.push(lookup);
          return lookup.type === 'root' ? {
              objectKind: 'root-descriptor',
              objectDigest: inventory.descriptorDigest,
              canonicalBytes: rootBytes,
            }
            : {
              objectKind: inventoryObject.objectKind,
              objectDigest: inventory.descriptor.treeRootDigest,
              canonicalBytes: inventoryObject.canonicalBytes,
            };
        },
      },
      frameAdmission: admission,
    });

    const rootExchange = fixtureExchange(rootRequest('8'.repeat(32)));
    await expect(provider.serve(rootExchange.value)).resolves.toBe('served');
    const rootResponse = decodeSystemRecordResponseFrameV1(rootExchange.written[0]!);
    expect(rootResponse.header).toMatchObject({
      status: 'ok',
      objectKind: 'root-descriptor',
      objectDigest: inventory.descriptorDigest,
    });
    expect(rootResponse.payload).toEqual(rootBytes);

    const inventoryExchange = fixtureExchange({
      wireVersion: '1',
      requestId: '9'.repeat(32),
      kind: 'agents',
      networkId: NETWORK,
      operation: 'get-inventory-object',
      rootDescriptorDigest: inventory.descriptorDigest,
      path: [],
      objectKind: inventoryObject.objectKind,
      objectDigest: inventory.descriptor.treeRootDigest,
      payloadBytes: '0',
    });
    await expect(provider.serve(inventoryExchange.value)).resolves.toBe('served');
    const inventoryResponse = decodeSystemRecordResponseFrameV1(inventoryExchange.written[0]!);
    expect(inventoryResponse.header).toMatchObject({
      status: 'ok',
      objectKind: inventoryObject.objectKind,
      objectDigest: inventory.descriptor.treeRootDigest,
    });
    expect(inventoryResponse.payload).toEqual(inventoryObject.canonicalBytes);
    expect(admission.active()).toBe(0);
    expect(lookups).toEqual([
      { type: 'root' },
      {
        type: 'inventory-object',
        path: [],
        objectKind: inventoryObject.objectKind,
        objectDigest: inventory.descriptor.treeRootDigest,
        rootDescriptorDigest: inventory.descriptorDigest,
      },
    ]);
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

  it('reports an ordinary response write failure and refunds all admission', async () => {
    const admission = frameAdmission();
    const bucket = createSystemRecordProviderTokenBucketV1({
      requestCapacity: 1,
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
    const exchange = fixtureExchange(bundleRequest());
    exchange.value.writeResponseFrame = async () => {
      throw new Error('socket write failed');
    };
    const before = bucket.snapshot().responseTokens;

    await expect(provider.serve(exchange.value)).resolves.toBe('reset-write-failed');
    expect(exchange.reset).toHaveBeenCalledWith('write-failed');
    expect(bucket.snapshot().responseTokens).toBe(before);
    expect(admission.active()).toBe(0);
    expect(provider.stats()).toMatchObject({
      active: 0,
      queued: 0,
      resets: { 'write-failed': 1 },
    });
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
  artifact: SystemRecordArtifactV1 | null,
): SystemRecordArtifactRepositoryV1 {
  return { resolve: async () => artifact };
}

function exactRepository(
  expectedLookup: SystemRecordArtifactLookupV1,
  artifact: SystemRecordArtifactV1,
) {
  const resolve = vi.fn(async (lookup: SystemRecordArtifactLookupV1) => {
    expect(lookup).toEqual(expectedLookup);
    return artifact;
  });
  return {
    repository: { resolve } satisfies SystemRecordArtifactRepositoryV1,
    resolve,
  };
}

function bundleRequest(requestId = '1'.repeat(32)): SystemRecordRequestHeaderV1 {
  return {
    wireVersion: '1', requestId, kind: 'agents', networkId: NETWORK,
    operation: 'get-bundle', objectKind: 'profile-bundle', objectDigest: DIGEST,
    payloadBytes: '0',
  };
}

function rootRequest(requestId: string): SystemRecordRequestHeaderV1 {
  return {
    wireVersion: '1', requestId, kind: 'agents', networkId: NETWORK,
    operation: 'get-root', payloadBytes: '0',
  };
}

function controlRequest(
  objectDigest: typeof DIGEST,
  requestId = 'a'.repeat(32),
): SystemRecordRequestHeaderV1 {
  return {
    wireVersion: '1', requestId, kind: 'agents', networkId: NETWORK,
    operation: 'get-control-object', objectKind: 'owned-subject-table', objectDigest,
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
