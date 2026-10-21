// SPDX-License-Identifier: Apache-2.0
import { OxigraphWorkerStore } from '../../dist/adapters/oxigraph-worker.js';
const store = new OxigraphWorkerStore(process.env.DKG_TEST_SNAPSHOT_PATH);
try {
  const commit = store.commitment.capture();
  await store.insert([{subject:'urn:worker:windows',predicate:'urn:worker:p',object:'"persisted"',graph:'urn:worker:g'}]);
  await commit();
} finally { await store.close(); }
const reopened = new OxigraphWorkerStore(process.env.DKG_TEST_SNAPSHOT_PATH);
try { console.log(JSON.stringify({ reopened:await reopened.countQuads() })); }
finally { await reopened.close(); }
