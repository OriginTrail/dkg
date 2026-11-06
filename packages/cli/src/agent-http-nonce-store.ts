import type Database from 'better-sqlite3';

import type { AgentHttpNonceStore } from './agent-http-auth.js';

/** Shares the daemon-owned SQLite connection and lifetime; survives ordinary restarts. */
export class SqliteAgentHttpNonceStore implements AgentHttpNonceStore {
  private readonly claimTransaction: (target: string, address: string, nonce: string, expiresAt: number, now: number) => boolean;

  constructor(db: Database.Database) {
    db.exec('CREATE TABLE IF NOT EXISTS agent_http_nonces_v1 (target TEXT NOT NULL, address TEXT NOT NULL, nonce TEXT NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY(target, address, nonce)) WITHOUT ROWID');
    db.exec('CREATE INDEX IF NOT EXISTS agent_http_nonces_expiry_v1 ON agent_http_nonces_v1(expires_at)');
    const cleanup = db.prepare('DELETE FROM agent_http_nonces_v1 WHERE expires_at < ?');
    const exists = db.prepare('SELECT 1 FROM agent_http_nonces_v1 WHERE target=? AND address=? AND nonce=?');
    const count = db.prepare('SELECT COUNT(*) AS n FROM agent_http_nonces_v1');
    const insert = db.prepare('INSERT INTO agent_http_nonces_v1 VALUES (?, ?, ?, ?)');
    this.claimTransaction = db.transaction((target: string, address: string, nonce: string, expiresAt: number, now: number) => {
      cleanup.run(now);
      if (exists.get(target, address, nonce)) return false;
      // Never evict a live nonce to admit new work: capacity exhaustion fails closed.
      if ((count.get() as { n: number }).n >= 100_000) throw new Error('HTTP nonce capacity exceeded');
      insert.run(target, address, nonce, expiresAt);
      return true;
    }).immediate;
  }

  claim(target: string, address: string, nonce: string, expiresAt: number, now: number): boolean {
    return this.claimTransaction(target, address, nonce, expiresAt, now);
  }
}

