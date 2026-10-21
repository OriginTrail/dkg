// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { writeFile, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { OxigraphWorkerStore } from '../../../storage/dist/index.js';
import { NamedKaVmLifecycleRepair } from '../../dist/named-ka-vm-lifecycle-repair.js';
import { confirmedLifecycleExecutionCapabilities } from '../../dist/named-ka-vm-lifecycle-executor.js';
const input = JSON.parse(process.argv[2]); input.packedKaId = BigInt(input.packedKaId);
const path = process.env.DKG_TEST_SNAPSHOT_PATH, dataDir = process.env.DKG_TEST_REPAIR_DIR, flag = process.env.DKG_TEST_SNAPSHOT_FAULT;
const graph = input.materialization.metadataQuads.find(q => q.predicate === 'http://dkg.io/ontology/assertionGraph').object;
const chain = { getEvmChainId: async () => BigInt(input.publicationDeployment.chainId),
  getKnowledgeAssetsLifecycleAddress: async () => input.publicationDeployment.lifecycleAddress,
  readKnowledgeAssetVersionSnapshot: async () => ({ rootCount: BigInt(input.assertionVersion), latestRoot: input.merkleRoot }) };
const store = new OxigraphWorkerStore(path); let now = 1000, reopened, second;
const owner = () => new NamedKaVmLifecycleRepair({ dataDir, now: () => now, warn: () => {},
  ...confirmedLifecycleExecutionCapabilities({ store, chain, writeLocks: new Map(), dataDir, readTimeoutMs: 1000 }) });
const first = owner();
const entries = async () => JSON.parse(await readFile(join(dataDir, 'named-ka-vm-lifecycle-repairs.json'), 'utf8')).entries;
const published = `ASK { GRAPH ?g { ?s <http://dkg.io/ontology/publishedUal> ${JSON.stringify(input.publishedUal)} } }`;
try {
  const baseline = store.commitment.capture();
  await store.insert([{ subject: 'urn:unrelated', predicate: 'urn:value', object: '"keep"', graph: 'urn:unrelated' }]); await baseline();
  await writeFile(flag, 'block graph-store snapshots only');
  await store.insert([...input.materialization.metadataQuads, ...input.materialization.publicQuads.map(q => ({ ...q, graph }))]);
  assert.equal(await store.countQuads(graph), 1);
  assert.equal(await first.submit(input), 'pending'); assert.equal((await entries()).length, 1);
  await store.worker.terminate(); await unlink(flag); await first.stop();
  assert.equal(await store.countQuads(graph), 0, 'real replacement worker lost acknowledged payload');
  assert.equal((await store.query(published)).value, false);
  second = owner(); now = 6000; await second.runDue();
  assert.equal((await entries()).length, 0);
  // A separate worker reopens the disk snapshot BEFORE either owner's close can flush it.
  reopened = new OxigraphWorkerStore(path);
  assert.equal((await reopened.query(published)).value, true);
  assert.equal(await reopened.countQuads(graph), 1);
  const result = await reopened.query(`CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${graph}> { ?s ?p ?o } }`);
  assert.deepEqual(result.quads, input.materialization.publicQuads);
  assert.equal(await reopened.countQuads('urn:unrelated'), 1);
  console.log(JSON.stringify({ recoveredOriginalPayload: true, durableBeforeClose: true, unrelatedPreserved: true }));
} finally { await unlink(flag).catch(() => {}); await first.stop(); await second?.stop(); await reopened?.close(); await store.close(); }
