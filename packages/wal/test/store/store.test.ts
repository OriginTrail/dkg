import { readFile, writeFile, mkdir, mkdtemp, readdir, rm, symlink, truncate } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { PROTOCOL_TUPLES } from '../../src/protocol/schema.js';
import {
  createWalObjectV1,
  verifyWalObjectV1,
  type UnsignedWalObjectV1,
} from '../../src/protocol/wal-object.js';
import {
  recoverEip191Address,
  signEip191DigestWithPrivateKey,
  type WalEip191Signer,
} from '../../src/protocol/signatures.js';
import { walObjectId, type WalObjectId } from '../../src/reconciliation/ids.js';
import { FileWalObjectStore } from '../../src/store/file-store.js';
import { FileWalObjectRangeReceiver } from '../../src/store/range-receiver.js';
import { verifyWalObjectFile } from '../../src/store/streaming-verifier.js';
import { WalObjectStore } from '../../src/store/types.js';

const vectors = JSON.parse(await readFile(
  new URL('../../../../conformance/wal-v1/vectors/protocol-v1.json', import.meta.url),
  'utf8',
));

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

function fromHex(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value.startsWith('0x') ? value.slice(2) : value, 'hex'));
}

function hex(value: Uint8Array): string {
  return Buffer.from(value).toString('hex');
}

async function temporaryRoot(label: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), `dkg-wal-${label}-`));
  temporaryRoots.push(path);
  return path;
}

async function* chunks(bytes: Uint8Array, size = 37): AsyncIterable<Uint8Array> {
  for (let offset = 0; offset < bytes.length; offset += size) {
    yield bytes.slice(offset, Math.min(offset + size, bytes.length));
  }
}

async function collect(source: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const values: Uint8Array[] = [];
  let length = 0;
  for await (const value of source) {
    values.push(value);
    length += value.length;
  }
  const output = new Uint8Array(length);
  let offset = 0;
  for (const value of values) {
    output.set(value, offset);
    offset += value.length;
  }
  return output;
}

async function collectIds(source: AsyncIterable<WalObjectId>): Promise<WalObjectId[]> {
  const output: WalObjectId[] = [];
  for await (const id of source) output.push(id);
  return output;
}

function fixture(name: 'first' | 'second' | 'onePayloadByteChanged' = 'first') {
  const value = vectors.walObjects[name];
  return {
    bytes: fromHex(value.canonicalBytes),
    id: walObjectId(fromHex(value.walObjectId)),
  };
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code });
}

async function expectIterableCode(source: AsyncIterable<Uint8Array>, code: string): Promise<void> {
  await expectCode(collect(source), code);
}

class MemoryWalObjectStore extends WalObjectStore {
  private readonly values = new Map<string, Uint8Array>();

  async has(id: WalObjectId): Promise<boolean> {
    return this.values.has(hex(id));
  }

  async *read(id: WalObjectId, offset = 0n, length?: number): AsyncIterable<Uint8Array> {
    const value = this.values.get(hex(id));
    if (!value) throw new Error('missing');
    const start = Number(offset);
    yield value.slice(start, length === undefined ? undefined : start + length);
  }

  async put(expectedId: WalObjectId, source: AsyncIterable<Uint8Array>): Promise<void> {
    if (await this.has(expectedId)) return;
    const bytes = await collect(source);
    const verified = verifyWalObjectV1(bytes);
    if (hex(verified.walObjectId) !== hex(expectedId)) throw new Error('wrong ID');
    this.values.set(hex(expectedId), bytes);
  }

  async *ids(): AsyncIterable<WalObjectId> {
    for (const id of [...this.values.keys()].sort()) yield walObjectId(fromHex(id));
  }
}

describe.each([
  ['memory', async (): Promise<WalObjectStore> => new MemoryWalObjectStore()],
  ['filesystem', async (): Promise<WalObjectStore> => new FileWalObjectStore({
    root: join(await temporaryRoot('contract'), 'objects'),
    readBufferBytes: 17,
  })],
] as const)('WalObjectStore contract: %s', (_name, createStore) => {
  it('stores only complete objects, reads whole-object offsets, is idempotent, and sorts IDs', async () => {
    const store = await createStore();
    const first = fixture('first');
    const second = fixture('second');
    expect(await store.has(first.id)).toBe(false);
    await store.put(second.id, chunks(second.bytes, 11));
    await store.put(first.id, chunks(first.bytes, 7));
    await store.put(first.id, chunks(Uint8Array.of(0xff)));
    expect(await store.has(first.id)).toBe(true);
    expect(await collect(store.read(first.id))).toEqual(first.bytes);
    expect(await collect(store.read(first.id, 3n, 19))).toEqual(first.bytes.slice(3, 22));
    expect((await collectIds(store.ids())).map(hex)).toEqual(
      [hex(first.id), hex(second.id)].sort(),
    );
  });
});

