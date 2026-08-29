import { describe, expect, it } from 'vitest';
import { DkgClient } from '../src/client.js';
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

  it('listAgents() keeps the bare path with no options', async () => {
    const { client, urls } = makeClient({ agents: [{ name: 'a' }] });
    const agents = await client.listAgents();
    expect(agents).toEqual([{ name: 'a' }]);
    expect(urls[0]!.endsWith('/api/agents')).toBe(true);
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

  it('listAgentsPage() carries limit/cursor out and nextCursor back', async () => {
    const { client, urls } = makeClient({ agents: [{ name: 'a' }], nextCursor: 'n1' });
    const page = await client.listAgentsPage({ connectionStatus: 'self', limit: 5, cursor: 'c0' });
    expect(urls[0]).toContain('connectionStatus=self');
    expect(urls[0]).toContain('limit=5');
    expect(urls[0]).toContain('cursor=c0');
    expect(page.agents).toEqual([{ name: 'a' }]);
    expect(page.nextCursor).toBe('n1');
  });

  it('listAgentsPage() omits nextCursor on a final page', async () => {
    const { client } = makeClient({ agents: [] });
    const page = await client.listAgentsPage({ limit: 5 });
    expect('nextCursor' in page).toBe(false);
  });
});
