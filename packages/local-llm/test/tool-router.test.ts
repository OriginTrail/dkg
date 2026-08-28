import { describe, expect, it } from 'vitest';
import { isMutatingTool, routeTools } from '../src/tool-router.js';
import type { McpToolDefinition } from '../src/schema.js';

function tools(...names: string[]): McpToolDefinition[] {
  return names.map((name) => ({ name, inputSchema: { type: 'object' } }));
}

const surface = tools(
  'dkg_status',
  'dkg_peer_info',
  'dkg_wallet_balances',
  'dkg_list_context_graphs',
  'dkg_sub_graph_list',
  'dkg_query',
  'dkg_get_entity',
  'dkg_get_entity_sources',
  'dkg_memory_search',
  'dkg_query_catalog_context_graphs',
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

  it('ranks catalog tools first without exposing catalog mutations for discovery', () => {
    const route = routeTools({ prompt: 'Which DKG query catalog queries are saved?', tools: surface });
    expect(route.profile).toBe('catalog');
    expect(route.tools.map((tool) => tool.name).slice(0, 2)).toEqual([
      'dkg_query_catalog_list',
      'dkg_query_catalog_run',
    ]);
    expect(route.tools.map((tool) => tool.name)).toContain('dkg_query_catalog_list');
    expect(route.tools.map((tool) => tool.name)).toContain('dkg_query_catalog_run');
    expect(route.tools.map((tool) => tool.name)).not.toContain('dkg_query_catalog_save');
    expect(route.tools).toHaveLength(8);
    expect(route.jsonBytes).toBeGreaterThan(0);
    expect(route.reason).toContain('Data-driven catalog route');
  });

  it('routes cross-graph catalog discovery to evidence instead of graph descriptions', () => {
    const metadataSurface = surface.map((tool) => tool.name === 'dkg_query_catalog_context_graphs'
      ? {
          ...tool,
          description:
            'Inspect accessible DKG Context Graphs and return only graphs that actually contain saved query-catalog entries. '
            + 'Use for explicit cross-graph questions such as which/all Context Graphs have catalogs.',
          annotations: { readOnlyHint: true },
        }
      : tool);
    const route = routeTools({ prompt: 'List CGs that have catalogs', tools: metadataSurface });
    expect(route.profile).toBe('catalog');
    expect(route.tools[0]?.name).toBe('dkg_query_catalog_context_graphs');
    expect(route.tools.some(isMutatingTool)).toBe(false);
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
    expect(route.tools[0].name).toBe('dkg_list_context_graphs');
    expect(route.tools.map((tool) => tool.name)).not.toContain('dkg_knowledge_asset_create');
  });

  it('treats hyphenated query-catalog as the same write intent', () => {
    const route = routeTools({
      prompt: 'Save a parameterized DKG query-catalog entry',
      tools: surface,
      allowWrite: true,
    });
    expect(route.profile).toBe('write');
    expect(route.tools.map((tool) => tool.name)).toContain('dkg_query_catalog_save');
  });

  it('maps generic mutation verbs to metadata-compatible tool actions', () => {
    const catalogUpdate = routeTools({
      prompt: 'Update the saved DKG query catalog entry named Models',
      tools: surface,
      allowWrite: true,
    });
    expect(catalogUpdate.tools.map((tool) => tool.name)).toContain('dkg_query_catalog_save');

    const partnerApply = routeTools({
      prompt: 'Apply configuration 748387',
      tools: [{
        name: 'partner_apply_configuration',
        description: 'Apply one approved configuration.',
        inputSchema: { type: 'object' },
        annotations: { readOnlyHint: false },
      }],
      allowWrite: true,
      domainKeywords: ['configuration'],
      additionalWriteToolNames: ['partner_apply_configuration'],
    });
    expect(partnerApply.profile).toBe('write');
    expect(partnerApply.tools.map((tool) => tool.name)).toEqual(['partner_apply_configuration']);
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

  it('fails closed for unknown adapter tools without read-only annotations', () => {
    expect(isMutatingTool({
      name: 'partner_apply',
      inputSchema: {},
    })).toBe(true);
  });

  it('never exposes mutation tools on a read route even when writes are enabled globally', () => {
    const route = routeTools({
      prompt: 'Trace configuration 748387 through its lifecycle',
      tools: [
        ...surface,
        {
          name: 'partner_trace_configuration',
          inputSchema: { type: 'object' },
          annotations: { readOnlyHint: true },
        },
        {
          name: 'partner_apply_configuration',
          inputSchema: { type: 'object' },
          annotations: { readOnlyHint: false },
        },
      ],
      allowWrite: true,
      domainKeywords: ['configuration', 'lifecycle'],
      additionalReadToolNames: ['partner_trace_configuration'],
      additionalToolNames: ['partner_apply_configuration'],
    });
    expect(route.profile).toBe('read');
    expect(route.tools.map((tool) => tool.name)).toContain('partner_trace_configuration');
    expect(route.tools.map((tool) => tool.name)).not.toContain('partner_apply_configuration');
  });

  it('does not misroute general list/which entity questions to node status', () => {
    for (const prompt of [
      'List DKG entities whose rdf:type is urn:test:Model',
      'Which DKG knowledge assets mention configuration 748387?',
    ]) {
      const route = routeTools({ prompt, tools: surface });
      expect(route.profile).toBe('read');
    }
    expect(routeTools({
      prompt: 'What is the DKG node status?',
      tools: surface,
    }).profile).toBe('status');
  });

  it('recognizes Context Graph acronyms and plurals as DKG discovery intent', () => {
    for (const prompt of [
      'What CGs do you see?',
      'Which context graphs are available?',
      'Which locally joined graph projects are visible to this node?',
    ]) {
      const route = routeTools({ prompt, tools: surface });
      expect(route.profile).toBe('read');
      expect(route.tools[0]?.name).toBe('dkg_list_context_graphs');
    }
  });

  it('ranks an unknown read-only adapter from discovered MCP metadata', () => {
    const route = routeTools({
      prompt: 'Which supplier provenance records are missing for configuration 748387?',
      tools: [
        ...surface,
        {
          name: 'partner_trace_product_lifecycle',
          description: 'Trace configuration supplier provenance, inbound events, warehouse records, and shipments.',
          inputSchema: {
            type: 'object',
            properties: { configurationId: { type: 'string' } },
          },
          annotations: { readOnlyHint: true },
        },
      ],
      maxTools: 3,
    });
    expect(route.profile).toBe('read');
    expect(route.tools[0]?.name).toBe('partner_trace_product_lifecycle');
    expect(route.rankedTools[0]?.lexicalScore).toBeGreaterThan(0);
  });

  it('uses input-schema metadata when an adapter name is intentionally opaque', () => {
    const route = routeTools({
      prompt: 'Find configuration ID 748387',
      tools: [{
        name: 'partner_lookup',
        description: 'Read one partner record.',
        inputSchema: {
          type: 'object',
          properties: {
            configurationId: { type: 'string', description: 'Approved Configuration ID' },
          },
        },
        annotations: { readOnlyHint: true },
      }],
      maxTools: 1,
    });
    expect(route.profile).toBe('read');
    expect(route.tools.map((tool) => tool.name)).toEqual(['partner_lookup']);
  });

  it('enforces both tool-count and serialized-schema budgets', () => {
    const metadataTools: McpToolDefinition[] = [
      {
        name: 'partner_configuration_supplier_provenance',
        description: 'Find configuration supplier provenance.',
        inputSchema: { type: 'object' },
        annotations: { readOnlyHint: true },
      },
      {
        name: 'partner_archive_lookup',
        description: `Configuration archive ${'padding '.repeat(2_000)}`,
        inputSchema: { type: 'object' },
        annotations: { readOnlyHint: true },
      },
    ];
    const first = routeTools({
      prompt: 'configuration supplier provenance',
      tools: metadataTools,
      maxTools: 1,
    });
    const bounded = routeTools({
      prompt: 'configuration supplier provenance',
      tools: metadataTools,
      maxTools: 8,
      maxJsonBytes: first.jsonBytes + 1,
    });
    expect(bounded.tools.map((tool) => tool.name))
      .toEqual(['partner_configuration_supplier_provenance']);
    expect(bounded.jsonBytes).toBeLessThanOrEqual(first.jsonBytes + 1);

    const tooSmall = routeTools({
      prompt: 'configuration archive',
      tools: [metadataTools[1]],
      maxJsonBytes: 100,
    });
    expect(tooSmall.tools).toEqual([]);
    expect(tooSmall.jsonBytes).toBe(0);
  });

  it('does not reinterpret a generic creative request as a DKG write', () => {
    const route = routeTools({ prompt: 'Write a haiku about rain', tools: surface });
    expect(route.profile).toBe('chat');
    expect(route.writeBlocked).toBe(false);
    expect(route.tools).toEqual([]);
  });

  it('covers routing holdouts without phrase-specific allowlists', () => {
    const cases = [
      ['Show available CGs', 'dkg_list_context_graphs'],
      ['Find RDF entities and their provenance', 'dkg_get_entity_sources'],
      ['Show recent DKG tasks and decisions', 'dkg_query'],
      ['Run a saved lifecycle query', 'dkg_query_catalog_run'],
      ['Check DKG wallet balances and peer connectivity', 'dkg_status'],
    ] as const;
    for (const [prompt, expectedTool] of cases) {
      const route = routeTools({ prompt, tools: surface });
      expect(route.profile, prompt).not.toBe('chat');
      expect(route.tools.map((tool) => tool.name), prompt).toContain(expectedTool);
      expect(route.tools.some(isMutatingTool), prompt).toBe(false);
    }
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
