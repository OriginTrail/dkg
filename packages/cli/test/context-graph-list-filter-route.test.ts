import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { DKGAgent } from '@origintrail-official/dkg-agent';
import { SYSTEM_CONTEXT_GRAPHS, contextGraphDataUri } from '@origintrail-official/dkg-core';
import { handleContextGraphRoutes } from '../src/daemon/routes/context-graph.js';
import {
  CONTEXT_GRAPH_LIST_FILTER_INVALID,
  parseContextGraphListQuery,
} from '../src/daemon/routes/context-graph-list-query.js';
import { requestAuthentication } from './_helpers/request-authentication.js';

const AGENT_ADDRESS = '0x1111111111111111111111111111111111111111';
const NAMED_ID = 'named-public';
const SYSTEM_ID = SYSTEM_CONTEXT_GRAPHS.ONTOLOGY;
/** A graph the node knows only by the name hash the chain committed. */
const WIRE_ONLY_ID = `0x${'bb'.repeat(32)}`;
const WIRE_ONLY_FACTS = {
  onChainId: '9',
  nameHash: WIRE_ONLY_ID,
  owner: `0x${'22'.repeat(20)}`,
  accessPolicy: 1,
  publishPolicy: 0,
  publishAuthority: `0x${'33'.repeat(20)}`,
  createdAt: 1_790_000_000,
  active: true,
  observedAtBlock: 700,
};

function projectedMeta(id: string) {
  return {
    id,
    uri: contextGraphDataUri(id),
    declared: true,
    isSystem: id === SYSTEM_ID,
    name: `local name of ${id}`,
    creators: [],
    curators: [],
    allowedPeers: [],
    allowedAgents: [],
    participantAgents: [],
    participantIdentityIds: [],
    revokedAgents: [],
    subGraphs: [],
    hasAgentGate: false,
    hasPeerGate: false,
    hasLegacyParticipantGate: false,
    accessPolicy: 'public',
  };
}

/** The agent's own cached listing over a small store: a named graph, a system graph and a wire-only one. */
function listingAgent() {
  const ids = [NAMED_ID, SYSTEM_ID, WIRE_ONLY_ID];
  const listing = DKGAgent.prototype as any;
  return {
    // The authority governor runs each read at once here.
    rfc64AuthorityReadCoordinatorV1: {
      run: (signal: AbortSignal, read: (signal: AbortSignal, evidence: unknown) => Promise<unknown>) =>
        read(signal, { agentResolverReadOptions: (readSignal?: AbortSignal) => ({ signal: readSignal }) }),
    },
    subscribedContextGraphs: new Map([
      [WIRE_ONLY_ID, { onChainHash: WIRE_ONLY_ID, onChainId: '9', subscribed: false, synced: false }],
    ]),
    wireIdToLocalCgId: new Map([[WIRE_ONLY_ID, WIRE_ONLY_ID]]),
    onChainContextGraphFacts: new Map([['9', WIRE_ONLY_FACTS]]),
    store: {
      query: async () => ({
        type: 'bindings' as const,
        bindings: ids.map((id) => ({
          ctxGraph: contextGraphDataUri(id),
          name: `"local name of ${id}"`,
          access: '"public"',
          ...(id === SYSTEM_ID ? { isSystem: 'true' } : {}),
        })),
      }),
      listGraphsByPrefix: async () => [],
    },
    getCgMeta: async (id: string) => projectedMeta(id),
    resolveFinalizedContextGraphAuthorityTargetsV1: async () => ({ kind: 'legacy-current' as const }),
    readLocalContextGraphRegistrationStatus: async () => null,
    getContextGraphOnChainId: async () => undefined,
    getContextGraphCurator: async () => undefined,
    isPrivateContextGraph: async () => false,
    curatorDidMatchesChecksumAgent: () => false,
    callerIsAllowlistedAgentParticipant: async () => false,
    listContextGraphsCacheAllowed: () => true,
    listContextGraphsCacheNow: () => 1_000,
    listContextGraphsCacheGeneration: 0,
    listContextGraphsCache: new Map(),
    listContextGraphsInFlight: new Map(),
    listContextGraphsUncached: listing.listContextGraphsUncached,
    listContextGraphs: listing.listContextGraphs,
  };
}

