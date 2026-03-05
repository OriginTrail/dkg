import { describe, it, expect, beforeEach } from 'vitest';
import { GraphModel } from '../src/core/graph-model.js';
import { FocusFilter } from '../src/core/focus-filter.js';

function buildChain(model: GraphModel, count: number): void {
  for (let i = 0; i < count; i++) {
    model.addTriple({
      subject: `urn:node${i}`,
      predicate: 'http://example.org/next',
      object: `urn:node${i + 1}`,
    });
  }
}

function buildStar(model: GraphModel, center: string, spokes: number): void {
  for (let i = 0; i < spokes; i++) {
    model.addTriple({
      subject: center,
      predicate: 'http://example.org/link',
      object: `urn:spoke${i}`,
    });
  }
}

describe('FocusFilter', () => {
  let model: GraphModel;

  beforeEach(() => {
    model = new GraphModel();
  });

  it('returns all nodes when graph is smaller than maxNodes', () => {
    buildChain(model, 3);
    const filter = new FocusFilter({ maxNodes: 200, hops: 2 });
    const result = filter.compute(model);
    expect(result.nodes.size).toBe(model.nodes.size);
    expect(result.edges.size).toBe(model.edges.size);
    expect(filter.enabled).toBe(false);
  });

  it('enables focus mode for large graphs', () => {
    buildStar(model, 'urn:hub', 10);
    const filter = new FocusFilter({ maxNodes: 5, hops: 1 });
    const result = filter.compute(model);
    expect(filter.enabled).toBe(true);
    expect(result.nodes.size).toBeLessThanOrEqual(5);
  });

  it('respects hops config — only includes nodes within N hops', () => {
    buildChain(model, 20);
    const filter = new FocusFilter({ maxNodes: 5, hops: 1, focalNode: 'urn:node10' });
    const result = filter.compute(model);

    expect(result.nodes.has('urn:node10')).toBe(true);
    expect(result.nodes.has('urn:node9') || result.nodes.has('urn:node11')).toBe(true);
    // 3+ hops away should not be visible
    expect(result.nodes.has('urn:node0')).toBe(false);
  });

  it('respects maxNodes — stops BFS when limit reached', () => {
    buildStar(model, 'urn:hub', 50);
    const filter = new FocusFilter({ maxNodes: 10, hops: 5, focalNode: 'urn:hub' });
    const result = filter.compute(model);
    expect(result.nodes.size).toBeLessThanOrEqual(10);
  });

  it('marks boundary nodes correctly', () => {
    buildStar(model, 'urn:center', 20);
    const filter = new FocusFilter({ maxNodes: 5, hops: 1, focalNode: 'urn:center' });
    const result = filter.compute(model);

    // Boundary nodes have hidden neighbors
    let hasBoundary = false;
    for (const node of result.nodes.values()) {
      if (node.isBoundary) hasBoundary = true;
    }
    expect(hasBoundary).toBe(true);
  });

  it('center node is not marked as boundary when all neighbors visible', () => {
    buildStar(model, 'urn:center', 3);
    const filter = new FocusFilter({ maxNodes: 200, hops: 2, focalNode: 'urn:center' });
    const result = filter.compute(model);
    const center = result.nodes.get('urn:center');
    expect(center).toBeDefined();
    expect(center!.isBoundary).toBe(false);
  });

  it('auto-selects highest-degree node when no focal node set', () => {
    buildStar(model, 'urn:hub', 15);
    model.addTriple({ subject: 'urn:isolated', predicate: 'http://ex.org/p', object: 'urn:other' });
    const filter = new FocusFilter({ maxNodes: 5, hops: 2 });
    filter.compute(model);
    expect(filter.focalNode).toBe('urn:hub');
  });

  it('only includes edges between visible nodes', () => {
    buildChain(model, 30);
    const filter = new FocusFilter({ maxNodes: 5, hops: 1, focalNode: 'urn:node15' });
    const result = filter.compute(model);

    for (const edge of result.edges.values()) {
      expect(result.nodes.has(edge.source)).toBe(true);
      expect(result.nodes.has(edge.target)).toBe(true);
    }
  });

  describe('setFocus', () => {
    it('changes the focal node', () => {
      const filter = new FocusFilter({ maxNodes: 5, hops: 1 });
      filter.setFocus('urn:newFocal');
      expect(filter.focalNode).toBe('urn:newFocal');
    });

    it('accepts null to reset', () => {
      const filter = new FocusFilter({ maxNodes: 5, hops: 1, focalNode: 'urn:x' });
      filter.setFocus(null);
      expect(filter.focalNode).toBeNull();
    });
  });

  describe('expandNode', () => {
    it('adds immediate neighbors to the visible set', () => {
      buildStar(model, 'urn:hub', 20);
      const filter = new FocusFilter({ maxNodes: 5, hops: 0, focalNode: 'urn:hub' });
      filter.compute(model);

      const visibleBefore = filter.visibleNodeIds.size;
      filter.expandNode('urn:hub', model);
      expect(filter.visibleNodeIds.size).toBeGreaterThan(visibleBefore);
    });
  });

  describe('disable / enable', () => {
    it('disable clears visible nodes and sets enabled to false', () => {
      const filter = new FocusFilter({ maxNodes: 5, hops: 1 });
      filter.enable('urn:x');
      filter.disable();
      expect(filter.enabled).toBe(false);
    });

    it('enable re-enables with optional new focal node', () => {
      const filter = new FocusFilter({ maxNodes: 5, hops: 1 });
      filter.disable();
      filter.enable('urn:new');
      expect(filter.enabled).toBe(true);
      expect(filter.focalNode).toBe('urn:new');
    });
  });

  it('returns empty maps when focal node not found in graph', () => {
    const filter = new FocusFilter({ maxNodes: 0, hops: 1, focalNode: null });
    const result = filter.compute(model);
    expect(result.nodes.size).toBe(0);
    expect(result.edges.size).toBe(0);
  });
});
