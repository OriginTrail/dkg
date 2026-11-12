import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryLayer, readScope, type ReadGraphKey } from '@origintrail-official/dkg-core';
import { READ_GRAPH_PLANNED_METHODS, OxigraphStore, readGraphModeOf, viewSemanticsOf, wrapReadGraphLayer, type TripleStore } from '@origintrail-official/dkg-storage';
import { QueryConfigError } from '../src/read-graphs-config.js';
import { READ_GRAPH_SETTINGS_FILE, SqliteReadGraphSettingsStore, openReadGraphSettingsStore } from '../src/read-graph-settings-store.js';
import { noteReadGraphStoreSupport, prepareDaemonReadGraphSettings, readGraphSettingsOutsideDaemon } from '../src/read-graph-settings-start.js';

const CURATED = `0x${'cd'.repeat(20)}/my-project`;
const vm = (contextGraphId: string): ReadGraphKey => ({ scope: readScope(contextGraphId), layer: MemoryLayer.VerifiableMemory });
const swm = (contextGraphId: string): ReadGraphKey => ({ scope: readScope(contextGraphId), layer: MemoryLayer.SharedWorkingMemory });
const wm = (contextGraphId: string): ReadGraphKey =>
  ({ scope: readScope(contextGraphId), layer: MemoryLayer.WorkingMemory, agentAddress: `0x${'ab'.repeat(20)}` });

let home: string;
let previousHome: string | undefined;
let lines: string[];
const log = (line: string) => { lines.push(line); };

beforeEach(async () => {
  previousHome = process.env.DKG_HOME;
  home = await mkdtemp(join(tmpdir(), 'dkg-read-graph-settings-start-'));
  process.env.DKG_HOME = home;
  lines = [];
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (previousHome === undefined) delete process.env.DKG_HOME;
  else process.env.DKG_HOME = previousHome;
  await rm(home, { recursive: true, force: true });
});

async function start(query: unknown, options: { checkpoint?: boolean; now?: number } = {}) {
  const settings = await prepareDaemonReadGraphSettings({
    query, role: 'edge', checkpoint: options.checkpoint ?? false, dataDir: home, log, now: () => options.now ?? 1_000,
  });
  return settings;
}

