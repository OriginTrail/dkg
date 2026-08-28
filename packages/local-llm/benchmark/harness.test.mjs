import { describe, expect, it } from 'vitest';
import {
  GuardedBenchmarkMcp,
  modelAssetLifecyclePass,
  validateBenchmarkCall,
} from './harness.mjs';

const target = {
  graphId: 'bench-1',
  assetName: 'models-1',
  fixtureAssetName: 'models-1-fixture',
};

describe('real-DKG benchmark guard', () => {
  it('locks graph, asset, and subgraph write targets', () => {
    expect(validateBenchmarkCall('dkg_context_graph_create', { id: 'other' }, target))
      .toContain('id must equal bench-1');
    expect(validateBenchmarkCall('dkg_knowledge_asset_write', {
      projectId: 'bench-1',
      name: 'other',
      subGraphName: 'wrong',
    }, target)).toEqual([
      'name must equal models-1',
      'subGraphName must equal model-families',
    ]);
  });

  it('allows omitted optional projectId but rejects an explicit graph escape', () => {
    expect(validateBenchmarkCall('dkg_query_catalog_run', {
      selector: 'models/by-category',
    }, target)).toEqual([]);
    expect(validateBenchmarkCall('dkg_query_catalog_run', {
      projectId: 'other',
      selector: 'models/by-category',
    }, target)).toContain('projectId must equal bench-1');
  });

  it('rejects publish even when a model asks for it', async () => {
    const delegate = {
      async listTools() { return { tools: [] }; },
      async callTool() { return { content: [{ type: 'text', text: 'should not run' }] }; },
    };
    const mcp = new GuardedBenchmarkMcp(delegate, target);
    const result = await mcp.callTool({
      name: 'dkg_knowledge_asset_publish',
      arguments: { projectId: 'bench-1', name: 'models-1' },
    });
    expect(result.isError).toBe(true);
    expect(mcp.records[0].text).toContain('outside the benchmark mutation allowlist');
  });
});

describe('asset lifecycle scoring', () => {
  it('accepts both one-shot and stepwise sealed assets with ten model-authored quads', () => {
    const base = { isError: false, source: 'model' };
    expect(modelAssetLifecyclePass([{
      ...base,
      name: 'dkg_knowledge_asset_create',
      args: { name: 'models-1', quads: Array.from({ length: 10 }, () => ({})) },
    }], target)).toBe(true);
    expect(modelAssetLifecyclePass([
      { ...base, name: 'dkg_knowledge_asset_create', args: { name: 'models-1' } },
      { ...base, name: 'dkg_knowledge_asset_write', args: { name: 'models-1', quads: Array.from({ length: 10 }, () => ({})) } },
      { ...base, name: 'dkg_knowledge_asset_finalize', args: { name: 'models-1' } },
    ], target)).toBe(true);
  });
});
