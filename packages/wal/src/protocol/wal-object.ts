import { decodeProtocolTuple, encodeProtocolTuple } from './codec.js';
import { protocolTupleId } from './hashes.js';
import {
  signSingleProtocolTuple,
  verifySingleSignedProtocolTuple,
  type WalEip191Signer,
} from './signatures.js';
import type { ProtocolTuple } from './schema.js';

export const WAL_OBJECT_V1_HARD_BYTES = 8_589_934_592;

export type WalObjectV1 = ProtocolTuple<'WalObjectV1'>;
export type UnsignedWalObjectV1 = readonly [
  version: 1n,
  namespaceId: Uint8Array,
  writerId: Uint8Array,
  writerEpoch: bigint,
  sequence: bigint,
  previousObjectIdOrNull: Uint8Array | null,
  payloadBytes: Uint8Array,
];

export interface VerifiedWalObjectV1 {
  tuple: WalObjectV1;
  canonicalBytes: Uint8Array;
  walObjectId: Uint8Array;
  writerId: Uint8Array;
  payloadBytes: Uint8Array;
}

export async function createWalObjectV1(
  unsigned: UnsignedWalObjectV1,
  signer: WalEip191Signer,
): Promise<VerifiedWalObjectV1> {
  const tuple = await signSingleProtocolTuple('WalObjectV1', unsigned, signer);
  const canonicalBytes = encodeProtocolTuple('WalObjectV1', tuple);
  return {
    tuple,
    canonicalBytes,
    walObjectId: protocolTupleId('WalObjectV1', tuple),
    writerId: new Uint8Array(tuple[2]),
    payloadBytes: new Uint8Array(tuple[6]),
  };
}

export function verifyWalObjectV1(canonicalBytes: Uint8Array): VerifiedWalObjectV1 {
  const tuple = decodeProtocolTuple('WalObjectV1', canonicalBytes);
  verifySingleSignedProtocolTuple('WalObjectV1', tuple);
  return {
    tuple,
    canonicalBytes: new Uint8Array(canonicalBytes),
    walObjectId: protocolTupleId('WalObjectV1', tuple),
    writerId: new Uint8Array(tuple[2]),
    payloadBytes: new Uint8Array(tuple[6]),
  };
}
