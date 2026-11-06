import { describe, expect, it } from 'vitest';
import { assignContextGraphSlots, contextGraphColor, contextGraphIdFromTab, CONTEXT_GRAPH_SLOTS } from '../src/ui/context-graph-colors.js';

describe('Context Graph identity colour', () => {
  const ids = ['cg:pharma-drug-interactions', 'cg:climate-science', 'cg:supply-chain-eu', 'agent-context'];

  it('gives up to 8 graphs distinct slots', () => {
    const eight = Array.from({ length: CONTEXT_GRAPH_SLOTS }, (_, i) => `cg:graph-${i}`);
    const slots = assignContextGraphSlots(eight);
    expect(new Set(slots.values()).size).toBe(CONTEXT_GRAPH_SLOTS);
    for (const s of slots.values()) expect(s).toBeGreaterThanOrEqual(1);
  });

  it('is deterministic and independent of list order', () => {
    const a = assignContextGraphSlots(ids);
    const b = assignContextGraphSlots([...ids].reverse());
    for (const id of ids) expect(a.get(id)).toBe(b.get(id));
  });

  it('returns a data-palette token, never a layer or signal colour', () => {
    expect(contextGraphColor('agent-context', ids)).toMatch(/^var\(--data-[1-8]\)$/);
  });

  it('maps context-graph tabs only', () => {
    expect(contextGraphIdFromTab('project:agent-context')).toBe('agent-context');
    expect(contextGraphIdFromTab('dashboard')).toBeNull();
  });
});

import { contextGraphInitial } from '../src/ui/context-graph-colors.js';
describe('Context Graph monogram', () => {
  it('uses the first letter or digit of the name, uppercased', () => {
    expect(contextGraphInitial('agent context')).toBe('A');
    expect(contextGraphInitial('  #2026 audits')).toBe('2');
    expect(contextGraphInitial('', 'cg:climate-science')).toBe('C');
    expect(contextGraphInitial(undefined)).toBe('?');
  });
});
