import { readFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WalControlStore } from '../../src/control/store.js';
import { decodeProtocolTuple, encodeProtocolTuple } from '../../src/protocol/codec.js';
import { recoverEip191Address, signEip191DigestWithPrivateKey } from '../../src/protocol/signatures.js';
import { WAL_V1_ENUMS, type ProtocolTuple } from '../../src/protocol/schema.js';
import { createWalObjectV1, verifyWalObjectV1 } from '../../src/protocol/wal-object.js';
import {
  decodeDkgPayloadEnvelope,
  decryptPrivateDkgPayload,
  derivePrivateObjectKey,
  encodePublicDkgPayload,
  encryptPrivateDkgPayload,
  privatePayloadAssociatedDataDigest,
  requirePayloadVisibility,
  WalPrivatePayloadDisclosureGate,
  type PrivatePayloadNonceClaim,
  type PrivatePayloadNonceRegistry,
} from '../../src/privacy/index.js';
import { hashBytes } from '../../src/reconciliation/hash.js';
import { PackedWalObjectStore } from '../../src/store/packed-store.js';

const vectors = JSON.parse(await readFile(
  new URL('../../../../conformance/wal-v1/vectors/protocol-v1.json', import.meta.url),
  'utf8',
));

const roots: string[] = [];
const controls: WalControlStore[] = [];
const stores: PackedWalObjectStore[] = [];

afterEach(async () => {
  for (const value of controls.splice(0)) value.close();
  for (const value of stores.splice(0)) value.close();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

function fromHex(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value.startsWith('0x') ? value.slice(2) : value, 'hex'));
}

function hex(value: Uint8Array): string {
  return Buffer.from(value).toString('hex');
}

function changed(value: Uint8Array): Uint8Array {
  const result = new Uint8Array(value);
  result[0] ^= 1;
  return result;
}

const coordinates = {
  namespaceId: fromHex(vectors.encryption.namespaceId),
  writerId: fromHex(vectors.encryption.writerId),
  writerEpoch: BigInt(vectors.encryption.writerEpoch),
  sequence: BigInt(vectors.encryption.sequence),
};
const metadata = {
  payloadKind: BigInt(WAL_V1_ENUMS.payloadKind.DKG_MUTATION),
  codec: BigInt(WAL_V1_ENUMS.codec.DETERMINISTIC_CBOR),
  mediaType: 'application/vnd.origintrail.dkg-mutation+cbor',
};
const epochKey = fromHex(vectors.encryption.epochKey);
const nonce = fromHex(vectors.encryption.nonce);
const plaintext = fromHex(vectors.encryption.plaintext);

class MemoryNonceRegistry implements PrivatePayloadNonceRegistry {
  readonly claims = new Set<string>();

  claimPrivatePayloadNonce(input: PrivatePayloadNonceClaim): void {
    const key = [
      hex(input.namespaceId), hex(input.writerId), input.writerEpoch,
      input.sequence, hex(input.nonce),
    ].join(':');
    if (this.claims.has(key)) {
      throw Object.assign(new Error('duplicate'), { code: 'WAL_CONTROL_NONCE_REUSE' });
    }
    this.claims.add(key);
  }
}

function encrypt(registry: PrivatePayloadNonceRegistry, fixedNonce: Uint8Array | null = nonce) {
  return encryptPrivateDkgPayload({
    ...coordinates,
    ...metadata,
    epochKey,
    keyEpoch: 9n,
    plaintext,
    nonceRegistry: registry,
    ...(fixedNonce === null ? {} : { nonce: fixedNonce }),
  });
}

function decrypt(envelopeBytes: Uint8Array, overrides: Record<string, unknown> = {}): Uint8Array {
  return decryptPrivateDkgPayload({
    ...coordinates,
    epochKey,
    envelopeBytes,
    expectedKeyEpoch: 9n,
    expectedPayloadKind: metadata.payloadKind,
    expectedCodec: metadata.codec,
    expectedMediaType: metadata.mediaType,
    ...overrides,
  });
}

function expectPrivateCode(operation: () => unknown, code: string): void {
  expect(operation).toThrowError(expect.objectContaining({ code }));
}

async function durableRegistry(label: string): Promise<{ root: string; control: WalControlStore }> {
  const root = await mkdtemp(join(tmpdir(), `dkg-wal-private-${label}-`));
  roots.push(root);
  const store = new PackedWalObjectStore({ root });
  stores.push(store);
  const control = new WalControlStore({ root, now: () => 77 });
  controls.push(control);
  return { root, control };
}

