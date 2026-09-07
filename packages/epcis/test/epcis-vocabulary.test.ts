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
  it.each(['UnknownEvent', '', 'https://example.org/Event>', 'urn:epcis:bad type'])(
    'rejects an undefined short name or unsafe IRI %s', (value) => expect(() => normalizeEpcisEventType(value)).toThrow(),
  );
});
