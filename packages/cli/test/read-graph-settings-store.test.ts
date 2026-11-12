import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { DashboardDB, SCHEMA_VERSION } from '@origintrail-official/dkg-node-ui';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  NODE_DATABASE_FILE,
  ReadGraphSettingsError,
  ReadGraphSettingsUnavailableError,
  SqliteReadGraphSettingsStore,
  readReadGraphSettings,
  withSettingsChange,
} from '../src/read-graph-settings-store.js';

const CURATED = `0x${'cd'.repeat(20)}/my-project`;

let dir: string;
let dashboards: DashboardDB[];
/** The node's database, as the daemon opens it, and the settings store over its handle. */
const open = () => {
  const dashboard = new DashboardDB({ dataDir: dir });
  dashboards.push(dashboard);
  return { dashboard, store: new SqliteReadGraphSettingsStore(dashboard) };
};

/** A context graph's rows as stored, with when and by whom each changed. */
function rowsOf(dashboard: DashboardDB, contextGraphId: string) {
  return {
    modes: dashboard.db.prepare('SELECT layer, mode, updated_at AS updatedAt, updated_by AS updatedBy FROM read_graph_modes WHERE context_graph_id = ? ORDER BY layer')
      .all(contextGraphId) as Array<{ layer: string; mode: string; updatedAt: number; updatedBy: string }>,
    semantics: dashboard.db.prepare('SELECT semantics, updated_at AS updatedAt, updated_by AS updatedBy FROM view_semantics_defaults WHERE context_graph_id = ?')
      .get(contextGraphId),
  };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dkg-read-graph-settings-'));
  dashboards = [];
});

afterEach(async () => {
  for (const dashboard of dashboards.splice(0)) dashboard.close();
  vi.useRealTimers();
  await rm(dir, { recursive: true, force: true });
});

