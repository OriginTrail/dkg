// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
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
  assert.equal(await store.countQuads(), 1); // Wait for replacement; the new sentinel is not yet on disk.
  const replacementCommit = store.commitment.capture();
  await store.insert([{subject:'urn:worker:replacement',predicate:'urn:worker:p',object:'"fresh"',graph:'urn:worker:g'}]);
  try { await replacementCommit(); } catch (error) { replacementFailure = { code:error.code, message:error.message }; }
  await unlink(process.env.DKG_TEST_DIRECTORY_FAULT);
  await replacementCommit();
  reopened = new OxigraphWorkerStore(path);
  assert.equal((await reopened.query('ASK { GRAPH <urn:worker:g> { <urn:worker:replacement> <urn:worker:p> "fresh" } }')).value, true);
  console.log(JSON.stringify({ failure, replacementFailure, reopened:await reopened.countQuads() }));
} finally { await reopened?.close(); await store.close(); }
