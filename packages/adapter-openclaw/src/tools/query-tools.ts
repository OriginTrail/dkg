/**
 * Publish / SPARQL query / query-catalog tool definitions for
 * {@link DkgNodePlugin}.
 *
 * Moved verbatim out of `DkgNodePlugin.tools()` — same metadata and handler
 * delegation, only relocated. The `execute` callbacks forward to the host's
 * `handle*` methods (see {@link DkgToolHost}). No behavior change.
 */
import type { OpenClawTool } from '../types.js';
import { EXISTING_CONTEXT_GRAPH_ID_DESCRIPTION } from '../dkg-node-plugin-constants.js';
import type { DkgToolHost } from './tool-host.js';

export function buildQueryTools(ctx: DkgToolHost): OpenClawTool[] {
  return [
    {
      name: 'dkg_publish',
      description:
        'One-shot write + publish helper: creates a fresh auto-named assertion from the supplied quads ' +
        '(seal + share), then publishes THAT one assertion to Verifiable Memory (on-chain). NOTE: this is ' +
        'two HTTP calls (create, then publish), not a single transactional operation — either phase can ' +
        'partially fail (a share-phase failure aborts before publish; a context-graph-binding failure still ' +
        'mints the asset on-chain). For the canonical stepwise flow ' +
        '(create → write → finalize → share → publish) use `dkg_knowledge_asset_create/write/finalize/share` ' +
        'followed by `dkg_knowledge_asset_publish`. Publishing requires the context graph to be registered ' +
        'on-chain — set `register_if_needed: true` to register it first (idempotent) before publishing.',
      parameters: {
        type: 'object',
        properties: {
          context_graph_id: { type: 'string', description: `Target context graph. ${EXISTING_CONTEXT_GRAPH_ID_DESCRIPTION}` },
          quads: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                subject: { type: 'string', description: 'Subject URI.' },
                predicate: { type: 'string', description: 'Predicate URI.' },
                object: { type: 'string', description: 'Object — URI or literal (URI auto-detected by prefix).' },
              },
              required: ['subject', 'predicate', 'object'],
            },
            description:
              'Quads to publish. Example: `[{ subject: "https://example.org/a", predicate: "https://schema.org/name", object: "Alpha" }]`. ' +
              'Object values starting with http://, https://, urn:, did: are passed as URIs; anything else becomes a literal.',
          },
          register_if_needed: {
            type: 'boolean',
            description:
              'If the context graph is not yet registered on-chain, register it first (idempotent), then publish. ' +
              'Registration may spend gas/TRAC; it is opt-in. Default false — when false and the CG is ' +
              'unregistered, publish fails with the daemon\'s not-registered error.',
          },
          access_policy: {
            type: 'number',
            description: 'Registration access policy: `0` for open, `1` for private. Requires `register_if_needed: true` — it only applies when registering the CG, and is rejected otherwise.',
          },
        },
        required: ['context_graph_id', 'quads'],
      },
      execute: async (_toolCallId, args) => ctx.handlePublish(args),
    },
    {
      name: 'dkg_query',
      description:
        'Read-only SPARQL query against the local triple store. Pass `view` to pick which memory ' +
        'layer to read: `working-memory` (WM — per-agent), `shared-working-memory` (SWM — gossip-' +
        'replicated), or `verifiable-memory` (VM — on-chain anchored); when `view` is supplied, ' +
        '`context_graph_id` is also required. For WM reads, `agent_address` selects whose WM to ' +
        'read; prefer the injected `current_agent_address` from turn context when present. If a WM ' +
        'read looks unexpectedly empty, retry alternate identity forms before concluding there is no ' +
        'WM data. It defaults to this node\'s agent address (the same default the adapter uses for ' +
        'memory-plugin reads). Omit `view` for a cross-graph query routed via the legacy data-' +
        'graph path (unscoped, or scoped when `context_graph_id` is set); use `GRAPH ?g { ... }` ' +
        'for named-graph targeting in that mode.',
      parameters: {
        type: 'object',
        properties: {
          sparql: { type: 'string', description: 'SPARQL SELECT, CONSTRUCT, ASK, or DESCRIBE.' },
          context_graph_id: {
            type: 'string',
            description:
              'CG scope. Use the injected target id when present, an exact existing id from dkg_list_context_graphs, or the full ' +
              'did:dkg:context-graph:<id> URI. Optional when `view` is omitted (unscoped cross-graph query); required ' +
              'when `view` is set (view-based routing always targets a single CG).',
          },
          view: {
            type: 'string',
            description:
              'Memory layer to read. Accepted values: `working-memory` (per-agent WM; uses ' +
              '`agent_address` or falls back to this node\'s agent address), `shared-working-memory` ' +
              '(provisional, gossip-replicated), or `verifiable-memory` (on-chain anchored). Omit to ' +
              'use the legacy cross-graph data-path routing (not layer-scoped). Validation is ' +
              'handler-side (not a JSON-schema enum) so strict-schema hosts still surface the ' +
              'tailored migration guidance on invalid values.',
          },
          agent_address: {
            type: 'string',
            description:
              "Optional target for `view: \"working-memory\"` reads - defaults to this node's " +
              'agent address (matches the default the memory plugin uses for its own WM reads). ' +
              'Prefer the injected `current_agent_address` from chat context when available. ' +
              'Recommended shape is a 0x-prefixed eth address for default-agent deployments. ' +
              'Optionally wrapped in the legacy `did:dkg:agent:` prefix, which is stripped before ' +
              'forwarding. Bare libp2p peer IDs are also accepted as a self-alias for nodes whose ' +
              'writer-side identity falls back to peerId. Ignored for non-WM views. Supply an ' +
              'explicit value to read another local agent\'s WM namespace in multi-agent deployments.',
          },
        },
        required: ['sparql'],
      },
      execute: async (_toolCallId, args) => ctx.handleQuery(args),
    },
    {
      name: 'dkg_query_catalog_list',
      description:
        'List saved SPARQL queries from a context graph profile query catalog. Use this when the user asks ' +
        'what saved/catalog queries are available for a project or before running a saved query by name. ' +
        'Returns sorted items with slug, display name, catalog, sub-graph, description, and SPARQL text.',
      parameters: {
        type: 'object',
        properties: {
          context_graph_id: {
            type: 'string',
            description: `Context graph/project whose profile query catalog should be read. ${EXISTING_CONTEXT_GRAPH_ID_DESCRIPTION}`,
          },
        },
        required: ['context_graph_id'],
      },
      execute: async (_toolCallId, args) => ctx.handleQueryCatalogList(args),
    },
    {
      name: 'dkg_query_catalog_run',
      description:
        'Run a saved SPARQL query from a context graph profile query catalog by slug or exact display name. ' +
        'Call dkg_query_catalog_list first if the selector is ambiguous. Executes the saved SPARQL against ' +
        'the same context graph and saved sub-graph scope using the standard DKG query route.',
      parameters: {
        type: 'object',
        properties: {
          context_graph_id: {
            type: 'string',
            description: `Context graph/project whose saved query should be used. ${EXISTING_CONTEXT_GRAPH_ID_DESCRIPTION}`,
          },
          query: {
            type: 'string',
            description: 'Saved query slug or exact display name.',
          },
        },
        required: ['context_graph_id', 'query'],
      },
      execute: async (_toolCallId, args) => ctx.handleQueryCatalogRun(args),
    },
    {
      name: 'dkg_query_catalog_save',
      description:
        'Save a read-only SPARQL query into a context graph profile query catalog. Use only when the user ' +
        'explicitly asks to save a query and you have the query text. Defaults to the UI "Saved queries" ' +
        'catalog for whole-context-graph queries.',
      parameters: {
        type: 'object',
        properties: {
          context_graph_id: {
            type: 'string',
            description: `Context graph/project whose profile query catalog should receive the saved query. ${EXISTING_CONTEXT_GRAPH_ID_DESCRIPTION}`,
          },
          name: {
            type: 'string',
            description: 'Human-readable saved query name.',
          },
          sparql: {
            type: 'string',
            description: 'Read-only SPARQL query text. Must start with SELECT, ASK, CONSTRUCT, or DESCRIBE after optional PREFIX/BASE declarations.',
          },
          description: {
            type: 'string',
            description: 'Optional short description of what the saved query returns.',
          },
          sub_graph: {
            type: 'string',
            description:
              'Optional profile sub-graph scope. Defaults to "__context_graph", the whole-context-graph query surface.',
          },
          catalog_slug: {
            type: 'string',
            description: 'Optional catalog slug. Defaults to "ui-saved-queries".',
          },
          catalog_name: {
            type: 'string',
            description: 'Optional catalog display name. Defaults to "Saved queries".',
          },
          catalog_description: {
            type: 'string',
            description: 'Optional catalog description. Defaults to the UI saved-query catalog description.',
          },
          result_column: {
            type: 'string',
            description: 'Optional SELECT variable name, without "?", that identifies entity URI results for UI entity-list rendering.',
          },
        },
        required: ['context_graph_id', 'name', 'sparql'],
      },
      execute: async (_toolCallId, args) => ctx.handleQueryCatalogSave(args),
    },
  ];
}
