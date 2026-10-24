import type { NotificationsFeedResponse, SubGraphInfo } from '../api.js';

export const MOCK_STATUS = {
  name: 'my-dkg-node',
  networkName: 'DKG Mainnet',
  connectedPeers: 12,
  synced: true,
  version: '10.0.0-rc',
};

export const MOCK_METRICS = {
  total_kcs: 1842,
  confirmed_kcs: 1623,
  tentative_kcs: 219,
};

export const MOCK_AGENTS = {
  agents: [
    { name: 'my-dkg-node', peerId: 'QmYourNode123', connectionStatus: 'self' },
    { name: 'research-agent', peerId: 'QmResearch456', connectionStatus: 'connected', lastSeen: Date.now() },
    { name: 'data-curator', peerId: 'QmCurator789', connectionStatus: 'connected', lastSeen: Date.now() - 60000 },
    { name: 'pharma-bot', peerId: 'QmPharma012', connectionStatus: 'discovered', lastSeen: Date.now() - 300000 },
  ],
};

export const MOCK_CONTEXT_GRAPHS = {
  contextGraphs: [
    {
      id: 'cg:pharma-drug-interactions',
      name: 'Pharma Drug Interactions',
      description: 'Drug interaction knowledge graph for clinical decision support',
      assetCount: 227,
      agentCount: 3,
      callerInvolved: true,
      curator: 'did:dkg:agent:0x1111111111111111111111111111111111111111',
    },
    {
      id: 'cg:climate-science',
      name: 'Climate Science',
      description: 'Climate research data and projections',
      assetCount: 45,
      agentCount: 2,
      callerInvolved: true,
      curator: 'did:dkg:agent:0x1111111111111111111111111111111111111111',
    },
    {
      id: 'cg:supply-chain-eu',
      name: 'EU Supply Chain',
      description: 'European supply chain provenance tracking',
      assetCount: 89,
      agentCount: 1,
      callerInvolved: true,
      curator: 'did:dkg:agent:0x5555555555555555555555555555555555555555',
    },
  ],
};

// Mock allow-lists keyed by CG id. Curator is intentionally a
// `did:dkg:agent:` URI while participants are bare EVM addresses
// (mirrors the real /participants vs cg.curator shape) so mock mode
// exercises canonicalAgentDid convergence + cross-CG dedup: the same
// curator 0x1111… spans pharma + climate, so the aggregate unique
// count is 5, not 3+2+1.
export const MOCK_PARTICIPANTS: Record<string, { contextGraphId: string; allowedAgents: string[] }> = {
  'cg:pharma-drug-interactions': {
    contextGraphId: 'cg:pharma-drug-interactions',
    allowedAgents: [
      '0x2222222222222222222222222222222222222222',
      '0x3333333333333333333333333333333333333333',
    ],
  },
  'cg:climate-science': {
    contextGraphId: 'cg:climate-science',
    allowedAgents: ['0x4444444444444444444444444444444444444444'],
  },
  'cg:supply-chain-eu': {
    contextGraphId: 'cg:supply-chain-eu',
    allowedAgents: [],
  },
};

export const MOCK_OPERATIONS = {
  operations: [
    { id: 'op-1', name: 'publish', status: 'completed', startedAt: Date.now() - 120000 },
    { id: 'op-2', name: 'query', status: 'completed', startedAt: Date.now() - 300000 },
    { id: 'op-3', name: 'publish', status: 'completed', startedAt: Date.now() - 600000 },
    { id: 'op-4', name: 'chat', status: 'completed', startedAt: Date.now() - 900000 },
    { id: 'op-5', name: 'sync', status: 'failed', startedAt: Date.now() - 1800000 },
    { id: 'op-6', name: 'publish', status: 'completed', startedAt: Date.now() - 3600000 },
  ],
  total: 6,
};

export const MOCK_ECONOMICS = {
  // Labels mirror the real /api/economics scheme (db.ts: 24h/7d/30d/all).
  periods: [
    { label: '24h', publishCount: 3, successCount: 3, totalGasEth: 0.0007, totalTrac: 9.1, avgGasEth: 0.00023, avgTrac: 3.03 },
    { label: '7d', publishCount: 14, successCount: 12, totalGasEth: 0.0034, totalTrac: 42.5, avgGasEth: 0.00024, avgTrac: 3.04 },
    { label: '30d', publishCount: 47, successCount: 43, totalGasEth: 0.012, totalTrac: 156.8, avgGasEth: 0.00026, avgTrac: 3.34 },
  ],
};

