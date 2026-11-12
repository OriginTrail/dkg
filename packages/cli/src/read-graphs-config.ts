/**
 * Query settings of config.json: `queryAccess` (who may query this node) and the `query` section (OT-RFC-74), the node-wide read-graph settings and what a
 * view query without `semantics` gets.
 *
 *   "query": {
 *     "readGraphs": "off",
 *     "viewSemantics": "per-asset",
 *     "readGraphsPolicy": { "enabled": true, "layers": ["working-memory", "shared-working-memory", "verifiable-memory"] }
 *   }
 *
 * `readGraphs` is the node's mode: `off` (no read graphs, the default), `build` (read graphs are built, maintained and checked, and no query reads them) or
 * `serve` (merged view queries read them). It can also be an object with a node default and modes per layer:
 *
 *   "readGraphs": { "default": "off", "layers": { "verifiable-memory": "build" } }
 *
 * Modes and view-semantics defaults for single context graphs are in the node's settings table (`read-graph-settings-store.ts`), which the daemon changes
 * at runtime. The most specific setting wins: the table's mode for the context graph and layer, then the node's mode for the layer, then the node's default.
 * Layers have the names `/api/query` gives views, and a context graph is named by its ID, as in `/api/query`.
 *
 * `readGraphsPolicy` bounds every mode: `enabled: false` turns every read graph off, and `layers` lists the layers that may keep one (all three by default).
 *
 * `viewSemantics` is the node's default: `per-asset` (every pattern matches inside one asset graph; the default) or `merged`. A query that asks for
 * `semantics` gets what it asks for; `merged` is answered only where read graphs are served.
 *
 * Rules for single context graphs in config.json (`readGraphs.contextGraphs`, `viewSemantics.contextGraphs`) are deprecated: the daemon imports them into
 * the settings table once and ignores them from then on.
 *
 * Validation is loud, as for `queueRetention`: `resolveQuerySection` collects every problem into one `QueryConfigError` that names each key, and an unknown
 * key is an error. The daemon also refuses node modes that the release it would roll back to does not recognize (`update/read-graph-rollback-target.ts`).
 * The settings table never stops a start: a setting that the policy or the node does not allow resolves to `off`, with a warning
 * ({@link resolveEffectiveQueryConfig}).
 */
import { GET_VIEWS, MemoryLayer, isReadGraphEligibleContextGraphId, type GetView } from '@origintrail-official/dkg-core';
import {
  READ_GRAPH_MODES,
  VIEW_SEMANTICS,
  type ReadGraphMode,
  type ReadGraphModeRule,
  type ReadGraphModes,
  type ReadGraphStoreConfig,
  type ViewSemantics,
  type ViewSemanticsSettings,
} from '@origintrail-official/dkg-storage';
import type { ReadGraphSettingsEntry, ReadGraphSettingsStore } from './read-graph-settings-store.js';

/** Cross-agent query access policy for inbound query-remote requests (`queryAccess` in config.json). */
export interface QueryAccessConfig {
  defaultPolicy: 'deny' | 'public';
  contextGraphs?: Record<string, {
    policy: 'deny' | 'public' | 'allowList';
    allowedPeers?: string[];
    allowedLookupTypes?: Array<'ENTITY_BY_UAL' | 'ENTITIES_BY_TYPE' | 'ENTITY_TRIPLES' | 'SPARQL_QUERY'>;
    sparqlEnabled?: boolean;
    sparqlTimeout?: number;
    sparqlMaxResults?: number;
  }>;
  rateLimitPerMinute?: number;
}

/** Modes per layer, by view name, over a default. */
export interface ReadGraphRuleInput {
  default?: ReadGraphMode;
  layers?: Partial<Record<GetView, ReadGraphMode>>;
}

/** `query.readGraphs` as written: one mode, or the node's rule with rules per context graph. */
export type ReadGraphsInput = ReadGraphMode | (ReadGraphRuleInput & { contextGraphs?: Record<string, ReadGraphMode | ReadGraphRuleInput> });

