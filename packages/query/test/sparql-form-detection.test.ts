/**
 * the fail-closed branches in
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
// — sparql-guard.ts:56). Before this
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

  // packages/query/src/index.ts:7).
  //
  // r30-3 deleted the legacy `classifySparqlForm` /
  // `emptyQueryResultForKind` / `SparqlForm` symbols outright; the
  // bot's r31-2 thread flagged the deletion as a source-breaking
  // API change for downstream consumers without a version bump.
  // Restored as `@deprecated` wrappers + a `SparqlForm` type alias
  // (defined in `sparql-guard.ts`, re-exported from the barrel).
  //
  // The anti-drift contract still holds — it just shifted shape:
  //   - Internal call sites (`dkg-query-engine.ts`, `dkg-agent.ts`)
  //     continue to use the canonical pair (`detectSparqlQueryForm`
  //     + `emptyResultForForm` / `emptyResultForSparql`).
  //   - The deprecated wrappers are PURE COMPOSITION over the
  //     canonical pair (`classifySparqlForm` =
  //     `detectSparqlQueryForm` with `'UNKNOWN'` → `'SELECT'`
  //     mapping; `emptyQueryResultForKind` =
  //     `emptyResultForForm`). No parallel logic path is
  //     reintroduced — any future change to ASK/CONSTRUCT shaping
  //     still has to touch ONE canonical spot.
  it('the @deprecated `classifySparqlForm` wrapper composes `detectSparqlQueryForm` with the legacy `UNKNOWN → SELECT` mapping', async () => {
    const { classifySparqlForm, detectSparqlQueryForm } = await import(
      '../src/index.js'
    );
    // Parseable shapes: identical to the canonical classifier.
    for (const q of [
      'SELECT ?s WHERE { ?s ?p ?o }',
      'CONSTRUCT { ?s ?p ?o } WHERE {}',
      'DESCRIBE <urn:x>',
      'ASK { ?s ?p ?o }',
    ]) {
      expect(classifySparqlForm(q)).toBe(detectSparqlQueryForm(q));
    }
    // Unparseable shapes: legacy wrapper coerces to `'SELECT'`,
    // canonical returns `'UNKNOWN'`. This is the byte-compat
    // anchor for any downstream caller that switches on the
    // returned string.
    for (const q of ['not-a-query', '']) {
      expect(detectSparqlQueryForm(q)).toBe('UNKNOWN');
      expect(classifySparqlForm(q)).toBe('SELECT');
    }
  });

  it('the @deprecated `emptyQueryResultForKind` wrapper is byte-compatible with `emptyResultForForm` for every legacy form', async () => {
    const { emptyQueryResultForKind, emptyResultForForm } = await import(
      '../src/index.js'
    );
    for (const form of ['SELECT', 'CONSTRUCT', 'DESCRIBE', 'ASK'] as const) {
      const legacy = emptyQueryResultForKind(form);
      const canonical = emptyResultForForm(form);
      expect(legacy).toEqual(canonical);
      // `quads`-presence parity is the property that determines
      // whether CONSTRUCT/DESCRIBE callers branch correctly. Pin
      // it explicitly so any future shape drift is caught here.
      expect(Object.prototype.hasOwnProperty.call(legacy, 'quads')).toBe(
        Object.prototype.hasOwnProperty.call(canonical, 'quads'),
      );
    }
  });

  it('the @deprecated `emptyQueryResultForKind` wrapper inherits the FRESH-object guarantee', async () => {
    // Same freshness invariant as the canonical builder — the
    // deprecated wrapper must NOT cache or share return values
    // across calls.
    const { emptyQueryResultForKind } = await import('../src/index.js');
    const a = emptyQueryResultForKind('CONSTRUCT');
    const b = emptyQueryResultForKind('CONSTRUCT');
    expect(a).not.toBe(b);
    expect(a.bindings).not.toBe(b.bindings);
    expect(a.quads).not.toBe(b.quads);
    a.bindings.push({ forged: 'v' });
    expect(b.bindings).toEqual([]);
  });

  it('the deprecated barrel exports are PRESENT (anti-removal: keeps backwards compat for downstream consumers)', async () => {
    // r31-2 inverts the r30-3 anti-drift assertion: the legacy
    // symbols MUST be present on the package barrel so existing
    // `@origintrail-official/dkg-query` consumers don't hard-fail
    // on a non-major version bump. If a future refactor removes
    // them again, this test fails and forces an explicit decision
    // (deprecate-then-remove with version bump, NOT silent removal).
    const exports = (await import('../src/index.js')) as Record<string, unknown>;
    expect(typeof exports.classifySparqlForm).toBe('function');
    expect(typeof exports.emptyQueryResultForKind).toBe('function');
    // `SparqlForm` is a type alias and doesn't appear at runtime,
    // but its source-level presence is asserted by the source guard
    // below.
  });

  // packages/query/src/sparql-guard.ts:201).
  //
  // r31-2 restored the `@deprecated` `emptyQueryResultForKind` wrapper
  // but accidentally CHANGED its parameter type from the legacy
  // `string` (raw SPARQL — the function classified internally) to the
  // `SparqlForm` discriminator. That silently broke downstream
  // `emptyQueryResultForKind(query)` callers in two ways:
  //
  //   (a) TypeScript callers: stop compiling outright (`string` is
  //       not assignable to `SparqlForm`).
  //   (b) `JS` / `as any` callers: the function returns the SELECT-
  //       shaped empty result for `ASK` / `CONSTRUCT` queries because
  //       the raw SPARQL string doesn't match any `SparqlForm` variant.
  //
  // r31-4 restores the legacy `string` parameter type and delegates to
  // `emptyResultForSparql()` so existing call sites compile and behave
  // identically to the surface. These tests pin the contract
  // structurally so a future "tighten the signature" change can't
  // re-introduce the regression.
  it('[r31-4] @deprecated `emptyQueryResultForKind` accepts a raw SPARQL STRING (not a SparqlForm) and routes onto the right empty shape', async () => {
    const { emptyQueryResultForKind } = await import('../src/index.js');

    // The exact regression the bot flagged: `emptyQueryResultForKind`
    // called with a real CONSTRUCT query MUST return the CONSTRUCT
    // empty shape (`{ bindings: [], quads: [] }`), not the SELECT
    // empty shape. r31-2 returned SELECT for this input because it
    // typed the param as `SparqlForm` and the raw string didn't match.
    const construct = emptyQueryResultForKind('CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }');
    expect(construct.bindings).toEqual([]);
    expect(construct.quads).toBeDefined();
    expect(construct.quads).toEqual([]);

    // Likewise for DESCRIBE — quads must be present.
    const describe = emptyQueryResultForKind('DESCRIBE <urn:x>');
    expect(describe.bindings).toEqual([]);
    expect(describe.quads).toBeDefined();
    expect(describe.quads).toEqual([]);

    // And ASK — bindings must be `[{ result: 'false' }]` per the
    // dkg-query-engine convention.
    const ask = emptyQueryResultForKind('ASK { ?s ?p ?o }');
    expect(ask.bindings).toEqual([{ result: 'false' }]);
    expect(ask.quads).toBeUndefined();

    // SELECT (with PREFIX preamble, exercising the same parser path).
    const select = emptyQueryResultForKind(
      'PREFIX ex: <urn:example:>\nSELECT ?s WHERE { ?s ex:p ?o }',
    );
    expect(select.bindings).toEqual([]);
    expect(select.quads).toBeUndefined();
  });

  it('[r31-4] `emptyQueryResultForKind` is byte-compatible with `emptyResultForSparql` for every parseable input', async () => {
    // Composition pin: the wrapper IS `emptyResultForSparql`
    // (no parallel logic path). If anyone ever reintroduces local
    // form-classification inside the wrapper, this assertion catches
    // the divergence on every call site.
    const { emptyQueryResultForKind, emptyResultForSparql } = await import(
      '../src/index.js'
    );
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
      expect(emptyQueryResultForKind(q)).toEqual(emptyResultForSparql(q));
    }
  });

  it('[r31-4] `emptyQueryResultForKind` source signature uses `string` (NOT `SparqlForm`) — anti-drift guard for the param type', () => {
    // Source-level guard: the legacy `(form: SparqlForm)` signature
    // is the regression we just fixed. Pin the `(sparql: string)`
    // signature in the source so a future "small tidy-up" that
    // restores the `SparqlForm` parameter type fails CI here.
    const here = dirname(fileURLToPath(import.meta.url));
    const guardPath = resolve(here, '..', 'src', 'sparql-guard.ts');
    const src = readFileSync(guardPath, 'utf-8');
    expect(src).toMatch(
      /\bexport\s+function\s+emptyQueryResultForKind\s*\(\s*sparql\s*:\s*string\s*\)/,
    );
    // Inverse guard: the `(form: SparqlForm)` signature must NOT be
    // present anymore.
    expect(src).not.toMatch(
      /\bexport\s+function\s+emptyQueryResultForKind\s*\(\s*form\s*:\s*SparqlForm\s*\)/,
    );
  });

  it('the deprecated wrappers ARE defined in the source AND ARE annotated `@deprecated` (downstream tooling surfaces the migration)', () => {
    // Source-level guard: the wrappers MUST exist (so the public
    // surface is whole) AND MUST carry `@deprecated` JSDoc
    // annotations (so downstream IDEs surface the strikethrough).
    // This is the reverse of the r30-3 anti-drift guard: the
    // symbols are intentionally back, but they must be marked
    // deprecated so callers see the migration path.
    const here = dirname(fileURLToPath(import.meta.url));
    const guardPath = resolve(here, '..', 'src', 'sparql-guard.ts');
    const src = readFileSync(guardPath, 'utf-8');
    expect(src).toMatch(/\bexport\s+function\s+classifySparqlForm\b/);
    expect(src).toMatch(/\bexport\s+function\s+emptyQueryResultForKind\b/);
    expect(src).toMatch(/\bexport\s+type\s+SparqlForm\b/);
    // JSDoc `@deprecated` tag presence — checked structurally so
    // a future refactor that drops the deprecation marker (which
    // would silently un-deprecate the wrappers) is caught here.
    // The `s` flag makes `.` match newlines so the regex can span
    // a multi-line JSDoc block ending right before the export.
    expect(src).toMatch(/@deprecated[\s\S]*?export\s+function\s+classifySparqlForm/);
    expect(src).toMatch(/@deprecated[\s\S]*?export\s+function\s+emptyQueryResultForKind/);
    expect(src).toMatch(/@deprecated[\s\S]*?export\s+type\s+SparqlForm/);
  });
});