describe('FileWalObjectStore admission and filesystem safety', () => {
  it('validates configuration, IDs, ranges, missing objects, and bounded source types', async () => {
    const root = join(await temporaryRoot('validation'), 'objects');
    expect(() => new FileWalObjectStore(undefined as never)).toThrow();
    expect(() => new FileWalObjectStore({ root: '' })).toThrow();
    expect(() => new FileWalObjectStore({ root: 'relative' })).toThrow();
    expect(() => new FileWalObjectStore({ root, maximumObjectBytes: 0n })).toThrow();
    expect(() => new FileWalObjectStore({ root, maximumObjectBytes: 8_589_934_593n })).toThrow();
    expect(() => new FileWalObjectStore({ root, readBufferBytes: 0 })).toThrow();
    expect(() => new FileWalObjectStore({ root, readBufferBytes: Number.NaN })).toThrow();
    expect(() => new FileWalObjectStore({ root, verificationBufferBytes: 1_048_577 })).toThrow();
    const store = new FileWalObjectStore({ root, maximumObjectBytes: 10_000n });
    expect(() => store.pathFor(new Uint8Array(31) as WalObjectId)).toThrow();
    expect(() => store.pathFor('id' as never)).toThrow();
    await expectCode(store.has(new Uint8Array(31) as WalObjectId), 'WAL_STORE_INVALID_OBJECT_ID');
    const missing = fixture().id;
    await expectIterableCode(store.read(missing), 'WAL_STORE_OBJECT_NOT_FOUND');
    await expectIterableCode(store.read(missing, -1n), 'WAL_STORE_INVALID_READ_RANGE');
    await expectIterableCode(store.read(missing, 1 as never), 'WAL_STORE_INVALID_READ_RANGE');
    await expectIterableCode(store.read(missing, BigInt(Number.MAX_SAFE_INTEGER) + 1n), 'WAL_STORE_INVALID_READ_RANGE');
    await expectIterableCode(store.read(missing, 0n, -1), 'WAL_STORE_INVALID_READ_RANGE');
    await expectIterableCode(store.read(missing, 0n, Number.NaN), 'WAL_STORE_INVALID_READ_RANGE');
    async function* invalidChunks(): AsyncIterable<Uint8Array> { yield 'bytes' as never; }
    await expectCode(store.put(missing, invalidChunks()), 'WAL_STORE_INVALID_OBJECT');
    async function* emptyThenValid(): AsyncIterable<Uint8Array> { yield new Uint8Array(); yield fixture().bytes; }
    await store.put(missing, emptyThenValid());
    async function* throwsString(): AsyncIterable<Uint8Array> { throw 'source failed'; }
    await expectCode(new FileWalObjectStore({ root: join(await temporaryRoot('source-error'), 'objects') }).put(
      missing,
      throwsString(),
    ), 'WAL_STORE_IO');
    const limited = new FileWalObjectStore({ root: join(await temporaryRoot('size'), 'objects'), maximumObjectBytes: 10n });
    await expectCode(limited.put(missing, chunks(fixture().bytes)), 'WAL_STORE_OBJECT_TOO_LARGE');
  });

  it('rejects malformed, noncanonical, wrongly signed, and wrongly addressed bytes', async () => {
    const root = join(await temporaryRoot('invalid'), 'objects');
    const first = fixture();
    for (const [index, invalid] of vectors.invalidWalObjects.entries()) {
      const store = new FileWalObjectStore({ root: join(root, String(index)) });
      await expect(store.put(first.id, chunks(fromHex(invalid.bytes)))).rejects.toMatchObject({
        code: expect.stringMatching(/^WAL_STORE_(INVALID_OBJECT|OBJECT_ID_MISMATCH)$/),
      });
      expect(await store.has(first.id)).toBe(false);
    }
    const store = new FileWalObjectStore({ root: join(root, 'wrong-id') });
    await expectCode(store.put(fixture('second').id, chunks(first.bytes)), 'WAL_STORE_OBJECT_ID_MISMATCH');
    expect(await store.has(fixture('second').id)).toBe(false);
  });

  it('supports clamped and empty reads and refuses unsafe final, root, shard, and orphan paths', async () => {
    const base = await temporaryRoot('paths');
    const root = join(base, 'objects');
    const store = new FileWalObjectStore({ root });
    const first = fixture();
    await store.put(first.id, chunks(first.bytes));
    expect(await collect(store.read(first.id, BigInt(first.bytes.length), 10))).toEqual(new Uint8Array());
    expect(await collect(store.read(first.id, 4n, 100_000))).toEqual(first.bytes.slice(4));
    await expectIterableCode(store.read(first.id, BigInt(first.bytes.length + 1)), 'WAL_STORE_INVALID_READ_RANGE');

    const unsafeFinal = new FileWalObjectStore({ root: join(base, 'unsafe-final') });
    const finalPath = unsafeFinal.pathFor(first.id);
    await mkdir(join(base, 'unsafe-final', hex(first.id).slice(0, 2)), { recursive: true });
    await symlink('/dev/null', finalPath);
    await expectCode(unsafeFinal.has(first.id), 'WAL_STORE_PATH_UNSAFE');
    await expectIterableCode(unsafeFinal.read(first.id), 'WAL_STORE_PATH_UNSAFE');

    const directoryFinal = new FileWalObjectStore({ root: join(base, 'directory-final') });
    await mkdir(directoryFinal.pathFor(first.id), { recursive: true });
    await expectCode(directoryFinal.has(first.id), 'WAL_STORE_PATH_UNSAFE');
    await expectIterableCode(directoryFinal.read(first.id), 'WAL_STORE_PATH_UNSAFE');

    const unsafeRootPath = join(base, 'root-link');
    await symlink(root, unsafeRootPath);
    const unsafeRoot = new FileWalObjectStore({ root: unsafeRootPath });
    await expectCode(unsafeRoot.put(first.id, chunks(first.bytes)), 'WAL_STORE_PATH_UNSAFE');
    await expect(collectIds(unsafeRoot.ids())).rejects.toMatchObject({ code: 'WAL_STORE_PATH_UNSAFE' });

    const unsafeShardRoot = join(base, 'unsafe-shard');
    await mkdir(unsafeShardRoot);
    await symlink(root, join(unsafeShardRoot, '00'));
    const unsafeShard = new FileWalObjectStore({ root: unsafeShardRoot });
    await expect(collectIds(unsafeShard.ids())).rejects.toMatchObject({ code: 'WAL_STORE_PATH_UNSAFE' });
    const zeroShardId = walObjectId(Uint8Array.from([0, ...new Uint8Array(31)]));
    await expectCode(unsafeShard.has(zeroShardId), 'WAL_STORE_PATH_UNSAFE');

    const orphanStore = new FileWalObjectStore({ root: join(base, 'orphans') });
    await mkdir(join(orphanStore.root, hex(first.id).slice(0, 2)), { recursive: true });
    const orphan = join(orphanStore.root, hex(first.id).slice(0, 2), `.${hex(first.id)}.12345678-1234-1234-1234-123456789abc.tmp`);
    await writeFile(orphan, Uint8Array.of(1));
    expect(await orphanStore.cleanupOrphans(Date.now() + 1_000)).toBe(1);
    expect(await orphanStore.cleanupOrphans(Date.now() - 1_000)).toBe(0);
    await expectCode(orphanStore.cleanupOrphans(Number.NaN), 'WAL_STORE_INVALID_CONFIGURATION');
    await writeFile(join(orphanStore.root, 'aa'), Uint8Array.of(1));
    await writeFile(join(orphanStore.root, hex(first.id).slice(0, 2), 'ignored'), Uint8Array.of(1));
    const retainedOrphan = join(orphanStore.root, hex(first.id).slice(0, 2), `.${hex(first.id)}.bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb.tmp`);
    await writeFile(retainedOrphan, Uint8Array.of(1));
    expect(await orphanStore.cleanupOrphans(Date.now() - 1_000)).toBe(0);
    const unsafeOrphan = join(orphanStore.root, hex(first.id).slice(0, 2), `.${hex(first.id)}.aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.tmp`);
    await symlink('/dev/null', unsafeOrphan);
    await expectCode(orphanStore.cleanupOrphans(Date.now() + 1_000), 'WAL_STORE_PATH_UNSAFE');

    await expectCode((orphanStore as never as { ensureSafeDirectory(path: string): Promise<void> }).ensureSafeDirectory(join(base, 'escape')), 'WAL_STORE_PATH_UNSAFE');
    await expectCode((orphanStore as never as { assertSafeExistingAncestors(path: string): Promise<void> }).assertSafeExistingAncestors(join(base, 'escape')), 'WAL_STORE_PATH_UNSAFE');
    const unsafeInnerShard = join(orphanStore.root, 'bb');
    await writeFile(unsafeInnerShard, Uint8Array.of(1));
    await expectCode((orphanStore as never as { ensureSafeDirectory(path: string): Promise<void> }).ensureSafeDirectory(unsafeInnerShard), 'WAL_STORE_PATH_UNSAFE');

    const entryRoot = join(base, 'entries');
    const entryStore = new FileWalObjectStore({ root: entryRoot });
    const entryShard = join(entryRoot, 'cc');
    await mkdir(entryShard, { recursive: true });
    await writeFile(join(entryShard, `${'1'.repeat(62)}.wal`), Uint8Array.of(1));
    await writeFile(join(entryShard, `${'0'.repeat(62)}.wal`), Uint8Array.of(1));
    expect((await collectIds(entryStore.ids())).map(hex)).toEqual([
      `cc${'0'.repeat(62)}`,
      `cc${'1'.repeat(62)}`,
    ]);
    await mkdir(join(entryShard, `${'2'.repeat(62)}.wal`));
    await expect(collectIds(entryStore.ids())).rejects.toMatchObject({ code: 'WAL_STORE_PATH_UNSAFE' });
  });

  it('detects a file truncated between streamed read chunks', async () => {
    const store = new FileWalObjectStore({ root: join(await temporaryRoot('truncate'), 'objects'), readBufferBytes: 8 });
    const first = fixture();
    await store.put(first.id, chunks(first.bytes));
    const iterator = store.read(first.id)[Symbol.asyncIterator]();
    expect((await iterator.next()).done).toBe(false);
    await truncate(store.pathFor(first.id), 8);
    await expect(iterator.next()).rejects.toMatchObject({ code: 'WAL_STORE_IO' });
  });

  it.each(['object-file-synced', 'object-renamed', 'object-directory-synced'] as const)(
    'recovers safely after simulated crash at %s',
    async (faultPoint) => {
      const root = join(await temporaryRoot(`store-fault-${faultPoint}`), 'objects');
      const first = fixture();
      const crashing = new FileWalObjectStore({
        root,
        durabilityHook: point => { if (point === faultPoint) throw new Error('simulated crash'); },
      });
      await expectCode(crashing.put(first.id, chunks(first.bytes)), 'WAL_STORE_IO');
      const restarted = new FileWalObjectStore({ root });
      if (!await restarted.has(first.id)) await restarted.put(first.id, chunks(first.bytes));
      expect(await collect(restarted.read(first.id))).toEqual(first.bytes);
    },
  );
});

