import { describe, expect, it } from 'vitest';
import type { PrivatePayloadNonceClaim, PrivatePayloadNonceRegistry } from '@origintrail-official/dkg-wal/privacy';
import type { LocalSwmSenderKeySendState } from '../src/dkg-agent-types.js';
import {
  deserializeSwmSenderSendState,
  serializeSwmSenderSendState,
} from '../src/dkg-agent-swm-state.js';
import {
  decryptDkgWalPrivatePayload,
  dkgWalSenderKeyEpoch,
  encryptDkgWalPrivatePayload,
} from '../src/wal/private-payload-adapter.js';

class NonceRegistry implements PrivatePayloadNonceRegistry {
  readonly values = new Set<string>();

  claimPrivatePayloadNonce(input: PrivatePayloadNonceClaim): void {
    const value = Buffer.from(input.nonce).toString('hex');
    if (this.values.has(value)) throw Object.assign(new Error('reuse'), { code: 'WAL_CONTROL_NONCE_REUSE' });
    this.values.add(value);
  }
}

function state(overrides: Partial<LocalSwmSenderKeySendState> = {}): LocalSwmSenderKeySendState {
  return {
    contextGraphId: 'urn:dkg:cg:private',
    subGraphName: 'private-subgraph',
    senderAgentAddress: '0x1111111111111111111111111111111111111111',
    epochId: 'sender-key-epoch-a',
    membershipHash: 'membership-a',
    chainKey: new Uint8Array(32).fill(2),
    walEpochKey: new Uint8Array(32).fill(1),
    nextMessageIndex: 7,
    senderSigningSecretKey: new Uint8Array(32).fill(3),
    senderSigningPublicKey: new Uint8Array(32).fill(4),
    createdAtMs: 1_700_000_000_000,
    ...overrides,
  };
}

const coordinates = {
  namespaceId: new Uint8Array(32).fill(5),
  writerId: new Uint8Array(20).fill(0x11),
  writerEpoch: 4n,
  sequence: 8n,
};

describe('current DKG Sender Key to WAL private-payload adapter', () => {
  it('persists a stable initial epoch key independently from the ratcheting message chain key', () => {
    const initial = state();
    const restored = deserializeSwmSenderSendState(serializeSwmSenderSendState(initial));
    expect(restored.walEpochKey).toEqual(initial.walEpochKey);
    expect(dkgWalSenderKeyEpoch(restored)).toEqual({
      epochId: initial.epochId,
      membershipHash: initial.membershipHash,
      keyEpoch: BigInt(initial.createdAtMs),
      epochKey: initial.walEpochKey,
    });
    restored.chainKey.fill(99);
    expect(dkgWalSenderKeyEpoch(restored).epochKey).toEqual(initial.walEpochKey);
  });

  it('uses the existing Sender Key epoch for WAL encryption and rejects a rotated or missing epoch', () => {
    const current = state();
    const registry = new NonceRegistry();
    const envelope = encryptDkgWalPrivatePayload(current, {
      ...coordinates,
      payloadKind: 0n,
      codec: 0n,
      mediaType: 'application/vnd.origintrail.dkg-mutation+cbor',
      plaintext: new TextEncoder().encode('private mutation'),
      nonceRegistry: registry,
      nonce: new Uint8Array(12).fill(6),
    });
    expect(new TextDecoder().decode(decryptDkgWalPrivatePayload(current, {
      ...coordinates,
      envelopeBytes: envelope.canonicalBytes,
      expectedPayloadKind: 0n,
      expectedCodec: 0n,
      expectedMediaType: 'application/vnd.origintrail.dkg-mutation+cbor',
    }))).toBe('private mutation');

    const rotated = state({
      epochId: 'sender-key-epoch-b',
      membershipHash: 'membership-b',
      walEpochKey: new Uint8Array(32).fill(9),
      createdAtMs: current.createdAtMs + 1,
    });
    expect(() => decryptDkgWalPrivatePayload(rotated, {
      ...coordinates,
      envelopeBytes: envelope.canonicalBytes,
      expectedPayloadKind: 0n,
      expectedCodec: 0n,
      expectedMediaType: 'application/vnd.origintrail.dkg-mutation+cbor',
    })).toThrowError(expect.objectContaining({ code: 'WAL_PRIVATE_AUTH_FAILED' }));

    expect(() => dkgWalSenderKeyEpoch(state({ walEpochKey: undefined })))
      .toThrowError(expect.objectContaining({ code: 'DKG_WAL_SENDER_KEY_ROTATION_REQUIRED' }));
  });

  it('loads pre-WAL Sender Key state but requires rotation before private WAL use', () => {
    const serialized = serializeSwmSenderSendState(state());
    delete serialized.walEpochKey;
    const legacy = deserializeSwmSenderSendState(serialized);
    expect(legacy.walEpochKey).toBeUndefined();
    expect(() => dkgWalSenderKeyEpoch(legacy)).toThrow(/rotate the Sender Key epoch/);
    expect(() => dkgWalSenderKeyEpoch(state({ createdAtMs: -1 }))).toThrow(/invalid WAL key epoch/);
  });
});
