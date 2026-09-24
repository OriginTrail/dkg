import type Database from 'better-sqlite3';
import type { DashboardDB } from '../src/db.js';
import { SqliteChainEventLogReader, SqliteChainEventLogStore } from '../src/index.js';
import type { SqliteChainEventLogCommit } from '../src/chain-event-log-store.js';

declare const handle: Database.Database;
declare const dashboard: DashboardDB;
declare const commit: SqliteChainEventLogCommit;

const reader = new SqliteChainEventLogReader(handle);
void reader.load('scope');
void reader.readEventsBounded('scope', { fromBlockNumber: 0, throughBlockNumber: 1 }, 10);
void reader.blockHashAt('scope', 1);
// @ts-expect-error The worker read port cannot commit a cursor or event rows.
void reader.commit('scope', undefined, commit);
// @ts-expect-error The worker read port cannot invalidate the daemon's log.
void reader.tombstone('scope', 1);

const writer = new SqliteChainEventLogStore(dashboard);
void writer.commit('scope', undefined, commit);
void writer.tombstone('scope', 1);
// @ts-expect-error A bare worker-owned handle is not the daemon's writable resource.
new SqliteChainEventLogStore({ db: handle });
