// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@origintrail-official/dkg-core', () => {
  throw new Error('ontologyInstall must use the browser-safe project-ontology subpath');
});

import { installOntology } from '../src/ui/lib/ontologyInstall.js';

type PostedQuad = {
  subject: string;
  predicate: string;
  object: string;
};

type FetchCall = {
  path: string;
  body: any;
};

const IRI_SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:[^\s<>"{}|\\^`\x00-\x20]+$/;

function isDaemonAcceptedObjectTerm(value: string): boolean {
  const object = value.trim();
  return object.startsWith('"') || IRI_SCHEME_RE.test(object);
}

describe('installOntology', () => {
  let originalFetch: typeof globalThis.fetch | undefined;
  let calls: FetchCall[];

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    calls = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      calls.push({ path, body });

      if (path.endsWith('/wm/write')) {
        const badIndex = (body.quads as PostedQuad[]).findIndex((quad) =>
          !isDaemonAcceptedObjectTerm(quad.object),
        );
        if (badIndex !== -1) {
          return new Response(JSON.stringify({
            error: `Invalid "quads[${badIndex}].object": RDF object must be a quoted literal term or absolute IRI`,
          }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          });
        }
      }

      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof globalThis.fetch;
  });

  afterEach(() => {
    if (originalFetch) globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('writes PKM ontology quads using raw IRI object terms accepted by the daemon', async () => {
    const contextGraphId = '0x00000000000000000000000000000000000000a1/dmaast-documentation';

    await expect(installOntology(contextGraphId, 'pkm')).resolves.toMatchObject({
      ontologyUri: `urn:dkg:project:${contextGraphId}:ontology`,
      guideUri: `urn:dkg:project:${contextGraphId}:ontology:agent-guide`,
      tripleCount: 21,
    });

    const writeCall = calls.find((call) => call.path.endsWith('/wm/write'));
    expect(writeCall).toBeTruthy();
    const writtenObjects = (writeCall!.body.quads as PostedQuad[]).map((quad) => quad.object);

    expect(writtenObjects).toContain('http://www.w3.org/2002/07/owl#Ontology');
    expect(writtenObjects).toContain('http://www.w3.org/ns/prov#Entity');
    expect(writtenObjects).toContain(`urn:dkg:project:${contextGraphId}:ontology:agent-guide`);
    expect(writtenObjects).toContain('http://schema.org/DigitalDocument');
    expect(writtenObjects).toContain(`urn:dkg:project:${contextGraphId}:ontology`);
    expect(writtenObjects).not.toEqual(expect.arrayContaining([
      expect.stringMatching(/^<[^>]+>$/),
    ]));
  });
});
