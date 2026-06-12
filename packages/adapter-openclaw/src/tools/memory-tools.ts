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
    // ── Shared Working Memory → Verifiable Memory publish (canonical step 4) ─
    {
      name: 'dkg_shared_memory_publish',
      description:
        'SWM-bridge / CG-wide publish (legacy, retained). Publish all Shared Working Memory in a context ' +
        'graph to Verifiable Memory (on-chain) and clear SWM. To publish a SINGLE named knowledge asset, ' +
        'prefer `dkg_knowledge_asset_publish` (multi-root-safe). This bulk route is single-root-per-call: ' +
        'with more than one root entity in SWM it returns 409 MULTI_ROOT_PUBLISH_NOT_ATOMIC. Use after ' +
        '`dkg_knowledge_asset_share`. NOTE: this CG-wide publish AUTO-registers an unregistered context ' +
        'graph on-chain at gas/TRAC cost regardless of `register_if_needed` — omitting the flag is NOT ' +
        'gas-free. `register_if_needed` only lets you set the registration\'s `access_policy`.',
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
            description: 'Run an EXPLICIT on-chain registration before publishing, which lets you set `access_policy` on that registration. NOTE: this does NOT gate whether registration happens — a CG-wide publish AUTO-registers an unregistered context graph at gas/TRAC cost regardless of this flag. Set it only to choose the registration\'s access_policy (the implicit auto-register on publish otherwise defaults the policy).',
          },
          reveal_on_chain: {
            type: 'boolean',
            description: 'Deprecated compatibility no-op. V10 context graph registration ignores metadata reveal.',
          },
          access_policy: {
            type: 'number',
            description: 'Optional access policy (`0` open, `1` private) for the EXPLICIT registration. Requires `register_if_needed: true` — it only applies to that explicit registration and is rejected otherwise (the implicit auto-register on publish defaults the policy).',
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
        'to the team. Lightweight alternative to the canonical dkg_knowledge_asset_create → ' +
        'dkg_knowledge_asset_write → dkg_knowledge_asset_share flow; use the canonical flow when the ' +
        'data needs to be staged, retracted, or published to Verifiable Memory.',
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
        'Shared Working Memory, and on-chain Verifiable Memory) in both your agent-context ' +
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
        },
        required: ['query'],
      },
      execute: async (_toolCallId, args) => ctx.handleMemorySearch(args),
    },
  ];
}
