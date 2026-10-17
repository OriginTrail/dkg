/**
 * Real libp2p native-receiver crash campaign. Build workspace agent dependencies,
 * then run: node --experimental-sqlite --import tsx scripts/repro/rfc64-catalog-durable-head.mts
 * Uses one disposable Vitest worker per boundary; SIGKILL never closes its stores.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OxigraphStore } from '../../packages/storage/dist/index.js';
import { openRfc64PersistenceV1 } from '../../packages/agent/src/rfc64/persistence-v1.js';

const repo = fileURLToPath(new URL('../../', import.meta.url));
// sparql-scan-allow: R2 -- Only the private, freshly-created 17-quad crash fixture is read; never an operator store.
const query = 'SELECT ?s ?p ?o ?g WHERE { GRAPH ?g { ?s ?p ?o } } ORDER BY ?g ?s ?p ?o';
const allStages = ['before-flush', 'before-cas', 'after-cas'] as const;
const selectedStage = process.argv[2];
assert.ok(selectedStage === undefined || allStages.some((stage) => stage === selectedStage),
  'optional argument must be before-flush, before-cas or after-cas');
const stages = allStages.filter((stage) => selectedStage === undefined || stage === selectedStage);
const testName = 'persists exact SWM and VM before applied-head CAS through a store decorator';

async function run(env: NodeJS.ProcessEnv): Promise<{ code: number | null; output: string }> {
  const child = spawn(process.execPath, [
    resolve(repo, 'node_modules/vitest/vitest.mjs'), 'run', '--config', 'vitest.unit.config.ts',
    'test/rfc64-public-catalog-native-gate1.integration.test.ts', '-t', testName,
    '--maxWorkers=1', '--no-file-parallelism',
  ], { cwd: resolve(repo, 'packages/agent'), env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
  let output = '';
  const capture = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-100_000); };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  const timer = setTimeout(() => {
    if (process.platform !== 'win32' && child.pid !== undefined) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    } else child.kill('SIGKILL');
  }, 90_000);
  try {
    return await new Promise((resolveExit, reject) => {
      child.once('error', reject);
      child.once('close', (code) => resolveExit({ code, output }));
    });
  } finally { clearTimeout(timer); }
}

for (const stage of stages) {
  const root = await mkdtemp(join(tmpdir(), 'dkg-catalog-durability-'));
  try {
    const killed = await run({ DKG_CATALOG_DURABILITY_ROOT: root, DKG_CATALOG_DURABILITY_CRASH: stage,
      DKG_CATALOG_DURABILITY_RESTART: '' });
    assert.notEqual(killed.code, 0, 'crash worker unexpectedly completed normally');
    const evidence = JSON.parse(await readFile(join(root, 'boundary.json'), 'utf8'));
    assert.ok(resolve(evidence.receiverDirectory).startsWith(`${resolve(root)}/`));
    assert.ok(resolve(evidence.snapshot).startsWith(`${resolve(root)}/`));
    assert.equal(evidence.stage, stage);
    assert.equal(evidence.signal, 'SIGKILL');
    assert.ok(evidence.backgroundWritesHeld > 0, 'debounced persistence fault was never reached');
    assert.throws(() => process.kill(evidence.pid, 0), { code: 'ESRCH' });
    const persistence = await openRfc64PersistenceV1(evidence.receiverDirectory,
      { yieldAfterPurgeBatch: async () => {} });
    const store = new OxigraphStore(evidence.snapshot);
    try {
      const head = persistence.inventory.readAppliedCatalogHeadV1(evidence.scopeDigest, evidence.author);
      assert.equal(head?.currentCatalogHeadDigest, stage === 'after-cas' ? evidence.target : evidence.predecessor);
      assert.deepEqual(await store.query(query), stage === 'before-flush'
        ? evidence.predecessorState : evidence.targetState,
      `${stage}: durable RDF differs from the required commit boundary`);
    } finally { await persistence.close(); }
    // Restart real peers and reannounce the exact same signed catalog. No
    // test-only flush or repair is inserted before the restart assertions.
    const restarted = await run({ DKG_CATALOG_DURABILITY_ROOT: root,
      DKG_CATALOG_DURABILITY_CRASH: '', DKG_CATALOG_DURABILITY_RESTART: evidence.receiverDirectory });
    assert.equal(restarted.code, 0, restarted.output);
    process.stdout.write(`${JSON.stringify({ stage, status: 'PASS', backgroundWritesHeld: evidence.backgroundWritesHeld,
      killedPid: evidence.pid, restart: 'exact catalog applied with 17 durable SWM/seal/VM quads' })}\n`);
  } finally { await rm(root, { recursive: true, force: true }); }
}