function closeControl(value: WalControlStore): void {
  value.close();
  controls.splice(controls.indexOf(value), 1);
}

describe('private inline DKG payload envelope', () => {
  it('matches the frozen HKDF, associated-data, envelope, and AES-GCM vector exactly', () => {
    expect(hex(derivePrivateObjectKey(epochKey, coordinates))).toBe(vectors.encryption.objectKey);
    expect(hex(privatePayloadAssociatedDataDigest({ ...coordinates, ...metadata, keyEpoch: 9n, nonce })))
      .toBe(vectors.encryption.associatedDataDigest);
    const envelope = encrypt(new MemoryNonceRegistry());
    expect(hex(envelope.canonicalBytes)).toBe(vectors.encryption.envelopeBytes);
    expect(hex(decrypt(envelope.canonicalBytes))).toBe(vectors.encryption.plaintext);
  });

  it('authenticates every view, author, sequence, key, descriptor, and adapter-semantic binding', () => {
    const bytes = encrypt(new MemoryNonceRegistry()).canonicalBytes;
    for (const overrides of [
      { namespaceId: changed(coordinates.namespaceId) },
      { writerId: changed(coordinates.writerId) },
      { writerEpoch: coordinates.writerEpoch + 1n },
      { sequence: coordinates.sequence + 1n },
      { epochKey: changed(epochKey) },
      { expectedKeyEpoch: 8n },
      { expectedPayloadKind: BigInt(WAL_V1_ENUMS.payloadKind.RDF_POLICY) },
      { expectedCodec: BigInt(WAL_V1_ENUMS.codec.OPAQUE_BYTES) },
      { expectedMediaType: 'application/octet-stream' },
      { validatePlaintext: () => false },
    ]) expectPrivateCode(() => decrypt(bytes, overrides), 'WAL_PRIVATE_AUTH_FAILED');
    expect(hex(decrypt(bytes, { validatePlaintext: (value: Uint8Array) => hex(value) === hex(plaintext) })))
      .toBe(hex(plaintext));
  });

  it('rejects nonce, associated-data, ciphertext, tag, length, codec, and media-type mutation', () => {
    const original = encrypt(new MemoryNonceRegistry()).tuple;
    const descriptor = original[4]!;
    const cases: ProtocolTuple<'DkgPayloadEnvelopeV1'>[] = [
      [1n, original[1], original[2], original[3], [descriptor[0], descriptor[1], changed(descriptor[2]), descriptor[3]], original[5]],
      [1n, original[1], original[2], original[3], [descriptor[0], descriptor[1], descriptor[2], changed(descriptor[3])], original[5]],
      [1n, original[1], original[2], original[3], descriptor, changed(original[5])],
      [1n, original[1], original[2], original[3], descriptor, original[5].slice(0, 15)],
      [1n, original[1], BigInt(WAL_V1_ENUMS.codec.OPAQUE_BYTES), original[3], descriptor, original[5]],
      [1n, original[1], original[2], 'application/octet-stream', descriptor, original[5]],
    ];
    for (const tuple of cases) {
      expectPrivateCode(
        () => decrypt(encodeProtocolTuple('DkgPayloadEnvelopeV1', tuple)),
        'WAL_PRIVATE_AUTH_FAILED',
      );
    }
    expectPrivateCode(() => decrypt(original[5].slice(0, 5)), 'WAL_PRIVATE_INVALID');
  });

  it('claims nonces before encryption, rejects reuse across restart, and prevents deterministic equality leakage', async () => {
    const { root, control } = await durableRegistry('nonce');
    const firstEnvelope = encrypt(control);
    expectPrivateCode(() => encrypt(control), 'WAL_PRIVATE_NONCE_REUSE');
    closeControl(control);
    const reopened = new WalControlStore({ root });
    controls.push(reopened);
    expectPrivateCode(() => encrypt(reopened), 'WAL_PRIVATE_NONCE_REUSE');

    const randomRegistry = new MemoryNonceRegistry();
    const randomA = encrypt(randomRegistry, null);
    const randomB = encrypt(randomRegistry, null);
    expect(hex(randomA.canonicalBytes)).not.toBe(hex(randomB.canonicalBytes));
    expect(hex(randomA.tuple[5])).not.toBe(hex(randomB.tuple[5]));
    expect(Buffer.from(randomA.canonicalBytes).includes(Buffer.from(plaintext))).toBe(false);
    expect(Buffer.from(randomA.canonicalBytes).includes(Buffer.from(hashBytes(plaintext)))).toBe(false);
    expect(hex(decrypt(firstEnvelope.canonicalBytes))).toBe(hex(plaintext));
  });

  it('keeps all envelope metadata under the enclosing WalObject signature and has no payload identity', async () => {
    const envelope = encrypt(new MemoryNonceRegistry());
    const privateKey = fromHex(vectors.fixturePrivateKey);
    const zero = new Uint8Array(32);
    const signature = signEip191DigestWithPrivateKey(zero, privateKey);
    const signerAddress = recoverEip191Address(zero, signature);
    const object = await createWalObjectV1([
      1n, coordinates.namespaceId, signerAddress, 1n, 0n, null, envelope.canonicalBytes,
    ], {
      address: signerAddress,
      signMessage: digest => signEip191DigestWithPrivateKey(digest, privateKey),
    });
    expect(verifyWalObjectV1(object.canonicalBytes).payloadBytes).toEqual(envelope.canonicalBytes);
    const changedEnvelope = new Uint8Array(envelope.canonicalBytes);
    changedEnvelope[changedEnvelope.length - 1] ^= 1;
    const tampered: ProtocolTuple<'WalObjectV1'> = [
      object.tuple[0], object.tuple[1], object.tuple[2], object.tuple[3],
      object.tuple[4], object.tuple[5], changedEnvelope, object.tuple[7],
    ];
    expect(() => verifyWalObjectV1(encodeProtocolTuple('WalObjectV1', tampered))).toThrow();
    expect(decodeDkgPayloadEnvelope(envelope.canonicalBytes)).toHaveLength(6);
  });

  it('enforces public/private downgrade boundaries and public MOVE_TIER leak safety', () => {
    const publicEnvelope = encodePublicDkgPayload({
      payloadKind: BigInt(WAL_V1_ENUMS.payloadKind.MOVE_TIER_TARGET),
      codec: BigInt(WAL_V1_ENUMS.codec.DETERMINISTIC_CBOR),
      mediaType: metadata.mediaType,
      contentBytes: fromHex(vectors.moveTier.publicTargetPayload),
    });
    expect(requirePayloadVisibility(publicEnvelope.canonicalBytes, 'public')[4]).toBeNull();
    expectPrivateCode(() => requirePayloadVisibility(publicEnvelope.canonicalBytes, 'private'), 'WAL_PRIVATE_DOWNGRADE');
    const privateEnvelope = encrypt(new MemoryNonceRegistry());
    expect(requirePayloadVisibility(privateEnvelope.canonicalBytes, 'private')[4]).not.toBeNull();
    expectPrivateCode(() => requirePayloadVisibility(privateEnvelope.canonicalBytes, 'public'), 'WAL_PRIVATE_DOWNGRADE');
    expectPrivateCode(() => encodePublicDkgPayload({
      payloadKind: BigInt(WAL_V1_ENUMS.payloadKind.MOVE_TIER_SOURCE),
      codec: metadata.codec,
      mediaType: metadata.mediaType,
      contentBytes: plaintext,
    }), 'WAL_PRIVATE_DOWNGRADE');

    const publicBytes = Buffer.from(vectors.moveTier.publicTargetPayload, 'hex');
    for (const forbidden of vectors.moveTier.forbiddenPublicValues) {
      expect(publicBytes.includes(Buffer.from(forbidden, 'hex'))).toBe(false);
    }
    for (const forbidden of vectors.moveTier.forbiddenPublicText) {
      expect(publicBytes.includes(Buffer.from(forbidden, 'utf8'))).toBe(false);
    }
    for (const forbidden of vectors.moveTier.forbiddenPublicScalarCbor) {
      expect(publicBytes.includes(Buffer.from(forbidden, 'hex'))).toBe(false);
    }
  });

  it('rejects malformed crypto inputs and propagates durable-registry failures without encrypting', () => {
    for (const operation of [
      () => derivePrivateObjectKey(new Uint8Array(31), coordinates),
      () => derivePrivateObjectKey(epochKey, { ...coordinates, namespaceId: new Uint8Array(31) }),
      () => derivePrivateObjectKey(epochKey, { ...coordinates, writerId: new Uint8Array(19) }),
      () => derivePrivateObjectKey(epochKey, { ...coordinates, writerEpoch: -1n }),
      () => derivePrivateObjectKey(epochKey, { ...coordinates, sequence: 1n << 64n }),
      () => derivePrivateObjectKey(epochKey, { ...coordinates, sequence: 1 as never }),
      () => privatePayloadAssociatedDataDigest({ ...coordinates, ...metadata, keyEpoch: 9n, nonce: new Uint8Array(11) }),
      () => privatePayloadAssociatedDataDigest({ ...coordinates, ...metadata, keyEpoch: -1n, nonce }),
      () => encodePublicDkgPayload({ ...metadata, mediaType: 'e\u0301', contentBytes: plaintext }),
      () => encodePublicDkgPayload({ ...metadata, mediaType: 'x'.repeat(129), contentBytes: plaintext }),
      () => encodePublicDkgPayload({ ...metadata, mediaType: 1 as never, contentBytes: plaintext }),
      () => encodePublicDkgPayload({ ...metadata, contentBytes: null as never }),
      () => encryptPrivateDkgPayload({
        ...coordinates, ...metadata, epochKey, keyEpoch: 9n, plaintext: null as never,
        nonceRegistry: new MemoryNonceRegistry(), nonce,
      }),
      () => encryptPrivateDkgPayload({
        ...coordinates, ...metadata, epochKey, keyEpoch: 9n, plaintext,
        nonceRegistry: new MemoryNonceRegistry(), nonce: new Uint8Array(11),
      }),
      () => encryptPrivateDkgPayload({
        ...coordinates, ...metadata, epochKey, keyEpoch: 9n, plaintext,
        nonceRegistry: null as never, nonce,
      }),
      () => encryptPrivateDkgPayload({
        ...coordinates, ...metadata, epochKey, keyEpoch: 9n, plaintext,
        nonceRegistry: {} as never, nonce,
      }),
      () => decodeDkgPayloadEnvelope(new Uint8Array()),
      () => decodeDkgPayloadEnvelope(null as never),
    ]) expectPrivateCode(operation, 'WAL_PRIVATE_INVALID');

    const registryFailure = new Error('disk unavailable');
    expect(() => encryptPrivateDkgPayload({
      ...coordinates, ...metadata, epochKey, keyEpoch: 9n, plaintext, nonce,
      nonceRegistry: { claimPrivatePayloadNonce: () => { throw registryFailure; } },
    })).toThrow(registryFailure);

    const oversizedMediaTuple: ProtocolTuple<'DkgPayloadEnvelopeV1'> = [
      1n, metadata.payloadKind, metadata.codec, 'x'.repeat(129), null, plaintext,
    ];
    expectPrivateCode(
      () => decodeDkgPayloadEnvelope(encodeProtocolTuple('DkgPayloadEnvelopeV1', oversizedMediaTuple)),
      'WAL_PRIVATE_INVALID',
    );
    const publicEnvelope = encodePublicDkgPayload({ ...metadata, contentBytes: plaintext });
    expectPrivateCode(() => decrypt(publicEnvelope.canonicalBytes), 'WAL_PRIVATE_DOWNGRADE');
  });

  it('authorizes before lookup and collapses unauthenticated, removed, stale, wrong-view, and failures to one denial', async () => {
    const authorize = vi.fn(async (request: { delegation: unknown }) => request.delegation === 'current');
    const gate = new WalPrivatePayloadDisclosureGate({ authorizePrivateDisclosure: authorize as never });
    const load = vi.fn(() => ({ private: true }));
    const request = {
      view: {
        collectionKey: ['testnet', 'cg:private', null, 1n] as const,
        viewKey: ['testnet', 'cg:private', null, 0n, 1n, 7n, 9n] as const,
      },
      requesterAgentAddress: coordinates.writerId,
      transportPeerId: Uint8Array.of(4),
      delegation: 'removed',
    };
    for (const denial of ['unauthenticated', 'removed', 'stale-policy', 'wrong-view', 'probe']) {
      expect(await gate.disclose({ ...request, delegation: denial }, load)).toEqual({ status: 'denied' });
    }
    expect(load).not.toHaveBeenCalled();
    expect(await gate.disclose({ ...request, delegation: 'current' }, load)).toEqual({
      status: 'allowed', value: { private: true },
    });
    expect(await gate.disclose({ ...request, delegation: 'current' }, () => { throw new Error('lookup'); }))
      .toEqual({ status: 'denied' });
    expect(authorize).toHaveBeenCalledTimes(7);
  });
});