/** `query.viewSemantics` as written: one value, or the node's default with values per context graph. */
export type ViewSemanticsInput = ViewSemantics | { default?: ViewSemantics; contextGraphs?: Record<string, ViewSemantics> };

/** `query.readGraphsPolicy` as written: a kill switch, and the layers that may keep read graphs. */
export interface ReadGraphsPolicyInput {
  enabled?: boolean;
  layers?: GetView[];
}

/** The `query` section as written in config.json. */
export interface QueryConfigInput {
  readGraphs?: ReadGraphsInput;
  viewSemantics?: ViewSemanticsInput;
  readGraphsPolicy?: ReadGraphsPolicyInput;
}

/** The read-graph settings in force: config.json's policy over the settings table. Every store object over the node's backend carries them. */
export interface ResolvedQueryConfig {
  readonly readGraphs: ReadGraphModes;
  readonly viewSemantics: ViewSemanticsSettings;
}

/** `query.readGraphsPolicy`, resolved: whether a read graph may be kept at all, and on which layers. */
export interface ReadGraphsPolicy {
  readonly enabled: boolean;
  readonly layers: readonly GetView[];
}

/** The node-wide part of the `query` section, which stays in config.json. */
export interface QueryPolicy {
  /** The node's default mode and its modes per layer: `query.readGraphs` without `contextGraphs`. */
  readonly readGraphs: ReadGraphModeRule;
  /** The node's default: `query.viewSemantics` without `contextGraphs`. */
  readonly viewSemantics: ViewSemanticsSettings;
  readonly readGraphsPolicy: ReadGraphsPolicy;
}

/** The `query` section, resolved and validated. */
export interface QuerySection {
  readonly policy: QueryPolicy;
  /**
   * config.json's deprecated rules for single context graphs, as entries of the settings table, where a context graph's default becomes its mode for each
   * layer. The daemon imports them once.
   */
  readonly contextGraphSettings: readonly ReadGraphSettingsEntry[];
  /** The deprecated keys that hold such rules, for the warning. */
  readonly deprecatedKeys: readonly string[];
}

export type ReadGraphsRefusalCode =
  | 'READ_GRAPHS_DISABLED'
  | 'READ_GRAPHS_LAYER_NOT_ALLOWED'
  | 'READ_GRAPHS_UNSUPPORTED'
  | 'READ_GRAPHS_CHECKPOINT_NODE'
  | 'READ_GRAPHS_ROLLBACK_TARGET_OLDER';

/** Why a read graph may not be kept: the policy, or something about the node. */
export interface ReadGraphsRefusal {
  readonly code: ReadGraphsRefusalCode;
  /** The reason, as the end of a sentence for the operator ("… are off: <message>"). */
  readonly message: string;
  /** For `READ_GRAPHS_ROLLBACK_TARGET_OLDER`: what a rollback would activate. */
  readonly rollbackTarget?: { readonly source: string; readonly version: string | null };
  /** For `READ_GRAPHS_ROLLBACK_TARGET_OLDER`: the first release that recognizes read graphs. */
  readonly firstRecognizingRelease?: string;
}

/**
 * What the node knows when it resolves its settings: each refusal that holds for every context graph (the store's support, a public checkpoint, the
 * rollback target), in the order of the checks.
 */
export interface StartChecks {
  readonly refusals: readonly ReadGraphsRefusal[];
}

export interface QueryConfigIssue {
  /** The offending key, as written in config.json (`query.readGraphs.layers.wm`). */
  readonly key: string;
  readonly message: string;
}

/** One error for the whole section: every offending key is named. */
export class QueryConfigError extends Error {
  readonly code = 'QUERY_CONFIG_INVALID';
  constructor(readonly issues: readonly QueryConfigIssue[]) {
    super(`invalid query configuration: ${issues.map((issue) => `${issue.key} ${issue.message}`).join('; ')}`);
    this.name = 'QueryConfigError';
  }
}

