import { readdir, mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DashboardDB } from '@origintrail-official/dkg-node-ui';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryLayer, readScope, type ReadGraphKey } from '@origintrail-official/dkg-core';
import { READ_GRAPH_PLANNED_METHODS, OxigraphStore, readGraphModeOf, viewSemanticsOf, wrapReadGraphLayer, type TripleStore } from '@origintrail-official/dkg-storage';
import { QueryConfigError } from '../src/read-graphs-config.js';
import { SqliteReadGraphSettingsStore } from '../src/read-graph-settings-store.js';
import {
  checkDaemonQuerySection,
  noteReadGraphStoreSupport,
  prepareDaemonReadGraphSettings,
  readGraphSettingsOutsideDaemon,
} from '../src/read-graph-settings-start.js';

const CURATED = `0x${'cd'.repeat(20)}/my-project`;
const vm = (contextGraphId: string): ReadGraphKey => ({ scope: readScope(contextGraphId), layer: MemoryLayer.VerifiableMemory });
const swm = (contextGraphId: string): ReadGraphKey => ({ scope: readScope(contextGraphId), layer: MemoryLayer.SharedWorkingMemory });
const wm = (contextGraphId: string): ReadGraphKey =>
  ({ scope: readScope(contextGraphId), layer: MemoryLayer.WorkingMemory, agentAddress: `0x${'ab'.repeat(20)}` });
const CHANGE_THEM = 'Change read graphs per context graph with `dkg store read-graphs enable|disable` or the node\'s read-graph settings API.';

let home: string;
let previousHome: string | undefined;
let lines: string[];
let dashboard: DashboardDB;
let table: SqliteReadGraphSettingsStore;
const log = (line: string) => { lines.push(line); };

beforeEach(async () => {
  previousHome = process.env.DKG_HOME;
  home = await mkdtemp(join(tmpdir(), 'dkg-read-graph-settings-start-'));
  process.env.DKG_HOME = home;
  lines = [];
  dashboard = new DashboardDB({ dataDir: home });
  table = new SqliteReadGraphSettingsStore(dashboard);
});

afterEach(async () => {
  vi.restoreAllMocks();
  try { dashboard.close(); } catch { /* closed by the test */ }
  if (previousHome === undefined) delete process.env.DKG_HOME;
  else process.env.DKG_HOME = previousHome;
  await rm(home, { recursive: true, force: true });
});

/** The daemon's two steps at start: the early check of config.json's section, then the settings once the node's database is open. */
async function start(query: unknown, options: { checkpoint?: boolean; now?: number } = {}) {
  const checkpoint = options.checkpoint ?? false;
  const section = await checkDaemonQuerySection({ query, role: 'edge', checkpoint });
  return prepareDaemonReadGraphSettings({ query, section, table, role: 'edge', checkpoint, log, now: () => options.now ?? 1_000 });
}

