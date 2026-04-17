import { describe, it, expect, beforeEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

interface FnCall { args: unknown[] }

function trackingFn<T>(defaultReturn?: T) {
  const calls: FnCall[] = [];
  const overrides: Array<() => Promise<unknown>> = [];
  const fn = async (...args: unknown[]) => {
    calls.push({ args });
    const override = overrides.shift();
    if (override) return override();
    return defaultReturn;
  };
  return {
    fn,
    calls,
    nextResolve(value: unknown) { overrides.push(() => Promise.resolve(value)); },
    nextReject(err: Error) { overrides.push(() => Promise.reject(err)); },
  };
}

const statusData = {
  name: 'test-node',
  peerId: '12D3KooWTest',
  uptimeMs: 60000,
  connectedPeers: 3,
  relayConnected: true,
  multiaddrs: ['/ip4/127.0.0.1/tcp/9000'],
};

const queryResultData = {
  result: { bindings: [{ s: 'urn:session:1', summary: '"Fixed tests"' }] },
};

const publishResultData = {
  kcId: 'kc-123',
  status: 'confirmed',
  kas: [{ tokenId: '1', rootEntity: 'urn:session:1' }],
};

async function createServerAndClient() {
  const statusFn = trackingFn(statusData);
  const queryFn = trackingFn(queryResultData);
  const publishFn = trackingFn(publishResultData);
  const listParanetsFn = trackingFn();
  const createParanetFn = trackingFn();
  const agentsFn = trackingFn();
  const subscribeFn = trackingFn();

  const trackingClient = {
    status: statusFn.fn,
    query: queryFn.fn,
    publish: publishFn.fn,
    listParanets: listParanetsFn.fn,
    createParanet: createParanetFn.fn,
    agents: agentsFn.fn,
    subscribe: subscribeFn.fn,
  };

  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const { z } = await import('zod');
  const { escapeSparqlLiteral } = await import('@origintrail-official/dkg-core');

  const server = new McpServer({ name: 'dkg-test', version: '9.0.0' });

  const PARANET = 'dev-coordination';
  const DG = 'https://ontology.dkg.io/devgraph#';
  const esc = escapeSparqlLiteral;

  async function getClient() {
    return trackingClient;
  }

  function formatError(err: unknown): string {
    if (err instanceof Error) return err.message;
    return String(err);
  }

  type Bindings = Array<Record<string, string>>;

  function parseBindings(raw: unknown): Bindings {
    const obj = raw as { bindings?: Bindings };
    return obj?.bindings ?? [];
  }

  function cleanValue(v: string): string {
    const typedMatch = v.match(/^"(.+?)"\^\^<.+>$/);
    if (typedMatch) return typedMatch[1];
    if (v.startsWith('"') && v.endsWith('"')) return v.slice(1, -1);
    return v.replace(DG, '').replace('file:', '').replace('symbol:', '').replace('pkg:', '');
  }

  function toTable(bindings: Bindings, columns?: string[]): string {
    if (bindings.length === 0) return '(no results)';
    const cols = columns ?? Object.keys(bindings[0]);
    const rows = bindings.map(row =>
      '| ' + cols.map(c => cleanValue(row[c] ?? '')).join(' | ') + ' |'
    );
    const header = '| ' + cols.join(' | ') + ' |';
    const sep = '| ' + cols.map(() => '---').join(' | ') + ' |';
    return [header, sep, ...rows].join('\n');
  }

  async function sparql(query: string): Promise<Bindings> {
    const client = await getClient();
    const result = await client.query(query, PARANET) as { result: unknown };
    return parseBindings(result.result);
  }

  function ok(text: string) {
    return { content: [{ type: 'text' as const, text }] };
  }

  function err(text: string) {
    return { content: [{ type: 'text' as const, text }], isError: true as const };
  }

  server.registerTool('dkg_find_modules', {
    title: 'Find Code Modules',
    description: 'Search the code graph for source files matching a keyword.',
    inputSchema: {
      keyword: z.string(),
      limit: z.number().optional().default(30),
    },
  }, async ({ keyword, limit }) => {
    try {
      const q = `SELECT ?path ?lines ?pkg WHERE {
        ?m a <${DG}CodeModule> ; <${DG}path> ?path ; <${DG}lineCount> ?lines ; <${DG}containedIn> ?p .
        ?p <${DG}name> ?pkg .
        FILTER(CONTAINS(LCASE(?path), LCASE("${esc(keyword)}")))
      } ORDER BY ?path LIMIT ${limit ?? 30}`;
      const rows = await sparql(q);
      return ok(`Found ${rows.length} modules matching "${keyword}":\n\n${toTable(rows, ['path', 'lines', 'pkg'])}`);
    } catch (e) { return err(`Error: ${formatError(e)}`); }
  });

  server.registerTool('dkg_find_functions', {
    title: 'Find Functions',
    description: 'Search the code graph for functions.',
    inputSchema: {
      keyword: z.string(),
      module: z.string().optional(),
      limit: z.number().optional().default(20),
    },
  }, async ({ keyword, module, limit }) => {
    try {
      const moduleFilter = module ? `FILTER(CONTAINS(LCASE(?path), LCASE("${esc(module)}")))` : '';
      const q = `SELECT ?name ?sig ?path ?ret WHERE {
        ?f a <${DG}Function> ; <${DG}name> ?name ; <${DG}definedIn> ?mod .
        ?mod <${DG}path> ?path .
        OPTIONAL { ?f <${DG}signature> ?sig }
        OPTIONAL { ?f <${DG}returnType> ?ret }
        FILTER(CONTAINS(LCASE(?name), LCASE("${esc(keyword)}")))
        ${moduleFilter}
      } ORDER BY ?path ?name LIMIT ${limit ?? 20}`;
      const rows = await sparql(q);
      return ok(`Found ${rows.length} functions matching "${keyword}":\n\n${toTable(rows, ['name', 'sig', 'path'])}`);
    } catch (e) { return err(`Error: ${formatError(e)}`); }
  });

  server.registerTool('dkg_find_classes', {
    title: 'Find Classes',
    description: 'Search the code graph for classes.',
    inputSchema: {
      keyword: z.string().optional().default(''),
      module: z.string().optional(),
      limit: z.number().optional().default(30),
    },
  }, async ({ keyword, module, limit }) => {
    try {
      const nameFilter = keyword ? `FILTER(CONTAINS(LCASE(?name), LCASE("${esc(keyword)}")))` : '';
      const moduleFilter = module ? `FILTER(CONTAINS(LCASE(?path), LCASE("${esc(module)}")))` : '';
      const q = `SELECT ?name ?path ?extends ?implements WHERE {
        ?c a <${DG}Class> ; <${DG}name> ?name ; <${DG}definedIn> ?mod .
        ?mod <${DG}path> ?path .
        OPTIONAL { ?c <${DG}extends> ?extends }
        OPTIONAL { ?c <${DG}implements> ?implements }
        ${nameFilter}
        ${moduleFilter}
      } ORDER BY ?name LIMIT ${limit ?? 30}`;
      const rows = await sparql(q);
      return ok(`Found ${rows.length} classes:\n\n${toTable(rows, ['name', 'path', 'extends', 'implements'])}`);
    } catch (e) { return err(`Error: ${formatError(e)}`); }
  });

  server.registerTool('dkg_find_packages', {
    title: 'Find Packages',
    description: 'Search the code graph for workspace packages.',
    inputSchema: { keyword: z.string().optional().default('') },
  }, async ({ keyword }) => {
    try {
      const nameFilter = keyword ? `FILTER(CONTAINS(LCASE(?name), LCASE("${esc(keyword)}")))` : '';
      const q = `SELECT ?name ?pkgPath ?dep WHERE {
        ?p a <${DG}Package> ; <${DG}name> ?name ; <${DG}path> ?pkgPath .
        OPTIONAL { ?p <${DG}dependsOn> ?d . ?d <${DG}name> ?dep }
        ${nameFilter}
      } ORDER BY ?name`;
      const rows = await sparql(q);
      return ok(`Found ${rows.length} package rows`);
    } catch (e) { return err(`Error: ${formatError(e)}`); }
  });

  server.registerTool('dkg_file_summary', {
    title: 'File Summary',
    description: 'Get a compact summary of a source file from the code graph.',
    inputSchema: { path: z.string() },
  }, async ({ path: filePath }) => {
    try {
      const escaped = esc(filePath);
      const q = `SELECT ?path ?lines ?pkg WHERE {
        ?m a <${DG}CodeModule> ; <${DG}path> ?path ; <${DG}lineCount> ?lines ; <${DG}containedIn> ?p .
        ?p <${DG}name> ?pkg .
        FILTER(CONTAINS(?path, "${escaped}"))
      } LIMIT 1`;
      const rows = await sparql(q);
      if (rows.length === 0) return ok(`No module found matching "${filePath}".`);
      return ok(`**${cleanValue(rows[0].path)}** (${cleanValue(rows[0].lines)} lines)`);
    } catch (e) { return err(`Error: ${formatError(e)}`); }
  });

  server.registerTool('dkg_query', {
    title: 'SPARQL Query (advanced)',
    description: 'Execute a raw SPARQL query.',
    inputSchema: { sparql: z.string() },
  }, async ({ sparql: query }) => {
    try {
      const rows = await sparql(query);
      return ok(toTable(rows));
    } catch (e) { return err(`Query error: ${formatError(e)}`); }
  });

  server.registerTool('dkg_publish', {
    title: 'Publish to DKG',
    description: 'Publish RDF quads to the dev-coordination paranet.',
    inputSchema: {
      quads: z.array(z.object({
        subject: z.string(),
        predicate: z.string(),
        object: z.string(),
        graph: z.string(),
      })),
    },
  }, async ({ quads }) => {
    try {
      const client = await getClient();
      const result = await client.publish(PARANET, quads) as { kcId: string; status: string };
      return ok(`Published ${quads.length} quads. KC: ${result.kcId}, status: ${result.status}`);
    } catch (e) { return err(`Publish error: ${formatError(e)}`); }
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await client.connect(clientTransport);

  return { client, queryFn, publishFn };
}

describe('DKG MCP Server Tools', () => {
  let client: Client;
  let queryFn: ReturnType<typeof trackingFn>;
  let publishFn: ReturnType<typeof trackingFn>;

  beforeEach(async () => {
    ({ client, queryFn, publishFn } = await createServerAndClient());
  });

  it('registers all expected tools', async () => {
    const { tools } = await client.listTools();
    const names = tools.map(t => t.name).sort();
    expect(names).toEqual([
      'dkg_file_summary',
      'dkg_find_classes',
      'dkg_find_functions',
      'dkg_find_modules',
      'dkg_find_packages',
      'dkg_publish',
      'dkg_query',
    ]);
  });

  it('dkg_query forwards SPARQL to client.query and returns formatted result', async () => {
    const result = await client.callTool({
      name: 'dkg_query',
      arguments: { sparql: 'SELECT ?s WHERE { ?s a devgraph:Session }' },
    });
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content).toHaveLength(1);

    expect(queryFn.calls).toHaveLength(1);
    expect(queryFn.calls[0].args[0]).toBe('SELECT ?s WHERE { ?s a devgraph:Session }');
    expect(queryFn.calls[0].args[1]).toBe('dev-coordination');

    expect(content[0].text).toContain('Fixed tests');
  });

  it('dkg_publish forwards quads to client.publish and returns confirmation', async () => {
    const quads = [{
      subject: '<urn:session:1>',
      predicate: '<http://www.w3.org/1999/02/22-rdf-syntax-ns#type>',
      object: '<https://ontology.dkg.io/devgraph#Session>',
      graph: '<urn:paranet:dev-coordination>',
    }];

    const result = await client.callTool({
      name: 'dkg_publish',
      arguments: { quads },
    });
    const content = result.content as Array<{ type: string; text: string }>;

    expect(publishFn.calls).toHaveLength(1);
    expect(publishFn.calls[0].args[0]).toBe('dev-coordination');
    expect(publishFn.calls[0].args[1]).toEqual(quads);
    expect(content[0].text).toContain('kc-123');
    expect(content[0].text).toContain('confirmed');
  });

  it('dkg_find_modules builds correct SPARQL with escaped keyword', async () => {
    queryFn.nextResolve({
      result: { bindings: [{ path: '"src/node.ts"', lines: '"200"', pkg: '"core"' }] },
    });

    await client.callTool({
      name: 'dkg_find_modules',
      arguments: { keyword: 'node' },
    });

    expect(queryFn.calls.length).toBeGreaterThan(0);
    const calledSparql = queryFn.calls[0].args[0] as string;
    expect(calledSparql).toContain('CodeModule');
    expect(calledSparql).toContain('node');
    expect(calledSparql).toContain('LIMIT');
  });

  it('dkg_query returns error content when client.query throws', async () => {
    queryFn.nextReject(new Error('Connection refused'));

    const result = await client.callTool({
      name: 'dkg_query',
      arguments: { sparql: 'SELECT * WHERE { ?s ?p ?o }' },
    });
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0].text).toContain('Connection refused');
  });

  it('dkg_publish returns error content when client.publish throws', async () => {
    publishFn.nextReject(new Error('Insufficient TRAC'));

    const result = await client.callTool({
      name: 'dkg_publish',
      arguments: {
        quads: [{ subject: 'urn:x', predicate: 'urn:p', object: '"v"', graph: 'urn:g' }],
      },
    });
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0].text).toContain('Insufficient TRAC');
  });

  it('dkg_file_summary returns "no module found" for non-existent file', async () => {
    queryFn.nextResolve({ result: { bindings: [] } });

    const result = await client.callTool({
      name: 'dkg_file_summary',
      arguments: { path: 'nonexistent/file.ts' },
    });
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0].text).toContain('No module found');
  });

  it('dkg_find_functions passes module filter when provided', async () => {
    queryFn.nextResolve({ result: { bindings: [] } });

    await client.callTool({
      name: 'dkg_find_functions',
      arguments: { keyword: 'publish', module: 'publisher' },
    });

    const calledSparql = queryFn.calls[0].args[0] as string;
    expect(calledSparql).toContain('publisher');
    expect(calledSparql).toContain('publish');
  });
});