describe('resumable whole-object ranges', () => {
  async function setup(label: string, options: Record<string, unknown> = {}) {
    const base = await temporaryRoot(label);
    const store = new FileWalObjectStore({ root: join(base, 'objects') });
    const receiver = new FileWalObjectRangeReceiver({
      stagingRoot: join(base, 'range-staging'),
      store,
      maximumRangeBytes: 100,
      assemblyBufferBytes: 23,
      ...options,
    });
    return { base, store, receiver };
  }

  it('validates every frozen receiver resource limit', async () => {
    const base = await temporaryRoot('range-config');
    const store = new MemoryWalObjectStore();
    const root = join(base, 'ranges');
    expect(() => new FileWalObjectRangeReceiver(undefined as never)).toThrow();
    expect(() => new FileWalObjectRangeReceiver({ stagingRoot: 'relative', store })).toThrow();
    expect(() => new FileWalObjectRangeReceiver({ stagingRoot: root, store: null as never })).toThrow();
    expect(() => new FileWalObjectRangeReceiver({ stagingRoot: root, store, maximumObjectBytes: 0n })).toThrow();
    expect(() => new FileWalObjectRangeReceiver({ stagingRoot: root, store, maximumObjectBytes: 8_589_934_593n })).toThrow();
    expect(() => new FileWalObjectRangeReceiver({ stagingRoot: root, store, maximumStagedBytes: 0n })).toThrow();
    for (const option of ['maximumRangeBytes', 'maximumPartsPerObject', 'maximumConcurrentObjects', 'assemblyBufferBytes'] as const) {
      expect(() => new FileWalObjectRangeReceiver({ stagingRoot: root, store, [option]: 0 })).toThrow();
      expect(() => new FileWalObjectRangeReceiver({ stagingRoot: root, store, [option]: Number.NaN })).toThrow();
      expect(() => new FileWalObjectRangeReceiver({ stagingRoot: root, store, [option]: 1_048_577 })).toThrow();
    }
    expect(() => new FileWalObjectRangeReceiver({ stagingRoot: root, store, stagingLifetimeMs: 0 })).toThrow();
    expect(() => new FileWalObjectRangeReceiver({ stagingRoot: root, store, stagingLifetimeMs: Number.NaN })).toThrow();
  });

  it('resumes out of order across restarts and accepts agreeing overlaps, duplicates, and providers', async () => {
    const first = fixture();
    const { base, store, receiver } = await setup('resume');
    const total = BigInt(first.bytes.length);
    const initialMissing = await receiver.missing(first.id, total, 80);
    expect(initialMissing.map(range => range.offset)).toEqual([0n, 80n, 160n, 240n, 320n, 400n, 480n]);
    expect(initialMissing.reduce((sum, range) => sum + BigInt(range.maximumLength), 0n)).toBe(total);
    expect(await receiver.accept({ walObjectId: first.id, totalObjectLength: total, offset: 100n, bytes: first.bytes.slice(100, 180) })).toBe('stored');
    expect(await receiver.accept({ walObjectId: first.id, totalObjectLength: total, offset: 120n, bytes: first.bytes.slice(120, 160) })).toBe('duplicate');
    expect(await receiver.accept({ walObjectId: first.id, totalObjectLength: total, offset: 80n, bytes: first.bytes.slice(80, 130) })).toBe('stored');
    const restarted = new FileWalObjectRangeReceiver({
      stagingRoot: join(base, 'range-staging'), store, maximumRangeBytes: 100, assemblyBufferBytes: 23,
    });
    expect(await restarted.missing(first.id, total, 100)).toEqual([
      { offset: 0n, maximumLength: 80 },
      { offset: 180n, maximumLength: 100 },
      { offset: 280n, maximumLength: 100 },
      { offset: 380n, maximumLength: 100 },
      { offset: 480n, maximumLength: 26 },
    ]);
    for (const range of (await restarted.missing(first.id, total, 100)).filter(range => range.offset > 0n)) {
      expect(await restarted.accept({
        walObjectId: first.id,
        totalObjectLength: total,
        offset: range.offset,
        bytes: first.bytes.slice(Number(range.offset), Number(range.offset) + range.maximumLength),
      })).toBe('stored');
    }
    expect(await restarted.accept({ walObjectId: first.id, totalObjectLength: total, offset: 0n, bytes: first.bytes.slice(0, 80) })).toBe('complete');
    expect(await collect(store.read(first.id))).toEqual(first.bytes);
    expect(await restarted.missing(first.id, total)).toEqual([]);
    expect(await restarted.accept({ walObjectId: first.id, totalObjectLength: total, offset: total, bytes: new Uint8Array() })).toBe('complete');
  });

  it('rejects dishonest ranges, mismatched resume metadata, overlap conflicts, gaps, quotas, parts, and concurrency', async () => {
    const first = fixture();
    const total = BigInt(first.bytes.length);
    const { receiver } = await setup('range-invalid', { maximumStagedBytes: 120n, maximumPartsPerObject: 2, maximumConcurrentObjects: 1 });
    const valid = { walObjectId: first.id, totalObjectLength: total, offset: 0n, bytes: first.bytes.slice(0, 60) };
    await expectCode(receiver.accept({ ...valid, walObjectId: new Uint8Array(31) as WalObjectId }), 'WAL_STORE_INVALID_OBJECT_ID');
    await expectCode(receiver.accept({ ...valid, totalObjectLength: 0n }), 'WAL_STORE_OBJECT_TOO_LARGE');
    await expectCode(receiver.accept({ ...valid, offset: -1n }), 'WAL_STAGE_INVALID_RANGE');
    await expectCode(receiver.accept({ ...valid, offset: 1 as never }), 'WAL_STAGE_INVALID_RANGE');
    await expectCode(receiver.accept({ ...valid, offset: total + 1n }), 'WAL_STAGE_INVALID_RANGE');
    await expectCode(receiver.accept({ ...valid, bytes: new Uint8Array(101) }), 'WAL_STAGE_INVALID_RANGE');
    await expectCode(receiver.accept({ ...valid, bytes: new Uint8Array() }), 'WAL_STAGE_INVALID_RANGE');
    await expectCode(receiver.accept({ ...valid, bytes: 'not-bytes' as never }), 'WAL_STAGE_INVALID_RANGE');
    await expectCode(receiver.accept({ ...valid, totalObjectLength: 1 as never }), 'WAL_STORE_OBJECT_TOO_LARGE');
    await expectCode(receiver.accept({ ...valid, offset: total - 1n, bytes: Uint8Array.of(1, 2) }), 'WAL_STAGE_INVALID_RANGE');
    await expectCode(receiver.missing(first.id, total, 101), 'WAL_STAGE_INVALID_RANGE');
    expect(await receiver.accept(valid)).toBe('stored');
    await expectCode(receiver.accept({ ...valid, totalObjectLength: total - 1n }), 'WAL_STAGE_TOTAL_LENGTH_MISMATCH');
    const conflict = first.bytes.slice(30, 50); conflict[0] ^= 1;
    await expectCode(receiver.accept({ ...valid, offset: 30n, bytes: conflict }), 'WAL_STAGE_RANGE_CONFLICT');
    expect(await receiver.accept({ ...valid, offset: 60n, bytes: first.bytes.slice(60, 100) })).toBe('stored');
    await expectCode(receiver.accept({ ...valid, offset: 100n, bytes: first.bytes.slice(100, 110) }), 'WAL_STAGE_PART_LIMIT');
    await expectCode(receiver.finalize(first.id, total), 'WAL_STAGE_INCOMPLETE');
    const second = fixture('second');
    await expectCode(receiver.accept({ walObjectId: second.id, totalObjectLength: BigInt(second.bytes.length), offset: 0n, bytes: second.bytes.slice(0, 1) }), 'WAL_STAGE_CONCURRENCY_LIMIT');

    const quota = (await setup('range-quota', { maximumStagedBytes: 10n })).receiver;
    await expectCode(quota.accept(valid), 'WAL_STAGE_QUOTA_EXCEEDED');
  });

  it('serializes simultaneous providers for one ID without duplicate durable parts', async () => {
    const first = fixture();
    const { receiver } = await setup('concurrent-provider');
    const frame = {
      walObjectId: first.id,
      totalObjectLength: BigInt(first.bytes.length),
      offset: 0n,
      bytes: first.bytes.slice(0, 50),
    };
    expect((await Promise.all([receiver.accept(frame), receiver.accept(frame)])).sort()).toEqual(['duplicate', 'stored']);
  });

  it('admits a zero-payload object exactly at a configured policy ceiling', async () => {
    const privateKey = fromHex(vectors.fixturePrivateKey);
    const digest = new Uint8Array(32);
    const writer = recoverEip191Address(digest, signEip191DigestWithPrivateKey(digest, privateKey));
    const signer: WalEip191Signer = {
      address: writer,
      signMessage: value => signEip191DigestWithPrivateKey(value, privateKey),
    };
    const object = await createWalObjectV1([
      1n, new Uint8Array(32).fill(4), writer, 0n, 0n, null, new Uint8Array(),
    ], signer);
    const base = await temporaryRoot('zero-payload');
    const ceiling = BigInt(object.canonicalBytes.length);
    const store = new FileWalObjectStore({ root: join(base, 'objects'), maximumObjectBytes: ceiling });
    const receiver = new FileWalObjectRangeReceiver({
      stagingRoot: join(base, 'ranges'), store, maximumObjectBytes: ceiling,
    });
    const id = walObjectId(object.walObjectId);
    expect(await receiver.accept({
      walObjectId: id,
      totalObjectLength: ceiling,
      offset: 0n,
      bytes: object.canonicalBytes,
    })).toBe('complete');
    expect(verifyWalObjectV1(await collect(store.read(id))).payloadBytes).toEqual(new Uint8Array());
  });

  it('fails closed on unsafe staging roots, entries, metadata, and part files', async () => {
    const first = fixture();
    const total = BigInt(first.bytes.length);
    const firstByte = { walObjectId: first.id, totalObjectLength: total, offset: 0n, bytes: first.bytes.slice(0, 1) };

    const unsafeRootSetup = await setup('unsafe-range-root');
    await writeFile(unsafeRootSetup.receiver.stagingRoot, Uint8Array.of(1));
    await expectCode(unsafeRootSetup.receiver.accept(firstByte), 'WAL_STORE_PATH_UNSAFE');

    const unsafeCleanup = await setup('unsafe-range-cleanup');
    await mkdir(unsafeCleanup.receiver.stagingRoot, { recursive: true });
    await writeFile(join(unsafeCleanup.receiver.stagingRoot, 'ignored'), Uint8Array.of(1));
    await writeFile(join(unsafeCleanup.receiver.stagingRoot, '0'.repeat(64)), Uint8Array.of(1));
    await expectCode(unsafeCleanup.receiver.cleanupExpired(), 'WAL_STORE_PATH_UNSAFE');

    const ignoredCleanup = await setup('ignored-range-cleanup');
    await mkdir(ignoredCleanup.receiver.stagingRoot, { recursive: true });
    await writeFile(join(ignoredCleanup.receiver.stagingRoot, 'ignored'), Uint8Array.of(1));
    expect(await ignoredCleanup.receiver.cleanupExpired()).toBe(0);

    const metadataAbsent = await setup('metadata-absent-cleanup');
    await mkdir(join(metadataAbsent.receiver.stagingRoot, 'a'.repeat(64)), { recursive: true });
    expect(await metadataAbsent.receiver.cleanupExpired()).toBe(1);

    const unsafeActive = await setup('unsafe-range-active');
    await mkdir(unsafeActive.receiver.stagingRoot, { recursive: true });
    await writeFile(join(unsafeActive.receiver.stagingRoot, 'ignored'), Uint8Array.of(1));
    await writeFile(join(unsafeActive.receiver.stagingRoot, '1'.repeat(64)), Uint8Array.of(1));
    await expectCode(unsafeActive.receiver.accept(firstByte), 'WAL_STORE_PATH_UNSAFE');

    const ignoredActive = await setup('ignored-range-active');
    await mkdir(ignoredActive.receiver.stagingRoot, { recursive: true });
    await writeFile(join(ignoredActive.receiver.stagingRoot, 'ignored'), Uint8Array.of(1));
    expect(await ignoredActive.receiver.accept(firstByte)).toBe('stored');

    const unsafeDirectory = await setup('unsafe-range-object-dir');
    await unsafeDirectory.receiver.accept(firstByte);
    const objectDirectory = join(unsafeDirectory.receiver.stagingRoot, hex(first.id));
    await rm(objectDirectory, { recursive: true });
    await writeFile(objectDirectory, Uint8Array.of(1));
    await expectCode(unsafeDirectory.receiver.missing(first.id, total), 'WAL_STORE_PATH_UNSAFE');

    const unsafeMetadata = await setup('unsafe-range-metadata');
    await unsafeMetadata.receiver.accept(firstByte);
    const metadataPath = join(unsafeMetadata.receiver.stagingRoot, hex(first.id), 'metadata.json');
    await rm(metadataPath);
    await mkdir(metadataPath);
    await expectCode(unsafeMetadata.receiver.missing(first.id, total), 'WAL_STORE_PATH_UNSAFE');

    const unsafeParts = await setup('unsafe-range-parts');
    await unsafeParts.receiver.accept(firstByte);
    const partsPath = join(unsafeParts.receiver.stagingRoot, hex(first.id), 'parts');
    await rm(partsPath, { recursive: true });
    await writeFile(partsPath, Uint8Array.of(1));
    await expectCode(unsafeParts.receiver.missing(first.id, total), 'WAL_STORE_PATH_UNSAFE');

    const absentParts = await setup('absent-range-parts');
    await absentParts.receiver.accept(firstByte);
    const absentPartsPath = join(absentParts.receiver.stagingRoot, hex(first.id), 'parts');
    await rm(absentPartsPath, { recursive: true });
    expect(await absentParts.receiver.missing(first.id, total, 100)).toHaveLength(6);

    const invalidPart = await setup('invalid-range-part');
    await invalidPart.receiver.accept(firstByte);
    const invalidPartsPath = join(invalidPart.receiver.stagingRoot, hex(first.id), 'parts');
    await writeFile(join(invalidPartsPath, 'junk'), Uint8Array.of(1));
    await writeFile(join(invalidPartsPath, '0-9007199254740992.part'), Uint8Array.of(1));
    await mkdir(join(invalidPartsPath, '2-1.part'));
    await expectCode(invalidPart.receiver.missing(first.id, total), 'WAL_STORE_PATH_UNSAFE');
    await rm(join(invalidPartsPath, '2-1.part'), { recursive: true });
    await writeFile(join(invalidPartsPath, '2-2.part'), Uint8Array.of(1));
    await expectCode(invalidPart.receiver.missing(first.id, total), 'WAL_STAGE_METADATA_INVALID');

    const parsedParts = await setup('parsed-range-parts');
    await parsedParts.receiver.accept(firstByte);
    const parsedPartsPath = join(parsedParts.receiver.stagingRoot, hex(first.id), 'parts');
    await writeFile(join(parsedPartsPath, 'junk'), Uint8Array.of(1));
    await writeFile(join(parsedPartsPath, '0-9007199254740992.part'), Uint8Array.of(1));
    await writeFile(join(parsedPartsPath, '0-2.part'), first.bytes.slice(0, 2));
    await writeFile(join(parsedPartsPath, '1-1.part'), first.bytes.slice(1, 2));
    expect(await (parsedParts.receiver as never as { parts(path: string): Promise<unknown[]> }).parts(parsedPartsPath)).toHaveLength(3);
    expect(await parsedParts.receiver.missing(first.id, total, 100)).toHaveLength(6);

    const gapParts = await setup('gap-range-parts');
    await gapParts.receiver.accept({ walObjectId: first.id, totalObjectLength: total, offset: 300n, bytes: first.bytes.slice(300, 310) });
    expect((await gapParts.receiver.missing(first.id, total, 100)).slice(0, 3)).toEqual([
      { offset: 0n, maximumLength: 100 },
      { offset: 100n, maximumLength: 100 },
      { offset: 200n, maximumLength: 100 },
    ]);
  });

  it('rejects every malformed local restart record without treating JSON as protocol data', async () => {
    const first = fixture();
    const total = BigInt(first.bytes.length);
    const key = hex(first.id);
    const malformed = [
      {},
      { version: 1, walObjectId: 1, totalObjectLength: total.toString(), createdAtMs: 1, updatedAtMs: 1 },
      { version: 1, walObjectId: 'bad', totalObjectLength: total.toString(), createdAtMs: 1, updatedAtMs: 1 },
      { version: 1, walObjectId: key, totalObjectLength: 1, createdAtMs: 1, updatedAtMs: 1 },
      { version: 1, walObjectId: key, totalObjectLength: '0', createdAtMs: 1, updatedAtMs: 1 },
      { version: 1, walObjectId: key, totalObjectLength: total.toString(), createdAtMs: null, updatedAtMs: 1 },
      { version: 1, walObjectId: key, totalObjectLength: total.toString(), createdAtMs: 1, updatedAtMs: null },
    ];
    for (const [index, value] of malformed.entries()) {
      const { receiver } = await setup(`metadata-shape-${index}`);
      await receiver.accept({ walObjectId: first.id, totalObjectLength: total, offset: 0n, bytes: first.bytes.slice(0, 1) });
      await writeFile(join(receiver.stagingRoot, key, 'metadata.json'), `${JSON.stringify(value)}\n`);
      await expectCode(receiver.missing(first.id, total), 'WAL_STAGE_METADATA_INVALID');
    }
    const invalidJson = await setup('metadata-json');
    await invalidJson.receiver.accept({ walObjectId: first.id, totalObjectLength: total, offset: 0n, bytes: first.bytes.slice(0, 1) });
    await writeFile(join(invalidJson.receiver.stagingRoot, key, 'metadata.json'), '{');
    await expectCode(invalidJson.receiver.missing(first.id, total), 'WAL_STAGE_METADATA_INVALID');

    const wrongKey = await setup('metadata-key');
    await wrongKey.receiver.accept({ walObjectId: first.id, totalObjectLength: total, offset: 0n, bytes: first.bytes.slice(0, 1) });
    const wrongMetadataPath = join(wrongKey.receiver.stagingRoot, key, 'metadata.json');
    const value = JSON.parse(await readFile(wrongMetadataPath, 'utf8'));
    value.walObjectId = 'f'.repeat(64);
    await writeFile(wrongMetadataPath, `${JSON.stringify(value)}\n`);
    await expectCode(wrongKey.receiver.missing(first.id, total), 'WAL_STAGE_METADATA_INVALID');
  });

  it('detects external staging corruption and removes every poisoned complete candidate', async () => {
    const first = fixture();
    const total = BigInt(first.bytes.length);
    const metadataGoneBase = await temporaryRoot('metadata-gone');
    const metadataGoneStore = new FileWalObjectStore({ root: join(metadataGoneBase, 'objects') });
    const metadataGoneRoot = join(metadataGoneBase, 'ranges');
    const metadataGone = new FileWalObjectRangeReceiver({
      stagingRoot: metadataGoneRoot,
      store: metadataGoneStore,
      durabilityHook: async point => {
        if (point === 'range-directory-synced') {
          await rm(join(metadataGoneRoot, hex(first.id), 'metadata.json'));
        }
      },
    });
    await expectCode(metadataGone.accept({ walObjectId: first.id, totalObjectLength: total, offset: 0n, bytes: first.bytes.slice(0, 1) }), 'WAL_STAGE_METADATA_INVALID');

    const truncated = await setup('truncated-range-part');
    const partPath = join(truncated.base, 'short.part');
    await writeFile(partPath, Uint8Array.of(1));
    await expectCode((truncated.receiver as never as {
      assertOverlapsAgree(parts: unknown[], offset: bigint, bytes: Uint8Array): Promise<void>;
    }).assertOverlapsAgree([{ path: partPath, offset: 0n, length: 2, end: 2n }], 0n, Uint8Array.of(1, 2)), 'WAL_STAGE_METADATA_INVALID');

    const unsafeQuota = await setup('unsafe-quota-object');
    await mkdir(unsafeQuota.receiver.stagingRoot, { recursive: true });
    await writeFile(join(unsafeQuota.receiver.stagingRoot, '2'.repeat(64)), Uint8Array.of(1));
    await expectCode((unsafeQuota.receiver as never as { stagedPhysicalBytes(): Promise<bigint> }).stagedPhysicalBytes(), 'WAL_STORE_PATH_UNSAFE');

    const unsafeQuotaPart = await setup('unsafe-quota-part');
    const quotaObject = join(unsafeQuotaPart.receiver.stagingRoot, '3'.repeat(64));
    await mkdir(join(quotaObject, 'parts'), { recursive: true });
    await mkdir(join(quotaObject, 'parts', 'bad.incoming'));
    await expectCode((unsafeQuotaPart.receiver as never as { stagedPhysicalBytes(): Promise<bigint> }).stagedPhysicalBytes(), 'WAL_STORE_PATH_UNSAFE');

    const quotaBranches = await setup('quota-branches');
    await mkdir(quotaBranches.receiver.stagingRoot, { recursive: true });
    await writeFile(join(quotaBranches.receiver.stagingRoot, 'ignored'), Uint8Array.of(1));
    const quotaBranchObject = join(quotaBranches.receiver.stagingRoot, '4'.repeat(64));
    await mkdir(join(quotaBranchObject, 'parts'), { recursive: true });
    await writeFile(join(quotaBranchObject, 'parts', 'ignored'), Uint8Array.of(1));
    await writeFile(join(quotaBranchObject, 'parts', '1-1.part'), Uint8Array.of(1));
    await writeFile(join(quotaBranchObject, 'parts', 'safe.incoming'), Uint8Array.of(1));
    expect(await (quotaBranches.receiver as never as { stagedPhysicalBytes(): Promise<bigint> }).stagedPhysicalBytes()).toBe(2n);
    await mkdir(join(quotaBranches.receiver.stagingRoot, '5'.repeat(64)));
    expect(await (quotaBranches.receiver as never as { stagedPhysicalBytes(): Promise<bigint> }).stagedPhysicalBytes()).toBe(2n);

    const wrongId = await setup('poison-wrong-id', { maximumRangeBytes: 1_048_576 });
    const second = fixture('second');
    await expectCode(wrongId.receiver.accept({ walObjectId: second.id, totalObjectLength: total, offset: 0n, bytes: first.bytes }), 'WAL_STORE_OBJECT_ID_MISMATCH');
    expect(await readdir(wrongId.receiver.stagingRoot)).toEqual([]);

    const tooLargeBase = await temporaryRoot('poison-size');
    const smallStore = new FileWalObjectStore({ root: join(tooLargeBase, 'objects'), maximumObjectBytes: 100n });
    const tooLarge = new FileWalObjectRangeReceiver({ stagingRoot: join(tooLargeBase, 'ranges'), store: smallStore });
    await expectCode(tooLarge.accept({ walObjectId: first.id, totalObjectLength: total, offset: 0n, bytes: first.bytes }), 'WAL_STORE_OBJECT_TOO_LARGE');
    expect(await readdir(tooLarge.stagingRoot)).toEqual([]);
  });

  it('finalize is idempotent after admission and fails before any range exists', async () => {
    const first = fixture();
    const total = BigInt(first.bytes.length);
    const { receiver } = await setup('explicit-finalize', { maximumRangeBytes: 1_048_576 });
    await expectCode(receiver.finalize(first.id, total), 'WAL_STAGE_INCOMPLETE');
    expect(await receiver.accept({ walObjectId: first.id, totalObjectLength: total, offset: total, bytes: new Uint8Array() })).toBe('duplicate');
    expect(await receiver.accept({ walObjectId: first.id, totalObjectLength: total, offset: 0n, bytes: first.bytes.slice(0, 1) })).toBe('stored');
    expect(await receiver.accept({ walObjectId: first.id, totalObjectLength: total, offset: total, bytes: new Uint8Array() })).toBe('duplicate');
    await receiver.accept({ walObjectId: first.id, totalObjectLength: total, offset: 0n, bytes: first.bytes });
    await expect(receiver.finalize(first.id, total)).resolves.toBeUndefined();
  });

  it('cancels, cleans stale staging, rejects malformed metadata, and removes poisoned complete objects', async () => {
    let now = 1_000;
    const first = fixture();
    const total = BigInt(first.bytes.length);
    const { base, store, receiver } = await setup('cleanup', {
      now: () => now, stagingLifetimeMs: 10, maximumRangeBytes: 1_048_576,
    });
    const aborted = new AbortController(); aborted.abort();
    await expectCode(receiver.accept({ walObjectId: first.id, totalObjectLength: total, offset: 0n, bytes: first.bytes.slice(0, 1) }, aborted.signal), 'WAL_STAGE_CANCELLED');
    await receiver.accept({ walObjectId: first.id, totalObjectLength: total, offset: 0n, bytes: first.bytes.slice(0, 1) });
    expect(await receiver.cleanupExpired()).toBe(0);
    now = 2_000;
    expect(await receiver.cleanupExpired()).toBe(1);
    expect(await receiver.cleanupExpired()).toBe(0);
    await receiver.cancel(first.id);

    await receiver.accept({ walObjectId: first.id, totalObjectLength: total, offset: 0n, bytes: first.bytes.slice(0, 1) });
    const key = hex(first.id);
    await writeFile(join(base, 'range-staging', key, 'metadata.json'), '{}');
    await expectCode(receiver.missing(first.id, total), 'WAL_STAGE_METADATA_INVALID');
    await receiver.cancel(first.id);

    const corrupt = new Uint8Array(first.bytes); corrupt[corrupt.length - 1] ^= 1;
    await expect(receiver.accept({ walObjectId: first.id, totalObjectLength: BigInt(corrupt.length), offset: 0n, bytes: corrupt.slice(0, 100) })).resolves.toBe('stored');
    await expect(receiver.accept({ walObjectId: first.id, totalObjectLength: BigInt(corrupt.length), offset: 100n, bytes: corrupt.slice(100, 200) })).resolves.toBe('stored');
    await expectCode(receiver.accept({ walObjectId: first.id, totalObjectLength: BigInt(corrupt.length), offset: 200n, bytes: corrupt.slice(200) }), 'WAL_STORE_INVALID_OBJECT');
    expect(await store.has(first.id)).toBe(false);
    expect(await readdir(join(base, 'range-staging'))).toEqual([]);
  });

  it.each([
    'metadata-file-synced', 'metadata-renamed', 'metadata-directory-synced',
    'range-file-synced', 'range-renamed', 'range-directory-synced',
    'progress-metadata-committed', 'assembly-file-synced', 'object-promoted',
    'staging-directory-removed',
  ] as const)('recovers to completion after simulated crash at %s', async (faultPoint) => {
    const base = await temporaryRoot(`range-fault-${faultPoint}`);
    const store = new FileWalObjectStore({ root: join(base, 'objects') });
    const first = fixture();
    const total = BigInt(first.bytes.length);
    let thrown = false;
    const receiver = new FileWalObjectRangeReceiver({
      stagingRoot: join(base, 'range-staging'), store, maximumRangeBytes: 1_048_576,
      durabilityHook: point => {
        if (!thrown && point === faultPoint) { thrown = true; throw new Error('simulated crash'); }
      },
    });
    await expect(receiver.accept({ walObjectId: first.id, totalObjectLength: total, offset: 0n, bytes: first.bytes })).rejects.toThrow();
    expect(thrown).toBe(true);
    const restarted = new FileWalObjectRangeReceiver({ stagingRoot: join(base, 'range-staging'), store });
    if (!await store.has(first.id)) {
      const missing = await restarted.missing(first.id, total);
      if (missing.length === 0) {
        expect(await restarted.accept({
          walObjectId: first.id,
          totalObjectLength: total,
          offset: total,
          bytes: new Uint8Array(),
        })).toBe('complete');
      }
      for (const range of missing) {
        await restarted.accept({
          walObjectId: first.id,
          totalObjectLength: total,
          offset: range.offset,
          bytes: first.bytes.slice(Number(range.offset), Number(range.offset) + range.maximumLength),
        });
      }
      if (!await store.has(first.id)) await restarted.finalize(first.id, total);
    }
    expect(await collect(store.read(first.id))).toEqual(first.bytes);
  });
});

