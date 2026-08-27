import { describe, expect, it } from 'vitest';
import {
  canonicalRowKey,
  dedupeExactRows,
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
  /** The fingerprint parse derives for a given filter set. */
  const fpOf = (qs: string) => {
    const r = parse(qs);
    if (!r.ok) throw new Error(r.error);
    return r.query.filterFingerprint;
  };

  it('accepts an empty query', () => {
    const r = parse('');
    expect(r.ok).toBe(true);
    if (r.ok) {
      const { filterFingerprint, ...rest } = r.query;
      expect(rest).toEqual({});
      expect(filterFingerprint).toMatch(/^[0-9a-f]{16}$/);
    }
  });

  it('accepts each documented value', () => {
    const q = (qs: string) => {
      const r = parse(qs);
      expect(r.ok).toBe(true);
      if (!r.ok) throw new Error(r.error);
      const { filterFingerprint, ...rest } = r.query;
      return rest;
    };
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
    const page = paginateAgentRows(rows, { limit: 1, filterFingerprint: fpOf('limit=1') });
    expect(page.nextCursor).toBeDefined();
    const parsed = parse(`cursor=${page.nextCursor}`);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(typeof parsed.query.cursor).toBe('string');
  });

  it('rejects a cursor issued under different filters', () => {
    // Page 1 walked with a filter; page 2 requested without it. Continuing
    // would return a coherent-looking wrong continuation — must be a 400.
    const rows = [row(), row({ agentUri: 'did:dkg:agent/2', name: 'beta' })];
    const page = paginateAgentRows(rows, {
      limit: 1,
      filterFingerprint: fpOf('connectionStatus=connected&limit=1'),
    });
    const withoutFilter = parse(`cursor=${page.nextCursor}`);
    expect(withoutFilter.ok).toBe(false);
    if (!withoutFilter.ok) expect(withoutFilter.error).toContain('different filter');
    // Repeating the filter continues fine.
    const withFilter = parse(`connectionStatus=connected&cursor=${page.nextCursor}`);
    expect(withFilter.ok).toBe(true);
  });

  it('cursor size is bounded regardless of row content', () => {
    // Row fields are other agents' self-published literals. A row-embedding
    // cursor would let one hostile multi-KB profile push every client's
    // next-page URL past proxy header limits and wedge the walk at its row.
    const hostile = [
      row({ name: 'x'.repeat(50_000) }),
      row({ agentUri: 'did:dkg:agent/2', name: 'y'.repeat(50_000), peerId: 'peer-2' }),
    ];
    const page = paginateAgentRows(hostile, { limit: 1, filterFingerprint: fpOf('limit=1') });
    expect(page.nextCursor).toBeDefined();
    expect(page.nextCursor!.length).toBeLessThan(200);
  });
});

describe('dedupeExactRows (GH#310)', () => {
  it('removes only rows identical in every field, keeping first-occurrence order', () => {
    const a = row();
    const rows = [
      a,
      // Same agent re-registered from a NEW peer — a real registry fact that
      // node-ui's peer grouping depends on. Must survive.
      row({ peerId: 'peer-2' }),
      // Pure SPARQL OPTIONAL-multiplication artifact. Must go.
      { ...a },
      // Same fields, different property insertion order — still the same row.
      { framework: 'eliza', peerId: 'peer-1', name: 'alpha', agentUri: 'did:dkg:agent/1' },
    ];
    const out = dedupeExactRows(rows);
    expect(out).toEqual([a, row({ peerId: 'peer-2' })]);
  });

  it('treats an absent field and an undefined field as the same row', () => {
    // findAgents() builds rows with conditional spreads, so the same agent can
    // surface as {framework: undefined} in one row and no key at all in
    // another. JSON over the wire cannot tell them apart; neither may dedupe.
    const withUndef = { agentUri: 'u', name: 'n', peerId: 'p', framework: undefined };
    const without = { agentUri: 'u', name: 'n', peerId: 'p' };
    expect(canonicalRowKey(withUndef)).toBe(canonicalRowKey(without));
    expect(dedupeExactRows([withUndef, without])).toHaveLength(1);
  });
});

describe('paginateAgentRows (GH#310)', () => {
  const many = Array.from({ length: 7 }, (_, i) =>
    row({ agentUri: `did:dkg:agent/${i}`, name: `agent-${i}`, peerId: `peer-${i}` }));

  const FP = (() => {
    const r = parseAgentsListQuery(new URLSearchParams(''));
    if (!r.ok) throw new Error(r.error);
    return r.query.filterFingerprint;
  })();

  it('returns rows untouched, in original order, when neither limit nor cursor is given', () => {
    const shuffled = [many[3]!, many[0]!, many[5]!];
    const page = paginateAgentRows(shuffled, { filterFingerprint: FP });
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

  it('omits nextCursor on the final exactly-full page', () => {
    const page1 = paginateAgentRows(many.slice(0, 3), { limit: 3, filterFingerprint: FP });
    expect(page1.rows).toHaveLength(3);
    expect(page1.nextCursor).toBeUndefined();
  });

  it('a row deleted between requests cannot wedge or repeat the walk', () => {
    const first = paginateAgentRows(many, { limit: 3, filterFingerprint: FP });
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
  const registry = [
    // 'self-agent' duplicated: OPTIONAL multiplication as findAgents really
    // produces it — identical rows, same reference shape.
    { agentUri: 'did:dkg:agent/self', name: 'self-agent', peerId: 'peer-self' },
    { agentUri: 'did:dkg:agent/self', name: 'self-agent', peerId: 'peer-self' },
    { agentUri: 'did:dkg:agent/conn', name: 'conn-agent', peerId: 'peer-conn' },
    { agentUri: 'did:dkg:agent/gone', name: 'gone-agent', peerId: 'peer-gone' },
  ];
  return {
    peerId: 'peer-self',
    findAgents: async () => registry.map((r) => ({ ...r })),
    findSkills: async () => [],
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
  it('parameterless response keeps its exact pre-#310 shape, minus duplicate rows', async () => {
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

  it('connectionStatus=connected returns only live peers', async () => {
    const { status, body } = await getAgents(fakeAgent(), '?connectionStatus=connected');
    expect(status).toBe(200);
    expect(body.agents.map((a: any) => a.peerId)).toEqual(['peer-conn']);
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

  it('rejects a bad parameter instead of silently returning the registry', async () => {
    const { status, body } = await getAgents(fakeAgent(), '?local=ture');
    expect(status).toBe(400);
    expect(body.error).toContain('"local"');
  });
});
