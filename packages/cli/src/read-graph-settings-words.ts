// SPDX-License-Identifier: Apache-2.0
// Search across assets (read graphs) in the words users see: the CLI's option
// values, help and output. `--json` and the wire keep the engine values.
import type { GetView } from '@origintrail-official/dkg-core';
import type { ReadGraphMode, ReadGraphModeChange, ViewSemantics } from '@origintrail-official/dkg-storage';
import type { ReadGraphCreateOutcome, ReadGraphsCreateSetting } from './read-graph-settings-client.js';
import {
  MEMORY_IN_SENTENCES,
  MEMORY_WORDS,
  READ_GRAPH_MODE_WORDS,
  type ReadGraphContextGraphSettings,
  type ReadGraphSettingsAnswer,
  type ReadGraphSettingsReadGraph,
  type ReadGraphSettingsRequest,
} from './read-graph-settings-wire.js';

export const FEATURE_NAME = 'Search across assets';

/** The memories in the order the CLI lists them: published assets first. */
export const MEMORIES: readonly GetView[] = Object.freeze(['verifiable-memory', 'shared-working-memory', 'working-memory']);
/** The status route's layer labels, which `dkg store read-graphs status` also takes. */
const SHORT_LABELS: Readonly<Record<string, GetView>> = {
  vm: 'verifiable-memory', swm: 'shared-working-memory', wm: 'working-memory',
};

export const LAYER_OPTION_HELP = 'Which memory: verifiable-memory (published assets, the default), '
  + 'shared-working-memory (shared memory), working-memory (private drafts), or all';
export const MODE_OPTION_HELP = 'preview (the default) prepares the combined copy and shows how results would change, '
  + 'without changing any results yet; on lets queries that ask for it search across assets. build and serve mean the same';

const capitalized = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);
const lowerFirst = (text: string): string => text.charAt(0).toLowerCase() + text.slice(1);
/** "Published assets", "Shared memory, shared with your team", "Private drafts". */
export const layerName = (layer: GetView): string => MEMORY_WORDS[layer];
/** "Published assets of my-project", "Shared memory of my-project". */
export const memoryOf = (layer: GetView, contextGraphId: string): string => `${capitalized(MEMORY_IN_SENTENCES[layer])} of ${contextGraphId}`;
/** "off", "preview", "on". */
export const modeWord = (mode: ReadGraphMode): string => READ_GRAPH_MODE_WORDS[mode].toLowerCase();
export const semanticsWords = (semantics: ViewSemantics): string =>
  semantics === 'merged' ? 'search across assets' : 'search each asset on its own';

/** One memory by name, or by the labels vm, swm and wm. */
const memoryNamed = (value: string): GetView | undefined =>
  ((MEMORIES as readonly string[]).includes(value) ? value as GetView
    : Object.hasOwn(SHORT_LABELS, value) ? SHORT_LABELS[value] : undefined);

/** `--layer`: one memory, or `all`. Published assets when absent. */
export function parseLayerOption(value: string | undefined, option = '--layer'): { readonly layers: readonly GetView[] } | { readonly error: string } {
  if (value === undefined) return { layers: ['verifiable-memory'] };
  if (value === 'all') return { layers: MEMORIES };
  const memory = memoryNamed(value);
  return memory === undefined ? { error: `${option} must be one of ${MEMORIES.join(', ')}, or all.` } : { layers: [memory] };
}

/** `--mode`: preview or on, or the engine's build or serve. Preview when absent. */
export function parseModeOption(value: string | undefined, option = '--mode'): { readonly mode: 'build' | 'serve' } | { readonly error: string } {
  if (value === undefined || value === 'preview' || value === 'build') return { mode: 'build' };
  if (value === 'on' || value === 'serve') return { mode: 'serve' };
  return { error: `${option} must be preview or on (or build or serve).` };
}

/** The argument of `default-semantics`: merged, per-asset, or none, which drops the context graph's own default. */
export function parseSemanticsArgument(value: string): { readonly viewSemantics: ViewSemantics | null } | { readonly error: string } {
  if (value === 'merged' || value === 'per-asset') return { viewSemantics: value };
  if (value === 'none') return { viewSemantics: null };
  return { error: 'The default must be merged, per-asset or none.' };
}

