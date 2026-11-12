// SPDX-License-Identifier: Apache-2.0

/**
 * Switching read graphs on and off while the node runs. An apply gives the
 * backend's runtime new modes (`./settings.ts`), and each context graph's
 * layer whose mode changed moves to the new mode at once:
 *
 * - `off` to `build` or `serve` takes the start-up path for the layer's read
 *   graphs. Each stored row is marked dirty at a new generation and taken into
 *   the mirror, and each read graph the node keeps there that has no row gets
 *   a dirty one. From then on the layer maintains every write to their
 *   members, and refuses the writes it cannot maintain. The context graph's
 *   registry is read and recorded. The builder then backfills them on its
 *   background lane, after the writes in flight have settled, as it does after
 *   a start (`./rebuild.ts`).
 * - `build` to `serve`: merged requests are served once a read graph is
 *   ready, and get `VIEW_NOT_READY` until then (the query engine's plan).
 * - `serve` to `build`: merged requests are no longer served; maintenance
 *   goes on.
 * - `build` or `serve` to `off`: each read graph of the layer is marked dirty
 *   and leaves the mirror, so nothing serves it and writes stop maintaining
 *   it. The builder then drops its contents and its row in the background, as
 *   `dkg store read-graphs drop` does (`./drop-requests.ts`).
 *
 * The view-semantics defaults switch with the modes, or alone
 * ({@link applyViewSemantics}): a view query without `semantics` gets the new
 * default from its next plan on.
 *
 * One apply runs at a time per backend, and the modes the runtime already has
 * change nothing. Refusals are decided before anything changes:
 * - a store that cannot maintain read graphs, or has no read-graph layer,
 *   refuses settings that keep any, whether or not a context graph is listed:
 *   the apply throws `ReadGraphsUnsupportedError` (`READ_GRAPHS_UNSUPPORTED`);
 * - a context graph ID that cannot have read graphs, switched on, refuses the
 *   apply: every change is refused in the result, and none is made.
 * An apply throws only before it changes the modes; the steps that can fail
 * on the data directory run before that too.
 * After that, a step that fails on one read graph is left to the builder,
 * which finds the read graph from its mode: one switched on is built where the
 * node keeps it, and one switched off that the mirror still holds is removed.
 */

import {
  MemoryLayer,
  compareCodePoint,
  isReadGraphEligibleContextGraphId,
  parseReadGraphIri,
  readGraphIri,
  type GetView,
  type ReadGraphKey,
} from '@origintrail-official/dkg-core';
import { readGraphPartitionMaintenanceStore } from '../read-graph-partition-store.js';
import type { QueryOptions, TripleStore } from '../triple-store.js';
import { missingReadGraphMethods } from './adapter-contract.js';
import { noteReadGraphPartitionsOfRuntime } from './data-directories.js';
import { forgetReadGraphDropRequest, requestReadGraphDrops } from './drop-requests.js';
import { readGraphLayerOf, type ReadGraphStore } from './read-graph-store.js';
import { ReadGraphsUnsupportedError } from './read-graphs-unsupported.js';
import { markReadGraphDirty, refreshReadGraphRegistry, retireReadGraph, type ReadGraphJobContext } from './rebuild.js';
import type { ReadGraphBackendRuntime } from './runtime.js';
import {
  READ_GRAPH_MODES,
  VIEW_SEMANTICS,
  keepsAnyReadGraph,
  readGraphModeOf,
  readGraphModeOfLayer,
  type ReadGraphMode,
  type ReadGraphModeRule,
  type ReadGraphModes,
  type ViewSemantics,
  type ViewSemanticsSettings,
} from './settings.js';
import { joinReadGraphMaintenance, noteReadGraphMirrorInService } from './startup.js';
import { readStoredReadGraphStates } from './state.js';

/** What an apply did with one context graph's layer. */
export type ReadGraphModeOutcome = 'applied' | 'unchanged' | { readonly refused: string };

