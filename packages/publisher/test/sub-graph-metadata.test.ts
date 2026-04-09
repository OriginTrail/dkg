import { describe, it, expect } from 'vitest';
import {
  generateSubGraphRegistration,
  subGraphDiscoverySparql,
  subGraphWritersSparql,
  subGraphDeregistrationSparql,
} from '../src/metadata.js';

const DKG = 'http://dkg.io/ontology/';
const SCHEMA = 'http://schema.org/';
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';

describe('generateSubGraphRegistration', () => {
  const reg = {
    contextGraphId: 'dkg-v10-dev',
    subGraphName: 'code',
    createdBy: '0xAbc123',
    timestamp: new Date('2026-04-07T10:00:00Z'),
  };

  it('generates correct type triple', () => {
    const quads = generateSubGraphRegistration(reg);
    const typeQuad = quads.find(q => q.predicate === `${RDF}type`);
    expect(typeQuad).toBeDefined();
    expect(typeQuad!.object).toBe(`${DKG}SubGraph`);
    expect(typeQuad!.subject).toBe('did:dkg:context-graph:dkg-v10-dev/code');
  });

  it('stores all quads in CG _meta graph', () => {
    const quads = generateSubGraphRegistration(reg);
    const expectedGraph = 'did:dkg:context-graph:dkg-v10-dev/_meta';
    for (const q of quads) {
      expect(q.graph).toBe(expectedGraph);
    }
  });

  it('includes parentContextGraph', () => {
    const quads = generateSubGraphRegistration(reg);
    const parent = quads.find(q => q.predicate === `${DKG}parentContextGraph`);
    expect(parent).toBeDefined();
    expect(parent!.object).toBe('did:dkg:context-graph:dkg-v10-dev');
  });

  it('includes schema:name with sub-graph name', () => {
    const quads = generateSubGraphRegistration(reg);
    const name = quads.find(q => q.predicate === `${SCHEMA}name`);
    expect(name).toBeDefined();
    expect(name!.object).toBe('"code"');
  });

  it('includes createdBy agent URI', () => {
    const quads = generateSubGraphRegistration(reg);
    const creator = quads.find(q => q.predicate === `${DKG}createdBy`);
    expect(creator).toBeDefined();
    expect(creator!.object).toBe('did:dkg:agent:0xAbc123');
  });

  it('includes createdAt timestamp', () => {
    const quads = generateSubGraphRegistration(reg);
    const created = quads.find(q => q.predicate === `${DKG}createdAt`);
    expect(created).toBeDefined();
    expect(created!.object).toContain('2026-04-07');
  });

  it('includes description when provided', () => {
    const quads = generateSubGraphRegistration({
      ...reg,
      description: 'Code structure sub-graph',
    });
    const desc = quads.find(q => q.predicate === `${SCHEMA}description`);
    expect(desc).toBeDefined();
    expect(desc!.object).toBe('"Code structure sub-graph"');
  });

  it('omits description when not provided', () => {
    const quads = generateSubGraphRegistration(reg);
    const desc = quads.find(q => q.predicate === `${SCHEMA}description`);
    expect(desc).toBeUndefined();
  });

  it('includes authorizedWriters when provided', () => {
    const quads = generateSubGraphRegistration({
      ...reg,
      authorizedWriters: ['0xParser', '0xSync'],
    });
    const writers = quads.filter(q => q.predicate === `${DKG}authorizedWriter`);
    expect(writers).toHaveLength(2);
    expect(writers.map(w => w.object).sort()).toEqual([
      'did:dkg:agent:0xParser',
      'did:dkg:agent:0xSync',
    ]);
  });

  it('omits authorizedWriters for open sub-graphs', () => {
    const quads = generateSubGraphRegistration(reg);
    const writers = quads.filter(q => q.predicate === `${DKG}authorizedWriter`);
    expect(writers).toHaveLength(0);
  });
});

describe('sub-graph SPARQL helpers', () => {
  it('subGraphDiscoverySparql queries _meta for SubGraph type', () => {
    const sparql = subGraphDiscoverySparql('dkg-v10-dev');
    expect(sparql).toContain('dkg-v10-dev/_meta');
    expect(sparql).toContain('SubGraph');
    expect(sparql).toContain('?subGraph');
    expect(sparql).toContain('?name');
  });

  it('subGraphWritersSparql scopes to specific sub-graph', () => {
    const sparql = subGraphWritersSparql('dkg-v10-dev', 'code');
    expect(sparql).toContain('dkg-v10-dev/_meta');
    expect(sparql).toContain('dkg-v10-dev/code');
    expect(sparql).toContain('authorizedWriter');
  });

  it('subGraphDeregistrationSparql targets correct graph and subject', () => {
    const sparql = subGraphDeregistrationSparql('dkg-v10-dev', 'code');
    expect(sparql).toContain('DELETE');
    expect(sparql).toContain('dkg-v10-dev/_meta');
    expect(sparql).toContain('dkg-v10-dev/code');
  });
});
