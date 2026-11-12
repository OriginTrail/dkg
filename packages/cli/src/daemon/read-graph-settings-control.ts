/**
 * The daemon's control of read-graph settings per context graph at runtime (OT-RFC-74): what `GET` and `PUT
 * /api/store/read-graphs/settings` and the `readGraphs` field of a context graph's creation do.
 *
 * A change switches nothing on that config.json's policy, the store, a public-checkpoint start or the rollback target
 * does not allow; a switch to `off` and a view-semantics default always pass those checks. It writes the context
 * graph's rows in one transaction, then applies the settings in force to the running node. When the apply refuses or
 * fails, it puts the context graph's previous rows back exactly and answers why. Changes run one at a time, and the
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
import type { ReadGraphSettingsChange } from '../read-graph-settings-store.js';
import {
  MEMORY_IN_SENTENCES,
  type ReadGraphContextGraphSettings,
  type ReadGraphSettingsAnswer,
  type ReadGraphSettingsReadGraph,
  type ReadGraphSettingsRefusal,
  type ReadGraphSettingsRequest,
} from '../read-graph-settings-wire.js';
import { readGraphRollbackTarget, rollbackTargetRefusal } from '../update/read-graph-rollback-target.js';
import { readGraphViewOf } from './routes/read-graphs.js';

const LAYER_OF_VIEW: Readonly<Record<GetView, MemoryLayer>> = {
  'working-memory': MemoryLayer.WorkingMemory,
  'shared-working-memory': MemoryLayer.SharedWorkingMemory,
  'verifiable-memory': MemoryLayer.VerifiableMemory,
};

/** The agent methods the control uses. */
export interface ReadGraphSettingsAgent {
  readonly store: TripleStore;
  applyReadGraphModesV1(next: ReadGraphModes, options?: { signal?: AbortSignal; viewSemantics?: ViewSemanticsSettings }): Promise<readonly ReadGraphModeChange[]>;
  readGraphStatusV1(): ReturnType<DKGAgent['readGraphStatusV1']>;
}

/** What a change answers: an HTTP status and its body. */
export interface ReadGraphSettingsOutcome {
  readonly status: number;
  readonly body: ReadGraphSettingsAnswer | (ReadGraphSettingsRefusal & { readonly changes?: readonly ReadGraphModeChange[] });
}

/** The `readGraphs` part of a context graph's creation answer. */
export type ReadGraphCreateOutcome =
  | { readonly applied: true; readonly changes: readonly ReadGraphModeChange[] }
  | { readonly refused: string; readonly code: string };

/** The `readGraphs` field of a context graph's creation, on a node whose control may not run yet. */
export async function readGraphSettingsOnCreate(
  control: ReadGraphSettingsControl | undefined,
  input: { readonly contextGraphId: string; readonly layers: ReadGraphSettingsRequest['layers']; readonly canAdminister: boolean; readonly actor: string },
): Promise<ReadGraphCreateOutcome> {
  // The token comes first, and its refusal is the same for every context graph.
  if (!input.canAdminister) return NOT_NODE_ADMIN;
  if (control === undefined) {
    return { code: 'READ_GRAPH_SETTINGS_UNAVAILABLE', refused: 'This node\'s search-across-assets settings aren\'t available yet; the context graph was created without them.' };
  }
  return control.applyOnCreate(input.contextGraphId, input.layers, input.actor);
}

/** Build the daemon's control once its agent runs, and say so when its store cannot keep the read graphs the table sets. */
export function startReadGraphSettingsControl(input: {
  readonly settings: DaemonReadGraphSettings;
  readonly agent: ReadGraphSettingsAgent;
  readonly role: 'core' | 'edge';
  readonly checkpoint: boolean;
  readonly log: (message: string) => void;
}): ReadGraphSettingsControl {
  noteReadGraphStoreSupport(input.settings, input.agent.store, input.log);
  return new ReadGraphSettingsControl(input);
}

