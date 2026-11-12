/**
 * The node's read-graph settings for single context graphs (OT-RFC-74): the mode of each context graph and layer, and the default of a view query without
 * `semantics`. The CLI, the API, agent tools and the node UI change them at runtime through the daemon, which is the only writer. config.json keeps the
 * node-wide policy that bounds them (`read-graphs-config.ts`).
 *
 * The rows live in the node's one SQLite database, `node-ui.db`, beside the other protocol state: `read_graph_modes`, `view_semantics_defaults` and
 * `read_graph_settings_meta` (`imported_from_config_at` once config.json's rules for single context graphs are imported). `DashboardDB` owns the file,
 * the connection and the schema (from version 39); this store only reads and writes over the handle it is given, as the protocol stores do.
 *
 * `updated_at` is unix milliseconds, and `updated_by` names who changed the row: `cli`, `api`, `ui`, `agent:<id>` or `import`.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { GET_VIEWS, isReadGraphEligibleContextGraphId, type GetView } from '@origintrail-official/dkg-core';
import type { NodeStoreDatabaseHandle } from '@origintrail-official/dkg-node-store';
import { READ_GRAPH_MODES, VIEW_SEMANTICS, type ReadGraphMode, type ViewSemantics } from '@origintrail-official/dkg-storage';

/** The node's SQLite database, which `DashboardDB` opens in the data directory. */
export const NODE_DATABASE_FILE = 'node-ui.db';
const IMPORTED_FROM_CONFIG_AT = 'imported_from_config_at';

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
  /** Stop using the database; its host closes it. */
  close(): void;
}

/** A change the table refuses: a context graph ID that can't have read graphs, an unknown layer or value, or an unknown actor. */
export class ReadGraphSettingsError extends Error {
  readonly code = 'READ_GRAPH_SETTINGS_INVALID';
  constructor(readonly issues: readonly string[]) {
    super(`invalid read-graph settings: ${issues.join('; ')}`);
    this.name = 'ReadGraphSettingsError';
  }
}

/** The settings cannot be read or written: the store was closed, it is read-only, or its database cannot be used. */
export class ReadGraphSettingsUnavailableError extends Error {
  readonly code = 'READ_GRAPH_SETTINGS_UNAVAILABLE';
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ReadGraphSettingsUnavailableError';
  }
}

/** What another process reads of the settings: their entries, and when config.json's rules were imported. */
export interface ReadGraphSettingsSnapshot {
  readonly entries: ReadonlyArray<ReadGraphSettingsEntry>;
  readonly importedFromConfigAt: number | undefined;
}

/**
 * Read the settings in a data directory without writing anything, for a process other than the daemon: the node's database opened read-only.
 * `undefined` when the directory holds no database, or one from before the settings tables.
 */
export function readReadGraphSettings(dataDir: string): ReadGraphSettingsSnapshot | undefined {
  const path = join(dataDir, NODE_DATABASE_FILE);
  if (!existsSync(path)) return undefined;
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const tables = db.prepare(`SELECT COUNT(*) AS found FROM sqlite_master WHERE type = 'table'
      AND name IN ('read_graph_modes', 'view_semantics_defaults', 'read_graph_settings_meta')`).get() as { found: number };
    if (tables.found < 3) return undefined;
    const store = new SqliteReadGraphSettingsStore({ db }, { readOnly: true });
    return { entries: store.list(), importedFromConfigAt: store.importedFromConfigAt() };
  } finally {
    db.close();
  }
}

export class SqliteReadGraphSettingsStore implements ReadGraphSettingsStore {
  readonly #db: Database.Database;
  readonly #readOnly: boolean;
  #closed = false;

  constructor(database: NodeStoreDatabaseHandle, options: { readonly readOnly?: boolean } = {}) {
    this.#db = database.db;
    this.#readOnly = options.readOnly === true;
  }