describe('the read-graph settings in the node\'s database', () => {
  it('live in node-ui.db, whose schema holds their tables, and start empty', () => {
    const { dashboard, store } = open();
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(39);
    const tables = (dashboard.db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'
      AND name IN ('read_graph_modes', 'view_semantics_defaults', 'read_graph_settings_meta') ORDER BY name`).all() as Array<{ name: string }>)
      .map((row) => row.name);
    expect(tables).toEqual(['read_graph_modes', 'read_graph_settings_meta', 'view_semantics_defaults']);
    expect(store.list()).toEqual([]);
    expect(store.get(CURATED)).toEqual({ layers: {} });
    expect(store.importedFromConfigAt()).toBeUndefined();
  });

  it('sets modes and a view-semantics default in one change, and lists them by context graph', () => {
    vi.useFakeTimers({ now: 1_000, toFake: ['Date'] });
    const { dashboard, store } = open();
    store.set(CURATED, { layers: { 'verifiable-memory': 'serve', 'working-memory': 'build' }, viewSemantics: 'merged' }, 'api');
    store.set('notes', { viewSemantics: 'per-asset' }, 'agent:0xabc');
    expect(store.get(CURATED)).toEqual({ layers: { 'verifiable-memory': 'serve', 'working-memory': 'build' }, viewSemantics: 'merged' });
    expect(store.list()).toEqual([
      { contextGraphId: CURATED, layers: { 'verifiable-memory': 'serve', 'working-memory': 'build' }, viewSemantics: 'merged' },
      { contextGraphId: 'notes', layers: {}, viewSemantics: 'per-asset' },
    ]);
    expect(dashboard.db.prepare('SELECT context_graph_id, layer, mode, updated_at, updated_by FROM read_graph_modes ORDER BY layer').all()).toEqual([
      { context_graph_id: CURATED, layer: 'verifiable-memory', mode: 'serve', updated_at: 1_000, updated_by: 'api' },
      { context_graph_id: CURATED, layer: 'working-memory', mode: 'build', updated_at: 1_000, updated_by: 'api' },
    ]);
  });

  it('keeps the time and actor of a mode\'s last change when a change leaves it as it is, and removes a default on null', () => {
    vi.useFakeTimers({ now: 1_000, toFake: ['Date'] });
    const { dashboard, store } = open();
    store.set(CURATED, { layers: { 'verifiable-memory': 'build', 'working-memory': 'off' }, viewSemantics: 'merged' }, 'cli');
    vi.setSystemTime(2_000);
    store.set(CURATED, { layers: { 'verifiable-memory': 'serve', 'working-memory': 'off' }, viewSemantics: 'merged' }, 'ui');
    expect(rowsOf(dashboard, CURATED)).toEqual({
      modes: [
        { layer: 'verifiable-memory', mode: 'serve', updatedAt: 2_000, updatedBy: 'ui' },
        { layer: 'working-memory', mode: 'off', updatedAt: 1_000, updatedBy: 'cli' },
      ],
      semantics: { semantics: 'merged', updatedAt: 1_000, updatedBy: 'cli' },
    });
    store.set(CURATED, { viewSemantics: null }, 'api');
    expect(store.get(CURATED)).toEqual({ layers: { 'verifiable-memory': 'serve', 'working-memory': 'off' } });
  });

  it('removes every setting of a context graph', () => {
    const { store } = open();
    store.set(CURATED, { layers: { 'verifiable-memory': 'serve' }, viewSemantics: 'merged' }, 'ui');
    store.set('notes', { layers: { 'verifiable-memory': 'build' } }, 'api');
    store.remove(CURATED, 'api');
    expect(store.list()).toEqual([{ contextGraphId: 'notes', layers: { 'verifiable-memory': 'build' } }]);
    store.remove('never-set', 'cli');
    expect(store.list()).toHaveLength(1);
  });

  it('refuses a change it cannot hold, and writes nothing of it', () => {
    const { store } = open();
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
    expect(refused(CURATED, { layers: { 'verifiable-memory': 'build' } }, 'agent:mcp‮')).toHaveLength(1);
    expect(refused(CURATED, ['build'], 'api')).toEqual(['the change must be an object']);
    expect(() => store.remove(CURATED, 'agent:has space')).toThrow(ReadGraphSettingsError);
    expect(store.list()).toEqual([]);
  });

  it('imports config.json\'s rules once, in one transaction, with the time of the import', () => {
    const { dashboard, store } = open();
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
    expect(rowsOf(dashboard, 'notes').modes.map((row) => [row.layer, row.updatedBy])).toEqual([['verifiable-memory', 'import'], ['working-memory', 'api']]);
    // A refused entry imports nothing and leaves the recorded time as it was.
    store.remove(CURATED, 'cli');
    store.remove('notes', 'cli');
    expect(() => store.importFromConfig([
      { contextGraphId: 'notes', layers: { 'verifiable-memory': 'build' } },
      { contextGraphId: '_private', layers: { 'verifiable-memory': 'build' } },
    ], 6_000)).toThrow(ReadGraphSettingsError);
    expect(store.importedFromConfigAt()).toBe(5_000);
    expect(store.list()).toEqual([]);
  });

  it('leaves nothing of an import that SQLite stops part way, and records no import time', () => {
    const { dashboard, store } = open();
    store.set('drafts', { layers: { 'working-memory': 'build' } }, 'cli');
    // A trigger refuses the second entry's rows, after the first entry's are written.
    dashboard.db.exec(`CREATE TRIGGER refuse_notes BEFORE INSERT ON read_graph_modes WHEN NEW.context_graph_id = 'notes'
      BEGIN SELECT RAISE(ABORT, 'refused by the test'); END;`);
    expect(() => store.importFromConfig([
      { contextGraphId: CURATED, layers: { 'verifiable-memory': 'serve' }, viewSemantics: 'merged' },
      { contextGraphId: 'notes', layers: { 'verifiable-memory': 'build' } },
    ], 8_000)).toThrow(/refused by the test/);
    expect(store.list()).toEqual([{ contextGraphId: 'drafts', layers: { 'working-memory': 'build' } }]);
    expect(store.importedFromConfigAt()).toBeUndefined();
  });

  it('is read by another process without writing, through the node\'s database opened read-only', () => {
    const { dashboard, store } = open();
    store.set(CURATED, { layers: { 'verifiable-memory': 'serve' } }, 'cli');
    store.importFromConfig([], 7_000);
    dashboard.close();
    dashboards.splice(0);
    expect(readReadGraphSettings(dir)).toEqual({
      entries: [{ contextGraphId: CURATED, layers: { 'verifiable-memory': 'serve' } }],
      importedFromConfigAt: 7_000,
    });
    // A store over a read-only handle writes nothing.
    const db = new Database(join(dir, NODE_DATABASE_FILE), { readonly: true });
    try {
      expect(() => new SqliteReadGraphSettingsStore({ db }, { readOnly: true }).set(CURATED, { layers: { 'verifiable-memory': 'off' } }, 'cli'))
        .toThrow(ReadGraphSettingsUnavailableError);
    } finally {
      db.close();
    }
  });

  it('gives nothing to read where there is no node database, or one from before the settings', async () => {
    expect(readReadGraphSettings(dir)).toBeUndefined();
    expect(existsSync(join(dir, NODE_DATABASE_FILE))).toBe(false);
    const older = new Database(join(dir, NODE_DATABASE_FILE));
    older.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL); PRAGMA user_version = 38;');
    older.close();
    expect(readReadGraphSettings(dir)).toBeUndefined();
  });

  it('previews a change as the table holds it after the change: the one rule for every preview', () => {
    const { store } = open();
    store.set(CURATED, { layers: { 'working-memory': 'build', 'verifiable-memory': 'serve' }, viewSemantics: 'merged' }, 'api');
    store.set('notes', { layers: { 'verifiable-memory': 'build' } }, 'api');
    const changes = [
      [CURATED, { layers: { 'working-memory': 'off' } }],
      [CURATED, { viewSemantics: null }],
      ['alpha', { layers: { 'shared-working-memory': 'serve' }, viewSemantics: 'per-asset' }],
      ['notes', { viewSemantics: 'merged', layers: { 'verifiable-memory': 'build' } }],
    ] as const;
    for (const [contextGraphId, change] of changes) {
      const preview = withSettingsChange(store.list(), contextGraphId, change);
      store.set(contextGraphId, change, 'api');
      expect(preview, `${contextGraphId} ${JSON.stringify(change)}`).toEqual(store.list());
    }
    expect(store.list().map((entry) => entry.contextGraphId)).toEqual([CURATED, 'alpha', 'notes']);
    expect(store.get(CURATED)).toEqual({ layers: { 'working-memory': 'off', 'verifiable-memory': 'serve' } });
  });

  it('answers nothing once closed', () => {
    const { store } = open();
    store.close();
    expect(() => store.list()).toThrow(ReadGraphSettingsUnavailableError);
  });
});