export class ReadGraphSettingsControl {
  readonly #settings: DaemonReadGraphSettings;
  readonly #agent: ReadGraphSettingsAgent;
  readonly #role: 'core' | 'edge';
  readonly #checkpoint: boolean;
  readonly #log: (message: string) => void;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(input: {
    readonly settings: DaemonReadGraphSettings;
    readonly agent: ReadGraphSettingsAgent;
    readonly role: 'core' | 'edge';
    readonly checkpoint: boolean;
    readonly log: (message: string) => void;
  }) {
    this.#settings = input.settings;
    this.#agent = input.agent;
    this.#role = input.role;
    this.#checkpoint = input.checkpoint;
    this.#log = input.log;
  }

  /** The settings of one context graph, or of every context graph with settings of its own or read graphs. */
  async answer(contextGraphId?: string): Promise<ReadGraphSettingsAnswer> {
    const { policy, table } = this.#settings;
    const refusals = await this.#nodeRefusals();
    const entries = new Map((table === undefined ? [] : safeList(table)).map((entry) => [entry.contextGraphId, entry]));
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

  /** Change one context graph's own settings: see the module documentation. */
  change(request: ReadGraphSettingsRequest, actor: string, signal?: AbortSignal): Promise<ReadGraphSettingsOutcome> {
    return this.#serial(() => this.#change(request, actor, signal));
  }

  /** The `readGraphs` field of a node admin's creation of a context graph, applied after it with the checks of a change. */
  async applyOnCreate(contextGraphId: string, layers: ReadGraphSettingsRequest['layers'], actor: string): Promise<ReadGraphCreateOutcome> {
    const outcome = await this.change({ contextGraphId, ...(layers === undefined ? {} : { layers }) }, actor);
    if (outcome.status === 200 && 'contextGraphs' in outcome.body) return { applied: true, changes: outcome.body.changes ?? [] };
    const body = outcome.body as ReadGraphSettingsRefusal;
    return { code: body.code, refused: body.error };
  }

  async #change(request: ReadGraphSettingsRequest, actor: string, signal: AbortSignal | undefined): Promise<ReadGraphSettingsOutcome> {
    const { policy, table } = this.#settings;
    const { contextGraphId } = request;
    if (!isReadGraphEligibleContextGraphId(contextGraphId)) {
      return { status: 400, body: { code: 'READ_GRAPH_SETTINGS_INVALID', error: `${contextGraphId} is not a context graph that can search across assets.` } };
    }
    const switchesOn = GET_VIEWS.filter((view) => request.layers?.[view] !== undefined && request.layers[view] !== 'off');
    for (const view of switchesOn) {
      const refusal = policyRefusalOf(policy.readGraphsPolicy, view);
      if (refusal !== undefined) return refusedWith(409, refusal, view);
    }
    const refusals = await this.#nodeRefusals();
    if (switchesOn.length > 0 && refusals.length > 0) return refusedWith(409, refusals[0]!, switchesOn[0]);
    // A node that starts from a public checkpoint keeps no settings table, so it takes no change at all.
    if (this.#checkpoint) return refusedWith(409, CHECKPOINT_NODE_REFUSAL);
    if (table === undefined) {
      return { status: 503, body: { code: 'READ_GRAPH_SETTINGS_UNAVAILABLE', error: 'This node\'s search-across-assets settings can\'t be changed: its settings file could not be opened at start.' } };
    }
    const change: ReadGraphSettingsChange = {
      ...(request.layers === undefined ? {} : { layers: request.layers }),
      ...(request.viewSemantics === undefined ? {} : { viewSemantics: request.viewSemantics }),
    };
    let previous: ReturnType<typeof table.rowsOf>;
    try {
      previous = table.rowsOf(contextGraphId);
      table.set(contextGraphId, change, actor);
    } catch (error) {
      return { status: 503, body: { code: 'READ_GRAPH_SETTINGS_UNAVAILABLE', error: `This node's search-across-assets settings can't be changed: ${messageOf(error)}.` } };
    }
    let changes: readonly ReadGraphModeChange[];
    try {
      const { config } = resolveEffectiveQueryConfig(policy, table, { refusals });
      changes = await this.#agent.applyReadGraphModesV1(config.readGraphs, { ...(signal ? { signal } : {}), viewSemantics: config.viewSemantics });
    } catch (error) {
      table.restore(contextGraphId, previous);
      return applyRefused(contextGraphId, messageOf(error));
    }
    const refused = changes.find((entry) => typeof entry.outcome === 'object');
    if (refused !== undefined) {
      table.restore(contextGraphId, previous);
      return applyRefused(contextGraphId, (refused.outcome as { refused: string }).refused, changes);
    }
    this.#log(`[read-graphs] ${actor} changed the settings of ${contextGraphId}: ${describe(request, changes)}.`);
    return { status: 200, body: { ...await this.answer(contextGraphId), changes } };
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
    try {
      const rollback = rollbackTargetRefusal(await readGraphRollbackTarget(this.#role));
      if (rollback !== undefined) refusals.push(rollback);
    } catch (error) {
      refusals.push({ code: 'READ_GRAPHS_ROLLBACK_TARGET_OLDER', message: `the rollback target cannot be read (${messageOf(error)})` });
    }
    return refusals;
  }

  #serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(work);
    this.#queue = run.then(() => undefined, () => undefined);
    return run;
  }
}

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

function refusedWith(status: number, refusal: ReadGraphsRefusal, view?: GetView): ReadGraphSettingsOutcome {
  return { status, body: answerOf(refusal, view) };
}

function applyRefused(contextGraphId: string, reason: string, changes?: readonly ReadGraphModeChange[]): ReadGraphSettingsOutcome {
  return {
    status: 409,
    body: {
      code: 'READ_GRAPHS_APPLY_REFUSED',
      error: `Search across assets couldn't be changed for ${contextGraphId}, so its previous settings are back: ${reason}.`,
      ...(changes === undefined ? {} : { changes }),
    },
  };
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

function safeList(table: NonNullable<DaemonReadGraphSettings['table']>) {
  try {
    return table.list();
  } catch {
    return [];
  }
}
