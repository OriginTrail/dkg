import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodeCanonicalCbor, encodeCanonicalCbor } from '../../src/protocol/canonical-cbor.js';
import { decodeProtocolTuple } from '../../src/protocol/codec.js';
import {
  collectionIdV1,
  hashCanonicalTupleV1,
  hashWalV1Domain,
  namespaceIdV1,
  protocolSignatureDigest,
  protocolTupleId,
  protocolTupleIdFromBytes,
} from '../../src/protocol/hashes.js';
import {
  assertCanonicalEip191Signature,
  eip191DigestHash,
  normalizeAddress20,
  recoverEip191Address,
  signEip191DigestWithAdapter,
  signEip191DigestWithPrivateKey,
  signSingleProtocolTuple,
  signThresholdProtocolTuple,
  verifySingleSignedProtocolTuple,
  verifyThresholdSignedProtocolTuple,
  type WalEip191Signer,
} from '../../src/protocol/signatures.js';
import type { CborProtocolValue } from '../../src/protocol/schema.js';
import { createWalObjectV1, verifyWalObjectV1 } from '../../src/protocol/wal-object.js';

const vectors = JSON.parse(await readFile(
  resolve(process.cwd(), '../../conformance/wal-v1/vectors/protocol-v1.json'),
  'utf8',
));
const SECP256K1_ORDER = 0xffff_ffff_ffff_ffff_ffff_ffff_ffff_fffe_baaedce6_af48a03b_bfd25e8c_d0364141n;

function fromHex(value: string): Uint8Array {
  const normalized = value.startsWith('0x') ? value.slice(2) : value;
  return new Uint8Array(Buffer.from(normalized, 'hex'));
}

function hex(value: Uint8Array): string {
  return Buffer.from(value).toString('hex');
}

function bigint32(value: bigint): Uint8Array {
  return fromHex(value.toString(16).padStart(64, '0'));
}

function privateKeySigner(privateKey: Uint8Array, address: Uint8Array, asHexAddress = true): WalEip191Signer {
  return {
    getAddress: async () => asHexAddress ? `0x${hex(address)}` : new Uint8Array(address),
    signMessage: async digest => `0x${hex(signEip191DigestWithPrivateKey(digest, privateKey))}`,
  };
}

const fixturePrivateKey = fromHex(vectors.fixturePrivateKey);
const fixtureWriter = fromHex(vectors.walObjects.first.writerId);
const fixtureSigner = privateKeySigner(fixturePrivateKey, fixtureWriter);
const invalidWalObjects = vectors.invalidWalObjects as Array<{ name: string; bytes: string }>;

describe('WalObjectV1 golden identity', () => {
  it('reproduces the exact unsigned bytes, digest, signature, signed bytes, signer, and ID', async () => {
    const fixture = vectors.walObjects.first;
    const unsigned = decodeCanonicalCbor(fromHex(fixture.unsignedTupleCbor)) as readonly CborProtocolValue[];
    expect(hex(encodeCanonicalCbor(unsigned))).toBe(fixture.unsignedTupleCbor);
    expect(hex(protocolSignatureDigest('WalObjectV1', unsigned))).toBe(fixture.signatureDigest);
    expect(hex(signEip191DigestWithPrivateKey(fromHex(fixture.signatureDigest), fixturePrivateKey))).toBe(fixture.signature);

    const created = await createWalObjectV1(unsigned as never, fixtureSigner);
    expect(hex(created.canonicalBytes)).toBe(fixture.canonicalBytes);
    expect(hex(created.walObjectId)).toBe(fixture.walObjectId);
    expect(hex(created.writerId)).toBe(fixture.writerId);
    expect(hex(created.payloadBytes)).toBe(fixture.payloadBytes);

    const verified = verifyWalObjectV1(fromHex(fixture.canonicalBytes));
    expect(hex(verified.walObjectId)).toBe(fixture.walObjectId);
    expect(hex(verified.canonicalBytes)).toBe(fixture.canonicalBytes);
    expect(hex(verifySingleSignedProtocolTuple('WalObjectV1', verified.tuple))).toBe(fixture.writerId);
    expect(hex(protocolTupleIdFromBytes('WalObjectV1', verified.canonicalBytes))).toBe(fixture.walObjectId);
  });

  it('verifies linked objects and makes one changed payload byte a new whole-object identity', () => {
    const second = verifyWalObjectV1(fromHex(vectors.walObjects.second.canonicalBytes));
    const changed = verifyWalObjectV1(fromHex(vectors.walObjects.onePayloadByteChanged.canonicalBytes));
    expect(hex(second.tuple[5]!)).toBe(vectors.walObjects.second.previousObjectId);
    expect(hex(changed.walObjectId)).toBe(vectors.walObjects.onePayloadByteChanged.walObjectId);
    expect(hex(changed.walObjectId)).not.toBe(vectors.walObjects.first.walObjectId);
  });

  it.each(invalidWalObjects)('rejects alternate fixture $name instead of normalizing it', (fixture) => {
    expect(() => verifyWalObjectV1(fromHex(fixture.bytes))).toThrow();
  });

  it('reproduces namespace and collection identities from their exact tuple bytes', () => {
    const collection = decodeCanonicalCbor(fromHex(vectors.collection.keyCbor));
    const namespace = decodeCanonicalCbor(fromHex(vectors.namespace.keyCbor));
    expect(hex(collectionIdV1(collection as never))).toBe(vectors.collection.collectionId);
    expect(hex(namespaceIdV1(namespace as never))).toBe(vectors.namespace.namespaceId);
    expect(hashCanonicalTupleV1('logicalKey', ['key'])).toHaveLength(32);
  });
});

