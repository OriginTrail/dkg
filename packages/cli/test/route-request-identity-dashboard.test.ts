import { describe, it, expect, afterEach, vi } from 'vitest';
import type { Server } from 'node:http';
import {
  AGENT_TOKEN,
  TOKEN_AGENT_ADDRESS,
  cookieFrom,
  startDashboardSessionServer as startServer,
} from './dashboard-session-test-harness.js';

describe('dashboard route request identity', () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
  });

  it('routes dashboard-cookie agent sessions through requestAgentAddress for agent identity', async () => {
    const started = await startServer();
    server = started.server;

    const exchange = await fetch(`${started.baseUrl}/api/dashboard/session/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: AGENT_TOKEN }),
    });
    expect(exchange.status).toBe(200);

    const identity = await fetch(`${started.baseUrl}/api/agent/identity`, {
      headers: { Cookie: cookieFrom(exchange) },
    });
    expect(identity.status).toBe(200);
    await expect(identity.json()).resolves.toMatchObject({
      agentAddress: TOKEN_AGENT_ADDRESS,
      agentDid: `did:dkg:agent:${TOKEN_AGENT_ADDRESS}`,
      name: 'Token Agent',
      framework: 'test',
      peerId: '12D3KooWDashboardSessionTest',
      nodeIdentityId: '1',
    });
  });

  it('routes dashboard-cookie agent sessions through requestAgentAddress for sign-join', async () => {
    const signJoinRequest = vi.fn(async (contextGraphId: string, agentAddress: string) => ({
      contextGraphId,
      agentAddress,
      signature: 'signed-join',
    }));
    const started = await startServer({ signJoinRequest });
    server = started.server;

    const exchange = await fetch(`${started.baseUrl}/api/dashboard/session/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: AGENT_TOKEN }),
    });
    expect(exchange.status).toBe(200);
    const cookie = cookieFrom(exchange);
    const body = await exchange.json() as { csrfToken: string };

    const signed = await fetch(`${started.baseUrl}/api/context-graph/cg-token/sign-join`, {
      method: 'POST',
      headers: { Cookie: cookie, 'X-DKG-CSRF': body.csrfToken, 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(signed.status).toBe(200);
    expect(signJoinRequest).toHaveBeenCalledWith('cg-token', TOKEN_AGENT_ADDRESS);
    await expect(signed.json()).resolves.toMatchObject({ agentAddress: TOKEN_AGENT_ADDRESS });
  });

});
