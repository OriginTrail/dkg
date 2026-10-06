/**
 * The real stack behind `openclaw-persist-turn.e2e.test.ts`: a real `DKGAgent`
 * (real libp2p, real Oxigraph store, `MockChainAdapter` for the chain) backs the
 * daemon's real chat-memory stack (`buildChatMemoryStack`, the same wiring
 * `runDaemonInner` uses), and the real OpenClaw, Hermes and Prime Agent route
 * handlers and the dashboard's chat-history handler (`handleNodeUIRequest`,
 * which serves `GET /api/memory/sessions[/:id[/graph-delta]]`) sit behind a real
 * `http.Server`. Nothing under test is mocked.
 *
 * `createPersistTurnFixture()` only builds the fixture; `start()` boots it and
 * `stop()` tears it down, so the suite keeps its own `beforeAll`/`afterAll`
 * (one agent start for the whole file) and the helpers below (`persistTurn`,
 * `listed`, `single`, `graphDelta`, `select`, `footprint`) are closures over the
 * running instance, valid between `start()` and `stop()`.
 */
import { createServer, type Server } from 'node:http';
import { expect } from 'vitest';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { DKGAgent } from '@origintrail-official/dkg-agent';
import {
  AGENT_CONTEXT_GRAPH,
  CHAT_TURNS_ASSERTION,
  handleNodeUIRequest,
  type ChatMemoryManager,
} from '@origintrail-official/dkg-node-ui';
import { buildChatMemoryStack, resolveMemoryAgentAddress } from '../../src/daemon.js';
import { handleHermesRoutes } from '../../src/daemon/routes/hermes.js';
import { handleOpenclawRoutes } from '../../src/daemon/routes/openclaw.js';
import { handlePrimeAgentRoutes } from '../../src/daemon/routes/prime-agent.js';
import { lexicalTerm, readChatTurnFootprint } from './chat-turn-footprint.js';
import { requestAuthentication } from './request-authentication.js';

export const PERSIST_TURN = '/api/openclaw-channel/persist-turn';

export interface PersistResponse {
  status: number;
  body: { ok?: boolean; duplicate?: boolean; transitioned?: boolean; turnId?: string; sessionId?: string; error?: string };
}

export type HistoryMessage = { author: string; text: string };

/** The answer of `GET /api/memory/sessions/:id/graph-delta`. */
export interface GraphDeltaResponse {
  mode: string;
  reason?: string;
  watermark: { appliedTurnId: string | null; turnCount: number };
  triples: Array<{ subject: string; predicate: string; object: string }>;
}

