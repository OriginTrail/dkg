import { afterEach, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SqliteLiteralBlobOwner } from '../src/sqlite-literal-blob-owner.js';
import { assertSqliteBlobRuntime, SQLITE_BLOB_APPLICATION_ID, SQLITE_BLOB_FILENAME, SQLITE_BLOB_VERSION } from '../src/sqlite-literal-blob-protocol.js';
import { StoreResponseTooLargeError } from '../src/http-response-limit.js';
import { unexpectedBlobSchemas } from './fixtures/sqlite-blob-unexpected-schema.js';

const roots: string[] = [], owners: SqliteLiteralBlobOwner[] = [];
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
it('requires a runtime carrying the upstream WAL-reset fix and accepts patched backports', () => {
  for (const version of ['3.44.5', '3.47.2', '3.50.6', '3.51.2', 'unknown']) {
    expect(() => assertSqliteBlobRuntime(version)).toThrow('requires a Node runtime');
  }
  for (const version of ['3.44.6', '3.50.7', '3.51.3', '3.53.0']) expect(() => assertSqliteBlobRuntime(version)).not.toThrow();
});
afterEach(async () => {
  for (const owner of owners.splice(0)) await owner.close().catch(() => {});
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dkg-sqlite-blob-owner-')); roots.push(root);
  const directory = join(root, 'blobs');
  const owner = new SqliteLiteralBlobOwner(directory); owners.push(owner);
  return { root, directory, owner, path: join(directory, SQLITE_BLOB_FILENAME) };
}
function reopen(directory: string) { const owner = new SqliteLiteralBlobOwner(directory); owners.push(owner); return owner; }
it('durably stores exact immutable UTF-8 bytes and reopens with the owned format', async () => {
  const f = await fixture(), value = JSON.stringify('payload é 🦉 '.repeat(8000));
  await f.owner.write(hash(value), value); await f.owner.close();
  const db = new DatabaseSync(f.path, { readOnly: true });
  expect(db.prepare('PRAGMA application_id').get()!.application_id).toBe(SQLITE_BLOB_APPLICATION_ID);
  expect(db.prepare('PRAGMA user_version').get()!.user_version).toBe(SQLITE_BLOB_VERSION);
  expect(db.prepare('SELECT typeof(term) AS kind FROM blobs').get()!.kind).toBe('blob');
  db.close();
  await expect(reopen(f.directory).read(hash(value))).resolves.toBe(value);
});
it('keeps a missing read read-only, even when its parent does not exist', async () => {
  const f = await fixture();
  await expect(f.owner.read(hash('absent'))).resolves.toBeUndefined();
  expect(await readdir(f.root)).toEqual([]);
});
it('bounds hydrated bytes before materializing a large stored value', async () => {
  const f = await fixture(), value = JSON.stringify('x'.repeat(1024 * 1024));
  await f.owner.write(hash(value), value);
  await expect(f.owner.read(hash(value), 16)).rejects.toBeInstanceOf(StoreResponseTooLargeError);
  await expect(f.owner.read(hash(value), Buffer.byteLength(value))).resolves.toBe(value);
});
it.each(['é', '\uFEFFé'])('preserves exact UTF-8/BOM bytes and rejects invalid byte limits for %j', async value => {
  const f = await fixture(); await f.owner.write(hash(value), value);
  await expect(f.owner.read(hash(value), 1)).rejects.toMatchObject({ code: 'STORE_RESPONSE_TOO_LARGE', actualBytes: Buffer.byteLength(value) });
  await expect(f.owner.read(hash(value), Buffer.byteLength(value))).resolves.toBe(value);
  await expect(f.owner.read(hash(value), -1)).rejects.toThrow('non-negative safe integer');
});
it('rejects a conflicting caller hash and retains committed data', async () => {
  const f = await fixture(), value = 'original'; await f.owner.write(hash(value), value);
  await expect(f.owner.write(hash(value), 'other bytes')).rejects.toThrow('integrity mismatch');
  await expect(f.owner.read(hash(value))).resolves.toBe(value);
});
it('drains accepted writes at synchronous close and refuses new work', async () => {
  const f = await fixture(), values = Array.from({ length: 25 }, (_, i) => 'concurrent '+i);
  const writes = values.map(value => f.owner.write(hash(value), value));
  const closing = f.owner.close(); expect(f.owner.close()).toBe(closing);
  await expect(f.owner.write(hash('late'), 'late')).rejects.toThrow('closing');
  await Promise.all(writes); await closing;
  const owner = reopen(f.directory);
  await expect(Promise.all(values.map(value => owner.read(hash(value))))).resolves.toEqual(values);
});
it('refuses malformed/foreign databases without deleting or rewriting them', async () => {
  const f = await fixture();
  const seed = reopen(f.directory); await seed.write(hash('seed'), 'seed'); await seed.close();
  const db = new DatabaseSync(f.path); db.exec('PRAGMA application_id=1234'); db.close();
  const before = await readFile(f.path);
  await expect(f.owner.write(hash('new'), 'new')).rejects.toThrow('identity/version/encoding');
  await f.owner.close(); expect(await readFile(f.path)).toEqual(before);
});
it('rejects unexpected tables or encoding instead of mutating another database', async () => {
  const f = await fixture(), seed = reopen(f.directory); await seed.write(hash('seed'), 'seed'); await seed.close();
  const db = new DatabaseSync(f.path); db.exec('CREATE TABLE unrelated(value TEXT)'); db.close();
  await expect(f.owner.read(hash('seed'))).rejects.toThrow('schema');
});
it('rejects altered valid UTF-8 BLOB bytes below the read budget after native reopen', async () => {
  const f = await fixture(), value = '"original immutable literal"';
  await f.owner.write(hash(value), value); await f.owner.close();
  const db = new DatabaseSync(f.path);
  db.prepare('UPDATE blobs SET term=? WHERE hash=?').run(Buffer.from('"corrupted but valid UTF-8"'), hash(value)); db.close();
  await expect(reopen(f.directory).read(hash(value), 4096)).rejects.toThrow('integrity mismatch');
});
it('does not adopt an empty database with an unknown version', async () => {
  const f = await fixture(), seed = reopen(f.directory); await seed.write(hash('seed'), 'seed'); await seed.close();
  const db = new DatabaseSync(f.path);
  db.exec('DROP TABLE blobs; PRAGMA application_id=0; PRAGMA user_version=99'); db.close();
  const before = await readFile(f.path);
  await expect(f.owner.write(hash('new'), 'new')).rejects.toThrow('identity/version/encoding');
  await f.owner.close(); expect(await readFile(f.path)).toEqual(before);
});
it('rejects a database-path alias and preserves its target', async () => {
  const f = await fixture(), seed = reopen(f.directory); await seed.write(hash('seed'), 'seed'); await seed.close();
  const original = await readFile(f.path), alias = join(f.root, 'alias');
  await writeFile(alias, original); await rm(f.path); await symlink(alias, f.path);
  await expect(f.owner.write(hash('new'), 'new')).rejects.toThrow('regular file');
  expect(await readFile(alias)).toEqual(original);
});
it('does not turn a pre-aborted read into physical work', async () => {
  const f = await fixture(), controller = new AbortController(); controller.abort();
  await expect(f.owner.read(hash('absent'), undefined, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  expect(await readdir(f.root)).toEqual([]);
});
it('recovers the last durable acknowledgement after whole-process kill before any RDF write', async () => {
  const f = await fixture(), child = fileURLToPath(new URL('./fixtures/sqlite-blob-process-crash.mjs', import.meta.url));
  const run = (mode: string) => spawnSync(process.execPath, [child, f.directory, mode], { encoding: 'utf8', timeout: 15_000 });
  const killed = run('kill');
  expect(killed.error).toBeUndefined(); expect(killed.stdout).toContain('durable-blob-ack');
  expect(killed.signal === 'SIGKILL' || (process.platform === 'win32' && killed.status !== 0)).toBe(true);
  const reopened = run('read');
  expect(reopened.error).toBeUndefined(); expect(reopened.status, reopened.stderr).toBe(0);
  expect(reopened.stdout).toContain('fresh-process-exact-readback');
});

it.each(unexpectedBlobSchemas)('rejects unexpected native schema ($label) before acknowledgement and preserves seed bytes', async ({ sql }) => {
  const f = await fixture(), value = '"retained seed"'; await f.owner.write(hash(value), value); await f.owner.close();
  const db = new DatabaseSync(f.path); db.exec(sql); db.close();
  const before = await readFile(f.path), retry = reopen(f.directory);
  const outcome = await retry.write(hash(value), value).then(() => 'ack', () => 'rejected'); await retry.close();
  const inspect = new DatabaseSync(f.path, { readOnly: true });
  const rows = inspect.prepare('SELECT hash, term FROM blobs').all(); inspect.close();
  expect({ outcome, rows }).toEqual({ outcome: 'rejected', rows: [{ hash: hash(value), term: new Uint8Array(Buffer.from(value)) }] });
  expect(await readFile(f.path)).toEqual(before);
});
it('refuses an unclaimed SQLite database containing sqliteX user data instead of adopting it', async () => {
  const f = await fixture();
  await f.owner.write(hash('seed'), 'seed'); await f.owner.close();
  const db = new DatabaseSync(f.path);
  db.exec("DROP TABLE blobs; PRAGMA application_id=0; PRAGMA user_version=0; CREATE TABLE sqliteXforeign(value TEXT); INSERT INTO sqliteXforeign VALUES('retain me');"); db.close();
  const before = await readFile(f.path), retry = reopen(f.directory);
  await expect(retry.write(hash('new'), 'new')).rejects.toThrow('identity/version/encoding'); await retry.close();
  expect(await readFile(f.path)).toEqual(before);
  const inspect = new DatabaseSync(f.path, { readOnly: true });
  expect(inspect.prepare('PRAGMA application_id').get()!.application_id).toBe(0);
  expect(inspect.prepare('SELECT value FROM sqliteXforeign').all()).toEqual([{ value: 'retain me' }]); inspect.close();
});
