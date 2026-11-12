/**
 * The daemon's control of read-graph settings per context graph at runtime (OT-RFC-74): what `GET` and `PUT
 * /api/store/read-graphs/settings` and the `readGraphs` field of a context graph's creation do.
 *
 * A change switches nothing on that config.json's policy, the store, a public-checkpoint start or the rollback target
 * does not allow; a switch to `off` and a view-semantics default always pass those checks. It applies the settings
 * the change leaves to the running node, and the table takes the change in one transaction at the apply's commit point,
 * so a change the node refuses or fails to apply writes nothing, and answers why. Changes run one at a time, and the
 * last one wins.
 */
import { GET_VIEWS, MemoryLayer, isReadGraphEligibleContextGraphId, parseReadGraphIri, type GetView } from '@origintrail-official/dkg-core';
import type { DKGAgent } from '@origintrail-official/dkg-agent';
import {
  missingReadGraphMethods,
  readGraphLayerOf,
  readGraphModeOfLayer,
  readGraphRuntimeOf,
  viewSemanticsOf,
  type ReadGraphMode,
  type ReadGraphModeChange,
  type ReadGraphModes,
  type TripleStore,
  type ViewSemanticsSettings,
} from '@origintrail-official/dkg-storage';
import { nodeReadGraphModes, policyRefusalOf, resolveEffectiveQueryConfig, type ReadGraphsRefusal } from '../read-graphs-config.js';
import { CHECKPOINT_NODE_REFUSAL, noteReadGraphStoreSupport, type DaemonReadGraphSettings } from '../read-graph-settings-start.js';
import type { ReadGraphSettingsChange, ReadGraphSettingsEntry, SqliteReadGraphSettingsStore } from '../read-graph-settings-store.js';
import {
  MEMORY_IN_SENTENCES,
  type ReadGraphCreateOutcome,
  type ReadGraphContextGraphSettings,
  type ReadGraphSettingsAnswer,
  type ReadGraphSettingsReadGraph,
  type ReadGraphSettingsRefusal,
  type ReadGraphSettingsRequest,
} from '../read-graph-settings-wire.js';
import { readGraphViewOf } from '../read-graphs-wire.js';
import { settingsTableRollbackRefusal } from '../update/read-graph-rollback-target.js';
import { daemonReadGraphRequests, type ReadGraphRequests } from './read-graph-requests.js';

const LAYER_OF_VIEW: Readonly<Record<GetView, MemoryLayer>> = {
  'working-memory': MemoryLayer.WorkingMemory,
  'shared-working-memory': MemoryLayer.SharedWorkingMemory,
  'verifiable-memory': MemoryLayer.VerifiableMemory,
};

/** The agent methods the control uses. */
export interface ReadGraphSettingsAgent {
  readonly store: TripleStore;
  applyReadGraphModesV1(
    next: ReadGraphModes,
    options?: { signal?: AbortSignal; viewSemantics?: ViewSemanticsSettings; beforeCommit?: () => void },
  ): Promise<readonly ReadGraphModeChange[]>;
  readGraphStatusV1(): ReturnType<DKGAgent['readGraphStatusV1']>;
}

/** What a change answers: an HTTP status and its body. */
export interface ReadGraphSettingsOutcome {
  readonly status: number;
  readonly body: ReadGraphSettingsAnswer | (ReadGraphSettingsRefusal & { readonly changes?: readonly ReadGraphModeChange[] });
}

export type { ReadGraphCreateOutcome } from '../read-graph-settings-wire.js';

/**
 * The `readGraphs` field of a context graph's creation, on a node whose control may not run yet. It runs as one of the daemon's read-graph requests,
 * which graceful shutdown ends.
 */