describe('the daemon\'s read-graph settings at start', () => {
  it('import config.json\'s rules for single context graphs once, and warn at every later start that they are ignored', async () => {
    const query = {
      readGraphs: { layers: { 'shared-working-memory': 'build' }, contextGraphs: { [CURATED]: 'serve' } },
      viewSemantics: { contextGraphs: { [CURATED]: 'merged' } },
    };
    const first = await start(query, { now: Date.UTC(2026, 10, 12, 8) });
    expect(lines).toEqual([
      '[read-graphs] Imported the read-graph settings of 1 context graph(s) from config.json into read-graph-settings.db. '
        + 'query.readGraphs.contextGraphs and query.viewSemantics.contextGraphs in config.json are deprecated and ignored from now on. '
        + 'Change read graphs per context graph with `dkg store read-graphs enable|disable` or the node\'s read-graph settings API.',
    ]);
    expect(readGraphModeOf(first.effective.readGraphs, vm(CURATED))).toBe('serve');
    expect(viewSemanticsOf(first.effective.viewSemantics, CURATED)).toBe('merged');
    expect(first.storeSettings).toEqual({ modes: first.effective.readGraphs, viewSemantics: first.effective.viewSemantics, whenUnsupported: 'refuse' });

    // The operator switches the context graph off through the API; config.json's rule no longer counts.
    const table = openReadGraphSettingsStore(home);
    table.set(CURATED, { layers: { 'verifiable-memory': 'off' } }, 'api');
    table.close();
    lines = [];
    const second = await start({ ...query, readGraphs: { ...query.readGraphs, contextGraphs: { [CURATED]: 'serve', notes: 'build' } } });
    expect(lines).toEqual([
      '[read-graphs] query.readGraphs.contextGraphs and query.viewSemantics.contextGraphs in config.json are deprecated and ignored: '
        + 'the settings were imported into read-graph-settings.db at 2026-11-12T08:00:00.000Z. '
        + 'Change read graphs per context graph with `dkg store read-graphs enable|disable` or the node\'s read-graph settings API.',
    ]);
    expect(readGraphModeOf(second.effective.readGraphs, vm(CURATED))).toBe('off');
    expect(readGraphModeOf(second.effective.readGraphs, vm('notes'))).toBe('off');
    expect(readGraphModeOf(second.effective.readGraphs, swm('notes'))).toBe('build');
  });

  it('carry the table\'s settings without a query section, and nothing when neither holds any', async () => {
    expect((await start(undefined)).storeSettings).toBeUndefined();
    expect(lines).toEqual([]);
    const table = openReadGraphSettingsStore(home);
    table.set(CURATED, { layers: { 'verifiable-memory': 'build' } }, 'cli');
    table.close();
    const settings = await start(undefined);
    expect(readGraphModeOf(settings.effective.readGraphs, vm(CURATED))).toBe('build');
    // Only the table keeps read graphs: an adapter that cannot keep them keeps none, and the start goes on.
    expect(settings.storeSettings?.whenUnsupported).toBe('off');
  });

  it('turn the table\'s modes off while the rollback target does not recognize read graphs, and still stop on the node\'s own', async () => {
    const table = openReadGraphSettingsStore(home);
    table.set(CURATED, { layers: { 'verifiable-memory': 'serve', 'working-memory': 'off' } }, 'api');
    table.close();
    await writeFile(join(home, 'previous-version'), '10.1.1\n');
    const settings = await start({ viewSemantics: 'merged' });
    expect(readGraphModeOf(settings.effective.readGraphs, vm(CURATED))).toBe('off');
    expect(lines).toEqual([
      `[read-graphs] Read graphs set for ${CURATED} (verifiable-memory) are off: the rollback target (${join(home, 'previous-version')}: 10.1.1) `
        + 'is older than 10.1.2, the first release that recognizes read graphs.',
    ]);
    await expect(start({ readGraphs: { layers: { 'verifiable-memory': 'build' } } })).rejects.toBeInstanceOf(QueryConfigError);
    // Nothing the table keeps, nothing to look up.
    await rm(join(home, 'previous-version'));
    await mkdir(join(home, 'previous-version'));
    const off = openReadGraphSettingsStore(home);
    off.set(CURATED, { layers: { 'verifiable-memory': 'off' } }, 'api');
    off.close();
    lines = [];
    expect((await start({})).effective.readGraphs.contextGraphs?.[CURATED]?.layers).toEqual({
      [MemoryLayer.VerifiableMemory]: 'off', [MemoryLayer.WorkingMemory]: 'off',
    });
    expect(lines).toEqual([]);
  });

  it('create no table on a node that starts from a public checkpoint, which keeps no read graphs', async () => {
    const settings = await start({ viewSemantics: 'merged', readGraphs: { contextGraphs: { [CURATED]: 'serve' } } }, { checkpoint: true });
    expect(existsSync(join(home, READ_GRAPH_SETTINGS_FILE))).toBe(false);
    expect(settings.storeSettings).toBeUndefined();
    expect(readGraphModeOf(settings.effective.readGraphs, vm(CURATED))).toBe('off');
    expect(lines).toEqual(['[read-graphs] query.readGraphs.contextGraphs in config.json is deprecated and ignored.']);
    await expect(start({ readGraphs: 'build' }, { checkpoint: true })).rejects.toBeInstanceOf(QueryConfigError);
  });

  it('go on with the node\'s own settings when the table cannot be opened', async () => {
    const db = new DatabaseSync(join(home, READ_GRAPH_SETTINGS_FILE));
    db.exec("CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO schema_meta VALUES ('version', '2');");
    db.close();
    const settings = await start({ readGraphs: 'build', viewSemantics: { contextGraphs: { [CURATED]: 'merged' } } });
    expect(settings.effective).toEqual({ readGraphs: { default: 'build' }, viewSemantics: {} });
    expect(lines).toEqual([
      expect.stringMatching(/^\[read-graphs\] read-graph-settings\.db cannot be opened, so no context graph has read-graph settings of its own: .*schema version 2/),
      '[read-graphs] query.viewSemantics.contextGraphs in config.json is deprecated and ignored.',
    ]);
  });

  it('go on with the node\'s own settings when the table opens but cannot be read', async () => {
    const db = new DatabaseSync(join(home, READ_GRAPH_SETTINGS_FILE));
    db.exec("CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO schema_meta VALUES ('version', '1');");
    db.close();
    const settings = await start({ readGraphs: 'build' });
    expect(settings.effective.readGraphs).toEqual({ default: 'build' });
    expect(lines).toEqual([
      expect.stringMatching(/^\[read-graphs\] read-graph-settings\.db cannot be read, so no context graph has read-graph settings of its own: .*read_graph_modes/),
    ]);
  });

  it('close the table once they are read: each change opens it again', async () => {
    const close = vi.spyOn(SqliteReadGraphSettingsStore.prototype, 'close');
    await start({ readGraphs: { contextGraphs: { [CURATED]: 'serve' } } });
    expect(close).toHaveBeenCalledTimes(1);
    // The file is free for another writer at once.
    const table = openReadGraphSettingsStore(home);
    table.set(CURATED, { layers: { 'working-memory': 'off' } }, 'cli');
    table.close();
  });

  it('say so after the store opens when it cannot keep the read graphs that the table sets', async () => {
    const table = openReadGraphSettingsStore(home);
    table.set(CURATED, { layers: { 'verifiable-memory': 'build' } }, 'api');
    table.close();
    const settings = await start(undefined);
    const backend = { backend: 'oxigraph-worker', options: { path: join(home, `store-${Math.random()}`) }, readGraphs: settings.storeSettings };
    // An adapter that implements a planned write and declares no read-graph capabilities.
    const unsupported = wrapReadGraphLayer({ delete: async () => undefined, close: async () => undefined } as unknown as TripleStore, backend);
    noteReadGraphStoreSupport(settings, unsupported, log);
    expect(lines).toEqual([
      '[read-graphs] The read graphs set in read-graph-settings.db are off: the node\'s store does not support read graphs '
        + '(its adapter does not send read-graph operations with delete).',
    ]);
    lines = [];
    const capable = Object.assign(new OxigraphStore(), { readGraphCapabilities: { methods: READ_GRAPH_PLANNED_METHODS, serialUpdates: true } });
    noteReadGraphStoreSupport(settings, wrapReadGraphLayer(capable, { ...backend, options: { path: join(home, `store-${Math.random()}`) } }), log);
    expect(lines).toEqual([]);
  });
});

