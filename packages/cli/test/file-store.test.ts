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
  it('resolves a hash to an absolute sharded path without touching disk', () => {
    const store = new FileStore(rootDir);
    const hex = '1234567890abcdef'.repeat(4);
    expect(hex.length).toBe(64);

    const path = store.hashToPath(`sha256:${hex}`);
    expect(path).toBe(join(rootDir, hex.slice(0, 2), hex.slice(2)));
  });

  it('returns null for malformed hashes', () => {
    const store = new FileStore(rootDir);
    expect(store.hashToPath('not-a-hash')).toBeNull();
    expect(store.hashToPath('sha256:short')).toBeNull();
  });
});
