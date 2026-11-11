import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  MemoryLayer,
  READ_GRAPH_SEGMENT,
  readGraphIri,
  readGraphStateGraphIri,
  readScope,
  type ReadGraphKey,
} from '@origintrail-official/dkg-core';
import { BlazegraphStore } from '../../src/adapters/blazegraph.js';
import { OxigraphStore } from '../../src/adapters/oxigraph.js';
import { ADAPTER_SPARQL_TERM_POLICY } from '../../src/adapters/sparql-term-policy.js';
import { BlazegraphNamespaceManager, blazegraphNamespaceApiUrlFromSparqlEndpoint } from '../../src/blazegraph-namespace-manager.js';
import type { Quad, TripleStore } from '../../src/triple-store.js';
import { spliceReadGraphPlan } from '../../src/read-graph/adapter-contract.js';
import {
  isReadGraphMember,
  matchesGraphNameTest,
  readGraphMembership,
  workingMemoryIdentityRule,
  type ReadGraphRegistrySnapshot,
} from '../../src/read-graph/membership.js';
import {
  CURRENT_READ_GRAPH_VERSIONS,
  READ_GRAPH_STATE_PREDICATES,
  nextReadGraphState,
  parseReadGraphStateRows,
  readGraphStateCompareAndSet,
  readGraphStateMarkAllDirty,
  readGraphStateMarkDirty,
  readGraphStateRowsQuery,
  type ReadGraphStateRow,
} from '../../src/read-graph/state.js';
import {
  readGraphBackfillBatch,
  readGraphCopy,
  readGraphDeltaDelete,
  readGraphDeltaDeleteBySubjectPrefix,
  readGraphDeltaDeleteMatching,
  readGraphFencedDrop,
  readGraphFirstHolderCountQuery,
  readGraphInsertQuads,
  readGraphMissingTripleAsk,
  readGraphRepairLeave,
  readGraphReferenceProcedure,
  readGraphRetraction,
  readGraphSizeQuery,
  readGraphUnheldSubjectAsk,
  renderGraphNameTest,
  type ReadGraphTarget,
} from '../../src/read-graph/statements.js';
import { propertyOptions } from '../../../../scripts/testing/property-options.js';

const AGENT = '0x' + 'ab'.repeat(20);
const AGENT_MIXED = '0x' + 'aB'.repeat(20);
const PEER = '12D3KooWQYhTNQdmr3ArTeUHRYzFg94BKyTkoWBDWez9kSCVe2Xo';
/** The partition segment without its `~`: an ordinary segment, which older context graph IDs may hold. */
const LOOK_ALIKE = READ_GRAPH_SEGMENT.replace('~', '');
const identity = workingMemoryIdentityRule({ defaultAgentAddress: AGENT, peerId: PEER });
const render = ADAPTER_SPARQL_TERM_POLICY.renderer({ adapter: 'oxigraph', operation: 'delete' }, () => {});