const SECTION = 'query';
const LAYER_OF_VIEW: Readonly<Record<GetView, MemoryLayer>> = Object.freeze({
  'working-memory': MemoryLayer.WorkingMemory,
  'shared-working-memory': MemoryLayer.SharedWorkingMemory,
  'verifiable-memory': MemoryLayer.VerifiableMemory,
});

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The offending value as written, short enough for one log line. */
function shown(value: unknown): string {
  let text: string | undefined;
  try { text = JSON.stringify(value); } catch { /* an unprintable value is described by its type below */ }
  const out = text ?? typeof value;
  return out.length > 40 ? `${out.slice(0, 37)}...` : out;
}

const quoted = (values: readonly string[]): string => values.map((value) => `"${value}"`).join(', ');

class Collector {
  readonly issues: QueryConfigIssue[] = [];
  add(key: string, message: string): void { this.issues.push({ key, message }); }

  /** A plain object whose keys are all recognised; undefined (with issues recorded) otherwise. */
  object(value: unknown, key: string, recognised: readonly string[]): Record<string, unknown> | undefined {
    if (!isRecord(value)) { this.add(key, `must be an object (got ${shown(value)})`); return undefined; }
    for (const name of Object.keys(value)) {
      if (!recognised.includes(name)) this.add(`${key}.${name}`, `is not a recognised setting (recognised: ${recognised.join(', ')})`);
    }
    return value;
  }

  /** One of `values`, or undefined (with an issue recorded) for anything else. */
  oneOf<T extends string>(value: unknown, key: string, values: readonly T[]): T | undefined {
    if (typeof value === 'string' && (values as readonly string[]).includes(value)) return value as T;
    this.add(key, `must be one of ${quoted(values)} (got ${shown(value)})`);
    return undefined;
  }

  /** The context graphs of a section, keyed by ID: each ID must be one that can have read graphs. */
  contextGraphs<T>(value: unknown, key: string, entry: (raw: unknown, key: string) => T | undefined): Record<string, T> | undefined {
    if (value === undefined) return undefined;
    if (!isRecord(value)) { this.add(key, `must be an object keyed by context graph ID (got ${shown(value)})`); return undefined; }
    const resolved: Record<string, T> = Object.create(null) as Record<string, T>;
    for (const [id, raw] of Object.entries(value)) {
      const entryKey = `${key}.${id}`;
      if (!isReadGraphEligibleContextGraphId(id)) {
        this.add(entryKey, 'is not a context graph ID that can have read graphs');
        continue;
      }
      const result = entry(raw, entryKey);
      if (result !== undefined) resolved[id] = result;
    }
    return Object.freeze(resolved);
  }

  /** A mode, or a rule with a default and modes per layer. */
  rule(value: unknown, key: string): ReadGraphModeRule | undefined {
    if (typeof value === 'string') {
      const mode = this.oneOf(value, key, READ_GRAPH_MODES);
      return mode === undefined ? undefined : Object.freeze({ default: mode });
    }
    const raw = this.object(value, key, ['default', 'layers']);
    if (raw === undefined) return undefined;
    return this.ruleFields(raw, key);
  }

  ruleFields(raw: Record<string, unknown>, key: string): ReadGraphModeRule {
    const rule: { default?: ReadGraphMode; layers?: Partial<Record<MemoryLayer, ReadGraphMode>> } = {};
    if (raw['default'] !== undefined) rule.default = this.oneOf(raw['default'], `${key}.default`, READ_GRAPH_MODES);
    if (raw['layers'] !== undefined) {
      const layers = this.object(raw['layers'], `${key}.layers`, GET_VIEWS);
      if (layers !== undefined) {
        const resolved: Partial<Record<MemoryLayer, ReadGraphMode>> = {};
        for (const view of GET_VIEWS) {
          if (layers[view] === undefined) continue;
          const mode = this.oneOf(layers[view], `${key}.layers.${view}`, READ_GRAPH_MODES);
          if (mode !== undefined) resolved[LAYER_OF_VIEW[view]] = mode;
        }
        rule.layers = Object.freeze(resolved);
      }
    }
    return Object.freeze(rule);
  }

