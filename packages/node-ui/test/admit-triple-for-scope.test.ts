import { describe, expect, it } from 'vitest';
import { admitTripleForScope } from '../src/ui/views/project/helpers.js';

// PR #839 sweep 2 — extracted admission predicate shared by
// `scopedTriples` and `singleLayerPanelTriples` (the duplicated
// inline copies that caused Task #19 to exist in the first place).
// These tests lock the predicate at the helper level so any future
// consumer inherits the locked behavior automatically.
describe('admitTripleForScope — sub-graph admission predicate', () => {
  const scopedUris = new Set(['urn:e:in-scope', 'urn:e:also-in-scope']);

  describe('Rule 1 — tagged triple with matching slug admits', () => {
    it('admits a tagged triple whose subGraph matches the named slug', () => {
      const t = { subject: 'urn:e:somewhere', object: '"literal"', subGraph: 'demo' };
      expect(admitTripleForScope(t, { slug: 'demo', isRoot: false, scopedUris })).toBe(true);
    });

    it('does NOT admit via matching-slug rule on the Root branch (Root carries no tagged triples)', () => {
      // The first rule is `!isRoot && t.subGraph === slug`. On the
      // Root branch, even a triple tagged with the Root sentinel
      // must fall through to rule 2 (subGraph !== undefined → reject)
      // because the daemon never writes the sentinel as a subGraph
      // tag in practice.
      const t = { subject: 'urn:e:somewhere', object: '"literal"', subGraph: '__root__' };
      expect(admitTripleForScope(t, { slug: '__root__', isRoot: true, scopedUris })).toBe(false);
    });
  });

  describe('Rule 2 — exact-tag-drop on non-matching slug (load-bearing for PR #772 sweep 1 Bug A + Task #19)', () => {
    it('REJECTS a tagged triple with a different slug even when subject is in scope', () => {
      // The cross-membership leakage shape: subject `urn:e:in-scope`
      // is in scopedUris but the triple is tagged for another slug.
      // Pre-Bug-A this admitted via the OR-shape; the helper now
      // rejects it.
      const t = { subject: 'urn:e:in-scope', object: '"literal"', subGraph: 'other' };
      expect(admitTripleForScope(t, { slug: 'demo', isRoot: false, scopedUris })).toBe(false);
    });

    it('REJECTS a tagged triple with a different slug even when object is in scope', () => {
      const t = { subject: 'urn:e:somewhere', object: 'urn:e:in-scope', subGraph: 'other' };
      expect(admitTripleForScope(t, { slug: 'demo', isRoot: false, scopedUris })).toBe(false);
    });

    it('REJECTS any tagged triple on the Root branch (Root carries no tagged triples by definition)', () => {
      // Cross-membership shape on Root: subject is a root entity
      // (in scopedUris) but the triple carries a named-slug tag.
      // The named slug's view owns that triple; Root must drop it.
      const t = { subject: 'urn:e:in-scope', object: '"literal"', subGraph: 'recipes' };
      expect(admitTripleForScope(t, { slug: '__root__', isRoot: true, scopedUris })).toBe(false);
    });
  });

  describe('Rule 3 — untagged-recovery via endpoint membership', () => {
    it('admits an untagged triple whose subject is in scope', () => {
      const t = { subject: 'urn:e:in-scope', object: '"literal"' };
      expect(admitTripleForScope(t, { slug: 'demo', isRoot: false, scopedUris })).toBe(true);
    });

    it('admits an untagged triple whose object is in scope (default — no requireResourceObject)', () => {
      // Default `requireResourceObject: false` (the scopedTriples
      // shape) admits any object whose canonical URI string is in
      // scope — including literal-shaped values that happen to
      // match (rare; primarily about resource-shaped objects).
      const t = { subject: 'urn:e:somewhere', object: 'urn:e:in-scope' };
      expect(admitTripleForScope(t, { slug: 'demo', isRoot: false, scopedUris })).toBe(true);
    });

    it('REJECTS an untagged triple whose neither endpoint is in scope', () => {
      const t = { subject: 'urn:e:elsewhere', object: 'urn:e:also-elsewhere' };
      expect(admitTripleForScope(t, { slug: 'demo', isRoot: false, scopedUris })).toBe(false);
    });

    it('admits an untagged triple via subject on the Root branch (post-promotion recovery)', () => {
      // Root scope is "root-bucket entities + their untagged
      // recovery edges". A WM-origin triple whose tag erased on
      // promotion still admits if either endpoint is a root entity.
      const t = { subject: 'urn:e:in-scope', object: '"literal"' };
      expect(admitTripleForScope(t, { slug: '__root__', isRoot: true, scopedUris })).toBe(true);
    });
  });

  describe('requireResourceObject — singleLayerPanelTriples-shape gate', () => {
    it('REJECTS an untagged triple whose object is a literal under requireResourceObject', () => {
      // singleLayerPanelTriples handles literal-objects via the
      // subject-local property branch upstream of this predicate;
      // the predicate's job here is admit only resource-shaped
      // edges via the object side. Literal objects with subject
      // out of scope must drop.
      const t = { subject: 'urn:e:elsewhere', object: '"literal-value"' };
      expect(admitTripleForScope(t, {
        slug: 'demo', isRoot: false, scopedUris,
        requireResourceObject: true,
      })).toBe(false);
    });

    it('still admits via subject when subject is in scope under requireResourceObject', () => {
      // Subject-side admission is orthogonal to the object-side
      // gate — a subject-local triple with a literal object still
      // admits because the subject is the in-scope endpoint.
      const t = { subject: 'urn:e:in-scope', object: '"label"' };
      expect(admitTripleForScope(t, {
        slug: 'demo', isRoot: false, scopedUris,
        requireResourceObject: true,
      })).toBe(true);
    });

    it('admits via resource-object when object is in scope under requireResourceObject', () => {
      const t = { subject: 'urn:e:elsewhere', object: 'urn:e:in-scope' };
      expect(admitTripleForScope(t, {
        slug: 'demo', isRoot: false, scopedUris,
        requireResourceObject: true,
      })).toBe(true);
    });

    it('REJECTS an untagged triple whose resource-shaped object is OUT of scope under requireResourceObject', () => {
      const t = { subject: 'urn:e:elsewhere', object: 'urn:e:also-elsewhere' };
      expect(admitTripleForScope(t, {
        slug: 'demo', isRoot: false, scopedUris,
        requireResourceObject: true,
      })).toBe(false);
    });
  });
});
