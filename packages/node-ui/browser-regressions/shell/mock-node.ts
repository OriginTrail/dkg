import type { Page } from '@playwright/test';

/**
 * A quiet node for shell checks: the real app is served by Vite and every
 * `/api` call is answered here, so no devnet, daemon or chain is involved.
 * The shell only needs a reachable status (otherwise the app shows the
 * node-unavailable view); every other call gets an empty answer.
 */
export async function mockQuietNode(page: Page): Promise<void> {
  await page.route('https://fonts.googleapis.com/**', (route) => route.abort());
  await page.route('https://fonts.gstatic.com/**', (route) => route.abort());
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/events') || route.request().headers().accept === 'text/event-stream') {
      await route.fulfill({ contentType: 'text/event-stream', body: '' });
      return;
    }
    if (url.pathname === '/api/status') {
      await route.fulfill({ json: {
        name: 'Browser test node', peerId: 'browser-test', networkName: 'devnet', nodeRole: 'core',
        uptimeMs: 60_000, connectedPeers: 0, connections: { direct: 0, relayed: 0 },
      } });
      return;
    }
    if (url.pathname === '/api/agent/identity') {
      await route.fulfill({ json: {
        agentAddress: '0x1111111111111111111111111111111111111111',
        agentDid: 'did:ethr:0x1111111111111111111111111111111111111111',
        name: 'Browser test', peerId: 'browser-test', nodeIdentityId: '1',
      } });
      return;
    }
    if (url.pathname === '/api/local-agent-integrations') {
      // One connected chat agent, so the agent panel shows a composer.
      await route.fulfill({ json: { integrations: [{
        id: 'openclaw', name: 'Test agent', description: 'A chat agent for shell checks', enabled: true, status: 'ready',
        capabilities: { localChat: true, chatAttachments: true },
        runtime: { status: 'ready', ready: true },
      }] } });
      return;
    }
    if (url.pathname === '/api/openclaw-channel/health') {
      await route.fulfill({ json: { ok: true, bridge: { ok: true }, gateway: { ok: true } } });
      return;
    }
    await route.fulfill({ json: {
      contextGraphs: [], events: [], agents: [], notifications: [], peers: [], items: [], badgeCount: 0,
    } });
  });
}