export async function readGraphSettingsOnCreate(
  control: ReadGraphSettingsControl | undefined,
  input: { readonly contextGraphId: string; readonly layers: ReadGraphSettingsRequest['layers']; readonly canAdminister: boolean; readonly actor: string },
  requests: ReadGraphRequests = daemonReadGraphRequests,
): Promise<ReadGraphCreateOutcome> {
  // The token comes first, and its refusal is the same for every context graph.
  if (!input.canAdminister) return NOT_NODE_ADMIN;
  if (control === undefined) {
    return { code: 'READ_GRAPH_SETTINGS_UNAVAILABLE', refused: 'This node\'s search-across-assets settings aren\'t available yet; the context graph was created without them.' };
  }
  if (requests.ending) return NODE_SHUTTING_DOWN_ON_CREATE;
  const stop = new AbortController();
  const untrack = requests.track(stop);
  try {
    const outcome = await control.applyOnCreate(input.contextGraphId, input.layers, input.actor, stop.signal);
    // Shutdown ends a change before it changes anything; a settings write that failed keeps its own answer.
    const ended = stop.signal.aborted && requests.ending && !('applied' in outcome) && outcome.code !== 'READ_GRAPH_SETTINGS_UNAVAILABLE';
    return ended ? NODE_SHUTTING_DOWN_ON_CREATE : outcome;
  } finally {
    untrack();
  }
}

/** Build the daemon's control once its agent runs, and say so when its store cannot keep the read graphs the table sets. */
export function startReadGraphSettingsControl(input: ReadGraphSettingsControlInput): ReadGraphSettingsControl {
  noteReadGraphStoreSupport(input.settings, input.agent.store, input.log);
  return new ReadGraphSettingsControl(input);
}

export interface ReadGraphSettingsControlInput {
  readonly settings: DaemonReadGraphSettings;
  readonly agent: ReadGraphSettingsAgent;
  readonly role: 'core' | 'edge';
  readonly checkpoint: boolean;
  /** The settings table, over the node's database: the daemon's composition owns the handle. */
  readonly table: SqliteReadGraphSettingsStore;
  readonly log: (message: string) => void;
}

