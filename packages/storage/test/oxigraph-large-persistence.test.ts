import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import oxigraph from 'oxigraph';
import { OxigraphStore } from '../src/adapters/oxigraph.js';

const readLimit = vi.hoisted(() => ({ path: '', maxBytes: Infinity, failRead: false, failOpen: false, failClose: false }));
const writeFault = vi.hoisted(() => ({ path: '', bytesWritten: 0 }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...fs,
    open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args);
      if (String(args[0]) !== writeFault.path || args[1] !== 'w') return handle;
      const write = handle.writeFile.bind(handle);
      handle.writeFile = async (...writeArgs: Parameters<typeof handle.writeFile>) => {
        if (writeFault.bytesWritten > 0) {
          throw Object.assign(new Error('injected mid-snapshot write failure'), { code: 'EIO' });
        }
        await write(...writeArgs);
        writeFault.bytesWritten = (await handle.stat()).size;
      };
      return handle;
    },
  };
});
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return {
    ...fs,
    readFileSync: (...args: Parameters<typeof fs.readFileSync>) => {
      if (String(args[0]) === readLimit.path && fs.statSync(args[0]).size > readLimit.maxBytes) {
        throw new RangeError('Cannot create a string longer than the simulated engine ceiling');
      }
      return Reflect.apply(fs.readFileSync, fs, args);
    },
    readSync: (...args: unknown[]) => {
      if (readLimit.failRead) throw Object.assign(new Error('injected snapshot read failure'), { code: 'EIO' });
      return Reflect.apply(fs.readSync, fs, args);
    },
    openSync: (...args: unknown[]) => {
      if (readLimit.failOpen) throw Object.assign(new Error('injected open failure'), { code: 'EACCES' });
      return Reflect.apply(fs.openSync, fs, args);
    },
    closeSync: (...args: unknown[]) => {
      const result = Reflect.apply(fs.closeSync, fs, args);
      if (readLimit.failClose) throw new Error('injected close failure');
      return result;
    },
  };
});

