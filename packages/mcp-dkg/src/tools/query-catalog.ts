/**
 * Query-catalog MCP facade.
 *
 * The catalog contract (encoding, parameter rendering, execution view, and
 * atomic upsert) belongs to dkg-core + the daemon. These tools intentionally
 * stay thin so CLI, UI, adapters, and local LLM clients execute the same
 * contract rather than growing subtly different catalog implementations.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  CONTEXT_GRAPH_QUERY_SUBGRAPH,
  USER_QUERY_CATALOG_DESCRIPTION,
  USER_QUERY_CATALOG_NAME,
  USER_QUERY_CATALOG_SLUG,
  buildQueryCatalogWrite,
  decodeQueryCatalogReadResponse,
  prepareQueryCatalogExecution,
  type QueryCatalogItem,
} from '@origintrail-official/dkg-core/query-catalog';
import type { DkgClient, SparqlResult } from '../client.js';
import type { DkgConfig } from '../config.js';
import { bindingsToTable } from '../sparql.js';
import { EXISTING_CONTEXT_GRAPH_ID_DESCRIPTION } from './context-graph-description.js';

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

const ok = (text: string, structuredContent?: Record<string, unknown>): ToolResult => ({
  content: [{ type: 'text', text }],
  ...(structuredContent ? { structuredContent } : {}),
});

const err = (text: string): ToolResult => ({
  content: [{ type: 'text', text }],
  isError: true,
});

const formatError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const projectSchema = z
  .string()
  .trim()
  .min(1)
  .optional()
  .describe(`${EXISTING_CONTEXT_GRAPH_ID_DESCRIPTION} Defaults to .dkg/config.yaml.`);

const parameterValueSchema = z.union([z.string(), z.number(), z.boolean()]);

const parameterDefinitionSchema = z.object({
  name: z.string().trim().min(1).describe('Placeholder name without braces.'),
  type: z.enum(['string', 'integer', 'number', 'boolean', 'iri']),
  label: z.string().trim().min(1).optional(),
  description: z.string().trim().min(1).optional(),
  required: z.boolean().optional(),
  defaultValue: parameterValueSchema.optional(),
});

function resolveProject(projectId: string | undefined, config: DkgConfig): string | null {
  return projectId ?? config.defaultProject ?? null;
}

function projectError(): ToolResult {
  return err(
    'No project specified. Pass `projectId`, set `DKG_PROJECT`, or pin a Context Graph in `.dkg/config.yaml`.',
  );
}

function qualifiedSelector(item: QueryCatalogItem): string {
  return `${item.subGraph}/${item.catalogSlug}/${item.slug}`;
}

function findSavedQuery(items: QueryCatalogItem[], selector: string): QueryCatalogItem | undefined {
  const qualified = items.filter((item) => qualifiedSelector(item) === selector);
  if (qualified.length === 1) return qualified[0];
  const matches = items.filter((item) => item.slug === selector || item.name === selector);
  if (matches.length > 1) {
    throw new Error(
      `Saved query selector is ambiguous: ${selector}. Use one of: `
      + matches.map(qualifiedSelector).join(', '),
    );
  }
  return matches[0];
}

function renderParameters(item: QueryCatalogItem): string {
  if (item.parameters.length === 0) return 'none';
  return item.parameters.map((parameter) => {
    const optional = parameter.defaultValue === undefined
      ? 'required'
      : `default=${JSON.stringify(parameter.defaultValue)}`;
    return `${parameter.name}:${parameter.type} (${optional})`;
  }).join(', ');
}

function renderQueryResult(result: SparqlResult, limit: number): string {
  if (result.type === 'boolean') return String(result.value);
  if (result.type === 'quads') {
    const all = result.quads;
    const capped = all.slice(0, limit);
    const rows = capped.map((quad) => ({
      subject: quad.subject,
      predicate: quad.predicate,
      object: quad.object,
      graph: quad.graph ?? '',
    }));
    const tail = capped.length < all.length
      ? `\n\n_(showing ${capped.length} of ${all.length})_`
      : '';
    return `${bindingsToTable(rows)}${tail}`;
  }
  const capped = result.bindings.slice(0, limit);
  const tail = capped.length < result.bindings.length
    ? `\n\n_(showing ${capped.length} of ${result.bindings.length})_`
    : '';
  return `${bindingsToTable(capped)}${tail}`;
}

async function readCatalog(client: DkgClient, projectId: string): Promise<QueryCatalogItem[]> {
  const response = await client.readQueryCatalog(projectId);
  return decodeQueryCatalogReadResponse(response);
}

export function registerQueryCatalogTools(
  server: McpServer,
  client: DkgClient,
  config: DkgConfig,
): void {
  server.registerTool(
    'dkg_query_catalog_list',
    {
      title: 'List Query Catalog',
      description:
        'List saved, parameterized queries available in one DKG Context Graph. ' +
        'Returns stable selectors, declared parameters, execution views, and ' +
        'sub-graph scopes. Use this for catalog discovery; it does not execute a query.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        projectId: projectSchema,
        catalogSlug: z.string().trim().min(1).optional(),
        subGraph: z.string().trim().min(1).optional(),
        limit: z.number().int().min(1).max(500).optional().default(100),
      },
    },
    async ({ projectId, catalogSlug, subGraph, limit = 100 }): Promise<ToolResult> => {
      const pid = resolveProject(projectId, config);
      if (!pid) return projectError();
      try {
        const allItems = await readCatalog(client, pid);
        const filtered = allItems.filter((item) =>
          (!catalogSlug || item.catalogSlug === catalogSlug)
          && (!subGraph || item.subGraph === subGraph));
        const items = filtered.slice(0, limit);
        if (items.length === 0) {
          return ok(`No saved queries found in Context Graph \`${pid}\`.`, {
            contextGraphId: pid,
            count: 0,
            items: [],
          });
        }
        const lines = items.map((item) => [
          `- **${item.name}** — \`${qualifiedSelector(item)}\``,
          `  Catalog: \`${item.catalogSlug}\` · Sub-graph: \`${item.subGraph}\` · View: \`${item.view ?? 'default'}\``,
          `  Parameters: ${renderParameters(item)}`,
          ...(item.description ? [`  ${item.description}`] : []),
        ].join('\n'));
        const tail = items.length < filtered.length
          ? `\n\n_(showing ${items.length} of ${filtered.length})_`
          : '';
        return ok(
          `Saved queries in \`${pid}\`:\n\n${lines.join('\n')}${tail}`,
          {
            contextGraphId: pid,
            count: filtered.length,
            items: items.map((item) => ({
              selector: qualifiedSelector(item),
              slug: item.slug,
              name: item.name,
              description: item.description,
              catalogSlug: item.catalogSlug,
              catalogName: item.catalogName,
              subGraph: item.subGraph,
              view: item.view,
              resultColumn: item.resultColumn,
              parameters: item.parameters,
            })),
          },
        );
      } catch (error) {
        return err(`Failed to list query catalog: ${formatError(error)}`);
      }
    },
  );

  server.registerTool(
    'dkg_query_catalog_run',
    {
      title: 'Run Saved Query',
      description:
        'Execute one saved query by its stable selector, slug, or exact name. ' +
        'Runtime parameter values are rendered by the DKG query-catalog contract; ' +
        'they are never interpolated as raw SPARQL.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        projectId: projectSchema,
        selector: z.string().trim().min(1).describe('Prefer the selector returned by dkg_query_catalog_list.'),
        parameters: z.record(parameterValueSchema).optional().default({}),
        limit: z.number().int().min(1).max(500).optional().default(100),
      },
    },
    async ({ projectId, selector, parameters = {}, limit = 100 }): Promise<ToolResult> => {
      const pid = resolveProject(projectId, config);
      if (!pid) return projectError();
      try {
        const items = await readCatalog(client, pid);
        const match = findSavedQuery(items, selector);
        if (!match) return err(`Saved query not found: ${selector}`);
        const execution = prepareQueryCatalogExecution(match, parameters);
        const result = await client.query({
          sparql: execution.sparql,
          contextGraphId: pid,
          ...(execution.subGraphName ? { subGraphName: execution.subGraphName } : {}),
          ...(execution.view ? { view: execution.view } : {}),
        });
        return ok(
          `Saved query **${match.name}** (\`${qualifiedSelector(match)}\`) in \`${pid}\`:\n\n`
          + renderQueryResult(result, limit),
          {
            contextGraphId: pid,
            selector: qualifiedSelector(match),
            query: {
              slug: match.slug,
              name: match.name,
              catalogSlug: match.catalogSlug,
              subGraph: match.subGraph,
              view: match.view,
              parameters: match.parameters,
            },
            result,
          },
        );
      } catch (error) {
        return err(`Failed to run saved query: ${formatError(error)}`);
      }
    },
  );

  server.registerTool(
    'dkg_query_catalog_save',
    {
      title: 'Save Query Catalog Entry',
      description:
        'Save or atomically update a parameterized SPARQL query in the Context ' +
        'Graph profile catalog. This mutates local DKG state. Never call it ' +
        'unless the user explicitly asks to save or update a catalog query.',
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        projectId: projectSchema,
        name: z.string().trim().min(1).max(160),
        description: z.string().trim().min(1).max(2_000).optional(),
        sparql: z.string().trim().min(1).max(100_000),
        subGraph: z.string().trim().min(1).optional().default(CONTEXT_GRAPH_QUERY_SUBGRAPH),
        catalogSlug: z.string().trim().min(1).optional().default(USER_QUERY_CATALOG_SLUG),
        catalogName: z.string().trim().min(1).max(160).optional().default(USER_QUERY_CATALOG_NAME),
        catalogDescription: z.string().trim().min(1).max(2_000).optional().default(USER_QUERY_CATALOG_DESCRIPTION),
        resultColumn: z.string().trim().min(1).optional(),
        rank: z.number().int().min(0).max(1_000_000).optional().default(99),
        catalogRank: z.number().int().min(0).max(1_000_000).optional().default(999),
        parameters: z.array(parameterDefinitionSchema).max(50).optional().default([]),
        view: z.enum(['working-memory', 'shared-working-memory', 'verifiable-memory']).optional(),
        mode: z.enum(['insert', 'upsert']).optional().default('upsert'),
      },
    },
    async (input): Promise<ToolResult> => {
      const pid = resolveProject(input.projectId, config);
      if (!pid) return projectError();
      try {
        const write = buildQueryCatalogWrite({
          contextGraphId: pid,
          name: input.name,
          description: input.description,
          sparql: input.sparql,
          subGraph: input.subGraph,
          catalogSlug: input.catalogSlug,
          catalogName: input.catalogName,
          catalogDescription: input.catalogDescription,
          resultColumn: input.resultColumn,
          rank: input.rank,
          catalogRank: input.catalogRank,
          parameters: input.parameters,
          view: input.view,
        });
        const response = await client.writeQueryCatalog({
          contextGraphId: pid,
          quads: write.quads,
          mode: input.mode,
        });
        return ok(
          `Saved query **${write.savedQuery.name}** as \`${qualifiedSelector(write.savedQuery)}\` `
          + `in Context Graph \`${pid}\` (${response.triplesWritten} triples, mode=${response.mode}).`,
          {
            ...response,
            selector: qualifiedSelector(write.savedQuery),
            savedQuery: write.savedQuery,
          },
        );
      } catch (error) {
        return err(`Failed to save catalog query: ${formatError(error)}`);
      }
    },
  );
}