describe('the read-graph settings of a store opened outside the daemon', () => {
  it('read the table the daemon wrote, without writing it', async () => {
    const table = openReadGraphSettingsStore(home);
    table.set(CURATED, { layers: { 'working-memory': 'build' }, viewSemantics: 'merged' }, 'api');
    table.importFromConfig([], 1_000);
    table.close();
    const settings = await readGraphSettingsOutsideDaemon(home, { nodeRole: 'edge' });
    expect(settings?.whenUnsupported).toBe('off');
    expect(readGraphModeOf(settings?.modes, wm(CURATED))).toBe('build');
    expect(viewSemanticsOf(settings?.viewSemantics, CURATED)).toBe('merged');
  });

  it('take config.json\'s rules over the table until the daemon has imported them, as the import will write them', async () => {
    const table = openReadGraphSettingsStore(home);
    table.set(CURATED, { layers: { 'working-memory': 'build', 'verifiable-memory': 'build' } }, 'api');
    table.close();
    const query = { readGraphs: { contextGraphs: { [CURATED]: { layers: { 'verifiable-memory': 'serve' } }, notes: 'build' } } };
    const before = await readGraphSettingsOutsideDaemon(home, { query });
    expect(readGraphModeOf(before?.modes, vm(CURATED))).toBe('serve');
    expect(readGraphModeOf(before?.modes, wm(CURATED))).toBe('build');
    expect(readGraphModeOf(before?.modes, vm('notes'))).toBe('build');
    // Once imported, the table alone holds them.
    const imported = openReadGraphSettingsStore(home);
    imported.importFromConfig([], 2_000);
    imported.close();
    const after = await readGraphSettingsOutsideDaemon(home, { query });
    expect(readGraphModeOf(after?.modes, vm(CURATED))).toBe('build');
    expect(readGraphModeOf(after?.modes, vm('notes'))).toBe('off');
  });

  it('take config.json\'s rules in a data directory without a table, and carry nothing without either', async () => {
    expect(await readGraphSettingsOutsideDaemon(home, {})).toBeUndefined();
    const settings = await readGraphSettingsOutsideDaemon(home, { query: { readGraphs: { contextGraphs: { notes: 'build' } } } });
    expect(readGraphModeOf(settings?.modes, vm('notes'))).toBe('build');
    expect(existsSync(join(home, READ_GRAPH_SETTINGS_FILE))).toBe(false);
  });
});
