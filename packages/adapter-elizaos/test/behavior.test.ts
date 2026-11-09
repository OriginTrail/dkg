import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  dkgFindAgents, dkgInvokeSkill, dkgKnowledgeProvider, dkgPublish,
  dkgQuery, dkgSendMessage, dkgService, getAgent,
} from '../src/index.js';
import { requireAgent } from '../src/service.js';
import type { Action, IAgentRuntime, Memory } from '../src/types.js';

// Mock only the external node boundary: the service, parsing, formatting and
// provider below are real. No P2P node or external network is started.
const { agent, create } = vi.hoisted(() => {
  const agent = {
    start: vi.fn(), stop: vi.fn(), publishProfile: vi.fn(), publish: vi.fn(),
    query: vi.fn(), findSkills: vi.fn(), findAgents: vi.fn(),
    sendChat: vi.fn(), invokeSkill: vi.fn(),
  };
  return { agent, create: vi.fn() };
});
vi.mock('@origintrail-official/dkg-agent', () => ({ DKGAgent: { create } }));

const runtime = (settings: Record<string, string> = {}, name?: string): IAgentRuntime => ({
  getSetting: key => settings[key],
  ...(name === undefined ? {} : { character: { name } }),
});
const message = (text: string): Memory => ({
  userId: 'user', agentId: 'agent', roomId: 'room', content: { text },
});
async function invoke(action: Action, text: string) {
  const callback = vi.fn();
  const ok = await action.handler(runtime(), message(text), {}, {}, callback);
  expect(callback).toHaveBeenCalledTimes(1);
  return { ok, text: callback.mock.calls[0][0].text };
}

beforeEach(async () => {
  await dkgService.cleanup!();
  vi.resetAllMocks();
  create.mockResolvedValue(agent);
  agent.query.mockResolvedValue({ bindings: [] });
  agent.findAgents.mockResolvedValue([]);
  agent.findSkills.mockResolvedValue([]);
});
afterEach(async () => {
  await dkgService.cleanup!();
  expect(getAgent()).toBeNull();
});

describe('service lifecycle', () => {
  it('uses defaults and starts before publishing a profile', async () => {
    expect(getAgent()).toBeNull();
    expect(() => requireAgent()).toThrow('DKG node not started');
    await dkgService.initialize!(runtime());
    expect(create).toHaveBeenCalledExactlyOnceWith({
      name: 'elizaos-agent', framework: 'ElizaOS', description: undefined,
      dataDir: '.dkg/elizaos', listenPort: undefined,
      relayPeers: undefined, bootstrapPeers: undefined,
    });
    expect(getAgent()).toBe(agent);
    expect(requireAgent()).toBe(agent);
    expect(agent.start).toHaveBeenCalledExactlyOnceWith();
    expect(agent.publishProfile).toHaveBeenCalledExactlyOnceWith();
    expect(agent.start.mock.invocationCallOrder[0])
      .toBeLessThan(agent.publishProfile.mock.invocationCallOrder[0]);
  });

  it('maps configured peers, port and metadata, with character name taking precedence', async () => {
    await dkgService.initialize!(runtime({
      DKG_AGENT_NAME: 'setting-name', DKG_AGENT_DESCRIPTION: 'Research agent',
      DKG_DATA_DIR: '/isolated/data', DKG_LISTEN_PORT: '9123',
      DKG_RELAY_PEERS: ' /ip4/127.0.0.1/tcp/1 , /ip4/127.0.0.1/tcp/2 ',
      DKG_BOOTSTRAP_PEERS: ' peer-a , peer-b ',
    }, 'character-name'));
    expect(create).toHaveBeenCalledExactlyOnceWith({
      name: 'character-name', framework: 'ElizaOS', description: 'Research agent',
      dataDir: '/isolated/data', listenPort: 9123,
      relayPeers: ['/ip4/127.0.0.1/tcp/1', '/ip4/127.0.0.1/tcp/2'],
      bootstrapPeers: ['peer-a', 'peer-b'],
    });
  });

  it('falls back to the configured name when a character has no name', async () => {
    await dkgService.initialize!({ ...runtime({ DKG_AGENT_NAME: 'configured' }), character: {} });
    expect(create.mock.calls[0][0].name).toBe('configured');
  });

  it('initializes once, stops once, and permits a new lifecycle after cleanup', async () => {
    await dkgService.initialize!(runtime());
    await dkgService.initialize!(runtime());
    expect(create).toHaveBeenCalledTimes(1);
    expect(agent.start).toHaveBeenCalledTimes(1);
    expect(agent.publishProfile).toHaveBeenCalledTimes(1);
    await dkgService.cleanup!();
    await dkgService.cleanup!();
    expect(agent.stop).toHaveBeenCalledTimes(1);
    expect(getAgent()).toBeNull();
    await dkgService.initialize!(runtime());
    expect(create).toHaveBeenCalledTimes(2);
    expect(agent.start).toHaveBeenCalledTimes(2);
  });

  it('propagates creation failure without installing a singleton and permits retry', async () => {
    const failure = new Error('creation failed');
    create.mockRejectedValueOnce(failure);
    await expect(dkgService.initialize!(runtime())).rejects.toBe(failure);
    expect(getAgent()).toBeNull();
    expect(agent.start).not.toHaveBeenCalled();
    expect(agent.publishProfile).not.toHaveBeenCalled();
    await dkgService.initialize!(runtime());
    expect(getAgent()).toBe(agent);
  });
});

