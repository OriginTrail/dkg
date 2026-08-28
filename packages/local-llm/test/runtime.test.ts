import { describe, expect, it, vi } from 'vitest';
import {
  DkgLocalLlmRuntime,
  normalizeFinalAnswer,
  type McpClientLike,
} from '../src/runtime.js';
import type { McpToolDefinition } from '../src/schema.js';

const catalogList: McpToolDefinition = {
  name: 'dkg_query_catalog_list',
  description: 'List saved queries',
  inputSchema: {
    type: 'object',
    properties: { projectId: { type: 'string' } },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
};

const catalogRun: McpToolDefinition = {
  name: 'dkg_query_catalog_run',
  description: 'Run a saved query',
  inputSchema: {
    type: 'object',
    properties: {
      selector: { type: 'string' },
      parameters: { type: 'object' },
    },
    required: ['selector'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
};

const dkgQuery: McpToolDefinition = {
  name: 'dkg_query',
  description: 'Run SPARQL',
  inputSchema: {
    type: 'object',
    properties: { sparql: { type: 'string' } },
    required: ['sparql'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
};

const catalogSave: McpToolDefinition = {
  name: 'dkg_query_catalog_save',
  description: 'Save a catalog query',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      sparql: { type: 'string' },
    },
    required: ['name', 'sparql'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false },
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function toolResponse(name: string, args: unknown, id = 'call-1'): Response {
  return jsonResponse({
    choices: [{
      finish_reason: 'tool_calls',
      message: {
        role: 'assistant',
        tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
      },
    }],
  });
}

function answerResponse(content: string): Response {
  return jsonResponse({
    choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }],
  });
}

function makeMcp(tools: McpToolDefinition[] = [catalogList, catalogRun]): McpClientLike & {
  callTool: ReturnType<typeof vi.fn>;
} {
  return {
    async listTools() { return { tools }; },
    callTool: vi.fn(async () => ({
      content: [{ type: 'text', text: 'Found lifecycle query.' }],
      structuredContent: { entries: [{ selector: 'supply/lifecycle' }] },
    })),
  };
}

describe('DkgLocalLlmRuntime', () => {
  it('executes a real catalog tool loop while exposing only the catalog profile', async () => {
    const mcp = makeMcp();
    const fetcher = vi.fn()
      .mockResolvedValueOnce(toolResponse('dkg_query_catalog_list', {}))
      .mockResolvedValueOnce(answerResponse('One saved query: supply/lifecycle.'));
    const runtime = await DkgLocalLlmRuntime.create({ mcp, fetch: fetcher as typeof fetch });

    const result = await runtime.run('Which DKG query catalog queries are saved?');

    expect(result.profile).toBe('catalog');
    expect(result.toolCalls).toEqual([{ name: 'dkg_query_catalog_list', arguments: {} }]);
    expect(mcp.callTool).toHaveBeenCalledWith({ name: 'dkg_query_catalog_list', arguments: {} });
    const firstRequest = JSON.parse(String(fetcher.mock.calls[0][1]?.body));
    expect(firstRequest.tool_choice).toBe('required');
    expect(firstRequest.tools.map((tool: { function: { name: string } }) => tool.function.name))
      .toEqual(['dkg_query_catalog_list', 'dkg_query_catalog_run']);
    const secondRequest = JSON.parse(String(fetcher.mock.calls[1][1]?.body));
    expect(secondRequest.messages.at(-1).role).toBe('tool');
    expect(secondRequest.messages.at(-1).content).toContain('Structured DKG evidence');
  });

  it('pins one schema repair retry to the failed tool', async () => {
    const mcp = makeMcp();
    const fetcher = vi.fn()
      .mockResolvedValueOnce(toolResponse('dkg_query_catalog_run', {}))
      .mockResolvedValueOnce(toolResponse('dkg_query_catalog_run', { selector: 'supply/lifecycle' }, 'call-2'))
      .mockResolvedValueOnce(answerResponse('Lifecycle evidence returned.'));
    const runtime = await DkgLocalLlmRuntime.create({ mcp, fetch: fetcher as typeof fetch });

    const result = await runtime.run('Run the saved DKG query catalog query supply/lifecycle');

    expect(result.toolCalls).toEqual([{
      name: 'dkg_query_catalog_run',
      arguments: { selector: 'supply/lifecycle' },
    }]);
    const retryRequest = JSON.parse(String(fetcher.mock.calls[1][1]?.body));
    expect(retryRequest.tools).toHaveLength(1);
    expect(retryRequest.tools[0].function.name).toBe('dkg_query_catalog_run');
  });

  it('closes an MCP tool-call turn with a tool error before requesting an argument retry', async () => {
    const mcp = makeMcp();
    mcp.callTool
      .mockResolvedValueOnce({
        isError: true,
        content: [{ type: 'text', text: 'Invalid arguments: selector is required' }],
      })
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: 'Found lifecycle query.' }],
      });
    const fetcher = vi.fn()
      .mockResolvedValueOnce(toolResponse('dkg_query_catalog_run', { selector: 'bad' }, 'call-bad'))
      .mockResolvedValueOnce(toolResponse('dkg_query_catalog_run', { selector: 'supply/lifecycle' }, 'call-good'))
      .mockResolvedValueOnce(answerResponse('Lifecycle evidence returned.'));
    const runtime = await DkgLocalLlmRuntime.create({ mcp, fetch: fetcher as typeof fetch });

    await runtime.run('Run the saved DKG query catalog query supply/lifecycle');

    const retryRequest = JSON.parse(String(fetcher.mock.calls[1][1]?.body));
    const retryMessages = retryRequest.messages.slice(-3);
    expect(retryMessages.map((message: { role: string }) => message.role))
      .toEqual(['assistant', 'tool', 'user']);
    expect(retryMessages[1]).toMatchObject({ role: 'tool', tool_call_id: 'call-bad' });
    expect(retryMessages[1].content).toContain('Invalid arguments');
  });

  it('blocks write intent before contacting the model', async () => {
    const save: McpToolDefinition = {
      name: 'dkg_query_catalog_save',
      inputSchema: { type: 'object' },
      annotations: { readOnlyHint: false },
    };
    const fetcher = vi.fn();
    const runtime = await DkgLocalLlmRuntime.create({
      mcp: makeMcp([...makeMcpTools(), save]),
      fetch: fetcher as typeof fetch,
    });
    await expect(runtime.run('Save this query in the DKG query catalog')).rejects.toThrow('read-only');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('retains bounded conversational context but requires fresh tools for DKG follow-ups', async () => {
    const mcp = makeMcp();
    const fetcher = vi.fn()
      .mockResolvedValueOnce(toolResponse('dkg_query_catalog_list', {}))
      .mockResolvedValueOnce(answerResponse('The selector is supply/lifecycle.'))
      .mockResolvedValueOnce(toolResponse('dkg_query_catalog_list', {}, 'call-2'))
      .mockResolvedValueOnce(answerResponse('It still exists.'));
    const runtime = await DkgLocalLlmRuntime.create({ mcp, fetch: fetcher as typeof fetch });
    await runtime.run('Which DKG query catalog queries are saved?');
    const followUp = await runtime.run('Does that DKG query still exist?');
    expect(followUp.toolCalls).toHaveLength(1);
    const request = JSON.parse(String(fetcher.mock.calls[2][1]?.body));
    expect(request.messages[0].content).toContain('Prior turns below only resolve conversational references');
  });

  it('uses the one repair retry for malformed DKG SPARQL before calling MCP', async () => {
    const mcp = makeMcp([dkgQuery]);
    const fetcher = vi.fn()
      .mockResolvedValueOnce(toolResponse('dkg_query', {
        sparql: 'ASK { urn:test:item <schema:name> "x" }',
      }))
      .mockResolvedValueOnce(toolResponse('dkg_query', {
        sparql: 'ASK { <urn:test:item> <schema:name> "x" }',
      }, 'call-2'))
      .mockResolvedValueOnce(answerResponse('Yes.'));
    const runtime = await DkgLocalLlmRuntime.create({ mcp, fetch: fetcher as typeof fetch });

    const result = await runtime.run('Use DKG SPARQL ASK for urn:test:item');

    expect(result.answer).toBe('Yes.');
    expect(mcp.callTool).toHaveBeenCalledTimes(1);
    expect(mcp.callTool).toHaveBeenCalledWith({
      name: 'dkg_query',
      arguments: { sparql: 'ASK { <urn:test:item> <schema:name> "x" }' },
    });
    const retryRequest = JSON.parse(String(fetcher.mock.calls[1][1]?.body));
    expect(retryRequest.messages.at(-1).content).toContain('wrap absolute IRI');
  });

  it('uses one storage-term retry after an empty compact-predicate DKG query', async () => {
    const mcp = makeMcp([dkgQuery]);
    mcp.callTool
      .mockResolvedValueOnce({ content: [{ type: 'text', text: '(no results)' }] })
      .mockResolvedValueOnce({ content: [{ type: 'text', text: '| model |\n|---|\n| urn:test:item |' }] });
    const fetcher = vi.fn()
      .mockResolvedValueOnce(toolResponse('dkg_query', {
        sparql: 'SELECT ?model WHERE { ?model a <urn:test:Class> }',
      }))
      .mockResolvedValueOnce(toolResponse('dkg_query', {
        sparql: 'SELECT ?model WHERE { ?model <rdf:type> <urn:test:Class> }',
      }, 'call-2'))
      .mockResolvedValueOnce(answerResponse('Found urn:test:item.'));
    const runtime = await DkgLocalLlmRuntime.create({ mcp, fetch: fetcher as typeof fetch });

    const result = await runtime.run('Use DKG SPARQL to find urn:test:Class entities');

    expect(result.answer).toBe('Found urn:test:item.');
    expect(mcp.callTool).toHaveBeenCalledTimes(2);
    const retryRequest = JSON.parse(String(fetcher.mock.calls[1][1]?.body));
    expect(retryRequest.messages.at(-1).content).toContain('<rdf:type>');
  });

  it('preserves quoted text byte-for-byte during the compact-predicate retry', async () => {
    const mcp = makeMcp([dkgQuery]);
    mcp.callTool
      .mockResolvedValueOnce({ content: [{ type: 'text', text: '(no results)' }] })
      .mockResolvedValueOnce({ content: [{ type: 'text', text: '| model |\n|---|\n| urn:test:item |' }] });
    const original = 'SELECT ?model WHERE { ?model a <urn:test:Class> ; schema:description "?x rdf:type legacy; schema:name untouched" }';
    const corrected = 'SELECT ?model WHERE { ?model <rdf:type> <urn:test:Class> ; <schema:description> "?x rdf:type legacy; schema:name untouched" }';
    const fetcher = vi.fn()
      .mockResolvedValueOnce(toolResponse('dkg_query', { sparql: original }))
      .mockResolvedValueOnce(toolResponse('dkg_query', { sparql: corrected }, 'call-2'))
      .mockResolvedValueOnce(answerResponse('Found urn:test:item.'));
    const runtime = await DkgLocalLlmRuntime.create({ mcp, fetch: fetcher as typeof fetch });

    await runtime.run('Use DKG SPARQL to find urn:test:Class entities by their exact description');

    expect(mcp.callTool).toHaveBeenNthCalledWith(2, {
      name: 'dkg_query',
      arguments: { sparql: corrected },
    });
    expect(corrected).toContain('"?x rdf:type legacy; schema:name untouched"');
  });

  it('lets one duplicate-call correction finish from existing evidence', async () => {
    const mcp = makeMcp();
    const fetcher = vi.fn()
      .mockResolvedValueOnce(toolResponse('dkg_query_catalog_list', {}))
      .mockResolvedValueOnce(toolResponse('dkg_query_catalog_list', {}, 'call-2'))
      .mockResolvedValueOnce(answerResponse('One saved query.'));
    const runtime = await DkgLocalLlmRuntime.create({ mcp, fetch: fetcher as typeof fetch });

    const result = await runtime.run('Which DKG query catalog queries are saved?');

    expect(result.answer).toBe('One saved query.');
    expect(mcp.callTool).toHaveBeenCalledTimes(1);
    const correctionRequest = JSON.parse(String(fetcher.mock.calls[2][1]?.body));
    expect(correctionRequest.tool_choice).toBe('auto');
    expect(correctionRequest.messages.at(-1).content).toContain('Do not call it again');
  });

  it('pins the routed mutation after a redundant discovery call in a write flow', async () => {
    const mcp = makeMcp([catalogSave, catalogList, catalogRun]);
    const fetcher = vi.fn()
      .mockResolvedValueOnce(toolResponse('dkg_query_catalog_list', {}))
      .mockResolvedValueOnce(toolResponse('dkg_query_catalog_list', {}, 'call-2'))
      .mockResolvedValueOnce(toolResponse('dkg_query_catalog_save', {
        name: 'Models',
        sparql: 'SELECT ?model WHERE { ?model <rdf:type> <urn:test:Model> }',
      }, 'call-3'))
      .mockResolvedValueOnce(answerResponse('Saved Models.'));
    const runtime = await DkgLocalLlmRuntime.create({
      mcp,
      fetch: fetcher as typeof fetch,
      allowWrite: true,
    });

    const result = await runtime.run('Save a DKG query catalog query named Models for urn:test:Model');

    expect(result.answer).toBe('Saved Models.');
    expect(mcp.callTool).toHaveBeenCalledTimes(2);
    const repairRequest = JSON.parse(String(fetcher.mock.calls[2][1]?.body));
    expect(repairRequest.tool_choice).toBe('required');
    expect(repairRequest.tools.map((tool: { function: { name: string } }) => tool.function.name))
      .toEqual(['dkg_query_catalog_save']);
  });
});

function makeMcpTools(): McpToolDefinition[] {
  return [catalogList, catalogRun];
}

describe('final-answer hygiene', () => {
  it('removes leaked special tokens, controls, and emoji-only padding lines', () => {
    expect(normalizeFinalAnswer('Answer.\n😀😀😀\n<|im_end|>\u0000')).toBe('Answer.');
  });
});
