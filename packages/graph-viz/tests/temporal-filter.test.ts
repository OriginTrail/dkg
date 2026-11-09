import { describe, it, expect, beforeEach } from 'vitest';
import { GraphModel } from '../src/core/graph-model.js';
import { TemporalFilter } from '../src/core/temporal-filter.js';

function addDatedNode(
  model: GraphModel,
  uri: string,
  isoDate: string,
  predicate: string = 'https://schema.org/dateCreated',
) {
  model.addTriple({
    subject: uri,
    predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type',
    object: 'https://schema.org/SocialMediaPosting',
  });
  model.addTriple({
    subject: uri,
    predicate,
    object: isoDate,
  });
}

function addUndatedNode(model: GraphModel, uri: string) {
  model.addTriple({
    subject: uri,
    predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type',
    object: 'https://schema.org/Thing',
  });
}

describe('TemporalFilter', () => {
  let model: GraphModel;
  let filter: TemporalFilter;

  beforeEach(() => {
    model = new GraphModel();
    filter = new TemporalFilter();
  });

  // ------- Scanning -------

  describe('scan', () => {
    it('extracts date range from nodes with schema:dateCreated', () => {
      addDatedNode(model, 'https://example.org/post1', '2025-01-15T10:00:00');
      addDatedNode(model, 'https://example.org/post2', '2025-06-20T15:30:00');
      addDatedNode(model, 'https://example.org/post3', '2025-03-01T08:00:00');

      filter.scan(model);

      const range = filter.dateRange;
      expect(range).not.toBeNull();
      expect(range![0].toISOString()).toContain('2025-01-15');
      expect(range![1].toISOString()).toContain('2025-06-20');
    });

    it('extracts dates from guardiankg.org namespace', () => {
      addDatedNode(
        model,
        'https://example.org/post1',
        '2025-02-01T12:00:00',
        'https://guardiankg.org/vocab/dateCreated',
      );

      filter.scan(model);

      expect(filter.dateRange).not.toBeNull();
      expect(filter.datedNodeCount).toBe(1);
    });

    it('returns null dateRange when no dates found', () => {
      addUndatedNode(model, 'https://example.org/thing');

      filter.scan(model);

      expect(filter.dateRange).toBeNull();
      expect(filter.datedNodeCount).toBe(0);
    });

    it('counts dated nodes correctly', () => {
      addDatedNode(model, 'https://example.org/a', '2025-01-01');
      addDatedNode(model, 'https://example.org/b', '2025-02-01');
      addUndatedNode(model, 'https://example.org/c');

      filter.scan(model);

      expect(filter.datedNodeCount).toBe(2);
    });

    it('handles mixed dated and undated nodes', () => {
      addDatedNode(model, 'https://example.org/dated', '2025-06-15');
      addUndatedNode(model, 'https://example.org/undated');

      filter.scan(model);

      expect(filter.dateRange).not.toBeNull();
      expect(filter.datedNodeCount).toBe(1);
    });

    it('ignores invalid date values', () => {
      model.addTriple({
        subject: 'https://example.org/bad',
        predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type',
        object: 'https://schema.org/Thing',
      });
      model.addTriple({
        subject: 'https://example.org/bad',
        predicate: 'https://schema.org/dateCreated',
        object: 'not-a-date',
      });

      filter.scan(model);
      expect(filter.dateRange).toBeNull();
    });
  });

  // ------- Cursor and filtering -------

  describe('setCursor / getVisibleNodeIds', () => {
    it('shows only nodes with date <= cursor', () => {
      addDatedNode(model, 'https://example.org/jan', '2025-01-15');
      addDatedNode(model, 'https://example.org/mar', '2025-03-15');
      addDatedNode(model, 'https://example.org/jun', '2025-06-15');

      filter.scan(model);
      filter.setCursor(new Date('2025-04-01'));

      const visible = filter.getVisibleNodeIds(model.nodes.keys());
      expect(visible).not.toBeNull();
      expect(visible!.has('https://example.org/jan')).toBe(true);
      expect(visible!.has('https://example.org/mar')).toBe(true);
      expect(visible!.has('https://example.org/jun')).toBe(false);
    });

    it('shows all nodes when cursor is at latest date', () => {
      addDatedNode(model, 'https://example.org/a', '2025-01-01');
      addDatedNode(model, 'https://example.org/b', '2025-12-31');

      filter.scan(model);
      // Default cursor is at latest
      const visible = filter.getVisibleNodeIds(model.nodes.keys());
      expect(visible).not.toBeNull();
      expect(visible!.size).toBe(2);
    });

    it('shows only earliest node when cursor is at earliest date', () => {
      addDatedNode(model, 'https://example.org/early', '2025-01-01T00:00:00');
      addDatedNode(model, 'https://example.org/late', '2025-12-31T23:59:59');

      filter.scan(model);
      filter.setCursor(new Date('2025-01-01T00:00:00'));

      const visible = filter.getVisibleNodeIds(model.nodes.keys());
      expect(visible).not.toBeNull();
      expect(visible!.has('https://example.org/early')).toBe(true);
      expect(visible!.has('https://example.org/late')).toBe(false);
    });

    it('includes undated nodes when showUndated is true (default)', () => {
      addDatedNode(model, 'https://example.org/dated', '2025-06-15');
      addUndatedNode(model, 'https://example.org/undated');

      filter.scan(model);
      filter.setCursor(new Date('2025-06-15'));

      const visible = filter.getVisibleNodeIds(model.nodes.keys());
      expect(visible).not.toBeNull();
      expect(visible!.has('https://example.org/dated')).toBe(true);
      expect(visible!.has('https://example.org/undated')).toBe(true);
    });

    it('excludes undated nodes when showUndated is false', () => {
      const strictFilter = new TemporalFilter({ showUndated: false, enabled: true });

      addDatedNode(model, 'https://example.org/dated', '2025-06-15');
      addUndatedNode(model, 'https://example.org/undated');

      strictFilter.scan(model);
      strictFilter.setCursor(new Date('2025-06-15'));

      const visible = strictFilter.getVisibleNodeIds(model.nodes.keys());
      expect(visible).not.toBeNull();
      expect(visible!.has('https://example.org/dated')).toBe(true);
      expect(visible!.has('https://example.org/undated')).toBe(false);
    });

    it('returns null when no dates found (no filtering)', () => {
      addUndatedNode(model, 'https://example.org/a');

      filter.scan(model);

      const visible = filter.getVisibleNodeIds(model.nodes.keys());
      expect(visible).toBeNull();
    });
  });

  // ------- getNodeDate -------

  describe('getNodeDate', () => {
    it('returns the date for a dated node', () => {
      addDatedNode(model, 'https://example.org/post', '2025-05-10T14:30:00');

      filter.scan(model);

      const date = filter.getNodeDate('https://example.org/post');
      expect(date).not.toBeNull();
      expect(date!.toISOString()).toContain('2025-05-10');
    });

    it('returns null for an undated node', () => {
      addUndatedNode(model, 'https://example.org/thing');

      filter.scan(model);

      expect(filter.getNodeDate('https://example.org/thing')).toBeNull();
    });

    it('returns null for unknown node', () => {
      filter.scan(model);
      expect(filter.getNodeDate('https://example.org/nonexistent')).toBeNull();
    });
  });

  // ------- Histogram -------

  describe('computeHistogram', () => {
    it('returns buckets with correct distribution', () => {
      addDatedNode(model, 'https://example.org/a', '2025-01-01');
      addDatedNode(model, 'https://example.org/b', '2025-01-02');
      addDatedNode(model, 'https://example.org/c', '2025-06-15');
      addDatedNode(model, 'https://example.org/d', '2025-12-31');

      filter.scan(model);

      const buckets = filter.computeHistogram(10);
      expect(buckets.length).toBe(10);

      // Total count across all buckets should equal dated node count
      const total = buckets.reduce((sum, b) => sum + b.count, 0);
      expect(total).toBe(4);
    });

    it('returns empty array when no dates found', () => {
      addUndatedNode(model, 'https://example.org/a');
      filter.scan(model);

      expect(filter.computeHistogram()).toEqual([]);
    });

    it('handles single-date case', () => {
      addDatedNode(model, 'https://example.org/a', '2025-05-01');
      addDatedNode(model, 'https://example.org/b', '2025-05-01');

      filter.scan(model);

      const buckets = filter.computeHistogram(5);
      expect(buckets.length).toBe(1);
      expect(buckets[0].count).toBe(2);
    });
  });

  // ------- Custom date properties -------

  describe('custom date properties', () => {
    it('scans custom property names across namespaces', () => {
      const customFilter = new TemporalFilter({
        dateProperties: ['generatedAtTime'],
        enabled: true,
      });

      model.addTriple({
        subject: 'https://example.org/decision',
        predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type',
        object: 'https://schema.org/Thing',
      });
      model.addTriple({
        subject: 'https://example.org/decision',
        predicate: 'http://www.w3.org/ns/prov#generatedAtTime',
        object: '2025-02-15T22:23:51',
      });

      customFilter.scan(model);

      expect(customFilter.dateRange).not.toBeNull();
      expect(customFilter.datedNodeCount).toBe(1);
    });
  });

  // ------- Edge cases -------

  describe('edge cases', () => {
    it('handles empty model', () => {
      filter.scan(model);
      expect(filter.dateRange).toBeNull();
      expect(filter.cursor).toBeNull();
      expect(filter.datedNodeCount).toBe(0);
      expect(filter.getVisibleNodeIds(model.nodes.keys())).toBeNull();
    });

    it('re-scanning clears previous state', () => {
      addDatedNode(model, 'https://example.org/a', '2025-01-01');
      filter.scan(model);
      expect(filter.datedNodeCount).toBe(1);

      // Create fresh model with different data
      const model2 = new GraphModel();
      addDatedNode(model2, 'https://example.org/x', '2025-06-01');
      addDatedNode(model2, 'https://example.org/y', '2025-07-01');
      filter.scan(model2);
      expect(filter.datedNodeCount).toBe(2);
    });
  });
});


