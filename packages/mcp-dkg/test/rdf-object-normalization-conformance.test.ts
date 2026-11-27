import { describe, it, expect } from 'vitest';
import {
  normalizeRdfObject,
  isRdfTerm,
  escapeRdfLiteralBody,
} from '../src/tools/assertions.js';

/**
 * GOLDEN conformance fixture for the `dkg_knowledge_asset_create({ quads })`
 * one-shot object-term normalization.
 *
 * WHY THIS EXISTS: MCP is deliberately dependency-light and does NOT depend on
 * `@origintrail-official/dkg-core`, so `normalizeRdfObject` (in
 * `src/tools/assertions.ts`) is a hand-inlined copy of core's
 * `normalizeDkgPublisherObject` / `isDkgRdfTerm` / `escapeDkgRdfLiteral`
 * (`packages/core/src/publisher-extension.ts:212-239`), which OpenClaw + Hermes
 * route the SAME create-tool `quads` shape through. Without a guard the inline
 * copy could silently DRIFT from the public cross-adapter contract.
 *
 * THE CONTRACT IS THE EXPECTED COLUMN. Each `expected` below is HAND-WRITTEN
 * (NOT derived from the implementation) — it is the agreed wire output a
 * `dkg_knowledge_asset_create({ quads })` object must produce identically across
 * MCP / OpenClaw / Hermes. If core's normalizer changes, update the inline copy
 * AND this fixture together (core carries a back-pointer to this file).
 *
 * Rules pinned:
 *   - http/https/urn/did URIs (scheme is case-insensitive) → passed through unchanged.
 *   - blank node `_:b` → passed through unchanged.
 *   - already-quoted literal `"…"` → passed through unchanged (NOT double-quoted).
 *   - anything else (a bare literal) → wrapped in double quotes, with the
 *     N-Triples ECHAR set escaped: backslash, double-quote, \n, \r, \t, \f, \b.
 *   - empty string → `""` (a bare empty literal, NOT a URI).
 */
const GOLDEN: Array<{ input: string; expected: string; note: string }> = [
  // ── bare literals → quoted ────────────────────────────────────────────────
  { input: 'hello world', expected: '"hello world"', note: 'bare literal with a space' },
  { input: 'Alpha', expected: '"Alpha"', note: 'bare single-word literal' },
  { input: '', expected: '""', note: 'empty string → empty quoted literal' },
  { input: '42', expected: '"42"', note: 'numeric-looking bare literal stays a literal' },
  { input: 'mailto:a@b.com', expected: '"mailto:a@b.com"', note: 'non-(http/urn/did) scheme is NOT a URI here' },
  { input: 'ftp://x', expected: '"ftp://x"', note: 'ftp scheme is NOT in the URI allow-list → literal' },

  // ── URIs → pass-through ───────────────────────────────────────────────────
  { input: 'http://example.org/x', expected: 'http://example.org/x', note: 'http URI' },
  { input: 'https://example.org/x', expected: 'https://example.org/x', note: 'https URI' },
  { input: 'HTTPS://EXAMPLE.ORG/X', expected: 'HTTPS://EXAMPLE.ORG/X', note: 'scheme match is case-insensitive' },
  { input: 'urn:dkg:thing', expected: 'urn:dkg:thing', note: 'urn URI' },
  { input: 'URN:dkg:thing', expected: 'URN:dkg:thing', note: 'urn scheme case-insensitive' },
  { input: 'did:dkg:agent/abc', expected: 'did:dkg:agent/abc', note: 'did URI' },

  // ── blank node → pass-through ─────────────────────────────────────────────
  { input: '_:b0', expected: '_:b0', note: 'blank node' },

  // ── already-quoted → pass-through (no double-quoting) ─────────────────────
  { input: '"already"', expected: '"already"', note: 'already-quoted literal kept as-is' },
  { input: '"42"^^<http://www.w3.org/2001/XMLSchema#integer>', expected: '"42"^^<http://www.w3.org/2001/XMLSchema#integer>', note: 'typed literal kept as-is (starts with quote)' },
  { input: '"hello"@en', expected: '"hello"@en', note: 'lang-tagged literal kept as-is (starts with quote)' },

  // ── ECHAR escaping (bare literals needing escapes) ────────────────────────
  { input: 'a"b', expected: '"a\\"b"', note: 'embedded double-quote escaped' },
  { input: 'a\\b', expected: '"a\\\\b"', note: 'embedded backslash escaped' },
  { input: 'line1\nline2', expected: '"line1\\nline2"', note: 'newline escaped' },
  { input: 'r\rr', expected: '"r\\rr"', note: 'carriage return escaped' },
  { input: 'tab\there', expected: '"tab\\there"', note: 'tab escaped' },
  { input: 'form\ffeed', expected: '"form\\ffeed"', note: 'form-feed escaped' },
  { input: 'bs\bhere', expected: '"bs\\bhere"', note: 'backspace escaped' },
  { input: 'a"b\nc', expected: '"a\\"b\\nc"', note: 'quote + newline together' },
  // ── non-ECHAR control chars (#416): must become \uXXXX, not pass through raw ──
  { input: 'nul\u0000x', expected: '"nul\\u0000x"', note: 'NUL → \\u0000 UCHAR' },
  { input: 'vt\u000Bx', expected: '"vt\\u000Bx"', note: 'vertical tab (0x0B) → \\u000B' },
  { input: 'us\u001Fx', expected: '"us\\u001Fx"', note: 'unit separator (0x1F) → \\u001F' },
  { input: 'del\u007Fx', expected: '"del\\u007Fx"', note: 'DEL (0x7F) → \\u007F' },
];

describe('rdf-object-normalization conformance (dkg_knowledge_asset_create quads — cross-adapter parity)', () => {
  for (const { input, expected, note } of GOLDEN) {
    it(`normalizeRdfObject(${JSON.stringify(input)}) === ${JSON.stringify(expected)}  [${note}]`, () => {
      expect(normalizeRdfObject(input)).toBe(expected);
    });
  }

  it('isRdfTerm classifies URIs / blank nodes / quoted literals as terms, bare text as not', () => {
    expect(isRdfTerm('http://x')).toBe(true);
    expect(isRdfTerm('https://x')).toBe(true);
    expect(isRdfTerm('urn:x')).toBe(true);
    expect(isRdfTerm('did:x')).toBe(true);
    expect(isRdfTerm('HTTP://X')).toBe(true);
    expect(isRdfTerm('_:b')).toBe(true);
    expect(isRdfTerm('"quoted"')).toBe(true);
    expect(isRdfTerm('bare text')).toBe(false);
    expect(isRdfTerm('')).toBe(false);
    expect(isRdfTerm('ftp://x')).toBe(false);
  });

  it('escapeRdfLiteralBody escapes the N-Triples ECHAR set (body only, no surrounding quotes)', () => {
    expect(escapeRdfLiteralBody('a\\b"c\nd\re\tf\fg\bh')).toBe('a\\\\b\\"c\\nd\\re\\tf\\fg\\bh');
    expect(escapeRdfLiteralBody('plain')).toBe('plain');
    // #416: non-ECHAR C0 controls + DEL become \uXXXX (uppercase, 4-digit).
    expect(escapeRdfLiteralBody('a\u0000b\u000Bc\u007Fd')).toBe('a\\u0000b\\u000Bc\\u007Fd');
  });
});
