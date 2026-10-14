import { describe, expect, it } from 'vitest';
import { classifyScopedContentGraph } from '../src/scoped-content-partition.js';

describe('normalized content partition scope', () => {
  const root = 'did:dkg:context-graph:team/graph';
  it.each([
    ['', 'content', undefined], ['_shared_memory/a/1', 'shared', undefined],
    ['_verifiable_memory/a/1', 'verified', undefined], ['assertion/agent-a/draft', 'draft', 'agent-a'],
    ['_working_memory/agent-a/draft/_named_graph/dXJuOmNoaWxk', 'draft', 'agent-a'],
  ] as const)('classifies root and registered subgraph identically: %s', (tail, kind, draftOwner) => {
    for (const sub of ['', 'code']) {
      const base = sub ? `${root}/${sub}` : root;
      const graph = tail ? `${base}/${tail}` : base;
      const registered = new Set([`${base}/assertion/agent-a/draft`, `${base}/_working_memory/agent-a/draft`]);
      expect(classifyScopedContentGraph(graph, 'team/graph', new Set(['code']), registered, new Set()))
        .toEqual({ graph, kind, ...(sub ? { subGraphName: sub } : {}), ...(draftOwner ? { draftOwner } : {}) });
    }
  });
  it.each(['_meta', '_private/a', '_rules/x', '_verifiable_memory/staging/x', '_working_memory/stranger/draft'])
    ('retains reserved and unregistered-draft fences: %s', tail => {
      for (const prefix of [root, `${root}/code`]) {
        expect(classifyScopedContentGraph(`${prefix}/${tail}`, 'team/graph', new Set(['code']), new Set(), new Set())).toBeUndefined();
      }
    });
  it('excludes known child graphs even when their name is a registered subgraph', () => {
    expect(classifyScopedContentGraph(`${root}/code/_verifiable_memory/a`, 'team/graph',
      new Set(['code']), new Set(), new Set([`${root}/code`]))).toBeUndefined();
  });
});