describe('the daemon\'s read-graph settings at start', () => {
  it('import config.json\'s rules for single context graphs once, and warn at every later start that they are ignored', async () => {
    const query = {
      readGraphs: { layers: { 'shared-working-memory': 'build' }, contextGraphs: { [CURATED]: 'serve' } },
      viewSemantics: { contextGraphs: { [CURATED]: 'merged' } },
    };
    const first = await start(query, { now: Date.UTC(2026, 10, 12, 8) });
    expect(lines).toEqual([
      '[read-graphs] Imported the read-graph settings of 1 context graph(s) from config.json into the node\'s read-graph settings. '
        + `query.readGraphs.contextGraphs and query.viewSemantics.contextGraphs in config.json are deprecated and ignored from now on. ${CHANGE_THEM}`,
    ]);
    expect(readGraphModeOf(first.effective.readGraphs, vm(CURATED))).toBe('serve');
    expect(viewSemanticsOf(first.effective.viewSemantics, CURATED)).toBe('merged');
    expect(first.storeSettings).toEqual({ modes: first.effective.readGraphs, viewSemantics: first.effective.viewSemantics, whenUnsupported: 'refuse' });

    // The operator switches the context graph off through the API; config.json's rule no longer counts.
    table.set(CURATED, { layers: { 'verifiable-memory': 'off' } }, 'api');
    lines = [];
    const second = await start({ ...query, readGraphs: { ...query.readGraphs, contextGraphs: { [CURATED]: 'serve', notes: 'build' } } });
    expect(lines).toEqual([
      '[read-graphs] query.readGraphs.contextGraphs and query.viewSemantics.contextGraphs in config.json are deprecated and ignored: '
        + `the settings were imported into the node's read-graph settings at 2026-11-12T08:00:00.000Z. ${CHANGE_THEM}`,
    ]);
    expect(readGraphModeOf(second.effective.readGraphs, vm(CURATED))).toBe('off');
    expect(readGraphModeOf(second.effective.readGraphs, vm('notes'))).toBe('off');
    expect(readGraphModeOf(second.effective.readGraphs, swm('notes'))).toBe('build');
  });

  it('keep every setting in the node\'s one database', async () => {
    await start({ readGraphs: { contextGraphs: { [CURATED]: 'serve' } } });
    const files = (await readdir(home)).filter((name) => /\.db(-wal|-shm)?$/.test(name));
    expect([...new Set(files.map((name) => name.replace(/-(wal|shm)$/, '')))]).toEqual(['node-ui.db']);
  });

  it('carry the table\'s settings without a query section, and nothing when neither holds any', async () => {
    expect((await start(undefined)).storeSettings).toBeUndefined();
    expect(lines).toEqual([]);
    table.set(CURATED, { layers: { 'verifiable-memory': 'build' } }, 'cli');
    const settings = await start(undefined);
    expect(readGraphModeOf(settings.effective.readGraphs, vm(CURATED))).toBe('build');
    // Only the table keeps read graphs: an adapter that cannot keep them keeps none, and the start goes on.
    expect(settings.storeSettings?.whenUnsupported).toBe('off');
  });

  it('turn the table\'s modes off while the rollback target does not recognize read graphs, and still stop on the node\'s own', async () => {
    table.set(CURATED, { layers: { 'verifiable-memory': 'serve', 'working-memory': 'off' } }, 'api');
    await writeFile(join(home, 'previous-version'), '10.1.1\n');
    const settings = await start({ viewSemantics: 'merged' });
    expect(readGraphModeOf(settings.effective.readGraphs, vm(CURATED))).toBe('off');
    expect(lines).toEqual([
      `[read-graphs] Read graphs set for ${CURATED} (verifiable-memory) are off: the rollback target (${join(home, 'previous-version')}: 10.1.1) `
        + 'is older than 10.1.2, the first release that recognizes read graphs.',
    ]);
    await expect(start({ readGraphs: { layers: { 'verifiable-memory': 'build' } } })).rejects.toBeInstanceOf(QueryConfigError);
    // An unreadable rollback target refuses too, and with nothing the table keeps, nothing is looked up.
    await rm(join(home, 'previous-version'));
    await mkdir(join(home, 'previous-version'));
    lines = [];
    expect(readGraphModeOf((await start({})).effective.readGraphs, vm(CURATED))).toBe('off');
    expect(lines).toEqual([expect.stringMatching(/^\[read-graphs\] Read graphs set for .* are off: the rollback target cannot be read/)]);
    table.set(CURATED, { layers: { 'verifiable-memory': 'off' } }, 'api');
    lines = [];
    expect((await start({})).effective.readGraphs.contextGraphs?.[CURATED]?.layers).toEqual({
      [MemoryLayer.VerifiableMemory]: 'off', [MemoryLayer.WorkingMemory]: 'off',
    });
    expect(lines).toEqual([]);
  });

  it('take no import and give no settings on a node that starts from a public checkpoint, which keeps no read graphs', async () => {
    const settings = await start({ viewSemantics: 'merged', readGraphs: { contextGraphs: { [CURATED]: 'serve' } } }, { checkpoint: true });
    expect(table.list()).toEqual([]);
    expect(table.importedFromConfigAt()).toBeUndefined();
    expect(settings.storeSettings).toBeUndefined();
    expect(readGraphModeOf(settings.effective.readGraphs, vm(CURATED))).toBe('off');
    expect(lines).toEqual(['[read-graphs] query.readGraphs.contextGraphs in config.json is deprecated and ignored.']);
    await expect(start({ readGraphs: 'build' }, { checkpoint: true })).rejects.toBeInstanceOf(QueryConfigError);
  });

  it('go on with the node\'s own settings when the table cannot be read', async () => {
    dashboard.db.exec('DROP TABLE read_graph_modes');
    const settings = await start({ readGraphs: 'build' });
    expect(settings.effective.readGraphs).toEqual({ default: 'build' });
    expect(lines).toEqual([
      expect.stringMatching(/^\[read-graphs\] The read-graph settings cannot be read, so no context graph has settings of its own: .*read_graph_modes/),
    ]);
  });

  it('say so after the store opens when it cannot keep the read graphs that the table sets', async () => {
    table.set(CURATED, { layers: { 'verifiable-memory': 'build' } }, 'api');
    const settings = await start(undefined);
    const backend = { backend: 'oxigraph-worker', options: { path: join(home, `store-${Math.random()}`) }, readGraphs: settings.storeSettings };
    // An adapter that implements a planned write and declares no read-graph capabilities.
    const unsupported = wrapReadGraphLayer({ delete: async () => undefined, close: async () => undefined } as unknown as TripleStore, backend);
    noteReadGraphStoreSupport(settings, unsupported, log);
    expect(lines).toEqual([
      '[read-graphs] The read graphs set in the node\'s read-graph settings are off: the node\'s store does not support read graphs '
        + '(its adapter does not send read-graph operations with delete).',
    ]);
    lines = [];
    const capable = Object.assign(new OxigraphStore(), { readGraphCapabilities: { methods: READ_GRAPH_PLANNED_METHODS, serialUpdates: true } });
    noteReadGraphStoreSupport(settings, wrapReadGraphLayer(capable, { ...backend, options: { path: join(home, `store-${Math.random()}`) } }), log);
    expect(lines).toEqual([]);
  });
});