const dirs: string[] = [];
function snapshotPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dkg-large-persist-'));
  dirs.push(dir);
  return join(dir, 'store.nq');
}
afterEach(() => {
  readLimit.path = '';
  readLimit.maxBytes = Infinity;
  readLimit.failRead = false;
  readLimit.failOpen = false;
  readLimit.failClose = false;
  writeFault.path = '';
  writeFault.bytesWritten = 0;
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('Oxigraph snapshots beyond one JavaScript string', () => {
  it('persists and restores all data when a whole-store dump exceeds the engine string ceiling', async () => {
    const path = snapshotPath();
    const store = new OxigraphStore(path);
    const originalDump = oxigraph.Store.prototype.dump;
    // A small deterministic version of the real V8 failure. Individual RDF terms
    // fit; only the aggregate representation is too large. The native store,
    // file writer and readback are real.
    vi.spyOn(oxigraph.Store.prototype, 'dump').mockImplementation(function (options) {
      const text = originalDump.call(this, options);
      if (Buffer.byteLength(text) > 4096) throw new RangeError('Cannot create a string longer than 4096');
      return text;
    });
    try {
      await store.insert(Array.from({ length: 1200 }, (_, n) => ({
        subject: `urn:asset:${n}`,
        predicate: 'urn:text',
        object: JSON.stringify(`row ${n}: 💧 quote " tab\t newline\n`),
        graph: `urn:graph:${n % 3}`,
      })));
      await expect(store.flush()).resolves.toBeUndefined();
      const reopened = new OxigraphStore(path);
      expect(await reopened.countQuads()).toBe(1200);
      expect(await reopened.query(`ASK { GRAPH <urn:graph:2> { <urn:asset:1199> <urn:text> ${JSON.stringify('row 1199: 💧 quote " tab\t newline\n')} } }`))
        .toEqual({ type: 'boolean', value: true });
      await reopened.close();
    } finally {
      vi.restoreAllMocks();
      await store.close();
    }
  });

  it('hydrates a large existing snapshot through one parser with cross-chunk blank-node identity', async () => {
    const path = snapshotPath();
    const middle = Array.from({ length: 2400 }, (_, n) => `<urn:s${n}> <urn:p> "é🙂 ${n}" <urn:g> .\n`).join('');
    writeFileSync(path, `_:shared <urn:p> "first" .\n${middle}<urn:end> <urn:p> _:shared <urn:g> .\n`);
    readLimit.path = path;
    readLimit.maxBytes = 4096;
    let store: OxigraphStore | undefined;
    try {
      expect(() => { store = new OxigraphStore(path); }).not.toThrow();
      expect(await store!.countQuads()).toBe(2402);
      expect(await store!.query('ASK { ?b <urn:p> "first" . GRAPH <urn:g> { <urn:end> <urn:p> ?b } }'))
        .toEqual({ type: 'boolean', value: true });
      expect(await store!.query('ASK { GRAPH <urn:g> { <urn:s2399> <urn:p> "é🙂 2399" } }'))
        .toEqual({ type: 'boolean', value: true });
    } finally {
      readLimit.path = '';
      await store?.close();
    }
    expect(readFileSync(path, 'utf8')).toContain('2399');
    const reopened = new OxigraphStore(path);
    try {
      expect(await reopened.countQuads()).toBe(2402);
      expect(await reopened.query('ASK { ?b <urn:p> "first" . GRAPH <urn:g> { <urn:end> <urn:p> ?b } }'))
        .toEqual({ type: 'boolean', value: true });
    } finally { await reopened.close(); }
  });

  it('keeps the previous snapshot after a mid-stream write fails and retries the entire new snapshot', async () => {
    const path = snapshotPath();
    const store = new OxigraphStore(path);
    try {
      await store.insert([{ subject: 'urn:original', predicate: 'urn:p', object: '"durable"', graph: 'urn:g' }]);
      await store.flush();
      const committed = readFileSync(path);
      const additions = Array.from({ length: 1800 }, (_, n) => ({
        subject: `urn:new:${n}`, predicate: 'urn:p', object: JSON.stringify(`${n}: ${'é🙂'.repeat(24)}`), graph: 'urn:g',
      }));
      writeFault.path = `${path}.tmp`;
      await store.insert(additions);
      await expect(store.flush()).rejects.toMatchObject({ code: 'EIO' });
      expect(writeFault.bytesWritten).toBeGreaterThan(0);
      // Inspect disk before closing the writer: close() itself flushes and could
      // otherwise conceal an acknowledgement or atomic-replacement regression.
      expect(readFileSync(path)).toEqual(committed);
      writeFault.path = '';
      const previous = new OxigraphStore(path);
      try {
        expect(await previous.countQuads()).toBe(1);
        expect(await previous.query('ASK { GRAPH <urn:g> { <urn:original> <urn:p> "durable" } }'))
          .toEqual({ type: 'boolean', value: true });
      } finally { await previous.close(); }

      await store.flush();
      const recovered = new OxigraphStore(path);
      try {
        expect(await recovered.countQuads()).toBe(additions.length + 1);
        const result = await recovered.query('SELECT ?s ?value WHERE { GRAPH <urn:g> { ?s <urn:p> ?value } }');
        expect(result.type).toBe('bindings');
        if (result.type !== 'bindings') throw new Error('expected stored snapshot rows');
        expect(result.bindings.map(row => [row.s, row.value]).sort()).toEqual([
          ['urn:original', '"durable"'], ...additions.map(quad => [quad.subject, quad.object]),
        ].sort());
      } finally { await recovered.close(); }
    } finally {
      writeFault.path = '';
      await store.close();
    }
  });

  it('preserves a valid snapshot after a streaming read fails', () => {
    const path = snapshotPath();
    const data = '<urn:s> <urn:p> "intact" <urn:g> .\n';
    writeFileSync(path, data);
    readLimit.failRead = true;
    expect(() => new OxigraphStore(path)).toThrow(/failed to read persist file.*injected snapshot read failure/);
    readLimit.failRead = false;
    expect(readFileSync(path, 'utf8')).toBe(data);
    expect(existsSync(path)).toBe(true);
    expect(readdirSync(dirs.at(-1)!)).toEqual(['store.nq']);
  });

  it.each(['failOpen', 'failClose'] as const)('preserves the file when %s interrupts hydration', (failure) => {
    const path = snapshotPath();
    const data = '<urn:s> <urn:p> "intact" .\n';
    writeFileSync(path, data);
    readLimit[failure] = true;
    expect(() => new OxigraphStore(path)).toThrow(/failed to read persist file/);
    readLimit[failure] = false;
    expect(readFileSync(path, 'utf8')).toBe(data);
    expect(readdirSync(dirs.at(-1)!)).toEqual(['store.nq']);
  });

  it('keeps a legacy individual literal larger than one output chunk intact', async () => {
    const path = snapshotPath();
    const text = '🙂'.repeat(20_000);
    writeFileSync(path, `<urn:big> <urn:p> "${text}" .\n<urn:small> <urn:p> "tail" .\n`);
    const store = new OxigraphStore(path);
    await store.close();
    const reopened = new OxigraphStore(path);
    try {
      expect(await reopened.countQuads()).toBe(2);
      expect(await reopened.query(`ASK { <urn:big> <urn:p> "${text}" }`)).toEqual({ type: 'boolean', value: true });
      expect(await reopened.query('ASK { <urn:small> <urn:p> "tail" }')).toEqual({ type: 'boolean', value: true });
    } finally { await reopened.close(); }
  });
});
