// OT-RFC-27 daemon auth carve-out (spec §11.3): a mini HTTP server that
// reproduces the lifecycle order — OPTIONS → gateway carve-out → the REAL
// `authenticateHttpRequest` → a `handleRequest` spy running the REAL
// marketplace route module — plus a source-order pin on lifecycle.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { authenticateHttpRequest, type AllowedHttpAuthentication } from '../src/auth.js';
import { handleMarketplaceRoutes } from '../src/daemon/routes/marketplace.js';
import type { RequestContext } from '../src/daemon/routes/context.js';
import { createMarketplaceGatewayDispatch, isMarketplaceGatewayPath } from '../src/daemon/marketplace-gateway-dispatch.js';
import { resolveMarketplaceGatewayConfig } from '../src/marketplace-config.js';
import { GV2_MESSAGES, bearer, getJson, makeFakeAgent, postJson, tempHome } from './marketplace-gateway-fixtures.js';

const NODE_TOKEN = 'node-operator-token-0123456789abcdef';
const AGENT_TOKEN = 'agent-token-0123456789abcdef';
const AGENT_ADDRESS = `0x${'a1'.repeat(20)}`;
const here = dirname(fileURLToPath(import.meta.url));
const cliSrc = resolve(here, '../src');

interface MiniDaemon {
  url: string;
  gw: string;
  handleRequest: ReturnType<typeof vi.fn>;
  agentCalls: Array<{ method: string; input: unknown }>;
  close(): Promise<void>;
}

let daemon: MiniDaemon | undefined;
let savedHome: string | undefined;
beforeEach(() => {
  savedHome = process.env.DKG_HOME;
  process.env.DKG_HOME = tempHome('dkg-mkt-carveout-');
});
afterEach(async () => {
  await daemon?.close();
  daemon = undefined;
  if (savedHome === undefined) delete process.env.DKG_HOME;
  else process.env.DKG_HOME = savedHome;
});

async function startMiniDaemon(opts: { authEnabled?: boolean; gatewayEnabled?: boolean } = {}): Promise<MiniDaemon> {
  const authEnabled = opts.authEnabled ?? true;
  const marketplaceConfig = { enabled: true, buyer: { gateway: { enabled: opts.gatewayEnabled ?? true } } };
  const fake = makeFakeAgent();
  const agent = {
    ...fake.agent,
    marketplaceStatus: async () => ({ enabled: true, sellerReady: true, buyerReady: true }),
    marketplaceDiscoverOffers: async () => [],
  };
  const handleRequest = vi.fn(async (req: IncomingMessage, res: ServerResponse, authentication: AllowedHttpAuthentication, url: URL) => {
    const ctx = {
      req, res, agent, path: url.pathname, url, authentication, config: { marketplace: marketplaceConfig },
    } as unknown as RequestContext;
    await handleMarketplaceRoutes(ctx);
    if (!res.writableEnded) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    }
  });
  const gateway = createMarketplaceGatewayDispatch({
    agent,
    gateway: resolveMarketplaceGatewayConfig(marketplaceConfig, {}),
    dataDir: process.env.DKG_HOME!,
    log: () => undefined,
  });
  const validTokens = new Set([NODE_TOKEN, AGENT_TOKEN]);
  const server: Server = createServer(async (req, res) => {
    try {
      const reqUrl = new URL(req.url ?? '/', `http://${req.headers.host}`);
      if (req.method === 'OPTIONS') {
        res.writeHead(204).end();
        return;
      }
      if (gateway && isMarketplaceGatewayPath(reqUrl.pathname)) {
        await gateway.handle(req, res, reqUrl, null);
        return;
      }
      const authentication = await authenticateHttpRequest({
        req, res, authEnabled, validTokens,
        resolveAgentByToken: (token) => (token === AGENT_TOKEN ? AGENT_ADDRESS : undefined),
        corsOrigin: null,
      });
      if (!authentication.allowed) return;
      await handleRequest(req, res, authentication, reqUrl);
    } catch (err) {
      if (!res.headersSent) res.writeHead(500).end(String((err as Error)?.message));
    }
  });
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;
  return {
    url,
    gw: `${url}/api/marketplace/gateway/v1`,
    handleRequest,
    agentCalls: fake.calls,
    close: () => new Promise<void>((resolveClose) => {
      server.closeAllConnections?.();
      server.close(() => resolveClose());
    }),
  };
}

async function mintViaAdmin(d: MiniDaemon, body: Record<string, unknown> = { budgetTrac: '1' }): Promise<{ key: string; keyId: string }> {
  const res = await postJson(`${d.url}/api/marketplace/keys`, body, bearer(NODE_TOKEN));
  expect(res.status).toBe(201);
  return { key: res.json.key, keyId: res.json.record.keyId };
}

const GATEWAY_PATHS = ['/models', '/chat/completions', '/query', '/unknown', ''];

