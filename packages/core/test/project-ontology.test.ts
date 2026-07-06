import { describe, expect, it } from 'vitest';
import { buildProjectOntologyTriples } from '../src/index.js';

const RAW_IRI_OBJECT_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:[^\s<>"{}|\\^`\x00-\x20]+$/;

describe('buildProjectOntologyTriples', () => {
  it('emits project ontology quads using /wm/write raw IRI object terms', () => {
    const contextGraphId = '0x00000000000000000000000000000000000000a1/dmaast-documentation';

    const { ontologyUri, guideUri, quads } = buildProjectOntologyTriples({
      contextGraphId,
      starterSlug: 'pkm',
      ttl: '@prefix ex: <urn:example:> .',
      guide: '# Agent guide',
      nowIso: '2026-01-15T09:00:00.000Z',
    });

    expect(ontologyUri).toBe(`urn:dkg:project:${contextGraphId}:ontology`);
    expect(guideUri).toBe(`urn:dkg:project:${contextGraphId}:ontology:agent-guide`);
    expect(quads).toHaveLength(21);

    const objects = quads.map((quad) => quad.object);
    expect(objects).toEqual(expect.arrayContaining([
      'http://www.w3.org/2002/07/owl#Ontology',
      'http://www.w3.org/ns/prov#Entity',
      `urn:dkg:project:${contextGraphId}:ontology:agent-guide`,
      'http://schema.org/DigitalDocument',
      `urn:dkg:project:${contextGraphId}:ontology`,
    ]));
    expect(objects).not.toEqual(expect.arrayContaining([
      expect.stringMatching(/^<[^>]+>$/),
    ]));
    expect(
      objects.filter((object) => !object.startsWith('"') && !RAW_IRI_OBJECT_RE.test(object)),
    ).toEqual([]);
  });
});
