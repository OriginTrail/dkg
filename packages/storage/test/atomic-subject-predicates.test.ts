// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildAtomicSubjectPredicatesReplaceUpdate, createTripleStore, OxigraphStore, SparqlHttpStore, BlazegraphStore,
  tryReplaceSubjectPredicatesAtomically, CHANGELOG_GRAPH, UnsupportedTripleStoreCapabilityError,
  ChangelogStore, GraphSetIndexStore, SharedMemoryLiteralBlobStore, type Quad, type TripleStore,
} from '../src/index.js';

const GRAPH = 'did:dkg:context-graph:predicate-test/_shared_memory/0x01/7';
const SUBJECT = 'urn:test:lifecycle', LAYER = 'urn:test:layer', STATE = 'urn:test:state';
const replacement = [q(LAYER, '"VM"'), q(STATE, '"published"')];
function q(predicate: string, object: string, subject = SUBJECT): Quad { return { graph: GRAPH, subject, predicate, object }; }
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close(); });
async function seed(store: TripleStore) {
  await store.insert([q(LAYER, '"SWM"'), q(STATE, '"promoted"'), q('urn:test:receipt', '"keep"'),
    q(LAYER, '"WM"', 'urn:test:other'), ...Array.from({ length: 130 }, (_, n) => q('urn:test:revision', `urn:test:revision:${n}`))]);
}
async function expectPreserved(store: TripleStore, expectedLayer = 'VM') {
  const rows = await store.query(`SELECT ?p ?o WHERE { GRAPH <${GRAPH}> { <${SUBJECT}> ?p ?o } } LIMIT 140`);
  expect(rows.type === 'bindings' ? rows.bindings : []).toHaveLength(133);
  expect(await store.query(`ASK { GRAPH <${GRAPH}> { <${SUBJECT}> <${LAYER}> "${expectedLayer}" ;
    <urn:test:receipt> "keep" . <urn:test:other> <${LAYER}> "WM" } }`)).toEqual({ type: 'boolean', value: true });
}
async function httpFixture(profile: 'best-effort' | 'atomic-update' = 'atomic-update', blazegraph = false) {
  const backing = new OxigraphStore(); cleanup.push(() => backing.close()); await seed(backing);
  let requests = 0, fail: 'none' | 'before' | 'after' = 'none';
  const server = createServer(async (req, res) => {
    requests++; let body = ''; for await (const chunk of req) body += chunk;
    if (fail === 'before') { res.writeHead(500); res.end('not committed'); return; }
    try {
      await backing.update(body);
      if (fail === 'after') { res.destroy(); return; }
      res.writeHead(204); res.end();
    } catch (error) { res.writeHead(400); res.end(String(error)); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('HTTP fixture not listening');
  const endpoint = `http://127.0.0.1:${address.port}`;
  const store = blazegraph ? new BlazegraphStore(endpoint) : new SparqlHttpStore({ queryEndpoint: endpoint, consistencyProfile: profile });
  cleanup.push(() => store.close());
  return { store, backing, requests: () => requests, fail: (mode: typeof fail) => { fail = mode; } };
}

describe('certified atomic subject predicate replacement', () => {
  it.each([
    ['empty predicates', [], replacement],
    ['duplicate predicates', [LAYER, LAYER], [q(LAYER, '"VM"')]],
    ['over-budget predicates', Array.from({ length: 33 }, (_, n) => `urn:p:${n}`), []],
    ['unsafe predicate', ['urn:p> } DROP ALL #'], []],
    ['blank predicate', ['_:blank'], []],
    ['outside predicate', [LAYER], [q(STATE, '"published"')]],
    ['wrong subject', [LAYER], [q(LAYER, '"VM"', 'urn:test:wrong')]],
    ['wrong graph', [LAYER], [{ ...q(LAYER, '"VM"'), graph: 'urn:test:wrong' }]],
    ['blank object', [LAYER], [q(LAYER, '_:blank')]],
  ] as const)('rejects %s before dispatch', (_name, predicates, quads) => {
    expect(() => buildAtomicSubjectPredicatesReplaceUpdate(GRAPH, SUBJECT, predicates, quads)).toThrow();
  });

  it('uses one native transaction, preserving every unrelated row without a history read', async () => {
    const store = new OxigraphStore(); cleanup.push(() => store.close()); await seed(store);
    const engine = (store as unknown as { store: { update(update: string): void } }).store;
    const update = vi.spyOn(engine, 'update'), query = vi.spyOn(store, 'query');
    expect(await tryReplaceSubjectPredicatesAtomically(store, GRAPH, SUBJECT, [LAYER, STATE], replacement)).toBe(true);
    expect(query).not.toHaveBeenCalled(); expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0][0]).toContain('DELETE {'); expect(update.mock.calls[0][0]).toContain('INSERT {');
    await expectPreserved(store);
    // A missing selected value still inserts once; empty payload removes only that predicate.
    await store.replaceSubjectPredicates(GRAPH, SUBJECT, ['urn:test:new'], [q('urn:test:new', '"new"')]);
    await store.replaceSubjectPredicates(GRAPH, SUBJECT, ['urn:test:new'], []);
    await expectPreserved(store);
  });

  it.each(['oxigraph', 'oxigraph-worker'] as const)('forwards actual writes through the full %s production decorator stack', async backend => {
    const directory = await mkdtemp(join(tmpdir(), 'atomic-predicates-')); cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const store = await createTripleStore({ backend, changelog: true, largeLiteralStorage: { enabled: true, directory } });
    cleanup.push(() => store.close()); await seed(store);
    const logBefore = await store.countQuads(CHANGELOG_GRAPH);
    const large = JSON.stringify('text'.repeat(20_000));
    await store.replaceSubjectPredicates!(GRAPH, SUBJECT, [LAYER, STATE, 'urn:test:payload'], [...replacement, q('urn:test:payload', large)]);
    const value = await store.query(`SELECT ?o WHERE { GRAPH <${GRAPH}> { <${SUBJECT}> <urn:test:payload> ?o } } LIMIT 2`);
    expect(value).toEqual({ type: 'bindings', bindings: [{ o: large }] });
    await store.replaceSubjectPredicates!(GRAPH, SUBJECT, ['urn:test:payload'], []);
    await expectPreserved(store); expect(await store.countQuads(CHANGELOG_GRAPH)).toBeGreaterThan(logBefore);
    expect(await store.listGraphs()).toContain(GRAPH);
  });

  it.each([false, true])('executes a real HTTP predicate transaction (Blazegraph client: %s)', async blazegraph => {
    const f = await httpFixture('atomic-update', blazegraph);
    await f.store.replaceSubjectPredicates!(GRAPH, SUBJECT, [LAYER, STATE], replacement);
    expect(f.requests()).toBe(1); await expectPreserved(f.backing);
  });

  it.each([false, true])('preserves the existing complete-subject HTTP contract (Blazegraph client: %s)', async blazegraph => {
    const f = await httpFixture('atomic-update', blazegraph);
    await f.store.replaceSubject!(GRAPH, SUBJECT, replacement);
    expect(await f.backing.countQuads(GRAPH)).toBe(3);
    expect(await f.backing.query(`ASK { GRAPH <${GRAPH}> { <urn:test:other> <${LAYER}> "WM" } }`))
      .toEqual({ type: 'boolean', value: true });
  });

  it('refuses uncertified HTTP before a request and never uses generic update fallback', async () => {
    const f = await httpFixture('best-effort'), update = vi.spyOn(f.store, 'update');
    expect(await tryReplaceSubjectPredicatesAtomically(f.store, GRAPH, SUBJECT, [LAYER, STATE], replacement)).toBe(false);
    expect(f.requests()).toBe(0); expect(update).not.toHaveBeenCalled(); await expectPreserved(f.backing, 'SWM');
  });

  it.each(['before', 'after'] as const)('propagates HTTP %s-commit dispatch failure and retries the selected transition', async fault => {
    const f = await httpFixture(); f.fail(fault);
    await expect(tryReplaceSubjectPredicatesAtomically(f.store, GRAPH, SUBJECT, [LAYER, STATE], replacement)).rejects.toThrow();
    await expectPreserved(f.backing, fault === 'before' ? 'SWM' : 'VM');
    f.fail('none'); await f.store.replaceSubjectPredicates!(GRAPH, SUBJECT, [LAYER, STATE], replacement);
    await expectPreserved(f.backing);
  });

  it('rejects an escaping blob payload before creating files or dispatching', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'predicate-blobs-')); cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const raw = new OxigraphStore(); cleanup.push(() => raw.close());
    const store = new SharedMemoryLiteralBlobStore(raw, { blobDir: directory, thresholdBytes: 16 });
    const replace = vi.spyOn(raw, 'replaceSubjectPredicates');
    await expect(store.replaceSubjectPredicates(GRAPH, SUBJECT, [LAYER], [q('urn:test:escaping', JSON.stringify('x'.repeat(1000)))]))
      .rejects.toThrow('escapes selected predicates');
    expect(replace).not.toHaveBeenCalled(); expect(await readdir(directory)).toEqual([]);
  });

  it.each(['refused', 'response-lost'] as const)('retains %s outcome through graph-index and changelog decorators', async failure => {
    const raw = new OxigraphStore(); cleanup.push(() => raw.close()); await seed(raw);
    const replace = raw.replaceSubjectPredicates.bind(raw);
    vi.spyOn(raw, 'replaceSubjectPredicates').mockImplementation(async (...args) => {
      if (failure === 'refused') throw new UnsupportedTripleStoreCapabilityError('replaceSubjectPredicates', 'fixture');
      await replace(...args); throw new Error('response lost after commit');
    });
    const store = new ChangelogStore(new GraphSetIndexStore(raw));
    const operation = tryReplaceSubjectPredicatesAtomically(store, GRAPH, SUBJECT, [LAYER, STATE], replacement);
    if (failure === 'refused') expect(await operation).toBe(false);
    else await expect(operation).rejects.toThrow('response lost after commit');
    await expectPreserved(raw, failure === 'refused' ? 'SWM' : 'VM');
  });

  it('preserves clean refusal through real decorators without changelog mutation', async () => {
    const raw = new OxigraphStore(); cleanup.push(() => raw.close()); await seed(raw);
    Object.defineProperty(raw, 'replaceSubjectPredicates', { value: undefined });
    const store = new ChangelogStore(new GraphSetIndexStore(raw));
    const before = await raw.countQuads(CHANGELOG_GRAPH);
    expect(await tryReplaceSubjectPredicatesAtomically(store, GRAPH, SUBJECT, [LAYER], [q(LAYER, '"VM"')])).toBe(false);
    expect(await raw.countQuads(CHANGELOG_GRAPH)).toBe(before); await expectPreserved(raw, 'SWM');
    await expect(store.replaceSubjectPredicates(GRAPH, SUBJECT, [LAYER], replacement))
      .rejects.toBeInstanceOf(UnsupportedTripleStoreCapabilityError);
  });
});
