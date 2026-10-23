// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { OxigraphWorkerStore } from '../../dist/adapters/oxigraph-worker.js';
const path = process.env.DKG_TEST_SNAPSHOT_PATH;
const store = new OxigraphWorkerStore(path); let reopened;
try {
  const commit = store.commitment.capture();
  await store.insert([{subject:'urn:worker:windows',predicate:'urn:worker:p',object:'"persisted"',graph:'urn:worker:g'}]);
  await commit();
  assert.match(await readFile(path, 'utf8'), /urn:worker:windows/);
  const trace = (await readFile(process.env.DKG_TEST_OPEN_TRACE, 'utf8')).trim().split('\n').map(JSON.parse);
  reopened = new OxigraphWorkerStore(path);
  console.log(JSON.stringify({ reopened:await reopened.countQuads(), traceBeforeCleanup: trace }));
} finally { await reopened?.close(); await store.close(); }