/** One context graph's layer in an apply: its mode before and after, and what the apply did. */
export interface ReadGraphModeChange {
  readonly contextGraphId: string;
  readonly layer: GetView;
  readonly from: ReadGraphMode;
  readonly to: ReadGraphMode;
  readonly outcome: ReadGraphModeOutcome;
}

/**
 * A step of a switch that failed after the modes changed. The apply still
 * reports the change applied, and the builder takes the step over from the
 * modes: it removes a read graph switched off and builds one switched on.
 * - `retire`: taking a read graph switched off out of service;
 * - `admit`: taking a read graph switched on into service, or giving it a row;
 * - `wanted`: listing the read graphs the node keeps under the new modes;
 * - `registry`: reading and recording a context graph's registry.
 */
export interface ReadGraphModeDeferral {
  readonly step: 'retire' | 'admit' | 'wanted' | 'registry';
  readonly readGraph?: string;
  readonly contextGraphId?: string;
  readonly error: unknown;
}

export interface ApplyReadGraphModesOptions {
  /** Ends an apply that has not changed the modes yet. Once it has, its steps run to their end. */
  readonly signal?: AbortSignal;
  /** The node's data directory: where the marks the store refuses are journaled. */
  readonly dataDir?: string;
  /** Context graphs to report on besides those the settings name and those with read graphs, such as the ones the node subscribes to. */
  readonly contextGraphIds?: Iterable<string>;
  /**
   * The read graphs the node keeps under the new modes, as the builder's
   * `wanted` gives them: one of a layer switched on that has no row gets a
   * dirty row at once. Without it, the builder creates those rows.
   */
  readonly wanted?: () => readonly ReadGraphKey[] | Promise<readonly ReadGraphKey[]>;
  /**
   * The view-semantics defaults to set with the modes, the whole settings
   * ({@link applyViewSemantics}). Checked before anything changes, set when the
   * modes are, and not set by an apply that is refused.
   */
  readonly viewSemantics?: ViewSemanticsSettings;
  /** The `source` label of the apply's store requests. */
  readonly source?: string;
  /** Told of each step that failed after the modes changed ({@link ReadGraphModeDeferral}). A hook that throws changes nothing. */
  readonly onDeferred?: (deferral: ReadGraphModeDeferral) => void;
}

const LAYERS: ReadonlyArray<readonly [GetView, MemoryLayer]> = [
  ['working-memory', MemoryLayer.WorkingMemory],
  ['shared-working-memory', MemoryLayer.SharedWorkingMemory],
  ['verifiable-memory', MemoryLayer.VerifiableMemory],
];
const NOT_APPLIED = 'not applied: another change in the same apply was refused';
const APPLIES = new WeakMap<ReadGraphBackendRuntime, Promise<unknown>>();

/**
 * Switch the node's read graphs to `next`, the whole settings, not a change:
 * see the module documentation. Lists every layer of each context graph that
 * `next` names and every other layer whose mode changes, in context-graph
 * order.
 */
export async function applyReadGraphModes(
  store: TripleStore,
  next: ReadGraphModes,
  options: ApplyReadGraphModesOptions = {},
): Promise<readonly ReadGraphModeChange[]> {
  const modes = checkedModes(next);
  const semantics = options.viewSemantics === undefined ? undefined : checkedViewSemantics(options.viewSemantics);
  const layer = readGraphLayerOf(store);
  if (!layer) {
    options.signal?.throwIfAborted();
    if (keepsAnyReadGraph(modes)) throw new ReadGraphsUnsupportedError('none', [], 'This store has no read-graph layer, so it keeps no read graphs');
    return outcomes(changesOf({}, modes, options.contextGraphIds ?? []), () => undefined);
  }
  const runtime = layer.runtime;
  const run = (APPLIES.get(runtime) ?? Promise.resolve()).then(() => apply(store, layer, modes, semantics, options));
  APPLIES.set(runtime, run.then(() => undefined, () => undefined));
  return run;
}

/**
 * Give the backend's runtime new view-semantics defaults, the whole settings:
 * a view query without `semantics` gets them from its next plan on. A store
 * configuration made later no longer sets them. A store without a read-graph
 * layer has nothing to set: every view query on it is per asset.
 */
