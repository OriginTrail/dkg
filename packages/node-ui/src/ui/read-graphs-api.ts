// A context graph's read-graph settings, which only the node admin reads and
// changes: `GET` and `PUT /api/store/read-graphs/settings`. Every answer is
// decoded here, so the panel never reads the node's JSON itself.

import type { GetView } from '@origintrail-official/dkg-core';
import { HttpError, authHeaders, getBoundedJson, requestLongMutation } from './http.js';

export const READ_GRAPH_SETTINGS_PATH = '/api/store/read-graphs/settings';

export type ReadGraphMode = 'off' | 'build' | 'serve';
export const READ_GRAPH_MODES: readonly ReadGraphMode[] = ['off', 'build', 'serve'];

/** The layers in the order the panel lists them. */
export const READ_GRAPH_VIEWS: readonly GetView[] = ['working-memory', 'shared-working-memory', 'verifiable-memory'];

/** The node reads its read-graph states from the store, which can take a while on a busy node. */
const SETTINGS_READ_TIMEOUT_MS = 30_000;

/** The read-graph status names a layer by its short label. */
const LAYER_OF_LABEL: Readonly<Record<string, GetView>> = {
  wm: 'working-memory',
  swm: 'shared-working-memory',
  vm: 'verifiable-memory',
};

/** One layer of a context graph. */
export interface ReadGraphLayerSettings {
  readonly view: GetView;
  /** The mode in force; `undefined` when the node did not say. */
  readonly mode?: ReadGraphMode;
  /** Whether the mode is set for this context graph, rather than coming from the node's config. */
  readonly setHere: boolean;
  /** Whether the node's policy lets this layer keep read graphs. */
  readonly allowed: boolean;
  /** How many of the layer's read graphs are in each state, for example `{ ready: 1 }`. */
  readonly states: Readonly<Record<string, number>>;
}

export interface ReadGraphSettings {
  readonly contextGraphId: string;
  /** False when the node's config switches read graphs off for every context graph. */
  readonly enabled: boolean;
  /** Why this node can't switch a layer on, when that holds for every layer. */
  readonly refused?: { readonly code?: string; readonly error: string };
  /** One entry per layer, in {@link READ_GRAPH_VIEWS} order. */
  readonly layers: readonly ReadGraphLayerSettings[];
}

/** `hidden`: the caller isn't the node admin, or the node has no settings to show. */
export type ReadGraphSettingsLoad = { readonly kind: 'hidden' } | { readonly kind: 'settings'; readonly settings: ReadGraphSettings };

function objectOf(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function modeOf(value: unknown): ReadGraphMode | undefined {
  return READ_GRAPH_MODES.find(mode => mode === value);
}

function viewOf(value: unknown): GetView | undefined {
  return READ_GRAPH_VIEWS.find(view => view === value) ?? (typeof value === 'string' ? LAYER_OF_LABEL[value] : undefined);
}

/**
 * Decode a settings answer for one context graph. Fields this page doesn't
 * know are ignored, and a field the node left out shows as unknown: without
 * `effective`, the rows alone give the modes.
 */
export function decodeReadGraphSettings(body: unknown, contextGraphId: string): ReadGraphSettings {
  const answer = objectOf(body) ?? {};
  const policy = objectOf(answer.policy);
  const allowedLayers = Array.isArray(policy?.layers) ? policy.layers.map(viewOf) : undefined;
  const refused = objectOf(answer.refused);
  const entry = (Array.isArray(answer.contextGraphs) ? answer.contextGraphs : [])
    .map(objectOf)
    .find(candidate => candidate?.contextGraphId === contextGraphId);
  const rows = objectOf(entry?.layers);
  const effective = objectOf(objectOf(entry?.effective)?.layers);
  const states = new Map<GetView, Record<string, number>>(READ_GRAPH_VIEWS.map(view => [view, {}]));
  for (const readGraph of Array.isArray(entry?.readGraphs) ? entry.readGraphs : []) {
    const row = objectOf(readGraph);
    const view = viewOf(row?.layer);
    const state = row?.state;
    if (view === undefined || typeof state !== 'string' || state === '') continue;
    const counts = states.get(view)!;
    counts[state] = (counts[state] ?? 0) + 1;
  }
  return {
    contextGraphId,
    enabled: policy?.enabled !== false,
    ...(typeof refused?.error === 'string'
      ? { refused: { error: refused.error, ...(typeof refused.code === 'string' ? { code: refused.code } : {}) } }
      : {}),
    layers: READ_GRAPH_VIEWS.map(view => {
      const setHere = modeOf(rows?.[view]);
      const mode = modeOf(effective?.[view]) ?? setHere;
      return {
        view,
        ...(mode === undefined ? {} : { mode }),
        setHere: setHere !== undefined,
        allowed: allowedLayers === undefined || allowedLayers.includes(view),
        states: states.get(view)!,
      };
    }),
  };
}

/** The settings of one context graph, or `hidden` for a caller who isn't the node admin (403) or a node without them (404). */
export async function fetchReadGraphSettings(contextGraphId: string): Promise<ReadGraphSettingsLoad> {
  try {
    const path = `${READ_GRAPH_SETTINGS_PATH}?contextGraphId=${encodeURIComponent(contextGraphId)}`;
    const body = await getBoundedJson<unknown>(path, SETTINGS_READ_TIMEOUT_MS);
    return { kind: 'settings', settings: decodeReadGraphSettings(body, contextGraphId) };
  } catch (error) {
    if (error instanceof HttpError && (error.status === 403 || error.status === 404)) return { kind: 'hidden' };
    throw error;
  }
}

/**
 * Set one layer's mode for a context graph, and answer the settings after the
 * node applied it. A refusal throws an {@link HttpError} whose message is the
 * node's own sentence for the operator.
 */
export async function setReadGraphMode(contextGraphId: string, view: GetView, mode: ReadGraphMode): Promise<ReadGraphSettings> {
  const body = await requestLongMutation<unknown>(READ_GRAPH_SETTINGS_PATH, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ contextGraphId, layers: { [view]: mode } }),
  }, 'The node did not answer in time. The change may still apply: refresh to see the current settings.');
  return decodeReadGraphSettings(body, contextGraphId);
}
