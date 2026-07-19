import Database from 'better-sqlite3';
import {
  appendFile,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  truncate,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { walObjectId, type WalObjectId } from '../../src/reconciliation/ids.js';
import { PackedWalObjectStore, type PackedWalObjectStoreDurabilityPoint } from '../../src/store/packed-store.js';

const vectors = JSON.parse(await readFile(
  new URL('../../../../conformance/wal-v1/vectors/protocol-v1.json', import.meta.url), 'utf8',
));
const roots: string[] = [];
const stores: PackedWalObjectStore[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

function fromHex(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value.startsWith('0x') ? value.slice(2) : value, 'hex'));
}

function fixture(name: 'first' | 'second' | 'onePayloadByteChanged' = 'first') {
  const value = vectors.walObjects[name];
  return { bytes: fromHex(value.canonicalBytes), id: walObjectId(fromHex(value.walObjectId)) };
}

async function root(label: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), `dkg-wal-packed-${label}-`));
  roots.push(path);
  return path;
}

function store(options: ConstructorParameters<typeof PackedWalObjectStore>[0]): PackedWalObjectStore {
  const value = new PackedWalObjectStore(options);
  stores.push(value);
  return value;
}

function close(value: PackedWalObjectStore): void {
  value.close();
  stores.splice(stores.indexOf(value), 1);
}

async function* chunks(bytes: Uint8Array, size = 37, empty = false): AsyncIterable<Uint8Array> {
  if (empty) yield new Uint8Array();
  for (let offset = 0; offset < bytes.length; offset += size) yield bytes.slice(offset, offset + size);
}

async function collect(source: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let length = 0;
  for await (const part of source) { parts.push(part); length += part.length; }
  const output = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) { output.set(part, offset); offset += part.length; }
  return output;
}

async function ids(source: AsyncIterable<WalObjectId>): Promise<string[]> {
  const output: string[] = [];
  for await (const id of source) output.push(Buffer.from(id).toString('hex'));
  return output;
}

async function code(promise: Promise<unknown>, expected: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code: expected });
}

async function iterableCode(source: AsyncIterable<Uint8Array>, expected: string): Promise<void> {
  await code(collect(source), expected);
}

function segment(rootPath: string, id = 0): string {
  return join(rootPath, 'segments', `${id.toString(16).padStart(16, '0')}.pack`);
}

