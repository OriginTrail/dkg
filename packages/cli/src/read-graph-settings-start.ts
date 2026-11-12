/**
 * The node's read-graph settings at start (OT-RFC-74): config.json's policy over the settings table, for the daemon and for a store opened outside it.
 *
 * The daemon opens the table, creating it when absent, imports config.json's deprecated rules for single context graphs once, and resolves the settings in
 * force. A bad `query` value in config.json stops the start, as do node modes that the rollback target would not recognize or that a node starting from a
 * public checkpoint cannot keep. The table never stops a start: a mode that the policy or the node does not allow resolves to `off`, with a warning, and a
 * table that cannot be opened gives no context graph settings of its own.
 */
import {
  keepsAnyReadGraph,
  missingReadGraphMethods,
  readGraphLayerOf,
  type ReadGraphStoreConfig,
  type TripleStore,
} from '@origintrail-official/dkg-storage';
import {
  nodeReadGraphModes,
  readGraphStoreSettings,
  resolveEffectiveQueryConfig,
  resolveQuerySection,
  type QueryPolicy,
  type QuerySection,
  type ReadGraphsRefusal,
  type ResolvedQueryConfig,
} from './read-graphs-config.js';
import {
  READ_GRAPH_SETTINGS_FILE,
  openReadGraphSettingsStore,
  readReadGraphSettings,
  type ReadGraphSettingsEntry,
  type SqliteReadGraphSettingsStore,
} from './read-graph-settings-store.js';
import { assertQueryConfigFitsNode, readGraphRollbackTarget, rollbackTargetRefusal } from './update/read-graph-rollback-target.js';

/** A node that starts from a public checkpoint gets its store from the checkpoint, which keeps no read graphs. */
export const CHECKPOINT_NODE_REFUSAL: ReadGraphsRefusal = Object.freeze({
  code: 'READ_GRAPHS_CHECKPOINT_NODE',
  message: 'the node starts from a public checkpoint, whose store the checkpoint builds without read graphs',
});

export interface DaemonReadGraphSettings {
  readonly policy: QueryPolicy;
  /** The settings in force at start. */
  readonly effective: ResolvedQueryConfig;
  /** The read-graph part of the agent's store configuration; `undefined` builds the store as for a node without read-graph settings. */
  readonly storeSettings: ReadGraphStoreConfig | undefined;
}

/** The daemon's settings at start. Throws `QueryConfigError` for a `query` section that stops the start. */
export async function prepareDaemonReadGraphSettings(input: {
  readonly query: unknown;
  readonly role: 'core' | 'edge';
  readonly checkpoint: boolean;
  readonly dataDir: string;
  readonly log: (message: string) => void;
  readonly now?: () => number;
}): Promise<DaemonReadGraphSettings> {
  const { log } = input;
  const section = resolveQuerySection(input.query);
  await assertQueryConfigFitsNode(section.policy, input.role, input.checkpoint);
  // A node that starts from a public checkpoint keeps no read graphs, and its data directory holds only what that start expects.
  const entries = input.checkpoint ? noTable(section, log) : importAndRead(input.dataDir, section, (input.now ?? Date.now)(), log);
  const refusals = input.checkpoint ? [CHECKPOINT_NODE_REFUSAL] : await rollbackRefusals(entries, input.role);
  const { config: effective, warnings } = resolveEffectiveQueryConfig(section.policy, entries, { refusals });
  for (const warning of warnings) log(`[read-graphs] ${capitalized(warning)}.`);
  return {
    policy: section.policy,
    effective,
    storeSettings: input.checkpoint || (input.query === undefined && entries.length === 0) ? undefined : storeSettingsOf(section, effective),
  };
}

/** After the agent's store opens: say so when the store cannot keep read graphs that the table sets, which it then keeps none of. */
export function noteReadGraphStoreSupport(settings: DaemonReadGraphSettings, store: TripleStore, log: (message: string) => void): void {
  if (settings.storeSettings?.whenUnsupported !== 'off' || !keepsAnyReadGraph(settings.effective.readGraphs)) return;
  const layer = readGraphLayerOf(store);
  const missing = layer === null ? [] : missingReadGraphMethods(layer.innerStore, layer.adapterCapabilities);
  if (missing.length === 0) return;
  log(`[read-graphs] The read graphs set in ${READ_GRAPH_SETTINGS_FILE} are off: the node's store does not support read graphs `
    + `(its adapter does not send read-graph operations with ${missing.join(', ')}).`);
}

/**
 * The read-graph part of the configuration of a store opened outside the daemon (`dkg publisher run`), which keeps what the daemon keeps: config.json's
 * policy over the table, which it reads without writing. Until the daemon has imported config.json's rules for single context graphs, they hold over the
 * table, as the import will write them. `undefined` when config.json has no `query` section and the table holds nothing. Throws `QueryConfigError` for a
 * `query` section that the daemon would not start with.
 */
export async function readGraphSettingsOutsideDaemon(
  dataDir: string,
  config: { readonly query?: unknown; readonly nodeRole?: 'core' | 'edge' },
): Promise<ReadGraphStoreConfig | undefined> {
  const section = resolveQuerySection(config.query);
  let snapshot: ReturnType<typeof readReadGraphSettings>;
  let readable = true;
  try {
    snapshot = readReadGraphSettings(dataDir);
  } catch {
    // As in the daemon, a table that cannot be read gives no context graph settings of its own.
    readable = false;
  }
  const pending = readable && snapshot?.importedFromConfigAt === undefined ? section.contextGraphSettings : [];
  const entries = overlaid(snapshot?.entries ?? [], pending);
  if (config.query === undefined && entries.length === 0) return undefined;
  const refusals = await rollbackRefusals(entries, config.nodeRole ?? 'edge');
  return storeSettingsOf(section, resolveEffectiveQueryConfig(section.policy, entries, { refusals }).config);
}

