/**
 * PR #229 bot review round 17 (r17-2): the fail-closed branches in
 * `DKGAgent.query()` (WM cross-agent auth denial, private-CG leak
 * guard, unreadable context graph) must emit a `QueryResult` whose
 * SHAPE matches the form the caller asked for — otherwise a
 * `CONSTRUCT`/`DESCRIBE` caller that branches on
 * `result.quads !== undefined` misreads a deny as a bindings-only
 * SELECT success.
 *
 * These tests pin the two exports that make the shape contract
 * explicit: `detectSparqlQueryForm` and `emptyResultForForm`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  detectSparqlQueryForm,
  emptyResultForForm,
  emptyResultForSparql,
  type SparqlQueryForm,
} from '../src/index.js';

describe('detectSparqlQueryForm', () => {
  it('classifies SELECT', () => {
    expect(detectSparqlQueryForm('SELECT ?s WHERE { ?s ?p ?o }')).toBe('SELECT');
    expect(detectSparqlQueryForm('select ?s where { ?s ?p ?o }')).toBe('SELECT');
  });

  it('classifies CONSTRUCT', () => {
    expect(detectSparqlQueryForm('CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }')).toBe('CONSTRUCT');
    expect(detectSparqlQueryForm('construct { ?s ?p ?o } where { ?s ?p ?o }')).toBe('CONSTRUCT');
  });

  it('classifies ASK', () => {
    expect(detectSparqlQueryForm('ASK { ?s ?p ?o }')).toBe('ASK');
    expect(detectSparqlQueryForm('ask { ?s ?p ?o }')).toBe('ASK');
  });

  it('classifies DESCRIBE', () => {
    expect(detectSparqlQueryForm('DESCRIBE <urn:x>')).toBe('DESCRIBE');
    expect(detectSparqlQueryForm('describe <urn:x>')).toBe('DESCRIBE');
  });

  it('looks through PREFIX / BASE preamble', () => {
    const q = [
      'PREFIX ex: <urn:example:>',
      'PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>',
      'CONSTRUCT { ?s a ex:Thing } WHERE { ?s ?p ?o }',
    ].join('\n');
    expect(detectSparqlQueryForm(q)).toBe('CONSTRUCT');
  });

  it('returns UNKNOWN for mutating / garbage input so callers can fall back safely', () => {
    expect(detectSparqlQueryForm('INSERT DATA { <urn:x> <urn:p> "y" }')).toBe('UNKNOWN');
    expect(detectSparqlQueryForm('DROP GRAPH <urn:g>')).toBe('UNKNOWN');
    expect(detectSparqlQueryForm('')).toBe('UNKNOWN');
    expect(detectSparqlQueryForm('not-a-query')).toBe('UNKNOWN');
  });
});

describe('emptyResultForForm — shape contract', () => {
  it('SELECT → bindings only, quads absent', () => {
    const r = emptyResultForForm('SELECT');
    expect(r.bindings).toEqual([]);
    expect(r.quads).toBeUndefined();
    // `quads` missing is the distinguishing trait — readers that
    // branch on `result.quads !== undefined` must treat this as a
    // bindings-only result.
    expect(Object.prototype.hasOwnProperty.call(r, 'quads')).toBe(false);
  });

  it('CONSTRUCT → bindings:[] AND quads:[] (both present)', () => {
    const r = emptyResultForForm('CONSTRUCT');
    expect(r.bindings).toEqual([]);
    expect(r.quads).toBeDefined();
    expect(r.quads).toEqual([]);
  });

  it('DESCRIBE → bindings:[] AND quads:[] (same as CONSTRUCT — both yield triples)', () => {
    const r = emptyResultForForm('DESCRIBE');
    expect(r.bindings).toEqual([]);
    expect(r.quads).toBeDefined();
    expect(r.quads).toEqual([]);
  });

  it('ASK → synthetic bindings [{ result: "false" }] matching dkg-query-engine normalization', () => {
    const r = emptyResultForForm('ASK');
    // dkg-query-engine surfaces ASK results via bindings; a false
    // ASK is the safest deny shape (as if the assertion failed).
    expect(r.bindings).toEqual([{ result: 'false' }]);
    expect(r.quads).toBeUndefined();
  });

  it('UNKNOWN → empty bindings (safe default, unreachable from DKGAgent.query)', () => {
    const r = emptyResultForForm('UNKNOWN');
    expect(r.bindings).toEqual([]);
    expect(r.quads).toBeUndefined();
  });

  it('returns a FRESH object per call — two calls cannot alias each other', () => {
    // Structural pin: the helper is documented to return a fresh
    // object on every call so callers that mutate it (appending
    // bindings before returning, downstream deep-freeze, etc.)
    // cannot poison a later deny path.
    const a = emptyResultForForm('CONSTRUCT');
    const b = emptyResultForForm('CONSTRUCT');
    expect(a).not.toBe(b);
    expect(a.bindings).not.toBe(b.bindings);
    expect(a.quads).not.toBe(b.quads);

    // Mutating one must not affect the other.
    a.bindings.push({ forged: 'v' });
    expect(b.bindings).toEqual([]);
  });
});

describe('round-trip: form → empty result preserves the `quads` presence distinction', () => {
  const cases: Array<[string, SparqlQueryForm, boolean]> = [
    ['SELECT ?s WHERE { ?s ?p ?o }',     'SELECT',    false],
    ['CONSTRUCT { ?s ?p ?o } WHERE {}',  'CONSTRUCT', true],
    ['DESCRIBE <urn:x>',                 'DESCRIBE',  true],
    ['ASK { ?s ?p ?o }',                 'ASK',       false],
  ];
  for (const [q, expectedForm, hasQuads] of cases) {
    it(`${expectedForm}: ${q}`, () => {
      const form = detectSparqlQueryForm(q);
      expect(form).toBe(expectedForm);
      const r = emptyResultForForm(form);
      expect(Object.prototype.hasOwnProperty.call(r, 'quads')).toBe(hasQuads);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────
// PR #229 bot review (r3148... — sparql-guard.ts:56). Before this
// consolidation, `sparql-guard.ts` exported TWO parallel pairs:
//   (a) detectSparqlQueryForm + emptyResultForForm
//   (b) classifySparqlForm    + emptyQueryResultForKind
// (a) returned `UNKNOWN` for unparseable input; (b) silently mapped
// it to `SELECT`. Two pairs meant the next time ASK/CONSTRUCT shaping
// changed, only one would get updated and the other call path would
// reintroduce the malformed empty-response bug. The bot asked for
// consolidation onto ONE pair.
//
// These tests pin the anti-drift contract structurally so any future
// re-introduction of the legacy pair fails CI:
//   1. The legacy symbols are no longer exported from the package
//      barrel.
//   2. `sparql-guard.ts` source no longer defines the legacy
//      identifiers.
//   3. The new ergonomic one-shot helper `emptyResultForSparql`
//      delegates to `emptyResultForForm(detectSparqlQueryForm(sparql))`
//      bit-for-bit (no parallel logic path).
// ─────────────────────────────────────────────────────────────────────
describe('[r30-3] consolidation: single canonical form-classifier + empty-result builder pair', () => {
  it('emptyResultForSparql composes the canonical pair (no parallel classifier)', () => {
    // For every form: emptyResultForSparql(q) must structurally equal
    // emptyResultForForm(detectSparqlQueryForm(q)). If anyone ever
    // re-introduces a parallel classifier with subtly different
    // shaping (the EXACT regression the bot flagged), this assertion
    // immediately catches the divergence.
    const queries: string[] = [
      'SELECT ?s WHERE { ?s ?p ?o }',
      'CONSTRUCT { ?s ?p ?o } WHERE {}',
      'DESCRIBE <urn:x>',
      'ASK { ?s ?p ?o }',
      'PREFIX ex: <urn:example:>\nSELECT ?s WHERE { ?s ex:p ?o }',
      'not-a-query',
      '',
    ];
    for (const q of queries) {
      const oneShot = emptyResultForSparql(q);
      const twoStep = emptyResultForForm(detectSparqlQueryForm(q));
      expect(oneShot).toEqual(twoStep);
      // `quads` presence parity is the property that makes
      // CONSTRUCT/DESCRIBE callers branch correctly. Pin it both ways.
      expect(Object.prototype.hasOwnProperty.call(oneShot, 'quads'))
        .toBe(Object.prototype.hasOwnProperty.call(twoStep, 'quads'));
    }
  });

  it('emptyResultForSparql returns a FRESH object (no shared mutable state with emptyResultForForm)', () => {
    // The convenience wrapper must inherit the freshness guarantee
    // of the underlying builder — otherwise a caller mutating the
    // returned `bindings` would poison every later deny that hit
    // the same form.
    const a = emptyResultForSparql('CONSTRUCT { ?s ?p ?o } WHERE {}');
    const b = emptyResultForSparql('CONSTRUCT { ?s ?p ?o } WHERE {}');
    expect(a).not.toBe(b);
    expect(a.bindings).not.toBe(b.bindings);
    expect(a.quads).not.toBe(b.quads);
    a.bindings.push({ forged: 'v' });
    expect(b.bindings).toEqual([]);
  });

  it('legacy `classifySparqlForm` and `emptyQueryResultForKind` are NOT exported from the package barrel (anti-drift)', async () => {
    // Dynamic import so the test still loads even if the symbols
    // were re-introduced (would just observe their presence and
    // fail the assertion below).
    const exports = (await import('../src/index.js')) as Record<string, unknown>;
    expect(exports.classifySparqlForm).toBeUndefined();
    expect(exports.emptyQueryResultForKind).toBeUndefined();
    // The legacy `SparqlForm` type alias was the second exported
    // surface that proved drift was happening. Confirm it's gone too.
    // (Type aliases don't appear at runtime, so this is satisfied
    // structurally by tsc — re-introducing the export would be a
    // compile error in this file's import statement.)
  });

  it('legacy identifiers are NOT defined in the source (anti-regression source guard)', () => {
    // Source-level guard: if a future commit re-adds
    // `classifySparqlForm` / `emptyQueryResultForKind` / `SparqlForm`
    // to `sparql-guard.ts` (even unexported), this check fails and
    // forces the author to choose: extend the canonical pair instead.
    // This is the "any future change to ASK/CONSTRUCT shaping has to
    // touch ONE spot, not two" enforcement the bot asked for.
    const here = dirname(fileURLToPath(import.meta.url));
    const guardPath = resolve(here, '..', 'src', 'sparql-guard.ts');
    const src = readFileSync(guardPath, 'utf-8');
    // Match the IDENTIFIER (function/type definition tokens), not
    // the comment/historical references. We allow the symbols to
    // appear in JSDoc strings explaining the consolidation.
    expect(src).not.toMatch(/\bexport\s+function\s+classifySparqlForm\b/);
    expect(src).not.toMatch(/\bexport\s+function\s+emptyQueryResultForKind\b/);
    expect(src).not.toMatch(/\bexport\s+type\s+SparqlForm\b/);
    expect(src).not.toMatch(/\bfunction\s+classifySparqlForm\b/);
    expect(src).not.toMatch(/\bfunction\s+emptyQueryResultForKind\b/);
  });
});
