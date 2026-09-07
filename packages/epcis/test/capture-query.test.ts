import { describe, expect, it } from 'vitest';
import jsonld from 'jsonld';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { handleCaptureAsync } from '../src/handlers.js';
import { buildEpcisQuery } from '../src/query-builder.js';
import { VALID_OBJECT_EVENT_DOC } from './fixtures/bicycle-story.js';

const CG = 'capture-query';
const GRAPH = `did:dkg:context-graph:${CG}`;
const cases = ['bare', 'public', 'private', 'both'].flatMap((visibility) =>
  ['ObjectEvent', 'https://gs1.github.io/EPCIS/ObjectEvent'].map((type) => ({ visibility, type })),
);

// The integration owns its store and JSON-LD conversion through declared
// package APIs. It needs no daemon, sibling implementation files, or network.
describe('EPCIS capture-to-query integration', () => {
  it.each(cases)('makes $type queryable with a non-keyword type mapping ($visibility)', async ({ visibility, type }) => {
    const document = structuredClone(VALID_OBJECT_EVENT_DOC);
    delete (document['@context'] as Record<string, unknown>).type;
    document.epcisBody!.eventList[0]!.type = type;
    const before = structuredClone(document);
    const store = new OxigraphStore();
    try {
      const accepted = await handleCaptureAsync({
        epcisDocument: visibility === 'bare' ? document : visibility === 'both'
          ? { public: document, private: document } : { [visibility]: document },
      }, {
        contextGraphId: CG,
        publisher: {
          async publishAsync(_cg, content) {
            const envelope = content as { public?: unknown; private?: unknown };
            for (const slot of ['public', 'private'] as const) {
              if (envelope[slot] === undefined) continue;
              const nquads = await jsonld.toRDF(envelope[slot], { format: 'application/n-quads' });
              const graph = slot === 'public' ? GRAPH : `${GRAPH}/_private`;
              await store.update(`INSERT DATA { GRAPH <${graph}> { ${nquads} } }`);
            }
            if (envelope.private !== undefined) {
              await store.insert([{
                subject: 'urn:uuid:fixture-obj-1', predicate: 'http://dkg.io/ontology/privateDataAnchor',
                object: '"true"', graph: GRAPH,
              }]);
            }
            return { captureID: 'capture-query-1' };
          },
        },
      });
      expect(accepted).toMatchObject({ status: 'accepted', eventCount: 1 });
      expect(document).toEqual(before);
      const result = await store.query(buildEpcisQuery({ epc: 'urn:epc:id:sgtin:4012345.011111.1001' }, CG));
      expect(result).toMatchObject({ type: 'bindings', bindings: [expect.objectContaining({
        event: 'urn:uuid:fixture-obj-1', eventType: 'https://gs1.github.io/EPCIS/ObjectEvent',
      })] });
    } finally {
      await store.close();
    }
  });
});
