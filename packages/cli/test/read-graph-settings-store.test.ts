import { existsSync, statSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  READ_GRAPH_SETTINGS_FILE,
  ReadGraphSettingsError,
  ReadGraphSettingsUnavailableError,
  openReadGraphSettingsStore,
  readReadGraphSettings,
  type SqliteReadGraphSettingsStore,
} from '../src/read-graph-settings-store.js';

const CURATED = `0x${'cd'.repeat(20)}/my-project`;

let dir: string;
const opened: SqliteReadGraphSettingsStore[] = [];
const open = () => {
  const store = openReadGraphSettingsStore(dir);
  opened.push(store);
  return store;
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dkg-read-graph-settings-'));
});

afterEach(async () => {
  for (const store of opened.splice(0)) store.close();
  vi.useRealTimers();
  await rm(dir, { recursive: true, force: true });
});

/** The rows as stored, read straight from the file. */
function rows(sql: string): Array<Record<string, unknown>> {
  const db = new DatabaseSync(join(dir, READ_GRAPH_SETTINGS_FILE), { readOnly: true });
  try {
    return db.prepare(sql).all() as Array<Record<string, unknown>>;
  } finally {
    db.close();
  }
}

describe('the read-graph settings table', () => {
  it('is created owner-only in WAL mode with schema v1, and holds no settings', () => {
    const store = open();
    const path = join(dir, READ_GRAPH_SETTINGS_FILE);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(rows('PRAGMA journal_mode')).toEqual([{ journal_mode: 'wal' }]);
    expect(rows('SELECT key, value FROM schema_meta')).toEqual([{ key: 'version', value: '1' }]);
    expect(store.list()).toEqual([]);
    expect(store.get(CURATED)).toEqual({ layers: {} });
    expect(store.importedFromConfigAt()).toBeUndefined();
  });

  it('sets modes and a view-semantics default in one change, and lists them by context graph', () => {
    vi.useFakeTimers({ now: 1_000, toFake: ['Date'] });
    const store = open();
    store.set(CURATED, { layers: { 'verifiable-memory': 'serve', 'working-memory': 'build' }, viewSemantics: 'merged' }, 'api');
    store.set('notes', { viewSemantics: 'per-asset' }, 'agent:0xabc');
    expect(store.get(CURATED)).toEqual({ layers: { 'verifiable-memory': 'serve', 'working-memory': 'build' }, viewSemantics: 'merged' });
    expect(store.list()).toEqual([
      { contextGraphId: CURATED, layers: { 'verifiable-memory': 'serve', 'working-memory': 'build' }, viewSemantics: 'merged' },
      { contextGraphId: 'notes', layers: {}, viewSemantics: 'per-asset' },
    ]);
    expect(rows('SELECT context_graph_id, layer, mode, updated_at, updated_by FROM read_graph_modes ORDER BY layer')).toEqual([
      { context_graph_id: CURATED, layer: 'verifiable-memory', mode: 'serve', updated_at: 1_000, updated_by: 'api' },
      { context_graph_id: CURATED, layer: 'working-memory', mode: 'build', updated_at: 1_000, updated_by: 'api' },
    ]);
  });

  it('keeps the time and actor of a mode\'s last change when a change leaves it as it is, and removes a default on null', () => {
    vi.useFakeTimers({ now: 1_000, toFake: ['Date'] });
    const store = open();
    store.set(CURATED, { layers: { 'verifiable-memory': 'build', 'working-memory': 'off' }, viewSemantics: 'merged' }, 'cli');
    vi.setSystemTime(2_000);
    store.set(CURATED, { layers: { 'verifiable-memory': 'serve', 'working-memory': 'off' }, viewSemantics: 'merged' }, 'ui');
    expect(rows('SELECT layer, mode, updated_at, updated_by FROM read_graph_modes ORDER BY layer')).toEqual([
      { layer: 'verifiable-memory', mode: 'serve', updated_at: 2_000, updated_by: 'ui' },
      { layer: 'working-memory', mode: 'off', updated_at: 1_000, updated_by: 'cli' },
    ]);
    expect(rows('SELECT semantics, updated_at, updated_by FROM view_semantics_defaults')).toEqual([
      { semantics: 'merged', updated_at: 1_000, updated_by: 'cli' },
    ]);
    store.set(CURATED, { viewSemantics: null }, 'api');
    expect(store.get(CURATED)).toEqual({ layers: { 'verifiable-memory': 'serve', 'working-memory': 'off' } });
  });

  it('removes every setting of a context graph', () => {
    const store = open();
    store.set(CURATED, { layers: { 'verifiable-memory': 'serve' }, viewSemantics: 'merged' }, 'api');
    store.set('notes', { layers: { 'verifiable-memory': 'build' } }, 'api');
    store.remove(CURATED, 'api');
    expect(store.list()).toEqual([{ contextGraphId: 'notes', layers: { 'verifiable-memory': 'build' } }]);
    store.remove('never-set', 'cli');
    expect(store.list()).toHaveLength(1);
  });

  it('refuses a change it cannot hold, and writes nothing of it', () => {
    const store = open();
    const refused = (contextGraphId: unknown, change: unknown, actor: unknown) => {
      try {
        store.set(contextGraphId as string, change as never, actor as string);
      } catch (error) {
        expect(error).toBeInstanceOf(ReadGraphSettingsError);
        expect((error as ReadGraphSettingsError).code).toBe('READ_GRAPH_SETTINGS_INVALID');
        return (error as ReadGraphSettingsError).issues;
      }
      throw new Error('expected the change to be refused');
    };
    expect(refused('_private', { layers: { 'verifiable-memory': 'build' } }, 'api')).toEqual([
      '"_private" is not a context graph ID that can have read graphs',
    ]);
    expect(refused(CURATED, { layers: { vm: 'build', 'working-memory': 'on' }, viewSemantics: 'joined' }, 'api')).toEqual([
      '"vm" is not a layer (layers: working-memory, shared-working-memory, verifiable-memory)',
      'the mode for working-memory must be one of off, build, serve (got "on")',
      'viewSemantics must be one of per-asset, merged, or null (got "joined")',
    ]);
    expect(refused(CURATED, { layers: { 'verifiable-memory': 'build' } }, 'someone')).toEqual([
      '"someone" is not an actor (cli, api, ui, import or agent:<id>)',
    ]);
    expect(refused(CURATED, { layers: { 'verifiable-memory': 'build' } }, 'agent:')).toHaveLength(1);
    expect(refused(CURATED, ['build'], 'api')).toEqual(['the change must be an object']);
    expect(() => store.remove(CURATED, 'agent:has space')).toThrow(ReadGraphSettingsError);
    expect(store.list()).toEqual([]);
  });

  it('imports config.json\'s rules once, in one transaction, with the time of the import', async () => {
    const store = open();
    store.set('notes', { layers: { 'working-memory': 'serve' } }, 'api');
    store.importFromConfig([
      { contextGraphId: CURATED, layers: { 'verifiable-memory': 'serve', 'shared-working-memory': 'serve', 'working-memory': 'serve' }, viewSemantics: 'merged' },
      { contextGraphId: 'notes', layers: { 'verifiable-memory': 'build' } },
    ], 5_000);
    expect(store.importedFromConfigAt()).toBe(5_000);
    expect(store.list()).toEqual([
      { contextGraphId: CURATED, layers: { 'verifiable-memory': 'serve', 'shared-working-memory': 'serve', 'working-memory': 'serve' }, viewSemantics: 'merged' },
      { contextGraphId: 'notes', layers: { 'working-memory': 'serve', 'verifiable-memory': 'build' } },
    ]);
    expect(rows("SELECT layer, updated_by FROM read_graph_modes WHERE context_graph_id = 'notes' ORDER BY layer")).toEqual([
      { layer: 'verifiable-memory', updated_by: 'import' },
      { layer: 'working-memory', updated_by: 'api' },
    ]);
    // A refused entry imports nothing and records no time.
    const other = await mkdtemp(join(tmpdir(), 'dkg-read-graph-settings-'));
    const fresh = openReadGraphSettingsStore(other);
    try {
      expect(() => fresh.importFromConfig([
        { contextGraphId: 'notes', layers: { 'verifiable-memory': 'build' } },
        { contextGraphId: '_private', layers: { 'verifiable-memory': 'build' } },
      ], 6_000)).toThrow(ReadGraphSettingsError);
      expect(fresh.importedFromConfigAt()).toBeUndefined();
      expect(fresh.list()).toEqual([]);
    } finally {
      fresh.close();
      await rm(other, { recursive: true, force: true });
    }
  });

  it('leaves nothing of an import that SQLite stops part way, and records no import time', () => {
    const store = open();
    store.set('drafts', { layers: { 'working-memory': 'build' } }, 'cli');
    // A trigger refuses the second entry's rows, after the first entry's are written.
    const db = new DatabaseSync(join(dir, READ_GRAPH_SETTINGS_FILE));
    db.exec(`CREATE TRIGGER refuse_notes BEFORE INSERT ON read_graph_modes WHEN NEW.context_graph_id = 'notes'
      BEGIN SELECT RAISE(ABORT, 'refused by the test'); END;`);
    db.close();
    expect(() => store.importFromConfig([
      { contextGraphId: CURATED, layers: { 'verifiable-memory': 'serve' }, viewSemantics: 'merged' },
      { contextGraphId: 'notes', layers: { 'verifiable-memory': 'build' } },
    ], 8_000)).toThrow(/refused by the test/);
    expect(store.list()).toEqual([{ contextGraphId: 'drafts', layers: { 'working-memory': 'build' } }]);
    expect(store.importedFromConfigAt()).toBeUndefined();
  });

  it('keeps its settings across a reopen, and is read by another process without writing', () => {
    const store = open();
    store.set(CURATED, { layers: { 'verifiable-memory': 'serve' } }, 'cli');
    store.importFromConfig([], 7_000);
    store.close();
    expect(readReadGraphSettings(dir)).toEqual({
      entries: [{ contextGraphId: CURATED, layers: { 'verifiable-memory': 'serve' } }],
      importedFromConfigAt: 7_000,
    });
    expect(open().get(CURATED)).toEqual({ layers: { 'verifiable-memory': 'serve' } });
  });

  it('gives nothing to read in a directory without a table, and creates none there', async () => {
    expect(readReadGraphSettings(dir)).toBeUndefined();
    expect(existsSync(join(dir, READ_GRAPH_SETTINGS_FILE))).toBe(false);
  });

  it('refuses a table that a newer release wrote, and leaves it unchanged', () => {
    const db = new DatabaseSync(join(dir, READ_GRAPH_SETTINGS_FILE));
    db.exec("CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO schema_meta VALUES ('version', '2');");
    db.close();
    expect(() => openReadGraphSettingsStore(dir)).toThrow(ReadGraphSettingsUnavailableError);
    expect(() => openReadGraphSettingsStore(dir)).toThrow(/schema version 2, which this release does not read/);
    expect(rows("SELECT name FROM sqlite_master WHERE type = 'table'")).toEqual([{ name: 'schema_meta' }]);
    expect(() => readReadGraphSettings(dir)).toThrow(ReadGraphSettingsUnavailableError);
  });

  it('refuses a file that is not a table', async () => {
    await writeFile(join(dir, READ_GRAPH_SETTINGS_FILE), 'not a database, only text that is long enough to have a header'.repeat(4));
    expect(() => openReadGraphSettingsStore(dir)).toThrow(ReadGraphSettingsUnavailableError);
  });

  it('answers nothing once closed', () => {
    const store = openReadGraphSettingsStore(dir);
    store.close();
    store.close();
    expect(() => store.list()).toThrow(ReadGraphSettingsUnavailableError);
  });
});