describe('initialized action handlers', () => {
  beforeEach(async () => { await dkgService.initialize!(runtime()); });

  it.each([
    [dkgPublish, 'publish', 'Please provide N-Quads triples in a code block to publish.'],
    [dkgPublish, '```nquads\n# comment\nnot a triple\n```', 'No valid triples found in the code block.'],
    [dkgQuery, 'query please', 'Please provide a SPARQL query (in a code block or inline).'],
    [dkgSendMessage, 'say hello', 'Please specify a peer ID to message.'],
    [dkgInvokeSkill, 'peer: alice', 'Please specify both a peer ID and skill URI.'],
    [dkgInvokeSkill, 'skill: urn:translate', 'Please specify both a peer ID and skill URI.'],
  ] as const)('%s rejects missing arguments without invoking the node', async (action, input, text) => {
    expect(await invoke(action, input)).toEqual({ ok: false, text });
    for (const method of [agent.publish, agent.query, agent.sendChat, agent.invokeSkill]) {
      expect(method).not.toHaveBeenCalled();
    }
  });

  it.each(['context-graph: "research"', "context graph: 'research'", 'contextGraph: research', 'contextgraph research'])
    ('publishes parsed RDF with an explicit context graph (%s)', async prefix => {
      agent.publish.mockResolvedValue({ kaId: 'ka-42', kaManifest: [{}, {}] });
      const input = `${prefix}\n\`\`\`nquads\n# comment\n\n<urn:s> <urn:p> <urn:o> <urn:g> .\n<urn:s> <urn:name> "Alice"@en .\n<urn:s> <urn:age> "42"^^<http://www.w3.org/2001/XMLSchema#integer> .\ninvalid\n\`\`\``;
      expect(await invoke(dkgPublish, input)).toEqual({
        ok: true, text: 'Published 3 triple(s) to context graph "research". KA ID: ka-42, KAs: 2',
      });
      expect(agent.publish).toHaveBeenCalledExactlyOnceWith('research', [
        { subject: 'urn:s', predicate: 'urn:p', object: 'urn:o', graph: 'urn:g' },
        { subject: 'urn:s', predicate: 'urn:name', object: '"Alice"@en', graph: undefined },
        { subject: 'urn:s', predicate: 'urn:age', object: '"42"^^<http://www.w3.org/2001/XMLSchema#integer>', graph: undefined },
      ]);
    });

  it('uses the default graph and preserves plain literal spelling', async () => {
    agent.publish.mockResolvedValue({ kaId: 'ka-1', kaManifest: [{}] });
    expect(await invoke(dkgPublish, '```\n<urn:s> <urn:p> "Hello" .\n```')).toEqual({
      ok: true, text: 'Published 1 triple(s) to context graph "default". KA ID: ka-1, KAs: 1',
    });
    expect(agent.publish).toHaveBeenCalledExactlyOnceWith('default', [
      { subject: 'urn:s', predicate: 'urn:p', object: '"Hello"', graph: undefined },
    ]);
  });

  it.each([{}, { DKG_DATA_DIR: '/data' }])('allows publishing with optional configuration %j', async settings => {
    expect(await dkgPublish.validate!(runtime(settings), message(''))).toBe(true);
  });

  it.each(['```sparql\n SELECT ?s WHERE { ?s ?p ?o } \n```', '```SELECT ?s WHERE { ?s ?p ?o }```', 'Please run SELECT ?s WHERE { ?s ?p ?o }'])
    ('forwards the query and reports empty results (%s)', async input => {
      expect(await invoke(dkgQuery, input)).toEqual({ ok: true, text: 'Query returned no results.' });
      expect(agent.query).toHaveBeenCalledExactlyOnceWith('SELECT ?s WHERE { ?s ?p ?o }');
    });

  it.each([1, 20, 21])('formats %i rows with a 20-row display limit', async count => {
    agent.query.mockResolvedValue({ bindings: Array.from({ length: count }, (_, i) => ({ s: `urn:${i}`, name: `row-${i}` })) });
    const rows = Array.from({ length: Math.min(count, 20) }, (_, i) => `s: urn:${i}, name: row-${i}`);
    expect(await invoke(dkgQuery, 'SELECT * WHERE { ?s ?p ?o }')).toEqual({
      ok: true, text: `Query returned ${count} result(s):\n${rows.join('\n')}${count > 20 ? '\n... (truncated)' : ''}`,
    });
  });

  it('reports no skill matches without running general discovery', async () => {
    expect(await invoke(dkgFindAgents, 'skill: "analysis"')).toEqual({ ok: true, text: 'No agents found offering skill "analysis".' });
    expect(agent.findSkills).toHaveBeenCalledExactlyOnceWith({ skillType: 'analysis' });
    expect(agent.findAgents).not.toHaveBeenCalled();
  });

  it('formats skill prices with defaults only for missing fields', async () => {
    agent.findSkills.mockResolvedValue([
      { agentName: 'A', skillType: 'analysis', pricePerCall: 7, currency: 'USD' },
      { agentName: 'B', skillType: 'analysis' },
      { agentName: 'C', skillType: 'analysis', pricePerCall: 0, currency: 'ETH' },
    ]);
    expect(await invoke(dkgFindAgents, 'skill: analysis')).toEqual({ ok: true,
      text: 'Found 3 agent(s) with that skill:\n- A: analysis (7 USD)\n- B: analysis (0 TRAC)\n- C: analysis (0 ETH)',
    });
  });

  it.each([['find agents', undefined], ['framework: "elizaos"', { framework: 'elizaos' }], ['framework elizaos', { framework: 'elizaos' }]])
    ('forwards optional framework filters (%s)', async (input, filter) => {
      expect(await invoke(dkgFindAgents, input)).toEqual({ ok: true, text: 'No agents found on the network.' });
      expect(agent.findAgents).toHaveBeenCalledExactlyOnceWith(filter);
      expect(agent.findSkills).not.toHaveBeenCalled();
    });

  it('formats discovered names, abbreviated peers and missing frameworks', async () => {
    agent.findAgents.mockResolvedValue([
      { name: 'Alice', peerId: 'abcdefghijklmnop', framework: 'ElizaOS' },
      { name: 'Bob', peerId: 'qrstuvwxyz123456' },
    ]);
    expect(await invoke(dkgFindAgents, 'find agents')).toEqual({ ok: true,
      text: 'Found 2 agent(s):\n- Alice (abcdefghijkl...): ElizaOS\n- Bob (qrstuvwxyz12...): unknown',
    });
  });

  it.each(['message: "Hello!"', "say: 'Hello!'", 'Hello!'])
    ('sends the parsed peer and message (%s)', async suffix => {
      agent.sendChat.mockResolvedValue({ delivered: true });
      expect(await invoke(dkgSendMessage, `peer: "abcdefghijklmnop" ${suffix}`)).toEqual({ ok: true, text: 'Message delivered to abcdefghijkl...' });
      expect(agent.sendChat).toHaveBeenCalledExactlyOnceWith('abcdefghijklmnop', 'Hello!');
    });

  it.each([['offline', 'offline'], [undefined, 'unknown error']])
    ('reports delivery refusal (%s)', async (error, reason) => {
      agent.sendChat.mockResolvedValue({ delivered: false, error });
      expect(await invoke(dkgSendMessage, 'peer: alice say: "Hi"')).toEqual({ ok: true, text: `Message delivery failed: ${reason}` });
    });

  it.each([['input: "café"', 'café'], ['```hello\nworld```', 'hello\nworld'], ['', '']])
    ('encodes skill input as UTF-8 (%s)', async (suffix, input) => {
      agent.invokeSkill.mockResolvedValue({ success: true, outputData: new Uint8Array([0x63, 0x61, 0x66, 0xc3, 0xa9]) });
      expect(await invoke(dkgInvokeSkill, `peer: alice skill: urn:translate ${suffix}`)).toEqual({ ok: true, text: 'Skill response: café' });
      expect(agent.invokeSkill).toHaveBeenCalledExactlyOnceWith('alice', 'urn:translate', new TextEncoder().encode(input));
    });

  it.each([
    [{ success: true }, 'ok: no output'],
    [{ success: false, error: 'unknown skill' }, 'failed: unknown skill'],
    [{ success: false }, 'failed: no output'],
  ])('reports skill status without output (%j)', async (response, status) => {
    agent.invokeSkill.mockResolvedValue(response);
    expect(await invoke(dkgInvokeSkill, 'peer: alice skill: urn:translate')).toEqual({ ok: true, text: `Skill invocation ${status}` });
  });

  it.each([
    [dkgPublish, '```<urn:s> <urn:p> <urn:o> .```', 'publish', 'DKG publish failed'],
    [dkgQuery, 'SELECT * WHERE { ?s ?p ?o }', 'query', 'DKG query failed'],
    [dkgFindAgents, 'find agents', 'findAgents', 'Agent discovery failed'],
    [dkgFindAgents, 'skill: analysis', 'findSkills', 'Agent discovery failed'],
    [dkgSendMessage, 'peer: alice say: "Hi"', 'sendChat', 'Message send failed'],
    [dkgInvokeSkill, 'peer: alice skill: urn:translate', 'invokeSkill', 'Skill invocation failed'],
  ] as const)('%s reports node errors once', async (action, input, method, prefix) => {
    agent[method].mockRejectedValue(new Error('node unavailable'));
    expect(await invoke(action, input)).toEqual({ ok: false, text: `${prefix}: node unavailable` });
    expect(agent[method]).toHaveBeenCalledTimes(1);
  });
});

