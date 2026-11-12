/**
 * "Search across assets" settings (the node's read graphs) for
 * {@link DkgNodePlugin}: `dkg_read_graphs_status` shows them and
 * `dkg_read_graphs_set` changes one context graph's, and
 * `dkg_context_graph_create` can set them at creation. They call the node's
 * admin-only settings route with this adapter's token and nothing else; the
 * node refuses any token that is not the node admin's, and the tools say so.
 */
import {
  READ_GRAPH_CREATE_MODE_INPUTS,
  READ_GRAPH_LAYER_INPUTS,
  READ_GRAPH_MODE_INPUTS,
  describeReadGraphChanges,
  describeReadGraphSettings,
  describeReadGraphSettingsRefusal,
  describeReadGraphsCreateOutcome,
  readGraphModeOf,
  readGraphModes,
  type ReadGraphLayerInput,
  type ReadGraphModeInput,
  type ReadGraphSettingsChange,
  type ReadGraphsCreateSetting,
} from '@origintrail-official/dkg-core/read-graph-settings';
import { DkgDaemonHttpError, normalizeContextGraphId, type DkgDaemonClient } from '../dkg-client.js';
import { EXISTING_CONTEXT_GRAPH_ID_DESCRIPTION } from '../dkg-node-plugin-constants.js';
import type { JSONSchemaProperty, OpenClawTool, OpenClawToolResult } from '../types.js';

type ReadGraphsClient = Pick<DkgDaemonClient, 'readGraphSettings' | 'setReadGraphSettings'>;

const SEMANTICS_INPUTS = ['merged', 'per-asset', 'none'] as const;

const LAYER_PROPERTY: JSONSchemaProperty = {
  type: 'string',
  enum: READ_GRAPH_LAYER_INPUTS,
  description:
    'Which memory: "verifiable-memory" (published assets, the default), "shared-working-memory" ' +
    '(shared memory, shared with your team), "working-memory" (private drafts), or "all".',
};

/** The create tool's optional properties: `read_graphs` and `read_graph_layer`. */
export const READ_GRAPHS_CREATE_PROPERTIES: Record<string, JSONSchemaProperty> = {
  read_graphs: {
    type: 'string',
    enum: READ_GRAPH_CREATE_MODE_INPUTS,
    description:
      'Optionally let queries search across this context graph\'s assets: "preview" prepares a combined copy and ' +
      'shows how results would change, without changing any results yet; "on" lets queries that ask for it search ' +
      'across assets once the copy is ready. Needs the node admin token: without it the context graph is still ' +
      'created, without this setting.',
  },
  read_graph_layer: { ...LAYER_PROPERTY, description: `${LAYER_PROPERTY.description} Needs read_graphs.` },
};

/**
 * The create tool's `read_graphs` and `read_graph_layer` arguments, checked:
 * the request field to send, none when not asked, or what is wrong.
 */
export function readGraphsCreateOption(args: Record<string, unknown>): { readGraphs?: ReadGraphsCreateSetting } | { error: string } {
  const { read_graphs: mode, read_graph_layer: layer } = args;
  if (mode === undefined) return layer === undefined ? {} : { error: '"read_graph_layer" needs "read_graphs".' };
  if (!includes(READ_GRAPH_CREATE_MODE_INPUTS, mode)) return { error: `"read_graphs" must be one of ${READ_GRAPH_CREATE_MODE_INPUTS.join(', ')}.` };
  if (layer !== undefined && !includes(READ_GRAPH_LAYER_INPUTS, layer)) return { error: `"read_graph_layer" must be one of ${READ_GRAPH_LAYER_INPUTS.join(', ')}.` };
  return { readGraphs: { layers: readGraphModes((layer as ReadGraphLayerInput | undefined) ?? 'verifiable-memory', readGraphModeOf(mode)) } };
}

/** The node's create answer, with what happened to the read-graph setting in plain words when one was asked for. */
export function withReadGraphsOutcome<T extends { readGraphs?: unknown }>(
  result: T,
  asked: ReadGraphsCreateSetting | undefined,
  contextGraphId: string,
): T & { searchAcrossAssets?: string } {
  return asked ? { ...result, searchAcrossAssets: describeReadGraphsCreateOutcome(contextGraphId, asked, result.readGraphs) } : result;
}