describe('TemporalFilter undated and malformed values', () => {
  it('controls undated temporal visibility', () => {
    const model = new GraphModel();
    addDatedNode(model, 'urn:dated', '2025-01-01');
    addUndatedNode(model, 'urn:undated');
    const filter = new TemporalFilter();
    filter.scan(model);
    expect(filter.showUndated).toBe(true);
    filter.showUndated = false;
    expect(filter.getVisibleNodeIds(model.nodes.keys())).toEqual(new Set(['urn:dated']));
    expect(filter.getNodeDate('missing')).toBeNull();
    expect(filter.getNodeDate('urn:dated')).toEqual(new Date('2025-01-01'));
  });
  it('ignores invalid and empty date values while finding the earliest valid namespace variant', () => {
    const model = new GraphModel();
    addDatedNode(model, 'urn:a', 'invalid');
    addDatedNode(model, 'urn:b', '2025-03-01');
    model.getNode('urn:a')!.properties.set('http://schema.org/dateCreated', []);
    model.getNode('urn:b')!.properties.set('http://schema.org/dateCreated', [{ value: '2025-01-01' }]);
    const filter = new TemporalFilter();
    filter.scan(model);
    expect(filter.getNodeDate('urn:a')).toBeNull();
    expect(filter.getNodeDate('urn:b')).toEqual(new Date('2025-01-01'));
    expect(filter.datedNodeCount).toBe(1);
  });
});
