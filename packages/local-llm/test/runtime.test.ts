import { describe, expect, it, vi } from 'vitest';
import {
  DkgLocalLlmRuntime,
  normalizeFinalAnswer,
  type McpClientLike,
} from '../src/runtime.js';
import { DEFAULT_MAX_MODEL_RESPONSE_BYTES } from '../src/model-response.js';
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
      projectId: { type: 'string' },
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
    properties: { projectId: { type: 'string' }, sparql: { type: 'string' } },
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
      projectId: { type: 'string' },
      name: { type: 'string' },
      sparql: { type: 'string' },
    },
    required: ['name', 'sparql'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false },
};

const listProjects: McpToolDefinition = {
  name: 'dkg_list_projects',
  description: 'List every Context Graph known to the node',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true },
};

const dkgStatus: McpToolDefinition = {
  name: 'dkg_status',
  description: 'Read node status',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true },
};

const memorySearch: McpToolDefinition = {
  name: 'dkg_memory_search',
  description: 'Search agent-context and optional project memory',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      projectId: { type: 'string' },
    },
    required: ['query'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
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

function truncatedAnswerResponse(content: string): Response {
  return jsonResponse({
    choices: [{ finish_reason: 'length', message: { role: 'assistant', content } }],
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

describe('local model response bounds', () => {
  it('enforces the default 4 MiB ceiling when the option is omitted', async () => {
    const oversized = new Response('x'.repeat(DEFAULT_MAX_MODEL_RESPONSE_BYTES + 1), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
    const runtime = await DkgLocalLlmRuntime.create({
      mcp: makeMcp(),
      fetch: vi.fn().mockResolvedValue(oversized) as typeof fetch,
    });

    await expect(runtime.run('Summarize the project.')).rejects.toThrow(
      `Local LLM response exceeds ${DEFAULT_MAX_MODEL_RESPONSE_BYTES} bytes`,
    );
  });

  it('rejects an oversized HTTP response before parsing it as JSON', async () => {
    const runtime = await DkgLocalLlmRuntime.create({
      mcp: makeMcp(),
      fetch: vi.fn().mockResolvedValue(answerResponse('x'.repeat(1_024))) as typeof fetch,
      maxModelResponseBytes: 128,
    });

    await expect(runtime.run('Summarize the project.')).rejects.toThrow(
      'Local LLM response exceeds 128 bytes',
    );
  });
});

describe('DkgLocalLlmRuntime', () => {
  it('executes a real catalog tool loop while exposing only the catalog profile', async () => {
    const mcp = makeMcp();
    const fetcher = vi.fn()
      .mockResolvedValueOnce(toolResponse('dkg_query_catalog_list', {}))
      .mockResolvedValueOnce(answerResponse('One saved query: supply/lifecycle.'));
    const runtime = await DkgLocalLlmRuntime.create({
      mcp,
      fetch: fetcher as typeof fetch,
      projectId: 'testing',
    });

    const result = await runtime.run('Which DKG query catalog queries are saved?');

    expect(result.profile).toBe('catalog');
    expect(result.toolCalls).toEqual([{
      name: 'dkg_query_catalog_list',
      arguments: { projectId: 'testing' },
    }]);
    expect(mcp.callTool).toHaveBeenCalledWith({
      name: 'dkg_query_catalog_list',
      arguments: { projectId: 'testing' },
    });
    const firstRequest = JSON.parse(String(fetcher.mock.calls[0][1]?.body));
    expect(firstRequest.tool_choice).toBe('required');
    expect(firstRequest.tools.map((tool: { function: { name: string } }) => tool.function.name))
      .toEqual(['dkg_query_catalog_list', 'dkg_query_catalog_run']);
    const secondRequest = JSON.parse(String(fetcher.mock.calls[1][1]?.body));
    expect(secondRequest.messages.at(-1).role).toBe('tool');
    expect(secondRequest.messages.at(-1).content).toContain('Structured DKG evidence');
  });

  it('repairs one ignored required tool choice from an OpenAI-compatible backend', async () => {
    const mcp = makeMcp();
    const fetcher = vi.fn()
      .mockResolvedValueOnce(answerResponse('I can answer without a tool.'))
      .mockResolvedValueOnce(toolResponse('dkg_query_catalog_list', {}))
      .mockResolvedValueOnce(answerResponse('One saved query: supply/lifecycle.'));
    const runtime = await DkgLocalLlmRuntime.create({
      mcp,
      fetch: fetcher as typeof fetch,
      projectId: 'testing',
    });

    const result = await runtime.run('Which DKG query catalog queries are saved?');

    expect(result.answer).toBe('One saved query: supply/lifecycle.');
    expect(mcp.callTool).toHaveBeenCalledOnce();
    const firstRequest = JSON.parse(String(fetcher.mock.calls[0][1]?.body));
    const repairRequest = JSON.parse(String(fetcher.mock.calls[1][1]?.body));
    expect(firstRequest.tool_choice).toBe('required');
    expect(repairRequest.tool_choice).toBe('required');
    expect(repairRequest.messages.at(-1).content)
      .toContain('Retry once with exactly one available tool call and no prose');
  });

  it('fails closed when an OpenAI-compatible backend ignores required tool choice twice', async () => {
    const mcp = makeMcp();
    const fetcher = vi.fn()
      .mockResolvedValueOnce(answerResponse('First unsupported prose answer.'))
      .mockResolvedValueOnce(answerResponse('Second unsupported prose answer.'));
    const runtime = await DkgLocalLlmRuntime.create({
      mcp,
      fetch: fetcher as typeof fetch,
      projectId: 'testing',
    });

    await expect(runtime.run('Which DKG query catalog queries are saved?'))
      .rejects.toThrow('One-retry limit reached');
    expect(mcp.callTool).not.toHaveBeenCalled();
  });

  it('strictly pins model-supplied graph arguments and excludes unscoped discovery tools', async () => {
    const strictCatalogList: McpToolDefinition = {
      ...catalogList,
      inputSchema: {
        type: 'object',
        properties: {
          projectId: { type: 'string' },
          contextGraphId: { type: 'string' },
        },
        additionalProperties: false,
      },
    };
    const mcp = makeMcp([strictCatalogList, memorySearch, listProjects, dkgStatus]);
    const fetcher = vi.fn()
      .mockResolvedValueOnce(toolResponse('dkg_query_catalog_list', {
        projectId: 'graph-b',
        contextGraphId: 'graph-c',
      }))
      .mockResolvedValueOnce(answerResponse('Catalog evidence returned.'));
    const runtime = await DkgLocalLlmRuntime.create({
      mcp,
      fetch: fetcher as typeof fetch,
      projectId: 'graph-a',
      strictProjectScope: true,
      strictProjectScopeTools: ['dkg_query_catalog_list'],
      strictProjectScopeUnscopedTools: ['dkg_status'],
    });

    const result = await runtime.run('List saved queries in graph-b.');

    expect(result.toolCalls).toEqual([{
      name: 'dkg_query_catalog_list',
      arguments: { projectId: 'graph-a', contextGraphId: 'graph-a' },
    }]);
    expect(mcp.callTool).toHaveBeenCalledWith({
      name: 'dkg_query_catalog_list',
      arguments: { projectId: 'graph-a', contextGraphId: 'graph-a' },
    });
    const firstRequest = JSON.parse(String(fetcher.mock.calls[0][1]?.body));
    expect(firstRequest.tools.map((tool: { function: { name: string } }) => tool.function.name))
      .toEqual(['dkg_query_catalog_list', 'dkg_status']);
    expect(JSON.stringify(firstRequest.tools)).not.toContain('dkg_list_projects');
  });

  it('aborts llama generation without retaining an invisible turn', async () => {
    let started!: () => void;
    const began = new Promise<void>((resolve) => { started = resolve; });
    const fetcher = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      if (fetcher.mock.calls.length === 1) {
        const signal = init?.signal;
        if (!signal) {
          return Promise.reject(new Error('Llama request did not receive an AbortSignal'));
        }
        started();
        return new Promise<Response>((_resolve, reject) => {
          const rejectFromAbort = () => reject(signal.reason);
          if (signal.aborted) {
            rejectFromAbort();
            return;
          }
          signal.addEventListener('abort', rejectFromAbort, { once: true });
        });
      }
      return Promise.resolve(answerResponse('Clean next answer.'));
    });
    const runtime = await DkgLocalLlmRuntime.create({
      mcp: makeMcp(),
      fetch: fetcher as typeof fetch,
    });
    const controller = new AbortController();

    const aborted = runtime.run('hello', { signal: controller.signal });
    await began;
    controller.abort(new Error('caller disconnected'));

    await expect(aborted).rejects.toThrow('caller disconnected');
    expect(runtime.getSessionHistory()).toEqual([]);
    const next = await runtime.run('hello again');
    expect(next.answer).toBe('Clean next answer.');
    const nextRequest = JSON.parse(String(fetcher.mock.calls[1][1]?.body));
    expect(nextRequest.messages[0].content).not.toContain('BOUNDED CHAT SESSION');
  });

  it('propagates cancellation into MCP tool calls without retaining evidence', async () => {
    let started!: () => void;
    const began = new Promise<void>((resolve) => { started = resolve; });
    const mcp = makeMcp();
    mcp.callTool.mockImplementationOnce((_input, options) => {
      const signal = options?.signal;
      if (!signal) {
        return Promise.reject(new Error('MCP tool call did not receive an AbortSignal'));
      }
      started();
      return new Promise((_resolve, reject) => {
        const rejectFromAbort = () => reject(signal.reason);
        if (signal.aborted) {
          rejectFromAbort();
          return;
        }
        signal.addEventListener('abort', rejectFromAbort, { once: true });
      });
    });
    const fetcher = vi.fn()
      .mockResolvedValueOnce(toolResponse('dkg_query_catalog_list', {}))
      .mockResolvedValueOnce(answerResponse('This answer must not be reached.'));
    const runtime = await DkgLocalLlmRuntime.create({
      mcp,
      fetch: fetcher as typeof fetch,
      projectId: 'graph-a',
    });
    const controller = new AbortController();

    const aborted = runtime.run('List saved DKG queries.', { signal: controller.signal });
    await began;
    controller.abort(new Error('caller disconnected'));

    await expect(aborted).rejects.toThrow('caller disconnected');
    expect(runtime.getSessionHistory()).toEqual([]);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('discards a truncated draft and retries with a generic bounded answer instruction', async () => {
    const mcp = makeMcp();
    const fetcher = vi.fn()
      .mockResolvedValueOnce(toolResponse('dkg_query_catalog_list', {}))
      .mockResolvedValueOnce(truncatedAnswerResponse('A verbose partial answer that must not anchor the retry.'))
      .mockResolvedValueOnce(answerResponse('supply/lifecycle'));
    const runtime = await DkgLocalLlmRuntime.create({
      mcp,
      fetch: fetcher as typeof fetch,
      projectId: 'testing',
      maxTokens: 1_024,
    });

    const result = await runtime.run('List every saved DKG query.');

    expect(result.answer).toBe('supply/lifecycle');
    const retryRequest = JSON.parse(String(fetcher.mock.calls[2][1]?.body));
    expect(retryRequest.tools).toBeUndefined();
    expect(retryRequest.messages.at(-1).content).toContain('target fewer than 768 tokens');
    expect(retryRequest.messages.at(-1).content).toContain('For lists, output only the minimum identifying fields');
    expect(retryRequest.messages).not.toContainEqual(expect.objectContaining({
      content: 'A verbose partial answer that must not anchor the retry.',
    }));
  });

  it('pins one schema repair retry to the failed tool', async () => {
    const mcp = makeMcp();
    const fetcher = vi.fn()
      .mockResolvedValueOnce(toolResponse('dkg_query_catalog_run', {}))
      .mockResolvedValueOnce(toolResponse('dkg_query_catalog_run', { selector: 'supply/lifecycle' }, 'call-2'))
      .mockResolvedValueOnce(answerResponse('Lifecycle evidence returned.'));
    const runtime = await DkgLocalLlmRuntime.create({
      mcp,
      fetch: fetcher as typeof fetch,
      projectId: 'testing',
    });

    const result = await runtime.run('Run the saved DKG query catalog query supply/lifecycle');

    expect(result.toolCalls).toEqual([{
      name: 'dkg_query_catalog_run',
      arguments: { projectId: 'testing', selector: 'supply/lifecycle' },
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
    const runtime = await DkgLocalLlmRuntime.create({
      mcp,
      fetch: fetcher as typeof fetch,
      projectId: 'testing',
    });

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
    const runtime = await DkgLocalLlmRuntime.create({
      mcp,
      fetch: fetcher as typeof fetch,
      projectId: 'testing',
    });
    await runtime.run('Which DKG query catalog queries are saved?');
    const followUp = await runtime.run('Does that DKG query still exist?');
    expect(followUp.toolCalls).toHaveLength(1);
    const request = JSON.parse(String(fetcher.mock.calls[2][1]?.body));
    expect(request.messages[0].content).toContain('Prior turns below only resolve conversational references');
  });

  it('carries a catalog selector Context Graph from list evidence instead of a different session pin', async () => {
    const mcp = makeMcp();
    mcp.callTool
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: 'One query.' }],
        structuredContent: {
          contextGraphId: 'graph-from-evidence',
          count: 1,
          items: [{
            selector: 'models/local/models-by-category',
            slug: 'models-by-category',
            name: 'Models by category',
          }],
        },
      })
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: '| model |\n|---|\n| urn:model:1 |' }],
      });
    const fetcher = vi.fn()
      .mockResolvedValueOnce(toolResponse('dkg_query_catalog_list', { projectId: 'graph-from-evidence' }))
      .mockResolvedValueOnce(answerResponse('The selector is models/local/models-by-category.'))
      .mockResolvedValueOnce(toolResponse('dkg_query_catalog_run', {
        selector: 'models/local/models-by-category',
        parameters: { category: 'decoder-only' },
      }, 'call-2'))
      .mockResolvedValueOnce(answerResponse('Found urn:model:1.'));
    const runtime = await DkgLocalLlmRuntime.create({
      mcp,
      fetch: fetcher as typeof fetch,
      projectId: 'different-session-pin',
    });

    await runtime.run('List the catalog in graph-from-evidence.');
    const result = await runtime.run('Run models/local/models-by-category for decoder-only.');

    expect(result.toolCalls).toEqual([{
      name: 'dkg_query_catalog_run',
      arguments: {
        projectId: 'graph-from-evidence',
        selector: 'models/local/models-by-category',
        parameters: { category: 'decoder-only' },
      },
    }]);
    expect(mcp.callTool).toHaveBeenLastCalledWith({
      name: 'dkg_query_catalog_run',
      arguments: {
        projectId: 'graph-from-evidence',
        selector: 'models/local/models-by-category',
        parameters: { category: 'decoder-only' },
      },
    });
    const followUpRequest = JSON.parse(String(fetcher.mock.calls[2][1]?.body));
    expect(followUpRequest.messages[0].content).toContain(
      'Session Context Graph: different-session-pin (explicitly pinned for this LLM session)',
    );
  });

  it('rejects a scoped MCP call without explicit, evidence, or session project scope', async () => {
    const mcp = makeMcp();
    const fetcher = vi.fn()
      .mockResolvedValueOnce(toolResponse('dkg_query_catalog_list', {}));
    const runtime = await DkgLocalLlmRuntime.create({ mcp, fetch: fetcher as typeof fetch });

    await expect(runtime.run('List saved DKG queries.')).rejects.toThrow(
      'requires an explicit Context Graph in local LLM mode',
    );
    expect(mcp.callTool).not.toHaveBeenCalled();
  });

  it('rejects an unresolved default/current graph alias before calling the model', async () => {
    const mcp = makeMcp();
    const fetcher = vi.fn();
    const runtime = await DkgLocalLlmRuntime.create({ mcp, fetch: fetcher as typeof fetch });

    await expect(runtime.run('List query catalogs for the default Context Graph.')).rejects.toThrow(
      'No Session Context Graph is selected',
    );
    expect(fetcher).not.toHaveBeenCalled();
    expect(mcp.callTool).not.toHaveBeenCalled();
  });

  it('never forwards a config path invented as a graph id', async () => {
    const mcp = makeMcp();
    const fetcher = vi.fn()
      .mockResolvedValueOnce(toolResponse('dkg_query_catalog_list', { projectId: '.dkg/config.yaml' }));
    const runtime = await DkgLocalLlmRuntime.create({ mcp, fetch: fetcher as typeof fetch });

    await expect(runtime.run('List the catalog for the default graph.')).rejects.toThrow(
      'projectId=".dkg/config.yaml" (config-path)',
    );
    expect(mcp.callTool).not.toHaveBeenCalled();
    const request = JSON.parse(String(fetcher.mock.calls[0][1]?.body));
    expect(JSON.stringify(request.tools)).not.toContain('Defaults to .dkg/config.yaml');
  });

  it('replaces an invented config-path target with the explicit session graph', async () => {
    const mcp = makeMcp();
    const fetcher = vi.fn()
      .mockResolvedValueOnce(toolResponse('dkg_query_catalog_list', { projectId: '.dkg/config.yaml' }))
      .mockResolvedValueOnce(answerResponse('No saved queries were returned.'));
    const runtime = await DkgLocalLlmRuntime.create({
      mcp,
      fetch: fetcher as typeof fetch,
      projectId: 'session-graph',
    });

    const result = await runtime.run('List the catalog for this graph.');

    expect(result.toolCalls).toEqual([{
      name: 'dkg_query_catalog_list',
      arguments: { projectId: 'session-graph' },
    }]);
    expect(mcp.callTool).toHaveBeenCalledWith({
      name: 'dkg_query_catalog_list',
      arguments: { projectId: 'session-graph' },
    });
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
    const runtime = await DkgLocalLlmRuntime.create({
      mcp,
      fetch: fetcher as typeof fetch,
      projectId: 'testing',
    });

    const result = await runtime.run('Use DKG SPARQL ASK for urn:test:item');

    expect(result.answer).toBe('Yes.');
    expect(mcp.callTool).toHaveBeenCalledTimes(1);
    expect(mcp.callTool).toHaveBeenCalledWith({
      name: 'dkg_query',
      arguments: { projectId: 'testing', sparql: 'ASK { <urn:test:item> <schema:name> "x" }' },
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
    const runtime = await DkgLocalLlmRuntime.create({
      mcp,
      fetch: fetcher as typeof fetch,
      projectId: 'testing',
    });

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
    const runtime = await DkgLocalLlmRuntime.create({
      mcp,
      fetch: fetcher as typeof fetch,
      projectId: 'testing',
    });

    await runtime.run('Use DKG SPARQL to find urn:test:Class entities by their exact description');

    expect(mcp.callTool).toHaveBeenNthCalledWith(2, {
      name: 'dkg_query',
      arguments: { projectId: 'testing', sparql: corrected },
    });
    expect(corrected).toContain('"?x rdf:type legacy; schema:name untouched"');
  });

  it('lets one duplicate-call correction finish from existing evidence', async () => {
    const mcp = makeMcp();
    const fetcher = vi.fn()
      .mockResolvedValueOnce(toolResponse('dkg_query_catalog_list', {}))
      .mockResolvedValueOnce(toolResponse('dkg_query_catalog_list', {}, 'call-2'))
      .mockResolvedValueOnce(answerResponse('One saved query.'));
    const runtime = await DkgLocalLlmRuntime.create({
      mcp,
      fetch: fetcher as typeof fetch,
      projectId: 'testing',
    });

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
      projectId: 'testing',
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