  readGraphs(value: unknown, key: string): ReadGraphModes {
    if (value === undefined) return READ_GRAPHS_OFF;
    if (typeof value === 'string') {
      const mode = this.oneOf(value, key, READ_GRAPH_MODES);
      return mode === undefined ? READ_GRAPHS_OFF : Object.freeze({ default: mode });
    }
    const raw = this.object(value, key, ['default', 'layers', 'contextGraphs']);
    if (raw === undefined) return READ_GRAPHS_OFF;
    const contextGraphs = this.contextGraphs(raw['contextGraphs'], `${key}.contextGraphs`, (entry, entryKey) => this.rule(entry, entryKey));
    return Object.freeze({ ...this.ruleFields(raw, key), ...(contextGraphs === undefined ? {} : { contextGraphs }) });
  }

  viewSemantics(value: unknown, key: string): ViewSemanticsSettings {
    if (value === undefined) return PER_ASSET;
    if (typeof value === 'string') {
      const semantics = this.oneOf(value, key, VIEW_SEMANTICS);
      return semantics === undefined ? PER_ASSET : Object.freeze({ default: semantics });
    }
    const raw = this.object(value, key, ['default', 'contextGraphs']);
    if (raw === undefined) return PER_ASSET;
    const settings: { default?: ViewSemantics; contextGraphs?: Record<string, ViewSemantics> } = {};
    if (raw['default'] !== undefined) settings.default = this.oneOf(raw['default'], `${key}.default`, VIEW_SEMANTICS);
    const contextGraphs = this.contextGraphs(raw['contextGraphs'], `${key}.contextGraphs`,
      (entry, entryKey) => this.oneOf(entry, entryKey, VIEW_SEMANTICS));
    if (contextGraphs !== undefined) settings.contextGraphs = contextGraphs;
    return Object.freeze(settings);
  }

  readGraphsPolicy(value: unknown, key: string): ReadGraphsPolicy {
    if (value === undefined) return OPEN_POLICY;
    const raw = this.object(value, key, ['enabled', 'layers']);
    if (raw === undefined) return OPEN_POLICY;
    let enabled = true;
    if (raw['enabled'] !== undefined) {
      if (typeof raw['enabled'] === 'boolean') enabled = raw['enabled'];
      else this.add(`${key}.enabled`, `must be true or false (got ${shown(raw['enabled'])})`);
    }
    let layers: readonly GetView[] = OPEN_POLICY.layers;
    if (raw['layers'] !== undefined) {
      if (!Array.isArray(raw['layers'])) {
        this.add(`${key}.layers`, `must be a list of layers, each one of ${quoted(GET_VIEWS)} (got ${shown(raw['layers'])})`);
      } else {
        const listed = new Set<GetView>();
        raw['layers'].forEach((entry: unknown, index: number) => {
          const view = this.oneOf(entry, `${key}.layers[${index}]`, GET_VIEWS);
          if (view !== undefined) listed.add(view);
        });
        layers = Object.freeze(GET_VIEWS.filter((view) => listed.has(view)));
      }
    }
    return Object.freeze({ enabled, layers });
  }
}

/** No read graphs: the settings of a node without `query.readGraphs`. */
const READ_GRAPHS_OFF: ReadGraphModes = Object.freeze({ default: 'off' });
const PER_ASSET: ViewSemanticsSettings = Object.freeze({ default: 'per-asset' });
/** The policy of a node without `query.readGraphsPolicy`: read graphs may be kept on every layer. */
const OPEN_POLICY: ReadGraphsPolicy = Object.freeze({ enabled: true, layers: Object.freeze([...GET_VIEWS]) });
/** At most this many settings are named in one warning. */
const NAMED_PER_WARNING = 10;

