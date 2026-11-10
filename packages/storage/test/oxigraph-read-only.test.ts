/**
 * A read-only open of a file-backed Oxigraph store (#3551).
 *
 * The CLI's offline publisher reads open the node's store from a second process. A file-backed store
 * writes its whole in-memory copy back to the file on close, so a reader that loaded the file before
 * the owner's latest flush would put the older data back. A read-only open loads the file and never
 * writes it: not on close, not on flush, and not when the file fails to parse.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OxigraphStore } from '../src/adapters/oxigraph.js';
import {
  OXIGRAPH_STORE_READ_ONLY_CODE,
  OxigraphStoreReadOnlyError,
  createTripleStore,
  type Quad,
  type TripleStore,
} from '../src/index.js';
import { authorCommitInput } from './rfc64-author-commit-cas-harness.js';

const G = 'urn:test:read-only:queue';
const META = 'urn:test:read-only:meta';

function job(id: string): Quad {
  return { subject: `urn:test:read-only:job:${id}`, predicate: 'http://schema.org/name', object: `"${id}"`, graph: G };
}

/** What a later reader can compare: the bytes, and the file itself (a rename over it is a new inode). */
function fileState(path: string) {
  const stat = statSync(path, { bigint: true });
  return { bytes: readFileSync(path), ino: stat.ino, mtimeNs: stat.mtimeNs };
}

async function names(store: TripleStore): Promise<string[]> {
  const result = await store.query(`SELECT ?name WHERE { GRAPH <${G}> { ?job <http://schema.org/name> ?name } } ORDER BY ?name`);
  return result.type === 'bindings' ? result.bindings.map(row => row['name']!) : [];
}

/** Every write of the TripleStore surface, each with arguments that would change the data. */
const WRITES: ReadonlyArray<readonly [string, (store: TripleStore) => Promise<unknown>]> = [
  ['insert', store => store.insert([job('c')])],
  ['delete', store => store.delete([job('a')])],
  ['deleteByPattern', store => store.deleteByPattern({ graph: G })],
  ['deleteByPatternWithoutCount', store => store.deleteByPatternWithoutCount!({ graph: G })],
  ['dropGraph', store => store.dropGraph(G)],
  ['replaceGraph', store => store.replaceGraph!(G, [job('c')])],
  ['replaceAssetGroup', store => store.replaceAssetGroup!([
    { graphUri: G, graphQuads: [job('c')], metaGraphUri: META, metadataSubject: 'urn:test:read-only:meta:c', metadataQuads: [] },
  ])],
  ['replaceGraphAndSubject', store => store.replaceGraphAndSubject!(G, [job('c')], META, 'urn:test:read-only:meta:c', [])],
  ['replaceSubject', store => store.replaceSubject!(G, job('a').subject, [{ ...job('a'), object: '"a2"' }])],
  ['replaceSubjectAndInsert', store => store.replaceSubjectAndInsert!(G, job('a').subject, [{ ...job('a'), object: '"a2"' }], [job('d')])],
  ['rfc64AuthorCommitCasV1', store => store.rfc64AuthorCommitCasV1!(authorCommitInput())],
  ['deleteBySubjectPrefix', store => store.deleteBySubjectPrefix(G, 'urn:test:read-only:job:')],
  ['update', store => store.update!(`INSERT DATA { GRAPH <${G}> { <urn:test:read-only:job:c> <http://schema.org/name> "c" } }`)],
];

