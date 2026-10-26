import { describe, expect, it, vi } from 'vitest';
import { DkgLocalLlmRuntime } from '../src/runtime.js';
import { makeMcp, toolResponse, answerResponse } from './helpers/runtime-fixtures.js';

describe('catalog scope from legacy textual evidence', () => {
  it.each(['contextGraphId', 'arguments'] as const)('retains catalog scope from %s across turns', async source => {
    const mcp = makeMcp();
    mcp.callTool.mockResolvedValueOnce({ content: [{ type: 'text', text:
      'Structured DKG evidence (authoritative):\n' + JSON.stringify({
        ...(source === 'contextGraphId' ? { contextGraphId: 'evidence-graph' } : {}),
        items: [null, [], { name: 'other' }, { selector: 'chosen' }],
      }),
    }] }).mockResolvedValueOnce({ content: [{ type: 'text', text: 'query result' }] });
    const fetcher = vi.fn()
      .mockResolvedValueOnce(toolResponse('dkg_query_catalog_list', { projectId: 'listed-graph' }))
      .mockResolvedValueOnce(answerResponse('The chosen query is available.'))
      .mockResolvedValueOnce(toolResponse('dkg_query_catalog_run', { selector: 'chosen' }))
      .mockResolvedValueOnce(answerResponse('The query returned data.'));
    const runtime = await DkgLocalLlmRuntime.create({ mcp, fetch: fetcher, projectId: 'session-graph', profile: 'catalog' });
    await runtime.run('list saved queries');
    const result = await runtime.run('run the chosen saved query', { captureEvidence: true });
    const projectId = source === 'contextGraphId' ? 'evidence-graph' : 'listed-graph';
    expect(mcp.callTool).toHaveBeenNthCalledWith(2, { name: 'dkg_query_catalog_run', arguments: { selector: 'chosen', projectId } });
    expect(result.answer).toBe('The query returned data.');
    expect(result.evidence).toEqual([{ name: 'dkg_query_catalog_run', arguments: { selector: 'chosen', projectId }, result: 'query result' }]);
  });

  it.each(['{broken', 'null', '[]', '{"items":[]}'])('does not invent scope from malformed or unmatched evidence %s', async text => {
    const mcp = makeMcp();
    mcp.callTool.mockResolvedValueOnce({ content: [{ type: 'text', text: `Structured DKG evidence (authoritative):\n${text}` }] });
    const fetcher = vi.fn()
      .mockResolvedValueOnce(toolResponse('dkg_query_catalog_list', { projectId: 'other-graph' }))
      .mockResolvedValueOnce(answerResponse('No matching saved query.'))
      .mockResolvedValueOnce(toolResponse('dkg_query_catalog_run', { selector: 'explicitly-requested' }))
      .mockResolvedValueOnce(answerResponse('Done.'));
    const runtime = await DkgLocalLlmRuntime.create({ mcp, fetch: fetcher, projectId: 'session-graph', profile: 'catalog' });
    await runtime.run('list saved queries');
    await runtime.run('run explicitly-requested');
    expect(mcp.callTool).toHaveBeenNthCalledWith(2, { name: 'dkg_query_catalog_run', arguments: { selector: 'explicitly-requested', projectId: 'session-graph' } });
  });
});
