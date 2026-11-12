import { describe, expect, it } from 'vitest';
import { OxigraphStore } from '../src/index.js';
import {
  READ_GRAPH_METHOD_MAINTENANCE,
  READ_GRAPH_PLANNED_METHODS,
  missingReadGraphMethods,
  readGraphCapabilitiesOf,
  spliceReadGraphPlan,
  type ReadGraphAdapterCapabilities,
  type ReadGraphWriteOptions,
} from '../src/read-graph/adapter-contract.js';

describe('read-graph adapter contract', () => {
  it('names the write methods that carry a plan', () => {
    expect(READ_GRAPH_PLANNED_METHODS).toEqual([
      'delete', 'deleteByPattern', 'deleteByPatternWithoutCount', 'deleteBySubjectPrefix', 'dropGraph',
      'replaceAssetGroup', 'replaceGraph', 'replaceGraphAndSubject', 'replaceSubject', 'replaceSubjectAndInsert',
      'rfc64AuthorCommitCasV1', 'update',
    ]);
    expect(READ_GRAPH_METHOD_MAINTENANCE.insert).toBe('insert');
    expect(READ_GRAPH_PLANNED_METHODS).not.toContain('insert');
    expect(READ_GRAPH_METHOD_MAINTENANCE.createGraph).toBe('none');
    expect(READ_GRAPH_METHOD_MAINTENANCE.query).toBe('read');
    expect(READ_GRAPH_METHOD_MAINTENANCE.replaceSubject).toBe('reference-subject');
    expect(READ_GRAPH_METHOD_MAINTENANCE.replaceSubjectAndInsert).toBe('reference-subject-and-insert');
  });

  it('lists the planned methods an adapter implements but has not declared', () => {
    const store = new OxigraphStore();
    // A store with the write methods and no declaration of its own.
    const undeclared = Object.fromEntries(
      ['insert', ...READ_GRAPH_PLANNED_METHODS].map((method) => [method, (store as unknown as Record<string, unknown>)[method]]),
    );
    expect(readGraphCapabilitiesOf(undeclared)).toBeUndefined();
    const missing = missingReadGraphMethods(undeclared as never, undefined);
    expect(missing).toContain('delete');
    expect(missing).toContain('replaceGraph');
    expect(missing.every((method) => READ_GRAPH_PLANNED_METHODS.includes(method))).toBe(true);

    const declared: ReadGraphAdapterCapabilities = { methods: READ_GRAPH_PLANNED_METHODS, serialUpdates: true };
    const capable = Object.assign(Object.create(store) as object, { readGraphCapabilities: declared });
    expect(readGraphCapabilitiesOf(capable)).toBe(declared);
    expect(missingReadGraphMethods(capable as never, declared)).toEqual([]);
    expect(missingReadGraphMethods({ delete: async () => {} }, { methods: [], serialUpdates: false })).toEqual(['delete']);
    expect(readGraphCapabilitiesOf(null)).toBeUndefined();
    expect(readGraphCapabilitiesOf({ readGraphCapabilities: 'yes' })).toBeUndefined();
  });

  it('splices a plan around the adapter operations, in order', () => {
    const options: ReadGraphWriteOptions = {
      source: 'test',
      readGraphPlan: { readGraphs: ['urn:r'], before: ['DELETE DATA { GRAPH <urn:r> { <urn:a> <urn:b> <urn:c> } }'], after: ['INSERT DATA { GRAPH <urn:r> { <urn:a> <urn:b> <urn:d> } }'] },
    };
    expect(spliceReadGraphPlan(options.readGraphPlan, ['DROP SILENT GRAPH <urn:g>'])).toBe([
      'DELETE DATA { GRAPH <urn:r> { <urn:a> <urn:b> <urn:c> } }',
      'DROP SILENT GRAPH <urn:g>',
      'INSERT DATA { GRAPH <urn:r> { <urn:a> <urn:b> <urn:d> } }',
    ].join('\n;\n'));
    expect(spliceReadGraphPlan(undefined, ['DROP SILENT GRAPH <urn:g>'])).toBe('DROP SILENT GRAPH <urn:g>');
    expect(spliceReadGraphPlan({ readGraphs: ['urn:r'], before: [], after: [] }, ['PREFIX p: <urn:p#> DELETE DATA { GRAPH <urn:g> { p:a p:b p:c } }']))
      .toBe('PREFIX p: <urn:p#> DELETE DATA { GRAPH <urn:g> { p:a p:b p:c } }');
    expect(() => spliceReadGraphPlan({ readGraphs: [], before: ['CLEAR SILENT GRAPH <urn:r> ;'], after: [] }, []))
      .toThrow(/must not end with/);
    // The adapter's own text passes as it is, and a trailing comment cannot swallow the separator.
    expect(spliceReadGraphPlan(undefined, ['DROP SILENT GRAPH <urn:g> ;'])).toBe('DROP SILENT GRAPH <urn:g> ;');
    expect(spliceReadGraphPlan({ readGraphs: ['urn:r'], before: [], after: ['CLEAR SILENT GRAPH <urn:r>'] }, ['DROP SILENT GRAPH <urn:g> # done']))
      .toBe('DROP SILENT GRAPH <urn:g> # done\n;\nCLEAR SILENT GRAPH <urn:r>');
  });

  it('runs a spliced request as one update on embedded Oxigraph', async () => {
    const store = new OxigraphStore();
    await store.insert([{ subject: 'urn:a', predicate: 'urn:b', object: 'urn:c', graph: 'urn:g' }]);
    await store.update(spliceReadGraphPlan(
      { readGraphs: ['urn:r'], before: ['DELETE { GRAPH <urn:r> { ?s ?p ?o } } WHERE { GRAPH <urn:g> { ?s ?p ?o } }'], after: ['INSERT { GRAPH <urn:r> { ?s ?p ?o } } WHERE { GRAPH <urn:g> { ?s ?p ?o } }'] },
      ['DELETE DATA { GRAPH <urn:g> { <urn:a> <urn:b> <urn:c> } }', 'INSERT DATA { GRAPH <urn:g> { <urn:a> <urn:b> <urn:e> } }'],
    ));
    const result = await store.query('SELECT ?o WHERE { GRAPH <urn:r> { <urn:a> <urn:b> ?o } }');
    expect(result.type === 'bindings' ? result.bindings.map((binding) => binding.o) : []).toEqual(['urn:e']);
  });
});
