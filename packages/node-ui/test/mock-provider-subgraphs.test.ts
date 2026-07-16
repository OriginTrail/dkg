import { describe, expect, it } from 'vitest';
import { mockApi } from '../src/ui/mocks/provider.js';
import { MOCK_SUBGRAPHS } from '../src/ui/mocks/data.js';

describe('mock sub-graph API', () => {
  it('exports typed fixtures and returns a scoped empty list by default', async () => {
    expect(MOCK_SUBGRAPHS).toEqual({});
    await expect(mockApi.fetchSubGraphs('cg:missing')).resolves.toEqual({
      contextGraphId: 'cg:missing',
      subGraphs: [],
    });
  });
});
