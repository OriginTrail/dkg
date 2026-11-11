import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BlazegraphStore } from '../../src/adapters/blazegraph.js';
import { OxigraphStore } from '../../src/adapters/oxigraph.js';
import { BlazegraphNamespaceManager, blazegraphNamespaceApiUrlFromSparqlEndpoint } from '../../src/blazegraph-namespace-manager.js';
import { SharedMemoryLiteralBlobStore } from '../../src/shared-memory-literal-blob-store.js';
import { workingMemoryIdentityRule } from '../../src/read-graph/membership.js';
import type { TripleStoreConfig } from '../../src/triple-store-composition.js';
import type { Quad, TripleStore } from '../../src/triple-store.js';
import { AGENT, P, expectLayerUnions, layerFixture, layeredStore, q, type LayerFixture } from './read-graph-layer-conformance.js';

/** The copy counts of the qualification matrix's engine-cost row. */
export const COPY_COUNTS = [100, 1_000, 10_000] as const;

/** The node's peer ID: the default agent, `AGENT`, also owns the drafts written under it. */
const PEER = '12D3KooWQualificationPeer';
const OTHER_AGENT = '0x' + 'ef'.repeat(20);
const IDENTITY = workingMemoryIdentityRule({ defaultAgentAddress: AGENT, peerId: PEER });

/** One timed removal of a triple that many graphs hold. */
export interface CopyRemovalTiming {
  readonly copies: number;
  readonly case: 'a member survives' | 'only copies outside the view';
  readonly ms: number;
}

async function holds(adapter: TripleStore, readGraph: string, subject: string, object: string): Promise<boolean> {
  const result = await adapter.query(`ASK { GRAPH <${readGraph}> { <${subject}> <${P}> ${object} } }`);
  return result.type === 'boolean' && result.value;
}

/**
 * The qualification matrix's rows for the read-graph layer that the per-method conformance does
 * not cover: a large shared-memory literal shared by two assets, two concurrent removals of the
 * last two copies, and the existence check at high copy counts. Each runs through the layer as
 * `createTripleStore` composes it, and ends with every read graph equal to the union of its members.
 */
