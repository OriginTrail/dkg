/**
 * Bug A regression tests for `agent.update`'s URI-keyed JSON-LD overload.
 *
 * The overload converts JSON-LD content to quads and dispatches into the
 * existing kcId-keyed `_update` flow. Codex correctly noticed there was no
 * check that the quads' root subject(s) actually match `keyOrUri` — so a
 * caller that supplied JSON-LD with a different `@id` (typo, stale builder,
 * or a private-only payload that synthesises a blank-node anchor) would have
 * its triples written into the kcId resolved from `keyOrUri`, but carrying a
 * DIFFERENT subject. The original subject's triples become stale; the new
 * subject's triples coexist confusingly inside the same kcId.
 *
 * The validation lives in a pure helper (`assertJsonLdRootMatches`) so we can
 * test it without the rest of the agent surface. The full overload is
 * exercised separately at the route level (slice 05's lifecycle e2e + the
 * smoke tests).
 */
import { describe, expect, it } from 'vitest';
import type { Quad } from '@origintrail-official/dkg-storage';
import {
  assertJsonLdRootMatches,
  RootEntityMismatchError,
} from '../src/dkg-agent-utils.js';

const URI = 'urn:dkg:kafka-endpoint:0xowner:hash';
const OTHER = 'urn:dkg:kafka-endpoint:0xowner:other-hash';

function quad(subject: string, predicate = 'http://example.org/p', object = '"v"'): Quad {
  return { subject, predicate, object, graph: '' };
}

describe('assertJsonLdRootMatches', () => {
  it('proceeds silently when the only public subject equals the expected URI', () => {
    expect(() =>
      assertJsonLdRootMatches(URI, [quad(URI)], []),
    ).not.toThrow();
  });

  it('proceeds silently when the only private subject equals the expected URI (public-only-anchor case)', () => {
    // jsonLdToQuads synthesises an anchor on the public side when the input
    // is private-only. We accept either side carrying the rootEntity, as
    // long as no subject diverges from it.
    expect(() =>
      assertJsonLdRootMatches(URI, [], [quad(URI)]),
    ).not.toThrow();
  });

  it('proceeds when both public and private quads share the same single subject (slice 05 compose path)', () => {
    expect(() =>
      assertJsonLdRootMatches(URI, [quad(URI), quad(URI, 'http://example.org/p2')], [quad(URI)]),
    ).not.toThrow();
  });

  it('throws RootEntityMismatchError when the only subject differs from the expected URI', () => {
    expect(() =>
      assertJsonLdRootMatches(URI, [quad(OTHER)], []),
    ).toThrow(RootEntityMismatchError);
  });

  it('throws when there are zero subjects (no concrete content)', () => {
    expect(() =>
      assertJsonLdRootMatches(URI, [], []),
    ).toThrow(RootEntityMismatchError);
  });

  it('throws when multiple subjects appear and not all match the expected URI', () => {
    // Mixed-subject content under a single rootEntity update is suspicious
    // even if the expected URI IS one of the subjects. Be strict.
    expect(() =>
      assertJsonLdRootMatches(URI, [quad(URI), quad(OTHER)], []),
    ).toThrow(RootEntityMismatchError);
  });

  it('throws on a synthetic anchor (urn:dkg:private:...) — the synthesised anchor never matches a real rootEntity', () => {
    // jsonLdToQuads emits a `urn:dkg:private:<uuid>` anchor on private-only
    // input. That URN is generated per-call and definitionally cannot equal
    // an externally-supplied rootEntity URI.
    expect(() =>
      assertJsonLdRootMatches(URI, [quad('urn:dkg:private:abc123')], []),
    ).toThrow(RootEntityMismatchError);
  });

  it('the error message names both the expected URI and the actual subject(s)', () => {
    try {
      assertJsonLdRootMatches(URI, [quad(OTHER), quad('urn:dkg:third')], []);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(RootEntityMismatchError);
      const e = err as RootEntityMismatchError;
      expect(e.message).toContain(URI);
      expect(e.message).toContain(OTHER);
      expect(e.message).toContain('urn:dkg:third');
      expect(e.expected).toBe(URI);
      expect(e.actual).toEqual([OTHER, 'urn:dkg:third'].sort());
    }
  });

  it('error message lists actual subjects sorted + deduplicated', () => {
    // Stable output for log/diagnostic comparison: sort and dedupe.
    try {
      assertJsonLdRootMatches(URI, [quad(OTHER), quad(OTHER), quad('urn:dkg:third')], []);
      throw new Error('expected throw');
    } catch (err) {
      const e = err as RootEntityMismatchError;
      // Two distinct actual subjects, sorted.
      expect(e.actual).toEqual([OTHER, 'urn:dkg:third'].sort());
    }
  });

  it('throws on a blank node anchor (`_:b1`) — blank nodes are non-IRIs and never match a real rootEntity URI', () => {
    // Sanity check: even if jsonLdToQuads ever leaks a blank node into the
    // quads (shouldn't, but defence-in-depth), it must not silently match.
    expect(() =>
      assertJsonLdRootMatches(URI, [quad('_:b1')], []),
    ).toThrow(RootEntityMismatchError);
  });
});
