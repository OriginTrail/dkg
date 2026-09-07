import { describe, expect, it } from 'vitest';
import { contextGraphDataUri } from '@origintrail-official/dkg-core';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { buildEpcisQuery } from '../src/query-builder.js';
import { toEpcisEvent } from '../src/handlers.js';

const CG = 'external-epcis-type';
const EPCIS = 'https://gs1.github.io/EPCIS/';
const DATE_CASES = [
  { name: 'without dates', filters: {}, expected: ['early', 'event', 'late'] },
  { name: 'with a lower bound', filters: { from: '2024-03-01T00:00:00Z' }, expected: ['event', 'late'] },
  { name: 'with an upper bound', filters: { to: '2024-03-02T00:00:00Z' }, expected: ['early', 'event'] },
  { name: 'with both bounds', filters: { from: '2024-03-01T00:00:00Z', to: '2024-03-02T00:00:00Z' }, expected: ['event'] },
];

function eventRows(id: string, eventType: string, time?: string, offset?: string): Quad[] {
  const graph = contextGraphDataUri(CG);
  const subject = `urn:event:${id}`;
  return [
    { subject, predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: eventType, graph },
    ...(time === undefined ? [] : [{ subject, predicate: `${EPCIS}eventTime`, object: `"${time}"`, graph }]),
    ...(offset === undefined ? [] : [{ subject, predicate: `${EPCIS}eventTimeZoneOffset`, object: `"${offset}"`, graph }]),
  ];
}

describe.each(['urn:epcis:CustomEvent', 'https://example.org/CustomEvent'])('external event class %s', (eventType) => {
  it.each(DATE_CASES)('requires event shape and preserves exact filtering $name', async ({ filters, expected }) => {
    const store = new OxigraphStore();
    try {
      await store.insert([
        ...eventRows('event', eventType, '2024-03-01T08:00:00Z', '+00:00'),
        ...eventRows('early', eventType, '2023-03-01T08:00:00Z', '+00:00'),
        ...eventRows('late', eventType, '2025-03-01T08:00:00Z', '+00:00'),
        ...eventRows('ordinary', eventType),
        ...eventRows('missing-offset', eventType, '2024-03-01T08:00:00Z'),
        ...eventRows('missing-time', eventType, undefined, '+00:00'),
        ...eventRows('standard', `${EPCIS}ObjectEvent`, '2024-03-01T08:00:00Z', '+00:00'),
      ]);
      const responseType = toEpcisEvent({ eventType }).type as string;
      expect(responseType).toBe(eventType);
      const sparql = buildEpcisQuery({ ...filters, eventType: responseType }, CG);
      expect(sparql).toContain(`FILTER(?eventType = <${eventType}>)`);
      for (const field of ['eventTime', 'eventTimeZoneOffset']) {
        expect(sparql).not.toContain(`OPTIONAL { ?event epcis:${field} ?${field} . }`);
        // One binding in each public/private graph branch, even with date filters.
        expect(sparql.split(`?event epcis:${field} ?${field} .`)).toHaveLength(3);
      }
      const result = await store.query(sparql);
      if (result.type !== 'bindings') throw new Error('Expected event bindings');
      expect(result.bindings.map((row) => row.event).sort())
        .toEqual(expected.map((id) => `urn:event:${id}`));

      const defaultResult = await store.query(buildEpcisQuery(filters, CG));
      if (defaultResult.type !== 'bindings') throw new Error('Expected default event bindings');
      expect(defaultResult.bindings.map((row) => row.event)).toEqual(['urn:event:standard']);
    } finally {
      await store.close();
    }
  });
});
