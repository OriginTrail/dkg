// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFile, readFile, unlink } from 'node:fs/promises';
import { OxigraphWorkerStore, GraphSetIndexStore, ChangelogStore } from '../../../storage/dist/index.js';
import { mutatePublishedNamedKaVmLifecycle } from '../../dist/named-ka-vm-lifecycle.js';
import { NamedKaVmLifecycleRepair } from '../../dist/named-ka-vm-lifecycle-repair.js';
const input = JSON.parse(process.argv[2]); input.packedKaId = BigInt(input.packedKaId);
const path = process.env.DKG_TEST_SNAPSHOT_PATH;
const worker = new OxigraphWorkerStore(path);
let arm = false, enter, release;
const entered = new Promise(resolve => { enter = resolve; });
const held = new Promise(resolve => { release = resolve; });
const store = new ChangelogStore(new GraphSetIndexStore(worker), { eraGuard: {
  load: async () => null,
  save: async () => { if (arm) { arm = false; enter(); await held; } },
} });
let now = 1000;
const repair = new NamedKaVmLifecycleRepair({ dataDir: process.env.DKG_TEST_REPAIR_DIR,
  writeLocks: new Map(), now: () => now, isCurrent: async () => true, warn: () => {},
  apply: async value => { const barrier = store.commitment.capture(); await mutatePublishedNamedKaVmLifecycle(store, value); await barrier(); },
});
const query = 'ASK { GRAPH ?g { ?s <http://dkg.io/ontology/publishedUal> ' + JSON.stringify(input.publishedUal) + ' } }';
const journal = async () => JSON.parse(await readFile(join(process.env.DKG_TEST_REPAIR_DIR, 'named-ka-vm-lifecycle-repairs.json'), 'utf8')).entries;
let reopened;
try {
  const baselineBarrier = store.commitment.capture();
  await store.insert([{subject:'urn:baseline',predicate:'urn:value',object:'"keep"',graph:'urn:baseline'}]);
  await baselineBarrier();
  const firstBarrier = store.commitment.capture();
  const secondBarrier = store.commitment.capture();
  await writeFile(process.env.DKG_TEST_SNAPSHOT_FAULT, 'hold snapshot'); arm = true;
  const attempt = repair.submit(input);
  await entered;
  assert.equal((await worker.query(query)).value, true, 'worker acknowledged lifecycle metadata');
  await worker.worker.terminate();
  assert.equal((await worker.query(query)).value, false, 'replacement really lost the uncommitted metadata');
  await unlink(process.env.DKG_TEST_SNAPSHOT_FAULT);
  release();
  assert.equal(await attempt, 'pending');
  assert.equal((await journal()).length, 1);
  await assert.rejects(firstBarrier(), { code: 'OXIGRAPH_WORKER_COMMIT_OWNER_CHANGED' });
  // A fresh mutation cannot repair the stale certificate of a different owner.
  await store.insert([{subject:'urn:other',predicate:'urn:value',object:'"new"',graph:'urn:other'}]);
  now += 5000; await repair.runDue();
  assert.equal((await journal()).length, 0);
  assert.equal((await worker.query(query)).value, true);
  await assert.rejects(secondBarrier(), { code: 'OXIGRAPH_WORKER_COMMIT_OWNER_CHANGED' });
  // Reopen before close can flush anything: only the fresh attempt's captured
  // barrier may justify retiring the durable journal.
  reopened = new OxigraphWorkerStore(path);
  assert.equal((await reopened.query(query)).value, true);
  assert.equal(await reopened.countQuads('urn:baseline'), 1);
  console.log(JSON.stringify({ acknowledgedThenLost: true, retainedUntilReapplied: true,
    durableReopen: true, staleBarriersRejected: 2 }));
} finally { release(); await unlink(process.env.DKG_TEST_SNAPSHOT_FAULT).catch(() => {}); await repair.stop(); await reopened?.close(); await store.close(); }
