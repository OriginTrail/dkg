import { describe, expect, it, vi } from 'vitest';
import {
  paginateAgentRows,
  parseAgentsListQuery,
} from '../src/daemon/routes/agents-list.js';
import { handleAgentChatRoutes } from '../src/daemon/routes/agent-chat.js';
import type { RequestContext } from '../src/daemon/routes/context.js';

// GH#310 — GET /api/agents returned the full network registry (~750 agents,
// ~150 KB) with no pagination, no connection filter and no way to ask only
// for the node's own agents. These pin the new query surface AND the
// unchanged parameterless contract that node-ui's fetchAgents() and the MCP
// dkg_find_agents tool depend on.

function row(over: Record<string, unknown> = {}) {
  return {
    agentUri: 'did:dkg:agent/1',
    name: 'alpha',
    peerId: 'peer-1',
    framework: 'eliza',
    ...over,
  };
}

describe('parseAgentsListQuery (GH#310)', () => {
  const parse = (qs: string) => parseAgentsListQuery(new URLSearchParams(qs));

  it('accepts an empty query', () => {
    const r = parse('');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.query).toEqual({});
  });

  it('accepts each documented value', () => {
    const q = (qs: string) => {
      const r = parse(qs);
      expect(r.ok).toBe(true);
      if (!r.ok) throw new Error(r.error);
      return r.query;
    };
    expect(q('framework=OpenClaw')).toEqual({ framework: 'OpenClaw' });
    expect(q('skill_type=ImageAnalysis')).toEqual({ skillType: 'ImageAnalysis' });
    expect(q('connectionStatus=connected')).toEqual({ connectionStatus: 'connected' });
    expect(q('connectionStatus=self')).toEqual({ connectionStatus: 'self' });
    expect(q('local=true')).toEqual({ local: true });
    expect(q('local=false')).toEqual({ local: false });
    expect(q('limit=25')).toEqual({ limit: 25 });
  });

  it.each([
    // A typo silently returning the full 150 KB registry would defeat the
    // point of the parameter — every bad value must be a 400.
    'connectionStatus=onnected',
    'local=ture',
    'local=1',
    'limit=0',
    'limit=-5',
    'limit=2.5',
    'limit=10x',
    'limit=NaN',
    // Number()-permissive spellings, deliberately outside the contract.
    'limit=%2B5',
    'limit=1e2',
    'limit=0x10',
    'cursor=%20not-a-cursor',
    // A typo in the KEY must be as loud as one in the value — this is the
    // request that would otherwise silently return the full registry.
    'limt=20',
    'Local=true',
  ])('rejects %s', (qs) => {
    const r = parse(qs);
    expect(r.ok).toBe(false);
  });

  it('round-trips a cursor produced by pagination under the same filters', () => {
    const rows = [row(), row({ agentUri: 'did:dkg:agent/2', name: 'beta' })];
    const page = paginateAgentRows(rows, { limit: 1 });
    expect(page.nextCursor).toBeDefined();
    const parsed = parse(`cursor=${page.nextCursor}`);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(typeof parsed.query.cursor).toBe('string');
      expect(paginateAgentRows(rows, parsed.query).rows).toHaveLength(1);
    }
  });

  it('rejects a cursor issued under different filters', () => {
    // Page 1 walked with a filter; page 2 requested without it. Continuing
    // would return a coherent-looking wrong continuation — must be a 400.
    const rows = [row(), row({ agentUri: 'did:dkg:agent/2', name: 'beta' })];
    const page = paginateAgentRows(rows, { limit: 1, connectionStatus: 'connected' });
    const withoutFilter = parse(`cursor=${page.nextCursor}`);
    expect(withoutFilter.ok).toBe(true);
    if (withoutFilter.ok) {
      expect(() => paginateAgentRows(rows, withoutFilter.query)).toThrow('different filter');
    }
    // Repeating the filter continues fine.
    const withFilter = parse(`connectionStatus=connected&cursor=${page.nextCursor}`);
    expect(withFilter.ok).toBe(true);
    if (withFilter.ok) expect(paginateAgentRows(rows, withFilter.query).rows).toHaveLength(1);
  });

  it('binds cursors to unambiguous normalized filter tuples', () => {
    // These pairs produced the same delimiter-joined string before the
    // fingerprint was derived from the typed filter model.
    const firstFilters = 'framework=x%26skill_type%3Dy&skill_type=z';
    const secondFilters = 'framework=x&skill_type=y%26skill_type%3Dz';
    const rows = [row(), row({ agentUri: 'did:dkg:agent/2', peerId: 'peer-2' })];
    const first = parse(`${firstFilters}&limit=1`);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const page = paginateAgentRows(rows, first.query);
    const crossFilter = parse(`${secondFilters}&cursor=${page.nextCursor}`);
    expect(crossFilter.ok).toBe(true);
    if (crossFilter.ok) {
      expect(() => paginateAgentRows(rows, crossFilter.query)).toThrow('different filter');
    }

    const reordered = parse(`skill_type=z&framework=x%26skill_type%3Dy&cursor=${page.nextCursor}`);
    expect(reordered.ok).toBe(true);
    if (reordered.ok) expect(() => paginateAgentRows(rows, reordered.query)).not.toThrow();
  });

  it('cursor size is bounded regardless of row content', () => {
    // Row fields are other agents' self-published literals. A row-embedding
    // cursor would let one hostile multi-KB profile push every client's
    // next-page URL past proxy header limits and wedge the walk at its row.
    const hostile = [
      row({ name: 'x'.repeat(50_000) }),
      row({ agentUri: 'did:dkg:agent/2', name: 'y'.repeat(50_000), peerId: 'peer-2' }),
    ];
    const page = paginateAgentRows(hostile, { limit: 1 });
    expect(page.nextCursor).toBeDefined();
    expect(page.nextCursor!.length).toBeLessThan(200);
  });
});

