/**
 * Bug A regression tests for `agent.update`'s URI-keyed JSON-LD overload.
 *
 * The overload converts JSON-LD content to quads and dispatches into the
 * existing kcId-keyed `_update` flow. Codex Round 2 noticed the overload
 * didn't verify the supplied JSON-LD actually described `keyOrUri` — so a
 * caller that passed JSON-LD with a different `@id` (typo, stale builder)
 * would have its triples written into the kcId resolved from `keyOrUri` but
 * carrying a DIFFERENT subject. Original subject's triples become stale;
 * new subject's triples coexist confusingly.
 *
 * Codex Round 3 noticed Round 2's fix was over-strict — the original
 * helper inspected POST-conversion quads and required every subject to
 * equal `keyOrUri`. That rejected two legitimate JSON-LD shapes that
 * `publish()` already accepts:
 *   1. Private-only payloads (`{ private: { ... } }`) — `jsonLdToQuads`
 *      mints a `urn:dkg:private:<uuid>` anchor on the public side that
 *      definitionally can't match.
 *   2. Nested entities — a top-level KA with `{ "@id": expectedUri,
 *      "dkg:hasMeta": { "@id": "urn:meta:1", ... } }` legitimately emits
 *      two distinct subjects.
 *
 * The current rule (Round 3 fix) inspects the user's JsonLdContent
 * structure BEFORE conversion and only checks the DECLARED top-level
 * `@id` (when present). Nested children's `@id`s are free; missing
 * `@id` is allowed (caller relies on synthetic anchor); explicit
 * `urn:dkg:private:` synthetic-shaped `@id` is allowed.
 *
 * The validator runs against the JsonLdContent shape, not the converted
 * quads, so the test fixtures are JSON-LD docs (not Quad arrays).
 */
import { describe, expect, it } from 'vitest';
import {
  assertJsonLdContentRootMatches,
  RootEntityMismatchError,
} from '../src/dkg-agent-utils.js';

const URI = 'urn:dkg:kafka-endpoint:0xowner:hash';
const OTHER = 'urn:dkg:kafka-endpoint:0xowner:other-hash';

describe('assertJsonLdContentRootMatches — happy paths', () => {
  it('proceeds when content.public has matching top-level @id', () => {
    expect(() =>
      assertJsonLdContentRootMatches(URI, {
        public: { '@id': URI, 'dkg:broker': 'kafka.example:9092' },
      }),
    ).not.toThrow();
  });

  it('proceeds when content.private has matching top-level @id', () => {
    expect(() =>
      assertJsonLdContentRootMatches(URI, {
        private: { '@id': URI, 'dkg:secret': 'S' },
      }),
    ).not.toThrow();
  });

  it('proceeds when both public and private sides carry the matching @id (slice 05 compose path)', () => {
    expect(() =>
      assertJsonLdContentRootMatches(URI, {
        public: { '@id': URI, 'dkg:broker': 'b' },
        private: { '@id': URI, 'dkg:secret': 'S' },
      }),
    ).not.toThrow();
  });

  it('proceeds when nested entities under the matching root carry their own @id (Round 3 relaxation)', () => {
    // The legitimate JSON-LD pattern Round 2 over-rejected: the top-level
    // KA roots at `URI`, but its `dkg:hasMeta` value is a nested resource
    // with its own `@id`. Two distinct subjects in the resulting quads,
    // both correct. Validator must allow.
    expect(() =>
      assertJsonLdContentRootMatches(URI, {
        public: {
          '@id': URI,
          'dkg:broker': 'kafka.example:9092',
          'dkg:hasMeta': { '@id': 'urn:meta:1', 'x:label': 'L' },
        },
      }),
    ).not.toThrow();
  });

  it('proceeds when content.public is a single object missing @id (caller relies on synthetic anchor)', () => {
    // `jsonLdToQuads` synthesises a public anchor when the document has no
    // `@id`. We allow this — `publish()` already accepts the same shape.
    expect(() =>
      assertJsonLdContentRootMatches(URI, {
        public: { 'dkg:broker': 'kafka.example:9092' },
      }),
    ).not.toThrow();
  });

  it('proceeds when content.private is a single object missing @id (private-only synthetic-anchor case)', () => {
    // The bug-2-from-the-brief case: `update("urn:x:foo", cgId, { private:
    // { "x:secret": "S" } })`. `jsonLdToQuads` synthesises an anchor;
    // the validator must NOT 422 the legitimate shape.
    expect(() =>
      assertJsonLdContentRootMatches(URI, {
        private: { 'x:secret': 'S' },
      }),
    ).not.toThrow();
  });

  it('proceeds on a bare JsonLdDocument (treated as private by jsonLdToQuads) with matching @id', () => {
    // The non-envelope path: a bare object is the private side per
    // `jsonLdToQuads`'s discrimination.
    expect(() =>
      assertJsonLdContentRootMatches(URI, {
        '@id': URI,
        'dkg:secret': 'S',
      }),
    ).not.toThrow();
  });

  it('proceeds on a bare JsonLdDocument with no @id', () => {
    // Bare doc, no @id → private-side, jsonLdToQuads will synthesise an
    // anchor. Allow.
    expect(() =>
      assertJsonLdContentRootMatches(URI, { 'dkg:secret': 'S' }),
    ).not.toThrow();
  });

  it('proceeds when @id is a synthetic urn:dkg:private:* shape (defensive — never user-supplied in practice)', () => {
    // Defence-in-depth: a paranoid caller might supply that shape
    // themselves. Allow — the synthetic-anchor convention is opaque, not
    // forbidden as input.
    expect(() =>
      assertJsonLdContentRootMatches(URI, {
        public: { '@id': 'urn:dkg:private:abc123', 'x:label': 'L' },
      }),
    ).not.toThrow();
  });

  it('proceeds on an empty envelope ({}) — no top-level @id to validate', () => {
    expect(() =>
      assertJsonLdContentRootMatches(URI, {}),
    ).not.toThrow();
  });
});