describe('GET /api/context-graph/list opt-in filters (#3919)', () => {
  let server: Server | undefined;
  let baseUrl = '';
  let agent: Record<string, any>;

  beforeEach(async () => {
    server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const agentToken = req.headers.authorization === 'Bearer agent-token';
      await handleContextGraphRoutes({
        req,
        res,
        agent,
        url,
        path: url.pathname,
        authentication: agentToken
          ? requestAuthentication({ kind: 'agent', agentAddress: AGENT_ADDRESS, token: 'agent-token' })
          : requestAuthentication({ kind: 'nodeOperator' }),
      } as any);
      if (!res.writableEnded) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
      }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    baseUrl = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : '';
  });

  afterEach(async () => {
    server?.closeAllConnections();
    await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
    server = undefined;
  });

  const listBody = async (query: string, init?: RequestInit) => {
    const response = await fetch(`${baseUrl}/api/context-graph/list${query}`, init);
    return { status: response.status, text: await response.text() };
  };

  describe('with a recording agent', () => {
    const rows = [{ id: NAMED_ID, name: 'Named', isSystem: false, nameKnown: true }];
    let seenOptions: unknown[];

    beforeEach(() => {
      seenOptions = [];
      agent = {
        listContextGraphs: async (options: unknown) => {
          seenOptions.push(options);
          return rows;
        },
      };
    });

    it('asks the agent exactly what it always did when no filter is sent', async () => {
      for (const query of ['', '?', '?unrelated=1', '?NAMED=true&OnChain=false']) {
        const { status, text } = await listBody(query);
        expect(status).toBe(200);
        expect(JSON.parse(text)).toStrictEqual({ contextGraphs: rows });
      }
      for (const options of seenOptions) expect(options).toStrictEqual({ callerAgentAddress: null });
      expect(seenOptions).toHaveLength(4);
    });

    it('passes each filter, alone and combined, with the caller', async () => {
      const cases: Array<[string, unknown]> = [
        ['?named=true', { namedOnly: true }],
        ['?system=false', { includeSystem: false }],
        ['?onChain=false', { includeOnChain: false }],
        ['?named=true&system=false', { namedOnly: true, includeSystem: false }],
        ['?named=true&system=false&onChain=false', { namedOnly: true, includeSystem: false, includeOnChain: false }],
        ['?named=false&system=true&onChain=true', { namedOnly: false, includeSystem: true, includeOnChain: true }],
      ];
      for (const [query, filter] of cases) {
        const { status } = await listBody(query);
        expect(status).toBe(200);
        expect(seenOptions.at(-1)).toStrictEqual({ callerAgentAddress: null, filter });
      }
      await listBody('?named=true', { headers: { authorization: 'Bearer agent-token' } });
      expect(seenOptions.at(-1)).toStrictEqual({ callerAgentAddress: AGENT_ADDRESS, filter: { namedOnly: true } });
    });

    it('answers 400 for a value it cannot read, naming the parameter and never the input', async () => {
      const cases: Array<[string, string]> = [
        ['?named=yes', '"named" must be "true" or "false"'],
        ['?named=', '"named" must be "true" or "false"'],
        ['?named=TRUE', '"named" must be "true" or "false"'],
        ['?system=0', '"system" must be "true" or "false"'],
        ['?onChain=no', '"onChain" must be "true" or "false"'],
        ['?named=true&onChain=%3Cb%3E', '"onChain" must be "true" or "false"'],
        ['?named=true&named=true', '"named" may be given only once'],
        ['?system=false&system=true', '"system" may be given only once'],
      ];
      for (const [query, error] of cases) {
        const { status, text } = await listBody(query);
        expect(status).toBe(400);
        expect(JSON.parse(text)).toEqual({ error, code: CONTEXT_GRAPH_LIST_FILTER_INVALID });
      }
      expect(seenOptions).toEqual([]);
    });
  });

  describe("with the agent's own listing", () => {
    beforeEach(() => {
      agent = listingAgent();
    });

    it('lists every graph with its chain facts when no filter is sent', async () => {
      const { status, text } = await listBody('');
      expect(status).toBe(200);
      const { contextGraphs } = JSON.parse(text);
      expect(contextGraphs.map((row: any) => [row.id, row.isSystem, row.nameKnown])).toEqual([
        [NAMED_ID, false, true],
        [SYSTEM_ID, true, true],
        [WIRE_ONLY_ID, false, false],
      ]);
      expect(contextGraphs[2].onChain).toMatchObject({ id: '9', nameHash: WIRE_ONLY_ID });
      // Spelling out every default changes nothing.
      expect((await listBody('?named=false&system=true&onChain=true')).text).toBe(text);
    });

    it('narrows the answer by each filter and their combination', async () => {
      const listed = async (query: string) => JSON.parse((await listBody(query)).text).contextGraphs as any[];
      expect((await listed('?named=true')).map((row) => row.id)).toEqual([NAMED_ID, SYSTEM_ID]);
      expect((await listed('?system=false')).map((row) => row.id)).toEqual([NAMED_ID, WIRE_ONLY_ID]);
      const noFacts = await listed('?onChain=false');
      expect(noFacts.map((row) => row.id)).toEqual([NAMED_ID, SYSTEM_ID, WIRE_ONLY_ID]);
      expect(noFacts.some((row) => 'onChain' in row)).toBe(false);
      expect(noFacts[2].onChainId).toBe('9');
      const all = await listed('?named=true&system=false&onChain=false');
      expect(all).toEqual([expect.objectContaining({ id: NAMED_ID, nameKnown: true })]);
      expect('onChain' in all[0]).toBe(false);
      // The unfiltered answer, cached first, is still the full one.
      expect((await listed('')).map((row) => row.id)).toEqual([NAMED_ID, SYSTEM_ID, WIRE_ONLY_ID]);
    });
  });
});

describe('parseContextGraphListQuery', () => {
  it('gives no filter for a request that names none of its parameters', () => {
    expect(parseContextGraphListQuery(new URLSearchParams(''))).toEqual({ ok: true, filter: undefined });
    expect(parseContextGraphListQuery(new URLSearchParams('limit=5&scope=all'))).toEqual({ ok: true, filter: undefined });
  });
});
