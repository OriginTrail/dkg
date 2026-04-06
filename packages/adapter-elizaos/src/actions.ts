/**
 * ElizaOS Actions for DKG V9.
 *
 * Each action maps to a DKGAgent capability. The DKG node must be
 * running (via DKGService) before actions are invoked.
 */
import { requireAgent } from './service.js';
import type { Action, IAgentRuntime, Memory, State, HandlerCallback } from './types.js';

function hasSetting(runtime: IAgentRuntime, key: string): boolean {
  return !!runtime.getSetting(key);
}

export const dkgPublish: Action = {
  name: 'DKG_PUBLISH',
  similes: ['PUBLISH_TO_DKG', 'STORE_KNOWLEDGE', 'ADD_TO_GRAPH'],
  description: 'Publish knowledge (RDF triples) to the OriginTrail Decentralized Knowledge Graph.',

  validate: async (runtime: IAgentRuntime) => hasSetting(runtime, 'DKG_DATA_DIR') || true,

  handler: async (
    _runtime: IAgentRuntime,
    message: Memory,
    _state: State,
    _options: Record<string, unknown>,
    callback: HandlerCallback,
  ): Promise<boolean> => {
    try {
      const agent = requireAgent();
      const text = message.content.text;

      const contextGraphMatch = text.match(/context[- ]?graph[:\s]+["']?([^\s"']+)/i)
        ?? text.match(/paranet[:\s]+["']?([^\s"']+)/i);
      const contextGraphId = contextGraphMatch?.[1] ?? 'default';

      const nquadsMatch = text.match(/```(?:nquads|n-quads|turtle)?\s*([\s\S]*?)```/i);
      if (!nquadsMatch) {
        callback({ text: 'Please provide N-Quads triples in a code block to publish.' });
        return false;
      }

      const quads = parseNQuads(nquadsMatch[1]);
      if (quads.length === 0) {
        callback({ text: 'No valid triples found in the code block.' });
        return false;
      }

      const result = await agent.publish(contextGraphId, quads as any);
      callback({
        text: `Published ${quads.length} triple(s) to context graph "${contextGraphId}". KC ID: ${result.kcId}, KAs: ${result.kaManifest.length}`,
      });
      return true;
    } catch (err: any) {
      callback({ text: `DKG publish failed: ${err.message}` });
      return false;
    }
  },

  examples: [
    [
      { user: '{{user1}}', content: { text: 'publish this to DKG:\n```nquads\n<http://ex.org/alice> <http://schema.org/name> "Alice" .\n```', action: 'DKG_PUBLISH' } },
      { user: '{{user2}}', content: { text: 'Published 1 triple(s) to context graph "default".' } },
    ],
  ],
};

export const dkgQuery: Action = {
  name: 'DKG_QUERY',
  similes: ['QUERY_DKG', 'SEARCH_KNOWLEDGE', 'SPARQL_QUERY', 'ASK_DKG'],
  description: 'Query the DKG knowledge graph using SPARQL.',

  handler: async (
    _runtime: IAgentRuntime,
    message: Memory,
    _state: State,
    _options: Record<string, unknown>,
    callback: HandlerCallback,
  ): Promise<boolean> => {
    try {
      const agent = requireAgent();
      const text = message.content.text;

      const sparqlMatch = text.match(/```(?:sparql)?\s*([\s\S]*?)```/i)
        ?? text.match(/(SELECT\s[\s\S]+)/i);
      if (!sparqlMatch) {
        callback({ text: 'Please provide a SPARQL query (in a code block or inline).' });
        return false;
      }

      const result = await agent.query(sparqlMatch[1].trim());
      const bindings = result.bindings;
      if (bindings.length === 0) {
        callback({ text: 'Query returned no results.' });
      } else {
        const formatted = bindings.slice(0, 20).map(row =>
          Object.entries(row).map(([k, v]) => `${k}: ${v}`).join(', '),
        ).join('\n');
        callback({
          text: `Query returned ${bindings.length} result(s):\n${formatted}${bindings.length > 20 ? '\n... (truncated)' : ''}`,
        });
      }
      return true;
    } catch (err: any) {
      callback({ text: `DKG query failed: ${err.message}` });
      return false;
    }
  },

  examples: [
    [
      { user: '{{user1}}', content: { text: 'query the DKG:\n```sparql\nSELECT ?s ?p ?o WHERE { ?s ?p ?o } LIMIT 10\n```', action: 'DKG_QUERY' } },
      { user: '{{user2}}', content: { text: 'Query returned 10 result(s):' } },
    ],
  ],
};

export const dkgFindAgents: Action = {
  name: 'DKG_FIND_AGENTS',
  similes: ['DISCOVER_AGENTS', 'FIND_AGENT', 'SEARCH_AGENTS', 'LIST_AGENTS'],
  description: 'Discover AI agents on the DKG network by skill or framework.',

  handler: async (
    _runtime: IAgentRuntime,
    message: Memory,
    _state: State,
    _options: Record<string, unknown>,
    callback: HandlerCallback,
  ): Promise<boolean> => {
    try {
      const agent = requireAgent();
      const text = message.content.text.toLowerCase();

      const skillMatch = text.match(/skill[:\s]+["']?([^\s"']+)/i);
      if (skillMatch) {
        const offerings = await agent.findSkills({ skillType: skillMatch[1] });
        if (offerings.length === 0) {
          callback({ text: `No agents found offering skill "${skillMatch[1]}".` });
        } else {
          const list = offerings.map(o =>
            `- ${o.agentName}: ${o.skillType} (${o.pricePerCall ?? 0} ${o.currency ?? 'TRAC'})`,
          ).join('\n');
          callback({ text: `Found ${offerings.length} agent(s) with that skill:\n${list}` });
        }
        return true;
      }

      const frameworkMatch = text.match(/framework[:\s]+["']?(\w+)/i);
      const agents = await agent.findAgents(
        frameworkMatch ? { framework: frameworkMatch[1] } : undefined,
      );
      if (agents.length === 0) {
        callback({ text: 'No agents found on the network.' });
      } else {
        const list = agents.map(a =>
          `- ${a.name} (${a.peerId.slice(0, 12)}...): ${a.framework ?? 'unknown'}`,
        ).join('\n');
        callback({ text: `Found ${agents.length} agent(s):\n${list}` });
      }
      return true;
    } catch (err: any) {
      callback({ text: `Agent discovery failed: ${err.message}` });
      return false;
    }
  },

  examples: [
    [
      { user: '{{user1}}', content: { text: 'find agents with skill: ImageAnalysis', action: 'DKG_FIND_AGENTS' } },
      { user: '{{user2}}', content: { text: 'Found 2 agent(s) with that skill:' } },
    ],
  ],
};

export const dkgSendMessage: Action = {
  name: 'DKG_SEND_MESSAGE',
  similes: ['MESSAGE_AGENT', 'CHAT_AGENT', 'DM_AGENT'],
  description: 'Send an encrypted message to another DKG agent.',

  handler: async (
    _runtime: IAgentRuntime,
    message: Memory,
    _state: State,
    _options: Record<string, unknown>,
    callback: HandlerCallback,
  ): Promise<boolean> => {
    try {
      const agent = requireAgent();
      const text = message.content.text;

      const peerMatch = text.match(/peer[:\s]+["']?([^\s"']+)/i);
      if (!peerMatch) {
        callback({ text: 'Please specify a peer ID to message.' });
        return false;
      }

      const msgMatch = text.match(/message[:\s]+["'](.+?)["']/i)
        ?? text.match(/say[:\s]+["'](.+?)["']/i);
      const msgText = msgMatch?.[1] ?? text.replace(/.*peer[:\s]+["']?[^\s"']+["']?\s*/i, '').trim();

      const result = await agent.sendChat(peerMatch[1], msgText);
      if (result.delivered) {
        callback({ text: `Message delivered to ${peerMatch[1].slice(0, 12)}...` });
      } else {
        callback({ text: `Message delivery failed: ${result.error ?? 'unknown error'}` });
      }
      return true;
    } catch (err: any) {
      callback({ text: `Message send failed: ${err.message}` });
      return false;
    }
  },

  examples: [
    [
      { user: '{{user1}}', content: { text: 'message peer: 12D3KooW... say: "Hello!"', action: 'DKG_SEND_MESSAGE' } },
      { user: '{{user2}}', content: { text: 'Message delivered to 12D3KooW...' } },
    ],
  ],
};

export const dkgInvokeSkill: Action = {
  name: 'DKG_INVOKE_SKILL',
  similes: ['CALL_SKILL', 'USE_SKILL', 'RUN_SKILL', 'INVOKE_AGENT'],
  description: 'Invoke a remote agent skill on the DKG network.',

  handler: async (
    _runtime: IAgentRuntime,
    message: Memory,
    _state: State,
    _options: Record<string, unknown>,
    callback: HandlerCallback,
  ): Promise<boolean> => {
    try {
      const agent = requireAgent();
      const text = message.content.text;

      const peerMatch = text.match(/peer[:\s]+["']?([^\s"']+)/i);
      const skillMatch = text.match(/skill[:\s]+["']?([^\s"']+)/i);
      if (!peerMatch || !skillMatch) {
        callback({ text: 'Please specify both a peer ID and skill URI.' });
        return false;
      }

      const inputMatch = text.match(/input[:\s]+["'](.+?)["']/i)
        ?? text.match(/```([\s\S]*?)```/);
      const input = inputMatch?.[1] ?? '';

      const response = await agent.invokeSkill(
        peerMatch[1],
        skillMatch[1],
        new TextEncoder().encode(input),
      );

      if (response.success && response.outputData) {
        callback({ text: `Skill response: ${new TextDecoder().decode(response.outputData)}` });
      } else {
        callback({ text: `Skill invocation ${response.success ? 'ok' : 'failed'}: ${response.error ?? 'no output'}` });
      }
      return true;
    } catch (err: any) {
      callback({ text: `Skill invocation failed: ${err.message}` });
      return false;
    }
  },

  examples: [
    [
      { user: '{{user1}}', content: { text: 'invoke skill: ImageAnalysis on peer: 12D3KooW... input: "analyze this"', action: 'DKG_INVOKE_SKILL' } },
      { user: '{{user2}}', content: { text: 'Skill response: ...' } },
    ],
  ],
};

function parseNQuads(text: string): Array<{ subject: string; predicate: string; object: string; graph?: string }> {
  const quads: Array<{ subject: string; predicate: string; object: string; graph?: string }> = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^<([^>]+)>\s+<([^>]+)>\s+("[^"]*(?:\\.[^"]*)*"(?:@\w+|(?:\^\^<[^>]+>))?|<[^>]+>)\s*(?:<([^>]+)>)?\s*\.?\s*$/);
    if (!match) continue;
    quads.push({
      subject: match[1],
      predicate: match[2],
      object: match[3].startsWith('<') ? match[3].slice(1, -1) : match[3],
      graph: match[4],
    });
  }
  return quads;
}
