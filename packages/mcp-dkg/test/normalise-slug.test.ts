import { describe, it, expect } from 'vitest';
import { normaliseSlug } from '../src/tools/annotations.js';

/**
 * Slug normalisation is the convergence rule. Without it, parallel
 * agents mint divergent URIs for the same concept and the graph
 * fragments. These tests pin the algorithm — any change here is a
 * coordination break across the whole DKG annotation ecosystem.
 *
 * Algorithm (per coding-project ontology §7):
 *   1. Lowercase
 *   2. Unicode NFKD + strip combining marks (ASCII fold)
 *   3. Strip stopwords (the/a/an/of/for/and/or/to/in/on/with)
 *   4. Replace any run of non-[a-z0-9] with a single hyphen
 *   5. Trim leading/trailing hyphens
 *   6. Truncate to 60 chars
 */
describe('normaliseSlug — convergence rule', () => {
  describe('case + delimiter normalisation', () => {
    it.each([
      ['tree-sitter', 'tree-sitter'],
      ['Tree-sitter', 'tree-sitter'],
      ['Tree sitter', 'tree-sitter'],
      ['TREE_SITTER', 'tree-sitter'],
      ['Tree-Sitter', 'tree-sitter'],
      ['tree.sitter', 'tree-sitter'],
      ['tree/sitter', 'tree-sitter'],
      ['tree   sitter', 'tree-sitter'],
      ['  Tree-sitter  ', 'tree-sitter'],
    ])('"%s" → "%s"', (input, expected) => {
      expect(normaliseSlug(input)).toBe(expected);
    });
  });

  describe('stopword stripping', () => {
    it.each([
      ['the Tree-Sitter library', 'tree-sitter-library'],
      ['a tree-sitter for python', 'tree-sitter-python'],
      ['parsing of code', 'parsing-code'],
      ['the and or to in on for of', ''], // pathological: all stopwords → empty
      ['Tree-Sitter and Python', 'tree-sitter-python'],
    ])('"%s" → "%s"', (input, expected) => {
      expect(normaliseSlug(input)).toBe(expected);
    });
  });

  describe('Unicode / accent folding', () => {
    it.each([
      ['café', 'cafe'],
      ['naïve approach', 'naive-approach'],
      ['résumé', 'resume'],
      ['Bremišek-Plahuta', 'bremisek-plahuta'],
    ])('"%s" → "%s"', (input, expected) => {
      expect(normaliseSlug(input)).toBe(expected);
    });
  });

  describe('truncation at 60 chars', () => {
    it('truncates inputs longer than 60 chars', () => {
      // "the" / "a" / "of" are stopwords and get stripped; pick a long
      // input made of substantive tokens.
      const long = 'profoundly-verbose-concept-name-exceeding-sixty-characters-by-a-significant-margin';
      const result = normaliseSlug(long);
      expect(result.length).toBeLessThanOrEqual(60);
      expect(result).toMatch(/^profoundly-verbose-concept-name/);
    });

    it('preserves exact 60-char inputs', () => {
      const exactly60 = 'x'.repeat(60);
      expect(normaliseSlug(exactly60)).toBe(exactly60);
    });
  });

  describe('idempotency', () => {
    it('normaliseSlug(normaliseSlug(x)) === normaliseSlug(x) for any input', () => {
      const inputs = [
        'Tree-sitter',
        'the AGENT-FRAMEWORK',
        'café résumé',
        'urn:dkg:concept:foo',
        '   leading and trailing   ',
        '!!!special---chars???',
      ];
      for (const input of inputs) {
        const once = normaliseSlug(input);
        const twice = normaliseSlug(once);
        expect(twice).toBe(once);
      }
    });
  });

  describe('determinism across equivalent inputs', () => {
    it('all variants of the same concept collapse to one slug', () => {
      const variants = [
        'tree-sitter',
        'Tree-sitter',
        'Tree sitter',
        'tree_sitter',
        'TREE-SITTER',
        '  the Tree-Sitter  ',
      ];
      const slugs = variants.map(normaliseSlug);
      const unique = new Set(slugs);
      expect(unique.size).toBe(1);
      expect([...unique][0]).toBe('tree-sitter');
    });
  });

  describe('edge cases', () => {
    it.each([
      ['', ''],
      ['   ', ''],
      ['---', ''],
      ['x', 'x'],                 // single non-stopword char
      ['x y', 'x-y'],             // two non-stopword tokens
      ['123', '123'],
      ['the', ''],                // single stopword → empty
      ['a', ''],                  // 'a' is a stopword too
      ['a b', 'b'],               // stopword "a" stripped; only "b" remains
      ['the and or to', ''],      // all stopwords → empty
    ])('"%s" → "%s"', (input, expected) => {
      expect(normaliseSlug(input)).toBe(expected);
    });
  });
});
