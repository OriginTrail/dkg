import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import oxigraph from 'oxigraph';
import { createManagedOxigraphSparqlStoreV1 } from '../src/adapters/sparql-http.js';
import { ChangelogStore, CHANGELOG_GRAPH } from '../src/changelog-store.js';
import { GraphSetIndexStore } from '../src/graph-set-index-store.js';
import { StorePriorityScheduler } from '../src/store-priority-scheduler.js';
import { authorCommitInput, PROJECTION_GRAPH, seedOldState } from './rfc64-author-commit-cas-harness.js';
import type { QueryOptions } from '../src/triple-store.js';

const GRAPH = 'urn:test:counted-maintenance';
afterEach(() => vi.restoreAllMocks());

async function harness(failure?: 'count' | 'marker' | 'cas403', pauseOn = (body: string) => body.startsWith('DELETE') && body.includes(`<${GRAPH}>`)) {
  const engine = new oxigraph.Store();
  engine.update(`INSERT DATA { GRAPH <${GRAPH}> { <urn:target:a> <urn:p> "a" . <urn:other:b> <urn:p> "b" } }`);
  const state = { recovering: false, admissionsPaused: false, generation: 0 };
  const requests: string[] = [], activity: boolean[] = [];
  let deleting!: () => void, release!: () => void;
  const deleted = new Promise<void>(resolve => { deleting = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  let committed = false;
  const server = createServer((request, response) => {
    void (async () => {
      const parts: Buffer[] = [];
      for await (const part of request) parts.push(Buffer.from(part));
      const body = Buffer.concat(parts).toString('utf8'); requests.push(body);
      const update = request.headers['content-type']?.startsWith('application/sparql-update');
      if (update) {
        if (failure === 'cas403' && body.includes('authorCommitApplied') && body.includes('INSERT DATA')) {
          response.writeHead(403).end('semantic CAS denied'); return;
        }
        if (committed && failure === 'marker' && body.includes(CHANGELOG_GRAPH)) {
          response.writeHead(500).end('marker outcome unavailable'); return;
        }
        engine.update(body);
        if (!committed && pauseOn(body)) {
          committed = true; state.admissionsPaused = true; deleting(); await held;
        }
        response.writeHead(204).end(); return;
      }
      if (committed && failure === 'count' && body.includes('COUNT(*)')) {
        response.writeHead(403).end('final count denied'); return;
      }
      const result = engine.query(body);
      response.setHeader('Content-Type', 'application/sparql-results+json');
      if (typeof result === 'boolean') { response.end(JSON.stringify({ boolean: result })); return; }
      const rows = result as Map<string, oxigraph.Term>[];
      response.end(JSON.stringify({ head: { vars: [...(rows[0]?.keys() ?? [])] }, results: { bindings: rows.map(row =>
        Object.fromEntries([...row].map(([key, term]) => [key, { type: term.termType === 'NamedNode' ? 'uri' : term.termType === 'BlankNode' ? 'bnode' : 'literal', value: term.value }]))), } }));
    })().catch(error => response.destroy(error));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const raw = createManagedOxigraphSparqlStoreV1({
    queryEndpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}/query`, timeout: 2000,
    scheduler: new StorePriorityScheduler({ maxConcurrent: 1, ackReservedSlots: 0, healthReservedSlots: 0, normalReservedSlots: 0, backgroundReservedSlots: 0 }),
  }, { getRecoveryState: () => ({ ...state }), registerActivity: () => ({ report: busy => activity.push(busy), dispose() {} }) });
  const index = new GraphSetIndexStore(raw);
  const log = new ChangelogStore(index);
  await log.changelogHead(); // Production enabled wrapper, already seeded durable log.
  activity.length = 0; requests.length = 0;
  return { log, index, raw, state, activity, requests, deleted, release, engine,
    endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}/query`,
    async close() { release(); await log.close(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); },
  };
}

const mutations = {
  pattern: (log: ChangelogStore) => log.deleteByPattern({ graph: GRAPH, subject: 'urn:target:a' }),
  prefix: (log: ChangelogStore) => log.deleteBySubjectPrefix(GRAPH, 'urn:target:'),
};

describe('counted deletion maintenance with the enabled changelog', () => {
  it.each(['uncounted', 'pattern', 'prefix', 'delete', 'update', 'replace', 'cas'] as const)('retains bare graph-index %s maintenance under the shared logical lifetime', async kind => {
    const h = await harness(undefined, body => kind === 'cas'
      ? body.includes('authorCommitApplied') && body.includes('INSERT DATA')
      : body.includes(`<${GRAPH}>`) && body.startsWith('DELETE'));
    if (kind === 'cas') await seedOldState(h.raw);
    await h.index.listGraphs(); // Warm production index so post-write maintenance must probe.
    h.requests.length = 0;
    const work = kind === 'uncounted' ? h.index.deleteByPatternWithoutCount({ graph: GRAPH, subject: 'urn:target:a' })
      : kind === 'pattern' ? h.index.deleteByPattern({ graph: GRAPH, subject: 'urn:target:a' })
      : kind === 'prefix' ? h.index.deleteBySubjectPrefix(GRAPH, 'urn:target:')
      : kind === 'delete' ? h.index.delete([{ graph: GRAPH, subject: 'urn:target:a', predicate: 'urn:p', object: '"a"' }])
      : kind === 'update' ? h.index.update(`DELETE WHERE { GRAPH <${GRAPH}> { <urn:target:a> ?p ?o } }`, { touchedGraphs: [GRAPH] })
      : kind === 'replace' ? h.index.replaceSubject(GRAPH, 'urn:target:a', [{ graph: GRAPH, subject: 'urn:target:a', predicate: 'urn:p', object: '"replacement"' }])
      : h.index.rfc64AuthorCommitCasV1(authorCommitInput());
    const settled = work.then(value => ({ value }), error => ({ error }));
    try {
      await Promise.race([h.deleted, settled.then(() => { throw new Error('mutation ended before pause'); })]);
      const requests = h.requests.length;
      await expect(h.raw.query('ASK {}')).rejects.toMatchObject({ outcome: 'not_started' });
      expect(h.requests).toHaveLength(requests);
      h.release();
      expect(await settled).toEqual({ value: kind === 'cas' ? 'committed' : kind === 'pattern' || kind === 'prefix' ? 1 : undefined });
      expect(h.requests.some(body => body.trimStart().startsWith('ASK') && body.includes(`<${kind === 'cas' ? PROJECTION_GRAPH : GRAPH}>`))).toBe(true);
      expect(h.activity.at(-1)).toBe(false);
    } finally { await h.close(); }
  });

  it.each(['drop', 'uncounted', 'delete', 'update'] as const)('retains admitted %s mutation through its graph-index and changelog writes', async kind => {
    const h = await harness(undefined, body => body.includes(`<${GRAPH}>`) && /^(DROP|DELETE)/.test(body));
    const work = kind === 'drop' ? h.log.dropGraph(GRAPH)
      : kind === 'uncounted' ? h.log.deleteByPatternWithoutCount({ graph: GRAPH, subject: 'urn:target:a' })
      : kind === 'delete' ? h.log.delete([{ graph: GRAPH, subject: 'urn:target:a', predicate: 'urn:p', object: '"a"' }])
      : h.log.update(`DELETE WHERE { GRAPH <${GRAPH}> { <urn:target:a> ?p ?o } }`, { touchedGraphs: [GRAPH] });
    const settled = work.then(() => ({ success: true }), error => ({ error }));
    try {
      await Promise.race([h.deleted, settled.then(() => { throw new Error('mutation ended before maintenance pause'); })]);
      expect(h.engine.query(`ASK { GRAPH <${GRAPH}> { <urn:target:a> ?p ?o } }`)).toBe(false);
      const requests = h.requests.length;
      await expect(h.raw.query('ASK {}')).rejects.toMatchObject({ outcome: 'not_started' });
      await expect(h.raw.insert([{ graph: GRAPH, subject: 'urn:fresh', predicate: 'urn:p', object: '"fresh"' }])).rejects.toMatchObject({ outcome: 'not_started' });
      expect(h.requests).toHaveLength(requests);
      h.release(); expect(await settled).toEqual({ success: true });
      expect(h.engine.query(`ASK { GRAPH <${CHANGELOG_GRAPH}> { ?s <urn:dkg:changelog#graph> <${GRAPH}> } }`)).toBe(true);
      expect(h.log.needsReconcile).toBe(false);
      expect(h.activity.at(-1)).toBe(false);
    } finally { await h.close(); }
  });

  it('preserves a definite CAS rejection through successful staging cleanup and the changelog wrapper', async () => {
    const h = await harness('cas403'); await seedOldState(h.raw);
    const before = h.raw.getWriteRevision(PROJECTION_GRAPH);
    try {
      await expect(h.log.rfc64AuthorCommitCasV1(authorCommitInput())).rejects.toMatchObject({ name: 'SparqlHttpResponseError', status: 403 });
      expect(h.requests.some(body => body.startsWith('DROP SILENT GRAPH') && !body.includes('INSERT DATA'))).toBe(true);
      expect(h.requests.some(body => body.startsWith('ASK') && body.includes('authorCommitApplied'))).toBe(false);
      expect(h.raw.getWriteRevision(PROJECTION_GRAPH)).toEqual(before);
      expect(h.engine.query(`ASK { GRAPH <${PROJECTION_GRAPH}> { <urn:test:rfc64:new:1> ?p ?o } }`)).toBe(false);
    } finally { await h.close(); }
  });

  it.each(['pattern', 'prefix'] as const)('drains %s deletion, graph-index and marker work while fresh operations stay refused', async kind => {
    const h = await harness(); const mutation = mutations[kind](h.log);
    const settled = mutation.then(value => ({ value }), error => ({ error }));
    try {
      await Promise.race([h.deleted, mutation.then(() => { throw new Error('delete ended before dispatch'); })]);
      expect(h.engine.query(`ASK { GRAPH <${GRAPH}> { <urn:target:a> ?p ?o } }`)).toBe(false);
      const requestCount = h.requests.length;
      expect(h.activity.at(-1)).toBe(true);
      await expect(h.raw.query('ASK {}')).rejects.toMatchObject({ outcome: 'not_started' });
      expect(h.requests).toHaveLength(requestCount);
      h.release(); expect(await settled).toEqual({ value: 1 });
      expect(h.log.needsReconcile).toBe(false);
      expect(h.engine.query(`ASK { GRAPH <${GRAPH}> { <urn:target:a> ?p ?o } }`)).toBe(false);
      expect(h.engine.query(`ASK { GRAPH <${GRAPH}> { <urn:other:b> ?p ?o } }`)).toBe(true);
      expect(h.engine.query(`ASK { GRAPH <${CHANGELOG_GRAPH}> { ?s <urn:dkg:changelog#graph> <${GRAPH}> } }`)).toBe(true);
      const lastBusy = h.activity.lastIndexOf(true);
      expect(h.activity.slice(1, lastBusy).every(Boolean)).toBe(true);
      expect(h.activity.at(-1)).toBe(false);
      await expect(h.log.query('ASK {}')).rejects.toMatchObject({ outcome: 'not_started' });
    } finally { await h.close(); }
  });

  it.each(['count', 'marker'] as const)('retains committed %s failure evidence and flags reconciliation', async failure => {
    const h = await harness(failure); const mutation = mutations.pattern(h.log);
    const rejected = expect(mutation).rejects.toMatchObject({ storeOperation: 'deleteByPattern', outcome: 'indeterminate' });
    try {
      await h.deleted; h.release(); await rejected;
      expect(h.engine.query(`ASK { GRAPH <${GRAPH}> { <urn:target:a> ?p ?o } }`)).toBe(false);
      expect(h.log.needsReconcile).toBe(true);
    } finally { await h.close(); }
  });

  it('keeps logical admission store-bound and prevents options copying or completed scopes from admitting fresh work', async () => {
    const h = await harness();
    let scoped: QueryOptions | undefined;
    const original = h.raw.countQuads.bind(h.raw);
    vi.spyOn(h.raw, 'countQuads').mockImplementation((graph, options) => {
      scoped = options; return original(graph, options);
    });
    const other = createManagedOxigraphSparqlStoreV1({ queryEndpoint: h.endpoint }, {
      getRecoveryState: () => ({ recovering: false, admissionsPaused: true, generation: 0 }),
    });
    const mutation = mutations.pattern(h.log);
    try {
      await h.deleted;
      expect(scoped).toBeDefined();
      await expect(h.raw.query('ASK {}', { ...scoped })).rejects.toMatchObject({ outcome: 'not_started' });
      await expect(other.query('ASK {}', scoped)).rejects.toMatchObject({ outcome: 'not_started' });
      h.release(); await expect(mutation).resolves.toBe(1);
      await expect(h.raw.query('ASK {}', scoped)).rejects.toMatchObject({ outcome: 'not_started' });
    } finally { await other.close(); await h.close(); }
  });

  it('shares nested lifetime through telemetry copies without transferring admission to another store or late work', async () => {
    const h = await harness(undefined, body => body.startsWith('INSERT DATA') && body.includes(`<${GRAPH}>`));
    const other = createManagedOxigraphSparqlStoreV1({ queryEndpoint: h.endpoint }, {
      getRecoveryState: () => ({ recovering: false, admissionsPaused: true, generation: 0 }),
    });
    let releaseLate!: () => void;
    const lateGate = new Promise<void>(resolve => { releaseLate = resolve; });
    let late!: Promise<unknown>;
    const work = h.raw.runLogicalMutation('insert', { source: 'test.outer' }, async options => {
      late = lateGate.then(() => h.raw.query('ASK {}', { ...options, source: 'test.late' }));
      void late.catch(() => undefined);
      await h.raw.insert([{ graph: GRAPH, subject: 'urn:nested', predicate: 'urn:p', object: '"nested"' }], options);
      await expect(other.query('ASK {}', options)).rejects.toMatchObject({ outcome: 'not_started' });
      return h.raw.runLogicalMutation('deleteByPattern', { ...options, source: 'test.nested' }, copied =>
        h.raw.query(`ASK { GRAPH <${GRAPH}> { <urn:nested> ?p ?o } }`, { ...copied, source: 'test.read' }));
    });
    try {
      await h.deleted;
      await expect(h.raw.query('ASK {}')).rejects.toMatchObject({ outcome: 'not_started' });
      h.release(); await expect(work).resolves.toEqual({ type: 'boolean', value: true });
      const requestCount = h.requests.length;
      releaseLate(); await expect(late).rejects.toMatchObject({ outcome: 'not_started' });
      expect(h.requests).toHaveLength(requestCount);
      expect(h.activity.at(-1)).toBe(false);
    } finally { releaseLate(); await other.close(); await h.close(); }
  });

  it('refuses continuation after a managed generation changes and retains reconciliation evidence', async () => {
    const h = await harness(); const mutation = mutations.pattern(h.log);
    const rejected = expect(mutation).rejects.toMatchObject({ storeOperation: 'deleteByPattern', outcome: 'indeterminate' });
    try {
      await h.deleted; h.state.generation += 1; h.release(); await rejected;
      expect(h.engine.query(`ASK { GRAPH <${GRAPH}> { <urn:target:a> ?p ?o } }`)).toBe(false);
      expect(h.log.needsReconcile).toBe(true);
    } finally { await h.close(); }
  });


  it.each(['pattern', 'prefix'] as const)('drains bare adapter %s continuations without a changelog wrapper', async kind => {
    const h = await harness();
    const mutation = kind === 'pattern'
      ? h.raw.deleteByPattern({ graph: GRAPH, subject: 'urn:target:a' })
      : h.raw.deleteBySubjectPrefix(GRAPH, 'urn:target:');
    try {
      await h.deleted; h.release(); await expect(mutation).resolves.toBe(1);
      expect(h.activity.at(-1)).toBe(false);
      await expect(h.raw.query('ASK {}')).rejects.toMatchObject({ outcome: 'not_started' });
    } finally { await h.close(); }
  });

  it('refuses a new logical mutation before dispatch while maintenance is paused', async () => {
    const h = await harness(); h.state.admissionsPaused = true;
    try {
      await expect(mutations.pattern(h.log)).rejects.toMatchObject({ storeOperation: 'deleteByPattern', outcome: 'not_started' });
      expect(h.requests).toEqual([]);
      expect(h.log.needsReconcile).toBe(false);
      expect(h.engine.query(`ASK { GRAPH <${GRAPH}> { <urn:target:a> ?p ?o } }`)).toBe(true);
    } finally { await h.close(); }
  });

  it('does not publish a marker when an admitted delete removes no rows', async () => {
    const h = await harness();
    const mutation = h.log.deleteByPattern({ graph: GRAPH, subject: 'urn:not-there' });
    try {
      await h.deleted; h.release(); await expect(mutation).resolves.toBe(0);
      expect(h.log.needsReconcile).toBe(false);
      expect(h.requests.some(body => body.startsWith('INSERT DATA') && body.includes(CHANGELOG_GRAPH))).toBe(false);
      expect(h.engine.query(`ASK { GRAPH <${GRAPH}> { <urn:target:a> ?p ?o } }`)).toBe(true);
    } finally { await h.close(); }
  });

  it('preserves atomic replacement admission through enabled changelog bookkeeping', async () => {
    const h = await harness();
    const mutation = h.log.replaceSubject(GRAPH, 'urn:target:a', [{ graph: GRAPH, subject: 'urn:target:a', predicate: 'urn:p', object: '"replacement"' }]);
    try {
      await h.deleted; h.release(); await mutation;
      expect(h.engine.query(`ASK { GRAPH <${GRAPH}> { <urn:target:a> <urn:p> "replacement" } }`)).toBe(true);
      expect(h.engine.query(`ASK { GRAPH <${CHANGELOG_GRAPH}> { ?s <urn:dkg:changelog#graph> <${GRAPH}> } }`)).toBe(true);
      expect(h.log.needsReconcile).toBe(false);
      await expect(h.raw.query('ASK {}')).rejects.toMatchObject({ outcome: 'not_started' });
    } finally { await h.close(); }
  });

  it('preserves the CAS receipt, cleanup and enabled changelog under one logical admission', async () => {
    const h = await harness(undefined, body => body.includes('authorCommitApplied') && body.includes('INSERT DATA'));
    const input = authorCommitInput();
    await seedOldState(h.raw);
    const mutation = h.log.rfc64AuthorCommitCasV1(input);
    try {
      await h.deleted; h.release(); await expect(mutation).resolves.toBe('committed');
      expect(h.engine.query(`ASK { GRAPH <${PROJECTION_GRAPH}> { <urn:test:rfc64:new:1> ?p ?o } }`)).toBe(true);
      expect(h.engine.query(`ASK { GRAPH <${CHANGELOG_GRAPH}> { ?s <urn:dkg:changelog#graph> <${PROJECTION_GRAPH}> } }`)).toBe(true);
      expect(h.log.needsReconcile).toBe(false);
      expect(h.requests.some(body => body.startsWith('DROP SILENT GRAPH') && !body.includes('INSERT DATA'))).toBe(true);
      await expect(h.raw.query('ASK {}')).rejects.toMatchObject({ outcome: 'not_started' });
    } finally { await h.close(); }
  });

});