describe('assertJsonLdContentRootMatches — array forms', () => {
  it('proceeds when content.public is an array of objects all matching the expected @id', () => {
    expect(() =>
      assertJsonLdContentRootMatches(URI, {
        public: [
          { '@id': URI, 'dkg:broker': 'b1' },
          { '@id': URI, 'dkg:topic': 't1' },
        ],
      }),
    ).not.toThrow();
  });

  it('proceeds when an array contains objects with no @id (synthetic-anchor mix)', () => {
    expect(() =>
      assertJsonLdContentRootMatches(URI, {
        public: [
          { '@id': URI, 'dkg:broker': 'b1' },
          { 'dkg:topic': 't1' },
        ],
      }),
    ).not.toThrow();
  });

  it('throws when ANY array element has a mismatched top-level @id (the wrong sibling is the issue)', () => {
    // From the brief: even if one sibling matches, the other's mismatch is
    // the issue.
    expect(() =>
      assertJsonLdContentRootMatches(URI, {
        public: [
          { '@id': URI, 'dkg:broker': 'b1' },
          { '@id': OTHER, 'dkg:topic': 't1' },
        ],
      }),
    ).toThrow(RootEntityMismatchError);
  });

  it('proceeds on a bare JsonLdDocument array with all matching (or @id-less) entries', () => {
    expect(() =>
      assertJsonLdContentRootMatches(URI, [
        { '@id': URI, 'x:a': '1' },
        { 'x:b': '2' },
      ]),
    ).not.toThrow();
  });
});

describe('assertJsonLdContentRootMatches — mismatch paths', () => {
  it('throws when content.public has a mismatched top-level @id', () => {
    expect(() =>
      assertJsonLdContentRootMatches(URI, {
        public: { '@id': OTHER, 'dkg:broker': 'b' },
      }),
    ).toThrow(RootEntityMismatchError);
  });

  it('throws when content.private has a mismatched top-level @id', () => {
    expect(() =>
      assertJsonLdContentRootMatches(URI, {
        private: { '@id': OTHER, 'x:secret': 'S' },
      }),
    ).toThrow(RootEntityMismatchError);
  });

  it('throws when bare JsonLdDocument has a mismatched @id', () => {
    expect(() =>
      assertJsonLdContentRootMatches(URI, {
        '@id': OTHER,
        'x:secret': 'S',
      }),
    ).toThrow(RootEntityMismatchError);
  });

  it('typed-error fields name expected and actual top-level @id(s)', () => {
    try {
      assertJsonLdContentRootMatches(URI, {
        public: { '@id': OTHER, 'x:a': '1' },
        private: { '@id': 'urn:third', 'x:b': '2' },
      });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(RootEntityMismatchError);
      const e = err as RootEntityMismatchError;
      expect(e.message).toContain(URI);
      expect(e.message).toContain(OTHER);
      expect(e.message).toContain('urn:third');
      expect(e.expected).toBe(URI);
      expect(e.actual).toEqual([OTHER, 'urn:third'].sort());
    }
  });

  it('actual list is sorted + deduplicated when the same wrong @id appears on both sides', () => {
    try {
      assertJsonLdContentRootMatches(URI, {
        public: { '@id': OTHER, 'x:a': '1' },
        private: { '@id': OTHER, 'x:b': '2' },
      });
      throw new Error('expected throw');
    } catch (err) {
      const e = err as RootEntityMismatchError;
      expect(e.actual).toEqual([OTHER]);
    }
  });

  it('throws when @id is a non-string (defensive — should never happen via normal callers)', () => {
    // jsonLdToQuads / jsonld would also reject this, but the validator
    // shouldn't crash on it — emit a clean RootEntityMismatchError.
    expect(() =>
      assertJsonLdContentRootMatches(URI, {
        public: { '@id': 42, 'x:a': '1' } as unknown as Record<string, unknown>,
      }),
    ).toThrow(RootEntityMismatchError);
  });
});
