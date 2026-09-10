import { describe, expect, it, vi } from 'vitest';
import { sendSyncRequest, type SingleUseSyncSender } from '@origintrail-official/dkg-agent/dist/p2p/sync-transport.js';
import { createSyncWorkAdmission, SyncWorkAdmissionExhaustedError } from '@origintrail-official/dkg-agent/dist/sync/work-admission.js';

const request = new Uint8Array([1, 2]);
const response = new Uint8Array([3, 4]);

function legacyParams(send: SingleUseSyncSender): Omit<Parameters<typeof sendSyncRequest>[0], 'workAdmission'> {
  return {
    remotePeerId: 'legacy-peer', protocolId: '/dkg/test/sync',
    timeoutMs: 1500, retryAttempts: 1, contextGraphId: 'legacy-cg', offset: 0,
    requestFactory: async () => request, send, onRetry: () => {},
    plane: 'shared-memory', phase: 'snapshot',
  };
}

describe('published sync transport compatibility', () => {
  it.each(['number', 'resolver'] as const)('accepts the pre-admission parameter shape with a %s timeout', kind => {
    const send = vi.fn<SingleUseSyncSender>(async () => response);
    const timeoutResolver = vi.fn((remainingAttempts: number) => 1500 + remainingAttempts);
    const params = legacyParams(send);
    params.timeoutMs = kind === 'number' ? 1500 : timeoutResolver;
    return sendSyncRequest(params).then(actual => {
      expect(actual).toEqual(response);
      expect(send).toHaveBeenCalledExactlyOnceWith(
        'legacy-peer', '/dkg/test/sync', request, kind === 'number' ? 1500 : 1501,
        expect.any(String), undefined,
      );
      if (kind === 'resolver') expect(timeoutResolver).toHaveBeenCalledExactlyOnceWith(1);
    });
  });

  it('preserves a supplied work allowance and caps the physical timeout', async () => {
    const send = vi.fn<SingleUseSyncSender>(async () => response);
    await expect(sendSyncRequest({
      ...legacyParams(send), workAdmission: createSyncWorkAdmission(() => 25),
    })).resolves.toEqual(response);
    expect(send).toHaveBeenCalledExactlyOnceWith(
      'legacy-peer', '/dkg/test/sync', request, 25, expect.any(String), undefined,
    );
  });

  it('preserves an exhausted allowance and rejects before request construction or send', async () => {
    const send = vi.fn<SingleUseSyncSender>(async () => response);
    const requestFactory = vi.fn(async () => request);
    await expect(sendSyncRequest({
      ...legacyParams(send), requestFactory, workAdmission: createSyncWorkAdmission(() => 0),
    })).rejects.toBeInstanceOf(SyncWorkAdmissionExhaustedError);
    expect(requestFactory).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});