describe('a read-only OxigraphStore', () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'oxigraph-read-only-'));
    path = join(dir, 'store.nq');
    const owner = new OxigraphStore(path);
    await owner.insert([job('a'), job('b')]);
    await owner.close();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('loads the file and serves reads from it', async () => {
    const reader = new OxigraphStore(path, { readOnly: true });
    expect(await names(reader)).toEqual(['"a"', '"b"']);
    expect(await reader.countQuads(G)).toBe(2);
    await reader.close();
  });

  it.each(WRITES)('refuses %s, and neither its data nor the file changes', async (_name, write) => {
    const before = fileState(path);
    const reader = new OxigraphStore(path, { readOnly: true });
    const error = await write(reader).then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(OxigraphStoreReadOnlyError);
    expect(error).toMatchObject({ name: 'OxigraphStoreReadOnlyError', code: OXIGRAPH_STORE_READ_ONLY_CODE });
    expect((error as Error).message).toContain(path);
    expect(await names(reader)).toEqual(['"a"', '"b"']);
    await reader.flush();
    await reader.close();
    expect(fileState(path)).toEqual(before);
    expect(readdirSync(dir)).toEqual(['store.nq']);
  });

  it('leaves what the owner wrote after the open in place when it closes', async () => {
    const owner = new OxigraphStore(path);
    const reader = new OxigraphStore(path, { readOnly: true });
    // The owner moves on after the reader loaded the file: job a is removed, job c admitted, and flushed.
    await owner.delete([job('a')]);
    await owner.insert([job('c')]);
    await owner.flush();
    const ownerState = fileState(path);

    expect(await names(reader)).toEqual(['"a"', '"b"']);   // the reader keeps what it loaded
    await reader.flush();
    await reader.close();
    expect(fileState(path)).toEqual(ownerState);
    expect(await names(new OxigraphStore(path, { readOnly: true }))).toEqual(['"b"', '"c"']);
    await owner.close();
  });

  it('leaves a file it cannot parse where it is, unchanged, and throws', () => {
    writeFileSync(path, 'this is not valid n-quads ???\n', 'utf-8');
    const before = fileState(path);
    expect(() => new OxigraphStore(path, { readOnly: true })).toThrow(/left in place \(read-only open\)/);
    expect(readdirSync(dir)).toEqual(['store.nq']);
    expect(fileState(path)).toEqual(before);
  });

  it('opens a missing file as an empty store and creates nothing', async () => {
    const missing = join(dir, 'absent.nq');
    const reader = new OxigraphStore(missing, { readOnly: true });
    expect(await reader.countQuads()).toBe(0);
    await expect(reader.insert([job('c')])).rejects.toBeInstanceOf(OxigraphStoreReadOnlyError);
    await reader.close();
    expect(existsSync(missing)).toBe(false);
  });
});

describe('readOnly through createTripleStore', () => {
  let dir: string;
  let path: string;
  const opened: TripleStore[] = [];
  const open = async (config: Parameters<typeof createTripleStore>[0]) => {
    const store = await createTripleStore(config);
    opened.push(store);
    return store;
  };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'oxigraph-read-only-factory-'));
    path = join(dir, 'store.nq');
    const owner = new OxigraphStore(path);
    await owner.insert([job('a'), job('b')]);
    await owner.close();
  });

  afterEach(async () => {
    // close() is idempotent; this only reaps a worker a failed test left open.
    await Promise.all(opened.splice(0).map(store => store.close().catch(() => undefined)));
    rmSync(dir, { recursive: true, force: true });
  });

  it.each(['oxigraph-persistent', 'oxigraph-worker'])('%s: reads the file, refuses writes, and leaves what the owner wrote since in place', async (backend) => {
    const reader = await open({ backend, options: { path, readOnly: true } });
    expect(await names(reader)).toEqual(['"a"', '"b"']);
    // The worker keeps the refusal's name and code across the thread boundary.
    await expect(reader.insert([job('c')])).rejects.toMatchObject({ name: 'OxigraphStoreReadOnlyError', code: OXIGRAPH_STORE_READ_ONLY_CODE });
    await expect(reader.dropGraph(G)).rejects.toMatchObject({ code: OXIGRAPH_STORE_READ_ONLY_CODE });
    expect(await names(reader)).toEqual(['"a"', '"b"']);

    const owner = new OxigraphStore(path);
    await owner.delete([job('a')]);
    await owner.insert([job('c')]);
    await owner.close();
    const ownerState = fileState(path);
    await reader.flush?.();
    await reader.close();
    expect(fileState(path)).toEqual(ownerState);
    expect(readdirSync(dir)).toEqual(['store.nq']);
  });

  it('a store opened without readOnly still writes its file (the option is off by default)', async () => {
    const writer = await open({ backend: 'oxigraph-worker', options: { path } });
    await writer.insert([job('c')]);
    await writer.close();
    expect(await names(new OxigraphStore(path, { readOnly: true }))).toEqual(['"a"', '"b"', '"c"']);
  });

  it('the in-memory oxigraph backend honours readOnly too', async () => {
    const store = await open({ backend: 'oxigraph', options: { readOnly: true } });
    await expect(store.insert([job('c')])).rejects.toBeInstanceOf(OxigraphStoreReadOnlyError);
    expect(await store.countQuads()).toBe(0);
  });
});
