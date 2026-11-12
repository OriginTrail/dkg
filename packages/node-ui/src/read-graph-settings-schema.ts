import type Database from 'better-sqlite3';

/**
 * The node's read-graph settings for single context graphs (OT-RFC-74), from schema 39: a mode for each context graph
 * and memory layer, a view-semantics default for each context graph, and when config.json's rules for single context
 * graphs were imported. The CLI's settings store reads and writes them; the daemon is their only writer.
 *
 * `updated_at` is unix milliseconds, and `updated_by` names who changed the row: `cli`, `api`, `ui`, `agent:<id>` or
 * `import`. Idempotent, so the repair pass of a current-version file can run it too.
 */
export function installReadGraphSettingsSchema(db: Pick<Database.Database, 'exec'>): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS read_graph_modes (
      context_graph_id TEXT NOT NULL,
      layer TEXT NOT NULL CHECK (layer IN ('working-memory', 'shared-working-memory', 'verifiable-memory')),
      mode TEXT NOT NULL CHECK (mode IN ('off', 'build', 'serve')),
      updated_at INTEGER NOT NULL,
      updated_by TEXT NOT NULL,
      PRIMARY KEY (context_graph_id, layer)
    );
    CREATE TABLE IF NOT EXISTS view_semantics_defaults (
      context_graph_id TEXT PRIMARY KEY,
      semantics TEXT NOT NULL CHECK (semantics IN ('merged', 'per-asset')),
      updated_at INTEGER NOT NULL,
      updated_by TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS read_graph_settings_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
}
