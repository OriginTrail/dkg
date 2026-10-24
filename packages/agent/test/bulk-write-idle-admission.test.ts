import { expect, it, vi } from 'vitest';
import { BULK_GRAPH_KIND as K, encodeBulkGraphFrame, type ProtocolRouter } from '@origintrail-official/dkg-core';
import { BlazegraphStore } from '@origintrail-official/dkg-storage';
import { registerSyncHandler, type ExperimentalExactBatchResponderResources } from '../src/sync/responder/sync-handler.js';
import { registerPublicBulkGraph } from '../src/sync/responder/bulk-graph-stream.js';
import type { PublicAssetResponderOptions } from '../src/sync/responder/public-asset-responder.js';

it('aborts a non-reading peer and releases its real shared admission and export lease', async () => {
  vi.useFakeTimers();
  const store = new BlazegraphStore('http://fixture.invalid/sparql');
  let resources!: ExperimentalExactBatchResponderResources;
  registerSyncHandler({ register: () => {}, protocolSync: '/fixture', syncDeniedResponse: 'denied',
    syncPageSize: 500, sharedMemoryTtlMs: 0, store, peerId: 'local-fixture',
    parseSyncRequest: bytes => JSON.parse(new TextDecoder().decode(bytes)),
    authorizeSyncRequest: async () => true, logWarn: () => {}, logDebug: () => {},
    onExperimentalExactBatchResources: value => { resources = value; } });
  let prepare!: Function, respond!: Function;
  const router = { registerDuplexStream: (_protocol: string, p: Function, r: Function) => {
    prepare = p; respond = r;
  } } as unknown as ProtocolRouter;
  const release = vi.fn(), signal = new AbortController().signal;
  const request = { version: 1, contextGraphId: 'write-idle', snapshotDigest: 'a'.repeat(64),
    assetUals: ['did:dkg:base:84532/0x0000000000000000000000000000000000000001/1'] };
  const options = { admission: resources, authorizeSyncRequest: async () => true,
    isPublicContextGraph: async () => true,
    exportCache: { acquireEncoded: async () => ({ body: new Uint8Array([1]), plainBytes: 1,
      metadata: new Uint8Array([1]), assertCurrent: async () => {}, release }) },
  } as unknown as PublicAssetResponderOptions;
  registerPublicBulkGraph(router, options);
  let rejectDrain!: (error: Error) => void;
  const abort = vi.fn((error: Error) => rejectDrain(error));
  const stream = { abort, writableNeedsDrain: false,
    send: vi.fn((bytes: Uint8Array) => bytes[4] !== K.DATA),
    onDrain: vi.fn(() => new Promise<void>((_resolve, reject) => { rejectDrain = reject; })),
    async *[Symbol.asyncIterator]() {
      yield encodeBulkGraphFrame({ kind: K.REQUEST, index: 0, sequence: 0,
        payload: new TextEncoder().encode(JSON.stringify(request)) });
    },
  };
  const prepared = await prepare(stream, signal);
  const work = respond({ ...prepared, peerId: 'stalled-peer', signal });
  const rejected = expect(work).rejects.toThrow('Bulk graph write-idle deadline exceeded');
  try {
    await vi.advanceTimersByTimeAsync(119_999);
    expect(stream.onDrain).toHaveBeenCalledOnce(); expect(release).not.toHaveBeenCalled();
    let nextStarted = false;
    const next = resources.withAuthorizedResponseAdmission('stalled-peer', request.contextGraphId, signal,
      async () => { nextStarted = true; });
    await vi.advanceTimersByTimeAsync(0); expect(nextStarted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await rejected; await next;
    expect(abort).toHaveBeenCalledOnce(); expect(release).toHaveBeenCalledOnce();
    expect(nextStarted).toBe(true);
  } finally { await prepared.dispose(); await store.close(); vi.useRealTimers(); }
});