/**
 * Resolve and validate the `query` section (`undefined` = every default: no read graphs, per-asset matching, read graphs allowed on every layer). Throws
 * one `QueryConfigError` naming every offending key; never falls back to a default for a value that was written.
 */
export function resolveQuerySection(input: unknown): QuerySection {
  const c = new Collector();
  const top = input === undefined ? {} : c.object(input, SECTION, ['readGraphs', 'viewSemantics', 'readGraphsPolicy']) ?? {};
  const { contextGraphs: rules, ...nodeModes } = c.readGraphs(top['readGraphs'], `${SECTION}.readGraphs`);
  const { contextGraphs: semantics, ...nodeSemantics } = c.viewSemantics(top['viewSemantics'], `${SECTION}.viewSemantics`);
  const readGraphsPolicy = c.readGraphsPolicy(top['readGraphsPolicy'], `${SECTION}.readGraphsPolicy`);
  if (c.issues.length > 0) throw new QueryConfigError(c.issues);
  const written = (record: object | undefined) => record !== undefined && Object.keys(record).length > 0;
  return Object.freeze({
    policy: Object.freeze({ readGraphs: Object.freeze(nodeModes), viewSemantics: Object.freeze(nodeSemantics), readGraphsPolicy }),
    contextGraphSettings: settingsOfContextGraphRules(rules ?? {}, semantics ?? {}),
    deprecatedKeys: Object.freeze([
      ...(written(rules) ? [`${SECTION}.readGraphs.contextGraphs`] : []),
      ...(written(semantics) ? [`${SECTION}.viewSemantics.contextGraphs`] : []),
    ]),
  });
}

/** config.json's rules for single context graphs as table entries: a context graph's default becomes its mode for each layer without one. */
function settingsOfContextGraphRules(
  rules: Readonly<Record<string, ReadGraphModeRule>>,
  semantics: Readonly<Record<string, ViewSemantics>>,
): readonly ReadGraphSettingsEntry[] {
  const ids = [...new Set([...Object.keys(rules), ...Object.keys(semantics)])].sort();
  return Object.freeze(ids.map((contextGraphId): ReadGraphSettingsEntry => {
    const rule = ownEntry(rules, contextGraphId);
    const layers: Partial<Record<GetView, ReadGraphMode>> = {};
    for (const view of GET_VIEWS) {
      const mode = rule?.layers?.[LAYER_OF_VIEW[view]] ?? rule?.default;
      if (mode !== undefined) layers[view] = mode;
    }
    const viewSemantics = ownEntry(semantics, contextGraphId);
    return Object.freeze({ contextGraphId, layers: Object.freeze(layers), ...(viewSemantics === undefined ? {} : { viewSemantics }) });
  }));
}

/** The node's own modes with its policy applied: all `off` when the policy is off, and `off` on each layer it does not allow. */
export function nodeReadGraphModes(policy: QueryPolicy): ReadGraphModes {
  const { enabled, layers } = policy.readGraphsPolicy;
  if (!enabled) return READ_GRAPHS_OFF;
  const closed = GET_VIEWS.filter((view) => !layers.includes(view));
  if (closed.length === 0) return policy.readGraphs;
  const off: Partial<Record<MemoryLayer, ReadGraphMode>> = Object.fromEntries(closed.map((view) => [LAYER_OF_VIEW[view], 'off']));
  return Object.freeze({ ...policy.readGraphs, layers: Object.freeze({ ...policy.readGraphs.layers, ...off }) });
}

