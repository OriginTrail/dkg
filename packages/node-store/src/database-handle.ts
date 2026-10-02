import type Database from 'better-sqlite3';

/**
 * The only thing a node store needs from its host: an already-open, already
 * migrated better-sqlite3 handle.
 *
 * Every `Sqlite*Store` in this package is constructed against this shape, never
 * against a concrete database class. That keeps the package free of any
 * dependency on the dashboard package that opens the file today (`DashboardDB`
 * in `@origintrail-official/dkg-node-ui` satisfies it structurally), and it is
 * what lets protocol state move to its own SQLite file later without touching
 * a store: the host hands over a different handle.
 *
 * The stores do not open, close, migrate or pragma the database. The host owns
 * the file, the connection lifecycle and the schema (see the package README).
 */
export interface NodeStoreDatabaseHandle {
  readonly db: Database.Database;
}
