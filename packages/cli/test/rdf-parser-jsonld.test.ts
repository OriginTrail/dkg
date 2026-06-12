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
 * This asserts the CORRECT (post-fix) INVARIANT — the parser is never in an
 * "advertised but broken" state — so it is RED while the bug is live and GREEN
 * for EITHER accepted fix: implement JSON-LD (then it parses) OR stop advertising
 * `.jsonld` (then there's nothing to parse). Written fix-agnostically so option A
 * can't leave it stuck red (Codex review on PR #1129).
 */
import { describe, expect, it } from 'vitest';
import { detectFormat, supportedExtensions, parseRdf } from '../src/rdf-parser.js';

const JSONLD_WITH_CONTEXT = JSON.stringify({
  '@context': { schema: 'https://schema.org/' },
  '@id': 'https://example.org/thing-15',
  '@type': 'schema:Thing',
  'schema:name': 'JsonLd15',
});

describe('GH #15 — JSON-LD ingest must not be advertised-but-broken', () => {
  it('a .jsonld document with @context is parseable, OR .jsonld is not advertised (no advertised-but-broken state)', async () => {
    const advertised =
      supportedExtensions().includes('.jsonld') || detectFormat('thing.jsonld') === 'jsonld';

    // Option A fix — `.jsonld` de-advertised: there is nothing to parse, the
    // parser is consistent, pass.
    if (!advertised) return;

    // Still advertised → option B fix must hold: a JSON-LD doc with `@context`
    // MUST parse. Today this throws ("requires the jsonld library"), so the test
    // is RED. (A throw here is the live bug; an empty parse is also a failure.)
    const quads = await parseRdf(JSONLD_WITH_CONTEXT, 'jsonld', 'did:dkg:context-graph:gh15');
    expect(quads.length).toBeGreaterThan(0);
  });
});