export function createPersistTurnFixture() {
  let agent: DKGAgent;
  let memoryManager: ChatMemoryManager;
  let agentAddress: string;
  let server: Server | undefined;
  let baseUrl: string;

  /** Boot the agent, the chat-memory stack and the route server. A failed start stops the agent again. */
  async function start(): Promise<void> {
    agent = await DKGAgent.create({
      name: 'OpenClawPersistTurnE2E',
      listenHost: '127.0.0.1',
      nodeRole: 'edge',
      chainAdapter: new MockChainAdapter(),
      rfc64CatalogActivation: { enabled: false },
    });
    try {
      await agent.start();

      agentAddress = resolveMemoryAgentAddress(agent);
      ({ manager: memoryManager } = buildChatMemoryStack({
        agent,
        emitMemoryGraphChanged: () => {},
        llmConfig: { apiKey: '' },
        agentAddress,
      }));

      server = createServer(async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const ctx = {
          req,
          res,
          agent,
          config: { name: 'openclaw-persist-turn-e2e', apiPort: 0, listenPort: 0, nodeRole: 'edge' },
          memoryManager,
          bridgeAuthToken: 'bridge-token',
          extractionStatus: new Map(),
          url,
          path: url.pathname,
          requestAgentAddress: agentAddress,
          authentication: requestAuthentication({ kind: 'nodeOperator' }),
        } as any;
        // The three local-agent channels, each with its own persist-turn route, all
        // in front of the one real chat-memory stack.
        for (const handle of [handleOpenclawRoutes, handleHermesRoutes, handlePrimeAgentRoutes]) {
          await handle(ctx);
          if (res.writableEnded) break;
        }
        // The dashboard's chat-history routes, the same handler the daemon runs, over
        // the same real manager.
        if (!res.writableEnded) {
          await handleNodeUIRequest(req, res, url, {} as any, '.', undefined, undefined, undefined, memoryManager);
        }
        if (!res.writableEnded) {
          res.statusCode = 404;
          res.end('{}');
        }
      });
      await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('route server did not bind');
      baseUrl = `http://127.0.0.1:${address.port}`;
    } catch (error) {
      await stop();
      throw error;
    }
  }

  async function stop(): Promise<void> {
    const open = server;
    await new Promise<void>((resolve) => (open ? open.close(() => resolve()) : resolve()));
    await agent?.stop().catch(() => {});
  }

  /** POST one turn the way the OpenClaw adapter's `DkgClient.storeChatTurn` does. */
  async function persistTurn(payload: Record<string, unknown>, path = PERSIST_TURN): Promise<PersistResponse> {
    const response = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return { status: response.status, body: await response.json() as PersistResponse['body'] };
  }

  async function getJson<T>(path: string): Promise<T> {
    const response = await fetch(`${baseUrl}${path}`);
    expect(response.status).toBe(200);
    return await response.json() as T;
  }

  /** The session as `GET /api/memory/sessions` lists it. */
  async function listed(sessionId: string): Promise<HistoryMessage[] | undefined> {
    const { sessions } = await getJson<{ sessions: Array<{ session: string; messages: HistoryMessage[] }> }>('/api/memory/sessions?limit=100');
    return sessions.find((entry) => entry.session === sessionId)?.messages.map(({ author, text }) => ({ author, text }));
  }

  /** The session as `GET /api/memory/sessions/:id` returns it. */
  async function single(sessionId: string): Promise<HistoryMessage[]> {
    const { messages } = await getJson<{ messages: HistoryMessage[] }>(`/api/memory/sessions/${encodeURIComponent(sessionId)}`);
    return messages.map(({ author, text }) => ({ author, text }));
  }

  /** The turn as `GET /api/memory/sessions/:id/graph-delta?turnId=` returns it. */
  async function graphDelta(sessionId: string, turnId: string, baseTurnId?: string): Promise<GraphDeltaResponse> {
    const query = `turnId=${encodeURIComponent(turnId)}${baseTurnId ? `&baseTurnId=${encodeURIComponent(baseTurnId)}` : ''}`;
    return await getJson<GraphDeltaResponse>(`/api/memory/sessions/${encodeURIComponent(sessionId)}/graph-delta?${query}`);
  }

  /** One SELECT against the chat-turns Working Memory assertion. */
  async function select(sparql: string): Promise<Array<Record<string, string>>> {
    const result = await agent.query(sparql, {
      contextGraphId: AGENT_CONTEXT_GRAPH,
      view: 'working-memory',
      agentAddress,
      assertionName: CHAT_TURNS_ASSERTION,
    });
    return (result.bindings ?? []) as Array<Record<string, string>>;
  }

  /** Everything one `(sessionId, turnId)` left in the chat-turns assertion. */
  const footprint = (sessionId: string, turnId: string) => readChatTurnFootprint(select, lexicalTerm, sessionId, turnId);

  return {
    start,
    stop,
    persistTurn,
    getJson,
    listed,
    single,
    graphDelta,
    select,
    footprint,
    /** The running instance's parts, for a suite that reads or writes the store itself. */
    get agent() { return agent; },
    get memoryManager() { return memoryManager; },
    get agentAddress() { return agentAddress; },
  };
}

export type PersistTurnFixture = ReturnType<typeof createPersistTurnFixture>;