/** Why the policy does not let a layer keep read graphs, or `undefined` when it does. */
export function policyRefusalOf(policy: ReadGraphsPolicy, view: GetView): ReadGraphsRefusal | undefined {
  if (!policy.enabled) return { code: 'READ_GRAPHS_DISABLED', message: 'query.readGraphsPolicy.enabled is false in config.json' };
  if (!policy.layers.includes(view)) {
    return { code: 'READ_GRAPHS_LAYER_NOT_ALLOWED', message: `query.readGraphsPolicy.layers in config.json does not allow ${view}` };
  }
  return undefined;
}

/**
 * The settings in force: config.json's policy over the settings table, as the store configuration carries them. A mode in the table that the policy or
 * the node does not allow resolves to `off`, with one warning for each reason that names the settings. A table that cannot be read gives no setting for
 * any context graph, with a warning: the table never stops a start.
 */
export function resolveEffectiveQueryConfig(
  policy: QueryPolicy,
  store: Pick<ReadGraphSettingsStore, 'list'>,
  checks: StartChecks,
): { config: ResolvedQueryConfig; warnings: string[] } {
  const warnings: string[] = [];
  let entries: ReadonlyArray<ReadGraphSettingsEntry> = [];
  try {
    entries = store.list();
  } catch (error) {
    warnings.push(`the read-graph settings table cannot be read, so no context graph has settings of its own: ${messageOf(error)}`);
  }
  const offBy = new Map<string, string[]>();
  const off = (reason: string, setting: string) => offBy.set(reason, [...offBy.get(reason) ?? [], setting]);
  const modes: Record<string, ReadGraphModeRule> = Object.create(null) as Record<string, ReadGraphModeRule>;
  const semantics: Record<string, ViewSemantics> = Object.create(null) as Record<string, ViewSemantics>;
  for (const { contextGraphId, layers: setModes, viewSemantics } of entries) {
    if (!isReadGraphEligibleContextGraphId(contextGraphId)) {
      off('it is not a context graph ID that can have read graphs', contextGraphId);
      continue;
    }
    if (viewSemantics !== undefined) semantics[contextGraphId] = viewSemantics;
    const layers: Partial<Record<MemoryLayer, ReadGraphMode>> = {};
    for (const view of GET_VIEWS) {
      const mode = setModes[view];
      if (mode === undefined) continue;
      const refusal = mode === 'off' ? undefined : policyRefusalOf(policy.readGraphsPolicy, view) ?? checks.refusals[0];
      if (refusal !== undefined) off(refusal.message, `${contextGraphId} (${view})`);
      layers[LAYER_OF_VIEW[view]] = refusal === undefined ? mode : 'off';
    }
    if (Object.keys(layers).length > 0) modes[contextGraphId] = Object.freeze({ layers: Object.freeze(layers) });
  }
  for (const [reason, settings] of offBy) warnings.push(`read graphs set for ${named(settings)} are off: ${reason}`);
  const node = nodeReadGraphModes(policy);
  return {
    config: Object.freeze({
      readGraphs: Object.keys(modes).length === 0 ? node : Object.freeze({ ...node, contextGraphs: Object.freeze(modes) }),
      viewSemantics: Object.keys(semantics).length === 0
        ? policy.viewSemantics
        : Object.freeze({ ...policy.viewSemantics, contextGraphs: Object.freeze(semantics) }),
    }),
    warnings,
  };
}

function named(settings: readonly string[]): string {
  const shownSettings = settings.slice(0, NAMED_PER_WARNING).join(', ');
  return settings.length > NAMED_PER_WARNING ? `${shownSettings} and ${settings.length - NAMED_PER_WARNING} more` : shownSettings;
}

/** A record's own entry, so that an ID such as `constructor` names nothing the record inherits. */
function ownEntry<V>(record: Readonly<Record<string, V>>, key: string): V | undefined {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The read-graph part of a store configuration for these settings, carried by every store object the node builds over its backend. */
export function readGraphStoreSettings(config: ResolvedQueryConfig): ReadGraphStoreConfig {
  return Object.freeze({ modes: config.readGraphs, viewSemantics: config.viewSemantics });
}
