import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { expect, it, vi } from 'vitest';
import { handleCaptureAsync, EpcisValidationError } from '../src/handlers.js';
import { VALID_OBJECT_EVENT_DOC } from './fixtures/bicycle-story.js';

const declaration = 'http://dkg.io/ontology/epcisEventType';
const forged = { '@id': 'https://gs1.github.io/EPCIS/CustomEvent' };
const jsonld = createRequire(import.meta.url)('jsonld') as {
  toRDF(document: unknown, options: { format: string }): Promise<string>;
};

it.each([
  { name: 'full predicate', node: { [declaration]: forged } },
  { name: 'prefix alias', node: { '@context': { dkg: 'http://dkg.io/ontology/', alias: 'dkg:epcisEventType' }, alias: forged } },
  { name: 'vocabulary alias', node: { '@context': { '@vocab': 'http://dkg.io/ontology/' }, epcisEventType: forged } },
  { name: 'reverse edge', node: { '@reverse': { [declaration]: forged } } },
])('rejects a caller declaration expressed as $name', async ({ node }) => {
  const document = structuredClone(VALID_OBJECT_EVENT_DOC);
  Object.assign(document.epcisBody!.eventList[0]!, {
    'https://example.org/extension': { '@id': 'urn:uuid:fixture-obj-1', ...node },
  });
  const publishAsync = vi.fn();
  await expect(handleCaptureAsync({ epcisDocument: document }, { contextGraphId: 'capture-rdf', publisher: { publishAsync } }))
    .rejects.toThrow('reserved');
  expect(publishAsync).not.toHaveBeenCalled();
});

it('checks secondary private fragments before admitting the public document', async () => {
  const publishAsync = vi.fn();
  await expect(handleCaptureAsync({ epcisDocument: {
    public: VALID_OBJECT_EVENT_DOC,
    private: { '@id': 'urn:uuid:fixture-obj-1', [declaration]: forged },
  } }, { contextGraphId: 'capture-rdf', publisher: { publishAsync } })).rejects.toThrow('reserved');
  expect(publishAsync).not.toHaveBeenCalled();
});

it('rejects a context that redirects the generated reserved predicate', async () => {
  const document = structuredClone(VALID_OBJECT_EVENT_DOC);
  Object.assign(document.epcisBody!.eventList[0]!, { '@context': { [declaration]: 'https://example.org/redirected' } });
  const publishAsync = vi.fn();
  await expect(handleCaptureAsync({ epcisDocument: document }, { contextGraphId: 'capture-rdf', publisher: { publishAsync } }))
    .rejects.toThrow(EpcisValidationError);
  expect(publishAsync).not.toHaveBeenCalled();
});

it('rejects two declared event types for the same event identity', async () => {
  const document = structuredClone(VALID_OBJECT_EVENT_DOC);
  document.epcisBody!.eventList.push({ ...document.epcisBody!.eventList[0]!, type: 'https://gs1.github.io/EPCIS/CustomEvent' });
  const publishAsync = vi.fn();
  await expect(handleCaptureAsync({ epcisDocument: document }, { contextGraphId: 'capture-rdf', publisher: { publishAsync } }))
    .rejects.toThrow('Conflicting');
  expect(publishAsync).not.toHaveBeenCalled();
});

it('publishes the inspected RDF without fetching a changed remote context again', async () => {
  let requests = 0;
  const server = createServer((_req, res) => {
    requests++;
    res.writeHead(200, { 'Content-Type': 'application/ld+json' });
    res.end(JSON.stringify({ '@context': {
      ...VALID_OBJECT_EVENT_DOC['@context'] as Record<string, unknown>,
      shadow: requests === 1 ? 'https://example.org/auxiliary' : declaration,
    } }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test server address');
    const document = structuredClone(VALID_OBJECT_EVENT_DOC);
    document['@context'] = `http://127.0.0.1:${address.port}/context`;
    Object.assign(document.epcisBody!.eventList[0]!, { 'https://example.org/extension': { '@id': 'urn:uuid:fixture-obj-1', shadow: forged, '@type': 'https://gs1.github.io/EPCIS/CustomEvent' } });
    const before = structuredClone(document);
    let rdf = '';
    await handleCaptureAsync({ epcisDocument: document }, {
      contextGraphId: 'capture-rdf', publisher: { publishAsync: async (_cg, content) => {
        const expanded = (content as { private: unknown }).private;
        expect(JSON.stringify(expanded)).not.toContain('"@context"');
        rdf = await jsonld.toRDF(expanded, { format: 'application/n-quads' });
        return { captureID: 'frozen-context' };
      } },
    });
    expect(document).toEqual(before);
    expect(requests).toBe(1);
    expect(rdf.split('\n').filter(line => line.includes(`<${declaration}>`))).toEqual([
      `<urn:uuid:fixture-obj-1> <${declaration}> <https://gs1.github.io/EPCIS/ObjectEvent> .`,
    ]);
    expect(rdf).toContain('<https://gs1.github.io/EPCIS/CustomEvent>');
  } finally { server.close(); await once(server, 'close'); }
});

it('rejects a context that drops the event list before publication', async () => {
  const document = structuredClone(VALID_OBJECT_EVENT_DOC);
  document['@context'] = { type: '@type', eventID: '@id' };
  const publishAsync = vi.fn();
  await expect(handleCaptureAsync({ epcisDocument: document }, { contextGraphId: 'capture-rdf', publisher: { publishAsync } }))
    .rejects.toThrow('reserved');
  expect(publishAsync).not.toHaveBeenCalled();
});

it('rejects conflicting declarations across public and private visibility slots', async () => {
  const privateDocument = structuredClone(VALID_OBJECT_EVENT_DOC);
  privateDocument.epcisBody!.eventList[0]!.type = 'https://gs1.github.io/EPCIS/CustomEvent';
  const publishAsync = vi.fn();
  await expect(handleCaptureAsync({ epcisDocument: {
    public: VALID_OBJECT_EVENT_DOC, private: privateDocument,
  } }, { contextGraphId: 'capture-rdf', publisher: { publishAsync } })).rejects.toThrow('Conflicting');
  expect(publishAsync).not.toHaveBeenCalled();
});
