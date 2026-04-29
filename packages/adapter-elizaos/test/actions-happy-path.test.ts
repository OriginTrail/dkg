/**
 * Happy-path coverage for the five DKG_* action handlers.
 *
 * These handlers all call service.requireAgent(), which reads a
 * module-private singleton that is only set by dkgService.initialize()
 * (which in turn boots a full DKGAgent — libp2p + chain + storage).
 * Spinning up a real DKGAgent per test would be multi-second-per-test
 * overhead that is redundantly covered by the downstream integration
 * suites in `@origintrail-official/dkg-agent`.
 *
 * Instead we swap the `./service.js` module at import time with a
 * lightweight stand-in that returns a capturing fake DKGAgent. This
 * exercises every argument-parsing branch and callback path in
 * actions.ts without the heavy dependency graph.
 *
 * Note: this is NOT a blockchain mock — the DKGAgent surface we drive
 * is entirely local-process message routing and SPARQL. The test
 * doesn't bypass any on-chain verification; it just decouples the
 * action-handler wiring from the singleton bootstrap.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

interface PublishCall { cgId: string; quads: any[] }
interface QueryCall { sparql: string }
interface SendChatCall { peerId: string; text: string }
interface InvokeSkillCall { peerId: string; skillUri: string; input: Uint8Array }
interface AssertionWriteCall { cgId: string; name: string; quads: any[] }
interface EnsureCGCall { id: string; name: string; curated?: boolean }

const state = {
  publishes: [] as PublishCall[],
  queries: [] as QueryCall[],
  sendChats: [] as SendChatCall[],
  invokes: [] as InvokeSkillCall[],
  assertionWrites: [] as AssertionWriteCall[],
  ensureCGs: [] as EnsureCGCall[],
  findSkillsResult: [] as any[],
  findAgentsResult: [] as any[],
  queryResult: { bindings: [] as any[] },
  publishResult: { kcId: 1n, kaManifest: [] as any[] },
  sendChatResult: { delivered: true, error: undefined as string | undefined },
  invokeResult: {
    success: true,
    outputData: new TextEncoder().encode('pong'),
    error: undefined as string | undefined,
  },
  // let individual tests opt in to having
  // assertion.write throw, mirroring the old publish-error path.
  assertionWriteError: null as Error | null,
};

function fakeAgent() {
  return {
    publish: async (cgId: string, quads: any[]) => {
      state.publishes.push({ cgId, quads });
      return state.publishResult;
    },
    query: async (sparql: string) => {
      state.queries.push({ sparql });
      return state.queryResult;
    },
    findSkills: async (_filter: any) => state.findSkillsResult,
    findAgents: async (_filter: any) => state.findAgentsResult,
    sendChat: async (peerId: string, text: string) => {
      state.sendChats.push({ peerId, text });
      return state.sendChatResult;
    },
    invokeSkill: async (peerId: string, skillUri: string, input: Uint8Array) => {
      state.invokes.push({ peerId, skillUri, input });
      return state.invokeResult;
    },
    // chat-turn persistence routes through the
    // WM assertion surface, not publish().
    assertion: {
      write: async (cgId: string, name: string, quads: any[]) => {
        if (state.assertionWriteError) throw state.assertionWriteError;
        state.assertionWrites.push({ cgId, name, quads });
      },
    },
    ensureContextGraphLocal: async (opts: { id: string; name: string; curated?: boolean }) => {
      state.ensureCGs.push({ id: opts.id, name: opts.name, curated: opts.curated });
    },
  };
}

vi.mock('../src/service.js', () => ({
  requireAgent: () => fakeAgent(),
  getAgent: () => fakeAgent(),
  dkgService: { name: 'dkg-node' },
}));

// Imports must come AFTER vi.mock so the stub applies.
const {
  dkgPublish,
  dkgQuery,
  dkgFindAgents,
  dkgSendMessage,
  dkgInvokeSkill,
  dkgPersistChatTurn,
} = await import('../src/actions.js');
const { dkgKnowledgeProvider } = await import('../src/provider.js');

import type { IAgentRuntime, Memory, State, HandlerCallback } from '../src/types.js';

function makeRuntime(settings: Record<string, string> = {}): IAgentRuntime {
  return {
    getSetting: (k: string) => settings[k],
    character: { name: 'TestBot' },
  } as unknown as IAgentRuntime;
}

function makeMessage(text: string, overrides: Partial<any> = {}): Memory {
  return {
    content: { text },
    id: overrides.id ?? 'm-1',
    userId: overrides.userId ?? 'user-1',
    roomId: overrides.roomId ?? 'room-1',
    ...overrides,
  } as unknown as Memory;
}

function captureCb() {
  const calls: Array<{ text: string }> = [];
  const cb: HandlerCallback = ((r: { text: string }) => {
    calls.push(r);
    return Promise.resolve([] as Memory[]);
  }) as unknown as HandlerCallback;
  return { calls, cb };
}

beforeEach(() => {
  state.publishes.length = 0;
  state.queries.length = 0;
  state.sendChats.length = 0;
  state.invokes.length = 0;
  state.assertionWrites.length = 0;
  state.ensureCGs.length = 0;
  state.findSkillsResult = [];
  state.findAgentsResult = [];
  state.queryResult = { bindings: [] };
  state.publishResult = { kcId: 1n, kaManifest: [] };
  state.sendChatResult = { delivered: true, error: undefined };
  state.invokeResult = {
    success: true,
    outputData: new TextEncoder().encode('pong'),
    error: undefined,
  };
  state.assertionWriteError = null;
});

// ───────────────────────────────────────────────────────────────────────────
// DKG_PUBLISH
// ───────────────────────────────────────────────────────────────────────────
describe('DKG_PUBLISH handler', () => {
  it('returns false when no code block is present', async () => {
    const { calls, cb } = captureCb();
    const ok = await dkgPublish.handler(
      makeRuntime(), makeMessage('publish something'), {} as State, {}, cb,
    );
    expect(ok).toBe(false);
    expect(calls[0].text).toMatch(/code block/i);
  });

  it('returns false when the code block has no parseable triples', async () => {
    const { calls, cb } = captureCb();
    const ok = await dkgPublish.handler(
      makeRuntime(),
      makeMessage('publish:\n```nquads\njust text nothing valid\n```'),
      {} as State, {}, cb,
    );
    expect(ok).toBe(false);
    expect(calls[0].text).toMatch(/no valid triples/i);
  });

  it('publishes parsed triples to the default context graph', async () => {
    const { calls, cb } = captureCb();
    const ok = await dkgPublish.handler(
      makeRuntime(),
      makeMessage([
        'publish:',
        '```nquads',
        '<http://ex.org/alice> <http://schema.org/name> "Alice" .',
        '<http://ex.org/bob> <http://schema.org/name> "Bob" .',
        '```',
      ].join('\n')),
      {} as State, {}, cb,
    );
    expect(ok).toBe(true);
    expect(state.publishes).toHaveLength(1);
    expect(state.publishes[0].cgId).toBe('default');
    expect(state.publishes[0].quads).toHaveLength(2);
    expect(calls[0].text).toMatch(/Published 2 triple\(s\) to context graph "default"/);
  });

  it('extracts an explicit "context-graph:" target from the message', async () => {
    const { cb } = captureCb();
    await dkgPublish.handler(
      makeRuntime(),
      makeMessage([
        'publish to context-graph: my-cg',
        '```',
        '<http://ex.org/x> <http://ex.org/p> "v" .',
        '```',
      ].join('\n')),
      {} as State, {}, cb,
    );
    expect(state.publishes[0].cgId).toBe('my-cg');
  });

  it('falls back to the "paranet:" V9 alias when context-graph is absent', async () => {
    const { cb } = captureCb();
    await dkgPublish.handler(
      makeRuntime(),
      makeMessage([
        'publish to paranet: legacy-cg',
        '```',
        '<http://ex.org/x> <http://ex.org/p> "v" .',
        '```',
      ].join('\n')),
      {} as State, {}, cb,
    );
    expect(state.publishes[0].cgId).toBe('legacy-cg');
  });

  it('parses IRI objects (not just string literals)', async () => {
    const { cb } = captureCb();
    await dkgPublish.handler(
      makeRuntime(),
      makeMessage([
        '```nquads',
        '<http://ex.org/a> <http://ex.org/p> <http://ex.org/b> .',
        '```',
      ].join('\n')),
      {} as State, {}, cb,
    );
    expect(state.publishes[0].quads[0].object).toBe('http://ex.org/b');
  });

  it('routes publish() errors through the callback and returns false', async () => {
    state.publishResult = null as any;
    const { calls, cb } = captureCb();
    // Force an error from the fake: swap publishes to throw for this call.
    const origPublishes = state.publishes;
    const throwingAgent = {
      publish: async () => { throw new Error('chain busy'); },
    };
    // Patch the module's requireAgent to temporarily return the throwing agent.
    const svc = await import('../src/service.js');
    const spy = vi.spyOn(svc, 'requireAgent').mockReturnValue(throwingAgent as any);
    try {
      const ok = await dkgPublish.handler(
        makeRuntime(),
        makeMessage('```nquads\n<http://ex.org/a> <http://ex.org/b> "c" .\n```'),
        {} as State, {}, cb,
      );
      expect(ok).toBe(false);
      expect(calls[0].text).toMatch(/DKG publish failed: chain busy/);
    } finally {
      spy.mockRestore();
      state.publishes = origPublishes;
    }
  });

  it('validate() returns true (never gates)', async () => {
    const ok = await dkgPublish.validate!(makeRuntime(), makeMessage('x'));
    expect(ok).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// DKG_QUERY
// ───────────────────────────────────────────────────────────────────────────
describe('DKG_QUERY handler', () => {
  it('returns false when no SPARQL is detected', async () => {
    const { calls, cb } = captureCb();
    const ok = await dkgQuery.handler(
      makeRuntime(), makeMessage('find me something'), {} as State, {}, cb,
    );
    expect(ok).toBe(false);
    expect(calls[0].text).toMatch(/SPARQL query/i);
  });

  it('executes a SPARQL query from a fenced code block and formats rows', async () => {
    state.queryResult = {
      bindings: [
        { s: 'http://ex/a', p: 'http://ex/p', o: '"v"' },
        { s: 'http://ex/b', p: 'http://ex/p', o: '"w"' },
      ],
    };
    const { calls, cb } = captureCb();
    const ok = await dkgQuery.handler(
      makeRuntime(),
      makeMessage('```sparql\nSELECT ?s ?p ?o WHERE { ?s ?p ?o } LIMIT 10\n```'),
      {} as State, {}, cb,
    );
    expect(ok).toBe(true);
    expect(state.queries[0].sparql).toContain('SELECT');
    expect(calls[0].text).toMatch(/Query returned 2 result\(s\)/);
    expect(calls[0].text).toContain('s: http://ex/a');
  });

  it('reports "no results" when bindings is empty', async () => {
    const { calls, cb } = captureCb();
    const ok = await dkgQuery.handler(
      makeRuntime(),
      makeMessage('```sparql\nSELECT ?s WHERE { ?s ?p ?o }\n```'),
      {} as State, {}, cb,
    );
    expect(ok).toBe(true);
    expect(calls[0].text).toMatch(/no results/i);
  });

  it('accepts an inline SELECT without a fence', async () => {
    state.queryResult = { bindings: [{ s: 'http://ex/a', p: 'http://ex/p', o: '"v"' }] };
    const { cb } = captureCb();
    const ok = await dkgQuery.handler(
      makeRuntime(),
      makeMessage('run this: SELECT ?s ?p ?o WHERE { ?s ?p ?o }'),
      {} as State, {}, cb,
    );
    expect(ok).toBe(true);
    expect(state.queries[0].sparql).toMatch(/^SELECT/);
  });

  it('truncates output past 20 rows', async () => {
    state.queryResult = {
      bindings: Array.from({ length: 25 }, (_, i) => ({ s: `http://ex/${i}`, o: `"v${i}"` })),
    };
    const { calls, cb } = captureCb();
    await dkgQuery.handler(
      makeRuntime(),
      makeMessage('```\nSELECT * WHERE { ?s ?p ?o }\n```'),
      {} as State, {}, cb,
    );
    expect(calls[0].text).toMatch(/Query returned 25 result/);
    expect(calls[0].text).toMatch(/truncated/);
  });

  it('routes query() errors through the callback', async () => {
    const svc = await import('../src/service.js');
    const spy = vi.spyOn(svc, 'requireAgent').mockReturnValue({
      query: async () => { throw new Error('store down'); },
    } as any);
    try {
      const { calls, cb } = captureCb();
      const ok = await dkgQuery.handler(
        makeRuntime(),
        makeMessage('```sparql\nSELECT ?s WHERE { ?s ?p ?o }\n```'),
        {} as State, {}, cb,
      );
      expect(ok).toBe(false);
      expect(calls[0].text).toMatch(/DKG query failed: store down/);
    } finally {
      spy.mockRestore();
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// DKG_FIND_AGENTS
// ───────────────────────────────────────────────────────────────────────────
describe('DKG_FIND_AGENTS handler', () => {
  it('reports no matches when findSkills returns an empty list', async () => {
    const { calls, cb } = captureCb();
    const ok = await dkgFindAgents.handler(
      makeRuntime(),
      makeMessage('find agents with skill: ImageAnalysis'),
      {} as State, {}, cb,
    );
    expect(ok).toBe(true);
    expect(calls[0].text).toMatch(/No agents found offering skill "ImageAnalysis"/i);
  });

  it('formats skill offerings when findSkills returns matches', async () => {
    state.findSkillsResult = [
      { agentName: 'Alpha', skillType: 'ImageAnalysis', pricePerCall: 5, currency: 'TRAC' },
      { agentName: 'Beta', skillType: 'ImageAnalysis' },
    ];
    const { calls, cb } = captureCb();
    await dkgFindAgents.handler(
      makeRuntime(),
      makeMessage('skill: ImageAnalysis'),
      {} as State, {}, cb,
    );
    expect(calls[0].text).toMatch(/Found 2 agent/);
    expect(calls[0].text).toContain('Alpha');
    expect(calls[0].text).toContain('Beta');
    expect(calls[0].text).toContain('5 TRAC');
    expect(calls[0].text).toContain('0 TRAC');
  });

  it('falls back to framework filter when no skill matcher is present', async () => {
    state.findAgentsResult = [
      { name: 'Gamma', peerId: '12D3KooWabcdefghijkl', framework: 'ElizaOS' },
    ];
    const { calls, cb } = captureCb();
    await dkgFindAgents.handler(
      makeRuntime(),
      makeMessage('find agents with framework: ElizaOS'),
      {} as State, {}, cb,
    );
    expect(calls[0].text).toMatch(/Found 1 agent/);
    expect(calls[0].text).toContain('Gamma');
  });

  it('lists all agents when neither skill nor framework filter is provided', async () => {
    state.findAgentsResult = [];
    const { calls, cb } = captureCb();
    await dkgFindAgents.handler(
      makeRuntime(),
      makeMessage('list all agents'),
      {} as State, {}, cb,
    );
    expect(calls[0].text).toMatch(/No agents found on the network/i);
  });

  it('routes findSkills errors through the callback', async () => {
    const svc = await import('../src/service.js');
    const spy = vi.spyOn(svc, 'requireAgent').mockReturnValue({
      findSkills: async () => { throw new Error('dht timeout'); },
      findAgents: async () => [],
    } as any);
    try {
      const { calls, cb } = captureCb();
      const ok = await dkgFindAgents.handler(
        makeRuntime(),
        makeMessage('skill: X'),
        {} as State, {}, cb,
      );
      expect(ok).toBe(false);
      expect(calls[0].text).toMatch(/Agent discovery failed: dht timeout/);
    } finally {
      spy.mockRestore();
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// DKG_SEND_MESSAGE
// ───────────────────────────────────────────────────────────────────────────
describe('DKG_SEND_MESSAGE handler', () => {
  it('returns false when no peer is specified', async () => {
    const { calls, cb } = captureCb();
    const ok = await dkgSendMessage.handler(
      makeRuntime(),
      makeMessage('say hi to nobody'),
      {} as State, {}, cb,
    );
    expect(ok).toBe(false);
    expect(calls[0].text).toMatch(/peer ID/i);
  });

  it('extracts peer + quoted message body and reports delivery', async () => {
    const { calls, cb } = captureCb();
    const ok = await dkgSendMessage.handler(
      makeRuntime(),
      makeMessage('peer: 12D3KooWabc message: "hello there"'),
      {} as State, {}, cb,
    );
    expect(ok).toBe(true);
    expect(state.sendChats[0].peerId).toBe('12D3KooWabc');
    expect(state.sendChats[0].text).toBe('hello there');
    expect(calls[0].text).toMatch(/Message delivered to 12D3KooWabc/);
  });

  it('accepts the "say:" alias for the message body', async () => {
    const { cb } = captureCb();
    await dkgSendMessage.handler(
      makeRuntime(),
      makeMessage('peer: 12D3KooWabc say: "hey"'),
      {} as State, {}, cb,
    );
    expect(state.sendChats[0].text).toBe('hey');
  });

  it('falls back to the text after the peer clause when no quoted body', async () => {
    const { cb } = captureCb();
    await dkgSendMessage.handler(
      makeRuntime(),
      makeMessage('peer: 12D3KooWabc hello friend'),
      {} as State, {}, cb,
    );
    expect(state.sendChats[0].text).toBe('hello friend');
  });

  it('reports a delivery failure when sendChat returns delivered=false', async () => {
    state.sendChatResult = { delivered: false, error: 'dial failed' };
    const { calls, cb } = captureCb();
    const ok = await dkgSendMessage.handler(
      makeRuntime(),
      makeMessage('peer: 12D3KooWabc message: "x"'),
      {} as State, {}, cb,
    );
    expect(ok).toBe(true); // handler itself succeeded
    expect(calls[0].text).toMatch(/Message delivery failed: dial failed/);
  });

  it('reports unknown-error when delivered=false and error is missing', async () => {
    state.sendChatResult = { delivered: false, error: undefined };
    const { calls, cb } = captureCb();
    await dkgSendMessage.handler(
      makeRuntime(),
      makeMessage('peer: 12D3KooWabc message: "x"'),
      {} as State, {}, cb,
    );
    expect(calls[0].text).toMatch(/unknown error/i);
  });

  it('routes sendChat errors through the callback', async () => {
    const svc = await import('../src/service.js');
    const spy = vi.spyOn(svc, 'requireAgent').mockReturnValue({
      sendChat: async () => { throw new Error('no route'); },
    } as any);
    try {
      const { calls, cb } = captureCb();
      const ok = await dkgSendMessage.handler(
        makeRuntime(),
        makeMessage('peer: 12D3KooWabc message: "x"'),
        {} as State, {}, cb,
      );
      expect(ok).toBe(false);
      expect(calls[0].text).toMatch(/Message send failed: no route/);
    } finally {
      spy.mockRestore();
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// DKG_INVOKE_SKILL
// ───────────────────────────────────────────────────────────────────────────
describe('DKG_INVOKE_SKILL handler', () => {
  it('returns false when peer or skill is missing', async () => {
    const { calls, cb } = captureCb();
    const ok = await dkgInvokeSkill.handler(
      makeRuntime(), makeMessage('invoke something'), {} as State, {}, cb,
    );
    expect(ok).toBe(false);
    expect(calls[0].text).toMatch(/peer ID and skill URI/i);
  });

  it('invokes the skill with the extracted peer, skill, and quoted input', async () => {
    const { calls, cb } = captureCb();
    const ok = await dkgInvokeSkill.handler(
      makeRuntime(),
      makeMessage('peer: 12D3KooWabc skill: ImageAnalysis input: "analyze"'),
      {} as State, {}, cb,
    );
    expect(ok).toBe(true);
    expect(state.invokes[0].peerId).toBe('12D3KooWabc');
    expect(state.invokes[0].skillUri).toBe('ImageAnalysis');
    expect(new TextDecoder().decode(state.invokes[0].input)).toBe('analyze');
    expect(calls[0].text).toMatch(/Skill response: pong/);
  });

  it('accepts a fenced code block as the input', async () => {
    const { cb } = captureCb();
    await dkgInvokeSkill.handler(
      makeRuntime(),
      makeMessage('peer: p1 skill: s1\n```\n{"k":"v"}\n```'),
      {} as State, {}, cb,
    );
    expect(new TextDecoder().decode(state.invokes[0].input).trim()).toBe('{"k":"v"}');
  });

  it('reports failure when invokeSkill returns success=false', async () => {
    state.invokeResult = { success: false, outputData: undefined as any, error: 'timed out' };
    const { calls, cb } = captureCb();
    const ok = await dkgInvokeSkill.handler(
      makeRuntime(),
      makeMessage('peer: p1 skill: s1 input: "x"'),
      {} as State, {}, cb,
    );
    expect(ok).toBe(true);
    expect(calls[0].text).toMatch(/failed: timed out/);
  });

  it('reports "ok: no output" when success=true but no outputData', async () => {
    state.invokeResult = { success: true, outputData: undefined as any, error: undefined };
    const { calls, cb } = captureCb();
    await dkgInvokeSkill.handler(
      makeRuntime(),
      makeMessage('peer: p1 skill: s1 input: "x"'),
      {} as State, {}, cb,
    );
    expect(calls[0].text).toMatch(/ok.*no output/);
  });

  it('routes invokeSkill errors through the callback', async () => {
    const svc = await import('../src/service.js');
    const spy = vi.spyOn(svc, 'requireAgent').mockReturnValue({
      invokeSkill: async () => { throw new Error('rpc dead'); },
    } as any);
    try {
      const { calls, cb } = captureCb();
      const ok = await dkgInvokeSkill.handler(
        makeRuntime(),
        makeMessage('peer: p1 skill: s1 input: "x"'),
        {} as State, {}, cb,
      );
      expect(ok).toBe(false);
      expect(calls[0].text).toMatch(/Skill invocation failed: rpc dead/);
    } finally {
      spy.mockRestore();
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// DKG_PERSIST_CHAT_TURN — happy path via the stubbed agent
// ───────────────────────────────────────────────────────────────────────────
describe('DKG_PERSIST_CHAT_TURN handler', () => {
  it('writes the turn quads via agent.assertion.write using the canonical schema:Conversation/Message shape', async () => {
    const { calls, cb } = captureCb();
    const ok = await dkgPersistChatTurn.handler(
      makeRuntime({ DKG_CHAT_CG: 'chat-room' }),
      makeMessage('hello friend', { id: 'm-99', roomId: 'r-a' } as any),
      {} as State,
      { assistantText: 'hi human' },
      cb,
    );
    expect(ok).toBe(true);
    // A1/A3: turns go to WM (assertion.write), NOT to publish().
    expect(state.publishes).toHaveLength(0);
    expect(state.assertionWrites).toHaveLength(1);
    expect(state.assertionWrites[0].cgId).toBe('chat-room');
    expect(state.assertionWrites[0].name).toBe('chat-turns');
    // 2nd-pass A4 (canonical RDF shape): user-turn with assistantText emits
    // session entity (2) + user msg (5) + assistant msg (6) + turn envelope
    // (5 + hasAssistantMessage + 3 eliza-provenance) = 22 quads.
    const quads = state.assertionWrites[0].quads;
    expect(quads.length).toBeGreaterThanOrEqual(20);
    // Critical canonical-shape assertions (ChatMemoryManager-readable):
    expect(quads.some((q: any) =>
      q.predicate === 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type'
      && q.object === 'http://schema.org/Conversation',
    )).toBe(true);
    expect(quads.some((q: any) =>
      q.predicate === 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type'
      && q.object === 'http://schema.org/Message',
    )).toBe(true);
    expect(quads.some((q: any) =>
      q.predicate === 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type'
      && q.object === 'http://dkg.io/ontology/ChatTurn',
    )).toBe(true);
    // A2: ensureContextGraphLocal is called first with the same cg id.
    expect(state.ensureCGs).toHaveLength(1);
    expect(state.ensureCGs[0].id).toBe('chat-room');
    expect(calls[0].text).toMatch(/Chat turn persisted \(\d+ triples\)/);
  });

  it('routes assertion.write errors through the callback', async () => {
    state.assertionWriteError = new Error('no store');
    const { calls, cb } = captureCb();
    const ok = await dkgPersistChatTurn.handler(
      makeRuntime(),
      makeMessage('hi'),
      {} as State, {}, cb,
    );
    expect(ok).toBe(false);
    expect(calls[0].text).toMatch(/Chat turn persist failed: no store/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// dkgKnowledgeProvider happy path (with an agent stub)
// ───────────────────────────────────────────────────────────────────────────
describe('dkgKnowledgeProvider happy path', () => {
  it('builds a FILTER query from extracted keywords and returns formatted facts', async () => {
    const svc = await import('../src/service.js');
    const queryCalls: string[] = [];
    const spy = vi.spyOn(svc, 'getAgent').mockReturnValue({
      query: async (sparql: string) => {
        queryCalls.push(sparql);
        return {
          bindings: [
            { s: 'http://ex/a', p: 'http://ex/p', o: '"Distributed"' },
          ],
        };
      },
    } as any);
    try {
      const out = await dkgKnowledgeProvider.get!(
        makeRuntime(),
        makeMessage('tell me about distributed systems'),
      );
      expect(queryCalls).toHaveLength(1);
      expect(queryCalls[0]).toMatch(/CONTAINS\(LCASE\(STR\(\?o\)\)/);
      expect(queryCalls[0].toLowerCase()).toContain('distributed');
      expect(out).toMatch(/\[DKG Knowledge Context\]/);
      expect(out).toContain('http://ex/a');
    } finally {
      spy.mockRestore();
    }
  });

  it('returns null when the query returns zero bindings', async () => {
    const svc = await import('../src/service.js');
    const spy = vi.spyOn(svc, 'getAgent').mockReturnValue({
      query: async () => ({ bindings: [] }),
    } as any);
    try {
      const out = await dkgKnowledgeProvider.get!(
        makeRuntime(),
        makeMessage('tell me about blockchains'),
      );
      expect(out).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it('swallows query errors and returns null', async () => {
    const svc = await import('../src/service.js');
    const spy = vi.spyOn(svc, 'getAgent').mockReturnValue({
      query: async () => { throw new Error('boom'); },
    } as any);
    try {
      const out = await dkgKnowledgeProvider.get!(
        makeRuntime(),
        makeMessage('tell me about blockchains'),
      );
      expect(out).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });
});