describe('paginateAgentRows (GH#310)', () => {
  const many = Array.from({ length: 7 }, (_, i) =>
    row({ agentUri: `did:dkg:agent/${i}`, name: `agent-${i}`, peerId: `peer-${i}` }));

  it('returns rows untouched, in original order, when neither limit nor cursor is given', () => {
    const shuffled = [many[3]!, many[0]!, many[5]!];
    const page = paginateAgentRows(shuffled, {});
    expect(page.rows).toEqual(shuffled);
    expect(page.nextCursor).toBeUndefined();
  });

  it('walks the whole set exactly once across pages', () => {
    const collected: unknown[] = [];
    let cursor: string | undefined;
    let guard = 0;
    do {
      const parsed = parseAgentsListQuery(
        new URLSearchParams(cursor ? `limit=3&cursor=${cursor}` : 'limit=3'),
      );
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      const page = paginateAgentRows(many, parsed.query);
      collected.push(...page.rows);
      cursor = page.nextCursor;
    } while (cursor && ++guard < 10);
    expect(collected).toHaveLength(many.length);
    expect(new Set(collected.map((r: any) => r.agentUri)).size).toBe(many.length);
  });

  it('profile mutations and new optional fields do not move identities between pages', () => {
    const collected: string[] = [];
    let cursor: string | undefined;
    let generation = 0;
    do {
      const current = many.map((agent, index) => ({
        ...agent,
        name: `${agent.name}-generation-${generation}`,
        lastSeen: `2026-08-28T00:00:0${(generation + index) % 10}Z`,
      }));
      const parsed = parseAgentsListQuery(
        new URLSearchParams(cursor ? `limit=2&cursor=${cursor}` : 'limit=2'),
      );
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      const page = paginateAgentRows(current, parsed.query);
      collected.push(...page.rows.map((agent) => agent.agentUri));
      cursor = page.nextCursor;
      generation++;
    } while (cursor && generation < 10);

    expect(collected).toHaveLength(many.length);
    expect(new Set(collected)).toEqual(new Set(many.map((agent) => agent.agentUri)));
  });

  it('resolves conflicting rows for one stable identity before pagination', () => {
    const conflict = row({ name: 'zeta', peerId: 'peer-conflict' });
    const page = paginateAgentRows([row(), conflict, many[2]!], { limit: 2 });
    expect(page.rows).toHaveLength(2);
    expect(new Set(page.rows.map((agent) => agent.agentUri)).size).toBe(2);
  });

  it('omits nextCursor on the final exactly-full page', () => {
    const page1 = paginateAgentRows(many.slice(0, 3), { limit: 3 });
    expect(page1.rows).toHaveLength(3);
    expect(page1.nextCursor).toBeUndefined();
  });

  it('a row deleted between requests cannot wedge or repeat the walk', () => {
    const first = paginateAgentRows(many, { limit: 3 });
    const deleted = first.rows[2]! as any;
    const remaining = many.filter((r) => r.agentUri !== deleted.agentUri);
    const parsed = parseAgentsListQuery(new URLSearchParams(`cursor=${first.nextCursor}`));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const second = paginateAgentRows(remaining, parsed.query);
    const firstUris = new Set(first.rows.map((r: any) => r.agentUri));
    for (const r of second.rows as any[]) expect(firstUris.has(r.agentUri)).toBe(false);
    expect(first.rows.length - 1 + second.rows.length).toBe(remaining.length);
  });
});

