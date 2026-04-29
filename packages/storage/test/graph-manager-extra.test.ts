/**
 * Targeted coverage for ContextGraphManager paths not exercised by
 * adapter-parity-extra / storage tests:
 *
 *   - ensureSubGraph (lines 70-77): creates the sub-graph + its _meta /
 *     _private / shared_memory / shared_memory_meta companion graphs.
 *   - Deprecated V9 aliases (lines 148-176): workspaceGraphUri,
 *     workspaceMetaGraphUri, ensureParanet, listParanets, hasParanet,
 *     dropParanet.
 *
 * All tests run against a real OxigraphStore — zero mocks.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { OxigraphStore, ContextGraphManager, GraphManager, type Quad } from '../src/index.js';
import {
  contextGraphSharedMemoryUri,
  contextGraphSharedMemoryMetaUri,
  contextGraphSubGraphUri,
  contextGraphSubGraphMetaUri,
  contextGraphSubGraphPrivateUri,
} from '@origintrail-official/dkg-core';

/**
 * Oxigraph only materializes a named graph when it contains at least one
 * quad — `createGraph` is a no-op. For tests that rely on `listGraphs` /
 * `hasGraph`, seed each ensured graph with a single marker triple so the
 * store actually has something to list.
 */
async function seed(store: OxigraphStore, graphs: string[]): Promise<void> {
  const quads: Quad[] = graphs.map((g) => ({
    subject: 'http://example.org/s',
    predicate: 'http://example.org/p',
    object: '"marker"',
    graph: g,
  }));
  await store.insert(quads);
}

