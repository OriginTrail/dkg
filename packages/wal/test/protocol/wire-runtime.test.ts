import { describe, expect, it, vi } from 'vitest';
import {
  decodeWalResponseFrame,
  decodeWalRequestFrame,
  encodeWalErrorFrame,
  encodeLengthPrefixedFrame,
  encodeWalRequestFrame,
  negotiateWalCapabilitiesV1,
  protocolTupleId,
  WalWireError,
  WalWireProtocolClient,
  WalWireProtocolServer,
  walWireMethod,
  WAL_WIRE_ERROR_CODE,
  WAL_WIRE_PROTOCOL_IDS,
  type CborProtocolValue,
  type ProtocolTuple,
  type WalRawProtocolRouter,
  type WalWireFamily,
  type WalWireProtocolService,
} from '../../src/protocol/index.js';
import {
  authorized,
  CAPABILITIES,
  checkpoint,
  COLLECTION,
  context,
  fill,
  methodFixtures,
  NOW_MS,
  peer,
  PROVIDER_PEER,
  REQUESTER_PEER,
  requestId,
  service,
  SIGNATURE,
  vector,
  WRITER,
} from './wire-fixtures.js';

function responseError(
  family: WalWireFamily,
  requestType: number,
  id: Uint8Array,
  bytes: Uint8Array,
): ProtocolTuple<'ErrorV1'> {
  const decoded = decodeWalResponseFrame(family, requestType, id, bytes);
  expect(decoded.ok).toBe(false);
  return (decoded as Extract<typeof decoded, { ok: false }>).error;
}

function requestBytes(
  family: WalWireFamily,
  requestType: number,
  id: Uint8Array,
  body: readonly CborProtocolValue[],
  requestContext = context(),
): Uint8Array {
  return encodeWalRequestFrame(family, requestType, id, requestContext, body);
}

describe('WalWireProtocolServer method dispatch and registration', () => {
  it('registers and unregisters exactly the three raw ProtocolRouter families with hard read bounds', async () => {
    const registrations: Array<[string, unknown, unknown]> = [];
    const unregistered: string[] = [];
    const router = {
      register: (...args: [string, unknown, unknown]) => registrations.push(args),
      unregister: (protocolId: string) => unregistered.push(protocolId),
    } as unknown as WalRawProtocolRouter;
    const server = new WalWireProtocolServer({ localPeerId: PROVIDER_PEER, service: service(), authorize: authorized, now: () => NOW_MS });
    const unregister = server.register(router);
    expect(registrations.map(entry => entry[0])).toEqual(Object.values(WAL_WIRE_PROTOCOL_IDS));
    expect(registrations.map(entry => entry[2])).toEqual(Array.from({ length: 3 }, () => ({
      maxReadBytes: 1_048_584,
      readTimeoutMs: 20_000,
    })));
    const handler = registrations[0][1] as (data: Uint8Array, remote: ReturnType<typeof peer>, options?: { signal?: AbortSignal }) => Promise<Uint8Array>;
    const id = requestId(99);
    expect(decodeWalResponseFrame('control', 0, id, await handler(requestBytes('control', 0, id, []), peer())).ok).toBe(true);
    unregister();
    expect(unregistered).toEqual(Object.values(WAL_WIRE_PROTOCOL_IDS));
  });

  it.each(methodFixtures().map((fixture, index) => ({ ...fixture, index })))('dispatches and binds $family method $requestType', async fixture => {
    const server = new WalWireProtocolServer({ localPeerId: PROVIDER_PEER, service: service(), authorize: authorized, now: () => NOW_MS });
    const id = requestId(fixture.index + 1);
    const response = await server.handle(fixture.family, requestBytes(fixture.family, fixture.requestType, id, fixture.body), peer());
    const decoded = decodeWalResponseFrame(fixture.family, fixture.requestType, id, response);
    expect(decoded).toEqual({
      ok: true,
      requestId: id,
      messageType: walWireMethod(fixture.family, fixture.requestType)!.responseType,
      body: fixture.response,
    });
  });

  it('maps provider failures to bounded stable errors without serializing exception text', async () => {
    const failing = service({ getCapabilities: async () => { throw new Error('secret database location'); } });
    const server = new WalWireProtocolServer({ localPeerId: PROVIDER_PEER, service: failing, authorize: authorized, now: () => NOW_MS });
    const id = requestId(1);
    const response = await server.handle('control', requestBytes('control', 0, id, []), peer());
    expect(responseError('control', 0, id, response)).toEqual([6n, null, null]);
    expect(Buffer.from(response).toString()).not.toContain('secret database');
  });
});