// Mock node-agent identity. agentDid matches the pharma + climate
// mock curators (0x1111…) so mock mode exercises curator-aware UI
// (CURATOR vs JOINED badge, identity-based membership fallback) the
// same way the real daemon would.
export const MOCK_AGENT_IDENTITY = {
  agentAddress: '0x1111111111111111111111111111111111111111',
  agentDid: 'did:dkg:agent:0x1111111111111111111111111111111111111111',
  name: 'mock-node-agent',
  framework: 'mock',
  peerId: 'QmMockNodeAgentPeer000000000000000000000000',
  nodeIdentityId: 'mock-node-identity',
};

export const MOCK_WALLETS = {
  wallets: [
    '0xA1b2C3d4E5f60718293a4B5c6D7e8F9012345678',
    '0xB2c3D4e5F60718293a4B5c6D7e8F90123456789a',
    '0xC3d4E5f60718293a4B5c6D7e8F90123456789aB1',
  ],
  balances: [
    { address: '0xA1b2C3d4E5f60718293a4B5c6D7e8F9012345678', eth: '0.842', trac: '1250.50', symbol: 'TRAC' },
    { address: '0xB2c3D4e5F60718293a4B5c6D7e8F90123456789a', eth: '0.310', trac: '480.00', symbol: 'TRAC' },
    { address: '0xC3d4E5f60718293a4B5c6D7e8F90123456789aB1', eth: '0.005', trac: '0.00', symbol: 'TRAC' },
  ],
  chainId: '8453',
  rpcUrl: 'https://mock.rpc',
  symbol: 'TRAC',
};

// Scoped pane wire contract (implementation-plan §3 / api.ts NotificationsFeedResponse):
// one actionable join request, one activity digest, one outbound confirmation.
export const MOCK_NOTIFICATIONS_FEED = {
  notifications: [
    {
      type: 'join_request',
      id: 101,
      ts: Date.now() - 120000,
      read: 0,
      contextGraphId: 'cg:pharma-drug-interactions',
      meta: { contextGraphName: 'Pharma Drug Interactions', agentAddress: '0xab12cd34ef56ab78cd90ab12cd34ef56ab78cd90', agentName: 'research-agent' },
    },
    {
      type: 'assertion_activity',
      id: 'activity:cg:pharma-drug-interactions:promoted:29812',
      ts: Date.now() - 300000,
      read: 0,
      contextGraphId: 'cg:pharma-drug-interactions',
      meta: { contextGraphName: 'Pharma Drug Interactions', kind: 'promoted', count: 3, actorAgentDid: 'did:dkg:agent:0xdana00000000000000000000000000000000dana', actorAgentName: 'Dana', soleAuthor: true },
    },
    {
      type: 'join_approved',
      id: 102,
      ts: Date.now() - 900000,
      read: 1,
      contextGraphId: 'cg:climate-arctic',
      meta: { contextGraphName: 'Arctic Climate', agentAddress: '0x0000000000000000000000000000000000000001' },
    },
  ],
  badgeCount: 2,
} satisfies NotificationsFeedResponse;

export const MOCK_NODE_LOG = {
  lines: [
    '[2026-04-11 10:30:01] INFO  Node started on port 8900',
    '[2026-04-11 10:30:02] INFO  Connected to DKG mainnet',
    '[2026-04-11 10:30:03] INFO  Discovered 12 peers',
    '[2026-04-11 10:30:05] INFO  Syncing context graph cg:pharma-drug-interactions',
    '[2026-04-11 10:30:08] INFO  Sync complete: 227 assets, 3 agents',
    '[2026-04-11 10:30:15] INFO  Agent research-agent connected via libp2p',
    '[2026-04-11 10:31:00] INFO  Publish operation started: warfarin-aspirin-001',
    '[2026-04-11 10:31:12] INFO  Triple store updated: +34 triples',
    '[2026-04-11 10:31:15] INFO  Publish complete: warfarin-aspirin-001 → Verifiable Memory',
    '[2026-04-11 10:32:00] DEBUG SPARQL query executed in 23ms (42 results)',
    '[2026-04-11 10:33:00] INFO  Gossip: received 3 proposals from data-curator',
    '[2026-04-11 10:34:00] INFO  SWM cleanup: 0 expired triples removed',
    '[2026-04-11 10:35:00] INFO  Heartbeat: 12 peers, 1842 KAs, memory 245MB',
  ],
  totalSize: 13,
};

