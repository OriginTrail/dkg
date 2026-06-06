/**
 * Shared Working Memory publish / share / memory-search tool definitions for
 * {@link DkgNodePlugin}.
 *
 * Moved verbatim out of `DkgNodePlugin.tools()` — same metadata and handler
 * delegation, only relocated. The `execute` callbacks forward to the host's
 * `handle*` methods (see {@link DkgToolHost}). No behavior change.
 */
import type { OpenClawTool } from '../types.js';
import { EXISTING_CONTEXT_GRAPH_ID_DESCRIPTION } from '../dkg-node-plugin-constants.js';
import type { DkgToolHost } from './tool-host.js';

export function buildMemoryTools(ctx: DkgToolHost): OpenClawTool[] {
  return [
    // ── Shared Working Memory → Verified Memory publish (canonical step 4) ─
    {
      name: 'dkg_shared_memory_publish',
      description:
        'Final step of the canonical flow. Publish all Shared Working Memory in a context graph to Verified ' +
        'Memory (on-chain) and clear SWM. Use after `dkg_assertion_promote` to finalize promoted data. ' +
        'If the context graph is still local-only/unregistered, set `register_if_needed: true` to explicitly ' +
        'upgrade it to on-chain registration before publishing.',
      parameters: {
        type: 'object',
        properties: {
          context_graph_id: { type: 'string', description: `Target context graph. ${EXISTING_CONTEXT_GRAPH_ID_DESCRIPTION}` },
          root_entities: {
            type: 'array',
            items: { type: 'string', description: 'Root entity URI to publish.' },
            description: 'Optional filter — publish only these root entities. Omit to publish all SWM in the CG.',
          },
          sub_graph_name: {
            type: 'string',
            description: 'Optional sub-graph scope. Must match the sub-graph used during create/write/promote. Cannot be combined with a cross-CG publish target.',
          },
          register_if_needed: {
            type: 'boolean',
            description: 'When true, explicitly register the context graph on-chain before publishing if needed. This may spend gas/TRAC; it is opt-in and not the default.',
          },
          reveal_on_chain: {
            type: 'boolean',
            description: 'Deprecated compatibility no-op. V10 context graph registration ignores metadata reveal.',
          },
          access_policy: {
            type: 'number',
            description: 'Optional registration access policy used only when `register_if_needed` is true: `0` for open, `1` for private.',
          },
        },
        required: ['context_graph_id'],
      },
      execute: async (_toolCallId, args) => ctx.handleSharedMemoryPublish(args),
    },
    {
      name: 'dkg_share',
      description:
        'Direct Shared Working Memory write — gossip-replicate a concise free-text fact ' +
        'to the team. Lightweight alternative to the canonical dkg_assertion_create → ' +
        'dkg_assertion_write → dkg_assertion_promote flow; use the canonical flow when the ' +
        'data needs to be staged, retracted, or promoted to Verified Memory.',
      parameters: {
        type: 'object',
        properties: {
          content: {
            type: 'string',
            description: 'Free-text knowledge to share with the team.',
          },
          context_graph_id: {
            type: 'string',
            description: `Target context graph. ${EXISTING_CONTEXT_GRAPH_ID_DESCRIPTION}`,
          },
          sub_graph_name: {
            type: 'string',
            description: 'Optional sub-graph scope.',
          },
        },
        required: ['content', 'context_graph_id'],
      },
      execute: async (_toolCallId, args) => ctx.handleShare(args),
    },
    {
      name: 'memory_search',
      description:
        'Search your DKG-backed memory across all trust tiers (Working Memory drafts, ' +
        'Shared Working Memory, and on-chain Verified Memory) in both your agent-context ' +
        'graph and the currently-selected project context graph. Returns the top-N most ' +
        'relevant memory snippets with trust-weighted ranking (VM > SWM > WM). Prefer this ' +
        'over dkg_query for free-text recall; use dkg_query only when you need precise ' +
        'SPARQL control over a known graph pattern.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Free-text search query. Case-insensitive keyword match (≥2 chars).',
          },
          limit: {
            type: ['number', 'string'],
            description: 'Max hits to return. Integer in [1, 100]. Default 20.',
          },
          sub_graph_name: {
            type: 'string',
            description:
              'Optional project sub-graph scope. Applies only to project context graph fan-out; ' +
              'requires a currently selected project context graph.',
          },
        },
        required: ['query'],
      },
      execute: async (_toolCallId, args) => ctx.handleMemorySearch(args),
    },
  ];
}
