import { expect, it } from 'vitest';
import { stripMetadataLiteral } from '../src/sync/metadata-literal.js';
import { parseGraphScopedSwmRecoveryDescriptors } from '../src/sync/graph-scoped-swm-recovery.js';
import { swmFixtures } from './swm-descriptor-fixtures.js';

it.each([
  [String.raw`"back\bspace"`, 'back\bspace'],
  [String.raw`"form\ffeed"`, 'form\ffeed'],
  [String.raw`"line\nfeed"`, 'line\nfeed'],
  [String.raw`"carriage\rreturn"`, 'carriage\rreturn'],
  [String.raw`"tab\there"`, 'tab\there'],
  [String.raw`"quote\"here"`, 'quote"here'],
  [String.raw`"slash\\here"`, 'slash\\here'],
  [String.raw`"\u0041"`, 'A'],
  [String.raw`"\U0001F600"`, '😀'],
  [String.raw`"\u0041"@en`, 'A'],
  [String.raw`"\u0041"^^<http://www.w3.org/2001/XMLSchema#string>`, 'A'],
  ['urn:example:iri', 'urn:example:iri'],
  [String.raw`"bad\qescape"`, String.raw`"bad\qescape"`],
  [undefined, undefined],
])('reads canonical literal input %s', (input, expected) => {
  expect(stripMetadataLiteral(input)).toBe(expected);
});

it('uses the same escape handling for graph-scoped recovery fields', () => {
  const contextGraphId = 'literal-recovery';
  const asset = swmFixtures(contextGraphId).manifest(1)[0]!;
  const metadata = asset.meta.map(quad => quad.predicate === 'http://dkg.io/ontology/publisherPeerId'
    ? { ...quad, object: String.raw`"peer\u0041\b\fZ"` } : quad);
  const [descriptor] = parseGraphScopedSwmRecoveryDescriptors({ contextGraphId, metaQuads: metadata });
  expect(descriptor?.publisherPeerId).toBe('peerA\b\fZ');
});
