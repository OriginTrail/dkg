import { describe, expect, it } from 'vitest';
import { isMutatingTool, routeTools } from '../src/tool-router.js';
import type { McpToolDefinition } from '../src/schema.js';

function tools(...names: string[]): McpToolDefinition[] {
  return names.map((name) => ({ name, inputSchema: { type: 'object' } }));
}

const surface = tools(
  'dkg_status',
  'dkg_list_context_graphs',
  'dkg_sub_graph_list',
  'dkg_query',
  'dkg_get_entity',
  'dkg_get_entity_sources',
  'dkg_memory_search',
  'dkg_query_catalog_list',
  'dkg_query_catalog_run',
  'dkg_query_catalog_save',
  'dkg_context_graph_create',
  'dkg_sub_graph_create',
  'dkg_knowledge_asset_create',
  'dkg_knowledge_asset_share',
  'dkg_knowledge_asset_publish',
);

describe('tool router', () => {
  it('withholds all DKG tools from a greeting', () => {
    const route = routeTools({ prompt: 'hello there', tools: surface });
    expect(route.profile).toBe('chat');
    expect(route.tools).toEqual([]);
  });

  it('selects only the compact catalog profile for saved-query discovery', () => {
    const route = routeTools({ prompt: 'Which DKG query catalog queries are saved?', tools: surface });
    expect(route.profile).toBe('catalog');
    expect(route.tools.map((tool) => tool.name)).toEqual([
      'dkg_status',
      'dkg_list_context_graphs',
      'dkg_query_catalog_list',
      'dkg_query_catalog_run',
    ]);
  });

  it('keeps general reads within the configured tool budget', () => {
    const route = routeTools({
      prompt: 'Search DKG memory and describe the entity with its provenance',
      tools: surface,
      maxTools: 5,
    });
    expect(route.profile).toBe('read');
    expect(route.tools.length).toBeLessThanOrEqual(5);
    expect(route.tools.map((tool) => tool.name)).toContain('dkg_get_entity');
  });

  it('fails closed when a mutation is requested in read-only mode', () => {
    const route = routeTools({
      prompt: 'Create a DKG knowledge asset with these triples',
      tools: surface,
    });
    expect(route.writeBlocked).toBe(true);
    expect(route.tools).toEqual([]);
  });

  it('exposes a relevant mutation only after explicit write opt-in', () => {
    const route = routeTools({
      prompt: 'Save this query in the DKG query catalog',
      tools: surface,
      allowWrite: true,
    });
    expect(route.profile).toBe('write');
    expect(route.tools.map((tool) => tool.name)).toContain('dkg_query_catalog_save');
    expect(route.tools[0].name).toBe('dkg_query_catalog_save');
    expect(route.tools.map((tool) => tool.name)).not.toContain('dkg_knowledge_asset_create');
  });

  it('treats hyphenated query-catalog as the same write intent', () => {
    const route = routeTools({
      prompt: 'Save a parameterized DKG query-catalog entry',
      tools: surface,
      allowWrite: true,
    });
    expect(route.profile).toBe('write');
    expect(route.tools[0].name).toBe('dkg_query_catalog_save');
  });

  it('does not expose on-chain registration for a local graph-create request', () => {
    const route = routeTools({
      prompt: 'Create a new DKG context graph',
      tools: tools(
        'dkg_status',
        'dkg_list_context_graphs',
        'dkg_context_graph_create',
        'dkg_context_graph_register',
      ),
      allowWrite: true,
    });
    expect(route.tools.map((tool) => tool.name)).toContain('dkg_context_graph_create');
    expect(route.tools.map((tool) => tool.name)).not.toContain('dkg_context_graph_register');
  });

  it('does not mistake an existing graph/subgraph scope for graph creation', () => {
    const route = routeTools({
      prompt:
        'In context graph benchmark and subgraph products, create a knowledge asset. '
        + 'Do not share or publish it.',
      tools: surface,
      allowWrite: true,
    });
    const names = route.tools.map((tool) => tool.name);
    expect(names).toContain('dkg_knowledge_asset_create');
    expect(names).not.toContain('dkg_context_graph_create');
    expect(names).not.toContain('dkg_sub_graph_create');
    expect(names).not.toContain('dkg_knowledge_asset_share');
    expect(names).not.toContain('dkg_knowledge_asset_publish');
  });

  it('keeps a read request read-only when mutation words are explicitly negated', () => {
    const route = routeTools({
      prompt: 'Describe the DKG knowledge asset. Do not share or publish it.',
      tools: surface,
    });
    expect(route.profile).toBe('read');
    expect(route.writeBlocked).toBe(false);
  });

  it('still exposes subgraph creation for an explicit subgraph-create request', () => {
    const route = routeTools({
      prompt: 'Create a new subgraph in DKG context graph benchmark',
      tools: surface,
      allowWrite: true,
    });
    const names = route.tools.map((tool) => tool.name);
    expect(names).toContain('dkg_sub_graph_create');
    expect(names).not.toContain('dkg_context_graph_create');
  });

  it('uses MCP annotations for adapter tools that are not in the built-in lists', () => {
    expect(isMutatingTool({
      name: 'partner_lookup',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    })).toBe(false);
    expect(isMutatingTool({
      name: 'partner_apply',
      inputSchema: {},
      annotations: { readOnlyHint: false },
    })).toBe(true);
  });

  it('routes a partner-domain prompt to profile tools without hard-coded domain words', () => {
    const partnerTools: McpToolDefinition[] = [{
      name: 'partner_trace_configuration',
      inputSchema: { type: 'object' },
      annotations: { readOnlyHint: true },
    }];
    const route = routeTools({
      prompt: 'Trace configuration 748387 through its lifecycle',
      tools: [...surface, ...partnerTools],
      domainKeywords: ['configuration', 'lifecycle'],
      additionalReadToolNames: ['partner_trace_configuration'],
    });
    expect(route.profile).toBe('read');
    expect(route.tools[0].name).toBe('partner_trace_configuration');
  });

  it('applies the read-only gate to partner-domain mutation intent', () => {
    const route = routeTools({
      prompt: 'Insert a new supplier record',
      tools: [{
        name: 'partner_insert_supplier',
        inputSchema: { type: 'object' },
        annotations: { readOnlyHint: false },
      }],
      domainKeywords: ['supplier'],
      additionalWriteToolNames: ['partner_insert_supplier'],
    });
    expect(route.writeBlocked).toBe(true);
  });
});
