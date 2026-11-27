import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { runCli } from '../src/cli/index.js';
import { fetchManifest } from '../src/manifest/fetch.js';
import { CONFIG_YAML_TEMPLATE } from '../src/manifest/templates.js';

const fixture = vi.hoisted(() => ({ home: '' }));
vi.mock('node:os', async (original) => {
  const actual = await original<typeof import('node:os')>();
  return { ...actual, homedir: () => fixture.home, default: { ...actual, homedir: () => fixture.home } };
});
vi.mock('../src/manifest/fetch.js', () => ({ fetchManifest: vi.fn() }));
let root: string;
let workspace: string;
let server: Server | undefined;
function write(file: string, text: string) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); }
function home(port: number) {
  write(path.join(root, '.dkg/config.json'), JSON.stringify({ apiPort: 0, contextGraphs: ['local-only'] }));
  write(path.join(root, '.dkg/api.port'), String(port));
  write(path.join(root, '.dkg/auth.token'), 'local-secret');
}
async function endpoint(status = 200) {
  const credentials: Array<string | undefined> = [];
  server = createServer((request, response) => {
    credentials.push(request.headers.authorization);
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(status === 200 ? { contextGraphs: [] } : { error: 'Stop before any onboarding writes' }));
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('HTTP server did not bind');
  return { port: address.port, api: `http://127.0.0.1:${address.port}`, credentials };
}
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-cli-endpoint-')); fixture.home = root;
  workspace = path.join(root, 'workspace'); fs.mkdirSync(workspace);
  for (const key of ['DKG_HOME', 'DKG_API', 'DEVNET_API', 'DKG_TOKEN', 'DEVNET_TOKEN', 'DKG_AUTH', 'DKG_PROJECT', 'DKG_AGENT_URI']) vi.stubEnv(key, undefined);
  vi.spyOn(process, 'cwd').mockReturnValue(workspace);
  for (const method of ['log', 'warn', 'error'] as const) vi.spyOn(console, method).mockImplementation(() => {});
});
afterEach(async () => {
  if (server) { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve())); server = undefined; }
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); fs.rmSync(root, { recursive: true, force: true });
});

describe('CLI final endpoint credential scope', () => {
  it('does not send discovered credentials to a different status endpoint and honors an explicit token', async () => {
    const remote = await endpoint(); home(remote.port === 9300 ? 9301 : 9300);
    expect(await runCli(['status', `--daemon=${remote.api}`])).toBe(0);
    expect(remote.credentials).toEqual([undefined]);
    expect(await runCli(['status', `--daemon=${remote.api}`, '--token=explicit-remote-token'])).toBe(0);
    expect(remote.credentials).toEqual([undefined, 'Bearer explicit-remote-token']);
  });
  it('keeps authentication for the matching local status endpoint', async () => {
    const local = await endpoint(); home(local.port);
    expect(await runCli(['status', `--daemon=${local.api}`])).toBe(0);
    expect(local.credentials).toEqual(['Bearer local-secret']);
  });
  it('blocks a remote hostname even when its protocol and port match the home', async () => {
    home(9300);
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ contextGraphs: [] }));
    vi.stubGlobal('fetch', fetcher);
    expect(await runCli(['status', '--daemon=http://remote.example:9300'])).toBe(0);
    expect(String(fetcher.mock.calls[0][0])).toBe('http://remote.example:9300/api/context-graph/list');
    expect(new Headers(fetcher.mock.calls[0][1]?.headers).has('Authorization')).toBe(false);
  });
  it('does not reuse a configured home token at the default port of another local node', async () => {
    home(9300);
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ error: 'Stop before onboarding' }, { status: 401 }));
    vi.stubGlobal('fetch', fetcher);
    expect(await runCli(['join', 'team', '--daemon=http://localhost:9200', `--workspace=${workspace}`, '--yes'])).toBe(1);
    expect(new Headers(fetcher.mock.calls[0][1]?.headers).has('Authorization')).toBe(false);
  });
  it.each(['http://remote.example:9200', 'not-a-url'])('keeps legacy token-only fallback local for %s', async (api) => {
    home(9200); fs.unlinkSync(path.join(root, '.dkg/config.json'));
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ error: 'Stop before onboarding' }, { status: 401 }));
    vi.stubGlobal('fetch', fetcher);
    expect(await runCli(['join', 'team', `--daemon=${api}`, `--workspace=${workspace}`, '--yes'])).toBe(1);
    expect(new Headers(fetcher.mock.calls[0][1]?.headers).has('Authorization')).toBe(false);
  });
  it('preserves token-only first-run authentication at its recorded local port', async () => {
    const local = await endpoint(401); home(local.port); fs.unlinkSync(path.join(root, '.dkg/config.json'));
    expect(await runCli(['join', 'team', `--daemon=${local.api}`, `--workspace=${workspace}`, '--yes'])).toBe(1);
    expect(local.credentials).toEqual(['Bearer local-secret']);
  });

  it('does not recover a rejected implicit token through join fallback, while explicit token-file stays intentional', async () => {
    const remote = await endpoint(401); home(remote.port === 9300 ? 9301 : 9300);
    const args = ['join', 'team', `--workspace=${workspace}`, `--daemon=${remote.api}`, '--yes', '--skip-claude'];
    expect(await runCli(args)).toBe(1);
    expect(remote.credentials).toEqual([undefined]);
    const explicit = path.join(root, 'selected-remote-token'); write(explicit, 'selected-remote-secret');
    expect(await runCli([...args, `--token-file=${explicit}`])).toBe(1);
    expect(remote.credentials).toEqual([undefined, 'Bearer selected-remote-secret']);
    expect(fs.readdirSync(workspace)).toEqual([]);
  });
});

