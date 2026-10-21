// SPDX-License-Identifier: Apache-2.0
import { OxigraphWorkerStore } from '../../dist/adapters/oxigraph-worker.js';
import { unlink } from 'node:fs/promises';
const path = process.env.DKG_TEST_SNAPSHOT_PATH;
const store = new OxigraphWorkerStore(path);
let failure, replacementFailure, reopened;
try {
  const commit = store.commitment.capture();
  await store.insert([{subject:'urn:worker:s',predicate:'urn:worker:p',object:'"value"',graph:'urn:worker:g'}]);
  try { await commit(); } catch (error) { failure = { code:error.code, message:error.message }; }
  await store.worker.terminate();
  await store.countQuads(); // Wait for the replacement worker to adopt the existing path.
  const replacementCommit = store.commitment.capture();
  await store.insert([{subject:'urn:worker:s',predicate:'urn:worker:p',object:'"value"',graph:'urn:worker:g'}]);
  try { await replacementCommit(); } catch (error) { replacementFailure = { code:error.code, message:error.message }; }
  await unlink(process.env.DKG_TEST_DIRECTORY_FAULT);
  await replacementCommit();
  reopened = new OxigraphWorkerStore(path);
  console.log(JSON.stringify({ failure, replacementFailure, reopened:await reopened.countQuads() }));
} finally { await reopened?.close(); await store.close(); }
