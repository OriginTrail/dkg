import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readdir, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { FileStore } from '../src/file-store.js';

let rootDir: string;

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), 'dkg-filestore-test-'));
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

describe('FileStore.put', () => {
  it('stores bytes and returns a sha256 hash with the sha256: prefix', async () => {
    const store = new FileStore(rootDir);
    const bytes = Buffer.from('hello world', 'utf-8');
    const expectedHex = createHash('sha256').update(bytes).digest('hex');

    const entry = await store.put(bytes, 'text/plain');

    expect(entry.hash).toBe(`sha256:${expectedHex}`);
    expect(entry.size).toBe(11);
    expect(entry.contentType).toBe('text/plain');
  });

  it('writes content to a two-level sharded path (ab/cdef...)', async () => {
    const store = new FileStore(rootDir);
    const bytes = Buffer.from('some content', 'utf-8');
    const expectedHex = createHash('sha256').update(bytes).digest('hex');

    const entry = await store.put(bytes, 'text/plain');

    const expectedPath = join(rootDir, expectedHex.slice(0, 2), expectedHex.slice(2));
    expect(entry.path).toBe(expectedPath);
    const onDisk = await readFile(expectedPath);
    expect(onDisk.equals(bytes)).toBe(true);
  });

  it('is idempotent — putting the same bytes twice yields the same hash', async () => {
    const store = new FileStore(rootDir);
    const bytes = Buffer.from('idempotent', 'utf-8');

    const first = await store.put(bytes, 'text/plain');
    const second = await store.put(bytes, 'application/octet-stream');

    expect(first.hash).toBe(second.hash);
    expect(first.path).toBe(second.path);
    // contentType on the returned entry reflects the caller, not persisted metadata
    expect(first.contentType).toBe('text/plain');
    expect(second.contentType).toBe('application/octet-stream');
  });

  it('leaves only the final blob after repeated puts of the same content', async () => {
    const store = new FileStore(rootDir);
    const bytes = Buffer.from('atomic-write', 'utf-8');

    const first = await store.put(bytes, 'text/plain');
    const second = await store.put(bytes, 'text/plain');

    expect(second.path).toBe(first.path);
    const shardEntries = await readdir(join(rootDir, first.hash.slice('sha256:'.length, 'sha256:'.length + 2)));
    expect(shardEntries).toEqual([first.hash.slice('sha256:'.length + 2)]);
  });

  it('handles empty input', async () => {
    const store = new FileStore(rootDir);
    const entry = await store.put(Buffer.alloc(0), 'application/octet-stream');
    expect(entry.size).toBe(0);
    // sha256 of empty string is well-known
    expect(entry.hash).toBe('sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('handles binary content with arbitrary bytes', async () => {
    const store = new FileStore(rootDir);
    const bytes = Buffer.from([0x00, 0xff, 0x7f, 0x80, 0x0a, 0x0d]);
    const entry = await store.put(bytes, 'application/octet-stream');
    const onDisk = await readFile(entry.path);
    expect(onDisk.equals(bytes)).toBe(true);
  });
});

describe('FileStore.get', () => {
  it('returns the bytes for a stored hash', async () => {
    const store = new FileStore(rootDir);
    const bytes = Buffer.from('retrievable', 'utf-8');
    const { hash } = await store.put(bytes, 'text/plain');

    const retrieved = await store.get(hash);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.equals(bytes)).toBe(true);
  });

  it('returns null for a hash that was never stored', async () => {
    const store = new FileStore(rootDir);
    const bogusHex = 'a'.repeat(64);
    const retrieved = await store.get(`sha256:${bogusHex}`);
    expect(retrieved).toBeNull();
  });

  it('accepts bare hex or sha256:-prefixed hashes', async () => {
    const store = new FileStore(rootDir);
    const bytes = Buffer.from('both forms', 'utf-8');
    const { hash } = await store.put(bytes, 'text/plain');
    const bareHex = hash.slice('sha256:'.length);

    const viaPrefixed = await store.get(hash);
    const viaBare = await store.get(bareHex);

    expect(viaPrefixed).not.toBeNull();
    expect(viaBare).not.toBeNull();
    expect(viaPrefixed!.equals(viaBare!)).toBe(true);
  });

  it('returns null for malformed hash strings', async () => {
    const store = new FileStore(rootDir);
    expect(await store.get('not-a-hash')).toBeNull();
    expect(await store.get('sha256:tooshort')).toBeNull();
    expect(await store.get('sha256:' + 'z'.repeat(64))).toBeNull(); // non-hex chars
    expect(await store.get('')).toBeNull();
  });
});