export class ReadGraphSettingsControl {
  readonly #settings: DaemonReadGraphSettings;
  readonly #agent: ReadGraphSettingsAgent;
  readonly #role: 'core' | 'edge';
  readonly #checkpoint: boolean;
  readonly #table: SqliteReadGraphSettingsStore;
  readonly #log: (message: string) => void;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(input: ReadGraphSettingsControlInput) {
    this.#settings = input.settings;
    this.#agent = input.agent;
    this.#role = input.role;
    this.#checkpoint = input.checkpoint;
    this.#table = input.table;
    this.#log = input.log;
  }

  /** The settings of one context graph, or of every context graph with settings of its own or read graphs. */
  async answer(contextGraphId?: string): Promise<ReadGraphSettingsAnswer> {
    const { policy } = this.#settings;
    const refusals = await this.#nodeRefusals();
    const entries = new Map(this.#entries().map((entry) => [entry.contextGraphId, entry]));
    const runtime = readGraphRuntimeOf(this.#agent.store);
    const status = this.#agent.readGraphStatusV1();
    const rows = status?.readGraphs ?? runtime?.mirror.rows() ?? [];
    const byGraph = new Map<string, ReadGraphSettingsReadGraph[]>();
    for (const row of rows) {
      const key = parseReadGraphIri(row.readGraph);
      if (key === undefined || (contextGraphId !== undefined && key.scope.contextGraphId !== contextGraphId)) continue;
      const progress = status?.builder?.building === row.readGraph ? status.builder.progress : undefined;
      const { triples, members } = row as { triples?: number; members?: number };
      byGraph.set(key.scope.contextGraphId, [...byGraph.get(key.scope.contextGraphId) ?? [], {
        ...readGraphViewOf(row),
        ...(progress === undefined ? {} : { progress }),
        ...(triples === undefined ? {} : { triples }),
        ...(members === undefined ? {} : { members }),
      }]);
    }
    const ids = contextGraphId !== undefined ? [contextGraphId] : [...new Set([...entries.keys(), ...byGraph.keys()])].sort();
    const contextGraphs = ids.map((id): ReadGraphContextGraphSettings => {
      const own = entries.get(id);
      return {
        contextGraphId: id,
        layers: own?.layers ?? {},
        ...(own?.viewSemantics === undefined ? {} : { viewSemantics: own.viewSemantics }),
        effective: { layers: layersOf(runtime?.modes, id), viewSemantics: viewSemanticsOf(runtime?.viewSemantics, id) },
        readGraphs: byGraph.get(id) ?? [],
      };
    });
    const { enabled, layers: allowed } = policy.readGraphsPolicy;
    const refused: ReadGraphSettingsRefusal | undefined = !enabled
      ? answerOf({ code: 'READ_GRAPHS_DISABLED', message: '' })
      : allowed.length === 0
        ? { code: 'READ_GRAPHS_LAYER_NOT_ALLOWED', error: NO_LAYER_ALLOWED }
        : refusals[0] === undefined ? undefined : answerOf(refusals[0]);
    return {
      policy: { enabled, layers: allowed },
      // The node's own modes name no context graph, so any ID reads them.
      node: { layers: layersOf(nodeReadGraphModes(policy), ''), viewSemantics: viewSemanticsOf(policy.viewSemantics, '') },
      ...(refused === undefined ? {} : { refused }),
      contextGraphs,
    };
  }

  /** Change one context graph's own settings, and answer what is in force afterwards: see the module documentation. */
  change(request: ReadGraphSettingsRequest, actor: string, signal?: AbortSignal): Promise<ReadGraphSettingsOutcome> {
    return this.#serial(async () => {
      const result = await this.#change(request, actor, signal);
      if (!result.ok) return { status: result.status, body: result.refusal };
      return { status: 200, body: { ...await this.answer(request.contextGraphId), changes: result.changes } };
    });
  }

  /** The `readGraphs` field of a node admin's creation of a context graph, applied after it with the checks of a change. */
  async applyOnCreate(
    contextGraphId: string,
    layers: ReadGraphSettingsRequest['layers'],
    actor: string,
    signal?: AbortSignal,
  ): Promise<ReadGraphCreateOutcome> {
    const result = await this.#serial(() => this.#change({ contextGraphId, ...(layers === undefined ? {} : { layers }) }, actor, signal));
    return result.ok ? { applied: true, changes: result.changes } : { code: result.refusal.code, refused: result.refusal.error };
  }

  async #change(request: ReadGraphSettingsRequest, actor: string, signal: AbortSignal | undefined): Promise<ChangeResult> {
    const { policy } = this.#settings;
    const { contextGraphId } = request;
    if (!isReadGraphEligibleContextGraphId(contextGraphId)) {
      return refused(400, { code: 'READ_GRAPH_SETTINGS_INVALID', error: `${contextGraphId} is not a context graph that can search across assets.` });
    }
    const switchesOn = GET_VIEWS.filter((view) => request.layers?.[view] !== undefined && request.layers[view] !== 'off');
    for (const view of switchesOn) {
      const refusal = policyRefusalOf(policy.readGraphsPolicy, view);
      if (refusal !== undefined) return refused(409, answerOf(refusal, view));
    }
    const refusals = await this.#nodeRefusals();
    if (switchesOn.length > 0 && refusals.length > 0) return refused(409, answerOf(refusals[0]!, switchesOn[0]));
    // A node that starts from a public checkpoint keeps no settings table, so it takes no change at all.
    if (this.#checkpoint) return refused(409, answerOf(CHECKPOINT_NODE_REFUSAL));
    const change: ReadGraphSettingsChange = {
      ...(request.layers === undefined ? {} : { layers: request.layers }),
      ...(request.viewSemantics === undefined ? {} : { viewSemantics: request.viewSemantics }),
    };
    // The settings the change leaves, resolved in memory. The table takes the change at the apply's commit point, after everything that can fail and
    // just before the node takes the settings: a change the node does not apply writes nothing, and a write that fails leaves the node as it was.
    const table = this.#table;
    let entries: ReadonlyArray<ReadGraphSettingsEntry>;
    try {
      entries = withChange(table.list(), contextGraphId, change);
    } catch (error) {
      return unavailable(error);
    }
    const { config } = resolveEffectiveQueryConfig(policy, entries, { refusals });
    let written = false;
    let writeError: unknown;
    const write = () => {
      try {
        table.set(contextGraphId, change, actor);
        written = true;
      } catch (error) {
        writeError = error;
        throw error;
      }
    };
    let changes: readonly ReadGraphModeChange[];
    try {
      changes = await this.#agent.applyReadGraphModesV1(config.readGraphs, {
        ...(signal ? { signal } : {}), viewSemantics: config.viewSemantics, beforeCommit: write,
      });
    } catch (error) {
      if (writeError !== undefined) return unavailable(writeError);
      // A store that cannot keep the settings in force refuses them before anything changes.
      return (error as { code?: unknown } | null)?.code === 'READ_GRAPHS_UNSUPPORTED'
        ? refused(409, answerOf({ code: 'READ_GRAPHS_UNSUPPORTED', message: messageOf(error) }))
        : applyRefused(contextGraphId, messageOf(error));
    }
    const refusedChange = changes.find((entry) => typeof entry.outcome === 'object');
    if (refusedChange !== undefined) return applyRefused(contextGraphId, (refusedChange.outcome as { refused: string }).refused, changes);
    // An apply that took the settings always passes its commit point; a host that has none writes the change once the settings are taken.
    if (!written) {
      try {
        write();
      } catch (error) {
        return unavailable(error);
      }
    }
    this.#log(`[read-graphs] ${actor} changed the settings of ${contextGraphId}: ${describe(request, changes)}.`);
    return { ok: true, changes };
  }

  /** The table's entries for an answer: none on a node that starts from a public checkpoint, or when the table cannot be read. */
  #entries(): ReadonlyArray<ReadGraphSettingsEntry> {
    if (this.#checkpoint) return [];
    try {
      return this.#table.list();
    } catch {
      return [];
    }
  }

  /** The refusals that hold for every context graph now, in the order of the checks: the store, a public checkpoint, the rollback target. */
  async #nodeRefusals(): Promise<ReadGraphsRefusal[]> {
    const refusals: ReadGraphsRefusal[] = [];
    const layer = readGraphLayerOf(this.#agent.store);
    const missing = layer === null ? ['every write'] : missingReadGraphMethods(layer.innerStore, layer.adapterCapabilities);
    if (missing.length > 0) {
      refusals.push({ code: 'READ_GRAPHS_UNSUPPORTED', message: `the node's store does not maintain read graphs with ${missing.join(', ')}` });
    }
    if (this.#checkpoint) refusals.push(CHECKPOINT_NODE_REFUSAL);
    const rollback = await settingsTableRollbackRefusal(this.#role);
    if (rollback !== undefined) refusals.push(rollback);
    return refusals;
  }

  #serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(work);
    this.#queue = run.then(() => undefined, () => undefined);
    return run;
  }
}

