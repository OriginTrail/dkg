import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { loadConfig, describeConfig } from '../src/config.js';
import { DkgClient, DkgHttpError } from '../src/client.js';
import { registerHealthTools } from '../src/tools/health.js';
import { registerReadTools } from '../src/tools.js';
import { FakeClient, FakeServer } from './harness.js';

const fixture = vi.hoisted(() => ({ home: '' }));
vi.mock('node:os', async (original) => {
  const actual = await original<typeof import('node:os')>();
  return { ...actual, homedir: () => fixture.home, default: { ...actual, homedir: () => fixture.home } };
});
let root: string;
function write(file: string, contents: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-default-home-'));
  fixture.home = root;
  for (const key of ['DKG_HOME', 'DKG_API', 'DEVNET_API', 'DKG_TOKEN', 'DEVNET_TOKEN', 'DKG_AUTH', 'DKG_PROJECT', 'DKG_AGENT_URI']) vi.stubEnv(key, undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('MCP default node home', () => {
  it('authenticates a real HTTP request using the default home from an unrelated client cwd', async () => {
    let authorization: string | undefined;
    const server = createServer((request, response) => {
      authorization = request.headers.authorization;
      response.writeHead(authorization === 'Bearer node-secret' ? 200 : 401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ contextGraphs: [{ id: 'agent-context' }] }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('HTTP server did not bind');
      write(path.join(root, '.dkg/config.json'), JSON.stringify({ apiPort: 0, contextGraphs: ['agent-context'] }));
      write(path.join(root, '.dkg/auth.token'), '# token\nnode-secret\n');
      write(path.join(root, '.dkg/api.port'), String(address.port));
      const config = loadConfig(path.join(root, 'client-install'));
      expect(config.sourcePath).toBe(path.join(root, '.dkg/config.json'));
      expect(config.defaultProject).toBe('agent-context');
      expect(config.api).toBe(`http://localhost:${address.port}`);
      // The production loader uses localhost; bind the test client to the same loopback service.
      const client = new DkgClient({ config: { ...config, api: `http://127.0.0.1:${address.port}` } });
      expect(await client.listProjects()).toEqual([{ id: 'agent-context' }]);
      expect(authorization).toBe('Bearer node-secret');
      expect(describeConfig(config)).not.toContain('node-secret');
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it.each(['DKG_API', 'DEVNET_API'])('matches the recorded runtime port for explicit %s endpoints', (key) => {
    write(path.join(root, '.dkg/config.json'), '{"apiPort":0,"contextGraphs":["runtime-graph"]}');
    write(path.join(root, '.dkg/api.port'), '9300');
    write(path.join(root, '.dkg/auth.token'), 'runtime-token');
    vi.stubEnv(key, 'http://127.0.0.1:9300');
    expect(loadConfig(root)).toMatchObject({ api: 'http://127.0.0.1:9300', token: 'runtime-token', defaultProject: 'runtime-graph' });
  });

  it.each(['0', '65536', '9300junk', '1.5', ''])('ignores invalid recorded runtime port %j and keeps the configured fallback', (recorded) => {
    write(path.join(root, '.dkg/config.json'), '{"apiPort":9300}');
    write(path.join(root, '.dkg/api.port'), recorded);
    write(path.join(root, '.dkg/auth.token'), 'fallback-token');
    expect(loadConfig(root)).toMatchObject({ api: 'http://localhost:9300', token: 'fallback-token' });
  });

  it('keeps workspace configuration ahead of the default node home', () => {
    write(path.join(root, '.dkg/config.json'), '{"apiPort":9300}');
    write(path.join(root, '.dkg/auth.token'), 'home-secret');
    write(path.join(root, 'workspace/.dkg/config.yaml'), 'node:\n  api: http://workspace:9200\n  token: workspace-secret\n');
    expect(loadConfig(path.join(root, 'workspace/src'))).toMatchObject({ api: 'http://workspace:9200', token: 'workspace-secret' });
  });

  it('does not redirect an explicit empty home to another local node', () => {
    write(path.join(root, '.dkg/config.json'), '{"apiPort":9300}');
    write(path.join(root, '.dkg/auth.token'), 'home-secret');
    vi.stubEnv('DKG_HOME', path.join(root, 'chosen-empty-home'));
    expect(loadConfig(root)).toMatchObject({ token: '', sourcePath: null });
  });

  it('uses the canonical active-home resolver for a running development node', () => {
    write(path.join(root, '.dkg/config.json'), '{"apiPort":9200}');
    write(path.join(root, '.dkg-dev/config.json'), '{"apiPort":9300}');
    write(path.join(root, '.dkg-dev/auth.token'), 'development-token');
    write(path.join(root, '.dkg-dev/daemon.pid'), String(process.pid));
    write(path.join(root, '.dkg-dev/api.port'), '9300');
    expect(loadConfig(root)).toMatchObject({ api: 'http://localhost:9300', token: 'development-token' });
  });

  it.each(['https://remote.example:9300', 'http://remote.example:9300', 'http://localhost:9400'])('does not forward automatically discovered credentials to %s', (api) => {
    write(path.join(root, '.dkg/config.json'), '{"apiPort":9300,"contextGraphs":["local-only"]}');
    write(path.join(root, '.dkg/auth.token'), 'local-secret');
    vi.stubEnv('DKG_API', api);
    expect(loadConfig(root)).toMatchObject({ api, token: '', defaultProject: null, sourcePath: null });
    vi.stubEnv('DKG_TOKEN', 'explicit-token');
    expect(loadConfig(root)).toMatchObject({ api, token: 'explicit-token', defaultProject: null });
  });

  it.each(['http://localhost:9300', 'http://127.0.0.1:9300', 'http://[::1]:9300'])('permits the same local endpoint %s', (api) => {
    write(path.join(root, '.dkg/config.json'), '{"apiPort":9300,"contextGraphs":["local-only"]}');
    write(path.join(root, '.dkg/auth.token'), 'local-secret');
    vi.stubEnv('DKG_API', api);
    expect(loadConfig(root)).toMatchObject({ api, token: 'local-secret', defaultProject: 'local-only' });
  });

  it('requires explicit graph selection for a different endpoint and sends only the requested remote graph', async () => {
    const requestedGraphs: unknown[] = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      requestedGraphs.push(JSON.parse(Buffer.concat(chunks).toString()).contextGraphId);
      response.writeHead(request.headers.authorization === 'Bearer remote-token' ? 200 : 401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ result: { type: 'bindings', bindings: [] } }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const bound = server.address();
      if (!bound || typeof bound === 'string') throw new Error('HTTP server did not bind');
      write(path.join(root, '.dkg/config.json'), JSON.stringify({ apiPort: bound.port === 9300 ? 9301 : 9300, contextGraphs: ['local-only'] }));
      write(path.join(root, '.dkg/auth.token'), 'local-token');
      vi.stubEnv('DKG_API', `http://127.0.0.1:${bound.port}`);
      vi.stubEnv('DKG_TOKEN', 'remote-token');
      const unscoped = loadConfig(root);
      expect(unscoped.defaultProject).toBeNull();
      const unscopedTools = new FakeServer();
      registerReadTools(unscopedTools.asMcpServer(), new DkgClient({ config: unscoped }), unscoped);
      const missing = await unscopedTools.call('dkg_query', { sparql: 'SELECT ?s WHERE { ?s ?p ?o }' });
      expect(missing.isError).toBe(true);
      expect(requestedGraphs).toEqual([]);
      vi.stubEnv('DKG_PROJECT', 'remote-environment');
      const scoped = loadConfig(root);
      expect(scoped.defaultProject).toBe('remote-environment');
      const tools = new FakeServer();
      registerReadTools(tools.asMcpServer(), new DkgClient({ config: scoped }), scoped);
      for (const projectId of [undefined, 'remote-explicit']) {
        const result = await tools.call('dkg_query', { sparql: 'SELECT ?s WHERE { ?s ?p ?o }', projectId });
        expect(result.isError).toBeFalsy();
      }
      expect(requestedGraphs).toEqual(['remote-environment', 'remote-explicit']);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('does not claim a configured token has already been accepted', async () => {
    vi.stubEnv('DKG_TOKEN', 'configured-secret');
    const config = loadConfig(root);
    const tools = new FakeServer();
    registerHealthTools(tools.asMcpServer(), new FakeClient().asDkgClient(), config);
    const status = await tools.call('dkg_status', {});
    expect(status.content[0].text).toContain('token-configured');
    expect(status.content[0].text).toContain('"verified": false');
    expect(status.content[0].text).not.toContain('configured-secret');
    const client = new DkgClient({ config, fetcher: async () => new Response('{}', { status: 401 }) });
    await expect(client.listProjects()).rejects.not.toThrow('MCP server has no auth token');
  });

  it('reports missing authentication in status and gives an actionable 401 hint', async () => {
    const config = loadConfig(root);
    expect(config.token).toBe('');
    expect(describeConfig(config)).toContain('DKG_HOME');
    const tools = new FakeServer();
    registerHealthTools(tools.asMcpServer(), new FakeClient().asDkgClient(), config);
    const status = await tools.call('dkg_status', {});
    expect(status.content[0].text).toContain('missing-token');
    expect(status.content[0].text).toContain('dkg mcp setup --print-only');
    const client = new DkgClient({ config, fetcher: async () => new Response('{"error":"Unauthorized"}', { status: 401 }) });
    const error = await client.listProjects().catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(DkgHttpError);
    expect(error).toMatchObject({ status: 401, body: { error: 'Unauthorized' } });
    expect((error as Error).message).toContain('MCP server has no auth token');
  });
});