// ── Route level: the wiring is what GH#310 actually ships ────────────────────

function fakeRes() {
  const res: any = { statusCode: 0, body: '' };
  res.writeHead = (status: number) => { res.statusCode = status; };
  res.end = (body: string) => { res.body = body; };
  return res;
}

function fakeAgent(over: Partial<Record<string, unknown>> = {}) {
  const localAgentAddress = '0x1111111111111111111111111111111111111111';
  const registry = [
    {
      agentUri: `did:dkg:agent:${localAgentAddress}`,
      name: 'self-agent',
      peerId: 'peer-self',
      agentAddress: localAgentAddress,
    },
    {
      agentUri: 'did:dkg:agent/conn',
      name: 'conn-agent',
      peerId: 'peer-conn',
      agentAddress: '0x2222222222222222222222222222222222222222',
    },
    {
      agentUri: 'did:dkg:agent/gone',
      name: 'gone-agent',
      peerId: 'peer-gone',
      agentAddress: '0x3333333333333333333333333333333333333333',
    },
  ];
  return {
    peerId: 'peer-self',
    findAgents: async () => registry.map((r) => ({ ...r })),
    findSkills: async () => [],
    getDefaultAgentAddress: () => localAgentAddress,
    listLocalAgents: () => [{ agentAddress: localAgentAddress, name: 'self-agent' }],
    getPeerHealth: () => new Map([['peer-conn', { lastSeen: 123, latencyMs: 9 }]]),
    node: {
      libp2p: {
        getConnections: () => [
          {
            remotePeer: { toString: () => 'peer-conn' },
            remoteAddr: { toString: () => '/ip4/1.2.3.4/tcp/9000' },
            direction: 'outbound',
            timeline: { open: Date.now() - 5_000 },
          },
        ],
      },
    },
    ...over,
  };
}

async function getAgents(agent: any, qs = '') {
  const path = '/api/agents';
  const req: any = { method: 'GET', url: path + qs, headers: {} };
  const res = fakeRes();
  const url = new URL(`http://127.0.0.1${path}${qs}`);
  const ctx = {
    req,
    res,
    agent,
    path,
    url,
    validTokens: new Set<string>(),
    requestToken: undefined,
    requestAgentAddress: '',
  } as unknown as RequestContext;
  await handleAgentChatRoutes(ctx);
  return { status: res.statusCode, body: JSON.parse(res.body) };
}

