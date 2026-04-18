import { describe, it, expect } from 'vitest';
import { toUri } from '../src/tools/annotations.js';

/**
 * `toUri` decides between treating an arg as an existing URI (pass-
 * through) or as a free-text label (mint via slug normalisation).
 * Wrong decision = either fabricated URIs landing in the graph or
 * human-readable strings being treated as URIs (broken triples).
 */
describe('toUri — URI passthrough vs minting', () => {
  describe('pass-through for known URI schemes', () => {
    it.each([
      'urn:dkg:concept:tree-sitter',
      'urn:dkg:decision:adopt-tree-sitter',
      'urn:dkg:task:phase-7-fix-race',
      'http://schema.org/Person',
      'https://example.com/foo',
      'did:dkg:agent:cursor-branarakic',
    ])('passes through %s unchanged', (uri) => {
      expect(toUri(uri)).toBe(uri);
    });
  });

  describe('mints URIs from free-text labels', () => {
    it.each([
      ['tree-sitter',           'concept', 'urn:dkg:concept:tree-sitter'],
      ['Tree sitter',           'concept', 'urn:dkg:concept:tree-sitter'],
      ['the Cool Topic',        'topic',   'urn:dkg:topic:cool-topic'],
      ['How does X scale?',     'question','urn:dkg:question:how-does-x-scale'],
      ['key insight',           'finding', 'urn:dkg:finding:key-insight'],
    ])('toUri("%s", "%s") → %s', (input, type, expected) => {
      expect(toUri(input, type)).toBe(expected);
    });
  });

  it('defaults to concept type when unspecified', () => {
    expect(toUri('foo bar')).toBe('urn:dkg:concept:foo-bar');
  });

  it('does NOT mint for empty input (slug becomes empty)', () => {
    // Edge case: caller passing empty string should at least be predictable.
    // Current behaviour: returns "urn:dkg:concept:" — caller responsibility
    // to validate non-empty before passing in. We pin the behaviour so a
    // change in slug rule doesn't accidentally start emitting valid-looking
    // URIs from empty input.
    expect(toUri('')).toBe('urn:dkg:concept:');
  });
});
