/** Generated-data benchmark: no daemon, network, real wallet or existing database. */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { ethers } from 'ethers';
import * as core from '@origintrail-official/dkg-core';
import { CandidateInventoryV1 } from '../dist/rfc64/inventory-v1/candidate.js';
import { INVENTORY_V1_DDL } from '../dist/rfc64/inventory-v1/sql.js';
import {
  maintainRfc64SwmAuthorInventoryV1,
  removeRfc64SwmAuthorInventoryRowV1,
} from '../dist/rfc64/swm-author-inventory-producer-v1.js';

const count = Number(process.argv[2] ?? 5846);
assert(Number.isSafeInteger(count) && count > 0 && count <= 10_000);
assert(process.argv[3] === undefined || process.argv[3] === 'file');
const directory = process.argv[3] === 'file' ? mkdtempSync(join(tmpdir(), 'dkg-inventory-bench-')) : null;
const databasePath = directory ? join(directory, 'generated.sqlite') : ':memory:';
if (directory) assert(!existsSync(databasePath));
const wallet = new ethers.Wallet(`0x${'33'.repeat(32)}`); // Public deterministic test identity; no network calls.
const author = wallet.address.toLowerCase();
const scope = {
  networkId: 'otp:20430', contextGraphId: 'generated-inventory-benchmark',
  governanceChainId: '20430', governanceContractAddress: `0x${'22'.repeat(20)}`,
  ownershipTransitionDigest: null, subGraphName: null, authorAddress: author, era: '0',
};
const scopeDigest = core.computeSwmAuthorInventoryScopeDigestV1(scope);
const signer = { issuer: author, signDigest: digest => wallet.signMessage(digest) };
function row(n) {
  return {
    assertionCoordinate: `draft-${n}`, assertionVersion: '1',
    kaUal: `did:dkg:otp:20430/${author}/${n}`, shareOperationId: `share-${n}`,
    projectionDigest: `0x${'11'.repeat(32)}`, publicTripleCount: '17', privateTripleCount: '0',
    sealDigest: `0x${'22'.repeat(32)}`, sharedAt: '1700000000000', expiresAt: null,
  };
}
function seedSnapshot(rows) {
  const unsigned = {
    issuer: author, objectType: core.SWM_AUTHOR_INVENTORY_HEAD_OBJECT_TYPE_V1,
    payload: { ...scope, version: '0', previousHeadDigest: null, totalRows: String(rows.length),
      rowsDigest: core.computeSwmAuthorInventoryRowsDigestV1(rows), issuedAt: '1700000000200' },
    signatureEvidence: { kind: 'none' }, signatureSuite: 'eip191-personal-sign-digest-v1',
  };
  const objectDigest = core.computeSwmAuthorInventoryHeadObjectDigestV1(unsigned);
  return { head: { ...unsigned, objectDigest,
    signature: wallet.signMessageSync(ethers.getBytes(objectDigest)).toLowerCase() }, rows };
}
const measurements = [];
async function timed(operation, fn) {
  await new Promise(resolve => setImmediate(resolve));
  const start = performance.now();
  const cpu = process.cpuUsage();
  let timerDelayMs;
  const timer = new Promise(resolve => setTimeout(() => {
    timerDelayMs = performance.now() - start; resolve();
  }, 0));
  const result = await fn();
  const wallMs = performance.now() - start;
  const used = process.cpuUsage(cpu);
  await timer;
  measurements.push({ operation, wallMs, timerDelayMs, cpuMs: (used.user + used.system) / 1000 });
  return result;
}
let db = new DatabaseSync(databasePath);
let inventory;
try {
  db.exec(`PRAGMA foreign_keys=ON;${INVENTORY_V1_DDL}`);
  inventory = new CandidateInventoryV1(db);
  const rows = Array.from({ length: count }, (_, index) => row(index + 1));
  const seed = seedSnapshot(rows);
  const input = { snapshot: seed, mergeRows: rows, expectedCurrentHeadDigest: null };
  assert.equal((await timed('seed', () => inventory.compareAndSwapMergeSwmAuthorInventoryV1(input))).status, 'applied');
  for (let i = 0; i < 3; i++) {
    assert.equal((await timed('read', () => inventory.readSwmAuthorInventorySnapshotV1(scopeDigest, author))).rows.length, count);
  }
  const added = row(count + 1);
  const update = { scope, row: added, issuedAt: '1700000000300', signer };
  const result = await timed('upsert', () => maintainRfc64SwmAuthorInventoryV1(inventory, update));
  assert.equal(result.status, 'applied');
  assert.equal(result.snapshot.rows.length, count + 1);
  core.assertSwmAuthorInventorySnapshotBindingV1(result.snapshot);
  const committedHead = result.snapshot.head.objectDigest;
  assert.equal((await maintainRfc64SwmAuthorInventoryV1(inventory, update)).status, 'existing');
  assert.throws(() => inventory.compareAndSwapMergeSwmAuthorInventoryV1(input), /conflict/);
  assert.equal(inventory.readSwmAuthorInventorySnapshotV1(scopeDigest, author).head.objectDigest, committedHead);
  if (directory) {
    inventory.close(); inventory = undefined;
    db = new DatabaseSync(databasePath);
    inventory = new CandidateInventoryV1(db);
    const reopened = inventory.readSwmAuthorInventorySnapshotV1(scopeDigest, author);
    assert.equal(reopened.head.objectDigest, committedHead);
    assert.equal(reopened.rows.length, count + 1);
  }
  const removal = await timed('remove', () => removeRfc64SwmAuthorInventoryRowV1(inventory, {
    scope, expectedRow: added, issuedAt: '1700000000400', signer,
  }));
  assert.equal(removal.status, 'applied');
  assert.equal(removal.snapshot.rows.length, count);
  assert.equal(removal.snapshot.head.payload.rowsDigest, seed.head.payload.rowsDigest);
  // A prior successful read must never hide subsequently corrupted persisted data.
  db.exec('UPDATE rfc64_swm_author_inventory_rows_v1 SET projection_digest = zeroblob(32)');
  assert.throws(() => inventory.readSwmAuthorInventorySnapshotV1(scopeDigest, author), /corrupt|canonical/);
  console.log(JSON.stringify({ rows: count, node: process.version, store: directory ? 'file/reopen' : 'memory',
    measurements, committedHead, finalHead: removal.snapshot.head.objectDigest,
    finalRowsDigest: removal.snapshot.head.payload.rowsDigest,
    checks: ['signed-upsert', 'exact-noop', 'stale-CAS-rejected', 'exact-removal', 'fresh-corruption-rejected',
      ...(directory ? ['close-reopen'] : [])] }));
} finally {
  if (inventory) inventory.close();
  else { try { db.close(); } catch { /* already closed */ } }
  if (directory) rmSync(directory, { recursive: true });
}
