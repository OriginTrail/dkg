import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';

// The Source Worker owns scheduling/retries. This journal bridges its state file
// and the external Kafka/DKG commits, which cannot share a transaction.
export class Journal {
  constructor(path, scope) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS scope (id INTEGER PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS messages (
        position TEXT PRIMARY KEY, digest TEXT NOT NULL, envelope TEXT NOT NULL,
        name TEXT NOT NULL, intent INTEGER NOT NULL DEFAULT 0, receipt TEXT);
      CREATE TABLE IF NOT EXISTS checkpoints (
        topic TEXT, partition INTEGER, nextOffset TEXT,
        PRIMARY KEY(topic, partition));
      CREATE TABLE IF NOT EXISTS scheduling (topic TEXT PRIMARY KEY, lastPartition INTEGER);
      CREATE TABLE IF NOT EXISTS http_cooldown (id INTEGER PRIMARY KEY, retryAt INTEGER);
      CREATE TABLE IF NOT EXISTS write_rejections (position TEXT PRIMARY KEY, code TEXT, retryAt INTEGER);
      CREATE TABLE IF NOT EXISTS write_errors (position TEXT PRIMARY KEY, code TEXT, httpStatus INTEGER, retryAt INTEGER);`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS handoffs (
      id TEXT PRIMARY KEY, body TEXT NOT NULL, accepted INTEGER NOT NULL DEFAULT 0,
      attempts INTEGER NOT NULL DEFAULT 0, retryAt INTEGER NOT NULL DEFAULT 0,
      code TEXT, blocked INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS source_controls (id INTEGER PRIMARY KEY, paused INTEGER NOT NULL DEFAULT 0);`);
    const stored = this.db.prepare('SELECT value FROM scope WHERE id=1').get();
    if (stored && stored.value !== scope) {
      this.db.close();
      throw new Error('KAFKA_JOURNAL_SCOPE_CHANGED');
    }
    this.db.prepare('INSERT OR IGNORE INTO scope VALUES (1, ?)').run(scope);
  }
  stage(record, digest, name) {
    const key = JSON.stringify([record.topic, record.partition, record.offset]);
    const old = this.db.prepare('SELECT * FROM messages WHERE position=?').get(key);
    if (old && old.digest !== digest) throw new Error('KAFKA_RECORD_CHANGED');
    if (old) return { ...old, envelope: JSON.parse(old.envelope) };
    this.db.prepare('INSERT INTO messages(position,digest,envelope,name) VALUES (?,?,?,?)')
      .run(key, digest, JSON.stringify(record), name);
    return { position: key, digest, envelope: record, name, intent: 0, receipt: null };
  }
  intent(position) {
    this.db.prepare('UPDATE messages SET intent=1 WHERE position=?').run(position);
  }
  writeFailed(position, error) {
    // Persist only structured codes, never server response text or payloads.
    this.db.prepare('INSERT OR REPLACE INTO write_errors VALUES (?,?,?,?)').run(position,
      error.status ? `DKG_HTTP_${error.status}` : 'DKG_TRANSPORT_FAILED', error.status ?? null, error.retryAt ?? null);
  }
  rejected(position, code, retryAt) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('UPDATE messages SET intent=0 WHERE position=?').run(position);
      this.db.prepare('INSERT OR REPLACE INTO write_rejections VALUES (?,?,?)').run(position, code, retryAt);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  rejection(position) { return this.db.prepare('SELECT code, retryAt FROM write_rejections WHERE position=?').get(position); }
  deferHttp(retryAt) {
    // A read cooldown must never clear or otherwise classify a write intent.
    this.db.prepare(`INSERT INTO http_cooldown VALUES (1, ?)
      ON CONFLICT(id) DO UPDATE SET retryAt=MAX(retryAt, excluded.retryAt)`).run(retryAt);
  }
  httpRetryAt() { return this.db.prepare('SELECT retryAt FROM http_cooldown WHERE id=1').get()?.retryAt; }
  startPosition(topic, partition, fallback) {
    const checkpoint = this.db.prepare('SELECT nextOffset FROM checkpoints WHERE topic=? AND partition=?').get(topic, partition);
    if (checkpoint) return checkpoint.nextOffset;
    // Recover staged first deliveries from journals written by earlier versions.
    const staged = this.db.prepare(`SELECT json_extract(envelope, '$.offset') AS offset FROM messages
      WHERE json_extract(envelope, '$.topic')=? AND json_extract(envelope, '$.partition')=?
      ORDER BY CAST(json_extract(envelope, '$.offset') AS INTEGER) LIMIT 1`).get(topic, partition);
    const first = staged && BigInt(staged.offset) < BigInt(fallback) ? staged.offset : fallback;
    this.checkpoint(topic, partition, first);
    return first;
  }
  selectPartition(topic, partitions) {
    const sorted = [...partitions].sort((a, b) => a - b);
    if (!sorted.length) return undefined;
    const last = this.db.prepare('SELECT lastPartition FROM scheduling WHERE topic=?').get(topic)?.lastPartition;
    const selected = sorted.find(partition => partition > (last ?? -1)) ?? sorted[0];
    return selected;
  }
  partitionDone(topic, partition) {
    this.db.prepare('INSERT OR REPLACE INTO scheduling VALUES (?,?)').run(topic, partition);
  }
  verified(position, receipt, handoff) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('UPDATE messages SET receipt=? WHERE position=?').run(JSON.stringify(receipt), position);
      if (handoff) {
        const body = JSON.stringify(handoff);
        const old = this.db.prepare('SELECT body FROM handoffs WHERE id=?').get(handoff.recordId);
        if (old && old.body !== body) throw new Error('KAFKA_HANDOFF_IDENTITY_CHANGED');
        this.db.prepare('INSERT OR IGNORE INTO handoffs(id,body) VALUES (?,?)').run(handoff.recordId, body);
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  pendingHandoffs(now, limit) { return this.db.prepare('SELECT * FROM handoffs WHERE accepted=0 AND blocked=0 AND retryAt<=? ORDER BY rowid LIMIT ?').all(now, limit); }
  handoffAccepted(id) { this.db.prepare('UPDATE handoffs SET accepted=1,code=NULL WHERE id=?').run(id); }
  handoffFailed(id, code, retryAt, blocked) { this.db.prepare('UPDATE handoffs SET attempts=attempts+1,code=?,retryAt=?,blocked=? WHERE id=?').run(code, retryAt, Number(blocked), id); }
  handoffBacklog() { return this.db.prepare('SELECT count(*) AS count FROM handoffs WHERE accepted=0').get().count; }
  handoffBlocked() { return this.db.prepare('SELECT count(*) AS count FROM handoffs WHERE accepted=0 AND blocked=1').get().count > 0; }
  backpressure() {
    const count = this.handoffBacklog();
    const wasPaused = this.db.prepare('SELECT paused FROM source_controls WHERE id=1').get()?.paused;
    const paused = count >= 1000 || (wasPaused && count >= 500);
    this.db.prepare('INSERT OR REPLACE INTO source_controls VALUES (1,?)').run(Number(!!paused));
    return !!paused;
  }
  checkpoint(topic, partition, nextOffset) {
    this.db.prepare(`INSERT INTO checkpoints VALUES (?,?,?)
      ON CONFLICT(topic,partition) DO UPDATE SET nextOffset=excluded.nextOffset`).run(topic, partition, nextOffset);
  }
  close() { this.db.close(); }
}