export function applyViewSemantics(store: TripleStore, next: ViewSemanticsSettings): void {
  const settings = checkedViewSemantics(next);
  const layer = readGraphLayerOf(store);
  if (layer) setViewSemantics(layer.runtime, settings);
}

function setViewSemantics(runtime: ReadGraphBackendRuntime, settings: ViewSemanticsSettings): void {
  runtime.viewSemantics = settings;
  runtime.viewSemanticsApplied = true;
}

async function apply(
  store: TripleStore,
  layer: ReadGraphStore,
  next: ReadGraphModes,
  semantics: ViewSemanticsSettings | undefined,
  options: ApplyReadGraphModesOptions,
): Promise<readonly ReadGraphModeChange[]> {
  options.signal?.throwIfAborted();
  // Settings that keep read graphs are refused here whether or not they list a context graph: a node default, too.
  const missing = missingReadGraphMethods(layer.innerStore, layer.adapterCapabilities);
  if (missing.length > 0 && keepsAnyReadGraph(next)) throw new ReadGraphsUnsupportedError(layer.termSite, missing);
  const runtime = layer.runtime;
  const source = options.source ?? 'storage.readGraphModes';
  const target = readGraphPartitionMaintenanceStore(store);
  const stored = await storedReadGraphs(target, { priority: 'background', source, ...(options.signal ? { signal: options.signal } : {}) });
  options.signal?.throwIfAborted();
  const candidates = [...(options.contextGraphIds ?? []), ...runtime.mirror.contextGraphIds(), ...stored.map((readGraph) => parseReadGraphIri(readGraph)!.scope.contextGraphId)];
  const changes = changesOf(runtime.modes, next, candidates);
  const refusal = (change: Omit<ReadGraphModeChange, 'outcome'>): string | undefined =>
    (change.from === 'off' && change.to !== 'off' && !isReadGraphEligibleContextGraphId(change.contextGraphId)
      ? 'this context graph ID cannot have read graphs' : undefined);
  if (changes.some((change) => refusal(change) !== undefined)) return outcomes(changes, refusal);

  // What can fail on the data directory, before anything changes. From the settings, not from the changes listed: a
  // node default switched on lists no context graph before the first subscription, and the builder builds there all
  // the same.
  if (keepsAnyReadGraph(next)) prepareMaintenance(runtime, options.dataDir);
  runtime.modes = next;
  runtime.modesApplied = true;
  if (semantics) setViewSemantics(runtime, semantics);
  const context: ReadGraphJobContext = { store, ...(options.dataDir !== undefined ? { dataDir: options.dataDir } : {}), source };
  const deferred = (deferral: ReadGraphModeDeferral) => {
    try {
      options.onDeferred?.(deferral);
    } catch {
      // The modes changed all the same, and the builder takes the step over.
    }
  };
  await switchOff(context, runtime, next, stored, deferred);
  const on = changes.filter((change) => change.from === 'off' && change.to !== 'off');
  if (on.length > 0) await switchOn(context, runtime, on, stored, options, deferred);
  return outcomes(changes, () => undefined);
}

/**
 * Take every read graph whose mode is `off` out of service, and ask the
 * builder to drop it: those of the layers switched off, and any that a
 * switch that did not end left in the mirror or in the store. The drop is
 * asked for first, so the builder's removal also takes out of service one
 * that this could not.
 */
async function switchOff(
  context: ReadGraphJobContext,
  runtime: ReadGraphBackendRuntime,
  next: ReadGraphModes,
  stored: readonly string[],
  deferred: (deferral: ReadGraphModeDeferral) => void,
): Promise<void> {
  const off = (readGraph: string) => {
    const key = parseReadGraphIri(readGraph);
    return key !== undefined && readGraphModeOf(next, key) === 'off';
  };
  const dropped = [...new Set([...runtime.mirror.rows().map((row) => row.readGraph), ...stored])].filter(off).sort(compareCodePoint);
  requestReadGraphDrops(runtime, dropped);
  for (const readGraph of dropped) {
    if (runtime.mirror.get(readGraph) === undefined) continue;
    try {
      await retireReadGraph(context, readGraph);
    } catch (error) {
      // The builder's removal takes it out of service.
      deferred({ step: 'retire', readGraph, error });
    }
  }
}

