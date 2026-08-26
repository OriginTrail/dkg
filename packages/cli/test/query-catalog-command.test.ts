import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import {
  QUERY_CATALOG_READ_CAPABILITIES,
  type QueryCatalogItem,
} from '@origintrail-official/dkg-core/query-catalog';
import { ApiClient } from '../src/api-client.js';
import { registerQueryCatalogCommand } from '../src/commands/query-catalog.js';

const savedQuery: QueryCatalogItem = {
  queryIri: 'urn:dkg:profile:cg-1:query:configuration-trace',
  catalogIri: 'urn:dkg:profile:cg-1:catalog:kamstrup',
  slug: 'configuration-trace',
  name: 'Configuration trace',
  sparql: 'SELECT ?record WHERE { ?record <urn:configuration> {{configurationId}} }',
  rank: 1,
  catalogSlug: 'kamstrup',
  catalogName: 'Kamstrup',
  catalogRank: 1,
  subGraph: 'production',
  parameters: [{ name: 'configurationId', type: 'string' }],
  view: 'verifiable-memory',
};

function commandProgram(): Command {
  const program = new Command().name('dkg');
  program.exitOverride();
  registerQueryCatalogCommand(program);
  return program;
}

function envelope() {
  return {
    schemaVersion: 1 as const,
    capabilities: QUERY_CATALOG_READ_CAPABILITIES,
    contextGraphId: 'cg-1',
    graph: 'did:dkg:context-graph:cg-1/meta/query-catalog',
    items: [savedQuery],
    result: { type: 'bindings' as const, bindings: [] },
  };
}

describe('dkg query-catalog command', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
      throw new Error(`process.exit:${code}`);
    }) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('runs a parameterized saved query with escaped input and exact saved scope', async () => {
    const query = vi.fn(async () => ({ result: { type: 'bindings', bindings: [] } }));
    vi.spyOn(ApiClient, 'connect').mockResolvedValue({
      readQueryCatalog: vi.fn(async () => envelope()),
      query,
    } as unknown as ApiClient);

    await commandProgram().parseAsync([
      'node',
      'dkg',
      'query-catalog',
      'run',
      'cg-1',
      'configuration-trace',
      '--param',
      'configurationId=748387" } UNION { ?s ?p ?o',
    ]);

    expect(query).toHaveBeenCalledWith(
      'SELECT ?record WHERE { ?record <urn:configuration> "748387\\" } UNION { ?s ?p ?o" }',
      'cg-1',
      { subGraphName: 'production', view: 'verifiable-memory' },
    );
  });

  it('fails explicitly against an older daemon response with no capability envelope', async () => {
    vi.spyOn(ApiClient, 'connect').mockResolvedValue({
      readQueryCatalog: vi.fn(async () => ({
        result: { type: 'bindings', bindings: [] },
      })),
    } as unknown as ApiClient);

    await expect(commandProgram().parseAsync([
      'node', 'dkg', 'query-catalog', 'list', 'cg-1',
    ])).rejects.toThrow('process.exit:1');

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Incompatible query-catalog daemon contract'),
    );
  });

  it('fails before query execution when a required parameter is missing', async () => {
    const query = vi.fn();
    vi.spyOn(ApiClient, 'connect').mockResolvedValue({
      readQueryCatalog: vi.fn(async () => envelope()),
      query,
    } as unknown as ApiClient);

    await expect(commandProgram().parseAsync([
      'node', 'dkg', 'query-catalog', 'run', 'cg-1', 'configuration-trace',
    ])).rejects.toThrow('process.exit:1');

    expect(query).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Missing required query parameter: configurationId'),
    );
  });
});