describe('signed control identities and authority boundary', () => {
  it.each([
    ['AuthoritySetV1', 'authoritySet', 'authoritySetId'],
    ['MembershipCheckpointV1', 'membershipCheckpoint', 'membershipCheckpointId'],
    ['CollectionHeadVectorV1', 'collectionHeadVector', 'vectorId'],
  ] as const)('verifies threshold fixture %s without defining its authority policy', (name, fixtureName, idField) => {
    const fixture = vectors.signedControl[fixtureName];
    const tuple = decodeProtocolTuple(name, fromHex(fixture.canonicalBytes)) as never;
    expect(hex(protocolTupleId(name, tuple))).toBe(fixture[idField]);
    expect(verifyThresholdSignedProtocolTuple(name, tuple, {
      signerAddresses: [fixtureWriter],
      threshold: 1,
    }).map(hex)).toEqual([vectors.walObjects.first.writerId]);
  });

  it('verifies author checkpoints and network cutovers under their distinct domains', () => {
    const checkpoint = decodeProtocolTuple(
      'AuthorCheckpointV1',
      fromHex(vectors.signedControl.authorCheckpoint.canonicalBytes),
    );
    expect(hex(verifySingleSignedProtocolTuple('AuthorCheckpointV1', checkpoint))).toBe(hex(fixtureWriter));
    expect(hex(protocolTupleId('AuthorCheckpointV1', checkpoint))).toBe(
      vectors.signedControl.authorCheckpoint.checkpointId,
    );

    const cutover = decodeProtocolTuple('NetworkWalCutoverV1', fromHex(vectors.cutover.canonicalBytes));
    expect(hex(protocolTupleId('NetworkWalCutoverV1', cutover))).toBe(vectors.cutover.cutoverId);
    expect(verifyThresholdSignedProtocolTuple('NetworkWalCutoverV1', cutover, {
      signerAddresses: [fixtureWriter],
      threshold: 1n,
    })).toHaveLength(1);
  });

  it('constructs sorted threshold entries and rejects duplicate signers', async () => {
    const zeroDigest = new Uint8Array(32);
    const secondPrivateKey = bigint32(1n);
    const secondAddress = recoverEip191Address(
      zeroDigest,
      signEip191DigestWithPrivateKey(zeroDigest, secondPrivateKey),
    );
    const secondSigner = privateKeySigner(secondPrivateKey, secondAddress, false);
    const unsigned = decodeCanonicalCbor(
      fromHex(vectors.signedControl.authoritySet.unsignedTupleCbor),
    ) as readonly CborProtocolValue[];
    const signed = await signThresholdProtocolTuple(
      'AuthoritySetV1',
      unsigned,
      [fixtureSigner, secondSigner],
    );
    expect(signed.at(-1)).toHaveLength(2);
    expect(verifyThresholdSignedProtocolTuple('AuthoritySetV1', signed, {
      signerAddresses: [fixtureWriter, secondAddress],
      threshold: 2,
    })).toHaveLength(2);
    await expect(signThresholdProtocolTuple(
      'AuthoritySetV1',
      unsigned,
      [fixtureSigner, fixtureSigner],
    )).rejects.toMatchObject({ code: 'WAL_SIGNATURE_DUPLICATE_SIGNER' });
  });

  it('fails closed for unattainable, insufficient, duplicate, and unauthorized authority policy', () => {
    const tuple = decodeProtocolTuple(
      'AuthoritySetV1',
      fromHex(vectors.signedControl.authoritySet.canonicalBytes),
    );
    for (const threshold of [0, 2]) {
      expect(() => verifyThresholdSignedProtocolTuple('AuthoritySetV1', tuple, {
        signerAddresses: [fixtureWriter],
        threshold,
      })).toThrow(expect.objectContaining({ code: 'WAL_SIGNATURE_THRESHOLD' }));
    }
    for (const threshold of [Number.NaN, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => verifyThresholdSignedProtocolTuple('AuthoritySetV1', tuple, {
        signerAddresses: [fixtureWriter],
        threshold,
      })).toThrow(expect.objectContaining({ code: 'WAL_SIGNATURE_THRESHOLD' }));
    }
    expect(() => verifyThresholdSignedProtocolTuple('AuthoritySetV1', tuple, {
      signerAddresses: [fixtureWriter, fixtureWriter],
      threshold: 1,
    })).toThrow(expect.objectContaining({ code: 'WAL_SIGNATURE_DUPLICATE_SIGNER' }));
    expect(() => verifyThresholdSignedProtocolTuple('AuthoritySetV1', tuple, {
      signerAddresses: [new Uint8Array(20).fill(9)],
      threshold: 1,
    })).toThrow(expect.objectContaining({ code: 'WAL_SIGNATURE_SIGNER_MISMATCH' }));

    const falselyClaimed = [...tuple] as CborProtocolValue[];
    const signatureEntries = tuple.at(-1) as readonly (readonly [Uint8Array, Uint8Array])[];
    falselyClaimed[falselyClaimed.length - 1] = [[new Uint8Array(20).fill(9), signatureEntries[0][1]]];
    expect(() => verifyThresholdSignedProtocolTuple('AuthoritySetV1', falselyClaimed as never, {
      signerAddresses: [fixtureWriter],
      threshold: 1,
    })).toThrow(expect.objectContaining({ code: 'WAL_SIGNATURE_SIGNER_MISMATCH' }));

    const empty = [...tuple.slice(0, -1), []] as never;
    expect(() => verifyThresholdSignedProtocolTuple('AuthoritySetV1', empty, {
      signerAddresses: [fixtureWriter],
      threshold: 1,
    })).toThrow(expect.objectContaining({ code: 'WAL_SIGNATURE_THRESHOLD' }));
  });
});