describe('initialized knowledge provider', () => {
  beforeEach(async () => { await dkgService.initialize!(runtime()); });

  it.each(['', 'the AND a is in', 'a b 12 !!'])('does not query for stop words or short tokens (%s)', async text => {
    expect(await dkgKnowledgeProvider.get(runtime(), message(text))).toBeNull();
    expect(agent.query).not.toHaveBeenCalled();
  });

  it.each([
    'THE a an is ARE was were be been being',
    'have has had do does did will would could',
    'should may might can shall to of in for',
    'on with at by from as into through during',
    'before after above below between and but or',
    'not no nor so yet both either neither',
    'this that these those it its I me my',
    'we our you your he she they them their',
    'what which who whom how when where why',
  ])('ignores function words in an initialized provider (%s)', async text => {
    expect(await dkgKnowledgeProvider.get(runtime(), message(text))).toBeNull();
    expect(agent.query).not.toHaveBeenCalled();
  });

  it('normalizes punctuation, strips stop words and limits the query to five keywords', async () => {
    agent.query.mockResolvedValue({ bindings: [
      { s: 'urn:alice', p: 'urn:name', o: 'Alice' },
      { s: 'urn:bob', p: 'urn:name', o: 'Bob' },
    ] });
    expect(await dkgKnowledgeProvider.get(runtime(), message('THE Alice,Bob!   Carol\nDave\tEve Frank')))
      .toBe('[DKG Knowledge Context]\nurn:alice urn:name Alice\nurn:bob urn:name Bob');
    expect(agent.query).toHaveBeenCalledTimes(1);
    expect(agent.query.mock.calls[0][0].replace(/\s+/g, ' ').trim()).toBe(
      'SELECT ?s ?p ?o WHERE { ?s ?p ?o . FILTER(CONTAINS(LCASE(STR(?o)), "alice") || CONTAINS(LCASE(STR(?o)), "bob") || CONTAINS(LCASE(STR(?o)), "carol") || CONTAINS(LCASE(STR(?o)), "dave") || CONTAINS(LCASE(STR(?o)), "eve")) } LIMIT 10',
    );
  });

  it('returns null when the initialized node has no matching knowledge', async () => {
    expect(await dkgKnowledgeProvider.get(runtime(), message('knowledge'))).toBeNull();
    expect(agent.query).toHaveBeenCalledTimes(1);
  });

  it('degrades to null when the node query rejects', async () => {
    agent.query.mockRejectedValue(new Error('store unavailable'));
    expect(await dkgKnowledgeProvider.get(runtime(), message('knowledge'))).toBeNull();
    expect(agent.query).toHaveBeenCalledTimes(1);
  });
});
