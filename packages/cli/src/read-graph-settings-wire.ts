// The node-admin settings of search across assets (read graphs) per context graph: the requests and answers of
// `GET` and `PUT /api/store/read-graphs/settings`, shared by the daemon routes, the CLI and the agent tools. The API
// keeps the engine values (`off`, `build`, `serve`); the words for users are below.

import { GET_VIEWS, isReadGraphEligibleContextGraphId, type GetView } from '@origintrail-official/dkg-core';
import type { ReadGraphMode, ReadGraphModeChange, ViewSemantics } from '@origintrail-official/dkg-storage';
import { READ_GRAPHS_PATH, type ReadGraphView } from './read-graphs-wire.js';

export const READ_GRAPH_SETTINGS_PATH = `${READ_GRAPHS_PATH}/settings`;
/** Who asks for a change, for the settings table's `updated_by`: `cli`, `ui` or `agent:<id>`; `api` without the header. */
export const READ_GRAPH_SETTINGS_ACTOR_HEADER = 'x-dkg-actor';

const MODES: readonly ReadGraphMode[] = ['off', 'build', 'serve'];
const SEMANTICS: readonly ViewSemantics[] = ['per-asset', 'merged'];

/** What users call a mode. */
export const READ_GRAPH_MODE_WORDS: Readonly<Record<ReadGraphMode, string>> = { off: 'Off', build: 'Preview', serve: 'On' };
/** What users call a memory layer, as a label. */
export const MEMORY_WORDS: Readonly<Record<GetView, string>> = {
  'verifiable-memory': 'Published assets',
  'shared-working-memory': 'Shared memory, shared with your team',
  'working-memory': 'Private drafts',
};
/** What users call a memory layer inside a sentence. */
export const MEMORY_IN_SENTENCES: Readonly<Record<GetView, string>> = {
  'verifiable-memory': 'published assets',
  'shared-working-memory': 'shared memory',
  'working-memory': 'private drafts',
};

/** `PUT …/settings`: one context graph's own settings to set. A layer without a mode keeps its setting. */
export interface ReadGraphSettingsRequest {
  readonly contextGraphId: string;
  readonly layers?: Readonly<Partial<Record<GetView, ReadGraphMode>>>;
  /** `null` removes the context graph's own default, so the node's applies. */
  readonly viewSemantics?: ViewSemantics | null;
}

/** One read graph in a settings answer: as `GET /api/store/read-graphs` lists it, with what its last build in this process found. */
export interface ReadGraphSettingsReadGraph extends ReadGraphView {
  /** From 0 to 1, on the read graph the builder is building. */
  readonly progress?: number;
  /** The triples the read graph held at its last build in this process: writes since then make it drift. */
  readonly triples?: number;
  /** The asset (or draft) graphs its last build in this process found. */
  readonly members?: number;
}

/** One context graph in a settings answer. */
export interface ReadGraphContextGraphSettings {
  readonly contextGraphId: string;
  /** Its own modes, from the settings table: a layer without one is absent. */
  readonly layers: Readonly<Partial<Record<GetView, ReadGraphMode>>>;
  /** Its own view-semantics default, when it has one. */
  readonly viewSemantics?: ViewSemantics;
  /** What is in force: its own settings over the node's, within the node's policy. */
  readonly effective: { readonly layers: Readonly<Record<GetView, ReadGraphMode>>; readonly viewSemantics: ViewSemantics };
  readonly readGraphs: readonly ReadGraphSettingsReadGraph[];
}

/** Why a change is refused, or why the node can switch nothing on. `error` is one sentence for users. */
export interface ReadGraphSettingsRefusal {
  readonly code: string;
  readonly error: string;
  /** For `READ_GRAPHS_ROLLBACK_TARGET_OLDER`. */
  readonly rollbackTarget?: { readonly source: string; readonly version: string | null };
  readonly firstRecognizingRelease?: string;
}

/** `GET …/settings`, and `PUT …/settings` for the context graph it changed, with `changes`. */
export interface ReadGraphSettingsAnswer {
  /** config.json's `query.readGraphsPolicy`. */
  readonly policy: { readonly enabled: boolean; readonly layers: readonly GetView[] };
  /** The node's own modes and default, within the policy: what a context graph without settings of its own gets. */
  readonly node: { readonly layers: Readonly<Record<GetView, ReadGraphMode>>; readonly viewSemantics: ViewSemantics };
  /** Present when the node can switch nothing on: the policy, its store, a public checkpoint or its rollback target. */
  readonly refused?: ReadGraphSettingsRefusal;
  readonly contextGraphs: readonly ReadGraphContextGraphSettings[];
  /** `PUT` only: what the change did to each context graph's layer. */
  readonly changes?: readonly ReadGraphModeChange[];
}

