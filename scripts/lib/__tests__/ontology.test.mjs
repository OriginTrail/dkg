/**
 * Tests for ontology helpers shared by the browser installer and the
 * standalone import script.
 *
 * Run via: node --test scripts/lib/__tests__/ontology.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildProjectOntologyTriples } from '../ontology.mjs';

const DAEMON_OBJECT_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:[^\s<>"{}|\\^`\x00-\x20]+$/;

test('buildProjectOntologyTriples emits daemon-accepted raw IRI object terms', () => {
  const contextGraphId = '0x00000000000000000000000000000000000000a1/dmaast-documentation';

  const { ontologyUri, guideUri, quads } = buildProjectOntologyTriples({
    contextGraphId,
    starterSlug: 'pkm',
    ttl: '@prefix ex: <urn:example:> .',
    guide: '# Agent guide',
    nowIso: '2026-01-15T09:00:00.000Z',
  });

  assert.equal(ontologyUri, `urn:dkg:project:${contextGraphId}:ontology`);
  assert.equal(guideUri, `urn:dkg:project:${contextGraphId}:ontology:agent-guide`);
  assert.equal(quads.length, 21);

  const objects = quads.map((quad) => quad.object);
  assert.deepEqual(
    [
      'http://www.w3.org/2002/07/owl#Ontology',
      'http://www.w3.org/ns/prov#Entity',
      `urn:dkg:project:${contextGraphId}:ontology:agent-guide`,
      'http://schema.org/DigitalDocument',
      `urn:dkg:project:${contextGraphId}:ontology`,
    ].filter((object) => !objects.includes(object)),
    [],
  );

  assert.equal(
    objects.filter((object) => /^<[^>]+>$/.test(object)).length,
    0,
    'objects sent to /wm/write must be raw IRIs or quoted literals, not bracketed N-Triples IRIs',
  );
  assert.equal(
    objects.filter((object) => !object.startsWith('"') && !DAEMON_OBJECT_RE.test(object)).length,
    0,
    'all objects must match the daemon /wm/write object-term contract',
  );
});
