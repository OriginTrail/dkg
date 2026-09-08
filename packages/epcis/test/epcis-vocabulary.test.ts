import { describe, it, expect } from 'vitest';
import { compactEpcisEventType, normalizeEpcisEventType } from '../src/epcis-vocabulary.js';

describe('EPCIS event type normalization', () => {
  it.each(['ObjectEvent', 'AggregationEvent', 'TransactionEvent', 'TransformationEvent', 'AssociationEvent'])(
    'expands the standard short name %s', (name) => {
      expect(normalizeEpcisEventType(name)).toBe(`https://gs1.github.io/EPCIS/${name}`);
      expect(compactEpcisEventType(normalizeEpcisEventType(name))).toBe(name);
    },
  );
  it.each(['https://gs1.github.io/EPCIS/ObjectEvent', 'https://example.org/Observation', 'urn:epcis:Observation'])(
    'preserves an absolute event type IRI %s', (iri) => {
      expect(normalizeEpcisEventType(iri)).toBe(iri);
      expect(normalizeEpcisEventType(compactEpcisEventType(iri))).toBe(iri);
    },
  );
  it.each(['not an event name', '', 'https://example.org/Event>', 'urn:epcis:bad type'])(
    'rejects an unsafe short name or IRI %s', (value) => expect(() => normalizeEpcisEventType(value)).toThrow(),
  );
});


it('retains the historical compact extension-name query spelling', () => {
  expect(normalizeEpcisEventType('CustomEvent')).toBe('https://gs1.github.io/EPCIS/CustomEvent');
  expect(normalizeEpcisEventType(compactEpcisEventType('https://gs1.github.io/EPCIS/CustomEvent')))
    .toBe('https://gs1.github.io/EPCIS/CustomEvent');
});

it.each(['ObjectEvent', 'AggregationEvent', 'TransactionEvent', 'TransformationEvent', 'AssociationEvent'])(
  'recognizes current-namespace standard class %s', name => {
    const current = `https://ref.gs1.org/epcis/${name}`;
    expect(compactEpcisEventType(current)).toBe(name);
    expect(normalizeEpcisEventType(current)).toBe(`https://gs1.github.io/EPCIS/${name}`);
  },
);
