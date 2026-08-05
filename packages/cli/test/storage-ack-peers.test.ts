import { describe, expect, it } from 'vitest';
import { storageAckPeerIdsFromPublishResult } from '../src/daemon/routes/storage-ack-peers.js';

describe('storageAckPeerIdsFromPublishResult', () => {
  it('returns trimmed, distinct peer IDs for a confirmed publish', () => {
    expect(storageAckPeerIdsFromPublishResult({
      status: 'confirmed',
      v10ACKs: [
        { peerId: ' peer-a ' },
        { peerId: 'peer-a' },
        { peerId: ' ' },
        { peerId: 'peer-b' },
      ],
    })).toEqual(['peer-a', 'peer-b']);
  });

  it('does not expose ACK targets for an unconfirmed publish', () => {
    expect(storageAckPeerIdsFromPublishResult({
      status: 'tentative',
      v10ACKs: [{ peerId: 'peer-a' }],
    })).toEqual([]);
  });

  it('returns an empty list when ACKs are absent', () => {
    expect(storageAckPeerIdsFromPublishResult({ status: 'confirmed' })).toEqual([]);
  });
});
