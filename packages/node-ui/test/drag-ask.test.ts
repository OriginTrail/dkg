// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { buildDragAskRequest } from '../src/ui/views/DragAskView.js';

describe('dRAG Ask request contract', () => {
  it('never sends local-only retrieval or stale rules in network scope', () => {
    expect(buildDragAskRequest({
      question: 'Which supplier was flagged?',
      contextGraphId: ' supply-cg ',
      scope: 'network',
      retrieval: 'semantic',
      reason: true,
      rules: '{ ?s ?p ?o } => { ?s ?p ?o } .',
    })).toEqual({
      question: 'Which supplier was flagged?',
      contextGraphId: 'supply-cg',
      scope: 'network',
      retrieval: undefined,
      reason: false,
      rules: undefined,
    });
  });

  it('sends custom rules only with explicitly enabled local reasoning', () => {
    const base = {
      question: 'Which supplier was flagged?',
      contextGraphId: 'supply-cg',
      scope: 'local' as const,
      retrieval: 'keyword' as const,
      rules: '  { ?s ?p ?o } => { ?s ?p ?o } .  ',
    };
    expect(buildDragAskRequest({ ...base, reason: false }).rules).toBeUndefined();
    expect(buildDragAskRequest({ ...base, reason: true }).rules).toBe('{ ?s ?p ?o } => { ?s ?p ?o } .');
  });
});
