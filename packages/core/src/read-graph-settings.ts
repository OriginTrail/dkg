/**
 * The read-graph settings of a running node as the agent tools present them:
 * the node-admin route, the values the tools accept, and the words users see.
 *
 * Users see the feature as "search across assets", with the modes Off,
 * Preview and On. The tools accept only those words; requests and stored
 * values keep the engine values `off`, `build` and `serve`.
 */

/** `GET` lists the settings and `PUT` changes them; both answer only the node admin. */
const READ_GRAPH_SETTINGS_PATH = '/api/store/read-graphs/settings';

/**
 * The header naming who changes a setting, which the node records with it: an
 * agent tool sends `agent:<runtime>` on a `PUT` and on a creation that sets
 * search across assets. Without it the node records `api`.
 */
export function readGraphSettingsActorHeaders(runtime: string): Record<string, string> {
  return { 'X-DKG-Actor': `agent:${runtime}` };
}

const READ_GRAPH_LAYERS = ['verifiable-memory', 'shared-working-memory', 'working-memory'] as const;
export type ReadGraphLayer = (typeof READ_GRAPH_LAYERS)[number];
/** A tool's layer argument: one layer, or all three. */
export const READ_GRAPH_LAYER_INPUTS = [...READ_GRAPH_LAYERS, 'all'] as const;
export type ReadGraphLayerInput = (typeof READ_GRAPH_LAYER_INPUTS)[number];
export type ReadGraphMode = 'off' | 'build' | 'serve';
/** A tool's mode argument, in the words users see. */
export const READ_GRAPH_MODE_INPUTS = ['off', 'preview', 'on'] as const;
export type ReadGraphModeInput = (typeof READ_GRAPH_MODE_INPUTS)[number];
/** The modes a context graph can be created with: Off is the default already. */
export const READ_GRAPH_CREATE_MODE_INPUTS = ['preview', 'on'] as const;
export type ReadGraphModes = Partial<Record<ReadGraphLayer, ReadGraphMode>>;
export type ViewSemantics = 'merged' | 'per-asset';

/** The body of `PUT`. `viewSemantics: null` removes the context graph's own default. */
export interface ReadGraphSettingsChange {
  readonly contextGraphId: string;
  readonly layers?: ReadGraphModes;
  readonly viewSemantics?: ViewSemantics | null;
}

/** The optional `readGraphs` field of `POST /api/context-graph/create`. */
export interface ReadGraphsCreateSetting {
  readonly layers: ReadGraphModes;
}

/** A failed settings request, as an HTTP client reports it; `status` is absent when no answer came. */
export interface ReadGraphSettingsFailure {
  readonly status?: number;
  readonly body?: unknown;
  readonly message: string;
}

const MODE_WORDS: Readonly<Record<ReadGraphMode, string>> = { off: 'Off', build: 'Preview', serve: 'On' };
/** Each memory as a list label… */
const LAYER_WORDS: Readonly<Record<ReadGraphLayer, string>> = {
  'verifiable-memory': 'Published assets',
  'shared-working-memory': 'Shared memory, shared with your team',
  'working-memory': 'Private drafts',
};
/** …and inside a sentence. */
const LAYER_PHRASES: Readonly<Record<ReadGraphLayer, string>> = {
  'verifiable-memory': 'published assets',
  'shared-working-memory': 'shared memory',
  'working-memory': 'private drafts',
};
/** The layer labels `GET /api/store/read-graphs` gives each read graph. */
const LAYER_LABELS: Readonly<Record<string, ReadGraphLayer>> = {
  vm: 'verifiable-memory',
  swm: 'shared-working-memory',
  wm: 'working-memory',
};
const PREVIEW_NOTE = 'Preview shows how results would change before it is turned on.';

export function readGraphSettingsPath(contextGraphId?: string): string {
  return contextGraphId === undefined
    ? READ_GRAPH_SETTINGS_PATH
    : `${READ_GRAPH_SETTINGS_PATH}?${new URLSearchParams({ contextGraphId })}`;
}