  list(): ReadonlyArray<ReadGraphSettingsEntry> {
    const db = this.#open();
    const byGraph = new Map<string, { layers: Partial<Record<GetView, ReadGraphMode>>; viewSemantics?: ViewSemantics }>();
    const of = (contextGraphId: string) => {
      let settings = byGraph.get(contextGraphId);
      if (settings === undefined) byGraph.set(contextGraphId, settings = { layers: {} });
      return settings;
    };
    for (const row of db.prepare('SELECT context_graph_id, layer, mode FROM read_graph_modes').all() as Array<Record<string, unknown>>) {
      const view = viewOf(row['layer']);
      const mode = modeOf(row['mode']);
      if (typeof row['context_graph_id'] === 'string' && view !== undefined && mode !== undefined) of(row['context_graph_id']).layers[view] = mode;
    }
    for (const row of db.prepare('SELECT context_graph_id, semantics FROM view_semantics_defaults').all() as Array<Record<string, unknown>>) {
      const semantics = semanticsOf(row['semantics']);
      if (typeof row['context_graph_id'] === 'string' && semantics !== undefined) of(row['context_graph_id']).viewSemantics = semantics;
    }
    return Object.freeze([...byGraph.keys()].sort().map((contextGraphId) => entryOf(contextGraphId, byGraph.get(contextGraphId)!)));
  }

  get(contextGraphId: string): ReadGraphContextSettings {
    const db = this.#open();
    const layers: Partial<Record<GetView, ReadGraphMode>> = {};
    for (const row of db.prepare('SELECT layer, mode FROM read_graph_modes WHERE context_graph_id = ?').all(contextGraphId) as Array<Record<string, unknown>>) {
      const view = viewOf(row['layer']);
      const mode = modeOf(row['mode']);
      if (view !== undefined && mode !== undefined) layers[view] = mode;
    }
    const row = db.prepare('SELECT semantics FROM view_semantics_defaults WHERE context_graph_id = ?').get(contextGraphId) as Record<string, unknown> | undefined;
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
    this.#transaction(() => this.#delete(contextGraphId));
  }

  /** When config.json's rules for single context graphs were imported (unix milliseconds), or `undefined` before they are. */
  importedFromConfigAt(): number | undefined {
    const row = this.#open().prepare('SELECT value FROM read_graph_settings_meta WHERE key = ?').get(IMPORTED_FROM_CONFIG_AT) as { value?: unknown } | undefined;
    const at = typeof row?.value === 'string' ? Number(row.value) : Number.NaN;
    return Number.isSafeInteger(at) ? at : undefined;
  }

  /** Import config.json's rules for single context graphs, with `updated_by` = `import`, and record the time: one transaction. */
  importFromConfig(entries: ReadonlyArray<ReadGraphSettingsEntry>, at: number): void {
    const issues = entries.flatMap((entry) => [...contextGraphIssues(entry.contextGraphId), ...changeIssues(entry)]);
    if (issues.length > 0) throw new ReadGraphSettingsError(issues);
    this.#transaction(() => {
      for (const entry of entries) this.#write(entry.contextGraphId, entry, 'import', at);
      this.#db.prepare('INSERT INTO read_graph_settings_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
        .run(IMPORTED_FROM_CONFIG_AT, String(at));
    });
  }

  close(): void {
    this.#closed = true;
  }

  #open(): Database.Database {
    if (this.#closed) throw new ReadGraphSettingsUnavailableError('the read-graph settings store is closed');
    return this.#db;
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

  #delete(contextGraphId: string): void {
    this.#db.prepare('DELETE FROM read_graph_modes WHERE context_graph_id = ?').run(contextGraphId);
    this.#db.prepare('DELETE FROM view_semantics_defaults WHERE context_graph_id = ?').run(contextGraphId);
  }

  /** One synchronous transaction on the shared handle, so no other write of the process can fall inside it. */
  #transaction(work: () => void): void {
    if (this.#readOnly) throw new ReadGraphSettingsUnavailableError('the read-graph settings store is read-only');
    this.#open().transaction(work).immediate();
  }
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