describe('EIP-191 canonical signature rules', () => {
  const digest = fromHex(vectors.walObjects.first.signatureDigest);
  const signature = fromHex(vectors.walObjects.first.signature);

  it('recovers the fixture signer and accepts both adapter address representations', async () => {
    expect(hex(recoverEip191Address(digest, signature))).toBe(hex(fixtureWriter));
    expect(hex(normalizeAddress20(`0x${hex(fixtureWriter).toUpperCase()}`))).toBe(hex(fixtureWriter));
    expect(hex(normalizeAddress20(fixtureWriter))).toBe(hex(fixtureWriter));
    expect(hex(eip191DigestHash(digest))).toHaveLength(64);
    expect((await signEip191DigestWithAdapter(digest, fixtureSigner)).signature).toEqual(signature);
    expect((await signEip191DigestWithAdapter(digest, {
      address: `0x${hex(fixtureWriter)}`,
      signMessage: () => `0x${hex(signature)}`,
    })).signature).toEqual(signature);
    const compactVs = new Uint8Array(signature.slice(32, 64));
    if (signature[64] === 28) compactVs[0] |= 0x80;
    expect((await signEip191DigestWithAdapter(digest, {
      getSignerAddress: () => `0x${hex(fixtureWriter)}`,
      signMessage: () => ({ r: signature.slice(0, 32), vs: compactVs }),
    })).signature).toEqual(signature);
    const oppositeSignature = new Uint8Array(signature);
    oppositeSignature[64] = signature[64] === 27 ? 28 : 27;
    const oppositeAddress = recoverEip191Address(digest, oppositeSignature);
    const oppositeVs = new Uint8Array(oppositeSignature.slice(32, 64));
    if (oppositeSignature[64] === 28) oppositeVs[0] |= 0x80;
    expect((await signEip191DigestWithAdapter(digest, {
      getSignerAddress: () => oppositeAddress,
      signMessage: () => ({ r: oppositeSignature.slice(0, 32), vs: oppositeVs }),
    })).signature).toEqual(oppositeSignature);
  });

  it.each([
    [new Uint8Array(64), 'WAL_SIGNATURE_LENGTH'],
    [Uint8Array.from([...signature.slice(0, 64), 0]), 'WAL_SIGNATURE_RECOVERY_BIT'],
    [Uint8Array.from([...new Uint8Array(32), ...signature.slice(32)]), 'WAL_SIGNATURE_R_RANGE'],
    [Uint8Array.from([...signature.slice(0, 32), ...new Uint8Array(32), signature[64]]), 'WAL_SIGNATURE_HIGH_S'],
  ])('rejects malformed canonical signatures with stable codes', (candidate, code) => {
    expect(() => assertCanonicalEip191Signature(candidate)).toThrow(expect.objectContaining({ code }));
  });

  it('rejects high-S malleability and valid-range signatures that cannot recover', () => {
    const s = BigInt(`0x${hex(signature.slice(32, 64))}`);
    const high = Uint8Array.from([
      ...signature.slice(0, 32),
      ...bigint32(SECP256K1_ORDER - s),
      signature[64] === 27 ? 28 : 27,
    ]);
    expect(() => assertCanonicalEip191Signature(high)).toThrow(
      expect.objectContaining({ code: 'WAL_SIGNATURE_HIGH_S' }),
    );
    const unrecoverable = new Uint8Array(65);
    unrecoverable[31] = 5;
    unrecoverable[63] = 1;
    unrecoverable[64] = 27;
    expect(() => recoverEip191Address(new Uint8Array(32), unrecoverable)).toThrow(
      expect.objectContaining({ code: 'WAL_SIGNATURE_RECOVERY_FAILED' }),
    );
  });

  it('rejects adapter errors, invalid keys, mismatched signers, and malformed addresses', async () => {
    expect(() => eip191DigestHash(new Uint8Array(31))).toThrow(
      expect.objectContaining({ code: 'WAL_SIGNATURE_LENGTH' }),
    );
    expect(() => normalizeAddress20(new Uint8Array(19))).toThrow();
    expect(() => normalizeAddress20('not-an-address')).toThrow();
    expect(() => signEip191DigestWithPrivateKey(digest, new Uint8Array(31))).toThrow();
    expect(() => signEip191DigestWithPrivateKey(digest, new Uint8Array(32))).toThrow();
    await expect(signEip191DigestWithAdapter(digest, {} as never)).rejects.toMatchObject({
      code: 'WAL_SIGNATURE_ADAPTER',
    });
    await expect(signEip191DigestWithAdapter(digest, {
      getAddress: () => { throw new Error('wallet locked'); },
      signMessage: () => signature,
    })).rejects.toMatchObject({ code: 'WAL_SIGNATURE_ADAPTER' });
    await expect(signEip191DigestWithAdapter(digest, {
      getAddress: () => { throw 'wallet locked'; },
      signMessage: () => signature,
    })).rejects.toMatchObject({ code: 'WAL_SIGNATURE_ADAPTER' });
    await expect(signEip191DigestWithAdapter(digest, {
      getAddress: () => fixtureWriter,
      signMessage: () => 'bad-signature',
    })).rejects.toMatchObject({ code: 'WAL_SIGNATURE_ADAPTER' });
    await expect(signEip191DigestWithAdapter(digest, {
      getAddress: () => fixtureWriter,
      signMessage: () => ({ r: new Uint8Array(31), vs: new Uint8Array(32) }),
    })).rejects.toMatchObject({ code: 'WAL_SIGNATURE_ADAPTER' });
    await expect(signEip191DigestWithAdapter(digest, {
      getAddress: () => fixtureWriter,
      signMessage: () => null as never,
    })).rejects.toMatchObject({ code: 'WAL_SIGNATURE_ADAPTER' });
    await expect(signEip191DigestWithAdapter(digest, {
      getAddress: () => new Uint8Array(20),
      signMessage: () => signature,
    })).rejects.toMatchObject({ code: 'WAL_SIGNATURE_SIGNER_MISMATCH' });
  });

  it('rejects signature and identity domain confusion', async () => {
    const unsigned = decodeCanonicalCbor(fromHex(vectors.walObjects.first.unsignedTupleCbor)) as readonly CborProtocolValue[];
    const wrongSigner: WalEip191Signer = {
      getAddress: () => fixtureWriter,
      signMessage: () => fromHex(vectors.signedControl.authorCheckpoint.signature),
    };
    await expect(signSingleProtocolTuple('WalObjectV1', unsigned, wrongSigner)).rejects.toMatchObject({
      code: 'WAL_SIGNATURE_SIGNER_MISMATCH',
    });
    expect(() => hashWalV1Domain('not-a-domain' as never, new Uint8Array())).toThrow(
      expect.objectContaining({ code: 'WAL_ID_DOMAIN' }),
    );
    expect(() => protocolTupleId('GetHeadV1' as never, [] as never)).toThrow(
      expect.objectContaining({ code: 'WAL_ID_DOMAIN' }),
    );
    expect(() => protocolTupleId('UnknownV1' as never, [] as never)).toThrow(
      expect.objectContaining({ code: 'WAL_ID_DOMAIN' }),
    );
    expect(() => protocolTupleIdFromBytes('GetHeadV1' as never, Uint8Array.of(0x80))).toThrow(
      expect.objectContaining({ code: 'WAL_ID_DOMAIN' }),
    );
    expect(() => protocolSignatureDigest('GetHeadV1' as never, [])).toThrow(
      expect.objectContaining({ code: 'WAL_SIGNATURE_DOMAIN' }),
    );
    expect(() => protocolSignatureDigest('UnknownV1' as never, [])).toThrow(
      expect.objectContaining({ code: 'WAL_SIGNATURE_DOMAIN' }),
    );
  });

  it('rejects calling single and threshold helpers with the wrong signed shape', async () => {
    const authority = decodeProtocolTuple(
      'AuthoritySetV1',
      fromHex(vectors.signedControl.authoritySet.canonicalBytes),
    );
    const wal = decodeProtocolTuple('WalObjectV1', fromHex(vectors.walObjects.first.canonicalBytes));
    expect(() => verifySingleSignedProtocolTuple('AuthoritySetV1' as never, authority as never)).toThrow(
      expect.objectContaining({ code: 'WAL_SIGNATURE_DOMAIN' }),
    );
    expect(() => verifyThresholdSignedProtocolTuple('WalObjectV1' as never, wal as never, {
      signerAddresses: [fixtureWriter],
      threshold: 1,
    })).toThrow(expect.objectContaining({ code: 'WAL_SIGNATURE_DOMAIN' }));
    await expect(signSingleProtocolTuple('AuthoritySetV1' as never, authority.slice(0, -1), fixtureSigner)).rejects.toMatchObject({
      code: 'WAL_SIGNATURE_DOMAIN',
    });
    await expect(signThresholdProtocolTuple('WalObjectV1' as never, wal.slice(0, -1), [fixtureSigner])).rejects.toMatchObject({
      code: 'WAL_SIGNATURE_DOMAIN',
    });
    const secondPrivateKey = bigint32(1n);
    const zeroDigest = new Uint8Array(32);
    const secondAddress = recoverEip191Address(
      zeroDigest,
      signEip191DigestWithPrivateKey(zeroDigest, secondPrivateKey),
    );
    await expect(signSingleProtocolTuple(
      'WalObjectV1',
      wal.slice(0, -1),
      privateKeySigner(secondPrivateKey, secondAddress),
    )).rejects.toMatchObject({ code: 'WAL_SIGNATURE_SIGNER_MISMATCH' });
  });

  it('round-trips deterministic property samples without a second accepted representation', () => {
    let state = 0x9e37_79b9;
    const next = () => {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      return state >>> 0;
    };
    for (let index = 0; index < 1_000; index += 1) {
      const value = [
        BigInt(next()),
        `ascii-${next()}`,
        Uint8Array.of(next() & 255, next() & 255),
        (next() & 1) === 1,
        null,
      ] as const;
      const first = encodeCanonicalCbor(value);
      const decoded = decodeCanonicalCbor(first);
      const second = encodeCanonicalCbor(decoded);
      expect(second).toEqual(first);
    }
  });
});