describe('authorization before private metadata disclosure', () => {
  it('returns one denial tuple for stale, misbound, replayed, malformed-body, callback-error, and explicit-deny requests', async () => {
    const lookup = vi.fn(async () => checkpoint());
    const baseService = service({ getHead: lookup });
    const deny = new WalWireProtocolServer({ localPeerId: PROVIDER_PEER, service: baseService, authorize: () => false, now: () => NOW_MS });
    const throwing = new WalWireProtocolServer({ localPeerId: PROVIDER_PEER, service: baseService, authorize: () => { throw new Error('policy backend'); }, now: () => NOW_MS });
    const allow = new WalWireProtocolServer({ localPeerId: PROVIDER_PEER, service: baseService, authorize: authorized, now: () => NOW_MS });
    const cases: Array<Promise<Uint8Array>> = [];

    cases.push(deny.handle('control', requestBytes('control', 2, requestId(1), [WRITER, 7n]), peer()));
    cases.push(throwing.handle('control', requestBytes('control', 2, requestId(2), [WRITER, 7n]), peer()));
    cases.push(allow.handle('control', requestBytes('control', 2, requestId(3), [WRITER, 7n], context(NOW_MS - 90_001)), peer()));
    cases.push(allow.handle('control', requestBytes('control', 2, requestId(4), [WRITER, 7n], context(NOW_MS, REQUESTER_PEER, fill(38, 9))), peer()));

    const malformedAuthenticatedBody = encodeLengthPrefixedFrame([
      1n,
      2n,
      requestId(5),
      [context(), []],
    ]);
    cases.push(deny.handle('control', malformedAuthenticatedBody, peer()));

    const replayId = requestId(6);
    const replayBytes = requestBytes('control', 0, replayId, []);
    await allow.handle('control', replayBytes, peer());
    cases.push(allow.handle('control', replayBytes, peer()));

    const results = await Promise.all(cases);
    for (const [index, response] of results.entries()) {
      const id = requestId(index + 1);
      expect(responseError('control', index === 5 ? 0 : 2, id, response)).toEqual([1n, null, null]);
    }
    expect(lookup).not.toHaveBeenCalled();
  });

  it('checks identity and private-view structural bindings before the authority callback', async () => {
    const authorize = vi.fn(() => true);
    const server = new WalWireProtocolServer({ localPeerId: PROVIDER_PEER, service: service(), authorize, now: () => NOW_MS });
    const agent = fill(20, 3);
    const validIdentity: ProtocolTuple<'IdentityProofV1'> = [agent, REQUESTER_PEER, BigInt(NOW_MS - 1), BigInt(NOW_MS + 1), fill(16, 4), SIGNATURE];
    const validPrivate: ProtocolTuple<'PrivateViewProofV1'> = [fill(32, 5), agent, REQUESTER_PEER, null];
    const contexts: ProtocolTuple<'RequestContextV1'>[] = [
      [BigInt(Number.MAX_SAFE_INTEGER) + 1n, REQUESTER_PEER, PROVIDER_PEER, fill(32, 1), null, null, null],
      [BigInt(NOW_MS + 5_001), REQUESTER_PEER, PROVIDER_PEER, fill(32, 1), null, null, null],
      [BigInt(NOW_MS), fill(38, 9), PROVIDER_PEER, fill(32, 1), null, null, null],
      [BigInt(NOW_MS), REQUESTER_PEER, PROVIDER_PEER, fill(32, 1), agent, null, validPrivate],
      [BigInt(NOW_MS), REQUESTER_PEER, PROVIDER_PEER, fill(32, 1), null, validIdentity, validPrivate],
      [BigInt(NOW_MS), REQUESTER_PEER, PROVIDER_PEER, fill(32, 1), agent, [fill(20, 8), REQUESTER_PEER, BigInt(NOW_MS - 1), BigInt(NOW_MS + 1), fill(16, 4), SIGNATURE], validPrivate],
      [BigInt(NOW_MS), REQUESTER_PEER, PROVIDER_PEER, fill(32, 1), agent, [agent, fill(38, 8), BigInt(NOW_MS - 1), BigInt(NOW_MS + 1), fill(16, 4), SIGNATURE], validPrivate],
      [BigInt(NOW_MS), REQUESTER_PEER, PROVIDER_PEER, fill(32, 1), agent, [agent, REQUESTER_PEER, BigInt(NOW_MS + 6_000), BigInt(NOW_MS + 10_000), fill(16, 4), SIGNATURE], validPrivate],
      [BigInt(NOW_MS), REQUESTER_PEER, PROVIDER_PEER, fill(32, 1), agent, [agent, REQUESTER_PEER, BigInt(NOW_MS - 10_000), BigInt(NOW_MS - 6_000), fill(16, 4), SIGNATURE], validPrivate],
      [BigInt(NOW_MS), REQUESTER_PEER, PROVIDER_PEER, fill(32, 1), null, null, [fill(32, 5), agent, REQUESTER_PEER, null]],
      [BigInt(NOW_MS), REQUESTER_PEER, PROVIDER_PEER, fill(32, 1), agent, validIdentity, [fill(32, 5), fill(20, 8), REQUESTER_PEER, null]],
      [BigInt(NOW_MS), REQUESTER_PEER, PROVIDER_PEER, fill(32, 1), agent, validIdentity, [fill(32, 5), agent, fill(38, 8), null]],
      [BigInt(NOW_MS), REQUESTER_PEER, PROVIDER_PEER, fill(32, 1), agent, [agent, REQUESTER_PEER, BigInt(NOW_MS + 10), BigInt(NOW_MS + 5), fill(16, 4), SIGNATURE], validPrivate],
      [BigInt(NOW_MS), REQUESTER_PEER, PROVIDER_PEER, fill(32, 1), agent, validIdentity, [fill(32, 5), agent, REQUESTER_PEER, [fill(32, 7), fill(20, 8), REQUESTER_PEER, BigInt(NOW_MS - 1), BigInt(NOW_MS + 1), fill(16, 8), SIGNATURE]]],
      [BigInt(NOW_MS), REQUESTER_PEER, PROVIDER_PEER, fill(32, 1), agent, validIdentity, [fill(32, 5), agent, REQUESTER_PEER, [fill(32, 7), agent, fill(38, 8), BigInt(NOW_MS - 1), BigInt(NOW_MS + 1), fill(16, 8), SIGNATURE]]],
      [BigInt(NOW_MS), REQUESTER_PEER, PROVIDER_PEER, fill(32, 1), agent, validIdentity, [fill(32, 5), agent, REQUESTER_PEER, [fill(32, 7), agent, REQUESTER_PEER, BigInt(NOW_MS - 10_000), BigInt(NOW_MS - 6_000), fill(16, 8), SIGNATURE]]],
    ];
    for (let index = 0; index < contexts.length; index += 1) {
      const id = requestId(index + 1);
      const response = await server.handle('control', requestBytes('control', 0, id, [], contexts[index]), peer());
      expect(responseError('control', 0, id, response)).toEqual([1n, null, null]);
    }
    expect(authorize).not.toHaveBeenCalled();

    const noDelegationContext: ProtocolTuple<'RequestContextV1'> = [BigInt(NOW_MS), REQUESTER_PEER, PROVIDER_PEER, fill(32, 1), agent, validIdentity, validPrivate];
    const noDelegationId = requestId(29);
    const noDelegationResponse = await server.handle('control', requestBytes('control', 0, noDelegationId, [], noDelegationContext), peer());
    expect(decodeWalResponseFrame('control', 0, noDelegationId, noDelegationResponse).ok).toBe(true);

    const delegation: ProtocolTuple<'PeerDelegationV1'> = [fill(32, 7), agent, REQUESTER_PEER, BigInt(NOW_MS - 1), BigInt(NOW_MS + 1), fill(16, 8), SIGNATURE];
    const validContext: ProtocolTuple<'RequestContextV1'> = [BigInt(NOW_MS), REQUESTER_PEER, PROVIDER_PEER, fill(32, 1), agent, validIdentity, [fill(32, 5), agent, REQUESTER_PEER, delegation]];
    const id = requestId(9);
    const response = await server.handle('control', requestBytes('control', 0, id, [], validContext), peer());
    expect(decodeWalResponseFrame('control', 0, id, response).ok).toBe(true);
    expect(authorize).toHaveBeenCalledTimes(2);
  });
});

