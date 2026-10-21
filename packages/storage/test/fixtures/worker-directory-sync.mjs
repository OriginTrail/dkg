// SPDX-License-Identifier: Apache-2.0
import { OxigraphWorkerStore } from '../../dist/adapters/oxigraph-worker.js';
import { unlink } from 'node:fs/promises';
const path = process.env.DKG_TEST_SNAPSHOT_PATH;
const store = new OxigraphWorkerStore(path);
let failure;
try {
  const commit = store.commitment.capture();
  await store.insert([{subject:'urn:worker:s',predicate:'urn:worker:p',object:'"value"',graph:'urn:worker:g'}]);
  try { await commit(); } catch (error) { failure = { code:error.code, message:error.message }; }
  await unlink(process.env.DKG_TEST_DIRECTORY_FAULT);
  await commit();
} finally { await store.close(); }
const reopened = new OxigraphWorkerStore(path);
try { console.log(JSON.stringify({ failure, reopened:await reopened.countQuads() })); }
finally { await reopened.close(); }