/** The reference procedure, delta forms, fences and checks, run on one engine through its adapter. */
export function readGraphStatementsConformance(backend: 'oxigraph' | 'blazegraph') {
  describe(`read-graph statements (${backend})`, () => {
    let store: TripleStore;
    let manager: BlazegraphNamespaceManager | undefined;
    let handles: Awaited<ReturnType<BlazegraphNamespaceManager['acquireMany']>> | undefined;
    const run = `rg${randomUUID().slice(0, 8)}`;
    let sequence = 0;
    const freshContextGraph = () => `${run}/c${sequence += 1}`;

    beforeAll(async () => {
      if (backend === 'blazegraph') {
        if (!process.env.BLAZEGRAPH_TEST_URL) throw new Error('The live Blazegraph lane requires BLAZEGRAPH_TEST_URL');
        manager = new BlazegraphNamespaceManager({
          namespaceApiUrl: blazegraphNamespaceApiUrlFromSparqlEndpoint(process.env.BLAZEGRAPH_TEST_URL),
        });
        handles = await manager.acquireMany([`read-graph-${randomUUID()}`]);
        store = new BlazegraphStore(handles[0]!.sparqlUrl, { timeout: 60_000 });
      } else {
        store = new OxigraphStore();
      }
    }, 60_000);
    afterAll(async () => {
      await store?.close();
      if (handles) await manager!.disposeAll(handles);
    });

    const update = (sparql: string) => store.update!(sparql);
    async function select(sparql: string): Promise<Array<Record<string, string>>> {
      const result = await store.query(sparql);
      if (result.type !== 'bindings') throw new Error('expected bindings');
      return result.bindings;
    }
    async function ask(sparql: string): Promise<boolean> {
      const result = await store.query(sparql);
      if (result.type === 'boolean') return result.value;
      if (result.type === 'bindings') return result.bindings[0]?.result === 'true';
      throw new Error('expected a boolean');
    }
    const count = async (sparql: string) => Number(/^"?(\d+)/.exec((await select(sparql))[0]!.n!)![1]);
    async function triples(graph: string): Promise<string[]> {
      return (await select(`SELECT ?s ?p ?o WHERE { GRAPH <${graph}> { ?s ?p ?o } }`))
        .map((row) => `${row.s} ${row.p} ${row.o}`).sort();
    }
    async function memberUnion(contextGraphId: string, key: ReadGraphKey, snapshot: ReadGraphRegistrySnapshot): Promise<string[]> {
      // Every graph of this context graph and of the one whose ID extends it with `y`, which hold the non-members.
      const rows = await select(`SELECT ?g ?s ?p ?o WHERE { GRAPH ?g { ?s ?p ?o } FILTER(STRSTARTS(STR(?g), "did:dkg:context-graph:${contextGraphId}")) }`);
      return [...new Set(rows.filter((row) => isReadGraphMember(row.g!, key, snapshot, identity))
        .map((row) => `${row.s} ${row.p} ${row.o}`))].sort();
    }
    async function setState(row: ReadGraphStateRow, previous?: ReadGraphStateRow) {
      await update(readGraphStateCompareAndSet(previous, row));
      return row;
    }

    it('keeps the probes\' maintenance sequences right', async () => {
      const cg = freshContextGraph();
      const root = `did:dkg:context-graph:${cg}`;
      const g = (n: number) => `${root}/_verifiable_memory/${AGENT}/${n}`;
      const snapshot: ReadGraphRegistrySnapshot = { contextGraphId: cg, subGraphNames: [], childContextGraphRoots: [] };
      const key: ReadGraphKey = { scope: readScope(cg), layer: MemoryLayer.VerifiableMemory };
      const R = readGraphIri(key);
      const target: ReadGraphTarget = { readGraph: R, membership: readGraphMembership(key, snapshot, identity) };
      const t = (o: string) => `urn:s urn:p urn:${o}`;
      await update(`INSERT DATA {
        GRAPH <${g(1)}> { <urn:s> <urn:p> <urn:shared> . <urn:s> <urn:p> <urn:only1> . <urn:s> <urn:p> <urn:kept1> }
        GRAPH <${g(2)}> { <urn:s> <urn:p> <urn:shared> . <urn:s> <urn:p> <urn:only2> }
      }`);
      const building = await setState({ readGraph: R, state: 'building', generation: 41, ruleVersion: 1, builderVersion: 1 });
      await update(readGraphBackfillBatch(R, building, [g(1), g(2)]));
      expect(await triples(R)).toEqual([t('kept1'), t('only1'), t('only2'), t('shared')]);
      await setState(nextReadGraphState(building, { kind: 'publish-ready' })!, building);

      // Replace g1: retract with the existence check, replace, copy. Separate operations, one request.
      const replace = readGraphReferenceProcedure(target, [g(1)], [g(1)]);
      await update(spliceReadGraphPlan({ readGraphs: [R], ...replace }, [
        `DROP SILENT GRAPH <${g(1)}>`,
        `INSERT DATA { GRAPH <${g(1)}> { <urn:s> <urn:p> <urn:shared> . <urn:s> <urn:p> <urn:kept1> . <urn:s> <urn:p> <urn:new1> } }`,
      ]));
      expect(await triples(R)).toEqual([t('kept1'), t('new1'), t('only2'), t('shared')]);

      // Drop g2 while g1 still holds the shared triple.
      await update(spliceReadGraphPlan({ readGraphs: [R], ...readGraphReferenceProcedure(target, [g(2)], []) }, [`DROP SILENT GRAPH <${g(2)}>`]));
      expect(await triples(R)).toEqual([t('kept1'), t('new1'), t('shared')]);

      // Two graphs hold the last two copies and leave in one request: the check ignores the whole touched set.
      await update(`INSERT DATA { GRAPH <${g(3)}> { <urn:s> <urn:p> <urn:shared> } } ;\n${readGraphCopy(R, g(3))}`);
      await update(spliceReadGraphPlan({ readGraphs: [R], ...readGraphReferenceProcedure(target, [g(1), g(3)], []) },
        [`DROP SILENT GRAPH <${g(1)}>`, `DROP SILENT GRAPH <${g(3)}>`]));
      expect(await triples(R)).toEqual([]);
    });

    it('renders membership with the same answer as the module, for every kind of name', async () => {
      const cg = freshContextGraph();
      const root = `did:dkg:context-graph:${cg}`;
      const snapshot: ReadGraphRegistrySnapshot = {
        contextGraphId: cg, subGraphNames: ['code', 'staging'], childContextGraphRoots: [`${root}/kid`],
      };
      const segments = ['_verifiable_memory', '_shared_memory', '_working_memory', 'assertion', 'context', 'staging',
        '_meta', '_private', READ_GRAPH_SEGMENT, LOOK_ALIKE, '_shared_memory_meta', '_metadata', AGENT, AGENT_MIXED, PEER,
        PEER.toLowerCase(), '0X' + 'AB'.repeat(20), '7', 'code', 'kid', 'docs'];
      const tails = fc.sample(fc.array(fc.constantFrom(...segments), { minLength: 1, maxLength: 4 }), { seed: propertyOptions().seed, numRuns: 400 });
      const graphs = [...new Set([root, `did:dkg:context-graph:${cg}x/_verifiable_memory/${AGENT}/1`, ...tails.map((tail) => [root, ...tail].join('/'))])];
      for (let start = 0; start < graphs.length; start += 200) {
        await update(`INSERT DATA { ${graphs.slice(start, start + 200).map((graph) => `GRAPH <${graph}> { <urn:m> <urn:m> <urn:m> }`).join('\n')} }`);
      }
      const keys: ReadGraphKey[] = [];
      for (const scope of [readScope(cg), readScope(cg, 'code'), readScope(cg, 'docs')]) {
        keys.push({ scope, layer: MemoryLayer.VerifiableMemory }, { scope, layer: MemoryLayer.SharedWorkingMemory },
          { scope, layer: MemoryLayer.WorkingMemory, agentAddress: AGENT }, { scope, layer: MemoryLayer.WorkingMemory, agentAddress: PEER });
      }
      for (const key of keys) {
        const membership = readGraphMembership(key, snapshot, identity);
        const selected = (await select(`SELECT ?g WHERE { GRAPH ?g { <urn:m> <urn:m> <urn:m> } FILTER(${renderGraphNameTest(membership, '?g')}) }`))
          .map((row) => row.g!).sort();
        expect(selected, readGraphIri(key)).toEqual(graphs.filter((graph) => matchesGraphNameTest(membership, graph)).sort());
      }
    }, 120_000);

    it('keeps every read graph equal to the union of its members across random writes', async () => {
      const subjects = ['urn:s:1', 'urn:s:2', 'urn:t:1'];
      const terms = { subject: fc.constantFrom(...subjects), predicate: fc.constantFrom('urn:p:1', 'urn:p:2'),
        object: fc.constantFrom('urn:o:1', 'urn:o:2', '"v"', '"w"@en') };
      const graphIndex = fc.nat({ max: 10 });
      const triple = fc.record(terms);
      const operation = fc.oneof(
        fc.record({ kind: fc.constant('insert' as const), graph: graphIndex, triples: fc.array(triple, { minLength: 1, maxLength: 4 }) }),
        fc.record({ kind: fc.constant('delete' as const), graph: graphIndex, triples: fc.array(triple, { minLength: 1, maxLength: 3 }) }),
        fc.record({ kind: fc.constant('delete-matching' as const), graph: graphIndex, subject: fc.option(terms.subject, { nil: undefined }), object: fc.option(terms.object, { nil: undefined }) }),
        fc.record({ kind: fc.constant('delete-prefix' as const), graph: graphIndex, prefix: fc.constantFrom('urn:s:', 'urn:t', 'urn:') }),
        fc.record({ kind: fc.constant('replace' as const), graph: graphIndex, triples: fc.array(triple, { maxLength: 4 }) }),
        fc.record({ kind: fc.constant('drop' as const), graph: graphIndex }),
        fc.record({ kind: fc.constant('replace-subject' as const), graph: graphIndex, subject: terms.subject, triples: fc.array(fc.record({ predicate: terms.predicate, object: terms.object }), { maxLength: 3 }),
          companions: fc.array(triple, { maxLength: 2 }) }),
        fc.record({ kind: fc.constant('replace-group' as const), graph: graphIndex, other: graphIndex, triples: fc.array(triple, { maxLength: 3 }) }),
      );
      const runs = backend === 'blazegraph' ? 20 : propertyOptions().numRuns;
      await fc.assert(fc.asyncProperty(fc.array(operation, { minLength: 1, maxLength: 8 }), async (operations) => {
        const cg = freshContextGraph();
        const root = `did:dkg:context-graph:${cg}`;
        const snapshot: ReadGraphRegistrySnapshot = { contextGraphId: cg, subGraphNames: ['code'], childContextGraphRoots: [`${root}/kid`] };
        const graphs = [
          root, `${root}/_verifiable_memory/${AGENT}/1`, `${root}/_verifiable_memory/${AGENT}/2`, `${root}/context/7`,
          `${root}/code`, `${root}/code/_verifiable_memory/${AGENT}/3`, `${root}/_meta`, `${root}/kid/_verifiable_memory/${AGENT}/4`,
          `${root}/docs/_verifiable_memory/${AGENT}/5`, `did:dkg:context-graph:${cg}y/_verifiable_memory/${AGENT}/6`,
          `${root}/_shared_memory/${AGENT}/7`,
        ];
        const keys: ReadGraphKey[] = [
          { scope: readScope(cg), layer: MemoryLayer.VerifiableMemory },
          { scope: readScope(cg, 'code'), layer: MemoryLayer.VerifiableMemory },
          { scope: readScope(cg), layer: MemoryLayer.SharedWorkingMemory },
        ];
        const targets = keys.map((key) => ({ key, readGraph: readGraphIri(key), membership: readGraphMembership(key, snapshot, identity) }));
        const isMember = (graph: string, target: (typeof targets)[number]) => matchesGraphNameTest(target.membership, graph);
        const quad = (graph: string, t: { subject: string; predicate: string; object: string }): Quad => ({ ...t, graph });
        const nquad = (q: Quad) => `${render.rdf(q.subject, 'subject', 'allow')} ${render.iri(q.predicate, 'predicate')} ${render.rdf(q.object, 'object', 'allow')}`;
        const insertData = (quads: readonly Quad[]) => quads.length === 0 ? [] : [`INSERT DATA { ${quads.map((q) => `GRAPH <${q.graph}> { ${nquad(q)} }`).join(' ')} }`];
        const reference = (touched: string[], ops: string[]) => {
          const before: string[] = [], after: string[] = [];
          for (const target of targets) {
            const members = touched.filter((graph) => isMember(graph, target));
            if (members.length === 0) continue;
            const procedure = readGraphReferenceProcedure(target, members, members);
            before.push(...procedure.before); after.push(...procedure.after);
          }
          return spliceReadGraphPlan({ readGraphs: targets.map((target) => target.readGraph), before, after }, ops);
        };

        for (const op of operations) {
          const graph = graphs[op.graph]!;
          switch (op.kind) {
            case 'insert': {
              const quads = op.triples.map((t) => quad(graph, t));
              const extra = targets.flatMap((target) => isMember(graph, target) ? readGraphInsertQuads(target.readGraph, quads) : []);
              await store.insert([...quads, ...extra]);
              break;
            }
            case 'delete': {
              const quads = op.triples.map((t) => quad(graph, t));
              const after = targets.flatMap((target) => {
                if (!isMember(graph, target)) return [];
                const statement = readGraphDeltaDelete(target, quads, render);
                return statement ? [statement] : [];
              });
              await update(spliceReadGraphPlan({ readGraphs: [], before: [], after }, [`DELETE DATA { ${quads.map((q) => `GRAPH <${q.graph}> { ${nquad(q)} }`).join(' ')} }`]));
              break;
            }
            case 'delete-matching': {
              const pattern = { subject: op.subject, object: op.object };
              const triplePattern = `${op.subject ? `<${op.subject}>` : '?s'} ?p ${op.object ? render.rdf(op.object, 'object', 'reject') : '?o'}`;
              const before = targets.flatMap((target) => isMember(graph, target) ? [readGraphDeltaDeleteMatching(target, graph, pattern, render)] : []);
              await update(spliceReadGraphPlan({ readGraphs: [], before, after: [] }, [`DELETE { GRAPH <${graph}> { ${triplePattern} } } WHERE { GRAPH <${graph}> { ${triplePattern} } }`]));
              break;
            }
            case 'delete-prefix': {
              const before = targets.flatMap((target) => isMember(graph, target) ? [readGraphDeltaDeleteBySubjectPrefix(target, graph, op.prefix, render)] : []);
              await update(spliceReadGraphPlan({ readGraphs: [], before, after: [] }, [
                `DELETE { GRAPH <${graph}> { ?s ?p ?o } } WHERE { GRAPH <${graph}> { ?s ?p ?o . FILTER(STRSTARTS(STR(?s), ${render.prefix(op.prefix)})) } }`,
              ]));
              break;
            }
            case 'replace':
              await update(reference([graph], [`DROP SILENT GRAPH <${graph}>`, ...insertData(op.triples.map((t) => quad(graph, t)))]));
              break;
            case 'drop':
              await update(reference([graph], [`DROP SILENT GRAPH <${graph}>`]));
              break;
            case 'replace-subject': {
              // replaceSubjectAndInsert: the companion rows of other subjects are added, never replaced.
              const companions = op.companions.filter((t) => t.subject !== op.subject);
              const companionSubjects = [...new Set(companions.map((t) => t.subject))];
              const before: string[] = [], after: string[] = [];
              for (const target of targets) {
                if (!isMember(graph, target)) continue;
                before.push(readGraphRetraction(target, graph, [graph], { subject: op.subject }));
                after.push(readGraphCopy(target.readGraph, graph, { subject: op.subject }),
                  ...companionSubjects.map((subject) => readGraphCopy(target.readGraph, graph, { subject })));
              }
              await update(spliceReadGraphPlan({ readGraphs: [], before, after }, [
                `DELETE { GRAPH <${graph}> { <${op.subject}> ?p ?o } } WHERE { GRAPH <${graph}> { <${op.subject}> ?p ?o } }`,
                ...insertData([...op.triples.map((t) => quad(graph, { subject: op.subject, ...t })), ...companions.map((t) => quad(graph, t))]),
              ]));
              break;
            }
            case 'replace-group': {
              const other = graphs[op.other]!;
              const touched = [...new Set([graph, other])];
              await update(reference(touched, [
                ...touched.map((g) => `DROP SILENT GRAPH <${g}>`),
                ...insertData(op.triples.map((t) => quad(graph, t))),
              ]));
              break;
            }
          }
          for (const target of targets) {
            expect(await triples(target.readGraph), `${target.readGraph} after ${JSON.stringify(op)}`)
              .toEqual(await memberUnion(cg, target.key, snapshot));
          }
        }
      }), { ...propertyOptions(), numRuns: runs });
    }, 300_000);

    it('names the terms the adapter itself deletes: escaped, typed, tagged and non-ASCII literals', async () => {
      const cg = freshContextGraph();
      const root = `did:dkg:context-graph:${cg}`;
      const g1 = `${root}/_verifiable_memory/${AGENT}/1`, g2 = `${root}/_verifiable_memory/${AGENT}/2`;
      const key: ReadGraphKey = { scope: readScope(cg), layer: MemoryLayer.VerifiableMemory };
      const snapshot: ReadGraphRegistrySnapshot = { contextGraphId: cg, subGraphNames: [], childContextGraphRoots: [] };
      const R = readGraphIri(key);
      const target: ReadGraphTarget = { readGraph: R, membership: readGraphMembership(key, snapshot, identity) };
      // The renderer of the adapter under test, as the layer would pass it.
      const adapterRender = ADAPTER_SPARQL_TERM_POLICY.renderer({ adapter: backend, operation: 'delete' }, () => {});
      const objects = [
        '"say \\"hi\\" \\\\ back\\nline\\ttab"',
        '"42"^^<http://www.w3.org/2001/XMLSchema#integer>',
        '"2026-11-10"^^<http://www.w3.org/2001/XMLSchema#date>',
        '"x"@en-GB',
        '"é ü 中 😀"',
        'urn:o:plain',
      ];
      const quadsOf = (graph: string): Quad[] => objects.map((object, i) => ({ subject: `urn:s:${i % 2}`, predicate: `urn:p:${i}`, object, graph }));
      // The second member also holds the first two triples, so the read graph keeps them.
      const seed = async () => {
        await store.insert([...quadsOf(g1), ...quadsOf(g2).slice(0, 2)]);
        await update(`${readGraphCopy(R, g1)} ;\n${readGraphCopy(R, g2)}`);
        expect(await triples(R)).toEqual(await memberUnion(cg, key, snapshot));
        expect(await triples(R)).toHaveLength(objects.length);
      };

      // The exact delete's delta runs after the delete; the pattern delete's runs before it.
      await seed();
      await store.delete(quadsOf(g1));
      await update(readGraphDeltaDelete(target, quadsOf(g1), adapterRender)!);
      expect(await triples(g1)).toEqual([]);
      expect(await triples(R)).toEqual(await memberUnion(cg, key, snapshot));
      expect(await triples(R)).toHaveLength(2);

      await seed();
      for (const object of objects) {
        await update(readGraphDeltaDeleteMatching(target, g1, { object }, adapterRender));
        await store.deleteByPattern({ graph: g1, object });
      }
      expect(await triples(g1)).toEqual([]);
      expect(await triples(R)).toEqual(await memberUnion(cg, key, snapshot));
      expect(await triples(R)).toHaveLength(2);
    });

    it('keeps a triple while a member holds it and removes it with the last one, for each delete delta', async () => {
      const cg = freshContextGraph();
      const root = `did:dkg:context-graph:${cg}`;
      const first = `${root}/_verifiable_memory/${AGENT}/1`, last = `${root}/_verifiable_memory/${AGENT}/2`;
      // A graph of the context graph whose ID extends this one: its name starts with the root, but it is no member.
      const outside = `${root}y/_verifiable_memory/${AGENT}/1`;
      const key: ReadGraphKey = { scope: readScope(cg), layer: MemoryLayer.VerifiableMemory };
      const R = readGraphIri(key);
      const target: ReadGraphTarget = {
        readGraph: R, membership: readGraphMembership(key, { contextGraphId: cg, subGraphNames: [], childContextGraphRoots: [] }, identity),
      };
      expect(matchesGraphNameTest(target.membership, outside)).toBe(false);
      const adapterRender = ADAPTER_SPARQL_TERM_POLICY.renderer({ adapter: backend, operation: 'delete' }, () => {});
      const triple = { subject: 'urn:shared:s', predicate: 'urn:shared:p', object: '"shared"' };
      // The exact delete's delta runs after the delete; the pattern and prefix deltas run before it.
      const forms: Record<string, (graph: string) => Promise<unknown>> = {
        exact: async (graph) => {
          await store.delete([{ ...triple, graph }]);
          await update(readGraphDeltaDelete(target, [{ ...triple, graph }], adapterRender)!);
        },
        pattern: async (graph) => {
          await update(readGraphDeltaDeleteMatching(target, graph, { subject: triple.subject }, adapterRender));
          await store.deleteByPattern({ graph, subject: triple.subject });
        },
        prefix: async (graph) => {
          await update(readGraphDeltaDeleteBySubjectPrefix(target, graph, 'urn:shared:', adapterRender));
          await store.deleteBySubjectPrefix(graph, 'urn:shared:');
        },
      };
      for (const [form, remove] of Object.entries(forms)) {
        await store.insert([first, last, outside].map((graph) => ({ ...triple, graph })));
        await update(`${readGraphCopy(R, first)} ;\n${readGraphCopy(R, last)}`);
        expect(await triples(R), form).toHaveLength(1);
        await remove(first);
        expect(await triples(R), `${form}: another member still holds it`).toHaveLength(1);
        await remove(last);
        expect(await triples(R), `${form}: only a graph outside the scope holds it`).toEqual([]);
        expect(await triples(outside), form).toHaveLength(1);
        await store.delete([{ ...triple, graph: outside }]);
      }
    });

    it('lets fenced batches, repairs and drops act only for their own state and generation', async () => {
      const cg = freshContextGraph();
      const root = `did:dkg:context-graph:${cg}`;
      const g1 = `${root}/_verifiable_memory/${AGENT}/1`, g2 = `${root}/code/_verifiable_memory/${AGENT}/2`;
      const key: ReadGraphKey = { scope: readScope(cg), layer: MemoryLayer.VerifiableMemory };
      const R = readGraphIri(key);
      await update(`INSERT DATA { GRAPH <${g1}> { <urn:a> <urn:b> <urn:c> } GRAPH <${g2}> { <urn:a> <urn:b> <urn:d> } }`);
      const building = await setState({ readGraph: R, state: 'building', generation: 5, ...versions() });
      await update(readGraphBackfillBatch(R, { state: 'building', generation: 4 }, [g1, g2]));
      await update(readGraphBackfillBatch(R, { state: 'rebuilding', generation: 5 }, [g1, g2]));
      expect(await triples(R)).toEqual([]);
      await update(readGraphBackfillBatch(R, building, [g1]));
      expect(await triples(R)).toEqual(['urn:a urn:b urn:c']);

      // The sub-graph `code` joins: copy its graph; a stale copy from the earlier generation does nothing.
      const dirty = await setState(nextReadGraphState(building, { kind: 'mark-dirty' })!, building);
      const repairing = await setState(nextReadGraphState(dirty, { kind: 'start-repair', versions: CURRENT_READ_GRAPH_VERSIONS })!, dirty);
      await update(readGraphBackfillBatch(R, building, [g2]));
      expect(await triples(R)).toEqual(['urn:a urn:b urn:c']);
      await update(readGraphBackfillBatch(R, repairing, [g2]));
      expect(await triples(R)).toEqual(['urn:a urn:b urn:c', 'urn:a urn:b urn:d']);

      // The sub-graph leaves while intact: retract it against the membership without it.
      const without: ReadGraphTarget = { readGraph: R, membership: readGraphMembership(key, { contextGraphId: cg, subGraphNames: [], childContextGraphRoots: [] }, identity) };
      await update(readGraphRepairLeave(without, dirty, [g2]).join(' ;\n'));
      expect(await triples(R)).toHaveLength(2);
      await update(readGraphRepairLeave(without, repairing, [g2]).join(' ;\n'));
      expect(await triples(R)).toEqual(['urn:a urn:b urn:c']);

      await update(readGraphFencedDrop(R, building));
      expect(await triples(R)).toHaveLength(1);
      await update(readGraphFencedDrop(R, repairing));
      expect(await triples(R)).toEqual([]);

      // A drop in batches removes at most its limit each time, and only for its own state and generation.
      await update(`INSERT DATA { GRAPH <${R}> { <urn:x> <urn:y> <urn:z1> . <urn:x> <urn:y> <urn:z2> . <urn:x> <urn:y> <urn:z3> } }`);
      await update(readGraphFencedDrop(R, building, { limit: 2 }));
      expect(await triples(R)).toHaveLength(3);
      await update(readGraphFencedDrop(R, repairing, { limit: 2 }));
      expect(await triples(R)).toHaveLength(1);
      await update(readGraphFencedDrop(R, repairing, { limit: 2 }));
      expect(await count(readGraphSizeQuery(R))).toBe(0);
    });

    it('leaves the read graph unchanged for a guarded change that does not apply, and for an exact replay', async () => {
      const cg = freshContextGraph();
      const root = `did:dkg:context-graph:${cg}`;
      const g1 = `${root}/_verifiable_memory/${AGENT}/1`, g2 = `${root}/_verifiable_memory/${AGENT}/2`;
      const key: ReadGraphKey = { scope: readScope(cg), layer: MemoryLayer.VerifiableMemory };
      const R = readGraphIri(key);
      const target: ReadGraphTarget = { readGraph: R, membership: readGraphMembership(key, { contextGraphId: cg, subGraphNames: [], childContextGraphRoots: [] }, identity) };
      await update(`INSERT DATA { GRAPH <${g1}> { <urn:a> <urn:b> <urn:shared> . <urn:a> <urn:b> <urn:one> } GRAPH <${g2}> { <urn:a> <urn:b> <urn:shared> } } ;\n`
        + `${readGraphCopy(R, g1)} ;\n${readGraphCopy(R, g2)}`);
      const before = await triples(R);
      // A compare-and-set that loses: its guard finds no match, so the data change does nothing.
      const guard = 'GRAPH <urn:guard> { <urn:head> <urn:is> "expected" }';
      const request = spliceReadGraphPlan({ readGraphs: [R], ...readGraphReferenceProcedure(target, [g1, g2], [g1, g2]) }, [
        `DELETE { GRAPH <${g1}> { ?s ?p ?o } } WHERE { ${guard} GRAPH <${g1}> { ?s ?p ?o } }`,
        `INSERT { GRAPH <${g1}> { <urn:a> <urn:b> <urn:new> } } WHERE { ${guard} }`,
      ]);
      await update(request);
      expect(await triples(R)).toEqual(before);
      await update(`INSERT DATA { GRAPH <urn:guard> { <urn:head> <urn:is> "expected" } }`);
      await update(request);
      const after = ['urn:a urn:b urn:new', 'urn:a urn:b urn:shared'];
      expect(await triples(R)).toEqual(after);
      // The same request again: its guard still matches, and the read graph comes out the same.
      await update(request);
      expect(await triples(R)).toEqual(after);
      await update(`DROP SILENT GRAPH <urn:guard>`);
    });

    it('needs a full rebuild after a change it did not maintain, and converges with writes during a backfill', async () => {
      const cg = freshContextGraph();
      const root = `did:dkg:context-graph:${cg}`;
      const g = (n: number) => `${root}/_verifiable_memory/${AGENT}/${n}`;
      const key: ReadGraphKey = { scope: readScope(cg), layer: MemoryLayer.VerifiableMemory };
      const snapshot: ReadGraphRegistrySnapshot = { contextGraphId: cg, subGraphNames: [], childContextGraphRoots: [] };
      const R = readGraphIri(key);
      const target: ReadGraphTarget = { readGraph: R, membership: readGraphMembership(key, snapshot, identity) };
      await update(`INSERT DATA { ${[1, 2, 3, 4].map((n) => `GRAPH <${g(n)}> { <urn:s:${n}> <urn:p> <urn:o:${n}> . <urn:shared> <urn:p> <urn:o> }`).join(' ')} }`);
      let row = await setState({ readGraph: R, state: 'building', generation: 9, ...versions() });
      await update(readGraphBackfillBatch(R, row, [g(1), g(2)]));
      // Writes during the backfill keep their own maintenance: one in a copied graph, one in a graph not copied yet.
      await update(spliceReadGraphPlan({ readGraphs: [R], ...readGraphReferenceProcedure(target, [g(1)], []) }, [`DROP SILENT GRAPH <${g(1)}>`]));
      await update(spliceReadGraphPlan({ readGraphs: [R], ...readGraphReferenceProcedure(target, [g(3)], [g(3)]) },
        [`DROP SILENT GRAPH <${g(3)}>`, `INSERT DATA { GRAPH <${g(3)}> { <urn:s:3> <urn:p> <urn:o:new> } }`]));
      await update(readGraphBackfillBatch(R, row, [g(3), g(4)]));
      expect(await triples(R)).toEqual(await memberUnion(cg, key, snapshot));
      row = await setState(nextReadGraphState(row, { kind: 'publish-ready' })!, row);

      // A drop that bypassed maintenance: what g(2) held can no longer be found from its name.
      await update(`DROP SILENT GRAPH <${g(2)}>`);
      expect(await triples(R)).toContain('urn:s:2 urn:p urn:o:2');
      await update(readGraphRepairLeave(target, row, [g(2)]).join(' ;\n'));
      expect(await triples(R)).toContain('urn:s:2 urn:p urn:o:2');
      // A full rebuild clears it: a fenced drop, then a fenced backfill of every member.
      const dirty = await setState(nextReadGraphState(row, { kind: 'mark-dirty' })!, row);
      const rebuilding = await setState(nextReadGraphState(dirty, { kind: 'start-rebuild', versions: CURRENT_READ_GRAPH_VERSIONS })!, dirty);
      await update([readGraphFencedDrop(R, rebuilding), readGraphBackfillBatch(R, rebuilding, [1, 2, 3, 4].map(g))].join(' ;\n'));
      await setState(nextReadGraphState(rebuilding, { kind: 'publish-ready' })!, rebuilding);
      expect(await triples(R)).toEqual(await memberUnion(cg, key, snapshot));
      expect(await triples(R)).not.toContain('urn:s:2 urn:p urn:o:2');
    });

    it('runs the state statements: compare-and-set, the start-up lookup and marking every read graph dirty', async () => {
      const cg = freshContextGraph();
      const vm = readGraphIri({ scope: readScope(cg), layer: MemoryLayer.VerifiableMemory });
      const swm = readGraphIri({ scope: readScope(cg), layer: MemoryLayer.SharedWorkingMemory });
      const ready = await setState({ readGraph: vm, state: 'building', generation: 3, ...versions() })
        .then((building) => setState(nextReadGraphState(building, { kind: 'publish-ready' })!, building));
      await setState({ readGraph: swm, state: 'dirty', generation: 12, ...versions() });
      // A damaged row with a second state must not keep its ready mark either.
      const wm = readGraphIri({ scope: readScope(cg), layer: MemoryLayer.WorkingMemory, agentAddress: AGENT });
      await setState({ readGraph: wm, state: 'ready', generation: 40, ...versions() });
      await update(`INSERT DATA { GRAPH <${readGraphStateGraphIri(cg)}> { <${wm}> <http://dkg.io/ontology/readGraphState> "building" } }`);
      // A stale compare-and-set changes nothing.
      await update(readGraphStateCompareAndSet({ ...ready, state: 'building' }, { ...ready, state: 'dirty', generation: 4 }));
      const mine = (rows: ReadGraphStateRow[]) => rows.filter((row) => row.readGraph === vm || row.readGraph === swm)
        .sort((a, b) => a.readGraph.localeCompare(b.readGraph));
      const lookup = async () => parseReadGraphStateRows(await select(readGraphStateRowsQuery()));
      expect(mine((await lookup()).rows)).toEqual(mine([ready, { readGraph: swm, state: 'dirty', generation: 12, ...versions() }]));
      // A row that has lost its state is found as damaged, and a create adds nothing beside it.
      const orphan = readGraphIri({ scope: readScope(cg, 'code'), layer: MemoryLayer.VerifiableMemory });
      await update(`INSERT DATA { GRAPH <${readGraphStateGraphIri(cg)}> { <${orphan}> <${READ_GRAPH_STATE_PREDICATES.generation}> 7 } }`);
      await update(readGraphStateCompareAndSet(undefined, { readGraph: orphan, state: 'building', generation: 9, ...versions() }));
      expect((await lookup()).damaged).toContain(orphan);
      expect(await count(`SELECT (COUNT(*) AS ?n) WHERE { GRAPH <${readGraphStateGraphIri(cg)}> { <${orphan}> ?p ?o } }`)).toBe(1);

      await update(readGraphStateMarkAllDirty());
      expect(mine((await lookup()).rows)).toEqual(mine([
        { ...ready, state: 'dirty', generation: 4 }, { readGraph: swm, state: 'dirty', generation: 12, ...versions() },
      ]));
      expect((await lookup()).rows.find((row) => row.readGraph === wm)).toEqual({ readGraph: wm, state: 'dirty', generation: 41, ...versions() });
      await update(readGraphStateMarkAllDirty());
      expect(mine((await lookup()).rows).map((row) => row.generation).sort()).toEqual([12, 4].sort());
    });

    it('marks one read graph dirty from whatever row is stored, and leaves a dirty row, a missing one and every other row alone', async () => {
      const cg = freshContextGraph();
      const vm = readGraphIri({ scope: readScope(cg), layer: MemoryLayer.VerifiableMemory });
      const swm = readGraphIri({ scope: readScope(cg), layer: MemoryLayer.SharedWorkingMemory });
      const missing = readGraphIri({ scope: readScope(cg, 'code'), layer: MemoryLayer.VerifiableMemory });
      await setState({ readGraph: vm, state: 'rebuilding', generation: 6, ...versions() });
      await setState({ readGraph: swm, state: 'ready', generation: 9, ...versions() });
      const lookup = async () => parseReadGraphStateRows(await select(readGraphStateRowsQuery()));
      const mine = async () => (await lookup()).rows.filter((row) => row.readGraph === vm || row.readGraph === swm)
        .sort((a, b) => a.readGraph.localeCompare(b.readGraph));
      await update(readGraphStateMarkDirty(vm));
      await update(readGraphStateMarkDirty(missing));
      const marked = await mine();
      expect(marked).toEqual([{ readGraph: vm, state: 'dirty', generation: 7, ...versions() }, { readGraph: swm, state: 'ready', generation: 9, ...versions() }]
        .sort((a, b) => a.readGraph.localeCompare(b.readGraph)));
      const found = await lookup();
      expect([...found.rows.map((row) => row.readGraph), ...found.damaged]).not.toContain(missing);
      // Sent again, as after a lost response, it changes nothing.
      await update(readGraphStateMarkDirty(vm));
      expect(await mine()).toEqual(marked);
    });

    it('finds a missing and an extra triple in both directions of the check', async () => {
      const cg = freshContextGraph();
      const root = `did:dkg:context-graph:${cg}`;
      const g1 = `${root}/_verifiable_memory/${AGENT}/1`, g2 = `${root}/_verifiable_memory/${AGENT}/2`;
      const key: ReadGraphKey = { scope: readScope(cg), layer: MemoryLayer.VerifiableMemory };
      const R = readGraphIri(key);
      const target: ReadGraphTarget = { readGraph: R, membership: readGraphMembership(key, { contextGraphId: cg, subGraphNames: [], childContextGraphRoots: [] }, identity) };
      await update(`INSERT DATA {
        GRAPH <${g1}> { <urn:a> <urn:b> <urn:shared> . <urn:a> <urn:b> <urn:one> }
        GRAPH <${g2}> { <urn:a> <urn:b> <urn:shared> . <urn:x> <urn:b> <urn:two> }
      } ;\n${readGraphCopy(R, g1)} ;\n${readGraphCopy(R, g2)}`);
      const distinct = async () => (await count(readGraphFirstHolderCountQuery(target, g1))) + (await count(readGraphFirstHolderCountQuery(target, g2)));
      expect(await distinct()).toBe(3);
      expect(await count(readGraphSizeQuery(R))).toBe(3);
      expect(await ask(readGraphMissingTripleAsk(R, g1))).toBe(false);
      expect(await ask(readGraphUnheldSubjectAsk(target, 'urn:a'))).toBe(false);

      await update(`DELETE DATA { GRAPH <${R}> { <urn:x> <urn:b> <urn:two> } }`);
      expect(await ask(readGraphMissingTripleAsk(R, g2))).toBe(true);
      await update(`INSERT DATA { GRAPH <${R}> { <urn:x> <urn:b> <urn:two> . <urn:a> <urn:b> <urn:ghost> } }`);
      expect(await count(readGraphSizeQuery(R))).toBe(4);
      expect(await distinct()).toBe(3);
      expect(await ask(readGraphUnheldSubjectAsk(target, 'urn:a', render))).toBe(true);
      expect(await ask(readGraphUnheldSubjectAsk(target, 'urn:x'))).toBe(false);
    });

    it('carries blank nodes through the reference procedure', async () => {
      const cg = freshContextGraph();
      const root = `did:dkg:context-graph:${cg}`;
      const g1 = `${root}/_verifiable_memory/${AGENT}/1`, g2 = `${root}/_verifiable_memory/${AGENT}/2`;
      const key: ReadGraphKey = { scope: readScope(cg), layer: MemoryLayer.VerifiableMemory };
      const R = readGraphIri(key);
      const target: ReadGraphTarget = { readGraph: R, membership: readGraphMembership(key, { contextGraphId: cg, subGraphNames: [], childContextGraphRoots: [] }, identity) };
      await update(`INSERT DATA { GRAPH <${g1}> { _:b <urn:p> "x" . <urn:s> <urn:q> _:b } GRAPH <${g2}> { <urn:s> <urn:p> "y" } } ;\n${readGraphCopy(R, g1)} ;\n${readGraphCopy(R, g2)}`);
      expect(await count(readGraphSizeQuery(R))).toBe(3);
      await update(spliceReadGraphPlan({ readGraphs: [R], ...readGraphReferenceProcedure(target, [g1], []) }, [`DROP SILENT GRAPH <${g1}>`]));
      expect(await triples(R)).toEqual(['urn:s urn:p "y"']);
    });
  });
}

function versions() {
  return { ruleVersion: CURRENT_READ_GRAPH_VERSIONS.ruleVersion, builderVersion: CURRENT_READ_GRAPH_VERSIONS.builderVersion };
}
