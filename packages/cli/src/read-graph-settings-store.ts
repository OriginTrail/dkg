/**
 * The node's read-graph settings for single context graphs (OT-RFC-74): the mode of each context graph and layer, and the default of a view query without
 * `semantics`. The CLI, the API, agent tools and the node UI change them at runtime through the daemon, which is the only writer. config.json keeps the
 * node-wide policy that bounds them (`read-graphs-config.ts`).
 *
 * The table is SQLite through `node:sqlite`: `read-graph-settings.db` in the node's data directory, in WAL mode. Schema v1:
 * - `read_graph_modes`: one row for each context graph and layer with a mode of its own;
 * - `view_semantics_defaults`: one row for each context graph with a default of its own;
 * - `schema_meta`: `version`, and `imported_from_config_at` once config.json's rules for single context graphs are imported.
 *
 * `updated_at` is unix milliseconds, and `updated_by` names who changed the row: `cli`, `api`, `ui`, `agent:<id>` or `import`.
 */
import { chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { GET_VIEWS, isReadGraphEligibleContextGraphId, type GetView } from '@origintrail-official/dkg-core';
import { READ_GRAPH_MODES, VIEW_SEMANTICS, type ReadGraphMode, type ViewSemantics } from '@origintrail-official/dkg-storage';

export const READ_GRAPH_SETTINGS_FILE = 'read-graph-settings.db';
const SCHEMA_VERSION = '1';
const IMPORTED_FROM_CONFIG_AT = 'imported_from_config_at';

const SCHEMA = `
CREATE TABLE read_graph_modes (
  context_graph_id TEXT NOT NULL,
  layer TEXT NOT NULL CHECK (layer IN ('working-memory', 'shared-working-memory', 'verifiable-memory')),
  mode TEXT NOT NULL CHECK (mode IN ('off', 'build', 'serve')),
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL,
  PRIMARY KEY (context_graph_id, layer)
);
CREATE TABLE view_semantics_defaults (
  context_graph_id TEXT PRIMARY KEY,
  semantics TEXT NOT NULL CHECK (semantics IN ('merged', 'per-asset')),
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL
);
CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

/** Who changed a setting: the CLI, the API, the node UI, an agent through its tools, or the one-time import from config.json. */
export type ReadGraphSettingsActor = 'cli' | 'api' | 'ui' | 'import' | `agent:${string}`;
const ACTOR = /^(?:cli|api|ui|import|agent:[^\s\p{Cc}\p{Cf}]{1,256})$/u;

/** A context graph's own settings: a mode for each layer that has one, and its view-semantics default when it has one. */
export interface ReadGraphContextSettings {
  readonly layers: Readonly<Partial<Record<GetView, ReadGraphMode>>>;
  readonly viewSemantics?: ViewSemantics;
}

export interface ReadGraphSettingsEntry extends ReadGraphContextSettings {
  readonly contextGraphId: string;
}

/** A change to one context graph's settings: the modes it sets, and its view-semantics default (`null` removes it). */
export interface ReadGraphSettingsChange {
  readonly layers?: Readonly<Partial<Record<GetView, ReadGraphMode>>>;
  readonly viewSemantics?: ViewSemantics | null;
}

export interface ReadGraphSettingsStore {
  /** Every context graph with a setting of its own, in ID order. */
  list(): ReadonlyArray<ReadGraphSettingsEntry>;
  /** One context graph's own settings: none for a context graph the table does not name. */
  get(contextGraphId: string): ReadGraphContextSettings;
  /** One transaction. `null` removes the view-semantics default. */
  set(contextGraphId: string, change: ReadGraphSettingsChange, actor: string): void;
  /** Remove every setting of a context graph, in one transaction. */
  remove(contextGraphId: string, actor: string): void;
  close(): void;
}

/** One context graph's rows as stored, for putting them back after a change the node refuses. */
export interface ReadGraphSettingsRows {
  readonly modes: ReadonlyArray<{ readonly layer: string; readonly mode: string; readonly updatedAt: number; readonly updatedBy: string }>;
  readonly semantics?: { readonly semantics: string; readonly updatedAt: number; readonly updatedBy: string };
}

/** A change the table refuses: a context graph ID that can't have read graphs, an unknown layer or value, or an unknown actor. */
export class ReadGraphSettingsError extends Error {
  readonly code = 'READ_GRAPH_SETTINGS_INVALID';
  constructor(readonly issues: readonly string[]) {
    super(`invalid read-graph settings: ${issues.join('; ')}`);
    this.name = 'ReadGraphSettingsError';
  }
}

/** The table cannot be opened: `node:sqlite` is missing, the file is not a settings table, or a newer release wrote it. */
export class ReadGraphSettingsUnavailableError extends Error {
  readonly code = 'READ_GRAPH_SETTINGS_UNAVAILABLE';
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ReadGraphSettingsUnavailableError';
  }
}

/** The table in a data directory, opened by the daemon: created when absent, and written only by it. */
export function openReadGraphSettingsStore(dataDir: string): SqliteReadGraphSettingsStore {
  return SqliteReadGraphSettingsStore.open(join(dataDir, READ_GRAPH_SETTINGS_FILE), false);
}

/** What another process reads of the table: its entries, and when config.json's rules were imported. */
export interface ReadGraphSettingsSnapshot {
  readonly entries: ReadonlyArray<ReadGraphSettingsEntry>;
  readonly importedFromConfigAt: number | undefined;
}

/** Read the table in a data directory without writing it, for a process other than the daemon. `undefined` when the directory holds none. */
export function readReadGraphSettings(dataDir: string): ReadGraphSettingsSnapshot | undefined {
  const path = join(dataDir, READ_GRAPH_SETTINGS_FILE);
  if (!existsSync(path)) return undefined;
  const store = SqliteReadGraphSettingsStore.open(path, true);
  try {
    return { entries: store.list(), importedFromConfigAt: store.importedFromConfigAt() };
  } finally {
    store.close();
  }
}

export class SqliteReadGraphSettingsStore implements ReadGraphSettingsStore {
  readonly #db: DatabaseSync;
  readonly #readOnly: boolean;
  #closed = false;

  private constructor(db: DatabaseSync, readOnly: boolean) {
    this.#db = db;
    this.#readOnly = readOnly;
  }

  /** Open the table at a path: read-only, or writable and created when absent. */
  static open(path: string, readOnly: boolean): SqliteReadGraphSettingsStore {
    const { DatabaseSync: Database } = sqlite();
    let db: DatabaseSync;
    try {
      db = new Database(path, { readOnly });
    } catch (error) {
      throw new ReadGraphSettingsUnavailableError(`${path} cannot be opened: ${messageOf(error)}`, { cause: error });
    }
    try {
      // Owner-only, as the node's other files; SQLite gives its WAL and shared-memory files the same mode.
      if (!readOnly) chmodSync(path, 0o600);
      db.exec('PRAGMA busy_timeout = 5000');
      const store = new SqliteReadGraphSettingsStore(db, readOnly);
      store.#prepareSchema(path);
      if (!readOnly) {
        db.exec('PRAGMA journal_mode = WAL');
        db.exec('PRAGMA synchronous = FULL');
      }
      return store;
    } catch (error) {
      db.close();
      if (error instanceof ReadGraphSettingsUnavailableError) throw error;
      throw new ReadGraphSettingsUnavailableError(`${path} cannot be opened: ${messageOf(error)}`, { cause: error });
    }
  }

  list(): ReadonlyArray<ReadGraphSettingsEntry> {
    const db = this.#open();
    const byGraph = new Map<string, { layers: Partial<Record<GetView, ReadGraphMode>>; viewSemantics?: ViewSemantics }>();
    const of = (contextGraphId: string) => {
      let settings = byGraph.get(contextGraphId);
      if (settings === undefined) byGraph.set(contextGraphId, settings = { layers: {} });
      return settings;
    };
    for (const row of db.prepare('SELECT context_graph_id, layer, mode FROM read_graph_modes').all()) {
      const view = viewOf(row['layer']);
      const mode = modeOf(row['mode']);
      if (typeof row['context_graph_id'] === 'string' && view !== undefined && mode !== undefined) of(row['context_graph_id']).layers[view] = mode;
    }
    for (const row of db.prepare('SELECT context_graph_id, semantics FROM view_semantics_defaults').all()) {
      const semantics = semanticsOf(row['semantics']);
      if (typeof row['context_graph_id'] === 'string' && semantics !== undefined) of(row['context_graph_id']).viewSemantics = semantics;
    }
    return Object.freeze([...byGraph.keys()].sort().map((contextGraphId) => entryOf(contextGraphId, byGraph.get(contextGraphId)!)));
  }

  get(contextGraphId: string): ReadGraphContextSettings {
    const db = this.#open();
    const layers: Partial<Record<GetView, ReadGraphMode>> = {};
    for (const row of db.prepare('SELECT layer, mode FROM read_graph_modes WHERE context_graph_id = ?').all(contextGraphId)) {
      const view = viewOf(row['layer']);
      const mode = modeOf(row['mode']);
      if (view !== undefined && mode !== undefined) layers[view] = mode;
    }
    const row = db.prepare('SELECT semantics FROM view_semantics_defaults WHERE context_graph_id = ?').get(contextGraphId);
    const viewSemantics = semanticsOf(row?.['semantics']);
    return Object.freeze({ layers: Object.freeze(layers), ...(viewSemantics === undefined ? {} : { viewSemantics }) });
  }

  set(contextGraphId: string, change: ReadGraphSettingsChange, actor: string): void {
    const issues = [...contextGraphIssues(contextGraphId), ...changeIssues(change), ...actorIssues(actor)];
    if (issues.length > 0) throw new ReadGraphSettingsError(issues);
    const at = Date.now();
    this.#transaction(() => this.#write(contextGraphId, change, actor, at));
  }

  remove(contextGraphId: string, actor: string): void {
    const issues = [...(typeof contextGraphId === 'string' ? [] : ['the context graph ID must be a string']), ...actorIssues(actor)];
    if (issues.length > 0) throw new ReadGraphSettingsError(issues);
    this.#transaction(() => {
      this.#db.prepare('DELETE FROM read_graph_modes WHERE context_graph_id = ?').run(contextGraphId);
      this.#db.prepare('DELETE FROM view_semantics_defaults WHERE context_graph_id = ?').run(contextGraphId);
    });
  }

  /** One context graph's rows as stored, with when and by whom each changed: what {@link restore} puts back. */
  rowsOf(contextGraphId: string): ReadGraphSettingsRows {
    const db = this.#open();
    const modes = db.prepare('SELECT layer, mode, updated_at, updated_by FROM read_graph_modes WHERE context_graph_id = ?').all(contextGraphId)
      .map((row) => ({ layer: String(row['layer']), mode: String(row['mode']), updatedAt: Number(row['updated_at']), updatedBy: String(row['updated_by']) }));
    const row = db.prepare('SELECT semantics, updated_at, updated_by FROM view_semantics_defaults WHERE context_graph_id = ?').get(contextGraphId);
    const semantics = row === undefined
      ? undefined
      : { semantics: String(row['semantics']), updatedAt: Number(row['updated_at']), updatedBy: String(row['updated_by']) };
    return Object.freeze({ modes: Object.freeze(modes), ...(semantics === undefined ? {} : { semantics }) });
  }

  /** Put a context graph's rows back exactly as {@link rowsOf} read them, in one transaction. */
  restore(contextGraphId: string, rows: ReadGraphSettingsRows): void {
    this.#transaction(() => {
      this.#db.prepare('DELETE FROM read_graph_modes WHERE context_graph_id = ?').run(contextGraphId);
      this.#db.prepare('DELETE FROM view_semantics_defaults WHERE context_graph_id = ?').run(contextGraphId);
      const insert = this.#db.prepare('INSERT INTO read_graph_modes (context_graph_id, layer, mode, updated_at, updated_by) VALUES (?, ?, ?, ?, ?)');
      for (const mode of rows.modes) insert.run(contextGraphId, mode.layer, mode.mode, mode.updatedAt, mode.updatedBy);
      if (rows.semantics !== undefined) {
        this.#db.prepare('INSERT INTO view_semantics_defaults (context_graph_id, semantics, updated_at, updated_by) VALUES (?, ?, ?, ?)')
          .run(contextGraphId, rows.semantics.semantics, rows.semantics.updatedAt, rows.semantics.updatedBy);
      }
    });
  }

  /** When config.json's rules for single context graphs were imported (unix milliseconds), or `undefined` before they are. */
  importedFromConfigAt(): number | undefined {
    const row = this.#open().prepare('SELECT value FROM schema_meta WHERE key = ?').get(IMPORTED_FROM_CONFIG_AT);
    const at = typeof row?.['value'] === 'string' ? Number(row['value']) : Number.NaN;
    return Number.isSafeInteger(at) ? at : undefined;
  }

  /** Import config.json's rules for single context graphs, with `updated_by` = `import`, and record the time: one transaction. */
  importFromConfig(entries: ReadonlyArray<ReadGraphSettingsEntry>, at: number): void {
    const issues = entries.flatMap((entry) => [...contextGraphIssues(entry.contextGraphId), ...changeIssues(entry)]);
    if (issues.length > 0) throw new ReadGraphSettingsError(issues);
    this.#transaction(() => {
      for (const entry of entries) this.#write(entry.contextGraphId, entry, 'import', at);
      this.#db.prepare('INSERT INTO schema_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
        .run(IMPORTED_FROM_CONFIG_AT, String(at));
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }

  #open(): DatabaseSync {
    if (this.#closed) throw new ReadGraphSettingsUnavailableError('the read-graph settings table is closed');
    return this.#db;
  }

  /** Check the schema version, and create schema v1 in a new table. A table that a newer release wrote is refused, never changed. */
  #prepareSchema(path: string): void {
    const meta = this.#db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'schema_meta'").get();
    if (meta === undefined) {
      if (this.#readOnly) throw new ReadGraphSettingsUnavailableError(`${path} holds no read-graph settings table`);
      this.#transaction(() => {
        this.#db.exec(SCHEMA);
        this.#db.prepare("INSERT INTO schema_meta (key, value) VALUES ('version', ?)").run(SCHEMA_VERSION);
      });
      return;
    }
    const version = this.#db.prepare("SELECT value FROM schema_meta WHERE key = 'version'").get()?.['value'];
    if (version !== SCHEMA_VERSION) {
      throw new ReadGraphSettingsUnavailableError(`${path} has schema version ${String(version)}, which this release does not read`);
    }
  }

  #write(contextGraphId: string, change: ReadGraphSettingsChange, actor: string, at: number): void {
    // A mode that does not change keeps the time and the actor of its last change.
    const setMode = this.#db.prepare(`INSERT INTO read_graph_modes (context_graph_id, layer, mode, updated_at, updated_by) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (context_graph_id, layer) DO UPDATE SET mode = excluded.mode, updated_at = excluded.updated_at, updated_by = excluded.updated_by
      WHERE read_graph_modes.mode <> excluded.mode`);
    for (const view of GET_VIEWS) {
      const mode = change.layers?.[view];
      if (mode !== undefined) setMode.run(contextGraphId, view, mode, at, actor);
    }
    if (change.viewSemantics === null) {
      this.#db.prepare('DELETE FROM view_semantics_defaults WHERE context_graph_id = ?').run(contextGraphId);
    } else if (change.viewSemantics !== undefined) {
      this.#db.prepare(`INSERT INTO view_semantics_defaults (context_graph_id, semantics, updated_at, updated_by) VALUES (?, ?, ?, ?)
        ON CONFLICT (context_graph_id) DO UPDATE SET semantics = excluded.semantics, updated_at = excluded.updated_at, updated_by = excluded.updated_by
        WHERE view_semantics_defaults.semantics <> excluded.semantics`).run(contextGraphId, change.viewSemantics, at, actor);
    }
  }

  #transaction(work: () => void): void {
    if (this.#readOnly) throw new ReadGraphSettingsUnavailableError('the read-graph settings table is open read-only');
    const db = this.#open();
    db.exec('BEGIN IMMEDIATE');
    try {
      work();
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* SQLite already ended the transaction; the first error is the one to report */ }
      throw error;
    }
  }
}

function sqlite(): typeof import('node:sqlite') {
  let module: typeof import('node:sqlite') | undefined;
  try {
    module = process.getBuiltinModule('node:sqlite');
  } catch { /* reported below */ }
  if (module === undefined) throw new ReadGraphSettingsUnavailableError(`node:sqlite is not available in Node.js ${process.version}`);
  return module;
}

function entryOf(contextGraphId: string, settings: { layers: Partial<Record<GetView, ReadGraphMode>>; viewSemantics?: ViewSemantics }): ReadGraphSettingsEntry {
  return Object.freeze({
    contextGraphId,
    layers: Object.freeze(settings.layers),
    ...(settings.viewSemantics === undefined ? {} : { viewSemantics: settings.viewSemantics }),
  });
}

function contextGraphIssues(contextGraphId: unknown): string[] {
  return typeof contextGraphId === 'string' && isReadGraphEligibleContextGraphId(contextGraphId)
    ? []
    : [`${shown(contextGraphId)} is not a context graph ID that can have read graphs`];
}

function changeIssues(change: unknown): string[] {
  if (typeof change !== 'object' || change === null || Array.isArray(change)) return ['the change must be an object'];
  const { layers, viewSemantics } = change as { layers?: unknown; viewSemantics?: unknown };
  const issues: string[] = [];
  if (layers !== undefined) {
    if (typeof layers !== 'object' || layers === null || Array.isArray(layers)) {
      issues.push('layers must be an object keyed by layer');
    } else {
      for (const [view, mode] of Object.entries(layers)) {
        if (mode === undefined) continue;
        if (viewOf(view) === undefined) issues.push(`${shown(view)} is not a layer (layers: ${GET_VIEWS.join(', ')})`);
        else if (modeOf(mode) === undefined) issues.push(`the mode for ${view} must be one of ${READ_GRAPH_MODES.join(', ')} (got ${shown(mode)})`);
      }
    }
  }
  if (viewSemantics !== undefined && viewSemantics !== null && semanticsOf(viewSemantics) === undefined) {
    issues.push(`viewSemantics must be one of ${VIEW_SEMANTICS.join(', ')}, or null (got ${shown(viewSemantics)})`);
  }
  return issues;
}

function actorIssues(actor: unknown): string[] {
  return typeof actor === 'string' && ACTOR.test(actor) ? [] : [`${shown(actor)} is not an actor (cli, api, ui, import or agent:<id>)`];
}

const viewOf = (value: unknown): GetView | undefined => GET_VIEWS.find((view) => view === value);
const modeOf = (value: unknown): ReadGraphMode | undefined => READ_GRAPH_MODES.find((mode) => mode === value);
const semanticsOf = (value: unknown): ViewSemantics | undefined => VIEW_SEMANTICS.find((semantics) => semantics === value);

/** A value as written, short enough for one message. */
function shown(value: unknown): string {
  let text: string | undefined;
  try { text = JSON.stringify(value); } catch { /* described by its type below */ }
  const out = text ?? typeof value;
  return out.length > 60 ? `${out.slice(0, 57)}...` : out;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
