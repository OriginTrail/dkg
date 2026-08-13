import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchSyncPagesMock = vi.hoisted(() => vi.fn(async (params: any) => {
  await params.send(
    params.remotePeerId,
    params.protocolSync,
    new Uint8Array([0xA1]),
    1_234,
    'fresh-message-id',
    params.signal,
  );
  return {
    quads: [],
    bytesReceived: 0,
    resumedFromOffset: 0,
    nextOffset: 0,
    checkpointKey: 'test-checkpoint',
    completed: true,
    timedOut: false,
  };
}));

vi.mock('../src/sync/requester/page-fetch.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/sync/requester/page-fetch.js')>(),
  fetchSyncPages: fetchSyncPagesMock,
}));

import { PROTOCOL_SYNC } from '@origintrail-official/dkg-core';
import { LifecycleSyncMethods } from '../src/dkg-agent-lifecycle.js';
import {
  MAX_EXACT_SYNC_PHASE_BYTES_PER_ASSET,
  MAX_EXACT_SYNC_PHASE_QUADS_PER_ASSET,
} from '../src/sync/exact-assets.js';

describe('LifecycleSyncMethods sync transport policy wiring', () => {
  beforeEach(() => {
    fetchSyncPagesMock.mockClear();
  });

  it('marks every real sync adapter send as a single-use payload', async () => {
    const sendToPeer = vi.fn(async () => new Uint8Array());
    const stopController = new AbortController();
    const agent: any = {
      node: { stopSignal: stopController.signal },
      messenger: { sendToPeer },
      syncCheckpoints: new Map(),
      buildSyncRequest: vi.fn(),
      getOrCreateSyncVerifyWorker: () => ({ parseAndFilter: vi.fn() }),
      log: { warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
    };

    await (LifecycleSyncMethods.prototype.fetchSyncPages as any).call(
      agent,
      { operationId: 'sync-policy-wiring' },
      'remote-peer',
      'private-context-graph',
      true,
      'meta',
      'did:dkg:private-context-graph/_meta',
      Date.now() + 60_000,
    );

    expect(fetchSyncPagesMock).toHaveBeenCalledTimes(1);
    expect(sendToPeer).toHaveBeenCalledTimes(1);
    expect(sendToPeer).toHaveBeenCalledWith(
      'remote-peer',
      PROTOCOL_SYNC,
      new Uint8Array([0xA1]),
      {
        timeoutMs: 1_234,
        payloadReuse: 'single-use',
        signal: expect.any(AbortSignal),
      },
    );
  });

  it('wires exact-asset accumulation limits into the lifecycle page fetch', async () => {
    const agent: any = {
      node: { stopSignal: new AbortController().signal },
      messenger: { sendToPeer: vi.fn(async () => new Uint8Array()) },
      syncCheckpoints: new Map(),
      buildSyncRequest: vi.fn(),
      getOrCreateSyncVerifyWorker: () => ({ parseAndFilter: vi.fn() }),
      log: { warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
    };
    const uals = [
      'did:dkg:base:84532/0x0000000000000000000000000000000000000001/7',
      'did:dkg:base:84532/0x0000000000000000000000000000000000000001/8',
    ];

    await (LifecycleSyncMethods.prototype.fetchSyncPages as any).call(
      agent,
      { operationId: 'exact-limit-wiring' },
      'remote-peer',
      'public-context-graph',
      false,
      'data',
      'did:dkg:public-context-graph',
      Date.now() + 60_000,
      { assetUals: uals },
    );

    expect(fetchSyncPagesMock).toHaveBeenCalledWith(expect.objectContaining({
      assetUals: uals,
      maxAcceptedBytes: 2 * MAX_EXACT_SYNC_PHASE_BYTES_PER_ASSET,
      maxAcceptedQuads: 2 * MAX_EXACT_SYNC_PHASE_QUADS_PER_ASSET,
    }));
  });
});