describe('PackedWalObjectStore', () => {
  it('keeps the complete-object contract across restart and segment rotation', async () => {
    const path = await root('contract');
    let value = store({ root: path, segmentTargetBytes: 550, readBufferBytes: 17, verificationBufferBytes: 19 });
    const first = fixture();
    const second = fixture('second');
    await value.put(second.id, chunks(second.bytes, 11));
    await value.put(first.id, chunks(first.bytes, 7, true));
    await value.put(first.id, chunks(Uint8Array.of(0xff)));
    expect(await collect(value.read(first.id))).toEqual(first.bytes);
    expect(await collect(value.read(first.id, 3n, 19))).toEqual(first.bytes.slice(3, 22));
    expect(await collect(value.read(first.id, BigInt(first.bytes.length), 10))).toEqual(new Uint8Array());
    expect(await collect(value.read(first.id, 4n, 100_000))).toEqual(first.bytes.slice(4));
    expect(await ids(value.ids())).toEqual([
      Buffer.from(first.id).toString('hex'), Buffer.from(second.id).toString('hex'),
    ].sort());
    expect((await readdir(join(path, 'segments'))).sort()).toEqual([
      '0000000000000000.pack', '0000000000000001.pack',
    ]);
    close(value);
    value = store({ root: path });
    expect(await collect(value.read(second.id))).toEqual(second.bytes);
    value.close();
    value.close();
    await code(value.has(first.id), 'WAL_STORE_IO');
    await iterableCode(value.read(first.id), 'WAL_STORE_IO');
    await expect(ids(value.ids())).rejects.toMatchObject({ code: 'WAL_STORE_IO' });
  });

  it('rejects invalid configuration, IDs, ranges, sources, sizes, and bytes', async () => {
    const base = await root('validation');
    for (const options of [
      undefined,
      { root: '' },
      { root: 'relative' },
      { root: base, maximumObjectBytes: 0n },
      { root: base, maximumObjectBytes: 8_589_934_593n },
      { root: base, segmentTargetBytes: 127 },
      { root: base, segmentTargetBytes: 8_590_000_129 },
      { root: base, readBufferBytes: 0 },
      { root: base, verificationBufferBytes: 1_048_577 },
      { root: base, busyTimeoutMs: 0 },
    ]) expect(() => new PackedWalObjectStore(options as never)).toThrow();
    const value = store({ root: join(base, 'valid'), maximumObjectBytes: 10_000n });
    const badId = new Uint8Array(31) as WalObjectId;
    await code(value.has(badId), 'WAL_STORE_INVALID_OBJECT_ID');
    await code(value.put(badId, chunks(new Uint8Array())), 'WAL_STORE_INVALID_OBJECT_ID');
    await iterableCode(value.read(badId), 'WAL_STORE_INVALID_OBJECT_ID');
    await iterableCode(value.read(fixture().id), 'WAL_STORE_OBJECT_NOT_FOUND');
    await iterableCode(value.read(fixture().id, -1n), 'WAL_STORE_INVALID_READ_RANGE');
    await iterableCode(value.read(fixture().id, 1 as never), 'WAL_STORE_INVALID_READ_RANGE');
    await iterableCode(value.read(fixture().id, BigInt(Number.MAX_SAFE_INTEGER) + 1n), 'WAL_STORE_INVALID_READ_RANGE');
    await iterableCode(value.read(fixture().id, 0n, -1), 'WAL_STORE_INVALID_READ_RANGE');
    await iterableCode(value.read(fixture().id, 0n, Number.NaN), 'WAL_STORE_INVALID_READ_RANGE');
    async function* invalid(): AsyncIterable<Uint8Array> { yield 'no' as never; }
    await code(value.put(fixture().id, invalid()), 'WAL_STORE_INVALID_OBJECT');
    const limited = store({ root: join(base, 'limited'), maximumObjectBytes: 10n });
    await code(limited.put(fixture().id, chunks(fixture().bytes)), 'WAL_STORE_OBJECT_TOO_LARGE');
    await code(value.put(fixture('second').id, chunks(fixture().bytes)), 'WAL_STORE_OBJECT_ID_MISMATCH');
    for (const invalidObject of vectors.invalidWalObjects) {
      await expect(value.put(fixture().id, chunks(fromHex(invalidObject.bytes)))).rejects.toMatchObject({
        code: expect.stringMatching(/^WAL_STORE_(INVALID_OBJECT|OBJECT_ID_MISMATCH)$/),
      });
    }
    await value.put(fixture().id, chunks(fixture().bytes));
    await iterableCode(value.read(fixture().id, BigInt(fixture().bytes.length + 1)), 'WAL_STORE_INVALID_READ_RANGE');
  });

  it.each([
    'candidate-file-synced', 'segment-file-synced', 'before-index-commit',
  ] satisfies PackedWalObjectStoreDurabilityPoint[])('rolls back the %s failure boundary', async (point) => {
    const path = await root(point);
    const value = store({ root: path, durabilityHook: reached => {
      if (reached === point) throw new Error(point);
    } });
    await code(value.put(fixture().id, chunks(fixture().bytes)), 'WAL_STORE_IO');
    expect(await value.has(fixture().id)).toBe(false);
    expect((await stat(segment(path))).size).toBe(32);
    expect(await readdir(join(path, 'staging'))).toEqual([]);
  });

  it('preserves a commit after lost acknowledgement and normalizes non-Error failures', async () => {
    const committedRoot = await root('committed');
    let value = store({ root: committedRoot, durabilityHook: point => {
      if (point === 'index-committed') throw new Error('ack');
    } });
    await code(value.put(fixture().id, chunks(fixture().bytes)), 'WAL_STORE_IO');
    expect(await value.has(fixture().id)).toBe(true);
    close(value);
    value = store({ root: committedRoot });
    expect(await collect(value.read(fixture().id))).toEqual(fixture().bytes);

    const stringRoot = await root('string');
    const stringStore = store({ root: stringRoot, durabilityHook: point => {
      if (point === 'candidate-file-synced') throw 'string failure';
    } });
    await code(stringStore.put(fixture().id, chunks(fixture().bytes)), 'WAL_STORE_IO');
  });

  it('truncates unindexed tails and removes orphan segment and candidate files', async () => {
    const path = await root('recovery');
    let value = store({ root: path });
    await value.put(fixture().id, chunks(fixture().bytes));
    const committed = (await stat(segment(path))).size;
    close(value);
    await appendFile(segment(path), new Uint8Array(4096));
    await writeFile(segment(path, 99), Uint8Array.of(1));
    await writeFile(join(path, 'staging', `.${'a'.repeat(64)}.aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.tmp`), Uint8Array.of(1));
    await writeFile(join(path, 'segments', 'README'), Uint8Array.of(1));
    value = store({ root: path });
    expect((await stat(segment(path))).size).toBe(committed);
    await expect(stat(segment(path, 99))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(join(path, 'staging'))).toEqual([]);
    expect(await collect(value.read(fixture().id))).toEqual(fixture().bytes);
  });

  it('fails closed for corrupt index, segment, and record bindings', async () => {
    const base = await root('corrupt');
    const first = fixture();

    const truncatedRoot = join(base, 'truncated');
    let value = store({ root: truncatedRoot });
    await value.put(first.id, chunks(first.bytes));
    close(value);
    await truncate(segment(truncatedRoot), 31);
    expect(() => store({ root: truncatedRoot })).toThrowError(expect.objectContaining({ code: 'WAL_STORE_CORRUPT' }));

    for (const [label, byte] of [['magic', 0], ['version', 8], ['segment-id', 23]] as const) {
      const path = join(base, label);
      value = store({ root: path });
      await value.put(first.id, chunks(first.bytes));
      close(value);
      const bytes = await readFile(segment(path));
      bytes[byte] ^= 0xff;
      await writeFile(segment(path), bytes);
      expect(() => store({ root: path })).toThrowError(expect.objectContaining({ code: 'WAL_STORE_CORRUPT' }));
    }

    for (const [label, byte] of [['record-magic', 32], ['record-id', 40], ['record-length', 72]] as const) {
      const path = join(base, label);
      value = store({ root: path });
      await value.put(first.id, chunks(first.bytes));
      const bytes = await readFile(segment(path));
      bytes[byte] ^= 0xff;
      await writeFile(segment(path), bytes);
      await iterableCode(value.read(first.id), 'WAL_STORE_CORRUPT');
      close(value);
    }

    const indexRoot = join(base, 'index');
    value = store({ root: indexRoot });
    await value.put(first.id, chunks(first.bytes));
    close(value);
    const database = new Database(join(indexRoot, 'objects.sqlite'));
    database.pragma('ignore_check_constraints = ON');
    database.prepare('UPDATE objects SET object_length = object_length + 100000').run();
    database.close();
    expect(() => store({ root: indexRoot })).toThrowError(expect.objectContaining({ code: 'WAL_STORE_CORRUPT' }));
  });

  it('handles live storage failures and invalid indexed IDs with stable errors', async () => {
    const base = await root('live-errors');
    const path = join(base, 'live');
    let value = store({ root: path });
    await value.put(fixture().id, chunks(fixture().bytes));
    await truncate(segment(path), 40);
    await iterableCode(value.read(fixture().id), 'WAL_STORE_CORRUPT');
    close(value);

    const missing = join(base, 'missing');
    value = store({ root: missing });
    await value.put(fixture().id, chunks(fixture().bytes));
    await rm(segment(missing));
    await iterableCode(value.read(fixture().id), 'WAL_STORE_IO');
    close(value);
    expect(() => store({ root: missing })).toThrowError(expect.objectContaining({ code: 'WAL_STORE_CORRUPT' }));

    const invalidId = join(base, 'invalid-id');
    value = store({ root: invalidId });
    await value.put(fixture().id, chunks(fixture().bytes));
    close(value);
    const db = new Database(join(invalidId, 'objects.sqlite'));
    db.pragma('ignore_check_constraints = ON');
    const target = db.prepare('SELECT segment_id, object_offset, object_length FROM objects LIMIT 1').get() as {
      segment_id: number; object_offset: number; object_length: number;
    };
    db.prepare('INSERT INTO objects VALUES (?, ?, ?, ?)').run(
      Buffer.from([1]), target.segment_id, target.object_offset, target.object_length,
    );
    db.close();
    value = store({ root: invalidId });
    await expect(ids(value.ids())).rejects.toMatchObject({ code: 'WAL_STORE_CORRUPT' });
  });

  it('rejects unsafe paths and unsupported schemas', async () => {
    const base = await root('unsafe');
    const target = join(base, 'target');
    await mkdir(target);
    await symlink(target, join(base, 'root-link'));
    expect(() => store({ root: join(base, 'root-link') })).toThrowError(expect.objectContaining({ code: 'WAL_STORE_PATH_UNSAFE' }));
    const indexRoot = join(base, 'index');
    await mkdir(indexRoot);
    await symlink('/dev/null', join(indexRoot, 'objects.sqlite'));
    expect(() => store({ root: indexRoot })).toThrowError(expect.objectContaining({ code: 'WAL_STORE_PATH_UNSAFE' }));
    const fileRoot = join(base, 'file');
    await writeFile(fileRoot, Uint8Array.of(1));
    expect(() => store({ root: fileRoot })).toThrowError(expect.objectContaining({ code: 'WAL_STORE_PATH_UNSAFE' }));

    const schemaRoot = join(base, 'schema');
    const value = store({ root: schemaRoot });
    close(value);
    const db = new Database(join(schemaRoot, 'objects.sqlite'));
    db.pragma('user_version = 99');
    db.close();
    expect(() => store({ root: schemaRoot })).toThrowError(expect.objectContaining({ code: 'WAL_STORE_INVALID_CONFIGURATION' }));
  });

  it('serializes concurrent duplicate admission across store instances', async () => {
    const path = await root('concurrent');
    const left = store({ root: path });
    const right = store({ root: path });
    await Promise.all([
      left.put(fixture().id, chunks(fixture().bytes, 7)),
      right.put(fixture().id, chunks(fixture().bytes, 11)),
    ]);
    const db = new Database(left.indexPath, { readonly: true });
    expect(db.prepare('SELECT COUNT(*) AS count FROM objects').get()).toEqual({ count: 1 });
    expect(db.prepare('SELECT record_count FROM segments').get()).toEqual({ record_count: 1 });
    db.close();
  });
});
