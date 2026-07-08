import { describe, expect, it } from 'vitest';
import { buildKaLifecycleLogProof } from '../src/ka-lifecycle-log-proof.js';

describe('KA lifecycle log proof parsing', () => {
  it('round-trips quoted lifecycle field values with spaces', () => {
    const assetUal = 'did:dkg:evm:31337/0x000000000000000000000000000000000000c10a/7';
    const proof = buildKaLifecycleLogProof([
      {
        level: 'warn',
        module: 'StorageACKHandler',
        message:
          `ka_lifecycle assetUal=${assetUal} stage=storage_ack event=storage_ack_declined ` +
          'role=receiver localPeerId=12D3KooWReceiver localNodeIdentityId=42 ' +
          'reason="No local Sender Key state for 0xabc epoch e1" retryable=true',
      },
    ], assetUal);

    expect(proof.entries).toHaveLength(1);
    expect(proof.entries[0].fields.reason).toBe('No local Sender Key state for 0xabc epoch e1');
    expect(proof.hasFailureOrDeclineLog).toBe(true);
  });
});
