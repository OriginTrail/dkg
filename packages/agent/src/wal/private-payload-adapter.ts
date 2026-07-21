import {
  decryptPrivateDkgPayload,
  encryptPrivateDkgPayload,
  type DecryptPrivateDkgPayloadInput,
  type EncodedDkgPayloadEnvelope,
  type EncryptPrivateDkgPayloadInput,
} from '@origintrail-official/dkg-wal/privacy';
import type {
  LocalSwmSenderKeyReceiveState,
  LocalSwmSenderKeySendState,
} from '../dkg-agent-types.js';

export type DkgWalSenderKeyState = LocalSwmSenderKeySendState | LocalSwmSenderKeyReceiveState;

export class DkgWalSenderKeyEpochUnavailableError extends Error {
  readonly code = 'DKG_WAL_SENDER_KEY_ROTATION_REQUIRED';

  constructor(message = 'Sender Key state predates WAL epoch-key retention; rotate the Sender Key epoch') {
    super(message);
    this.name = 'DkgWalSenderKeyEpochUnavailableError';
  }
}

export interface DkgWalSenderKeyEpoch {
  epochId: string;
  membershipHash: string;
  keyEpoch: bigint;
  epochKey: Uint8Array;
}

/**
 * Projects existing Sender Key state into WAL crypto inputs. It distributes no
 * keys and performs no membership decision: callers must first select the
 * current state through the existing DKG membership/removal path.
 */
export function dkgWalSenderKeyEpoch(state: DkgWalSenderKeyState): DkgWalSenderKeyEpoch {
  if (!(state.walEpochKey instanceof Uint8Array) || state.walEpochKey.length !== 32) {
    throw new DkgWalSenderKeyEpochUnavailableError();
  }
  if (!Number.isSafeInteger(state.createdAtMs) || state.createdAtMs < 0) {
    throw new DkgWalSenderKeyEpochUnavailableError('Sender Key epoch has an invalid WAL key epoch');
  }
  return {
    epochId: state.epochId,
    membershipHash: state.membershipHash,
    keyEpoch: BigInt(state.createdAtMs),
    epochKey: new Uint8Array(state.walEpochKey),
  };
}

export function encryptDkgWalPrivatePayload(
  state: LocalSwmSenderKeySendState,
  input: Omit<EncryptPrivateDkgPayloadInput, 'epochKey' | 'keyEpoch'>,
): EncodedDkgPayloadEnvelope {
  const epoch = dkgWalSenderKeyEpoch(state);
  return encryptPrivateDkgPayload({ ...input, epochKey: epoch.epochKey, keyEpoch: epoch.keyEpoch });
}

export function decryptDkgWalPrivatePayload(
  state: DkgWalSenderKeyState,
  input: Omit<DecryptPrivateDkgPayloadInput, 'epochKey' | 'expectedKeyEpoch'>,
): Uint8Array {
  const epoch = dkgWalSenderKeyEpoch(state);
  return decryptPrivateDkgPayload({ ...input, epochKey: epoch.epochKey, expectedKeyEpoch: epoch.keyEpoch });
}
