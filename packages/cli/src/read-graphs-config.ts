/**
 * Query settings of config.json: `queryAccess` (who may query this node) and the `query` section (OT-RFC-74), which sets where the node keeps read graphs and
 * what a view query without `semantics` gets.
 *
 *   "query": {
 *     "readGraphs": "off",
 *     "viewSemantics": "per-asset"
 *   }
 *
 * `readGraphs` is a mode: `off` (no read graphs, the default), `build` (read graphs are built, maintained and checked, and no query reads them) or `serve`
 * (merged view queries read them). It can also be an object with a node default, modes per layer, and rules per context graph:
 *
 *   "readGraphs": {
 *     "default": "off",
 *     "layers": { "verifiable-memory": "build" },
 *     "contextGraphs": { "my-project": "serve", "notes": { "layers": { "working-memory": "off" } } }
 *   }
 *
 * The most specific setting wins: a context graph's mode for the layer, then its default, then the node's mode for the layer, then the node's default. Layers
 * have the names `/api/query` gives views, and a context graph is named by its ID, as in `/api/query`.
 *
 * `viewSemantics` is `per-asset` (the default: every pattern matches inside one asset graph) or `merged`, for the node or per context graph:
 *
 *   "viewSemantics": { "default": "per-asset", "contextGraphs": { "my-project": "merged" } }
 *
 * A query that asks for `semantics` gets what it asks for; `merged` is answered only where read graphs are served.
 *
 * Validation is loud, as for `queueRetention`: `resolveQueryConfig` collects every problem into one `QueryConfigError` that names each key, and an unknown key
 * is an error. The daemon also refuses read graphs that the release it would roll back to does not recognize (`update/read-graph-rollback-target.ts`).
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

/** The `query` section as written in config.json. */
export interface QueryConfigInput {
  readGraphs?: ReadGraphsInput;
  viewSemantics?: ViewSemanticsInput;
}

export interface ResolvedQueryConfig {
  readonly readGraphs: ReadGraphModes;
  readonly viewSemantics: ViewSemanticsSettings;
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
}

/** No read graphs: the settings of a node without `query.readGraphs`. */
const READ_GRAPHS_OFF: ReadGraphModes = Object.freeze({ default: 'off' });
const PER_ASSET: ViewSemanticsSettings = Object.freeze({ default: 'per-asset' });

/**
 * Resolve and validate the `query` section (`undefined` = every default: no read graphs, per-asset matching). Throws one `QueryConfigError` naming every
 * offending key; never falls back to a default for a value that was written.
 */
export function resolveQueryConfig(input: unknown): ResolvedQueryConfig {
  const c = new Collector();
  const top = input === undefined ? {} : c.object(input, SECTION, ['readGraphs', 'viewSemantics']) ?? {};
  const resolved: ResolvedQueryConfig = Object.freeze({
    readGraphs: c.readGraphs(top['readGraphs'], `${SECTION}.readGraphs`),
    viewSemantics: c.viewSemantics(top['viewSemantics'], `${SECTION}.viewSemantics`),
  });
  if (c.issues.length > 0) throw new QueryConfigError(c.issues);
  return resolved;
}

/** The read-graph part of a store configuration for these settings, carried by every store object the node builds over its backend. */
export function readGraphStoreSettings(config: ResolvedQueryConfig): ReadGraphStoreConfig {
  return Object.freeze({ modes: config.readGraphs, viewSemantics: config.viewSemantics });
}
