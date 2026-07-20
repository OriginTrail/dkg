import {
  protocolTupleId,
  type CborProtocolValue,
  type ProtocolTuple,
  type WalAuthorizedRequest,
  type WalWireProtocolService,
} from '../../src/protocol/index.js';

export const NOW_MS = 1_800_000_000_000;

export function fill(length: number, value: number): Uint8Array {
  return new Uint8Array(length).fill(value);
}

export const REQUESTER_PEER = fill(38, 0x11);
export const PROVIDER_PEER = fill(38, 0x22);
export const NAMESPACE = fill(32, 0x33);
export const COLLECTION = fill(32, 0x44);
export const WRITER = fill(20, 0x55);
export const SIGNER = fill(20, 0x66);
export const SIGNATURE = fill(65, 0x77);
export const HEAD_ROOT = fill(32, 0x88);
export const POLICY = fill(32, 0x99);

export function requestId(value: number): Uint8Array {
  return fill(16, value);
}

export function context(
  issuedAtMs = NOW_MS,
  requesterPeerId = REQUESTER_PEER,
  targetPeerId = PROVIDER_PEER,
  namespaceId = NAMESPACE,
): ProtocolTuple<'RequestContextV1'> {
  return [BigInt(issuedAtMs), requesterPeerId, targetPeerId, namespaceId, null, null, null];
}

export function checkpoint(
  namespaceId = NAMESPACE,
  writerId = WRITER,
  writerEpoch = 7n,
): ProtocolTuple<'AuthorCheckpointV1'> {
  return [
    1n,
    namespaceId,
    writerId,
    writerEpoch,
    3n,
    1n,
    HEAD_ROOT,
    2n,
    1n,
    null,
    null,
    0n,
    SIGNATURE,
  ];
}

export function vector(collectionId = COLLECTION): ProtocolTuple<'CollectionHeadVectorV1'> {
  const checkpointValue = checkpoint();
  return [
    1n,
    collectionId,
    fill(32, 0xaa),
    [[NAMESPACE, [[WRITER, protocolTupleId('AuthorCheckpointV1', checkpointValue)]]]],
    1n,
    2n,
    null,
    BigInt(NOW_MS),
    BigInt(NOW_MS + 60_000),
    null,
    fill(32, 0xbb),
    [[SIGNER, SIGNATURE]],
  ];
}

export const CAPABILITIES: ProtocolTuple<'CapabilitiesV1'> = [
  [1n],
  [1n],
  1_048_576n,
  4_096n,
  4_096n,
  1_048_576n,
  1_073_741_824n,
  16n,
];

export function service(overrides: Partial<WalWireProtocolService> = {}): WalWireProtocolService {
  const checkpointValue = checkpoint();
  const base: WalWireProtocolService = {
    async getCapabilities() { return CAPABILITIES; },
    async getHead() { return checkpointValue; },
    async getVector() { return vector(); },
    async getCheckpoint() { return checkpointValue; },
    async announceHead() {},
    async getReconciliationSymbols(_request, body) {
      return [
        body[0],
        body[1],
        body[2],
        Array.from({ length: Number(body[3]) }, (_, index) => [
          body[2] + BigInt(index),
          0n,
          fill(32, 0),
          fill(32, 0),
        ] as const),
      ];
    },
    async getObjectIds(_request, body) {
      const first = fill(32, 0xc1);
      const second = fill(32, 0xc2);
      return [body[0], body[1], [first, second], null, true];
    },
    async getObjectRange(_request, body) {
      return [body[0], body[1] + 3n, body[1], Uint8Array.of(1, 2, 3)];
    },
  };
  return { ...base, ...overrides };
}

export function peer(id = REQUESTER_PEER, text = 'requester-peer') {
  return { toString: () => text, toBytes: () => id };
}

export interface MethodFixture {
  family: 'control' | 'reconcile' | 'object';
  requestType: number;
  body: readonly CborProtocolValue[];
  response: readonly CborProtocolValue[];
}

export function methodFixtures(): MethodFixture[] {
  const checkpointValue = checkpoint();
  const checkpointId = protocolTupleId('AuthorCheckpointV1', checkpointValue);
  const headId = fill(32, 0xd1);
  const seed = fill(32, 0xd2);
  const objectId = fill(32, 0xd3);
  return [
    { family: 'control', requestType: 0, body: [], response: CAPABILITIES },
    { family: 'control', requestType: 2, body: [WRITER, 7n], response: checkpointValue },
    { family: 'control', requestType: 4, body: [COLLECTION], response: vector() },
    { family: 'control', requestType: 6, body: [checkpointId], response: checkpointValue },
    { family: 'control', requestType: 8, body: [checkpointId], response: [] },
    { family: 'control', requestType: 10, body: [requestId(0xfe)], response: [] },
    {
      family: 'reconcile',
      requestType: 0,
      body: [headId, seed, 5n, 2n],
      response: [headId, seed, 5n, [[5n, 0n, fill(32, 0), fill(32, 0)], [6n, 0n, fill(32, 0), fill(32, 0)]]],
    },
    { family: 'reconcile', requestType: 2, body: [headId, null, 2n], response: [headId, null, [fill(32, 0xc1), fill(32, 0xc2)], null, true] },
    { family: 'reconcile', requestType: 10, body: [requestId(0xfd)], response: [] },
    { family: 'object', requestType: 0, body: [objectId, 10n, 3n], response: [objectId, 13n, 10n, Uint8Array.of(1, 2, 3)] },
    { family: 'object', requestType: 10, body: [requestId(0xfc)], response: [] },
  ];
}

export function authorized(_request: WalAuthorizedRequest): boolean {
  return true;
}