/** `dkg context-graph create --read-graphs <mode> [--read-graph-layer <memory>]`: the setting to send with the creation, if any. */
export function parseCreateReadGraphsOptions(mode: string | undefined, layer: string | undefined): { readonly setting?: ReadGraphsCreateSetting } | { readonly error: string } {
  if (mode === undefined) return layer === undefined ? {} : { error: '--read-graph-layer needs --read-graphs.' };
  const parsedMode = parseModeOption(mode, '--read-graphs');
  if ('error' in parsedMode) return parsedMode;
  const layers = parseLayerOption(layer, '--read-graph-layer');
  if ('error' in layers) return layers;
  return { setting: { layers: Object.fromEntries(layers.layers.map((memory) => [memory, parsedMode.mode])) } };
}

/** `dkg query --view --semantics`: a semantics without a view reads published assets. */
export function parseQueryViewOptions(view: string | undefined, semantics: string | undefined):
  { readonly view?: GetView; readonly semantics?: ViewSemantics } | { readonly error: string } {
  const memory = view === undefined ? undefined : memoryNamed(view);
  if (view !== undefined && memory === undefined) return { error: `--view must be one of ${MEMORIES.join(', ')}.` };
  if (semantics !== undefined && semantics !== 'merged' && semantics !== 'per-asset') return { error: '--semantics must be merged or per-asset.' };
  return {
    ...(memory === undefined && semantics === undefined ? {} : { view: memory ?? 'verifiable-memory' }),
    ...(semantics === undefined ? {} : { semantics: semantics as ViewSemantics }),
  };
}

/** A memory's read graphs: the context graph's root and sub-graphs, or one per agent for private drafts. */
export function readGraphsOf(settings: ReadGraphContextGraphSettings, layer: GetView): readonly ReadGraphSettingsReadGraph[] {
  const memoryOfLabel = (label: string) => (Object.hasOwn(SHORT_LABELS, label) ? SHORT_LABELS[label] : label);
  return (settings.readGraphs ?? []).filter((readGraph) => memoryOfLabel(readGraph.layer) === layer);
}

/**
 * A memory's state: Off; Getting ready while it has no read graph yet or one is
 * being built, with how far when the builder says; Rebuilding; Checking; and once
 * every read graph is ready, In use (on) or Ready to turn on (preview).
 */
export function stateWords(mode: ReadGraphMode, readGraphs: readonly ReadGraphSettingsReadGraph[]): string {
  if (mode === 'off') return 'Off';
  const building = readGraphs.filter((readGraph) => readGraph.state === 'building');
  if (readGraphs.length === 0 || building.length > 0) {
    // A read graph that reports no progress counts as not started.
    if (!building.some((readGraph) => typeof readGraph.progress === 'number')) return 'Getting ready';
    const share = building.reduce((sum, readGraph) => sum + (readGraph.progress ?? 0), 0) / building.length;
    return `Getting ready ${Math.floor(share * 100)}%`;
  }
  const states = readGraphs.map((readGraph) => readGraph.state);
  if (states.some((state) => state === 'repairing' || state === 'rebuilding')) return 'Rebuilding';
  if (states.includes('dirty')) return 'Checking';
  if (states.every((state) => state === 'ready')) return mode === 'serve' ? 'In use' : 'Ready to turn on';
  return 'Getting ready';
}

/**
 * "1,204 assets, holds about 24,080 facts", from the memory's whole copies, each only when every one of them reports it. A sub-graph's copy holds what
 * the context graph's whole copy already holds, and in working memory each agent's whole copy holds its own drafts.
 */
export function sizeWords(layer: GetView, readGraphs: readonly ReadGraphSettingsReadGraph[]): string | undefined {
  const whole = readGraphs.filter((readGraph) => readGraph.subGraphName === undefined);
  const total = (key: 'members' | 'triples') => (whole.length > 0 && whole.every((readGraph) => typeof readGraph[key] === 'number')
    ? whole.reduce((sum, readGraph) => sum + (readGraph[key] ?? 0), 0) : undefined);
  const members = total('members');
  const triples = total('triples');
  const unit = layer === 'working-memory' ? 'draft' : 'asset';
  const parts = [
    ...(members === undefined ? [] : [`${members.toLocaleString('en-US')} ${unit}${members === 1 ? '' : 's'}`]),
    ...(triples === undefined ? [] : [`holds about ${triples.toLocaleString('en-US')} facts`]),
  ];
  return parts.length === 0 ? undefined : parts.join(', ');
}

