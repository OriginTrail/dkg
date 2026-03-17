import { describe, expect, it } from 'vitest';
import { buildLabelMap, predicateToPhrase, splitCamelCase, tripleToText, uriLocalName } from '../src/triple-text.js';
import type { Quad } from '@origintrail-official/dkg-storage';

describe('triple-text', () => {
  it('splits camelCase and kebab-case names', () => {
    expect(splitCamelCase('worksFor')).toBe('works for');
    expect(splitCamelCase('MemoryImportBatch')).toBe('memory import batch');
    expect(splitCamelCase('workspace-owner')).toBe('workspace owner');
  });

  it('extracts local names from URIs', () => {
    expect(uriLocalName('http://schema.org/worksFor')).toBe('works for');
    expect(uriLocalName('urn:dkg:entity:alice-johnson')).toBe('alice johnson');
  });

  it('uses predicate aliases for common RDF properties', () => {
    expect(predicateToPhrase('http://www.w3.org/1999/02/22-rdf-syntax-ns#type')).toBe('is a');
  });

  it('builds a label map from schema:name and rdfs:label triples', () => {
    const quads: Quad[] = [
      {
        subject: 'urn:alice',
        predicate: 'http://schema.org/name',
        object: '"Alice Johnson"',
        graph: '',
      },
      {
        subject: 'urn:acme',
        predicate: 'http://www.w3.org/2000/01/rdf-schema#label',
        object: '"Acme Corp"',
        graph: '',
      },
    ];
    const labelMap = buildLabelMap(quads);
    expect(labelMap.get('urn:alice')).toBe('Alice Johnson');
    expect(labelMap.get('urn:acme')).toBe('Acme Corp');
  });

  it('converts quads into cleaned embedding text with label enrichment', () => {
    const quads: Quad[] = [
      {
        subject: 'urn:alice',
        predicate: 'http://schema.org/name',
        object: '"Alice Johnson"',
        graph: '',
      },
      {
        subject: 'urn:alice',
        predicate: 'http://schema.org/worksFor',
        object: 'urn:acme',
        graph: '',
      },
      {
        subject: 'urn:acme',
        predicate: 'http://schema.org/name',
        object: '"Acme Corp"',
        graph: '',
      },
    ];
    const labelMap = buildLabelMap(quads);
    expect(tripleToText(quads[1], labelMap)).toBe('Alice Johnson, works for, Acme Corp');
  });

  it('keeps literal values readable', () => {
    const labelMap = new Map<string, string>();
    expect(tripleToText({
      subject: 'urn:washing-machine',
      predicate: 'http://schema.org/dateCreated',
      object: '"2026-03-17"^^<http://www.w3.org/2001/XMLSchema#date>',
      graph: '',
    }, labelMap)).toBe('washing machine, date created, 2026-03-17');
  });
});