export function buildReadGraphTools(client: ReadGraphsClient): OpenClawTool[] {
  return [
    {
      name: 'dkg_read_graphs_status',
      description:
        'Show where this node lets queries search across assets: for each context graph and memory (published ' +
        'assets, shared memory, private drafts), whether it is Off, in Preview (a combined copy is prepared without ' +
        'changing any results) or On (queries that ask for it search across assets), and how far that copy is. ' +
        '`summary` says it in plain words. Needs the node admin token: with any other token the node refuses and ' +
        'shows nothing.',
      parameters: {
        type: 'object',
        properties: {
          context_graph_id: { type: 'string', description: `Show this context graph only. ${EXISTING_CONTEXT_GRAPH_ID_DESCRIPTION}` },
        },
        required: [],
      },
      execute: async (_toolCallId, args) => {
        const id = (args ?? {}).context_graph_id;
        if (id !== undefined && !isContextGraphId(id)) return error('"context_graph_id" must be a context graph id.');
        try {
          const answer = await client.readGraphSettings(id as string | undefined);
          return result({ summary: describeReadGraphSettings(answer), ...asRecord(answer) });
        } catch (err) {
          return refusal(err);
        }
      },
    },
    {
      name: 'dkg_read_graphs_set',
      description:
        'Turn search across assets Off, to Preview, or On for one context graph, in one memory or all three, and ' +
        'choose whether its queries search across assets by default. Off removes the combined copy. Preview prepares ' +
        'it and shows how results would change, without changing any results yet. On lets queries that ask for it ' +
        'search across assets once the copy is ready. Needs the node admin token: with any other token the node ' +
        'refuses and nothing changes. Returns what changed and the settings in force afterwards; `summary` says it ' +
        'in plain words.',
      parameters: {
        type: 'object',
        properties: {
          context_graph_id: { type: 'string', description: `Context graph to change. ${EXISTING_CONTEXT_GRAPH_ID_DESCRIPTION}` },
          mode: {
            type: 'string',
            enum: READ_GRAPH_MODE_INPUTS,
            description:
              '"off" removes the combined copy; "preview" prepares it and shows how results would change, without ' +
              'changing any results yet; "on" lets queries that ask for it search across assets once the copy is ready.',
          },
          layer: { ...LAYER_PROPERTY, description: `${LAYER_PROPERTY.description} Needs mode.` },
          default_semantics: {
            type: 'string',
            enum: SEMANTICS_INPUTS,
            description:
              'Whether this context graph\'s queries search across assets by default: "merged" (one query can link ' +
              'facts from different assets), "per-asset" (each asset is searched on its own), or "none" (the node\'s default).',
          },
        },
        required: ['context_graph_id'],
      },
      execute: async (_toolCallId, args) => {
        const change = readGraphsChange(args ?? {});
        if ('error' in change) return error(change.error);
        try {
          const answer = await client.setReadGraphSettings(change);
          const changed = describeReadGraphChanges(answer);
          const settings = describeReadGraphSettings(answer);
          return result({ summary: changed === undefined ? settings : `${changed}\n\n${settings}`, ...asRecord(answer) });
        } catch (err) {
          return refusal(err);
        }
      },
    },
  ];
}

function readGraphsChange(args: Record<string, unknown>): ReadGraphSettingsChange | { error: string } {
  const { context_graph_id: id, mode, layer, default_semantics: semantics } = args;
  if (!isContextGraphId(id)) return { error: '"context_graph_id" is required.' };
  if (mode !== undefined && !includes(READ_GRAPH_MODE_INPUTS, mode)) return { error: `"mode" must be one of ${READ_GRAPH_MODE_INPUTS.join(', ')}.` };
  if (layer !== undefined && !includes(READ_GRAPH_LAYER_INPUTS, layer)) return { error: `"layer" must be one of ${READ_GRAPH_LAYER_INPUTS.join(', ')}.` };
  if (semantics !== undefined && !includes(SEMANTICS_INPUTS, semantics)) return { error: `"default_semantics" must be one of ${SEMANTICS_INPUTS.join(', ')}.` };
  if (mode === undefined && semantics === undefined) return { error: 'Give "mode", "default_semantics", or both.' };
  if (mode === undefined && layer !== undefined) return { error: '"layer" needs "mode".' };
  return {
    contextGraphId: id,
    ...(mode === undefined ? {} : { layers: readGraphModes((layer as ReadGraphLayerInput | undefined) ?? 'verifiable-memory', readGraphModeOf(mode as ReadGraphModeInput)) }),
    ...(semantics === undefined ? {} : { viewSemantics: semantics === 'none' ? null : semantics as 'merged' | 'per-asset' }),
  };
}

/** A context graph id or URI that names one; the client strips the URI prefix once when it sends it. */
function isContextGraphId(value: unknown): value is string {
  return typeof value === 'string' && normalizeContextGraphId(value) !== '';
}

function includes<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (values as readonly string[]).includes(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function result(data: Record<string, unknown>): OpenClawToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], details: data };
}

function error(message: string): OpenClawToolResult {
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], details: { error: message } };
}

function refusal(err: unknown): OpenClawToolResult {
  if (err instanceof DkgDaemonHttpError) return error(describeReadGraphSettingsRefusal(err, 'this OpenClaw adapter'));
  return error(describeReadGraphSettingsRefusal({ message: err instanceof Error ? err.message : String(err) }, 'this OpenClaw adapter'));
}