describe('join credential source', () => {
  const wallets: Record<string, string> = { 'Bearer selected-secret': `0x${'5e'.repeat(20)}`, 'Bearer local-secret': `0x${'ad'.repeat(20)}` };
  // Daemon double: records each request's credential; identity follows the credential.
  function daemon() {
    const requests: Array<[string, string | null]> = [];
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (input, init) => {
      const route = new URL(String(input)).pathname; const authorization = new Headers(init?.headers).get('Authorization');
      requests.push([route, authorization]);
      return Response.json(route === '/api/agent/identity' ? { agentAddress: wallets[authorization ?? ''] } : { contextGraphs: [{ id: 'team' }] });
    }));
    vi.mocked(fetchManifest).mockResolvedValue({ uri: 'urn:manifest:team', contextGraphId: 'team', network: 'testnet', supportedTools: ['cursor'],
      configTemplate: { uri: 'urn:template', encodingFormat: 'text/yaml', text: CONFIG_YAML_TEMPLATE } });
    return requests;
  }
  const join = (...extra: string[]) => runCli(['join', 'team', `--workspace=${workspace}`, '--agent-slug=alice', '--yes', '--no-subscribe', '--skip-claude', ...extra]);
  const installed = () => parseYaml(fs.readFileSync(path.join(workspace, '.dkg/config.yaml'), 'utf8'));

  it.each([
    { source: 'the active development home', file: '.dkg-dev/auth.token', api: 'http://localhost:9200', args: [], setup: () => {
      write(path.join(root, '.dkg-dev/config.json'), '{"apiPort":9200}'); write(path.join(root, '.dkg-dev/api.port'), '9200');
      write(path.join(root, '.dkg-dev/daemon.pid'), String(process.pid)); write(path.join(root, '.dkg-dev/auth.token'), 'node-secret');
    } },
    { source: 'an explicit DKG_HOME', file: 'chosen/auth.token', api: 'http://localhost:9400', args: ['--daemon=http://localhost:9400'], setup: () => {
      write(path.join(root, 'chosen/config.json'), '{"apiPort":9400}'); write(path.join(root, 'chosen/auth.token'), 'node-secret');
      vi.stubEnv('DKG_HOME', path.join(root, 'chosen'));
    } },
  ])('records the token file it authenticated with from $source', async ({ file, api, args, setup }) => {
    setup(); const requests = daemon();
    expect(await join(...args)).toBe(0);
    expect(requests.map(([, authorization]) => authorization)).toEqual(['Bearer node-secret', 'Bearer node-secret']);
    expect(installed().node).toEqual({ api, tokenFile: path.join(root, file) });
    // After a restart without DKG_HOME, the workspace binding alone must authenticate.
    vi.stubEnv('DKG_HOME', undefined); requests.length = 0;
    expect(await runCli(['status'])).toBe(0);
    expect(requests).toEqual([['/api/context-graph/list', 'Bearer node-secret']]);
  });

  it.each(['discovered home', 'workspace binding'])('uses an explicit token file over the %s for requests, identity and the install', async (source) => {
    home(9200);
    if (source === 'workspace binding') write(path.join(workspace, '.dkg/config.yaml'), `node:\n  api: http://localhost:9200\n  tokenFile: ${path.join(root, '.dkg/auth.token')}\n`);
    const selected = path.join(root, 'selected.token'); write(selected, '# selected\nselected-secret\n');
    const requests = daemon();
    expect(await join(`--token-file=${selected}`)).toBe(0);
    expect(requests).toEqual([['/api/context-graph/list', 'Bearer selected-secret'], ['/api/agent/identity', 'Bearer selected-secret']]);
    expect(installed()).toMatchObject({ node: { tokenFile: selected }, agent: { uri: `urn:dkg:agent:${wallets['Bearer selected-secret']}` } });
  });
});
