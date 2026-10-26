import { describe, expect, it, vi } from 'vitest';
import { DkgLocalLlmRuntime } from '../src/runtime.js';
import type { McpToolDefinition } from '../src/schema.js';
import {
  catalogSave, dkgStatus, makeMcp, jsonResponse, toolResponse, answerResponse, truncatedAnswerResponse,
} from './helpers/runtime-fixtures.js';

describe('runtime validation and recovery', () => {
  it.each(['maxTokens', 'maxToolCalls', 'maxToolsPerTurn', 'maxToolJsonBytes', 'maxModelResponseBytes',
    'maxEvidenceChars', 'maxSessionTurns', 'maxSessionChars', 'requestTimeoutMs'] as const)
    ('rejects invalid %s before model or tool execution', async key => {
      for (const value of [0, -1, 0.5, NaN, Infinity]) {
        const mcp = makeMcp();
        const fetcher = vi.fn();
        await expect(DkgLocalLlmRuntime.create({ mcp, fetch: fetcher, [key]: value }))
          .rejects.toThrow(`${key} must be a positive integer.`);
        expect(fetcher).not.toHaveBeenCalled();
        expect(mcp.callTool).not.toHaveBeenCalled();
      }
    });

  it('reports normalized and rejected schemas while keeping only compatible tools', async () => {
    const trace = { write: vi.fn() };
    const compatible: McpToolDefinition = { ...dkgStatus, inputSchema: {
      type: 'object', properties: { id: { type: 'string', pattern: '^\\d+$' } },
    } };
    const incompatible: McpToolDefinition = { name: 'unsafe', inputSchema: { not: {} } };
    const runtime = await DkgLocalLlmRuntime.create({ mcp: makeMcp([compatible, incompatible]), trace });
    expect(runtime.getAvailableToolNames()).toEqual(['dkg_status']);
    expect(trace.write).toHaveBeenCalledExactlyOnceWith('MCP TOOLS/LIST', expect.objectContaining({
      discovered: 2,
      schemaNormalizations: [{ name: 'dkg_status', changes: ['$.properties.id.pattern: ^\\d+$ -> ^[0-9]+$'] }],
      rejected: [{ name: 'unsafe', error: '$.not: unsupported JSON Schema keyword' }],
    }));
    await expect(DkgLocalLlmRuntime.create({ mcp: makeMcp([incompatible]) }))
      .rejects.toThrow('no llama.cpp-compatible tools');
    await expect(DkgLocalLlmRuntime.create({ mcp: makeMcp([]) }))
      .rejects.toThrow('no llama.cpp-compatible tools');
  });

  it('rejects strict scope when none of the discovered tools are trusted', async () => {
    await expect(DkgLocalLlmRuntime.create({ mcp: makeMcp(), strictProjectScope: true, projectId: 'graph' }))
      .rejects.toThrow('no tools compatible with the strict Context Graph scope');
  });

  it.each([
    [() => new Response('{'), 'returned invalid JSON'],
    [() => jsonResponse({ choices: [] }), 'returned no assistant choice'],
    [() => answerResponse('   '), 'returned an empty final answer'],
  ] as const)('rejects malformed model output without persisting a turn (%#)', async (response, error) => {
    const mcp = makeMcp();
    const fetcher = vi.fn<typeof fetch>(async () => response());
    const runtime = await DkgLocalLlmRuntime.create({ mcp, fetch: fetcher, profile: 'chat' });
    await expect(runtime.run('hello')).rejects.toThrow(error);
    expect(runtime.getSessionHistory()).toEqual([]);
    expect(mcp.callTool).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('rejects an empty prompt before inference', async () => {
    const fetcher = vi.fn();
    const runtime = await DkgLocalLlmRuntime.create({ mcp: makeMcp(), fetch: fetcher });
    await expect(runtime.run(' \n\t ')).rejects.toThrow('non-empty user prompt');
    expect(fetcher).not.toHaveBeenCalled();
    expect(runtime.getSessionHistory()).toEqual([]);
  });

  it('does not invent tools for an unavailable explicit profile', async () => {
    const fetcher = vi.fn();
    const runtime = await DkgLocalLlmRuntime.create({ mcp: makeMcp([catalogSave]), fetch: fetcher, profile: 'catalog' });
    await expect(runtime.run('list saved queries')).rejects.toThrow("no compatible tools for the 'catalog' profile");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('bounds repairs when a chat-only model insists on calling a tool', async () => {
    const mcp = makeMcp();
    const fetcher = vi.fn<typeof fetch>(async () => toolResponse('dkg_query_catalog_list', {}));
    const runtime = await DkgLocalLlmRuntime.create({ mcp, fetch: fetcher, profile: 'chat' });
    await expect(runtime.run('hello')).rejects.toThrow('One-retry limit reached');
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(mcp.callTool).not.toHaveBeenCalled();
    expect(runtime.getSessionHistory()).toEqual([]);
  });

  it('rejects a repeated unavailable tool call after one repair', async () => {
    const mcp = makeMcp();
    const fetcher = vi.fn<typeof fetch>(async () => toolResponse('unknown_tool', {}));
    const runtime = await DkgLocalLlmRuntime.create({ mcp, fetch: fetcher, profile: 'catalog' });
    await expect(runtime.run('list saved queries')).rejects.toThrow('retry repeated an unchanged failed tool call');
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(mcp.callTool).not.toHaveBeenCalled();
  });

  it('rejects parallel calls and permits a corrected single-tool round', async () => {
    const mcp = makeMcp([dkgStatus]);
    const fetcher = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ choices: [{ message: { tool_calls: [
        { id: 'one', function: { name: 'dkg_status', arguments: '{}' } },
        { id: 'two', function: { name: 'dkg_status', arguments: '{}' } },
      ] } }] }))
      .mockResolvedValueOnce(toolResponse('dkg_status', {}))
      .mockResolvedValueOnce(answerResponse('Node ready.'));
    const runtime = await DkgLocalLlmRuntime.create({ mcp, fetch: fetcher, profile: 'status' });
    expect((await runtime.run('node status')).answer).toBe('Node ready.');
    expect(mcp.callTool).toHaveBeenCalledExactlyOnceWith({ name: 'dkg_status', arguments: {} });
    expect(fetcher).toHaveBeenCalledTimes(3);
    const repair = JSON.parse(String(fetcher.mock.calls[1][1]?.body));
    expect(repair.messages.at(-1).content).toContain('exactly one is allowed per round');
  });

  it('fails after a second truncated answer and retains no discarded draft', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => truncatedAnswerResponse('partial'));
    const runtime = await DkgLocalLlmRuntime.create({ mcp: makeMcp(), fetch: fetcher, profile: 'chat' });
    await expect(runtime.run('hello')).rejects.toThrow('truncated the final answer twice');
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(runtime.getSessionHistory()).toEqual([]);
  });

  it('propagates a non-validation MCP failure without retrying or recording success', async () => {
    const mcp = makeMcp([dkgStatus]);
    mcp.callTool.mockResolvedValue({ isError: true });
    const fetcher = vi.fn<typeof fetch>(async () => toolResponse('dkg_status', {}));
    const runtime = await DkgLocalLlmRuntime.create({ mcp, fetch: fetcher, profile: 'status' });
    await expect(runtime.run('node status')).rejects.toThrow('dkg_status failed: unknown MCP error');
    expect(mcp.callTool).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(runtime.getSessionHistory()).toEqual([]);
  });
});
