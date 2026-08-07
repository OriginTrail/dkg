import { mkdtemp, open, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { blake3 } from '@noble/hashes/blake3.js';
import { computeAddress, getBytes, hashMessage, Signature, SigningKey } from 'ethers';
import { afterEach, describe, expect, it } from 'vitest';
import { concat, equalBytes, hex, utf8 } from '../src/bytes.js';
import { encodeCanonical } from '../src/cbor.js';
import { RangeStager } from '../src/range-staging.js';
import { FIXTURE_PRIVATE_KEY, type RangeFrame } from '../src/reference.js';
import { DOMAINS, LIMITS } from '../src/schema.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function byteStringHeader(length: number): Uint8Array {
  if (length < 24) return Uint8Array.of(0x40 + length);
  if (length <= 0xff) return Uint8Array.of(0x58, length);
  if (length <= 0xffff) {
    const output = new Uint8Array(3);
    output[0] = 0x59;
    new DataView(output.buffer).setUint16(1, length, false);
    return output;
  }
  const output = new Uint8Array(5);
  output[0] = 0x5a;
  new DataView(output.buffer).setUint32(1, length, false);
  return output;
}

async function createLargeWalObject(path: string, payloadLength: number): Promise<{ id: Uint8Array; length: bigint }> {
  const namespaceId = blake3(utf8('large-object-namespace'));
  const writerId = getBytes(computeAddress(FIXTURE_PRIVATE_KEY));
  const fixedFields = [
    encodeCanonical(1n),
    encodeCanonical(namespaceId),
    encodeCanonical(writerId),
    encodeCanonical(1n),
    encodeCanonical(0n),
    encodeCanonical(null),
    byteStringHeader(payloadLength)
  ];
  const domain = utf8(DOMAINS.walObjectSignature);
  const signingHasher = blake3.create({});
  signingHasher.update(domain);
  signingHasher.update(Uint8Array.of(0x87));
  for (const field of fixedFields) signingHasher.update(field);

  const idHasher = blake3.create({});
  const file = await open(path, 'w');
  try {
    const prefix = concat(Uint8Array.of(0x88), ...fixedFields);
    await file.write(prefix);
    idHasher.update(prefix);
    const chunk = new Uint8Array(65_536);
    let written = 0;
    while (written < payloadLength) {
      const length = Math.min(chunk.length, payloadLength - written);
      for (let index = 0; index < length; index += 1) chunk[index] = ((written + index) * 31 + 7) & 255;
      const bytes = chunk.subarray(0, length);
      await file.write(bytes);
      signingHasher.update(bytes);
      idHasher.update(bytes);
      written += length;
    }
    const signature = getBytes(Signature.from(
      new SigningKey(FIXTURE_PRIVATE_KEY).sign(hashMessage(signingHasher.digest()))
    ).serialized);
    const encodedSignature = encodeCanonical(signature);
    await file.write(encodedSignature);
    idHasher.update(encodedSignature);
    await file.sync();
  } finally {
    await file.close();
  }
  const details = await stat(path, { bigint: true });
  return { id: idHasher.digest(), length: details.size };
}

async function readRange(path: string, id: Uint8Array, total: bigint, offset: number, length: number): Promise<RangeFrame> {
  const file = await open(path, 'r');
  try {
    const bytes = new Uint8Array(length);
    const result = await file.read(bytes, 0, length, offset);
    return { walObjectId: id, totalObjectLength: total, offset: BigInt(offset), bytes: bytes.slice(0, result.bytesRead) };
  } finally {
    await file.close();
  }
}

describe('large whole-object range staging', () => {
  it('resumes after restart with bounded buffers and atomically promotes only the complete object', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dkg-wal-001-large-'));
    temporaryDirectories.push(root);
    const source = join(root, 'source.wal');
    const payloadLength = 16 * 1_048_576;
    const object = await createLargeWalObject(source, payloadLength);
    const options = {
      stagingRoot: join(root, 'staging'),
      finalRoot: join(root, 'objects'),
      walObjectId: object.id,
      totalObjectLength: object.length,
      quotaBytes: object.length + 1_048_576n,
      verificationBufferBytes: 65_536
    };
    const firstProcess = new RangeStager(options);
    await firstProcess.initialize();
    const chunkBytes = LIMITS.walObjectRangeBytes;
    await firstProcess.accept(await readRange(source, object.id, object.length, 0, chunkBytes));
    await firstProcess.accept(await readRange(source, object.id, object.length, chunkBytes, chunkBytes));
    await expect(stat(firstProcess.finalPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await firstProcess.isComplete()).toBe(false);

    const restarted = new RangeStager(options);
    await restarted.initialize();
    expect((await restarted.parts()).length).toBe(2);
    const totalNumber = Number(object.length);
    const offsets: number[] = [];
    for (let offset = chunkBytes * 2; offset < totalNumber; offset += chunkBytes) offsets.push(offset);
    offsets.reverse();
    for (const offset of offsets) {
      await restarted.accept(await readRange(source, object.id, object.length, offset, Math.min(chunkBytes, totalNumber - offset)));
    }
    expect(await restarted.accept(await readRange(source, object.id, object.length, 0, chunkBytes))).toBe('duplicate');
    expect(await restarted.isComplete()).toBe(true);
    await expect(stat(restarted.finalPath)).rejects.toMatchObject({ code: 'ENOENT' });

    const verification = await restarted.promote();
    expect(equalBytes(verification.id, object.id)).toBe(true);
    expect(verification.payloadLength).toBe(BigInt(payloadLength));
    expect(verification.maximumReadBufferBytes).toBeLessThanOrEqual(65_536);
    expect(BigInt(payloadLength)).toBeGreaterThanOrEqual(BigInt(verification.maximumReadBufferBytes) * 256n);
    expect((await stat(restarted.finalPath)).size).toBe(Number(object.length));
  }, 30_000);

  it('fails closed on quotas, dishonest resume lengths, cancellation, and conflicting duplicates', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dkg-wal-001-limits-'));
    temporaryDirectories.push(root);
    const source = join(root, 'source.wal');
    const object = await createLargeWalObject(source, 1_048_576);
    expect(() => new RangeStager({
      stagingRoot: join(root, 'quota-staging'),
      finalRoot: join(root, 'objects'),
      walObjectId: object.id,
      totalObjectLength: object.length,
      quotaBytes: object.length - 1n
    })).toThrow(/quota/);

    const options = {
      stagingRoot: join(root, 'staging'),
      finalRoot: join(root, 'objects'),
      walObjectId: object.id,
      totalObjectLength: object.length,
      quotaBytes: object.length
    };
    const stager = new RangeStager(options);
    await stager.initialize();
    const first = await readRange(source, object.id, object.length, 0, 65_536);
    await stager.accept(first);
    const corrupt = { ...first, bytes: new Uint8Array(first.bytes) };
    corrupt.bytes[0] ^= 1;
    await expect(stager.accept(corrupt)).rejects.toThrow(/disagree/);
    for (let offset = 1; offset < 16; offset += 1) {
      await stager.accept(await readRange(source, object.id, object.length, offset, 65_536));
    }
    await expect(stager.accept(await readRange(source, object.id, object.length, 16, 65_536))).rejects.toThrow(/quota/);

    const dishonest = new RangeStager({ ...options, totalObjectLength: object.length + 1n, quotaBytes: object.length + 1n });
    await expect(dishonest.initialize()).rejects.toThrow(/dishonest/);
    await stager.cancel();
    await expect(stat(stager.objectDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
