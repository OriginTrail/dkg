import type { Page, Route } from '@playwright/test';
import {
  PHARMA_CG_ID,
  profileMetaBindings,
  profileSubGraphSelectBindings,
  subGraphList,
  swmBindings,
  vmBindings,
  wmBindings,
} from './rich-mock-data.js';

/** Inline mock payloads (mirror `src/ui/mocks/data.ts` for Playwright isolation). */
const MOCK_API = {
  status: {
    name: 'my-dkg-node',
    networkName: 'DKG Mainnet',
    connectedPeers: 12,
    synced: true,
    version: '10.0.0-rc',
    peerId: 'QmMockNodeAgentPeer000000000000000000000000',
  },
  agent: {
    agentAddress: '0x1111111111111111111111111111111111111111',
    agentDid: 'did:dkg:agent:0x1111111111111111111111111111111111111111',
    name: 'mock-node-agent',
    framework: 'mock',
    peerId: 'QmMockNodeAgentPeer000000000000000000000000',
    nodeIdentityId: 'mock-node-identity',
  },
  contextGraphs: {
    contextGraphs: [
      { id: 'cg:pharma-drug-interactions', name: 'Pharma Drug Interactions', description: 'Drug interaction knowledge graph for clinical decision support', assetCount: 227, agentCount: 3, callerInvolved: true, curator: 'did:dkg:agent:0x1111111111111111111111111111111111111111' },
      { id: 'cg:climate-science', name: 'Climate Science', description: 'Climate research data and projections', assetCount: 45, agentCount: 2, callerInvolved: true, curator: 'did:dkg:agent:0x1111111111111111111111111111111111111111' },
      { id: 'cg:supply-chain-eu', name: 'EU Supply Chain', description: 'European supply chain provenance tracking', assetCount: 89, agentCount: 1, callerInvolved: true, curator: 'did:dkg:agent:0x5555555555555555555555555555555555555555' },
    ],
  },
  participants: {
    'cg:pharma-drug-interactions': { contextGraphId: 'cg:pharma-drug-interactions', allowedAgents: ['0x2222222222222222222222222222222222222222', '0x3333333333333333333333333333333333333333'] },
    'cg:climate-science': { contextGraphId: 'cg:climate-science', allowedAgents: ['0x4444444444444444444444444444444444444444'] },
    'cg:supply-chain-eu': { contextGraphId: 'cg:supply-chain-eu', allowedAgents: [] },
  },
  economics: { periods: [{ label: '24h', publishCount: 3, successCount: 3, totalGasEth: 0.0007, totalTrac: 9.1, avgGasEth: 0.00023, avgTrac: 3.03 }] },
  wallets: { wallets: [], balances: [], chainId: '8453', rpcUrl: 'https://mock.rpc', symbol: 'TRAC' },
  notifications: { notifications: [], unreadCount: 0 },
  joinRequests: { requests: [] },
};

function queryResponse(bindings: unknown[]) {
  return { result: { bindings } };
}

function isProfileSelectQuery(sparql: string): boolean {
  return sparql.includes('SELECT') && (
    sparql.includes('SubGraphBinding')
    || sparql.includes('EntityTypeBinding')
    || sparql.includes('prof:Profile')
    || sparql.includes('FilterChip')
    || sparql.includes('QueryCatalog')
    || sparql.includes('SavedQuery')
    || sparql.includes('ViewConfig')
  );
}

function classifySparql(sparql: string): 'wm' | 'swm' | 'vm' | 'meta' | 'other' {
  if (sparql.includes('/assertion/')) return 'wm';
  if (sparql.includes('_shared_memory')) return 'swm';
  if (sparql.includes('/meta') || sparql.includes('_meta')) return 'meta';
  if (sparql.includes('did:dkg:context-graph:')) return 'vm';
  return 'other';
}

function bindingsForQuery(sparql: string, cgId: string): unknown[] {
  if (isProfileSelectQuery(sparql)) {
    if (sparql.includes('SubGraphBinding')) return profileSubGraphSelectBindings(cgId);
    return [];
  }
  switch (classifySparql(sparql)) {
    case 'wm': return wmBindings(cgId);
    case 'swm': return swmBindings(cgId);
    case 'vm': return vmBindings(cgId);
    case 'meta': return profileMetaBindings(cgId);
    default: return [];
  }
}

async function fulfillJson(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

function cgIdFromUrl(url: string): string | null {
  const m = url.match(/context-graph\/([^/?]+)/);
  return m ? decodeURIComponent(m[1]!) : null;
}

export type RichMockOptions = {
  primaryCgId?: string;
  allContextGraphs?: boolean;
};

/**
 * Force deterministic mock API responses so Playwright tests do not depend
 * on a live daemon or ~/.dkg configuration.
 */
export async function installRichMemoryRoutes(
  page: Page,
  opts: RichMockOptions = {},
): Promise<void> {
  const primaryCgId = opts.primaryCgId ?? PHARMA_CG_ID;

  await page.route('**/api/**', async (route: Route) => {
    const url = route.request().url();
    const path = new URL(url).pathname;
    const method = route.request().method();

    if (path === '/api/status') return fulfillJson(route, MOCK_API.status);
    if (path === '/api/agent/identity' || path === '/api/agent/current') return fulfillJson(route, MOCK_API.agent);
    if (path === '/api/context-graphs' || path === '/api/context-graph/list') return fulfillJson(route, MOCK_API.contextGraphs);
    if (path === '/api/metrics') return fulfillJson(route, { total_kcs: 1842, confirmed_kcs: 1623, tentative_kcs: 219 });
    if (path === '/api/agents') return fulfillJson(route, { agents: [] });
    if (path === '/api/economics') return fulfillJson(route, MOCK_API.economics);
    if (path === '/api/wallets/balances') return fulfillJson(route, MOCK_API.wallets);
    if (path === '/api/notifications') return fulfillJson(route, MOCK_API.notifications);
    if (path === '/api/operations' || path.startsWith('/api/operations/')) {
      return fulfillJson(route, { operations: [], total: 0 });
    }
    if (path.startsWith('/api/memory/sessions')) {
      return fulfillJson(route, { sessions: [] });
    }
    if (path.startsWith('/api/sub-graph/list')) {
      const cgId = new URL(url).searchParams.get('contextGraphId') ?? primaryCgId;
      return fulfillJson(route, subGraphList(cgId));
    }
    if (path.includes('/participants') && method === 'GET') {
      const cgId = cgIdFromUrl(path) ?? primaryCgId;
      const p = MOCK_API.participants[cgId as keyof typeof MOCK_API.participants];
      return fulfillJson(route, p ?? { contextGraphId: cgId, allowedAgents: [] });
    }
    if (path.includes('/join-requests') && method === 'GET') {
      return fulfillJson(route, { contextGraphId: cgIdFromUrl(path) ?? primaryCgId, requests: [] });
    }
    if (path === '/api/query' && method === 'POST') {
      let body: { sparql?: string; contextGraphId?: string } = {};
      try { body = route.request().postDataJSON() ?? {}; } catch { /* empty */ }
      const cgId = body.contextGraphId ?? primaryCgId;
      return fulfillJson(route, queryResponse(bindingsForQuery(body.sparql ?? '', cgId)));
    }
    if (path.startsWith('/api/events')) {
      return route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: ': mock sse\n\n',
      });
    }

    // Fail fast — do not leak to a live daemon when an endpoint is missing.
    await route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({ error: `rich-mock: unstubbed ${method} ${path}` }),
    });
  });
}

export async function uninstallRichMemoryRoutes(page: Page): Promise<void> {
  await page.unroute('**/api/**');
}
