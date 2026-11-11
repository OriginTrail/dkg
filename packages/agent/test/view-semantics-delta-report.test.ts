import { describe, expect, it, vi } from 'vitest';
import type { ViewSemanticsDeltaSummary } from '@origintrail-official/dkg-query';
import { readableViewSemanticsDeltaReport } from '../src/view-semantics-delta-report.js';

const summary = (contextGraphId: string): ViewSemanticsDeltaSummary => ({
  contextGraphId, since: '2026-11-11T02:00:00.000Z', samples: 3, skipped: 0, uncomparable: 0,
  kinds: { 'none': 3, 'copies-removed': 0, 'rows-added': 0, 'rows-removed-or-changed': 0 }, shapes: [],
});

describe('the semantic-delta report a caller gets', () => {
  it('holds only the context graphs the caller may read, leaving out any whose check fails', async () => {
    const viewSemanticsDeltaReport = vi.fn(() => [summary('a'), summary('b'), summary('c')]);
    const canReadContextGraph = vi.fn(async (contextGraphId: string) => {
      if (contextGraphId === 'c') throw new Error('authority unavailable');
      return contextGraphId === 'a';
    });
    const agent = { queryEngine: { viewSemanticsDeltaReport }, canReadContextGraph };
    const readable = await readableViewSemanticsDeltaReport(agent, { callerAgentAddress: '0xabc' });
    expect(readable.map(entry => entry.contextGraphId)).toEqual(['a']);
    expect(canReadContextGraph).toHaveBeenCalledWith('b', { callerAgentAddress: '0xabc' });
    expect(viewSemanticsDeltaReport).toHaveBeenCalledWith(undefined);
    await readableViewSemanticsDeltaReport(agent, { contextGraphId: 'a' });
    expect(viewSemanticsDeltaReport).toHaveBeenLastCalledWith(['a']);
  });
});