/** The engine value of a tool's mode argument: Preview is `build`, On is `serve`. */
export function readGraphModeOf(input: ReadGraphModeInput): ReadGraphMode {
  if (input === 'preview') return 'build';
  if (input === 'on') return 'serve';
  return 'off';
}

/** `mode` for one layer, or for all three. */
export function readGraphModes(layer: ReadGraphLayerInput, mode: ReadGraphMode): ReadGraphModes {
  const layers: readonly ReadGraphLayer[] = layer === 'all' ? READ_GRAPH_LAYERS : [layer];
  return Object.fromEntries(layers.map((name) => [name, mode]));
}

/**
 * A `GET` answer, or a `PUT` answer, in plain words: the node-wide limits,
 * then each context graph's memories with the mode in force and how far its
 * combined copy is, and whether queries search across assets by default.
 * Fields the answer lacks are left out.
 */
export function describeReadGraphSettings(answer: unknown): string {
  const lines: string[] = [];
  const policy = recordOf(answer, 'policy');
  if (policy?.enabled === false) lines.push('Search across assets is switched off for this whole node.');
  const refused = recordOf(answer, 'refused');
  if (refused) lines.push(`This node can't turn search across assets on: ${sentenceOf(refused)}`);
  const node = recordOf(answer, 'node');
  const nodeModes = recordOf(node, 'layers');
  if (nodeModes) {
    const modes = READ_GRAPH_LAYERS.map((layer) => {
      const mode = modeOf(nodeModes[layer]);
      return `${LAYER_WORDS[layer]}: ${mode ? MODE_WORDS[mode] : 'not set'}`;
    });
    if (node?.viewSemantics === 'merged' || node?.viewSemantics === 'per-asset') {
      modes.push(`Queries search across assets: ${node.viewSemantics === 'merged' ? 'On' : 'Off'}`);
    }
    lines.push(`This node's default: ${modes.join(' · ')}.`);
  }
  const allowed = policy && Array.isArray(policy.layers) ? policy.layers as readonly unknown[] : undefined;
  const contextGraphs = arrayOf(answer, 'contextGraphs');
  if (contextGraphs.length === 0) lines.push('No context graph has search across assets set up.');
  for (const contextGraph of contextGraphs) lines.push(...describeContextGraph(contextGraph, allowed));
  return lines.join('\n');
}

/** What a `PUT` did to each memory, one sentence each, or `undefined` when the answer lists no changes. */
export function describeReadGraphChanges(answer: unknown): string | undefined {
  const changes = arrayOf(answer, 'changes');
  return changes.length === 0 ? undefined : changes.map(describeChange).join('\n');
}

/**
 * What a create tool says when the caller asked for search across assets: the
 * node's `readGraphs` outcome, or, when the answer has none, a node from before
 * the setting.
 */
export function describeReadGraphsCreateOutcome(contextGraphId: string, requested: ReadGraphsCreateSetting, outcome: unknown): string {
  const mode = modeOf(Object.values(requested.layers)[0]);
  const where = `${contextGraphId}'s ${phraseList(Object.keys(requested.layers))}`;
  const result = outcome !== null && typeof outcome === 'object' ? outcome as Record<string, unknown> : {};
  if (result.refused !== undefined) {
    const code = typeof result.refused === 'string' && typeof result.code === 'string' ? ` (${result.code})` : '';
    return `Search across assets was not turned on for ${contextGraphId}: ${reasonOf(result.refused)}${code} ` +
      'The context graph was created; search across assets can be turned on later with dkg_read_graphs_set.';
  }
  if (result.applied !== undefined) {
    if (mode === 'serve') return `Turned search across assets on for ${where}.`;
    if (mode === 'build') return `Getting search across assets ready for ${where}. ${PREVIEW_NOTE}`;
    return `Search across assets stays off for ${where}.`;
  }
  return `Search across assets was not turned on for ${contextGraphId}: the node did not apply the setting, so it may run ` +
    'a DKG version from before it. Check with dkg_read_graphs_status.';
}