export const MOCK_SESSIONS = {
  sessions: [
    {
      session: 'sess-abc123',
      messages: [
        { author: 'user', text: 'What drug interactions should I know about warfarin?', ts: '2026-04-11T10:00:00Z' },
        { author: 'assistant', text: 'Warfarin has significant interactions with aspirin, NSAIDs, and several antibiotics. The most critical ones involve...', ts: '2026-04-11T10:00:05Z' },
      ],
    },
    {
      session: 'sess-def456',
      messages: [
        { author: 'user', text: 'Summarize the latest climate data for Arctic ice', ts: '2026-04-10T14:00:00Z' },
        { author: 'assistant', text: 'Based on the latest projections in the verifiable memory...', ts: '2026-04-10T14:00:03Z' },
      ],
    },
  ],
};

// GH#1763 — mock sub-graph lists keyed by CG id, mirroring the real
// `/api/sub-graph/list` response shape. `provider.ts` previously reached for
// this map through `(mock as any).MOCK_SUBGRAPHS`, which the module never
// exported: the optional lookup kept mock mode from crashing, but the
// per-CG override the comment promised could never fire and the production
// Vite build emitted a missing-export warning on every run.
//
// Only CGs whose sub-graph UI is worth exercising need an entry — the
// provider falls back to an empty list for anything absent, which is what
// `cg:supply-chain-eu` deliberately exercises.
//
// Fidelity rules this fixture must hold to, because its stated job is
// mirroring a real `/api/sub-graph/list` response (PR #2131 review):
//   1. `name` is the sub-graph SLUG, not a display label. `validateSubGraphName`
//      (`packages/core/src/constants.ts:650`) rejects whitespace, so a name like
//      `'Arctic Ice'` is a row the daemon can never emit. The human-readable
//      label arrives from the profile binding (`displayName ?? sg.name`).
//   2. `uri` is `did:dkg:context-graph:<cgId>/<name>` — `contextGraphSubGraphUri`
//      (`constants.ts:563`), which `generateSubGraphRegistration` mints the
//      registration subject from. The tail must equal `name` exactly.
//   3. `createdBy` / `createdAt` are always emitted by the list route
//      (`cli/src/daemon/routes/context-graph.ts:1004-1010`), so a row without
//      them is likewise unreachable.
// `mock-provider-subgraphs.test.ts` pins all three.
export const MOCK_SUBGRAPHS: Record<
  string,
  { contextGraphId: string; subGraphs: SubGraphInfo[] }
> = {
  'cg:pharma-drug-interactions': {
    contextGraphId: 'cg:pharma-drug-interactions',
    subGraphs: [
      {
        name: 'interactions',
        uri: 'did:dkg:context-graph:cg:pharma-drug-interactions/interactions',
        description: 'Pairwise drug interaction records',
        createdBy: 'did:dkg:agent:0x1111111111111111111111111111111111111111',
        createdAt: '2026-04-02T09:15:00Z',
        entityCount: 148,
        tripleCount: 1721,
      },
      {
        name: 'contraindications',
        uri: 'did:dkg:context-graph:cg:pharma-drug-interactions/contraindications',
        createdBy: 'did:dkg:agent:0x2222222222222222222222222222222222222222',
        createdAt: '2026-04-05T16:40:00Z',
        entityCount: 79,
        tripleCount: 604,
      },
    ],
  },
  'cg:climate-science': {
    contextGraphId: 'cg:climate-science',
    subGraphs: [
      {
        name: 'arctic-ice',
        uri: 'did:dkg:context-graph:cg:climate-science/arctic-ice',
        description: 'Sea-ice extent projections',
        createdBy: 'did:dkg:agent:0x3333333333333333333333333333333333333333',
        createdAt: '2026-04-11T08:05:00Z',
        entityCount: 32,
        tripleCount: 410,
      },
    ],
  },
};