describe('GET /api/agents (GH#310)', () => {
  it('parameterless response keeps its exact pre-#310 shape', async () => {
    const { status, body } = await getAgents(fakeAgent());
    expect(status).toBe(200);
    // The shape node-ui's fetchAgents() consumes: {agents} and nothing else.
    expect(Object.keys(body)).toEqual(['agents']);
    expect(body.agents).toHaveLength(3);
    const self = body.agents.find((a: any) => a.peerId === 'peer-self');
    expect(self.connectionStatus).toBe('self');
    const conn = body.agents.find((a: any) => a.peerId === 'peer-conn');
    expect(conn).toMatchObject({
      connectionStatus: 'connected',
      connectionTransport: 'direct',
      connectionDirection: 'outbound',
      lastSeen: 123,
      latencyMs: 9,
    });
    expect(body.agents.find((a: any) => a.peerId === 'peer-gone').connectionStatus)
      .toBe('disconnected');
  });

  it('local=true answers "what is my own agent" without the other 749', async () => {
    const { status, body } = await getAgents(fakeAgent(), '?local=true');
    expect(status).toBe(200);
    expect(body.agents).toHaveLength(1);
    expect(body.agents[0]).toMatchObject({ peerId: 'peer-self', connectionStatus: 'self' });
  });

  it('requires the canonical default profile and current peer binding for self', async () => {
    const localAddress = '0x1111111111111111111111111111111111111111';
    const secondaryLocalAddress = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const foreignAddress = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const registry = [
      {
        agentUri: `did:dkg:agent:${localAddress}`,
        name: 'local',
        peerId: 'peer-self',
        agentAddress: localAddress,
      },
      {
        agentUri: `did:dkg:agent:${secondaryLocalAddress}`,
        name: 'remote-reusing-local-wallet',
        peerId: 'peer-remote',
        agentAddress: secondaryLocalAddress,
      },
      {
        agentUri: 'did:dkg:agent/foreign',
        name: 'foreign-spoof',
        peerId: 'peer-self',
        agentAddress: foreignAddress,
      },
    ];
    const agent = fakeAgent({
      findAgents: async () => registry,
      // The second local identity is unpublished and must not be synthesized
      // into this registry-backed endpoint.
      listLocalAgents: () => [
        { agentAddress: localAddress, name: 'local' },
        { agentAddress: secondaryLocalAddress, name: 'secondary' },
      ],
    });

    for (const query of ['?local=true', '?connectionStatus=self']) {
      const { status, body } = await getAgents(agent, query);
      expect(status).toBe(200);
      expect(body.agents).toHaveLength(1);
      expect(body.agents[0]).toMatchObject({
        agentAddress: localAddress,
        peerId: 'peer-self',
        connectionStatus: 'self',
      });
    }
  });

  it('connectionStatus=connected returns only live peers', async () => {
    const { status, body } = await getAgents(fakeAgent(), '?connectionStatus=connected');
    expect(status).toBe(200);
    expect(body.agents.map((a: any) => a.peerId)).toEqual(['peer-conn']);
  });

  it('forwards framework and intersects skill offerings through the route', async () => {
    const findAgents = vi.fn(async () => [
      row({ agentUri: 'did:dkg:agent/oc-image', peerId: 'peer-image' }),
      row({ agentUri: 'did:dkg:agent/oc-text', peerId: 'peer-text' }),
    ]);
    const findSkills = vi.fn(async () => [{
      agentUri: 'did:dkg:agent/oc-image',
      agentName: 'image',
      offeringUri: 'did:dkg:offering/image',
      skillType: 'ImageAnalysis',
    }]);
    const { status, body } = await getAgents(
      fakeAgent({ findAgents, findSkills }),
      '?framework=OpenClaw&skill_type=ImageAnalysis',
    );

    expect(status).toBe(200);
    expect(findAgents).toHaveBeenCalledWith({ framework: 'OpenClaw' });
    expect(findSkills).toHaveBeenCalledWith({ skillType: 'ImageAnalysis' });
    expect(body.agents.map((agent: any) => agent.agentUri)).toEqual([
      'did:dkg:agent/oc-image',
    ]);
  });

  it('pages the registry with limit/cursor and terminates', async () => {
    const seen: string[] = [];
    let qs = '?limit=2';
    let guard = 0;
    for (;;) {
      const { status, body } = await getAgents(fakeAgent(), qs);
      expect(status).toBe(200);
      seen.push(...body.agents.map((a: any) => a.peerId));
      if (body.nextCursor === undefined) break;
      qs = `?limit=2&cursor=${body.nextCursor}`;
      expect(++guard).toBeLessThan(10);
    }
    expect(seen.sort()).toEqual(['peer-conn', 'peer-gone', 'peer-self']);
  });

  it('rejects a cursor when route filters change between pages', async () => {
    const first = await getAgents(fakeAgent(), '?local=false&limit=1');
    expect(first.status).toBe(200);
    expect(first.body.nextCursor).toBeDefined();

    const second = await getAgents(fakeAgent(), `?cursor=${first.body.nextCursor}`);
    expect(second.status).toBe(400);
    expect(second.body.error).toContain('different filter');
  });

  it('rejects a bad parameter instead of silently returning the registry', async () => {
    const { status, body } = await getAgents(fakeAgent(), '?local=ture');
    expect(status).toBe(400);
    expect(body.error).toContain('"local"');
  });
});