/**
 * What a tool says when a settings request fails: only the node admin may use
 * these settings (401, 403); a node from before them (404 without a code);
 * otherwise the node's own sentence and code.
 */
export function describeReadGraphSettingsRefusal(failure: ReadGraphSettingsFailure, caller: string): string {
  if (failure.status === undefined) return `No answer from the node: ${failure.message}`;
  if (failure.status === 401 || failure.status === 403) {
    return `Only the node admin can see or change search across assets, and the node did not accept ${caller}'s token ` +
      `as the node admin token (HTTP ${failure.status}).`;
  }
  const body = failure.body !== null && typeof failure.body === 'object' ? failure.body as Record<string, unknown> : {};
  if (failure.status === 404 && body.code === undefined) {
    return 'This node has no search-across-assets settings: it runs a DKG version from before them. Update the node first.';
  }
  const changes = describeReadGraphChanges(body);
  return `The node refused: ${sentenceOf(body, failure.message)}${changes === undefined ? '' : `\n${changes}`}`;
}

function describeChange(change: Record<string, unknown>): string {
  const where = whereOf(change.contextGraphId, change.layer);
  const to = modeOf(change.to);
  if (change.outcome === 'unchanged') return `Search across assets was already ${to ? MODE_WORDS[to] : String(change.to)} for ${where}.`;
  if (change.outcome !== 'applied') return `Search across assets was not changed for ${where}: ${reasonOf(recordOf(change, 'outcome')?.refused)}`;
  if (to === 'serve') return `Turned search across assets on for ${where}.`;
  if (to === 'off') return `Turned search across assets off for ${where}; its combined copy is removed.`;
  if (to === 'build' && change.from === 'serve') {
    return `Search across assets is back to Preview for ${where}: queries no longer search across them, and the combined copy stays up to date.`;
  }
  if (to === 'build') return `Getting search across assets ready for ${where}. ${PREVIEW_NOTE}`;
  return `Search across assets for ${where}: ${String(change.to)}.`;
}

function describeContextGraph(contextGraph: Record<string, unknown>, allowed: readonly unknown[] | undefined): string[] {
  const chosen = recordOf(contextGraph, 'layers') ?? {};
  const effective = recordOf(contextGraph, 'effective');
  const inForce = recordOf(effective, 'layers') ?? {};
  const readGraphs = arrayOf(contextGraph, 'readGraphs');
  const lines = [`Search across assets in ${String(contextGraph.contextGraphId)}:`];
  for (const layer of READ_GRAPH_LAYERS) {
    const mode = modeOf(inForce[layer]) ?? modeOf(chosen[layer]);
    const choice = modeOf(chosen[layer]);
    const kept = mode === 'build' || mode === 'serve';
    const copies = readGraphs.filter((readGraph) => layerOf(readGraph.layer) === layer);
    const assets = kept ? countOf(copies, 'members') : undefined;
    let line = `- ${LAYER_WORDS[layer]}${assets === undefined ? '' : ` · ${counted(assets, 'asset')}`}: ${mode ? MODE_WORDS[mode] : 'not set'}`;
    if (mode && choice && choice !== mode) {
      const why = allowed && !allowed.includes(layer) ? 'this node does not allow it' : 'this node keeps it ' + MODE_WORDS[mode];
      line += ` (set to ${MODE_WORDS[choice]}, but ${why})`;
    }
    if (kept) {
      line += `: ${progressOf(copies, mode)}`;
      const facts = countOf(copies, 'triples');
      if (facts !== undefined) line += `. About ${counted(facts, 'fact')}, at its last build`;
    }
    lines.push(line);
  }
  const semantics = effective?.viewSemantics ?? contextGraph.viewSemantics;
  if (semantics === 'merged') lines.push('- Queries search across assets by default: On.');
  if (semantics === 'per-asset') lines.push('- Queries search across assets by default: Off, each asset is searched on its own.');
  return lines;
}