describe('response proof and range binding', () => {
  it.each([
    ['capability protocols', service({ getCapabilities: async () => [[], [1n], 1n, 1n, 1n, 1n, 1n, 1n] }), 'control', 0, [], WAL_WIRE_ERROR_CODE.INVALID_PROOF],
    ['capability adapters', service({ getCapabilities: async () => [[1n], [], 1n, 1n, 1n, 1n, 1n, 1n] }), 'control', 0, [], WAL_WIRE_ERROR_CODE.INVALID_PROOF],
    ['capability v1', service({ getCapabilities: async () => [[2n], [1n], 1n, 1n, 1n, 1n, 1n, 1n] }), 'control', 0, [], WAL_WIRE_ERROR_CODE.INVALID_PROOF],
    ['capability zero limit', service({ getCapabilities: async () => [[1n], [1n], 0n, 1n, 1n, 1n, 1n, 1n] }), 'control', 0, [], WAL_WIRE_ERROR_CODE.INVALID_PROOF],
    ['head namespace', service({ getHead: async () => checkpoint(fill(32, 9)) }), 'control', 2, [WRITER, 7n], WAL_WIRE_ERROR_CODE.INVALID_PROOF],
    ['head writer', service({ getHead: async () => checkpoint(undefined, fill(20, 9)) }), 'control', 2, [WRITER, 7n], WAL_WIRE_ERROR_CODE.INVALID_PROOF],
    ['head epoch', service({ getHead: async () => checkpoint(undefined, undefined, 8n) }), 'control', 2, [WRITER, 7n], WAL_WIRE_ERROR_CODE.INVALID_PROOF],
    ['vector collection', service({ getVector: async () => vector(fill(32, 9)) }), 'control', 4, [COLLECTION], WAL_WIRE_ERROR_CODE.INVALID_PROOF],
    ['symbol head', service({ getReconciliationSymbols: async (_request, body) => [fill(32, 9), body[1], body[2], [[body[2], 0n, fill(32, 0), fill(32, 0)]]] }), 'reconcile', 0, [fill(32, 1), fill(32, 2), 0n, 1n], WAL_WIRE_ERROR_CODE.INVALID_PROOF],
    ['symbol seed', service({ getReconciliationSymbols: async (_request, body) => [body[0], fill(32, 9), body[2], [[body[2], 0n, fill(32, 0), fill(32, 0)]]] }), 'reconcile', 0, [fill(32, 1), fill(32, 2), 0n, 1n], WAL_WIRE_ERROR_CODE.INVALID_PROOF],
    ['symbol offset', service({ getReconciliationSymbols: async (_request, body) => [body[0], body[1], body[2] + 1n, [[body[2], 0n, fill(32, 0), fill(32, 0)]]] }), 'reconcile', 0, [fill(32, 1), fill(32, 2), 0n, 1n], WAL_WIRE_ERROR_CODE.INVALID_PROOF],
    ['symbol window', service({ getReconciliationSymbols: async (_request, body) => [body[0], body[1], body[2], []] }), 'reconcile', 0, [fill(32, 1), fill(32, 2), 0n, 1n], WAL_WIRE_ERROR_CODE.INVALID_PROOF],
    ['symbol contiguity', service({ getReconciliationSymbols: async (_request, body) => [body[0], body[1], body[2], [[body[2] + 1n, 0n, fill(32, 0), fill(32, 0)]]] }), 'reconcile', 0, [fill(32, 1), fill(32, 2), 0n, 1n], WAL_WIRE_ERROR_CODE.INVALID_PROOF],
    ['ID page head', service({ getObjectIds: async (_request, body) => [fill(32, 9), body[1], [], null, true] }), 'reconcile', 2, [fill(32, 1), null, 1n], WAL_WIRE_ERROR_CODE.INVALID_PROOF],
    ['ID page cursor binding', service({ getObjectIds: async (_request, body) => [body[0], fill(32, 9), [], null, true] }), 'reconcile', 2, [fill(32, 1), null, 1n], WAL_WIRE_ERROR_CODE.INVALID_PROOF],
    ['ID page count', service({ getObjectIds: async (_request, body) => [body[0], body[1], [fill(32, 1), fill(32, 2)], null, true] }), 'reconcile', 2, [fill(32, 1), null, 1n], WAL_WIRE_ERROR_CODE.INVALID_PROOF],
    ['ID page advance', service({ getObjectIds: async (_request, body) => [body[0], body[1], [fill(32, 1)], null, true] }), 'reconcile', 2, [fill(32, 1), fill(32, 2), 1n], WAL_WIRE_ERROR_CODE.INVALID_PROOF],
    ['ID page final cursor', service({ getObjectIds: async (_request, body) => [body[0], body[1], [fill(32, 3)], fill(32, 3), true] }), 'reconcile', 2, [fill(32, 1), null, 1n], WAL_WIRE_ERROR_CODE.INVALID_PROOF],
    ['ID page cursor', service({ getObjectIds: async (_request, body) => [body[0], body[1], [], fill(32, 1), false] }), 'reconcile', 2, [fill(32, 1), null, 1n], WAL_WIRE_ERROR_CODE.INVALID_PROOF],
    ['ID page next mismatch', service({ getObjectIds: async (_request, body) => [body[0], body[1], [fill(32, 3)], fill(32, 4), false] }), 'reconcile', 2, [fill(32, 1), null, 1n], WAL_WIRE_ERROR_CODE.INVALID_PROOF],
    ['range ID', service({ getObjectRange: async (_request, body) => [fill(32, 9), 3n, body[1], Uint8Array.of(1)] }), 'object', 0, [fill(32, 1), 0n, 3n], WAL_WIRE_ERROR_CODE.INVALID_RANGE],
    ['range offset', service({ getObjectRange: async (_request, body) => [body[0], 3n, body[1] + 1n, Uint8Array.of(1)] }), 'object', 0, [fill(32, 1), 0n, 3n], WAL_WIRE_ERROR_CODE.INVALID_RANGE],
    ['range cap', service({ getObjectRange: async (_request, body) => [body[0], 8_589_934_593n, body[1], Uint8Array.of(1)] }), 'object', 0, [fill(32, 1), 0n, 3n], WAL_WIRE_ERROR_CODE.INVALID_RANGE],
    ['range requested length', service({ getObjectRange: async (_request, body) => [body[0], 4n, body[1], Uint8Array.of(1, 2, 3, 4)] }), 'object', 0, [fill(32, 1), 0n, 3n], WAL_WIRE_ERROR_CODE.INVALID_RANGE],
    ['range offset past total', service({ getObjectRange: async (_request, body) => [body[0], 0n, body[1] + 1n, new Uint8Array()] }), 'object', 0, [fill(32, 1), 0n, 3n], WAL_WIRE_ERROR_CODE.INVALID_RANGE],
    ['range bound offset past total', service({ getObjectRange: async (_request, body) => [body[0], 0n, body[1], new Uint8Array()] }), 'object', 0, [fill(32, 1), 1n, 3n], WAL_WIRE_ERROR_CODE.INVALID_RANGE],
    ['range length', service({ getObjectRange: async (_request, body) => [body[0], 2n, body[1], Uint8Array.of(1, 2, 3)] }), 'object', 0, [fill(32, 1), 0n, 3n], WAL_WIRE_ERROR_CODE.INVALID_RANGE],
    ['range empty before EOF', service({ getObjectRange: async (_request, body) => [body[0], 3n, body[1], new Uint8Array()] }), 'object', 0, [fill(32, 1), 0n, 3n], WAL_WIRE_ERROR_CODE.INVALID_RANGE],
  ] as const)('rejects dishonest %s responses', async (_name, badService, family, requestType, body, errorCode) => {
    const server = new WalWireProtocolServer({ localPeerId: PROVIDER_PEER, service: badService, authorize: authorized, now: () => NOW_MS });
    const id = requestId(requestType + 1);
    const response = await server.handle(family, requestBytes(family, requestType, id, body), peer());
    expect(responseError(family, requestType, id, response)[0]).toBe(BigInt(errorCode));
  });

  it('rejects a checkpoint whose signed identity differs from the requested ID', async () => {
    const server = new WalWireProtocolServer({ localPeerId: PROVIDER_PEER, service: service(), authorize: authorized, now: () => NOW_MS });
    const id = requestId(1);
    const response = await server.handle('control', requestBytes('control', 6, id, [fill(32, 9)]), peer());
    expect(responseError('control', 6, id, response)[0]).toBe(8n);
  });

  it('accepts nullable head epochs, advancing nonfinal ID cursors, and the empty EOF range sentinel', async () => {
    const headServer = new WalWireProtocolServer({ localPeerId: PROVIDER_PEER, service: service(), authorize: authorized, now: () => NOW_MS });
    const headId = requestId(1);
    expect(decodeWalResponseFrame('control', 2, headId, await headServer.handle('control', requestBytes('control', 2, headId, [WRITER, null]), peer())).ok).toBe(true);

    const cursor = fill(32, 2);
    const next = fill(32, 3);
    const pageServer = new WalWireProtocolServer({
      localPeerId: PROVIDER_PEER,
      authorize: authorized,
      now: () => NOW_MS,
      service: service({ getObjectIds: async (_request, body) => [body[0], body[1], [next], next, false] }),
    });
    const pageId = requestId(2);
    expect(decodeWalResponseFrame('reconcile', 2, pageId, await pageServer.handle('reconcile', requestBytes('reconcile', 2, pageId, [fill(32, 1), cursor, 1n]), peer())).ok).toBe(true);

    const rangeServer = new WalWireProtocolServer({
      localPeerId: PROVIDER_PEER,
      authorize: authorized,
      now: () => NOW_MS,
      service: service({ getObjectRange: async (_request, body) => [body[0], body[1], body[1], new Uint8Array()] }),
    });
    const rangeId = requestId(3);
    expect(decodeWalResponseFrame('object', 0, rangeId, await rangeServer.handle('object', requestBytes('object', 0, rangeId, [fill(32, 1), 3n, 1n]), peer())).ok).toBe(true);
  });
});

