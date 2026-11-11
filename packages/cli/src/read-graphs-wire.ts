// The operator-only read-graph commands of a running node (`dkg store
// read-graphs`): requests and answers shared by the daemon routes and the CLI.

import { validateContextGraphId } from '@origintrail-official/dkg-core';

export const READ_GRAPHS_PATH = '/api/store/read-graphs';
/** A full check of a large context graph can take minutes; the client waits this long. */
export const READ_GRAPHS_REQUEST_TIMEOUT_MS = 30 * 60_000;

export const READ_GRAPHS_ACTIONS = ['status', 'check', 'rebuild', 'drop'] as const;
export type ReadGraphsAction = (typeof READ_GRAPHS_ACTIONS)[number];
export const READ_GRAPH_LAYER_LABELS = ['wm', 'swm', 'vm'] as const;
export type ReadGraphLayerLabel = (typeof READ_GRAPH_LAYER_LABELS)[number];
export const READ_GRAPH_CHECK_MODES = ['full', 'sampled'] as const;
export type ReadGraphCheckModeLabel = (typeof READ_GRAPH_CHECK_MODES)[number];

/**
 * What an action applies to. `status`, `rebuild` and `drop` take every read
 * graph, or those of one context graph, one layer, or both; `check` takes
 * every ready read graph, and a mode.
 */
export interface ReadGraphsRequest {
  readonly contextGraphId?: string;
  readonly layer?: ReadGraphLayerLabel;
  /** For `check` only; `full` when absent. */
  readonly mode?: ReadGraphCheckModeLabel;
}

/** One read graph as the node holds it. */
export interface ReadGraphView {
  readonly readGraph: string;
  readonly contextGraphId: string;
  readonly subGraphName?: string;
  readonly layer: ReadGraphLayerLabel;
  readonly agentAddress?: string;
  readonly state: string;
  readonly generation: number;
}

/** A check of every ready read graph, run on request. */
export interface ReadGraphsCheckAnswer {
  readonly mode: ReadGraphCheckModeLabel;
  /** When the check ended, in milliseconds since the epoch. */
  readonly at: number;
  /** `outcome` is `consistent`, `mismatch`, `skipped` or `interrupted`; a mismatch has a `direction`, `missing` or `unheld`. */
  readonly results: readonly { readonly readGraph: string; readonly outcome: string; readonly direction?: string }[];
}

/** What the node's read-graph builder does. */
export interface ReadGraphsBuilderView {
  readonly running: boolean;
  /** The read graph of the job in progress. */
  readonly building?: string;
  /** Read graphs the last pass found to build, the one in progress included. */
  readonly pending: number;
  readonly retrying: readonly { readonly readGraph: string; readonly attempts: number; readonly retryAt: number; readonly error?: string }[];
  readonly lastJob?: { readonly readGraph: string; readonly kind: string; readonly outcome: string; readonly durationMs?: number };
}

export interface ReadGraphsStatusAnswer {
  readonly readGraphs: readonly ReadGraphView[];
  /** The read graphs listed, by state. */
  readonly states: Readonly<Record<string, number>>;
  /** Absent while the builder does not run. */
  readonly builder?: ReadGraphsBuilderView;
  /** Whether the node's background checks run. */
  readonly checking: boolean;
  /** The last check run on request. */
  readonly lastCheck?: ReadGraphsCheckAnswer;
}

export interface ReadGraphsRebuildAnswer {
  /** The read graphs marked dirty, which the node's builder rebuilds at its next pass. */
  readonly marked: readonly { readonly readGraph: string; readonly state?: string; readonly error?: string }[];
}

export interface ReadGraphsDropAnswer {
  /** `done`: removed; `current`: nothing to remove; `lost`: a newer change overtook the removal; or `error`. */
  readonly removed: readonly { readonly readGraph: string; readonly outcome: string; readonly error?: string }[];
}

export type ReadGraphsRequestParse = { readonly request: ReadGraphsRequest } | { readonly error: string };

const FIELDS: Readonly<Record<ReadGraphsAction, readonly string[]>> = {
  status: ['contextGraphId', 'layer'],
  check: ['mode'],
  rebuild: ['contextGraphId', 'layer'],
  drop: ['contextGraphId', 'layer'],
};

/**
 * Check a request: `contextGraphId` a valid context-graph ID, `layer` one of
 * wm, swm and vm, and `mode` full or sampled, each only where the action
 * takes it. Anything else is refused.
 */
export function parseReadGraphsRequest(action: ReadGraphsAction, raw: unknown): ReadGraphsRequestParse {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: 'The read-graphs request must be a JSON object, for example {"contextGraphId": "my-graph"}.' };
  }
  const fields = FIELDS[action];
  const unknown = Object.keys(raw).find((key) => !fields.includes(key));
  if (unknown !== undefined) return { error: `Unknown field "${unknown}" for ${action}; it takes ${fields.join(', ')}.` };
  const { contextGraphId, layer, mode } = raw as Record<string, unknown>;
  if (contextGraphId !== undefined) {
    if (typeof contextGraphId !== 'string') return { error: 'contextGraphId must be a string.' };
    const validation = validateContextGraphId(contextGraphId);
    if (!validation.valid) return { error: `Invalid contextGraphId: ${validation.reason}` };
  }
  if (layer !== undefined && !(READ_GRAPH_LAYER_LABELS as readonly unknown[]).includes(layer)) {
    return { error: `layer must be one of ${READ_GRAPH_LAYER_LABELS.join(', ')}.` };
  }
  if (mode !== undefined && !(READ_GRAPH_CHECK_MODES as readonly unknown[]).includes(mode)) {
    return { error: `mode must be one of ${READ_GRAPH_CHECK_MODES.join(', ')}.` };
  }
  return {
    request: {
      ...(contextGraphId === undefined ? {} : { contextGraphId: contextGraphId as string }),
      ...(layer === undefined ? {} : { layer: layer as ReadGraphLayerLabel }),
      ...(mode === undefined ? {} : { mode: mode as ReadGraphCheckModeLabel }),
    },
  };
}

/** The query string of a `status` request. */
export function readGraphsStatusPath(request: ReadGraphsRequest = {}): string {
  const query = new URLSearchParams();
  if (request.contextGraphId !== undefined) query.set('contextGraphId', request.contextGraphId);
  if (request.layer !== undefined) query.set('layer', request.layer);
  const text = query.toString();
  return text ? `${READ_GRAPHS_PATH}?${text}` : READ_GRAPHS_PATH;
}
