import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { OxigraphStore, SparqlHttpStore, BlazegraphStore, type TripleStore, type Quad } from '../packages/storage/dist/index.js';
import { resolveOxigraphBinary } from '../packages/cli/dist/daemon/oxigraph-binary.js';
import { startTestOxigraphServer } from '../scripts/testing/oxigraph.js';
import { TripleStoreAsyncLiftPublisher } from '../packages/publisher/dist/index.js';
import { KA_VM_VALIDATION, KA_VM_BROADCAST_TX, kaVmPublishRequest } from '../scripts/testing/ka-vm-publish.js';

async function values(store: TripleStore, graph: string) {
  const result = await store.query(`SELECT ?s ?p ?o WHERE { GRAPH <${graph}> { ?s ?p ?o } } ORDER BY ?s ?p ?o`);
  assert.equal(result.type, 'bindings');
  if (result.type !== 'bindings') throw new Error('incomplete result');
  return result.bindings;
}

test('real embedded, HTTP and configured Blazegraph stores preserve graph isolation and recovery', { timeout: 180_000 }, async (t) => {
  await rm('test-systems/.runtime/storage-conformance.json', { force: true });
  const root = await mkdtemp(join(tmpdir(), 'dkg-store-conformance-'));
  const cleanup: Array<() => Promise<unknown>> = [() => rm(root, { recursive: true, force: true })];
  t.after(async () => {
    const errors: unknown[] = [];
    for (const action of cleanup.reverse()) { try { await action(); } catch (error) { errors.push(error); } }
    if (errors.length) throw new AggregateError(errors, 'conformance cleanup failed');
  });
  const binary = await resolveOxigraphBinary({ cacheDir: resolve('test-systems/.runtime/bin') });
  const logs: string[] = [];
  const server = await startTestOxigraphServer({ binaryPath: binary.path, location: join(root, 'rocksdb'), restartBackoffBaseMs: 25, log: (line) => logs.push(line) });
  cleanup.push(() => server.stop());
  const embedded = new OxigraphStore();
  const http = new SparqlHttpStore({ queryEndpoint: server.queryEndpoint, updateEndpoint: server.updateEndpoint, timeout: 10_000 });
  const stores: Array<[string, TripleStore]> = [['embedded', embedded], ['native-oxigraph-http', http]];
  const blazegraphUrl = process.env.BLAZEGRAPH_TEST_URL;
  if (process.env.DKG_REQUIRE_BLAZEGRAPH === '1' && !blazegraphUrl) throw new Error('Blazegraph required but BLAZEGRAPH_TEST_URL is missing');
  if (blazegraphUrl) stores.push(['blazegraph', new BlazegraphStore(blazegraphUrl)]);
  cleanup.push(async () => { for (const [, store] of stores) await store.close(); });
  const graph = `urn:dkg:conformance:${randomUUID()}`;
  const privateGraph = `${graph}:private`;
  const quads: Quad[] = [
    { graph, subject: 'urn:one', predicate: 'urn:value', object: '"line\\nquote\\\" and Ω"' },
    { graph, subject: 'urn:two', predicate: 'urn:value', object: '"bonjour"@fr' },
    { graph: privateGraph, subject: 'urn:secret', predicate: 'urn:value', object: '"protected"' },
  ];
  let expected: Awaited<ReturnType<typeof values>> | undefined;
  for (const [name, store] of stores) {
    await store.insert(quads);
    const actual = await values(store, graph);
    assert.equal(actual.length, 2, name);
    assert.ok(actual.every((row) => row.s !== 'urn:secret'), `${name}: private graph leaked`);
    if (expected) assert.deepEqual(actual, expected, name); else expected = actual;
    assert.equal(await store.deleteByPattern({ graph, subject: 'urn:one' }), 1, name);
    assert.equal((await values(store, graph)).length, 1, name);
    assert.equal((await values(store, privateGraph)).length, 1, name);
    await assert.rejects(() => store.query('SELECT WHERE { invalid syntax'), `${name}: malformed query reported success`);
  }

  // Persist the transaction identity before the store process dies. The
  // restarted publisher must recover that exact identity, never a fresh claim.
  let clock = 1_000;
  const config = { now: () => ++clock, idGenerator: () => 'crash-job' };
  let publisher = new TripleStoreAsyncLiftPublisher(http, config);
  const id = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
  await publisher.claimNext('wallet-1');
  await publisher.update(id, 'validated', { validation: KA_VM_VALIDATION });
  await publisher.update(id, 'broadcast', { broadcast: KA_VM_BROADCAST_TX });
  const before = await publisher.getStatus(id);
  const generation = server.getRecoveryState().generation;
  assert.equal(server.requestRestart('conformance: SIGKILL after acknowledged broadcast persistence'), true);
  const deadline = Date.now() + 20_000;
  while (server.getRecoveryState().generation <= generation || server.getRecoveryState().recovering) {
    if (Date.now() >= deadline) throw new Error(`store did not recover within 20s:\n${logs.join('\n')}`);
    await new Promise((done) => setTimeout(done, 25));
  }
  publisher = new TripleStoreAsyncLiftPublisher(http, config);
  assert.deepEqual(await publisher.getStatus(id), before);
  assert.equal(await publisher.claimNext('wallet-2'), null, 'broadcast job became claimable after restart');
  assert.equal((await values(http, graph)).length, 1);
  assert.equal((await values(http, privateGraph)).length, 1);

  for (const [, store] of stores) {
    await store.deleteByPattern({ graph }); await store.deleteByPattern({ graph: privateGraph });
  }
  await mkdir('test-systems/.runtime', { recursive: true });
  await writeFile('test-systems/.runtime/storage-conformance.json', JSON.stringify({
    revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    workingTreeDirty: execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8' }).trim().length > 0,
    scenarioHash: createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex'),
    binaryVersion: binary.version, backends: stores.map(([name]) => name),
    fault: 'SIGKILL after acknowledged broadcast persistence', jobId: id,
    transactionHash: KA_VM_BROADCAST_TX.txHash, recoveredGeneration: server.getRecoveryState().generation,
    verdict: 'pass', logs,
  }, null, 2));
});