/**
 * Ready a runtime for maintenance, as a start-up that keeps read graphs does.
 * The data directory notes first that the backend may hold read-graph
 * partitions, as a build does before its first row, and a directory that
 * cannot take the note throws before it is registered or anything changes.
 * The marks the store refuses from now on go to the data directory's journal,
 * which also records the working-memory identity, and a later start-up of
 * this process shares the mirror rather than load it again.
 */
function prepareMaintenance(runtime: ReadGraphBackendRuntime, dataDir: string | undefined): void {
  if (dataDir !== undefined) {
    noteReadGraphPartitionsOfRuntime(runtime, dataDir);
    joinReadGraphMaintenance(runtime, dataDir);
  }
  noteReadGraphMirrorInService(runtime);
}

/**
 * The start-up path for the layers switched on: every stored row of theirs is
 * marked dirty at a new generation, and every read graph the node keeps there
 * without a row gets a dirty row, each under its lock, so the mirror holds
 * them and the layer maintains them. Then each context graph's registry is
 * read, installed and recorded.
 */
async function switchOn(
  context: ReadGraphJobContext,
  runtime: ReadGraphBackendRuntime,
  on: readonly Omit<ReadGraphModeChange, 'outcome'>[],
  stored: readonly string[],
  options: ApplyReadGraphModesOptions,
  deferred: (deferral: ReadGraphModeDeferral) => void,
): Promise<void> {
  const switched = (key: ReadGraphKey | undefined) => key !== undefined
    && on.some((change) => change.contextGraphId === key.scope.contextGraphId && layerOfView(change.layer) === key.layer);
  const admitted = new Set(stored.filter((readGraph) => switched(parseReadGraphIri(readGraph))));
  try {
    for (const key of (await options.wanted?.()) ?? []) if (switched(key)) admitted.add(readGraphIri(key));
  } catch (error) {
    // The builder asks again, and creates their rows.
    deferred({ step: 'wanted', error });
  }
  for (const readGraph of [...admitted].sort(compareCodePoint)) {
    forgetReadGraphDropRequest(runtime, readGraph);
    try {
      await markReadGraphDirty(context, readGraph, { create: true });
    } catch (error) {
      // The builder builds it where the node keeps it.
      deferred({ step: 'admit', readGraph, error });
    }
  }
  for (const contextGraphId of new Set(on.map((change) => change.contextGraphId))) {
    try {
      await refreshReadGraphRegistry(context, contextGraphId);
    } catch (error) {
      // A build reads it before it copies anything.
      deferred({ step: 'registry', contextGraphId, error });
    }
  }
}

/**
 * Every layer of each context graph `next` names, and every other layer of a
 * candidate whose mode changes. A candidate that cannot have read graphs is
 * left out unless `next` names it.
 */
function changesOf(current: ReadGraphModes, next: ReadGraphModes, candidates: Iterable<string>): Omit<ReadGraphModeChange, 'outcome'>[] {
  const named = new Set(ownKeys(next.contextGraphs));
  const contextGraphIds = new Set([...named, ...ownKeys(current.contextGraphs), ...candidates]);
  const changes: Omit<ReadGraphModeChange, 'outcome'>[] = [];
  for (const contextGraphId of [...contextGraphIds].sort(compareCodePoint)) {
    if (!named.has(contextGraphId) && !isReadGraphEligibleContextGraphId(contextGraphId)) continue;
    for (const [view, layer] of LAYERS) {
      const from = readGraphModeOfLayer(current, contextGraphId, layer);
      const to = readGraphModeOfLayer(next, contextGraphId, layer);
      if (from !== to || named.has(contextGraphId)) changes.push({ contextGraphId, layer: view, from, to });
    }
  }
  return changes;
}