const NODE_SHUTTING_DOWN_ON_CREATE: ReadGraphCreateOutcome = Object.freeze({
  code: 'NODE_SHUTTING_DOWN',
  refused: 'The node is shutting down; the context graph was created without search across assets.',
});

const NOT_NODE_ADMIN: ReadGraphCreateOutcome = Object.freeze({
  code: 'NODE_ADMIN_REQUIRED',
  refused: 'Only the node admin can turn on search across assets; the context graph was created without it.',
});

const NO_LAYER_ALLOWED = 'Search across assets can\'t be turned on for any memory on this node: query.readGraphsPolicy.layers in its config.json is empty.';

/** A refusal as the API answers it, with a sentence for users. */
function answerOf(refusal: ReadGraphsRefusal, view?: GetView): ReadGraphSettingsRefusal {
  return {
    code: refusal.code,
    error: sentenceOf(refusal, view),
    ...(refusal.rollbackTarget === undefined ? {} : { rollbackTarget: refusal.rollbackTarget }),
    ...(refusal.firstRecognizingRelease === undefined ? {} : { firstRecognizingRelease: refusal.firstRecognizingRelease }),
  };
}

function sentenceOf(refusal: ReadGraphsRefusal, view: GetView | undefined): string {
  switch (refusal.code) {
    case 'READ_GRAPHS_DISABLED':
      return 'Search across assets is off for this whole node: query.readGraphsPolicy.enabled is false in its config.json.';
    case 'READ_GRAPHS_LAYER_NOT_ALLOWED':
      return `Search across assets can't be turned on for ${view === undefined ? 'this memory' : MEMORY_IN_SENTENCES[view]} on this node: `
        + 'query.readGraphsPolicy.layers in its config.json leaves it out.';
    case 'READ_GRAPHS_UNSUPPORTED':
      return `This node's store can't search across assets (${refusal.message}).`;
    case 'READ_GRAPHS_CHECKPOINT_NODE':
      return 'This node starts from a public checkpoint, so it can\'t search across assets.';
    case 'READ_GRAPHS_ROLLBACK_TARGET_OLDER':
      return refusal.rollbackTarget === undefined
        ? `Search across assets can't be turned on now: ${refusal.message}.`
        : 'Search across assets can be turned on after this node\'s next update: the release it would roll back to '
          + `(${refusal.rollbackTarget.version ?? 'version unknown'}) doesn't support it, and ${refusal.firstRecognizingRelease} is the first that does.`;
  }
}

