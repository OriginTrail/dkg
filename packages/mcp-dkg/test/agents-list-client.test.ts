import { describe, expect, it } from 'vitest';
import { DkgClient, type AgentListRow } from '../src/client.js';
import { makeConfig } from './harness.js';

// GH#310 follow-up — the daemon 400s on unknown parameter NAMES, so this
// client's option→query-param mapping is a hard contract: a wrong name is a
// hard failure, a dropped one silently widens the query.
/**
 * Exact query-entry map — substring assertions are spoofable (a URL holding
 * `badconnectionStatus=connected` CONTAINS `connectionStatus=connected`),
 * and the wire parameter NAMES are the load-bearing contract here.
 */
const queryEntries = (url: string): Record<string, string> =>
  Object.fromEntries(new URLSearchParams(url.split('?')[1] ?? ''));

describe('DkgClient agents-list serialization', () => {
  const makeClient = (body: unknown = { agents: [] }) => {
    const urls: string[] = [];
    const client = new DkgClient({
      config: makeConfig(),
      fetcher: (async (url) => {
        urls.push(String(url));
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }) as typeof fetch,
    });
    return { client, urls };
  };

  const fullRow = (over: Partial<AgentListRow> = {}): AgentListRow => ({
    agentUri: 'did:dkg:agent:0xabc',
    name: 'a',
    peerId: 'p1',
    connectionStatus: 'connected',
    connectionTransport: 'direct',
    connectionDirection: 'outbound',
    connectedSinceMs: 5_000,
    lastSeen: 123,
    latencyMs: 9,
    ...over,
  });

  it('listAgents() keeps the bare path with no options', async () => {
    const { client, urls } = makeClient({ agents: [fullRow()] });
    const agents = await client.listAgents();
    expect(agents).toEqual([fullRow()]);
    expect(urls[0]!.endsWith('/api/agents')).toBe(true);
  });

  it('known fields read without casts; unknown extras stay reachable', () => {
    // The compile-time half of this contract (required identity, closed
    // status union) lives in test-d/agent-list-row.test-d.ts, which runs
    // under tsc via the vitest typecheck lane — here the types are stripped.
    const row = fullRow({ futureField: 1 });
    expect(row.peerId).toBe('p1');
    expect(row.futureField).toBe(1);
  });

  it('listAgents() maps every non-truncating filter to the daemon parameter names', async () => {
    const { client, urls } = makeClient();
    await client.listAgents({ framework: 'eliza', connectionStatus: 'connected', local: false });
    // Exact entries — and local=false must be SENT: dropping it flips
    // "everyone else's agents" into "everyone's agents".
    expect(queryEntries(urls[0]!)).toEqual({
      framework: 'eliza',
      connectionStatus: 'connected',
      local: 'false',
    });
  });

  it('listAgentsPage() carries limit/cursor out and nextCursor back, and the cursor continues', async () => {
    const { client, urls } = makeClient({ agents: [fullRow()], nextCursor: 'n1' });
    const page = await client.listAgentsPage({ connectionStatus: 'self', skillType: 'ImageAnalysis', limit: 5, cursor: 'c0' });
    // Exact entries: the camelCase option maps to the daemon's snake_case
    // parameter, and the NAMES are the load-bearing part.
    expect(queryEntries(urls[0]!)).toEqual({
      connectionStatus: 'self',
      skill_type: 'ImageAnalysis',
      limit: '5',
      cursor: 'c0',
    });
    // Rows are typed: known fields need no cast.
    expect(page.agents[0]!.peerId).toBe('p1');
    expect(page.nextCursor).toBe('n1');

    // The returned cursor is directly usable for the next call.
    await client.listAgentsPage({ connectionStatus: 'self', skillType: 'ImageAnalysis', limit: 5, cursor: page.nextCursor });
    expect(queryEntries(urls[1]!).cursor).toBe('n1');
  });

  it('listAgentsPage() omits nextCursor on a final page', async () => {
    const { client } = makeClient({ agents: [] });
    const page = await client.listAgentsPage({ limit: 5 });
    expect('nextCursor' in page).toBe(false);
  });
});
