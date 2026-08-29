import { describe, expect, it } from 'vitest';
import { DkgNodePlugin } from '../src/DkgNodePlugin.js';
import type { OpenClawPluginApi, OpenClawTool } from '../src/types.js';

// GH#310 — dkg_find_agents against the daemon's strict agents-list contract.
// The daemon 400s on bad values AND unknown parameter names, so the tool has
// exactly two jobs: ADVERTISE the filters (a model cannot use what is not
// advertised) and FORWARD values verbatim so the daemon's 400 — not a
// silently different query — is what a bad value produces.

function registeredFindAgents(plugin: DkgNodePlugin): OpenClawTool {
  const tools: OpenClawTool[] = [];
  const mockApi: OpenClawPluginApi = {
    config: {},
    registerTool: (tool) => tools.push(tool),
    registerHook: () => {},
    on: () => {},
    logger: {},
  };
  plugin.register(mockApi);
  const tool = tools.find((t) => t.name === 'dkg_find_agents');
  if (!tool) throw new Error('dkg_find_agents not registered');
  return tool;
}

describe('dkg_find_agents tool', () => {
  it('advertises the GH#310 filters, with limit constrained as the daemon constrains it', () => {
    const tool = registeredFindAgents(new DkgNodePlugin());
    const props = tool.parameters.properties as Record<string, any>;
    for (const key of ['framework', 'skill_type', 'connection_status', 'local', 'limit', 'cursor']) {
      expect(Object.keys(props)).toContain(key);
    }
    // The machine-readable contract must match the daemon contract — an
    // unrestricted `number` admits 0 and 1.9, both guaranteed daemon 400s.
    expect(props.limit.type).toBe('integer');
    expect(props.limit.minimum).toBe(1);
    expect(props.connection_status.enum).toEqual(['self', 'connected', 'disconnected']);
  });

  it('serializes well-formed and malformed values verbatim onto the wire', async () => {
    const plugin = new DkgNodePlugin();
    const tool = registeredFindAgents(plugin);
    const queries: string[] = [];
    // Raw model values travel through the query escape hatch — the strictly
    // typed getAgents() never sees them.
    (plugin as any).client = {
      getAgentsByQuery: async (qs: string) => { queries.push(qs); return { agents: [] }; },
    };

    await tool.execute('tc-1', {
      connection_status: 'connected',
      local: 'true',
      limit: '10',
      cursor: 'cur-1',
    });
    expect(queries[0]).toContain('connectionStatus=connected');
    expect(queries[0]).toContain('local=true');
    expect(queries[0]).toContain('limit=10');
    expect(queries[0]).toContain('cursor=cur-1');

    // Malformed model output (calls can bypass schema validation) must REACH
    // the daemon's 400 — the documented filter-drop risk: limit 0 silently
    // becoming "no limit" is the full ~150 KB registry.
    for (const [bad, wire] of [
      ['not-a-number', 'limit=not-a-number'],
      ['10junk', 'limit=10junk'],
      [0, 'limit=0'],
      [1.9, 'limit=1.9'],
      [-5, 'limit=-5'],
    ] as const) {
      queries.length = 0;
      await tool.execute('tc-bad', { limit: bad });
      expect(queries[0], `limit=${bad} must be forwarded, not dropped`).toBe(wire);
    }
    queries.length = 0;
    await tool.execute('tc-bad-status', { connection_status: 'onnected', local: 'ture' });
    expect(queries[0]).toContain('connectionStatus=onnected');
    expect(queries[0]).toContain('local=ture');
  });

  it("surfaces the daemon's validation error as the tool result", async () => {
    // Forwarding verbatim makes the daemon's 400 the caller's ONLY signal —
    // so the handler must relay it, not swallow it into an empty success.
    const plugin = new DkgNodePlugin();
    const tool = registeredFindAgents(plugin);
    (plugin as any).client = {
      getAgentsByQuery: async () => {
        throw new Error('DKG daemon /api/agents responded 400: "limit" must be a positive integer');
      },
    };
    const result = await tool.execute('tc-err', { limit: '10junk' });
    const text = (result as any).content?.map((c: any) => c.text).join(' ') ?? '';
    // The message arrives JSON-encoded inside the tool result; assert the
    // substance (status + reason), not the quoting.
    expect(text).toContain('responded 400');
    expect(text).toContain('must be a positive integer');
  });
});
