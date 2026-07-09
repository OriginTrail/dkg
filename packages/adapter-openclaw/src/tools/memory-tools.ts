/**
 * Shared Working Memory publish / share / memory-search tool definitions for
 * {@link DkgNodePlugin}.
 *
 * Moved verbatim out of `DkgNodePlugin.tools()` — same metadata and handler
 * delegation, only relocated. The `execute` callbacks forward to the host's
 * `handle*` methods (see {@link DkgToolHost}). No behavior change.
 */
import type { OpenClawTool } from '../types.js';
import type { DkgToolHost } from './tool-host.js';

export function buildMemoryTools(ctx: DkgToolHost): OpenClawTool[] {
  return [
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