describe('FileStore.has', () => {
  it('returns true for stored hashes and false otherwise', async () => {
    const store = new FileStore(rootDir);
    const bytes = Buffer.from('presence check', 'utf-8');
    const { hash } = await store.put(bytes, 'text/plain');

    expect(await store.has(hash)).toBe(true);
    expect(await store.has('sha256:' + 'b'.repeat(64))).toBe(false);
    expect(await store.has('bad-hash')).toBe(false);
  });
});

describe('FileStore.hashToPath', () => {
  it('resolves a sha256 hash to the absolute sharded blob path', async () => {
    const store = new FileStore(rootDir);
    const hex = '1234567890abcdef'.repeat(4);
    expect(hex.length).toBe(64);

    const path = await store.hashToPath(`sha256:${hex}`);
    expect(path).toBe(join(rootDir, hex.slice(0, 2), hex.slice(2)));
  });

  it('returns null for malformed hashes', async () => {
    const store = new FileStore(rootDir);
    expect(await store.hashToPath('not-a-hash')).toBeNull();
    expect(await store.hashToPath('sha256:short')).toBeNull();
  });

  it('Bug 9: resolves a keccak256 hash to the CONTENT path (not the pointer file)', async () => {
    // Regression guard: before the Bug 9 fix, hashToPath returned the
    // pointer file for keccak256 inputs. A caller using it to read the
    // file bytes would get the sha256 hex text from the pointer file
    // instead of the actual content. The fix makes hashToPath always
    // return the underlying blob path, dereferencing the pointer as
    // needed.
    const store = new FileStore(rootDir);
    const bytes = Buffer.from('keccak round-trip payload', 'utf-8');
    const entry = await store.put(bytes, 'text/plain');

    // hashToPath with the keccak256 form returns the content path ...
    const pathViaKeccak = await store.hashToPath(entry.keccak256);
    expect(pathViaKeccak).not.toBeNull();
    // ... which is byte-equal to the sha256-form path and points at
    // the actual blob, not the pointer indirection file.
    const pathViaSha = await store.hashToPath(entry.hash);
    expect(pathViaKeccak).toBe(pathViaSha);
    const onDisk = await readFile(pathViaKeccak!);
    expect(onDisk.equals(bytes)).toBe(true);
  });

  it('Bug 9: hashToPath returns null for keccak256 hashes whose pointer file is missing', async () => {
    const store = new FileStore(rootDir);
    // A well-formed but never-stored keccak256 hash has no pointer
    // file on disk, so the method must return null rather than a
    // would-be-invalid content path.
    const bogusKeccak = 'keccak256:' + '0'.repeat(64);
    expect(await store.hashToPath(bogusKeccak)).toBeNull();
  });
});

describe('FileStore.hashToPointerPath', () => {
  it('returns the synchronous pointer-file path for a valid keccak256 hash', () => {
    const store = new FileStore(rootDir);
    const hex = 'abcdef0123456789'.repeat(4);
    expect(hex.length).toBe(64);

    const path = store.hashToPointerPath(`keccak256:${hex}`);
    expect(path).toBe(join(rootDir, 'keccak256', hex.slice(0, 2), hex.slice(2)));
  });

  it('returns null for sha256 inputs (use hashToPath for content resolution)', () => {
    const store = new FileStore(rootDir);
    const hex = '1234567890abcdef'.repeat(4);
    expect(store.hashToPointerPath(`sha256:${hex}`)).toBeNull();
  });

  it('returns null for malformed hashes', () => {
    const store = new FileStore(rootDir);
    expect(store.hashToPointerPath('not-a-hash')).toBeNull();
    expect(store.hashToPointerPath('keccak256:short')).toBeNull();
  });

  it('the pointer file returned actually contains the sha256 hex after a put()', async () => {
    // Tightens the contract: the pointer file isn't just a location
    // on disk — it's a file whose contents are the sha256 hex that
    // `hashToPath` uses to resolve the blob.
    const store = new FileStore(rootDir);
    const bytes = Buffer.from('pointer contents check', 'utf-8');
    const entry = await store.put(bytes, 'text/plain');

    const pointerPath = store.hashToPointerPath(entry.keccak256);
    expect(pointerPath).not.toBeNull();
    const pointerContents = (await readFile(pointerPath!, 'utf-8')).trim();
    expect(pointerContents).toBe(entry.hash.slice('sha256:'.length));
  });
});
