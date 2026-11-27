import { createServer, type Server } from 'node:http';
import { afterEach, expect, it } from 'vitest';
import { authenticateHttpRequest } from '../src/auth.js';
import { handleNotificationRoutes } from '../src/daemon/routes/notifications.js';

const owner = '0x1111111111111111111111111111111111111111';
let server: Server | undefined;
afterEach(async () => {
  if (server) await new Promise<void>((resolve, reject) => server!.close(e => e ? reject(e) : resolve()));
  server = undefined;
});

it('bounds 100 curated-graph join checks and retains caller scoping when individual reads fail', async () => {
  let active = 0, peak = 0;
  const checked: string[] = [];
  const graphs = Array.from({ length: 100 }, (_, i) => ({
    id: 'owned-' + i, name: 'Owned ' + i, callerInvolved: true, curator: 'did:dkg:agent:' + owner,
  }));
  const agent = {
    resolveAgentByToken: (token: string) => token === 'test-agent-token' ? owner : undefined,
    getDefaultAgentAddress: () => owner,
    listContextGraphs: async ({ callerAgentAddress }: { callerAgentAddress: string }) => {
      expect(callerAgentAddress).toBe(owner);
      return [...graphs, { id: 'foreign', name: 'Foreign', callerInvolved: false, curator: 'did:dkg:agent:' + owner }];
    },
    listPendingJoinRequests: async (graph: string, caller: string) => {
      expect(caller).toBe(owner);
      active++; peak = Math.max(peak, active); checked.push(graph);
      try {
        await new Promise(resolve => setTimeout(resolve, 2));
        if (graph === 'owned-5') throw new Error('temporary lookup failure');
        return [];
      } finally { active--; }
    },
  };
  const dashDb = {
    getNotificationsForContextGraphs: (ids: string[]) => {
      expect(new Set(ids)).toEqual(new Set(graphs.map(g => g.id))); return [];
    },
    getNotificationsOfTypes: () => [], getPcaCostCoveredRowsForWallet: () => [],
  };
  server = createServer(async (req, res) => {
    const authentication = await authenticateHttpRequest({ req, res, authEnabled: true,
      validTokens: new Set(['test-agent-token']), resolveAgentByToken: agent.resolveAgentByToken });
    if (!authentication.allowed) return;
    await handleNotificationRoutes({ req, res, agent, dashDb, authentication, path: '/api/notifications' } as any);
  });
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind');
  const url = `http://127.0.0.1:${address.port}/api/notifications`;
  expect((await fetch(url)).status).toBe(401);
  expect(checked).toEqual([]);
  const response = await fetch(url, { headers: { Authorization: 'Bearer test-agent-token' } });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ notifications: [], badgeCount: 0 });
  expect(new Set(checked)).toEqual(new Set(graphs.map(g => g.id)));
  expect(checked).toHaveLength(100); expect(peak).toBe(4); expect(active).toBe(0);
});