export function readGraphQualificationSuite(backend: 'oxigraph' | 'blazegraph', timings?: CopyRemovalTiming[]) {
  describe(`read-graph qualification (${backend})`, () => {
    let manager: BlazegraphNamespaceManager | undefined;
    let handles: Awaited<ReturnType<BlazegraphNamespaceManager['acquireMany']>> | undefined;
    let shared: { readonly adapter: TripleStore; readonly config: TripleStoreConfig } | undefined;
    const run = `qual${randomUUID().slice(0, 8)}`;
    let sequence = 0;
    const freshFixture = () => layerFixture(`${run}-${sequence += 1}`);
    /**
     * The production adapter of each engine, under the read-graph layer. Embedded Oxigraph gets a new
     * store each time; Blazegraph shares one namespace, with a new context graph each time.
     */
    const open = async (fixture: LayerFixture) => {
      const { adapter, config } = shared ?? { adapter: new OxigraphStore(), config: { backend: 'oxigraph' } as TripleStoreConfig };
      const withIdentity: TripleStoreConfig = { ...config, readGraphs: { workingMemoryIdentity: IDENTITY } };
      return { adapter, ...(await layeredStore(adapter, withIdentity, fixture)), close: shared ? async () => {} : () => adapter.close() };
    };

    beforeAll(async () => {
      if (backend !== 'blazegraph') return;
      if (!process.env.BLAZEGRAPH_TEST_URL) throw new Error('The live Blazegraph lane requires BLAZEGRAPH_TEST_URL');
      manager = new BlazegraphNamespaceManager({ namespaceApiUrl: blazegraphNamespaceApiUrlFromSparqlEndpoint(process.env.BLAZEGRAPH_TEST_URL) });
      handles = await manager.acquireMany([`read-graph-qualification-${randomUUID()}`]);
      const url = handles[0]!.sparqlUrl;
      shared = { adapter: new BlazegraphStore(url, { timeout: 120_000 }), config: { backend: 'blazegraph', options: { url } } };
    }, 60_000);
    afterAll(async () => {
      await shared?.adapter.close();
      if (manager && handles) await manager.disposeAll(handles);
    }, 60_000);

    it('keeps a large shared-memory literal that two assets share until both let it go, and reads it back whole', async () => {
      const fixture = freshFixture();
      const { adapter, layer, store, close } = await open(fixture);
      const blobDir = await mkdtemp(join(tmpdir(), 'read-graph-qualification-'));
      try {
        const blobs = new SharedMemoryLiteralBlobStore(store, { blobDir, thresholdBytes: 64 });
        const swm = fixture.readGraphs.wholeSwm;
        const [a, b] = [10, 11].map(n => `${fixture.root}/_shared_memory/${AGENT}/${n}`);
        const large = JSON.stringify(`large:${'x'.repeat(4096)}`);
        const quadIn = (graph: string): Quad => ({ subject: 'urn:s:large', predicate: P, object: large, graph });
        await blobs.insert([quadIn(a!), quadIn(b!)]);
        await expectLayerUnions(adapter, layer, fixture, 'two assets insert the same large literal');
        const read = async () => {
          const result = await blobs.query(`SELECT ?o WHERE { GRAPH <${swm}> { <urn:s:large> <${P}> ?o } }`);
          return result.type === 'bindings' ? result.bindings.map(row => row.o) : [];
        };
        // The read graph holds the literal once, and it reads back whole through the literal store.
        expect(await read()).toEqual([large]);
        await blobs.delete([quadIn(a!)]);
        await expectLayerUnions(adapter, layer, fixture, 'one asset lets the literal go');
        expect(await read()).toEqual([large]);
        await blobs.delete([quadIn(b!)]);
        await expectLayerUnions(adapter, layer, fixture, 'both assets let the literal go');
        expect(await read()).toEqual([]);
      } finally {
        await rm(blobDir, { recursive: true, force: true });
        await close();
      }
    }, 120_000);

    it("keeps the default agent's drafts under its peer ID and another spelling of its address in its read graph, and no other agent's", async () => {
      const fixture = freshFixture();
      const { adapter, layer, store, close } = await open(fixture);
      try {
        const wm = fixture.readGraphs.agentWm;
        const peerDraft = `${fixture.root}/_working_memory/${PEER}/30`;
        const spelledDraft = `${fixture.root}/_working_memory/0x${AGENT.slice(2).toUpperCase()}/31`;
        const otherDraft = `${fixture.root}/_working_memory/${OTHER_AGENT}/32`;
        await store.insert([q('urn:s:note', '"same"', peerDraft), q('urn:s:note', '"same"', spelledDraft), q('urn:s:theirs', '"theirs"', otherDraft)]);
        expect(await holds(adapter, wm, 'urn:s:note', '"same"')).toBe(true);
        expect(await holds(adapter, wm, 'urn:s:theirs', '"theirs"')).toBe(false);
        await expectLayerUnions(adapter, layer, fixture, 'drafts under the peer ID, another spelling and another agent');
        // Discarding one draft keeps the triple the other draft still holds; discarding both lets it go.
        await store.delete([q('urn:s:note', '"same"', peerDraft)]);
        expect(await holds(adapter, wm, 'urn:s:note', '"same"')).toBe(true);
        await store.dropGraph(spelledDraft);
        expect(await holds(adapter, wm, 'urn:s:note', '"same"')).toBe(false);
        await expectLayerUnions(adapter, layer, fixture, 'both drafts discarded');
      } finally { await close(); }
    }, 120_000);

    it('removes a triple whose last two copies two concurrent writes remove', async () => {
      const fixture = freshFixture();
      const { adapter, layer, store, close } = await open(fixture);
      try {
        const vm = fixture.readGraphs.wholeVm;
        const [a, b] = [20, 21].map(n => `${fixture.root}/_verifiable_memory/${AGENT}/${n}`);
        await store.insert([q('urn:s:last', '"two copies"', a!), q('urn:s:last', '"two copies"', b!)]);
        expect(await holds(adapter, vm, 'urn:s:last', '"two copies"')).toBe(true);
        // Each removal alone would see the other copy still held; the layer orders them.
        await Promise.all([store.delete([q('urn:s:last', '"two copies"', a!)]), store.delete([q('urn:s:last', '"two copies"', b!)])]);
        expect(await holds(adapter, vm, 'urn:s:last', '"two copies"')).toBe(false);
        await expectLayerUnions(adapter, layer, fixture, 'two concurrent removals of the last two copies');
      } finally { await close(); }
    }, 120_000);

    it.each(COPY_COUNTS)('checks a triple held by %i graphs: kept while a member holds it, dropped when only graphs outside the view do', async (copies) => {
      const fixture = freshFixture();
      const { adapter, layer, store, close } = await open(fixture);
      try {
        const vm = fixture.readGraphs.wholeVm;
        const member = (n: number) => `${fixture.root}/_verifiable_memory/${AGENT}/copy-${n}`;
        const outside = (n: number) => `${fixture.root}-outside/_verifiable_memory/${AGENT}/copy-${n}`;
        const copy = (graph: string) => q('urn:s:copy', '"copied"', graph);
        const timed = async (label: CopyRemovalTiming['case'], work: () => Promise<void>) => {
          const started = performance.now();
          await work();
          const ms = Math.round(performance.now() - started);
          timings?.push({ copies, case: label, ms });
          // A coarse bound that catches a check that scans far more than the triple's holders.
          expect(ms).toBeLessThan(30_000);
        };

        // Every member holds the triple: removing it from one keeps it in the read graph.
        await store.insert(Array.from({ length: copies }, (_, n) => copy(member(n))));
        await timed('a member survives', () => store.delete([copy(member(0))]));
        expect(await holds(adapter, vm, 'urn:s:copy', '"copied"')).toBe(true);

        // The rest of the members let it go together: no member is left, so it leaves.
        await store.delete(Array.from({ length: copies - 1 }, (_, n) => copy(member(n + 1))));
        expect(await holds(adapter, vm, 'urn:s:copy', '"copied"')).toBe(false);

        // One member holds it besides as many graphs of another context graph: removing it drops it.
        await store.insert([copy(member(0)), ...Array.from({ length: copies }, (_, n) => copy(outside(n)))]);
        expect(await holds(adapter, vm, 'urn:s:copy', '"copied"')).toBe(true);
        await timed('only copies outside the view', () => store.delete([copy(member(0))]));
        expect(await holds(adapter, vm, 'urn:s:copy', '"copied"')).toBe(false);
        await expectLayerUnions(adapter, layer, fixture, `a triple held by ${copies} graphs`);
        await store.delete(Array.from({ length: copies }, (_, n) => copy(outside(n))));
      } finally { await close(); }
    }, 600_000);
  });
}