/** The outcome of each change: refused where `refusal` gives a reason, and then every other change too. */
function outcomes(
  changes: readonly Omit<ReadGraphModeChange, 'outcome'>[],
  refusal: (change: Omit<ReadGraphModeChange, 'outcome'>) => string | undefined,
): ReadGraphModeChange[] {
  const refused = changes.some((change) => refusal(change) !== undefined);
  return changes.map((change): ReadGraphModeChange => {
    if (change.from === change.to) return { ...change, outcome: 'unchanged' };
    if (!refused) return { ...change, outcome: 'applied' };
    return { ...change, outcome: { refused: refusal(change) ?? NOT_APPLIED } };
  });
}

/** The read graphs with a state row in the store, read below the layer. */
async function storedReadGraphs(store: TripleStore, options: QueryOptions): Promise<string[]> {
  const { rows, damaged } = await readStoredReadGraphStates(store, options);
  return [...new Set([...rows.map((row) => row.readGraph), ...damaged])].filter((readGraph) => parseReadGraphIri(readGraph) !== undefined);
}

/** A frozen copy of settings whose every mode and layer is known; anything else throws. */
function checkedModes(modes: ReadGraphModes): ReadGraphModes {
  const rule = (value: ReadGraphModeRule, where: string): ReadGraphModeRule => {
    const layers: Partial<Record<MemoryLayer, ReadGraphMode>> = {};
    for (const [layer, mode] of Object.entries(value.layers ?? {})) {
      if (!LAYERS.some(([, known]) => known === layer)) throw new TypeError(`${where}: not a memory layer: ${layer}`);
      layers[layer as MemoryLayer] = checkedMode(mode, `${where}.layers.${layer}`);
    }
    return Object.freeze({
      ...(value.default !== undefined ? { default: checkedMode(value.default, `${where}.default`) } : {}),
      ...(value.layers !== undefined ? { layers: Object.freeze(layers) } : {}),
    });
  };
  const contextGraphs: Record<string, ReadGraphModeRule> = {};
  for (const contextGraphId of ownKeys(modes.contextGraphs)) {
    Object.defineProperty(contextGraphs, contextGraphId, {
      value: rule(modes.contextGraphs![contextGraphId]!, `contextGraphs.${contextGraphId}`), enumerable: true,
    });
  }
  return Object.freeze({ ...rule(modes, 'modes'), ...(modes.contextGraphs !== undefined ? { contextGraphs: Object.freeze(contextGraphs) } : {}) });
}

/** A frozen copy of view-semantics settings whose every value is known; anything else throws. */
function checkedViewSemantics(settings: ViewSemanticsSettings): ViewSemanticsSettings {
  const checked = (value: unknown, where: string): ViewSemantics => {
    if (!VIEW_SEMANTICS.includes(value as ViewSemantics)) throw new TypeError(`${where}: not a view semantics: ${String(value)}`);
    return value as ViewSemantics;
  };
  const contextGraphs: Record<string, ViewSemantics> = {};
  for (const contextGraphId of ownKeys(settings.contextGraphs)) {
    Object.defineProperty(contextGraphs, contextGraphId, {
      value: checked(settings.contextGraphs![contextGraphId], `contextGraphs.${contextGraphId}`), enumerable: true,
    });
  }
  return Object.freeze({
    ...(settings.default !== undefined ? { default: checked(settings.default, 'default') } : {}),
    ...(settings.contextGraphs !== undefined ? { contextGraphs: Object.freeze(contextGraphs) } : {}),
  });
}

function checkedMode(mode: unknown, where: string): ReadGraphMode {
  if (!READ_GRAPH_MODES.includes(mode as ReadGraphMode)) throw new TypeError(`${where}: not a read-graph mode: ${String(mode)}`);
  return mode as ReadGraphMode;
}

function layerOfView(view: GetView): MemoryLayer {
  return LAYERS.find(([known]) => known === view)![1];
}

function ownKeys(record: object | undefined): string[] {
  return record === undefined ? [] : Object.keys(record);
}
