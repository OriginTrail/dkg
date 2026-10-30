import { describe, expect, it, vi } from 'vitest';
import { OxigraphStore } from '../src/adapters/oxigraph.js';
import { ChangelogStore, CHANGELOG_GRAPH } from '../src/changelog-store.js';
import { GraphSetIndexStore } from '../src/graph-set-index-store.js';
import { runLogicalStoreMutation, type LogicalStoreMutationCapability, type QueryOptions } from '../src/triple-store.js';
import type { StoreOperation } from '../src/store-operation-outcome.js';

const graph = 'urn:test:logical-capability';
const quad = { graph, subject: 'urn:subject', predicate: 'urn:p', object: '"value"' };

describe('optional logical mutation capability', () => {
  it('keeps embedded and third-party stores working without a lifetime capability', async () => {
    const raw = new OxigraphStore();
    const log = new ChangelogStore(new GraphSetIndexStore(raw));
    try {
      await log.insert([quad]);
      await log.delete([quad]);
      expect(await raw.hasGraph(graph)).toBe(false);
      expect(await raw.hasGraph(CHANGELOG_GRAPH)).toBe(true);
      expect(await log.listGraphs()).not.toContain(CHANGELOG_GRAPH);
      const options = { source: 'third-party' };
      const thirdParty = { query: () => Promise.resolve(42) };
      await expect(runLogicalStoreMutation(thirdParty, 'delete', options, async scoped => {
        expect(scoped).toBe(options); return thirdParty.query();
      })).resolves.toBe(42);
    } finally { await log.close(); }
  });

  it('discovers the backend receiver through decorators while keeping reserved filtering and markers on the outer path', async () => {
    const calls: StoreOperation[] = [];
    const raw = Object.assign(new OxigraphStore(), {
      async runLogicalMutation<T>(this: LogicalStoreMutationCapability, operation: StoreOperation,
        options: QueryOptions | undefined, work: (options: QueryOptions | undefined) => Promise<T>): Promise<T> {
        expect(this).toBe(raw); calls.push(operation);
        return work({ ...options, source: 'logical-owner' });
      },
    });
    const log = new ChangelogStore(new GraphSetIndexStore(raw));
    try {
      await log.insert([quad, { ...quad, graph: CHANGELOG_GRAPH, subject: 'urn:forged-marker' }]);
      await log.deleteByPattern({ graph, subject: quad.subject });
      expect(calls).toContain('insert'); expect(calls).toContain('deleteByPattern');
      expect(await raw.hasGraph(graph)).toBe(false);
      const marker = await raw.query(`ASK { GRAPH <${CHANGELOG_GRAPH}> { ?s <urn:dkg:changelog#graph> <${graph}> } }`);
      expect(marker).toEqual({ type: 'boolean', value: true });
      expect(await raw.query(`ASK { GRAPH <${CHANGELOG_GRAPH}> { <urn:forged-marker> ?p ?o } }`)).toEqual({ type: 'boolean', value: false });
      expect(await log.listGraphs()).not.toContain(CHANGELOG_GRAPH);
    } finally { await log.close(); }
  });

  it('terminates cyclic decorator discovery with the direct-execution fallback', async () => {
    const cycle: { innerStore?: unknown } = {}; cycle.innerStore = cycle;
    await expect(runLogicalStoreMutation(cycle, 'insert', undefined, async () => 'direct')).resolves.toBe('direct');
  });
});


it('keeps grouped publication and graph bookkeeping inside the same scoped lifetime', async () => {
  let active = 0;
  const raw = Object.assign(new OxigraphStore(), {
    async runLogicalMutation<T>(_operation: StoreOperation, options: QueryOptions | undefined,
      work: (options: QueryOptions | undefined) => Promise<T>): Promise<T> {
      if (active > 0 && _operation === 'replaceAssetGroup') expect(options?.source).toBe('logical-owner');
      active++;
      try { return await work({ ...options, source: 'logical-owner' }); }
      finally { active--; }
    },
  });
  const publish = raw.replaceAssetGroup.bind(raw);
  const grouped = vi.spyOn(raw, 'replaceAssetGroup');
  grouped.mockImplementation(async (assets, options) => {
    expect(active).toBeGreaterThan(0); expect(options?.source).toBe('logical-owner');
    return publish.call(raw, assets, options);
  });
  const hasGraph = raw.hasGraph.bind(raw);
  const presence = vi.spyOn(raw, 'hasGraph');
  presence.mockImplementation(async (graph, options) => {
    expect(active).toBeGreaterThan(0); expect(options?.source).toBe('logical-owner');
    return hasGraph.call(raw, graph, options);
  });
  const log = new ChangelogStore(new GraphSetIndexStore(raw));
  const meta = 'urn:group:meta';
  try {
    await log.replaceAssetGroup([{ graphUri: graph, graphQuads: [quad], metaGraphUri: meta,
      metadataSubject: quad.subject, metadataQuads: [{ ...quad, graph: meta }] }], { source: 'caller' });
    expect(grouped).toHaveBeenCalledOnce(); expect(presence).toHaveBeenCalled();
    expect(active).toBe(0);
    expect(await raw.query(`ASK { GRAPH <${graph}> { ?s ?p ?o } }`)).toEqual({ type: 'boolean', value: true });
    expect(await raw.query(`ASK { GRAPH <${CHANGELOG_GRAPH}> { ?s <urn:dkg:changelog#graph> <${graph}> } }`))
      .toEqual({ type: 'boolean', value: true });
  } finally { presence.mockRestore(); grouped.mockRestore(); await log.close(); }
});