/**
 * The store settings for the settings in force. An adapter that cannot keep read graphs refuses the node's own modes, as before the table, and keeps none
 * of the table's.
 */
function storeSettingsOf(section: QuerySection, effective: ResolvedQueryConfig): ReadGraphStoreConfig {
  return { ...readGraphStoreSettings(effective), whenUnsupported: keepsAnyReadGraph(nodeReadGraphModes(section.policy)) ? 'refuse' : 'off' };
}

/**
 * Open the table, import config.json's rules once, read its entries and close it again: the daemon reads it at start, and opens it again for each change.
 * A table that cannot be opened or read gives no entries, with a warning.
 */
function importAndRead(dataDir: string, section: QuerySection, now: number, log: (message: string) => void): ReadonlyArray<ReadGraphSettingsEntry> {
  let table: SqliteReadGraphSettingsStore;
  try {
    table = openReadGraphSettingsStore(dataDir);
  } catch (error) {
    log(`[read-graphs] ${READ_GRAPH_SETTINGS_FILE} cannot be opened, so no context graph has read-graph settings of its own: ${messageOf(error)}`);
    if (section.deprecatedKeys.length > 0) log(`[read-graphs] ${deprecated(section)} deprecated and ignored.`);
    return [];
  }
  try {
    importOnce(table, section, now, log);
    return table.list();
  } catch (error) {
    log(`[read-graphs] ${READ_GRAPH_SETTINGS_FILE} cannot be read, so no context graph has read-graph settings of its own: ${messageOf(error)}`);
    return [];
  } finally {
    table.close();
  }
}

/** A node that starts from a public checkpoint has no table: config.json's rules for single context graphs are ignored there too. */
function noTable(section: QuerySection, log: (message: string) => void): ReadonlyArray<ReadGraphSettingsEntry> {
  if (section.deprecatedKeys.length > 0) log(`[read-graphs] ${deprecated(section)} deprecated and ignored.`);
  return [];
}

/** Import config.json's rules for single context graphs once; from then on, warn at each start that they are ignored. */
function importOnce(table: SqliteReadGraphSettingsStore, section: QuerySection, now: number, log: (message: string) => void): void {
  if (section.deprecatedKeys.length === 0) return;
  try {
    const importedAt = table.importedFromConfigAt();
    if (importedAt === undefined) {
      table.importFromConfig(section.contextGraphSettings, now);
      log(`[read-graphs] Imported the read-graph settings of ${section.contextGraphSettings.length} context graph(s) from config.json into `
        + `${READ_GRAPH_SETTINGS_FILE}. ${deprecated(section)} deprecated and ignored from now on. ${CHANGE_THEM}`);
    } else {
      log(`[read-graphs] ${deprecated(section)} deprecated and ignored: the settings were imported into ${READ_GRAPH_SETTINGS_FILE} at `
        + `${new Date(importedAt).toISOString()}. ${CHANGE_THEM}`);
    }
  } catch (error) {
    log(`[read-graphs] ${deprecated(section)} deprecated and ignored, and the settings could not be imported into ${READ_GRAPH_SETTINGS_FILE}: `
      + `${messageOf(error)}`);
  }
}

const CHANGE_THEM = 'Change read graphs per context graph with `dkg store read-graphs enable|disable` or the node\'s read-graph settings API.';

/** "query.readGraphs.contextGraphs in config.json is" or "… and … in config.json are". */
function deprecated(section: QuerySection): string {
  return `${section.deprecatedKeys.join(' and ')} in config.json ${section.deprecatedKeys.length === 1 ? 'is' : 'are'}`;
}

/** The rollback target's refusal, looked up only when the table keeps a read graph. A target that cannot be read refuses too. */
async function rollbackRefusals(entries: ReadonlyArray<ReadGraphSettingsEntry>, role: 'core' | 'edge'): Promise<ReadGraphsRefusal[]> {
  if (!entries.some((entry) => Object.values(entry.layers).some((mode) => mode !== 'off'))) return [];
  try {
    const refusal = rollbackTargetRefusal(await readGraphRollbackTarget(role));
    return refusal === undefined ? [] : [refusal];
  } catch (error) {
    return [{ code: 'READ_GRAPHS_ROLLBACK_TARGET_OLDER', message: `the rollback target cannot be read (${messageOf(error)})` }];
  }
}

/** The table's entries with config.json's rules written over them, as the import writes them. */
function overlaid(table: ReadonlyArray<ReadGraphSettingsEntry>, rules: ReadonlyArray<ReadGraphSettingsEntry>): ReadonlyArray<ReadGraphSettingsEntry> {
  if (rules.length === 0) return table;
  const byGraph = new Map(table.map((entry) => [entry.contextGraphId, entry]));
  for (const rule of rules) {
    const held = byGraph.get(rule.contextGraphId);
    const viewSemantics = rule.viewSemantics ?? held?.viewSemantics;
    byGraph.set(rule.contextGraphId, {
      contextGraphId: rule.contextGraphId,
      layers: { ...held?.layers, ...rule.layers },
      ...(viewSemantics === undefined ? {} : { viewSemantics }),
    });
  }
  return [...byGraph.keys()].sort().map((contextGraphId) => byGraph.get(contextGraphId)!);
}

const capitalized = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
