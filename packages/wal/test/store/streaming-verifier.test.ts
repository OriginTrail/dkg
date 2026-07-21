import { mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { walObjectId } from '../../src/reconciliation/ids.js';
import { verifyWalObjectFile } from '../../src/store/streaming-verifier.js';

const vectors = JSON.parse(await readFile(
  new URL('../../../../conformance/wal-v1/vectors/protocol-v1.json', import.meta.url),
  'utf8',
));
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

function fromHex(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, 'hex'));
}

async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'dkg-wal-verifier-'));
  roots.push(path);
  return path;
}

async function verifyRaw(
  bytes: Uint8Array,
  expectedId = fromHex(vectors.walObjects.first.walObjectId),
  options = { maximumObjectBytes: 1_073_741_824n, readBufferBytes: 31 },
) {
  const path = join(await root(), 'object.wal');
  await writeFile(path, bytes);
  return verifyWalObjectFile(path, expectedId, options);
}

describe('streaming WalObjectV1 verifier adversarial grammar', () => {
  it.each([
    ['truncated tuple', Uint8Array.of(0x88)],
    ['wrong tuple major', Uint8Array.of(0x01)],
    ['wrong tuple arity', Uint8Array.of(0x87)],
    ['reserved header argument', Uint8Array.of(0x88, 0x01, 0x5c)],
    ['indefinite header argument', Uint8Array.of(0x88, 0x01, 0x5f)],
    ['non-shortest u8 argument', Uint8Array.of(0x88, 0x01, 0x58, 0x01)],
    ['non-shortest u16 argument', Uint8Array.of(0x88, 0x01, 0x59, 0x00, 0x20)],
    ['non-shortest u32 argument', Uint8Array.of(0x88, 0x01, 0x5a, 0x00, 0x00, 0x00, 0x20)],
    ['non-shortest u64 argument', Uint8Array.of(0x88, 0x01, 0x5b, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00)],
    ['wrong unsigned major', Uint8Array.of(0x88, 0x61)],
    ['wrong byte-string major', Uint8Array.of(0x88, 0x01, 0x01)],
    ['wrong fixed byte-string length', Uint8Array.of(0x88, 0x01, 0x41)],
  ])('rejects %s', async (_name, bytes) => {
    await expect(verifyRaw(bytes)).rejects.toMatchObject({ code: 'WAL_STORE_INVALID_OBJECT' });
  });

  it('rejects unsupported versions, invalid sequence links, trailing bytes, signer mismatch, and malformed signatures', async () => {
    const first = fromHex(vectors.walObjects.first.canonicalBytes);
    const second = fromHex(vectors.walObjects.second.canonicalBytes);
    const cases: Uint8Array[] = [];
    const version = new Uint8Array(first); version[1] = 2; cases.push(version);
    const nonzeroNull = new Uint8Array(first); nonzeroNull[58] = 1; cases.push(nonzeroNull);
    const zeroPrevious = new Uint8Array(second); zeroPrevious[58] = 0; cases.push(zeroPrevious);
    cases.push(Uint8Array.from([...first, 0]));
    const writerMismatch = new Uint8Array(first); writerMismatch[37] ^= 1; cases.push(writerMismatch);
    const malformedSignature = new Uint8Array(first); malformedSignature.fill(0, malformedSignature.length - 65); cases.push(malformedSignature);
    for (const bytes of cases) {
      await expect(verifyRaw(bytes)).rejects.toMatchObject({ code: 'WAL_STORE_INVALID_OBJECT' });
    }
  });

  it('validates its direct-call identity and resource boundary', async () => {
    const first = fromHex(vectors.walObjects.first.canonicalBytes);
    await expect(verifyRaw(first, new Uint8Array(31))).rejects.toMatchObject({ code: 'WAL_STORE_INVALID_OBJECT_ID' });
    for (const options of [
      { maximumObjectBytes: 0n, readBufferBytes: 1 },
      { maximumObjectBytes: 8_589_934_593n, readBufferBytes: 1 },
      { maximumObjectBytes: 1n, readBufferBytes: Number.NaN },
      { maximumObjectBytes: 1n, readBufferBytes: 0 },
      { maximumObjectBytes: 1n, readBufferBytes: 1_048_577 },
    ]) {
      await expect(verifyRaw(first, fromHex(vectors.walObjects.first.walObjectId), options)).rejects.toMatchObject({
        code: 'WAL_STORE_INVALID_CONFIGURATION',
      });
    }
    await expect(verifyRaw(first, fromHex(vectors.walObjects.first.walObjectId), {
      maximumObjectBytes: 1n,
      readBufferBytes: 1,
    })).rejects.toMatchObject({ code: 'WAL_STORE_OBJECT_TOO_LARGE' });
  });

  it('rejects directories and sparse files beyond the hard whole-object limit before parsing', async () => {
    const directory = await root();
    await expect(verifyWalObjectFile(directory, walObjectId(new Uint8Array(32)), {
      maximumObjectBytes: 8_589_934_592n,
      readBufferBytes: 1,
    })).rejects.toMatchObject({ code: 'WAL_STORE_PATH_UNSAFE' });

    const sparse = join(await root(), 'sparse.wal');
    const handle = await open(sparse, 'w');
    await handle.truncate(8_589_934_593);
    await handle.close();
    await expect(verifyWalObjectFile(sparse, walObjectId(new Uint8Array(32)), {
      maximumObjectBytes: 8_589_934_592n,
      readBufferBytes: 1,
    })).rejects.toMatchObject({ code: 'WAL_STORE_OBJECT_TOO_LARGE' });
  });
});