/** "Published assets of my-project: off → preview. Getting ready in the background." */
export function changeLine(change: ReadGraphModeChange, state?: string): string {
  const subject = memoryOf(change.layer, change.contextGraphId);
  if (typeof change.outcome === 'object') return `${subject}: stays ${modeWord(change.from)}. ${change.outcome.refused}`;
  if (change.outcome === 'unchanged') return `${subject}: already ${modeWord(change.to)}.`;
  return `${subject}: ${modeWord(change.from)} → ${modeWord(change.to)}. ${afterChange(change.to, state)}`;
}

/**
 * What to name from the node's report, which holds every memory of each context graph in its settings: a memory left
 * as it was only when the request set it, and every change and refusal.
 */
export function changesToName(changes: readonly ReadGraphModeChange[], request: Pick<ReadGraphSettingsRequest, 'contextGraphId' | 'layers'>):
  readonly ReadGraphModeChange[] {
  return changes.filter((change) => change.outcome !== 'unchanged'
    || (change.contextGraphId === request.contextGraphId && request.layers !== undefined && Object.hasOwn(request.layers, change.layer)));
}

function afterChange(to: ReadGraphMode, state: string | undefined): string {
  if (to === 'off') return 'The combined copy is removed in the background.';
  if (state === 'In use' || state === 'Ready to turn on') return `${state}.`;
  return to === 'serve'
    ? 'Getting ready in the background; until then, queries that ask to search across assets are told it is not ready.'
    : 'Getting ready in the background.';
}

/**
 * What `dkg context-graph create` says about the setting it sent: the changes,
 * or why it is not in force. `ok` is false when it is not, though the context
 * graph was created.
 */
export function createReadGraphsLines(contextGraphId: string, setting: ReadGraphsCreateSetting | undefined, outcome: ReadGraphCreateOutcome | undefined):
  { readonly lines: readonly string[]; readonly ok: boolean } {
  if (setting === undefined) return { lines: [], ok: true };
  const asked = Object.entries(setting.layers) as [GetView, ReadGraphMode][];
  const layerFlag = asked.length === MEMORIES.length ? ' --layer all' : asked[0]![0] === 'verifiable-memory' ? '' : ` --layer ${asked[0]![0]}`;
  const later = `Switch it on later with: dkg store read-graphs enable -c ${contextGraphId}${layerFlag}${asked[0]![1] === 'serve' ? ' --mode on' : ''}`;
  if (outcome === undefined) {
    return { lines: [`${FEATURE_NAME}: this node did not say whether it switched it on. Check with: dkg store read-graphs settings -c ${contextGraphId}`], ok: false };
  }
  if ('refused' in outcome) return { lines: [`${FEATURE_NAME} was not switched on: ${outcome.refused}`, later], ok: false };
  if (outcome.changes.length === 0) {
    return { lines: asked.map(([layer, mode]) => `${memoryOf(layer, contextGraphId)}: ${modeWord(mode)}. Getting ready in the background.`), ok: true };
  }
  return {
    lines: changesToName(outcome.changes, { contextGraphId, layers: setting.layers }).map((change) => changeLine(change)),
    ok: !outcome.changes.some((change) => typeof change.outcome === 'object'),
  };
}

/** The node's policy, as the first line of `settings`. */
export function policyLine(policy: ReadGraphSettingsAnswer['policy']): string {
  if (!policy.enabled) return `${FEATURE_NAME} is switched off on this node (query.readGraphsPolicy in its config.json).`;
  const allowed = MEMORIES.filter((layer) => policy.layers.includes(layer));
  return `${FEATURE_NAME} is allowed for: ${allowed.map(layerName).join('; ')}.`;
}

/** "Published assets: on, in use. 1,204 assets, holds about 24,080 facts." */
export function layerLine(settings: ReadGraphContextGraphSettings, layer: GetView): string {
  const mode = settings.effective?.layers[layer] ?? settings.layers[layer] ?? 'off';
  const own = settings.layers[layer] === undefined ? ' (node default)' : '';
  if (mode === 'off') return `${layerName(layer)}: off${own}.`;
  const readGraphs = readGraphsOf(settings, layer);
  const size = sizeWords(layer, readGraphs);
  return `${layerName(layer)}: ${modeWord(mode)}${own}, ${lowerFirst(stateWords(mode, readGraphs))}.${size === undefined ? '' : ` ${capitalized(size)}.`}`;
}

/** "Queries that don't choose: search across assets." */
export function semanticsLine(settings: ReadGraphContextGraphSettings): string {
  const semantics = settings.effective?.viewSemantics ?? settings.viewSemantics ?? 'per-asset';
  return `Queries that don't choose: ${semanticsWords(semantics)}${settings.viewSemantics === undefined ? ' (node default)' : ''}.`;
}
