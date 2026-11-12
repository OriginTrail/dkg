/**
 * "Search across assets" settings (the node's read graphs):
 * `dkg_read_graphs_status` shows them and `dkg_read_graphs_set` changes one
 * context graph's. Both call the node's admin-only settings route with this
 * server's token and nothing else; the node refuses any token that is not the
 * node admin's, and the tools say so.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  READ_GRAPH_LAYER_INPUTS,
  READ_GRAPH_MODE_INPUTS,
  describeReadGraphChanges,
  describeReadGraphSettings,
  describeReadGraphSettingsRefusal,
  readGraphModeOf,
  readGraphModes,
  type ReadGraphSettingsChange,
} from '@origintrail-official/dkg-core/read-graph-settings';
import { MISSING_TOKEN_HELP } from '../auth-diagnostics.js';
import { normalizeContextGraphId, type DkgClient } from '../client.js';
import type { DkgConfig } from '../config.js';
import { DkgHttpError } from '../http-error.js';
import { EXISTING_CONTEXT_GRAPH_ID_DESCRIPTION } from './context-graph-description.js';

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

const ok = (text: string, answer: unknown): ToolResult => ({
  content: [{ type: 'text', text }],
  ...(answer !== null && typeof answer === 'object' && !Array.isArray(answer)
    ? { structuredContent: answer as Record<string, unknown> }
    : {}),
});
const errResult = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true });

/** Shared by the create tool's read-graph option. */
export const READ_GRAPH_LAYER_DESCRIPTION =
  'Which memory: "verifiable-memory" (published assets, the default), "shared-working-memory" ' +
  '(shared memory, shared with your team), "working-memory" (private drafts), or "all".';

/** What a tool says when the node refuses a settings request, or cannot be reached. */
function readGraphSettingsRefusal(error: unknown): ToolResult {
  if (!(error instanceof DkgHttpError)) {
    return errResult(describeReadGraphSettingsRefusal({ message: error instanceof Error ? error.message : String(error) }, 'this MCP server'));
  }
  const hint = error.message.includes(MISSING_TOKEN_HELP) ? ` ${MISSING_TOKEN_HELP}` : '';
  return errResult(describeReadGraphSettingsRefusal(error, 'this MCP server') + hint);
}

export function registerReadGraphTools(server: McpServer, client: DkgClient, _config: DkgConfig): void {
  server.registerTool(
    'dkg_read_graphs_status',
    {
      title: 'Search Across Assets Settings',
      description:
        'Show where this node lets queries search across assets: for each context graph and memory (published ' +
        'assets, shared memory, private drafts), whether it is Off, in Preview (a combined copy is prepared without ' +
        'changing any results) or On (queries that ask for it search across assets), and how far that copy is. ' +
        'Needs the node admin token: with any other token the node refuses and shows nothing.',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        contextGraphId: z.string().min(1).optional().describe(`Show this context graph only. ${EXISTING_CONTEXT_GRAPH_ID_DESCRIPTION}`),
      },
    },
    async ({ contextGraphId }): Promise<ToolResult> => {
      const id = contextGraphId === undefined ? undefined : normalizeContextGraphId(contextGraphId);
      if (id === '') return errResult('"contextGraphId" is empty.');
      try {
        const answer = await client.readGraphSettings(id);
        return ok(describeReadGraphSettings(answer), answer);
      } catch (error) {
        return readGraphSettingsRefusal(error);
      }
    },
  );

  server.registerTool(
    'dkg_read_graphs_set',
    {
      title: 'Change Search Across Assets',
      description:
        'Turn search across assets Off, to Preview, or On for one context graph, in one memory or all three, and ' +
        'choose whether its queries search across assets by default. Off removes the combined copy. Preview prepares ' +
        'it and shows how results would change, without changing any results yet. On lets queries that ask for it ' +
        'search across assets once the copy is ready. Needs the node admin token: with any other token the node ' +
        'refuses and nothing changes. Returns what changed and the settings in force afterwards.',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        contextGraphId: z.string().min(1).describe(EXISTING_CONTEXT_GRAPH_ID_DESCRIPTION),
        mode: z.enum(READ_GRAPH_MODE_INPUTS).optional().describe(
          '"off" removes the combined copy; "preview" prepares it and shows how results would change, without ' +
            'changing any results yet; "on" lets queries that ask for it search across assets once the copy is ready.',
        ),
        layer: z.enum(READ_GRAPH_LAYER_INPUTS).optional().describe(`${READ_GRAPH_LAYER_DESCRIPTION} Needs \`mode\`.`),
        defaultSemantics: z.enum(['merged', 'per-asset', 'none']).optional().describe(
          'Whether this context graph\'s queries search across assets by default: "merged" (one query can link facts ' +
            'from different assets), "per-asset" (each asset is searched on its own), or "none" (the node\'s default).',
        ),
      },
    },
    async ({ contextGraphId, mode, layer, defaultSemantics }): Promise<ToolResult> => {
      const id = normalizeContextGraphId(contextGraphId);
      if (!id) return errResult('"contextGraphId" is empty.');
      if (mode === undefined && defaultSemantics === undefined) return errResult('Give "mode", "defaultSemantics", or both.');
      if (mode === undefined && layer !== undefined) return errResult('"layer" needs "mode".');
      const change: ReadGraphSettingsChange = {
        contextGraphId: id,
        ...(mode === undefined ? {} : { layers: readGraphModes(layer ?? 'verifiable-memory', readGraphModeOf(mode)) }),
        ...(defaultSemantics === undefined ? {} : { viewSemantics: defaultSemantics === 'none' ? null : defaultSemantics }),
      };
      try {
        const answer = await client.setReadGraphSettings(change);
        const changed = describeReadGraphChanges(answer);
        return ok(changed === undefined ? describeReadGraphSettings(answer) : `${changed}\n\n${describeReadGraphSettings(answer)}`, answer);
      } catch (error) {
        return readGraphSettingsRefusal(error);
      }
    },
  );
}
