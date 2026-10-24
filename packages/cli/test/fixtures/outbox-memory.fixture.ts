import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { DashboardDB, SqliteProtocolOutboxStore } from '@origintrail-official/dkg-node-ui';
import { OutboxDrainer } from '@origintrail-official/dkg-agent/dist/p2p/outbox-drainer.js';

if (!global.gc) throw new Error('Run the outbox memory fixture with --expose-gc');
const collect = global.gc;
const dir = mkdtempSync(join(tmpdir(), 'dkg-outbox-working-set-'));
const dashboard = new DashboardDB({ dataDir: dir });
const store = new SqliteProtocolOutboxStore(dashboard, { backoffFor: () => 10, maxAgeMs: 5_000 });
const rows = 512;
const rowBytes = 256 * 1024;
const oversizedBytes = 16 * 1024 * 1024;
const budget = 4 * 1024 * 1024;
let release = () => {};
let gate = Promise.resolve();
const drainer = new OutboxDrainer(
  (now, bounds) => store.readDuePage(now, bounds),
  async entry => {
    await gate;
    assert(store.recordRetryFailure(entry.peer, entry.protocol, entry.messageId, 'still offline', 1_000));
  },
  { batchSize: 100, concurrency: 4, maxPayloadBytes: budget },
);

try {
  const insert = dashboard.db.prepare(`INSERT INTO protocol_outbox
    (peer_id, protocol, message_id, payload, attempts, first_failure_at, last_attempt_at, next_attempt_at, last_error)
    VALUES ('peer', '/test', ?, zeroblob(?), 1, 0, 0, 10, 'offline')`);
  dashboard.db.transaction(() => {
    insert.run('0000-oversized', oversizedBytes);
    for (let i = 0; i < rows; i++) insert.run(`small-${String(i).padStart(4, '0')}`, rowBytes);
  })();
  collect();
  const before = process.memoryUsage();
  let peakArrayBuffers = before.arrayBuffers;
  let peakRss = before.rss;
  let peakClaimedBytes = 0;
  const sample = () => {
    const memory = process.memoryUsage();
    peakArrayBuffers = Math.max(peakArrayBuffers, memory.arrayBuffers);
    peakRss = Math.max(peakRss, memory.rss);
  };
  for (let pass = 0; pass < rows / (budget / rowBytes); pass++) {
    gate = new Promise<void>(resolve => { release = resolve; });
    const tick = drainer.tick(1_000);
    await setImmediate();
    const stats = drainer.getStats();
    assert.equal(stats.claimedEntries, 16);
    assert.equal(stats.claimedBytes, budget);
    peakClaimedBytes = Math.max(peakClaimedBytes, stats.claimedBytes);
    sample();
    // These reads must not turn the persisted 144 MiB backlog into JS buffers.
    const metadata = store.listMetadata();
    assert.equal(metadata.length, rows + 1);
    assert(metadata.every(entry => !Object.hasOwn(entry, 'payload')));
    assert.equal(store.queueStats(1_000, budget).queuedBytes, rows * rowBytes + oversizedBytes);
    sample();
    release();
    await tick;
    // Include retry bookkeeping's allocations before forcing collection.
    sample();
    assert.equal(drainer.getStats().claimedBytes, 0);
    collect();
  }
  const metadata = store.listMetadata();
  assert.equal(metadata.filter(entry => entry.attempts === 2).length, rows);
  assert.equal(metadata.find(entry => entry.messageId === '0000-oversized')?.attempts, 1);
  assert.equal(store.queueStats(1_000, budget).oversizedDueEntries, 1);
  collect();
  const beforeExpiry = process.memoryUsage().arrayBuffers;
  const expired = store.dropExpiredMetadata(6_000);
  sample();
  const expiryArrayBufferDelta = process.memoryUsage().arrayBuffers - beforeExpiry;
  assert.equal(expired.length, rows + 1);
  assert(expired.every(entry => !Object.hasOwn(entry, 'payload')));
  assert.equal(store.size(), 0);
  const result = {
    rows, rowBytes, persistedBytes: rows * rowBytes + oversizedBytes, budget,
    peakClaimedBytes, arrayBufferDelta: peakArrayBuffers - before.arrayBuffers,
    rssDelta: peakRss - before.rss, expiryArrayBufferDelta,
    skippedOversizedEntriesTotal: drainer.getStats().skippedOversizedEntriesTotal,
  };
  console.log('OUTBOX_MEMORY_RESULT ' + JSON.stringify(result));
  assert(result.arrayBufferDelta <= budget + 512 * 1024, 'Payload working set exceeded one admitted page');
  assert(result.rssDelta <= 64 * 1024 * 1024, 'SQLite retry/metadata working set grew with persisted payloads');
  assert(result.expiryArrayBufferDelta < 512 * 1024, 'Expiry materialized payloads');
} finally {
  release();
  await drainer.stop();
  dashboard.close();
  rmSync(dir, { recursive: true, force: true });
}
