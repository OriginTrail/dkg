import { expect } from 'vitest';
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  DashboardSessionStore,
  authenticateDashboardSessionRequest,
  createDashboardSessionAuthSource,
  handleDashboardSessionRequest,
  verifyDashboardCsrf,
  type DashboardLoginOptions,
} from '../src/daemon/dashboard-session.js';
import { getRequestAuthContext, httpAuthGuardResult, type RequestAuthPrincipal } from '../src/auth.js';
import { handleAgentIdentityRoute } from '../src/daemon/routes/agent-chat.js';
import { handleContextGraphSignJoinRoute } from '../src/daemon/routes/context-graph.js';
import { resolveRouteRequestIdentity } from '../src/daemon/route-request-identity.js';

export const VALID_TOKEN = 'dashboard-backed-token';
export const ROTATED_TOKEN = 'dashboard-rotated-token';
export const AGENT_TOKEN = 'dkg_at_agent-token';
export const DEFAULT_AGENT_ADDRESS = 'did:dkg:agent:default';
export const TOKEN_AGENT_ADDRESS = 'did:dkg:agent:token';

export function loopbackBootstrapInit(baseUrl: string): RequestInit {
  return {
    method: 'POST',
    headers: { Origin: baseUrl, Authorization: `Bearer ${VALID_TOKEN}` },
  };
}

export function cookieFrom(res: Response): string {
  const setCookie = res.headers.get('set-cookie');
  expect(setCookie).toBeTruthy();
  return setCookie!.split(';')[0];
}

export async function startDashboardSessionServer(options: {
  validTokens?: Set<string>;
  refreshValidTokens?: () => void;
  resolvePrincipal?: (token: string) => RequestAuthPrincipal;
  onSessionRevoked?: (sessionId: string) => void;
  corsOrigin?: string | null;
  signJoinRequest?: (contextGraphId: string, agentAddress: string) => Promise<{ agentAddress: string }>;
  authEnabled?: boolean;
  dashboardLogin?: DashboardLoginOptions;
} = {}): Promise<{ server: Server; baseUrl: string }> {
  const validTokens = options.validTokens ?? new Set([VALID_TOKEN, AGENT_TOKEN]);
  const sessions = new DashboardSessionStore();
  const resolvePrincipal = options.resolvePrincipal ?? ((token: string): RequestAuthPrincipal => token === AGENT_TOKEN
    ? { kind: 'agent', agentAddress: TOKEN_AGENT_ADDRESS }
    : { kind: 'node-admin', agentAddress: DEFAULT_AGENT_ADDRESS });
  const agent = {
    resolveAgentByToken: (token: string | undefined) => token === AGENT_TOKEN ? TOKEN_AGENT_ADDRESS : undefined,
    resolveAgentAddress: (token: string | undefined) => token === AGENT_TOKEN ? TOKEN_AGENT_ADDRESS : DEFAULT_AGENT_ADDRESS,
    listLocalAgents: () => [
      { agentAddress: DEFAULT_AGENT_ADDRESS, name: 'Default Agent', framework: 'node' },
      { agentAddress: TOKEN_AGENT_ADDRESS, name: 'Token Agent', framework: 'test' },
    ],
    nodeName: 'Default Agent',
    nodeFramework: 'node',
    signJoinRequest: options.signJoinRequest ?? (async (contextGraphId: string, agentAddress: string) =>
      ({ contextGraphId, agentAddress, signature: 'signed' })),
    peerId: '12D3KooWDashboardSessionTest',
    publisher: { getIdentityId: () => 1n },
  };
  const dashboardAuthSource = createDashboardSessionAuthSource({
    authenticate: (request) => authenticateDashboardSessionRequest(request, sessions, {
      ...(options.dashboardLogin ? { dashboardLogin: options.dashboardLogin } : {}),
      ...(options.onSessionRevoked ? { onSessionRevoked: options.onSessionRevoked } : {}),
    }),
    resolvePrincipal,
    verifyCsrf: (request, session) => verifyDashboardCsrf(request, session),
  });
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    if (await handleDashboardSessionRequest(req, res, url, sessions, {
      authEnabled: options.authEnabled ?? true,
      validTokens,
      refreshValidTokens: options.refreshValidTokens,
      onSessionRevoked: options.onSessionRevoked,
      corsOrigin: options.corsOrigin,
      ...(options.dashboardLogin ? { dashboardLogin: options.dashboardLogin } : {}),
    })) {
      return;
    }
    const authResult = await httpAuthGuardResult(req, res, true, validTokens, options.corsOrigin ?? null, {
      resolvePrincipal,
      authSources: [dashboardAuthSource],
    });
    if (!authResult.allowed) return;
    if (
      url.pathname === '/api/agent/identity' ||
      /^\/api\/context-graph\/[^/]+\/sign-join$/.test(url.pathname)
    ) {
      const requestIdentity = resolveRouteRequestIdentity(req, agent);
      const routeContext = {
        req,
        res,
        agent,
        path: url.pathname,
        requestAgentAddress: requestIdentity.principal.agentAddress,
      };
      if (handleAgentIdentityRoute(routeContext)) return;
      if (await handleContextGraphSignJoinRoute(routeContext)) return;
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      authorization: req.headers.authorization ?? null,
      requestAuth: getRequestAuthContext(req) ?? null,
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server did not bind');
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

export async function rawRequest(
  baseUrl: string,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; headers: IncomingMessage['headers']; body: string }> {
  const url = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: url.hostname,
      port: url.port,
      path,
      method: options.method ?? 'GET',
      headers: options.headers,
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}