describe('S2/S3/S5: gateway paths never reach the token-authenticated surfaces without a valid key', () => {
  it('no key, the node token, an agent token, or junk → 401 invalid_api_key; handleRequest and the agent are never called', async () => {
    daemon = await startMiniDaemon();
    for (const path of GATEWAY_PATHS) {
      for (const headers of [{}, bearer(NODE_TOKEN), bearer(AGENT_TOKEN), bearer('dkg_gw_nothex'), { Authorization: `Bearer ${NODE_TOKEN}` }]) {
        const res = path === '/models' || path === '' || path === '/unknown'
          ? await getJson(`${daemon.gw}${path}`, headers)
          : await postJson(`${daemon.gw}${path}`, { model: 'stub-chat', messages: GV2_MESSAGES, sparql: 'SELECT 1' }, headers);
        expect(res.status, `${path} ${JSON.stringify(headers)}`).toBe(401);
        expect(res.json.error.code).toBe('invalid_api_key');
      }
    }
    expect(daemon.handleRequest).not.toHaveBeenCalled();
    expect(daemon.agentCalls).toEqual([]);
  });

  it('a valid key reaches the gateway handler only; an unknown subpath is 404 without touching the route modules', async () => {
    daemon = await startMiniDaemon();
    const { key } = await mintViaAdmin(daemon);
    daemon.handleRequest.mockClear();
    const unknown = await getJson(`${daemon.gw}/status`, bearer(key));
    expect(unknown.status).toBe(404);
    expect(unknown.json.error.code).toBe('unknown_url');
    const models = await getJson(`${daemon.gw}/models`, bearer(key));
    expect(models.status).toBe(200);
    const completion = await postJson(`${daemon.gw}/chat/completions`, { model: 'stub-chat', messages: GV2_MESSAGES }, bearer(key));
    expect(completion.status).toBe(200);
    expect(daemon.handleRequest).not.toHaveBeenCalled();
  });
});

describe('S4: a gateway key authenticates nothing else', () => {
  it('is 401 on /api/marketplace/*, the key admin routes and /api/query', async () => {
    daemon = await startMiniDaemon();
    const { key, keyId } = await mintViaAdmin(daemon);
    daemon.handleRequest.mockClear();
    for (const [method, path] of [
      ['GET', '/api/marketplace/status'],
      ['GET', '/api/marketplace/keys'],
      ['POST', '/api/marketplace/keys'],
      ['POST', `/api/marketplace/keys/${keyId}/revoke`],
      ['POST', '/api/marketplace/invoke'],
      ['GET', '/api/marketplace/meter'],
      ['POST', '/api/query'],
      ['GET', '/api/marketplace/gateway/v1/../../status'],
      ['GET', '/api/marketplace/gateway/v1/%2e%2e/%2e%2e/status'],
    ] as const) {
      const res = method === 'GET'
        ? await getJson(`${daemon.url}${path}`, bearer(key))
        : await postJson(`${daemon.url}${path}`, {}, bearer(key));
      expect(res.status, `${method} ${path}`).toBe(401);
    }
    expect(daemon.handleRequest).not.toHaveBeenCalled();
    // The node token still works there.
    expect((await getJson(`${daemon.url}/api/marketplace/status`, bearer(NODE_TOKEN))).status).toBe(200);
  });
});

describe('S6: auth disabled does not open spend', () => {
  it('the gateway still requires a key while ordinary routes are open', async () => {
    daemon = await startMiniDaemon({ authEnabled: false });
    expect((await getJson(`${daemon.url}/api/marketplace/status`)).status).toBe(200);
    for (const path of GATEWAY_PATHS) {
      expect((await getJson(`${daemon.gw}${path}`)).status, path).toBe(401);
      expect((await getJson(`${daemon.gw}${path}`, bearer(NODE_TOKEN))).status, path).toBe(401);
    }
    const chat = await postJson(`${daemon.gw}/chat/completions`, { model: 'stub-chat', messages: GV2_MESSAGES });
    expect(chat.status).toBe(401);
    expect(daemon.agentCalls).toEqual([]);
  });
});