/** The `readGraphs` field of `POST /api/context-graph/create`: the modes to set once the context graph exists. */
export interface ReadGraphCreateSettings {
  readonly layers: Readonly<Partial<Record<GetView, ReadGraphMode>>>;
}

/** The `readGraphs` part of a context graph's creation answer: applied with what it did, or refused with why. */
export type ReadGraphCreateOutcome =
  | { readonly applied: true; readonly changes: readonly ReadGraphModeChange[] }
  | { readonly refused: string; readonly code: string };

export type ReadGraphSettingsRequestParse = { readonly request: ReadGraphSettingsRequest } | { readonly error: string };

/**
 * Check a `PUT` body: `contextGraphId` a context graph ID that can have read graphs, `layers` modes keyed by layer, and
 * `viewSemantics` `merged`, `per-asset` or `null`. It must set at least one of them, and anything else is refused.
 */
export function parseReadGraphSettingsRequest(raw: unknown): ReadGraphSettingsRequestParse {
  const parsed = parseSettingsFields(raw, ['contextGraphId', 'layers', 'viewSemantics']);
  if ('error' in parsed) return parsed;
  const { contextGraphId, layers, viewSemantics } = parsed.fields;
  if (typeof contextGraphId !== 'string' || !isReadGraphEligibleContextGraphId(contextGraphId)) {
    return { error: 'contextGraphId must be the ID of a context graph that can search across assets.' };
  }
  const modes = parseLayers(layers);
  if ('error' in modes) return modes;
  if (viewSemantics !== undefined && viewSemantics !== null && !(SEMANTICS as readonly unknown[]).includes(viewSemantics)) {
    return { error: 'viewSemantics must be "merged", "per-asset" or null.' };
  }
  if (modes.layers === undefined && viewSemantics === undefined) return { error: 'Set layers, viewSemantics or both.' };
  return {
    request: {
      contextGraphId,
      ...(modes.layers === undefined ? {} : { layers: modes.layers }),
      ...(viewSemantics === undefined ? {} : { viewSemantics: viewSemantics as ViewSemantics | null }),
    },
  };
}

/** The `readGraphs` field of `POST /api/context-graph/create`: `{ layers: { [layer]: mode } }`. */
export function parseCreateReadGraphSettings(raw: unknown): ReadGraphCreateSettings | { readonly error: string } {
  const parsed = parseSettingsFields(raw, ['layers']);
  if ('error' in parsed) return { error: `readGraphs: ${parsed.error}` };
  const modes = parseLayers(parsed.fields['layers']);
  if ('error' in modes) return { error: `readGraphs: ${modes.error}` };
  if (modes.layers === undefined) return { error: 'readGraphs: set layers, for example {"layers": {"verifiable-memory": "build"}}.' };
  return { layers: modes.layers };
}

/** The value of the actor header: `cli`, `ui` or `agent:<id>`; `undefined` for anything else. */
export function readGraphSettingsActorOf(header: string | string[] | undefined): string | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  return value !== undefined && /^(?:cli|ui|agent:[^\s\p{Cc}\p{Cf}]{1,256})$/u.test(value) ? value : undefined;
}

function parseSettingsFields(raw: unknown, fields: readonly string[]): { readonly fields: Record<string, unknown> } | { readonly error: string } {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'The settings must be a JSON object.' };
  const unknown = Object.keys(raw).find((key) => !fields.includes(key));
  if (unknown !== undefined) return { error: `Unknown field "${unknown}"; the settings take ${fields.join(', ')}.` };
  return { fields: raw as Record<string, unknown> };
}

function parseLayers(raw: unknown): { readonly layers: Partial<Record<GetView, ReadGraphMode>> | undefined } | { readonly error: string } {
  if (raw === undefined) return { layers: undefined };
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: 'layers must be an object such as {"verifiable-memory": "build"}.' };
  }
  const layers: Partial<Record<GetView, ReadGraphMode>> = {};
  for (const [view, mode] of Object.entries(raw)) {
    if (!(GET_VIEWS as readonly string[]).includes(view)) return { error: `"${view}" is not a memory; use ${GET_VIEWS.join(', ')}.` };
    if (!(MODES as readonly unknown[]).includes(mode)) return { error: `The mode for ${view} must be "off", "build" or "serve".` };
    layers[view as GetView] = mode as ReadGraphMode;
  }
  return Object.keys(layers).length === 0 ? { error: 'layers must name at least one memory.' } : { layers };
}
