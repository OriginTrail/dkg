// Native engine/process fault probes, installed only by the test's Worker constructor.
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { parentPort, workerData } from 'node:worker_threads';
const signal = workerData.signal ? new Int32Array(workerData.signal) : undefined;
const nativePost = parentPort.postMessage.bind(parentPort), nativeOn = parentPort.on.bind(parentPort);
const ids = new Set(); let seenWrite = false, commits = 0, capped = false;
let handler, collected = false; const delivery = [];
nativeOn('message', request => {
  if (request.operation === 'write') { seenWrite = true; ids.add(request.id); }
  if (workerData.fault.startsWith('collect')) {
    delivery.push(request);
    if (delivery.length === 8 || collected) {
      collected = true;
      for (const item of delivery.splice(0)) handler(item);
    }
  }
});
if (workerData.fault.startsWith('collect')) parentPort.on = function(event, callback) {
  if (event === 'message') { handler = callback; return this; }
  return nativeOn(event, callback);
};
const exec = DatabaseSync.prototype.exec;
let downgraded = false, resubmitBlocked = false;
DatabaseSync.prototype.exec = function(sql) {
  if (seenWrite && sql === 'BEGIN IMMEDIATE' && workerData.fault.endsWith('full') && !capped) {
    capped = true; exec.call(this, 'PRAGMA max_page_count=8');
  }
  if (seenWrite && sql === 'COMMIT') {
    if (workerData.fault.endsWith('before-commit')) process.exit(71);
    if (workerData.fault.endsWith('hold')) {
      commits += 1; Atomics.store(signal, 0, commits); Atomics.notify(signal, 0);
      while (Atomics.load(signal, 1) < commits) Atomics.wait(signal, 1, Atomics.load(signal, 1));
    }
  }
  const result = exec.call(this, sql);
  if (sql.includes('PRAGMA journal_mode=WAL;')) {
    const downgrades = { journal_mode: 'PRAGMA journal_mode=DELETE', synchronous: 'PRAGMA synchronous=NORMAL',
      fullfsync: 'PRAGMA fullfsync=OFF', checkpoint_fullfsync: 'PRAGMA checkpoint_fullfsync=OFF' };
    const key = workerData.fault.startsWith('policy-downgrade:') ? workerData.fault.split(':')[1] : undefined;
    if (key && !downgraded) { downgraded = true; exec.call(this, downgrades[key]); }
    const values = Object.fromEntries(Object.keys(downgrades).map(name => [name, this.prepare(`PRAGMA ${name}`).get()[name]]));
    nativePost({ diagnostic: 'policy', values });
  }
  if (seenWrite && sql === 'COMMIT') nativePost({ diagnostic: 'commit' });
  return result;
};
parentPort.postMessage = function(message, ...args) {
  if (workerData.fault === 'after-commit' && ids.has(message.id) && !message.error) process.exit(72);
  return nativePost(message, ...args);
};
const prepare = DatabaseSync.prototype.prepare;
DatabaseSync.prototype.prepare = function(sql) {
    const statement = prepare.call(this, sql), get = statement.get.bind(statement);
    if (workerData.fault === 'allocation' || workerData.fault === 'hold-read') statement.get = (...args) => {
      if (workerData.fault === 'hold-read' && sql.startsWith('SELECT typeof(term)')) {
        Atomics.store(signal, 0, 1); Atomics.notify(signal, 0);
        while (Atomics.load(signal, 1) === 0) Atomics.wait(signal, 1, 0);
      }
      const result = get(...args);
      nativePost({ diagnostic: 'allocation', bytes: process.memoryUsage().arrayBuffers });
      return result;
    };
    if (sql.startsWith('INSERT OR REPLACE INTO blobs')) {
      const run = statement.run.bind(statement), db = this;
      statement.run = (...args) => {
        const bytes = args[1];
        nativePost({ diagnostic: 'write', hash: args[0], bytes: bytes.byteLength,
          payloadHash: createHash('sha256').update(bytes).digest('hex') });
        if (workerData.fault === 'resubmit-readonly' && !resubmitBlocked) {
          resubmitBlocked = true; exec.call(db, 'PRAGMA query_only=ON');
        }
        return run(...args);
      };
    }
    return statement;
};
await import('../../dist/sqlite-literal-blob-worker.js');
