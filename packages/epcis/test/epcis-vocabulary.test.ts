import { expect, it } from 'vitest';
import { resolveEpcisEventType, resolveEpcisQueryEventType, compactEpcisEventType } from '../src/epcis-vocabulary.js';

it.each([
  { input: 'ObjectEvent', kind: 'standard', iri: 'https://gs1.github.io/EPCIS/ObjectEvent', response: 'ObjectEvent' },
  { input: 'https://gs1.github.io/EPCIS/ObjectEvent', kind: 'standard', iri: 'https://gs1.github.io/EPCIS/ObjectEvent', response: 'ObjectEvent' },
  { input: 'https://gs1.github.io/EPCIS/CustomEvent', kind: 'gs1-extension', iri: 'https://gs1.github.io/EPCIS/CustomEvent', response: 'https://gs1.github.io/EPCIS/CustomEvent' },
  { input: 'https://example.org/CustomEvent', kind: 'external', iri: 'https://example.org/CustomEvent', response: 'https://example.org/CustomEvent' },
  { input: 'urn:epcis:CustomEvent', kind: 'external', iri: 'urn:epcis:CustomEvent', response: 'urn:epcis:CustomEvent' },
])('owns classification and response spelling for $input', ({ input, kind, iri, response }) => {
  expect(resolveEpcisEventType(input)).toMatchObject({ kind, iri });
  expect(compactEpcisEventType(input)).toBe(response);
});
it.each(['not an event name', 'urn:bad type', 'https://example.org/Event>'])('rejects invalid event type %s', (input) => {
  expect(resolveEpcisEventType(input)).toBeUndefined();
});

it('keeps historical local extension aliases query-only', () => {
  expect(resolveEpcisEventType('CustomEvent')).toBeUndefined();
  expect(resolveEpcisQueryEventType('CustomEvent')).toEqual({ kind: 'gs1-extension', iri: 'https://gs1.github.io/EPCIS/CustomEvent' });
});
