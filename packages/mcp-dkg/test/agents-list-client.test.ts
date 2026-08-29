import { describe, expect, it } from 'vitest';
import { DkgClient, type AgentListRow } from '../src/client.js';
import { makeConfig } from './harness.js';

// GH#310 follow-up — the daemon 400s on unknown parameter NAMES, so this
// client's option→query-param mapping is a hard contract: a wrong name is a
// hard failure, a dropped one silently widens the query.
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

  it('the row type states the route invariants at compile time', () => {
    // Identity + enrichment are daemon guarantees — required, not optional.
    // @ts-expect-error a row without identity fields must not type-check
    const missingIdentity: AgentListRow = { connectionStatus: 'connected' };
    // @ts-expect-error a status the endpoint cannot emit must not type-check
    const badStatus: AgentListRow = fullRow({ connectionStatus: 'connecting' });
    void missingIdentity;
    void badStatus;
    // Known fields read without casts; unknown extras stay reachable.
    const row = fullRow({ futureField: 1 });
    expect(row.peerId).toBe('p1');
    expect(row.futureField).toBe(1);
  });

  it('listAgents() maps every non-truncating filter to the daemon parameter names', async () => {
    const { client, urls } = makeClient();
    await client.listAgents({ framework: 'eliza', connectionStatus: 'connected', local: false });
    const url = urls[0]!;
    expect(url).toContain('framework=eliza');
    expect(url).toContain('connectionStatus=connected');
    // false must be SENT — dropping it flips "everyone else's agents" into
    // "everyone's agents".
    expect(url).toContain('local=false');
  });

  it('listAgentsPage() carries limit/cursor out and nextCursor back, and the cursor continues', async () => {
    const { client, urls } = makeClient({ agents: [fullRow()], nextCursor: 'n1' });
    const page = await client.listAgentsPage({ connectionStatus: 'self', skillType: 'ImageAnalysis', limit: 5, cursor: 'c0' });
    expect(urls[0]).toContain('connectionStatus=self');
    // The camelCase option maps to the daemon's snake_case parameter.
    expect(urls[0]).toContain('skill_type=ImageAnalysis');
    expect(urls[0]).toContain('limit=5');
    expect(urls[0]).toContain('cursor=c0');
    // Rows are typed: known fields need no cast.
    expect(page.agents[0]!.peerId).toBe('p1');
    expect(page.nextCursor).toBe('n1');

    // The returned cursor is directly usable for the next call.
    await client.listAgentsPage({ connectionStatus: 'self', skillType: 'ImageAnalysis', limit: 5, cursor: page.nextCursor });
    expect(urls[1]).toContain('cursor=n1');
  });

  it('listAgentsPage() omits nextCursor on a final page', async () => {
    const { client } = makeClient({ agents: [] });
    const page = await client.listAgentsPage({ limit: 5 });
    expect('nextCursor' in page).toBe(false);
  });
});