describe('the read-graph settings of a store opened outside the daemon', () => {
  it('read the settings the daemon wrote, without writing them', async () => {
    table.set(CURATED, { layers: { 'working-memory': 'build' }, viewSemantics: 'merged' }, 'api');
    table.importFromConfig([], 1_000);
    dashboard.close();
    const settings = await readGraphSettingsOutsideDaemon(home, { nodeRole: 'edge' });
    expect(settings?.whenUnsupported).toBe('off');
    expect(readGraphModeOf(settings?.modes, wm(CURATED))).toBe('build');
    expect(viewSemanticsOf(settings?.viewSemantics, CURATED)).toBe('merged');
  });

  it('take config.json\'s rules over the table until the daemon has imported them, as the import will write them', async () => {
    table.set(CURATED, { layers: { 'working-memory': 'build', 'verifiable-memory': 'build' } }, 'api');
    const query = { readGraphs: { contextGraphs: { [CURATED]: { layers: { 'verifiable-memory': 'serve' } }, notes: 'build' } } };
    const before = await readGraphSettingsOutsideDaemon(home, { query });
    expect(readGraphModeOf(before?.modes, vm(CURATED))).toBe('serve');
    expect(readGraphModeOf(before?.modes, wm(CURATED))).toBe('build');
    expect(readGraphModeOf(before?.modes, vm('notes'))).toBe('build');
    // Once imported, the table alone holds them.
    table.importFromConfig([], 2_000);
    const after = await readGraphSettingsOutsideDaemon(home, { query });
    expect(readGraphModeOf(after?.modes, vm(CURATED))).toBe('build');
    expect(readGraphModeOf(after?.modes, vm('notes'))).toBe('off');
  });

  it('take config.json\'s rules in a data directory without a node database, and carry nothing without either', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'dkg-read-graph-settings-empty-'));
    try {
      expect(await readGraphSettingsOutsideDaemon(empty, {})).toBeUndefined();
      const settings = await readGraphSettingsOutsideDaemon(empty, { query: { readGraphs: { contextGraphs: { notes: 'build' } } } });
      expect(readGraphModeOf(settings?.modes, vm('notes'))).toBe('build');
      expect(await readdir(empty)).toEqual([]);
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });
});
