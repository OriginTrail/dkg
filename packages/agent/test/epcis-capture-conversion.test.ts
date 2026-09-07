import { describe, expect, it } from 'vitest';
import { handleCaptureAsync, type EPCISDocument } from '@origintrail-official/dkg-epcis';
import { jsonLdToQuads } from '../src/dkg-agent-utils.js';

const cases = ['bare', 'public', 'private', 'both'].flatMap((visibility) =>
  ['ObjectEvent', 'https://gs1.github.io/EPCIS/ObjectEvent'].map((type) => ({ visibility, type })),
);

// Exercise the conversion used by DKGAgent publication. Graph routing, anchors,
// and persistence are owned by the publisher's existing integration suites.
describe('EPCIS capture through the canonical agent JSON-LD converter', () => {
  it.each(cases)('emits the standard RDF class for $type with a non-keyword type mapping ($visibility)', async ({ visibility, type }) => {
    const document: EPCISDocument = {
      '@context': { '@vocab': 'https://gs1.github.io/EPCIS/', eventID: '@id', type: 'https://example.org/type' },
      type: 'EPCISDocument', schemaVersion: '2.0', creationDate: '2024-03-01T08:00:00Z',
      epcisBody: { eventList: [{ type, eventID: 'urn:uuid:epcis-conversion',
        eventTime: '2024-03-01T08:00:00Z', eventTimeZoneOffset: '+00:00', action: 'OBSERVE', epcList: [],
      }] },
    };
    const before = structuredClone(document);
    let converted: Awaited<ReturnType<typeof jsonLdToQuads>> | undefined;
    const result = await handleCaptureAsync({ epcisDocument: visibility === 'bare' ? document
      : visibility === 'both' ? { public: document, private: document } : { [visibility]: document } }, {
      contextGraphId: 'epcis-conversion',
      publisher: {
        async publishAsync(_cg, content) {
          converted = await jsonLdToQuads(content as Parameters<typeof jsonLdToQuads>[0]);
          return { captureID: 'conversion-1' };
        },
      },
    });
    expect(result).toMatchObject({ status: 'accepted', eventCount: 1 });
    expect(document).toEqual(before);
    const eventType = {
      subject: 'urn:uuid:epcis-conversion', predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type',
      object: 'https://gs1.github.io/EPCIS/ObjectEvent',
    };
    expect(converted).toBeDefined();
    for (const slot of ['public', 'private'] as const) {
      const expected = visibility === 'both' || visibility === slot || (visibility === 'bare' && slot === 'private');
      const eventTypes = converted![`${slot}Quads`].filter((quad) => quad.subject === eventType.subject && quad.predicate === eventType.predicate);
      expect(eventTypes).toEqual(expected ? [expect.objectContaining(eventType)] : []);
    }
  });
});
