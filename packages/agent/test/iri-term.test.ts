import { describe, it, expect } from 'vitest';
import { isIriTerm, isIriMetaSubject } from '../src/sync/iri-term.js';

/**
 * #1940 — `isIriTerm` (responder read) and `isIriMetaSubject` (requester ingest)
 * share one core predicate but diverge on empty/non-string input by design. The
 * divergence is load-bearing (#1921): ingest must fail closed on `''` while the
 * responder read must preserve its lenient byte-identical behavior. These tests
 * lock both the shared behavior and the intentional divergence.
 */
describe('iri-term classifiers', () => {
  describe('shared behavior (both exports)', () => {
    const iris = [
      'did:dkg:otp:2043/0x1234567890abcdef1234567890abcdef12345678/1',
      'http://dkg.io/ontology/merkleRoot',
      'https://example.org/thing#fragment',
      'urn:uuid:1234',
    ];
    for (const iri of iris) {
      it(`classifies IRI as a term: ${iri}`, () => {
        expect(isIriTerm(iri)).toBe(true);
        expect(isIriMetaSubject(iri)).toBe(true);
      });
    }

    it('rejects a blank-node label (_:…) in both', () => {
      expect(isIriTerm('_:b0')).toBe(false);
      expect(isIriMetaSubject('_:b0')).toBe(false);
      expect(isIriTerm('_:')).toBe(false);
      expect(isIriMetaSubject('_:')).toBe(false);
    });

    it('rejects a quoted literal ("…) in both', () => {
      expect(isIriTerm('"a literal"')).toBe(false);
      expect(isIriMetaSubject('"a literal"')).toBe(false);
      expect(isIriTerm('"42"^^<http://www.w3.org/2001/XMLSchema#integer>')).toBe(false);
      expect(isIriMetaSubject('"42"^^<http://www.w3.org/2001/XMLSchema#integer>')).toBe(false);
    });
  });

  describe('intentional divergence on empty / non-string input (#1940)', () => {
    it('empty string: isIriTerm is lenient (true), isIriMetaSubject is fail-closed (false)', () => {
      // Responder read preserves the bare-core semantics: '' starts with
      // neither '_:' nor '"', so it is an IRI term.
      expect(isIriTerm('')).toBe(true);
      // Ingest hardening (#1921): an empty subject is not a trustworthy IRI, so
      // it is dropped rather than persisted.
      expect(isIriMetaSubject('')).toBe(false);
    });

    it('non-string subject: isIriMetaSubject fails closed without throwing', () => {
      // The verification-input boundary runs on RAW peer-fetched meta; tolerate
      // a malformed subject (treat as non-IRI → drop) instead of throwing.
      for (const bad of [undefined, null, 0, {}, []]) {
        expect(isIriMetaSubject(bad as unknown as string)).toBe(false);
      }
    });
  });
});
