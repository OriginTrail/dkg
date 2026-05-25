import { describe, it, expect, beforeEach } from 'vitest';
import { GraphModel } from '../src/core/graph-model.js';

describe('GraphModel', () => {
  let model: GraphModel;

  beforeEach(() => {
    model = new GraphModel();
  });

  describe('addTriple', () => {
    it('creates subject node for URI-object triple', () => {
      model.addTriple({
        subject: 'https://example.org/alice',
        predicate: 'https://schema.org/knows',
        object: 'https://example.org/bob',
      });

      expect(model.nodes.has('https://example.org/alice')).toBe(true);
      expect(model.nodes.has('https://example.org/bob')).toBe(true);
    });

    it('creates an edge for URI-object triple', () => {
      model.addTriple({
        subject: 'https://example.org/alice',
        predicate: 'https://schema.org/knows',
        object: 'https://example.org/bob',
      });

      expect(model.edges.size).toBe(1);
      const edge = [...model.edges.values()][0];
      expect(edge.source).toBe('https://example.org/alice');
      expect(edge.target).toBe('https://example.org/bob');
      expect(edge.predicate).toBe('https://schema.org/knows');
    });

    it('stores literal objects as properties, not edges', () => {
      model.addTriple({
        subject: 'https://example.org/alice',
        predicate: 'https://schema.org/name',
        object: 'Alice',
      });

      expect(model.edges.size).toBe(0);
      const node = model.nodes.get('https://example.org/alice')!;
      const names = node.properties.get('https://schema.org/name');
      expect(names).toHaveLength(1);
      expect(names![0].value).toBe('Alice');
    });

    it('creates edges for absolute IRI schemes beyond http and urn', () => {
      model.addTriple({
        subject: 'did:dkg:entity:source',
        predicate: 'https://schema.org/mentions',
        object: 'ipfs://bafy-example-target',
      });

      expect(model.edges.size).toBe(1);
      expect(model.nodes.has('did:dkg:entity:source')).toBe(true);
      expect(model.nodes.has('ipfs://bafy-example-target')).toBe(true);
    });

    it('keeps quoted values with URI-like text as literals', () => {
      model.addTriple({
        subject: 'https://example.org/alice',
        predicate: 'https://schema.org/identifier',
        object: '"did:dkg:literal"',
      });

      expect(model.edges.size).toBe(0);
      const node = model.nodes.get('https://example.org/alice')!;
      expect(node.properties.get('https://schema.org/identifier')?.[0]?.value).toBe('"did:dkg:literal"');
    });

    it('stores rdf:type in node.types, not as edge', () => {
      model.addTriple({
        subject: 'https://example.org/alice',
        predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type',
        object: 'https://schema.org/Person',
      });

      expect(model.edges.size).toBe(0);
      const node = model.nodes.get('https://example.org/alice')!;
      expect(node.types).toContain('https://schema.org/Person');
    });

    it('increments degree on both endpoints', () => {
      model.addTriple({
        subject: 'https://example.org/alice',
        predicate: 'https://schema.org/knows',
        object: 'https://example.org/bob',
      });

      expect(model.nodes.get('https://example.org/alice')!.degree).toBe(1);
      expect(model.nodes.get('https://example.org/bob')!.degree).toBe(1);
    });

    it('deduplicates edges by subject+predicate+object', () => {
      const triple = {
        subject: 'https://example.org/alice',
        predicate: 'https://schema.org/knows',
        object: 'https://example.org/bob',
      };
      model.addTriple(triple);
      model.addTriple(triple);

      expect(model.edges.size).toBe(1);
      expect(model.nodes.get('https://example.org/alice')!.degree).toBe(1);
    });

    it('strips angle brackets from URIs', () => {
      model.addTriple({
        subject: '<https://example.org/alice>',
        predicate: '<https://schema.org/knows>',
        object: '<https://example.org/bob>',
      });

      expect(model.nodes.has('https://example.org/alice')).toBe(true);
      expect(model.nodes.has('https://example.org/bob')).toBe(true);
    });
  });

  describe('metadata predicates', () => {
    it('stores metadata-predicate values in metadata map, not as edges', () => {
      const m = new GraphModel(['https://prov.org/source']);
      m.addTriple({
        subject: 'https://example.org/post1',
        predicate: 'https://prov.org/source',
        object: 'https://example.org/datasource',
      });

      expect(m.edges.size).toBe(0);
      const node = m.nodes.get('https://example.org/post1')!;
      const meta = node.metadata.get('https://prov.org/source');
      expect(meta).toHaveLength(1);
      expect(meta![0].value).toBe('https://example.org/datasource');
    });
  });

  describe('adjacency index', () => {
    it('getEdgesFrom returns only outgoing edges', () => {
      model.addTriple({
        subject: 'https://example.org/a',
        predicate: 'https://schema.org/knows',
        object: 'https://example.org/b',
      });
      model.addTriple({
        subject: 'https://example.org/b',
        predicate: 'https://schema.org/knows',
        object: 'https://example.org/c',
      });

      const fromA = model.getEdgesFrom('https://example.org/a');
      expect(fromA).toHaveLength(1);
      expect(fromA[0].target).toBe('https://example.org/b');

      const fromB = model.getEdgesFrom('https://example.org/b');
      expect(fromB).toHaveLength(1);
      expect(fromB[0].target).toBe('https://example.org/c');
    });

    it('getEdgesTo returns only incoming edges', () => {
      model.addTriple({
        subject: 'https://example.org/a',
        predicate: 'https://schema.org/knows',
        object: 'https://example.org/b',
      });

      const toB = model.getEdgesTo('https://example.org/b');
      expect(toB).toHaveLength(1);
      expect(toB[0].source).toBe('https://example.org/a');

      const toA = model.getEdgesTo('https://example.org/a');
      expect(toA).toHaveLength(0);
    });

    it('getNeighborIds returns neighbors from both directions', () => {
      model.addTriple({
        subject: 'https://example.org/a',
        predicate: 'https://schema.org/knows',
        object: 'https://example.org/b',
      });
      model.addTriple({
        subject: 'https://example.org/c',
        predicate: 'https://schema.org/knows',
        object: 'https://example.org/b',
      });

      const neighbors = model.getNeighborIds('https://example.org/b');
      expect(neighbors.size).toBe(2);
      expect(neighbors.has('https://example.org/a')).toBe(true);
      expect(neighbors.has('https://example.org/c')).toBe(true);
    });

    it('returns empty results for unknown node IDs', () => {
      expect(model.getEdgesFrom('https://example.org/unknown')).toEqual([]);
      expect(model.getEdgesTo('https://example.org/unknown')).toEqual([]);
      expect(model.getNeighborIds('https://example.org/unknown').size).toBe(0);
    });
  });

  describe('removeTriples', () => {
    it('removes edge and decrements degree', () => {
      const triple = {
        subject: 'https://example.org/alice',
        predicate: 'https://schema.org/knows',
        object: 'https://example.org/bob',
      };
      model.addTriple(triple);
      model.removeTriples([triple]);

      expect(model.edges.size).toBe(0);
      // Orphan nodes with no data are cleaned up
    });

    it('updates adjacency index on removal', () => {
      model.addTriple({
        subject: 'https://example.org/a',
        predicate: 'https://schema.org/knows',
        object: 'https://example.org/b',
      });
      model.addTriple({
        subject: 'https://example.org/a',
        predicate: 'https://schema.org/likes',
        object: 'https://example.org/c',
      });

      model.removeTriples([{
        subject: 'https://example.org/a',
        predicate: 'https://schema.org/knows',
        object: 'https://example.org/b',
      }]);

      const fromA = model.getEdgesFrom('https://example.org/a');
      expect(fromA).toHaveLength(1);
      expect(fromA[0].predicate).toBe('https://schema.org/likes');
    });
  });

  describe('clear', () => {
    it('resets all state including adjacency indexes', () => {
      model.addTriple({
        subject: 'https://example.org/a',
        predicate: 'https://schema.org/knows',
        object: 'https://example.org/b',
      });

      model.clear();

      expect(model.nodes.size).toBe(0);
      expect(model.edges.size).toBe(0);
      expect(model.tripleCount).toBe(0);
      expect(model.getEdgesFrom('https://example.org/a')).toEqual([]);
    });
  });

  describe('addTriples', () => {
    it('returns correct changeset', () => {
      const changes = model.addTriples([
        { subject: 'https://example.org/a', predicate: 'https://schema.org/knows', object: 'https://example.org/b' },
        { subject: 'https://example.org/a', predicate: 'https://schema.org/name', object: 'Alice' },
      ]);

      expect(changes.addedNodes).toContain('https://example.org/a');
      expect(changes.addedNodes).toContain('https://example.org/b');
      expect(changes.addedEdges).toHaveLength(1);
      expect(changes.removedNodes).toHaveLength(0);
    });
  });

  describe('getHighestDegreeNode', () => {
    it('returns the node with the most edges', () => {
      model.addTriple({ subject: 'https://example.org/hub', predicate: 'https://schema.org/knows', object: 'https://example.org/a' });
      model.addTriple({ subject: 'https://example.org/hub', predicate: 'https://schema.org/knows', object: 'https://example.org/b' });
      model.addTriple({ subject: 'https://example.org/hub', predicate: 'https://schema.org/knows', object: 'https://example.org/c' });

      const best = model.getHighestDegreeNode()!;
      expect(best.id).toBe('https://example.org/hub');
      expect(best.degree).toBe(3);
    });
  });
});
