import { describe, expect, it } from 'vitest';
import { OxigraphStore, readExactGraphPaged } from '@origintrail-official/dkg-storage';
import { acceptIncomingPublicQuads } from '../src/incoming-public-copy.js';
import { parseSimpleNQuads } from '../src/publish-handler.js';
import { workspacePublicQuadsDigest } from '../src/workspace-snapshot-store.js';

const GRAPH = 'urn:test:incoming-copy';

// Text escaped the way N-Triples writers send it: `\u` escapes, an emoji as a
// UTF-16 escape pair, and ECHAR line breaks and tabs.
const WIRE = [
  '<urn:article> <http://schema.org/headline> "Women\\u2019s Europeans \\u2013 Zagreb" .',
  '<urn:event> <http://schema.org/description> '
    + '"\\uD83D\\uDDD3\\uFE0F 12 October\\n\\uD83D\\uDCCD Zagreb\\tHall" .',
  '<urn:event> <http://schema.org/name> "European Championships"@en .',
  '<urn:event> <http://schema.org/startDate> "2026-10-12"^^<http://www.w3.org/2001/XMLSchema#date> .',
  '<urn:event> <http://schema.org/location> <urn:place:zagreb> .',
].join('\n');

describe('acceptIncomingPublicQuads', () => {
  it('rewrites literal objects to the stored form and leaves every other term alone', () => {
    const parsed = parseSimpleNQuads(WIRE);
    const accepted = acceptIncomingPublicQuads(parsed);

    expect(accepted.map((quad) => [quad.subject, quad.predicate, quad.graph]))
      .toEqual(parsed.map((quad) => [quad.subject, quad.predicate, quad.graph]));
    expect(accepted[0]!.object).toBe('"Women\u2019s Europeans \u2013 Zagreb"');
    expect(accepted[1]!.object)
      .toBe('"\u{1F5D3}\uFE0F 12 October\\n\u{1F4CD} Zagreb\\tHall"');
    expect(accepted.slice(2)).toEqual(parsed.slice(2));
  });

  it('fingerprints a received copy the way the finalization check reads it back', async () => {
    const parsed = parseSimpleNQuads(WIRE);
    const accepted = acceptIncomingPublicQuads(parsed);
    const store = new OxigraphStore();
    await store.insert(accepted.map((quad) => ({ ...quad, graph: GRAPH })));

    const readBack = await readExactGraphPaged(store, GRAPH, {
      expectedQuadCount: accepted.length,
      outputGraph: '',
    });

    expect(workspacePublicQuadsDigest(accepted)).toBe(workspacePublicQuadsDigest(readBack));
    // Fingerprinting the copy as received is the mismatch this avoids.
    expect(workspacePublicQuadsDigest(parsed)).not.toBe(workspacePublicQuadsDigest(readBack));
  });
});
