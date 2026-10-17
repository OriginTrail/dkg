/** Disposable local Blazegraph campaign: kill the client after legacy partial clear, then restart. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BlazegraphNamespaceManager, BlazegraphStore, blazegraphNamespaceApiUrlFromSparqlEndpoint,
} from '../../packages/storage/dist/index.js';
import {
  RECOVERY_CG as CG, RECOVERY_NAME as NAME, RECOVERY_AUTHOR as AUTHOR,
  recoveryPublisher, seedRecoveryAsset, seedInterruptedSealClear,
} from '../../packages/publisher/test/_helpers/pull-recovery.js';

const endpoint = process.env.BLAZEGRAPH_TEST_URL;
if (!endpoint) throw new Error('Set BLAZEGRAPH_TEST_URL to a local devnet Blazegraph endpoint');
const url = new URL(endpoint);
assert(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'This crash campaign requires a loopback devnet');
const content = (quads: { subject: string; predicate: string; object: string }[]) =>
  quads.map(q => JSON.stringify([q.subject, q.predicate, q.object])).sort();
const phase = process.argv[2];
if (phase === 'seed' || phase === 'recover') {
  const marker = process.argv[3]!;
  const store = new BlazegraphStore(endpoint, { timeout: 10_000 });
  if (phase === 'seed') {
    const { finalized } = await seedRecoveryAsset(store);
    await seedInterruptedSealClear(store, 4);
    await writeFile(marker, JSON.stringify({ pid: process.pid, stage: 'four-predicate-clear',
      public: content(finalized.publicQuads), private: content(finalized.privateQuads) }));
    process.kill(process.pid, 'SIGKILL');
    await new Promise(() => {});
  } else {
    const expected = JSON.parse(await readFile(marker, 'utf8'));
    const publisher = await recoveryPublisher(store);
    const result = await publisher.assertionPullFrom(CG, NAME, AUTHOR, 'swm');
    assert.equal(result.seeded, 2);
    assert.deepEqual(content(await publisher.assertionQuery(CG, NAME, AUTHOR)), expected.public);
    assert.deepEqual(content(await publisher.assertionQueryPrivate(CG, NAME, AUTHOR)), expected.private);
    await store.close();
    console.log(JSON.stringify({ stage: 'fresh-process-recovery', pid: process.pid, seeded: result.seeded }));
  }
} else {
  assert.equal(phase, undefined, 'No positional arguments are needed');
  const manager = new BlazegraphNamespaceManager({
    namespaceApiUrl: blazegraphNamespaceApiUrlFromSparqlEndpoint(endpoint), requestTimeoutMs: 10_000,
  });
  const handles = await manager.acquireMany([`pull-crash-${randomUUID()}`]);
  const root = await mkdtemp(join(tmpdir(), 'dkg-pull-recovery-'));
  const marker = join(root, 'boundary.json');
  const script = fileURLToPath(import.meta.url);
  const run = (childPhase: string) => spawnSync(process.execPath, ['--import', 'tsx', script, childPhase, marker], {
    env: { ...process.env, BLAZEGRAPH_TEST_URL: handles[0]!.sparqlUrl },
    encoding: 'utf8', timeout: 60_000, maxBuffer: 2 * 1024 * 1024,
  });
  try {
    const seeded = run('seed');
    assert.equal(seeded.signal, 'SIGKILL', `Seed must reach its deliberate crash: ${seeded.stderr}`);
    const proof = JSON.parse(await readFile(marker, 'utf8'));
    assert.equal(proof.stage, 'four-predicate-clear');
    assert.throws(() => process.kill(proof.pid, 0), { code: 'ESRCH' });
    console.log(JSON.stringify({ stage: proof.stage, killedPid: proof.pid, signal: seeded.signal }));
    const recovered = run('recover');
    assert.equal(recovered.status, 0, `Fresh-process recovery failed: ${recovered.stderr}`);
    console.log(recovered.stdout.trim());
  } finally {
    await manager.disposeAll(handles);
    await rm(root, { recursive: true, force: true });
  }
}