/** Where a memory's combined copies are: "In use", "Ready to turn on", "Getting ready" (with how far, while one is built), "Rebuilding", or a count of each. */
function progressOf(readGraphs: readonly Record<string, unknown>[], mode: 'build' | 'serve'): string {
  if (readGraphs.length === 0) return 'Getting ready';
  const counts = new Map<string, number>();
  for (const readGraph of readGraphs) {
    const word = stateWordOf(readGraph.state, mode, readGraph.progress);
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  if (counts.size === 1) return [...counts.keys()][0];
  return [...counts].map(([word, count]) => `${count} ${word}`).join(', ');
}

/**
 * What a memory's copies counted at their last build, `members` (assets) or
 * `triples` (facts), added up; `undefined` unless every copy has the count (a
 * restart clears them until the next build).
 */
function countOf(readGraphs: readonly Record<string, unknown>[], key: 'members' | 'triples'): number | undefined {
  let total = 0;
  for (const readGraph of readGraphs) {
    const count = readGraph[key];
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) return undefined;
    total += count;
  }
  return readGraphs.length === 0 ? undefined : total;
}

/** "12,400 assets", "1 asset". */
function counted(count: number, noun: string): string {
  return `${count.toLocaleString('en-US')} ${noun}${count === 1 ? '' : 's'}`;
}

function stateWordOf(state: unknown, mode: 'build' | 'serve', progress: unknown): string {
  if (state === 'ready') return mode === 'serve' ? 'In use' : 'Ready to turn on';
  if (state === 'building') {
    return typeof progress === 'number' && progress >= 0 && progress <= 1 ? `Getting ready ${Math.round(progress * 100)}%` : 'Getting ready';
  }
  if (state === 'dirty' || state === 'repairing' || state === 'rebuilding') return 'Rebuilding';
  return String(state);
}

/** "team's published assets", or the memory alone when the change names no context graph. */
function whereOf(contextGraphId: unknown, layer: unknown): string {
  const name = layerOf(layer);
  const phrase = name ? LAYER_PHRASES[name] : String(layer);
  return typeof contextGraphId === 'string' && contextGraphId !== '' ? `${contextGraphId}'s ${phrase}` : phrase;
}

/** "published assets", "published assets and private drafts", "published assets, shared memory and private drafts". */
function phraseList(layers: readonly string[]): string {
  const phrases = layers.map((layer) => {
    const name = layerOf(layer);
    return name ? LAYER_PHRASES[name] : layer;
  });
  return phrases.length < 2 ? phrases.join('') : `${phrases.slice(0, -1).join(', ')} and ${phrases[phrases.length - 1]}`;
}

function modeOf(value: unknown): ReadGraphMode | undefined {
  return value === 'off' || value === 'build' || value === 'serve' ? value : undefined;
}

function layerOf(value: unknown): ReadGraphLayer | undefined {
  if (typeof value !== 'string') return undefined;
  if ((READ_GRAPH_LAYERS as readonly string[]).includes(value)) return value as ReadGraphLayer;
  return LAYER_LABELS[value];
}

/** The node's sentence with its code: `error (CODE)`. */
function sentenceOf(body: Record<string, unknown>, fallback = 'no reason given'): string {
  const said = typeof body.error === 'string' ? body.error : fallback;
  return typeof body.code === 'string' ? `${said} (${body.code})` : said;
}

/** A refusal reason the node gave as a sentence, or as `{ code, error }`. */
function reasonOf(refused: unknown): string {
  if (typeof refused === 'string') return refused;
  return refused !== null && typeof refused === 'object' ? sentenceOf(refused as Record<string, unknown>) : 'no reason given';
}

function recordOf(value: unknown, key: string): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const field = (value as Record<string, unknown>)[key];
  return field !== null && typeof field === 'object' && !Array.isArray(field) ? field as Record<string, unknown> : undefined;
}

function arrayOf(value: unknown, key: string): Record<string, unknown>[] {
  if (value === null || typeof value !== 'object') return [];
  const field = (value as Record<string, unknown>)[key];
  return Array.isArray(field) ? field.filter((item) => item !== null && typeof item === 'object') : [];
}