describe('S7: key administration needs the node-admin token', () => {
  it('agent token → 403, no token → 401, node token → mint/list/revoke', async () => {
    daemon = await startMiniDaemon();
    const agentMint = await postJson(`${daemon.url}/api/marketplace/keys`, { budgetTrac: '1' }, bearer(AGENT_TOKEN));
    expect(agentMint.status).toBe(403);
    expect((await getJson(`${daemon.url}/api/marketplace/keys`, bearer(AGENT_TOKEN))).status).toBe(403);
    expect((await postJson(`${daemon.url}/api/marketplace/keys`, { budgetTrac: '1' })).status).toBe(401);
    const { key, keyId } = await mintViaAdmin(daemon);
    expect((await postJson(`${daemon.url}/api/marketplace/keys/${keyId}/revoke`, {}, bearer(AGENT_TOKEN))).status).toBe(403);
    expect((await postJson(`${daemon.url}/api/marketplace/keys/${keyId}/revoke`, {})).status).toBe(401);
    const list = await getJson(`${daemon.url}/api/marketplace/keys`, bearer(NODE_TOKEN));
    expect(list.status).toBe(200);
    expect(list.json.keys).toHaveLength(1);
    expect(list.json.keys[0]).not.toHaveProperty('keyHash');
    expect(list.text).not.toContain(key);
    expect(list.text).not.toContain('sha256:');
  });

  it('revocation takes effect on the very next gateway call (one shared store)', async () => {
    daemon = await startMiniDaemon();
    const { key, keyId } = await mintViaAdmin(daemon);
    expect((await getJson(`${daemon.gw}/models`, bearer(key))).status).toBe(200);
    const revoked = await postJson(`${daemon.url}/api/marketplace/keys/${keyId}/revoke`, {}, bearer(NODE_TOKEN));
    expect(revoked.status).toBe(200);
    expect(revoked.json).toEqual({ keyId, revokedAt: expect.any(Number) });
    const next = await getJson(`${daemon.gw}/models`, bearer(key));
    expect(next.status).toBe(401);
    expect(next.json.error.code).toBe('key_revoked');
    // Idempotent: the original revokedAt is kept.
    const again = await postJson(`${daemon.url}/api/marketplace/keys/${keyId}/revoke`, {}, bearer(NODE_TOKEN));
    expect(again.json.revokedAt).toBe(revoked.json.revokedAt);
  });
});

describe('gateway disabled', () => {
  it('the prefix falls through to token auth and answers 404 — no route module claims it', async () => {
    daemon = await startMiniDaemon({ gatewayEnabled: false });
    expect((await getJson(`${daemon.gw}/models`)).status).toBe(401);
    const res = await getJson(`${daemon.gw}/models`, bearer(NODE_TOKEN));
    expect(res.status).toBe(404);
    expect(res.json).toEqual({ error: 'marketplace gateway is disabled on this node' });
    const post = await postJson(`${daemon.gw}/chat/completions`, { model: 'stub-chat', messages: GV2_MESSAGES }, bearer(NODE_TOKEN));
    expect(post.status).toBe(404);
    expect(daemon.agentCalls).toEqual([]);
  });
});

describe('source-order pin (lifecycle.ts)', () => {
  const lifecycle = readFileSync(join(cliSrc, 'daemon/lifecycle.ts'), 'utf8');

  it('exactly one carve-out, after the OPTIONS block and before authenticateHttpRequest', () => {
    const calls = [...lifecycle.matchAll(/isMarketplaceGatewayPath\(/g)];
    expect(calls).toHaveLength(1);
    const carveOut = calls[0].index!;
    const options = lifecycle.indexOf('req.method === "OPTIONS"');
    const auth = lifecycle.indexOf('authenticateHttpRequest({');
    expect(options).toBeGreaterThan(0);
    expect(auth).toBeGreaterThan(0);
    expect(carveOut).toBeGreaterThan(options);
    expect(carveOut).toBeLessThan(auth);
    // The OPTIONS block returns before the carve-out, and the carve-out returns before auth.
    expect(lifecycle.slice(options, carveOut)).toMatch(/return;\s*}\s*$/m);
    expect(lifecycle.slice(carveOut, auth)).toMatch(/await marketplaceGateway\.handle\(req, res, reqUrl, reqCorsOrigin\);\s*return;/);
  });

  it('no other non-test cli source references isMarketplaceGatewayPath; the gateway modules never call the token pipeline', () => {
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (name.endsWith('.ts')) files.push(full);
      }
    };
    walk(cliSrc);
    const referencing = files
      .filter((file) => readFileSync(file, 'utf8').includes('isMarketplaceGatewayPath'))
      .map((file) => relative(cliSrc, file).split('\\').join('/'))
      .sort();
    expect(referencing).toEqual(['daemon/lifecycle.ts', 'daemon/marketplace-gateway-dispatch.ts', 'daemon/routes/marketplace.ts']);
    for (const file of ['daemon/marketplace-gateway-dispatch.ts', 'daemon/routes/marketplace-gateway.ts', 'daemon/routes/marketplace-gateway-errors.ts']) {
      // Code only: the module comments name these surfaces to document their absence.
      const source = readFileSync(join(cliSrc, file), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      for (const forbidden of ['authenticateHttpRequest', 'handleRequest(', 'handleNodeUIRequest', 'createRequestActor', 'validTokens', 'handlePluginRoutes']) {
        expect(source.includes(forbidden), `${file} must not reference ${forbidden}`).toBe(false);
      }
    }
  });
});
