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
        PRIMARY KEY(topic, partition));`);
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
  verified(position, receipt) {
    this.db.prepare('UPDATE messages SET receipt=? WHERE position=?').run(JSON.stringify(receipt), position);
  }
  checkpoint(topic, partition, nextOffset) {
    this.db.prepare(`INSERT INTO checkpoints VALUES (?,?,?)
      ON CONFLICT(topic,partition) DO UPDATE SET nextOffset=excluded.nextOffset`).run(topic, partition, nextOffset);
  }
  close() { this.db.close(); }
}
