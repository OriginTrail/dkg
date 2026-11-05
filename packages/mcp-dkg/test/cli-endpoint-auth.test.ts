import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCli } from '../src/cli/index.js';

const fixture = vi.hoisted(() => ({ home: '' }));
vi.mock('node:os', async (original) => {
  const actual = await original<typeof import('node:os')>();
  return { ...actual, homedir: () => fixture.home, default: { ...actual, homedir: () => fixture.home } };
});
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