describe('large-object and abstraction boundary', () => {
  it('streams an object far larger than its verifier buffer while a small object completes between ranges', async () => {
    const privateKey = fromHex(vectors.fixturePrivateKey);
    const zeroDigest = new Uint8Array(32);
    const writer = recoverEip191Address(zeroDigest, signEip191DigestWithPrivateKey(zeroDigest, privateKey));
    const signer: WalEip191Signer = {
      address: writer,
      signMessage: digest => signEip191DigestWithPrivateKey(digest, privateKey),
    };
    const large = await createWalObjectV1([
      1n, new Uint8Array(32).fill(7), writer, 0n, 0n, null, new Uint8Array(8 * 1024 * 1024).fill(0xa5),
    ] satisfies UnsignedWalObjectV1, signer);
    const base = await temporaryRoot('large');
    const store = new FileWalObjectStore({
      root: join(base, 'objects'), readBufferBytes: 32_768, verificationBufferBytes: 32_768,
      maximumObjectBytes: 16n * 1024n * 1024n,
    });
    const receiver = new FileWalObjectRangeReceiver({
      stagingRoot: join(base, 'ranges'), store, maximumObjectBytes: 16n * 1024n * 1024n,
      maximumRangeBytes: 1_048_576, assemblyBufferBytes: 32_768,
    });
    const largeId = walObjectId(large.walObjectId);
    const total = BigInt(large.canonicalBytes.length);
    await receiver.accept({ walObjectId: largeId, totalObjectLength: total, offset: 1_048_576n, bytes: large.canonicalBytes.slice(1_048_576, 2_097_152) });
    const small = fixture();
    await receiver.accept({ walObjectId: small.id, totalObjectLength: BigInt(small.bytes.length), offset: 0n, bytes: small.bytes });
    expect(await store.has(small.id)).toBe(true);
    for (const range of await receiver.missing(largeId, total)) {
      await receiver.accept({
        walObjectId: largeId,
        totalObjectLength: total,
        offset: range.offset,
        bytes: large.canonicalBytes.slice(Number(range.offset), Number(range.offset) + range.maximumLength),
      });
    }
    const verification = await verifyWalObjectFile(store.pathFor(largeId), largeId, {
      maximumObjectBytes: 16n * 1024n * 1024n,
      readBufferBytes: 32_768,
    });
    expect(verification.maximumReadBufferBytes).toBeLessThanOrEqual(32_768);
    expect(verification.byteLength).toBe(total);
    expect(await collect(store.read(largeId, total - 16n))).toEqual(large.canonicalBytes.slice(-16));
  });

  it('keeps WalObjectV1 as the only durable content-addressed atom', async () => {
    const schema = JSON.stringify(PROTOCOL_TUPLES);
    expect(schema).not.toMatch(/PayloadId|BlobId|ChunkId|RangeId/);
    const sourceRoot = new URL('../../src/', import.meta.url);
    const sourceNames = (await readdir(sourceRoot, { recursive: true }))
      .filter(name => name.endsWith('.ts'));
    const allProductionSource = (await Promise.all(
      sourceNames.map(name => readFile(new URL(name, sourceRoot), 'utf8')),
    )).join('\n');
    expect(allProductionSource).not.toMatch(/PayloadId|BlobId|ChunkId|RangeId|fetchPayload|getPayload|readPayload/);
    const storeExports = await readFile(new URL('../../src/store/index.ts', import.meta.url), 'utf8');
    expect(storeExports).not.toContain('range-receiver');
    const contractSource = await readFile(new URL('../../src/store/types.ts', import.meta.url), 'utf8');
    expect([...contractSource.matchAll(/abstract (has|read|put|ids)\(/g)].map(match => match[1]).sort()).toEqual([
      'has', 'ids', 'put', 'read',
    ]);
  });
});
