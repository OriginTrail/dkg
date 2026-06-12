/**
 * Liveness/regression test for GH #15 —
 * "JSON-LD advertised but not implemented in CLI ingest".
 * https://github.com/OriginTrail/dkg/issues/15
 *
 * `.jsonld` is advertised as a supported ingest format (`supportedExtensions()`
 * lists it, `detectFormat('.jsonld')` returns `'jsonld'`), but parsing a JSON-LD
 * document that carries an `@context` throws
 *   "JSON-LD with @context requires the jsonld library. Use .nq, .nt, .ttl, or .trig instead."
 * So the format is advertised but non-functional. The issue's accepted
 * resolutions: implement JSON-LD (option B) OR stop advertising `.jsonld`
 * (option A). Either way the current state — advertised AND throwing — is the bug.
 *
 * Encoded as `it.fails`: asserting that a `.jsonld` file with `@context` parses
 * fails today (bug live). When JSON-LD ingest is implemented, flip to a plain
 * `it(...)` and close #15. (If option A is taken instead, replace this with a
 * test asserting `.jsonld` is absent from `supportedExtensions()`.)
 */
import { describe, expect, it } from 'vitest';
import { detectFormat, supportedExtensions, parseRdf } from '../src/rdf-parser.js';

// Opt-in gate: these repros assert post-fix behaviour, so they are RED while
// the bug is live. They are EXCLUDED from the default test lane (which must stay
// green / mergeable) and run only under `RUN_ISSUE_LIVENESS=1` (the dedicated
// issue-liveness CI lane). See package.json `test:issue-liveness`.
const LIVENESS_ENABLED = !!process.env.RUN_ISSUE_LIVENESS;


const JSONLD_WITH_CONTEXT = JSON.stringify({
  '@context': { schema: 'https://schema.org/' },
  '@id': 'https://example.org/thing-15',
  '@type': 'schema:Thing',
  'schema:name': 'JsonLd15',
});

describe.runIf(LIVENESS_ENABLED)('GH #15 — JSON-LD ingest is advertised but non-functional', () => {
  it('CONTROL: .jsonld is advertised as a supported format', () => {
    expect(supportedExtensions()).toContain('.jsonld');
    expect(detectFormat('thing.jsonld')).toBe('jsonld');
  });

  it('parses a .jsonld document that carries an @context', async () => {
    const quads = await parseRdf(
      JSONLD_WITH_CONTEXT,
      'jsonld',
      'did:dkg:context-graph:gh15',
    );
    expect(quads.length).toBeGreaterThan(0);
  });
});