/** What a change did: applied with what it changed, or refused with an HTTP status and why. */
type ChangeResult =
  | { readonly ok: true; readonly changes: readonly ReadGraphModeChange[] }
  | { readonly ok: false; readonly status: number; readonly refusal: ReadGraphSettingsRefusal & { readonly changes?: readonly ReadGraphModeChange[] } };

function refused(status: number, refusal: ReadGraphSettingsRefusal & { readonly changes?: readonly ReadGraphModeChange[] }): ChangeResult {
  return { ok: false, status, refusal };
}

/** The settings a change leaves, from the table's entries and the change, as the table will hold them. */
function withChange(
  entries: ReadonlyArray<ReadGraphSettingsEntry>,
  contextGraphId: string,
  change: ReadGraphSettingsChange,
): ReadonlyArray<ReadGraphSettingsEntry> {
  const held = entries.find((entry) => entry.contextGraphId === contextGraphId);
  const layers = { ...held?.layers };
  for (const view of GET_VIEWS) {
    const mode = change.layers?.[view];
    if (mode !== undefined) layers[view] = mode;
  }
  const viewSemantics = change.viewSemantics === undefined ? held?.viewSemantics : change.viewSemantics ?? undefined;
  const changed: ReadGraphSettingsEntry = { contextGraphId, layers, ...(viewSemantics === undefined ? {} : { viewSemantics }) };
  return [...entries.filter((entry) => entry.contextGraphId !== contextGraphId), changed];
}

function applyRefused(contextGraphId: string, reason: string, changes?: readonly ReadGraphModeChange[]): ChangeResult {
  return refused(409, {
    code: 'READ_GRAPHS_APPLY_REFUSED',
    error: `Search across assets couldn't be changed for ${contextGraphId}, and its settings stay as they were: ${reason}.`,
    ...(changes === undefined ? {} : { changes }),
  });
}

/** A context graph's mode in each layer. */
function layersOf(modes: ReadGraphModes | undefined, contextGraphId: string): Record<GetView, ReadGraphMode> {
  return Object.fromEntries(GET_VIEWS.map((view) => [view, readGraphModeOfLayer(modes, contextGraphId, LAYER_OF_VIEW[view])])) as Record<GetView, ReadGraphMode>;
}

/** What a change set, for the daemon's log. */
function describe(request: ReadGraphSettingsRequest, changes: readonly ReadGraphModeChange[]): string {
  const parts = changes.filter((change) => change.contextGraphId === request.contextGraphId && change.outcome === 'applied')
    .map((change) => `${change.layer} ${change.from} -> ${change.to}`);
  if (request.viewSemantics !== undefined) parts.push(`view semantics ${request.viewSemantics ?? 'the node\'s default'}`);
  return parts.length > 0 ? parts.join(', ') : 'nothing changed';
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function unavailable(error: unknown): ChangeResult {
  return refused(503, { code: 'READ_GRAPH_SETTINGS_UNAVAILABLE', error: `This node's search-across-assets settings can't be changed now: ${messageOf(error)}.` });
}