describe('cancellation, deadlines, and bounded queues', () => {
  it('cancels a queued reconciliation request and rejects queue overflow', async () => {
    const pending = new Map<number, (value: ProtocolTuple<'ReconciliationSymbolsV1'>) => void>();
    let calls = 0;
    const blocking = service({
      getReconciliationSymbols: async (_request, body, signal) => new Promise((resolve, reject) => {
        calls += 1;
        pending.set(calls, resolve);
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
    });
    const server = new WalWireProtocolServer({
      localPeerId: PROVIDER_PEER,
      service: blocking,
      authorize: authorized,
      now: () => NOW_MS,
      limits: { maximumConcurrentReconciliationStreamsPerPeer: 1, maximumQueuedRequestsPerKey: 1 },
    });
    const head = fill(32, 1);
    const seed = fill(32, 2);
    const firstId = requestId(1);
    const queuedId = requestId(2);
    const first = server.handle('reconcile', requestBytes('reconcile', 0, firstId, [head, seed, 0n, 1n]), peer());
    await vi.waitFor(() => expect(calls).toBe(1));
    const queued = server.handle('reconcile', requestBytes('reconcile', 0, queuedId, [head, seed, 0n, 1n]), peer());
    await Promise.resolve();
    const overflowId = requestId(3);
    const overflow = await server.handle('reconcile', requestBytes('reconcile', 0, overflowId, [head, seed, 0n, 1n]), peer());
    expect(responseError('reconcile', 0, overflowId, overflow)[0]).toBe(4n);

    const cancelId = requestId(4);
    const cancel = await server.handle('reconcile', requestBytes('reconcile', 10, cancelId, [queuedId]), peer());
    expect(decodeWalResponseFrame('reconcile', 10, cancelId, cancel).ok).toBe(true);
    expect(responseError('reconcile', 0, queuedId, await queued)[0]).toBe(5n);

    pending.get(1)!([head, seed, 0n, [[0n, 0n, fill(32, 0), fill(32, 0)]]]);
    expect(decodeWalResponseFrame('reconcile', 0, firstId, await first).ok).toBe(true);
  });

  it('bounds ignored work by deadline and transport cancellation', async () => {
    const blocking = service({
      getCapabilities: async (_request, signal) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
    });
    const server = new WalWireProtocolServer({ localPeerId: PROVIDER_PEER, service: blocking, authorize: authorized, now: () => NOW_MS, limits: { requestHandlerTimeoutMs: 5 } });
    const timeoutId = requestId(1);
    const timedOut = await server.handle('control', requestBytes('control', 0, timeoutId, []), peer());
    expect(responseError('control', 0, timeoutId, timedOut)).toEqual([5n, null, 7n]);

    const abortServer = new WalWireProtocolServer({ localPeerId: PROVIDER_PEER, service: blocking, authorize: authorized, now: () => NOW_MS });
    const controller = new AbortController();
    const abortId = requestId(2);
    const responsePromise = abortServer.handle('control', requestBytes('control', 0, abortId, []), peer(), controller.signal);
    controller.abort();
    expect(responseError('control', 0, abortId, await responsePromise)[0]).toBe(5n);

    const ignored = new WalWireProtocolServer({
      localPeerId: PROVIDER_PEER,
      service: service({ getCapabilities: async () => new Promise(resolve => setTimeout(() => resolve(CAPABILITIES), 10)) }),
      authorize: authorized,
      now: () => NOW_MS,
      limits: { requestHandlerTimeoutMs: 5 },
    });
    const ignoredId = requestId(3);
    expect(responseError('control', 0, ignoredId, await ignored.handle('control', requestBytes('control', 0, ignoredId, []), peer()))[0]).toBe(5n);

    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    const preId = requestId(4);
    expect(responseError('control', 0, preId, await abortServer.handle('control', requestBytes('control', 0, preId, []), peer(), alreadyAborted.signal))[0]).toBe(5n);
  });

  it('runs queued work after a slot releases and retains remaining active counts', async () => {
    const resolvers: Array<(value: ProtocolTuple<'ReconciliationSymbolsV1'>) => void> = [];
    const head = fill(32, 1);
    const seed = fill(32, 2);
    const getReconciliationSymbols = vi.fn(async () => new Promise<ProtocolTuple<'ReconciliationSymbolsV1'>>(resolve => resolvers.push(resolve)));
    const queuedServer = new WalWireProtocolServer({
      localPeerId: PROVIDER_PEER,
      service: service({ getReconciliationSymbols }),
      authorize: authorized,
      now: () => NOW_MS,
      limits: { maximumConcurrentReconciliationStreamsPerPeer: 1, maximumQueuedRequestsPerKey: 3 },
    });
    const firstId = requestId(10);
    const secondId = requestId(11);
    const thirdId = requestId(14);
    const fourthId = requestId(15);
    const first = queuedServer.handle('reconcile', requestBytes('reconcile', 0, firstId, [head, seed, 0n, 1n]), peer());
    await vi.waitFor(() => expect(resolvers).toHaveLength(1));
    const second = queuedServer.handle('reconcile', requestBytes('reconcile', 0, secondId, [head, seed, 0n, 1n]), peer());
    const third = queuedServer.handle('reconcile', requestBytes('reconcile', 0, thirdId, [head, seed, 0n, 1n]), peer());
    const fourth = queuedServer.handle('reconcile', requestBytes('reconcile', 0, fourthId, [head, seed, 0n, 1n]), peer());
    await Promise.resolve();
    const cancelId = requestId(16);
    expect(decodeWalResponseFrame('reconcile', 10, cancelId, await queuedServer.handle('reconcile', requestBytes('reconcile', 10, cancelId, [secondId]), peer())).ok).toBe(true);
    expect(responseError('reconcile', 0, secondId, await second)[0]).toBe(5n);
    resolvers[0]([head, seed, 0n, [[0n, 0n, fill(32, 0), fill(32, 0)]]]);
    await vi.waitFor(() => expect(resolvers).toHaveLength(2));
    resolvers[1]([head, seed, 0n, [[0n, 0n, fill(32, 0), fill(32, 0)]]]);
    await vi.waitFor(() => expect(resolvers).toHaveLength(3));
    resolvers[2]([head, seed, 0n, [[0n, 0n, fill(32, 0), fill(32, 0)]]]);
    expect(decodeWalResponseFrame('reconcile', 0, firstId, await first).ok).toBe(true);
    expect(decodeWalResponseFrame('reconcile', 0, thirdId, await third).ok).toBe(true);
    expect(decodeWalResponseFrame('reconcile', 0, fourthId, await fourth).ok).toBe(true);

    const activeResolvers: Array<(value: ProtocolTuple<'ReconciliationSymbolsV1'>) => void> = [];
    const activeServer = new WalWireProtocolServer({
      localPeerId: PROVIDER_PEER,
      service: service({ getReconciliationSymbols: async () => new Promise(resolve => activeResolvers.push(resolve)) }),
      authorize: authorized,
      now: () => NOW_MS,
      limits: { maximumConcurrentReconciliationStreamsPerPeer: 2 },
    });
    const activeIdA = requestId(12);
    const activeIdB = requestId(13);
    const activeA = activeServer.handle('reconcile', requestBytes('reconcile', 0, activeIdA, [head, seed, 0n, 1n]), peer());
    const activeB = activeServer.handle('reconcile', requestBytes('reconcile', 0, activeIdB, [head, seed, 0n, 1n]), peer());
    await vi.waitFor(() => expect(activeResolvers).toHaveLength(2));
    activeResolvers[0]([head, seed, 0n, [[0n, 0n, fill(32, 0), fill(32, 0)]]]);
    expect(decodeWalResponseFrame('reconcile', 0, activeIdA, await activeA).ok).toBe(true);
    activeResolvers[1]([head, seed, 0n, [[0n, 0n, fill(32, 0), fill(32, 0)]]]);
    expect(decodeWalResponseFrame('reconcile', 0, activeIdB, await activeB).ok).toBe(true);
  });

  it('rejects a CANCEL request that targets itself', async () => {
    const server = new WalWireProtocolServer({ localPeerId: PROVIDER_PEER, service: service(), authorize: authorized, now: () => NOW_MS });
    const id = requestId(20);
    const response = await server.handle('control', requestBytes('control', 10, id, [id]), peer());
    expect(responseError('control', 10, id, response)[0]).toBe(7n);
  });

  it('rejects global/per-peer outstanding saturation before another provider call', async () => {
    let release!: (value: ProtocolTuple<'CapabilitiesV1'>) => void;
    const getCapabilities = vi.fn(async () => new Promise<ProtocolTuple<'CapabilitiesV1'>>(resolve => { release = resolve; }));
    const authorize = vi.fn(authorized);
    const server = new WalWireProtocolServer({
      localPeerId: PROVIDER_PEER,
      service: service({ getCapabilities }),
      authorize,
      now: () => NOW_MS,
      limits: { maximumOutstandingRequestsPerPeer: 1, maximumOutstandingRequestsGlobal: 1 },
    });
    const firstId = requestId(1);
    const first = server.handle('control', requestBytes('control', 0, firstId, []), peer());
    await vi.waitFor(() => expect(getCapabilities).toHaveBeenCalledOnce());
    const secondId = requestId(2);
    const second = await server.handle('control', requestBytes('control', 0, secondId, []), peer());
    expect(responseError('control', 0, secondId, second)[0]).toBe(4n);
    expect(authorize).toHaveBeenCalledOnce();
    release(CAPABILITIES);
    expect(decodeWalResponseFrame('control', 0, firstId, await first).ok).toBe(true);
  });
});

describe('WalWireProtocolClient and negotiation', () => {
  it('uses exact raw protocol IDs and single-use payloads, then verifies the response', async () => {
    const server = new WalWireProtocolServer({ localPeerId: PROVIDER_PEER, service: service(), authorize: authorized, now: () => NOW_MS });
    const calls: unknown[][] = [];
    const router = {
      register() {},
      unregister() {},
      async send(...args: [string, string, Uint8Array, { payloadReuse?: string }]) {
        calls.push(args);
        const family = Object.entries(WAL_WIRE_PROTOCOL_IDS).find(([, id]) => id === args[1])![0] as WalWireFamily;
        return server.handle(family, args[2], peer());
      },
    } as unknown as WalRawProtocolRouter;
    let sequence = 6;
    const client = new WalWireProtocolClient({ router, localPeerId: REQUESTER_PEER, randomRequestId: () => requestId(++sequence) });
    await expect(client.request('provider-peer', 'control', 0, context(), [])).resolves.toEqual(CAPABILITIES);
    await expect(client.request('provider-peer', 'control', 0, context(), [], { timeoutMs: 123 })).resolves.toEqual(CAPABILITIES);
    expect(calls[0][1]).toBe(WAL_WIRE_PROTOCOL_IDS.control);
    expect(calls[0][3]).toMatchObject({ payloadReuse: 'single-use' });
    expect(calls[1][3]).toMatchObject({ timeoutMs: 123 });

    const randomClient = new WalWireProtocolClient({ router, localPeerId: REQUESTER_PEER });
    await expect(randomClient.request('provider-peer', 'control', 0, context(), [])).resolves.toEqual(CAPABILITIES);
  });

  it('rejects local identity mismatch, malformed random IDs, and provider errors', async () => {
    const errorRouter = {
      register() {}, unregister() {},
      async send() { throw new WalWireError(6, 'transport'); },
    } as unknown as WalRawProtocolRouter;
    const client = new WalWireProtocolClient({ router: errorRouter, localPeerId: REQUESTER_PEER, randomRequestId: () => requestId(1) });
    await expect(client.request('p', 'control', 0, context(NOW_MS, fill(38, 9)), [])).rejects.toMatchObject({ code: 1 });
    const malformed = new WalWireProtocolClient({ router: errorRouter, localPeerId: REQUESTER_PEER, randomRequestId: () => new Uint8Array(15) });
    await expect(malformed.request('p', 'control', 0, context(), [])).rejects.toThrow(/16 bytes/);
    await expect(client.request('p', 'control', 0, context(), [])).rejects.toMatchObject({ code: 6 });

    const responseErrorRouter = {
      register() {}, unregister() {},
      async send(_peerId: string, _protocol: string, request: Uint8Array) {
        const decoded = decodeWalRequestFrame('control', request);
        return encodeWalErrorFrame(decoded.requestId, [4n, 50n, 8n]);
      },
    } as unknown as WalRawProtocolRouter;
    const responseErrorClient = new WalWireProtocolClient({ router: responseErrorRouter, localPeerId: REQUESTER_PEER, randomRequestId: () => requestId(2) });
    await expect(responseErrorClient.request('p', 'control', 0, context(), [])).rejects.toMatchObject({ code: 4, detailCode: 8, retryAfterMs: 50n });

    const nullDetailRouter = {
      register() {}, unregister() {},
      async send(_peerId: string, _protocol: string, request: Uint8Array) {
        const decoded = decodeWalRequestFrame('control', request);
        return encodeWalErrorFrame(decoded.requestId, [6n, null, null]);
      },
    } as unknown as WalRawProtocolRouter;
    const nullDetailClient = new WalWireProtocolClient({ router: nullDetailRouter, localPeerId: REQUESTER_PEER, randomRequestId: () => requestId(3) });
    await expect(nullDetailClient.request('p', 'control', 0, context(), [])).rejects.toMatchObject({ code: 6, detailCode: null });
  });

  it('rejects invalid identities and every out-of-profile local limit before registration', () => {
    expect(() => new WalWireProtocolServer({ localPeerId: new Uint8Array(), service: service(), authorize: authorized })).toThrow(/localPeerId/);
    expect(() => new WalWireProtocolServer({ localPeerId: 'peer' as never, service: service(), authorize: authorized })).toThrow(/localPeerId/);
    expect(() => new WalWireProtocolClient({ router: {} as WalRawProtocolRouter, localPeerId: new Uint8Array() })).toThrow(/localPeerId/);
    expect(() => new WalWireProtocolClient({ router: {} as WalRawProtocolRouter, localPeerId: 'peer' as never })).toThrow(/localPeerId/);
    expect(() => new WalWireProtocolServer({ localPeerId: PROVIDER_PEER, service: service(), authorize: authorized })).not.toThrow();

    const invalidLimits = [
      { maximumFrameBytes: Number.NaN },
      { maximumFrameBytes: 0 },
      { maximumFrameBytes: 1_048_577 },
      { maximumFrameBytes: 127 },
      { maximumWalObjectBytes: 0n },
      { maximumWalObjectBytes: 8_589_934_593n },
      { maximumReplayEntriesPerPeer: 16_385 },
      { maximumReplayEntriesGlobal: 131_073 },
    ];
    for (const limits of invalidLimits) {
      expect(() => new WalWireProtocolServer({ localPeerId: PROVIDER_PEER, service: service(), authorize: authorized, limits })).toThrow();
    }
  });

  it('negotiates minima and never downgrades private requests', () => {
    const remote: ProtocolTuple<'CapabilitiesV1'> = [[1n], [1n, 2n], 500_000n, 2_000n, 3_000n, 400_000n, 900_000_000n, 8n];
    expect(negotiateWalCapabilitiesV1(CAPABILITIES, remote)).toEqual({
      protocolVersion: 1n,
      adapterVersion: 1n,
      maximumControlFrameBytes: 500_000n,
      maximumSymbolsPerResponse: 2_000n,
      maximumFallbackIdsPerPage: 3_000n,
      maximumObjectRangeBytes: 400_000n,
      maximumWalObjectBytes: 900_000_000n,
      maximumConcurrentRanges: 8n,
    });
    const noV1: ProtocolTuple<'CapabilitiesV1'> = [[2n], [1n], 1n, 1n, 1n, 1n, 1n, 1n];
    expect(() => negotiateWalCapabilitiesV1(CAPABILITIES, noV1, true)).toThrow(/cannot downgrade/);
    expect(() => negotiateWalCapabilitiesV1(CAPABILITIES, noV1)).toThrow(/no common/);
    const noAdapter: ProtocolTuple<'CapabilitiesV1'> = [[1n], [2n], 1n, 1n, 1n, 1n, 1n, 1n];
    expect(() => negotiateWalCapabilitiesV1(CAPABILITIES, noAdapter)).toThrow(/adapter/);
    const larger: ProtocolTuple<'CapabilitiesV1'> = [[1n], [1n], 2_000_000n, 5_000n, 5_000n, 2_000_000n, 2_000_000_000n, 32n];
    expect(negotiateWalCapabilitiesV1(CAPABILITIES, larger).maximumControlFrameBytes).toBe(CAPABILITIES[2]);
  });
});
