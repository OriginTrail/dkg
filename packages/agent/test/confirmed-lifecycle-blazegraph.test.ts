import { afterEach, expect, it, vi } from 'vitest';
import { assertionLifecycleUri, contextGraphAssertionUri, contextGraphMetaUri, contextGraphLayerUri, MemoryLayer } from '@origintrail-official/dkg-core';
import { BlazegraphStore, OxigraphStore, type TripleStore } from '@origintrail-official/dkg-storage';
import { mutatePublishedNamedKaVmLifecycle } from '../src/named-ka-vm-lifecycle.js';
import { confirmedLifecycleRecoveryFixture } from './_helpers/confirmed-lifecycle-recovery-fixture.js';

const stores: TripleStore[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); for (const store of stores.splice(0)) await store.close(); });

it.each([false, true])('uses one native lifecycle mutation and matches fallback semantics, newer draft=%s', async newerDraft => {
  const backend = new OxigraphStore(), reference = new OxigraphStore(); stores.push(backend, reference);
  const leaf = new BlazegraphStore('http://blaze.test/sparql'); stores.push(leaf);
  const { input } = confirmedLifecycleRecoveryFixture();
  const meta = contextGraphMetaUri(input.contextGraphId), lifecycle = assertionLifecycleUri(input.contextGraphId, input.agentAddress, input.name);
  const assertion = contextGraphAssertionUri(input.contextGraphId, input.agentAddress, input.name), dkg = 'http://dkg.io/ontology/';
  const root = input.merkleRoot.slice(2), draft = newerDraft ? 'ab'.repeat(32) : root;
  const row = (subject: string, predicate: string, object: string) => ({ subject, predicate: dkg + predicate, object, graph: meta });
  const initial = [row(lifecycle, 'wmCurrentAssertion', JSON.stringify(draft)), row(lifecycle, 'swmCurrentAssertion', JSON.stringify(root)),
    row(lifecycle, 'state', JSON.stringify(newerDraft ? 'created' : 'shared')),
    row(lifecycle, 'memoryLayer', JSON.stringify(newerDraft ? 'WM' : 'SWM')), row(assertion, 'memoryLayer', '"SWM"'),
    row(lifecycle, 'publishedUal', '"old"'), row(lifecycle, 'note', '"unrelated annotation"'),
    ...[MemoryLayer.WorkingMemory, MemoryLayer.SharedWorkingMemory].map(layer => row(contextGraphLayerUri(input.contextGraphId, layer, input.agentAddress, 1n), 'memoryLayer', JSON.stringify(layer)))];
  await backend.insert(initial); await reference.insert(initial);
  // Use real adapter dispatch and real SPARQL execution; only the HTTP transport is local.
  let mutations = 0;
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => { mutations++; await backend.update(String(init.body)); return new Response('complete'); }));
  vi.spyOn(leaf, 'query').mockImplementation(backend.query.bind(backend));
  vi.spyOn(leaf, 'insert').mockImplementation(async quads => { mutations++; await backend.insert(quads); });
  await mutatePublishedNamedKaVmLifecycle(leaf, input);
  expect(mutations).toBe(1);
  const fallback = new Proxy(reference, { get(target, property) {
    if (property === 'atomicUpdate') return undefined;
    const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
  } });
  await mutatePublishedNamedKaVmLifecycle(fallback, input);
  const all = 'SELECT ?s ?p ?o ?g WHERE { GRAPH ?g { ?s ?p ?o } } ORDER BY ?g ?s ?p ?o';
  expect(await backend.query(all)).toEqual(await reference.query(all));
  expect(await backend.query(`ASK { GRAPH <${meta}> { <${lifecycle}> <${dkg}note> "unrelated annotation" } }`)).toMatchObject({ value: true });
  if (newerDraft) expect(await backend.query(`ASK { GRAPH <${meta}> { <${lifecycle}> <${dkg}wmCurrentAssertion> "${draft}"; <${dkg}state> "created" } }`)).toMatchObject({ value: true });
});