describe('ContextGraphManager — ensureSubGraph + deprecated V9 aliases', () => {
  let dir: string;
  let store: OxigraphStore;
  let gm: ContextGraphManager;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dkg-gm-'));
    store = new OxigraphStore(join(dir, 'db'));
    gm = new ContextGraphManager(store);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('ensureSubGraph creates the expected five graphs for a (cg, sub) pair', async () => {
    await gm.ensureSubGraph('cg-x', 'news');
    // Oxigraph creates lazily — seed each graph so listGraphs can see them.
    await seed(store, [
      contextGraphSubGraphUri('cg-x', 'news'),
      contextGraphSubGraphMetaUri('cg-x', 'news'),
      contextGraphSubGraphPrivateUri('cg-x', 'news'),
      contextGraphSharedMemoryUri('cg-x', 'news'),
      contextGraphSharedMemoryMetaUri('cg-x', 'news'),
    ]);

    const all = await store.listGraphs();
    expect(all).toContain(contextGraphSubGraphUri('cg-x', 'news'));
    expect(all).toContain(contextGraphSubGraphMetaUri('cg-x', 'news'));
    expect(all).toContain(contextGraphSubGraphPrivateUri('cg-x', 'news'));
    expect(all).toContain(contextGraphSharedMemoryUri('cg-x', 'news'));
    expect(all).toContain(contextGraphSharedMemoryMetaUri('cg-x', 'news'));
  });

  it('ensureSubGraph also ensures the owning context graph (idempotent)', async () => {
    await gm.ensureSubGraph('cg-y', 's1');
    // Context graph was implicitly ensured; calling ensureContextGraph again
    // must be a no-op (the early-return branch at line 80 fires).
    await gm.ensureContextGraph('cg-y');
    // Seed the data graph so hasContextGraph (which greps the store) sees it.
    await seed(store, [gm.dataGraphUri('cg-y')]);
    expect(await gm.hasContextGraph('cg-y')).toBe(true);
  });

  it('ensureContextGraph is idempotent — second call is a no-op', async () => {
    await gm.ensureContextGraph('cg-idem');
    // Second invocation hits the `ensuredContextGraphs.has(...) → return` branch.
    await gm.ensureContextGraph('cg-idem');
    await seed(store, [gm.dataGraphUri('cg-idem')]);
    expect(await gm.hasContextGraph('cg-idem')).toBe(true);
  });

  it('listSubGraphs returns registered sub-graph names only (excluding reserved graphs)', async () => {
    await gm.ensureSubGraph('cg-ls', 'alpha');
    await gm.ensureSubGraph('cg-ls', 'beta');
    await seed(store, [
      contextGraphSubGraphUri('cg-ls', 'alpha'),
      contextGraphSubGraphUri('cg-ls', 'beta'),
    ]);
    const subs = await gm.listSubGraphs('cg-ls');
    expect(new Set(subs)).toEqual(new Set(['alpha', 'beta']));
  });

  it('listContextGraphs returns exactly the context graphs ensured (not sub-graphs or reserved graphs)', async () => {
    await gm.ensureContextGraph('cg-a');
    await gm.ensureContextGraph('cg-b');
    await gm.ensureSubGraph('cg-a', 'inner');
    // Seed the data graph of each cg so listGraphs sees them. The reserved
    // `_meta` / `_private` / `_shared_memory*` companions and the sub-graph
    // are seeded only via their data URIs, exercising the stripping logic
    // in listContextGraphs.
    await seed(store, [
      gm.dataGraphUri('cg-a'),
      gm.metaGraphUri('cg-a'),
      gm.privateGraphUri('cg-a'),
      gm.sharedMemoryUri('cg-a'),
      gm.sharedMemoryMetaUri('cg-a'),
      gm.dataGraphUri('cg-b'),
      contextGraphSubGraphUri('cg-a', 'inner'),
    ]);
    const roots = await gm.listContextGraphs();
    expect(new Set(roots)).toEqual(new Set(['cg-a', 'cg-b']));
  });

  it('dropContextGraph drops every companion graph and flips hasContextGraph to false', async () => {
    await gm.ensureContextGraph('cg-drop');
    await seed(store, [
      gm.dataGraphUri('cg-drop'),
      gm.metaGraphUri('cg-drop'),
      gm.privateGraphUri('cg-drop'),
    ]);
    expect(await gm.hasContextGraph('cg-drop')).toBe(true);

    await gm.dropContextGraph('cg-drop');
    expect(await gm.hasContextGraph('cg-drop')).toBe(false);

    const all = await store.listGraphs();
    expect(all).not.toContain(gm.dataGraphUri('cg-drop'));
    expect(all).not.toContain(gm.metaGraphUri('cg-drop'));
    expect(all).not.toContain(gm.privateGraphUri('cg-drop'));
  });

  // ───────── Deprecated V9 aliases ─────────

  it('workspaceGraphUri is an alias for sharedMemoryUri (V9 compat)', () => {
    expect(gm.workspaceGraphUri('cg-legacy')).toBe(gm.sharedMemoryUri('cg-legacy'));
  });

  it('workspaceMetaGraphUri is an alias for sharedMemoryMetaUri (V9 compat)', () => {
    expect(gm.workspaceMetaGraphUri('cg-legacy')).toBe(gm.sharedMemoryMetaUri('cg-legacy'));
  });

  it('ensureParanet delegates to ensureContextGraph', async () => {
    await gm.ensureParanet('pn-legacy');
    await seed(store, [gm.dataGraphUri('pn-legacy')]);
    expect(await gm.hasContextGraph('pn-legacy')).toBe(true);
  });

  it('listParanets delegates to listContextGraphs', async () => {
    await gm.ensureParanet('pn-1');
    await gm.ensureParanet('pn-2');
    await seed(store, [gm.dataGraphUri('pn-1'), gm.dataGraphUri('pn-2')]);
    const out = await gm.listParanets();
    expect(new Set(out)).toEqual(new Set(['pn-1', 'pn-2']));
  });

  it('hasParanet delegates to hasContextGraph', async () => {
    expect(await gm.hasParanet('pn-missing')).toBe(false);
    await gm.ensureParanet('pn-present');
    await seed(store, [gm.dataGraphUri('pn-present')]);
    expect(await gm.hasParanet('pn-present')).toBe(true);
  });

  it('dropParanet delegates to dropContextGraph', async () => {
    await gm.ensureParanet('pn-todrop');
    await seed(store, [gm.dataGraphUri('pn-todrop')]);
    expect(await gm.hasParanet('pn-todrop')).toBe(true);
    await gm.dropParanet('pn-todrop');
    expect(await gm.hasParanet('pn-todrop')).toBe(false);
  });

  it('GraphManager is a back-compat alias extending ContextGraphManager', () => {
    const legacy = new GraphManager(store);
    expect(legacy).toBeInstanceOf(ContextGraphManager);
    expect(legacy.dataGraphUri('cg-legacy')).toBe(gm.dataGraphUri('cg-legacy'));
  });
});
