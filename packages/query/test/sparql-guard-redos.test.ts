import { describe, it, expect } from 'vitest';
import {
  detectSparqlQueryForm,
  validateReadOnlySparql,
} from '../src/sparql-guard.js';

/**
 * Regression coverage for CodeQL alert #65 (`js/redos` against
 * `packages/query/src/sparql-guard.ts:30`). The legacy
 * `READ_ONLY_FORMS` regex had nested `*` quantifiers around `\s+` runs
 * and a `[^\s:]*` label; V8's backtracking NFA exhibited polynomial-
 * to-exponential search-space growth on adversarial preambles like
 * "thousands of PREFIX decls followed by no terminal form".
 *
 * The fix replaced the monolithic regex with a small, anchored
 * declaration scanner that consumes O(n) characters total regardless
 * of preamble shape. These tests pin two properties:
 *   1. functional equivalence on the documented happy-path inputs;
 *   2. linear runtime on adversarial inputs the legacy regex spent
 *      polynomial time on.
 *
 * Because this guard runs on operator-supplied SPARQL arriving over
 * HTTP, a regression here directly re-opens a CPU-DoS vector.
 */
describe('detectSparqlQueryForm — happy path (functional equivalence)', () => {
  it('classifies bare SELECT', () => {
    expect(detectSparqlQueryForm('SELECT * WHERE { ?s ?p ?o }')).toBe('SELECT');
  });

  it('classifies bare ASK / CONSTRUCT / DESCRIBE', () => {
    expect(detectSparqlQueryForm('ASK { ?s ?p ?o }')).toBe('ASK');
    expect(detectSparqlQueryForm('CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }')).toBe('CONSTRUCT');
    expect(detectSparqlQueryForm('DESCRIBE <urn:x>')).toBe('DESCRIBE');
  });

  it('handles single PREFIX declaration', () => {
    expect(detectSparqlQueryForm('PREFIX ex: <http://example.org/> SELECT * WHERE { ?s ?p ?o }')).toBe('SELECT');
  });

  it('handles relative IRI refs in PREFIX and BASE declarations', () => {
    expect(detectSparqlQueryForm('PREFIX ex: <1/> SELECT * WHERE { ?s ?p ?o }')).toBe('SELECT');
    expect(detectSparqlQueryForm('BASE <1/> ASK { ?s ?p ?o }')).toBe('ASK');
  });

  it('handles multi-line PREFIX preamble', () => {
    const q = `
      PREFIX foaf: <http://xmlns.com/foaf/0.1/>
      PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
      PREFIX schema: <http://schema.org/>
      SELECT ?name WHERE { ?p foaf:name ?name }
    `;
    expect(detectSparqlQueryForm(q)).toBe('SELECT');
  });

  it('handles BASE declaration', () => {
    expect(detectSparqlQueryForm('BASE <http://example.org/> SELECT * WHERE { ?s ?p ?o }')).toBe('SELECT');
  });

  it('handles mixed PREFIX + BASE preamble', () => {
    const q = 'BASE <http://x/> PREFIX a: <http://a/> PREFIX b: <http://b/> CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }';
    expect(detectSparqlQueryForm(q)).toBe('CONSTRUCT');
  });

  it('handles empty-default PREFIX (": <iri>")', () => {
    expect(detectSparqlQueryForm('PREFIX : <http://default/> SELECT * WHERE { ?s ?p ?o }')).toBe('SELECT');
  });

  it('handles PREFIX label with dots and dashes (non-ASCII-charset prefixes)', () => {
    expect(detectSparqlQueryForm('PREFIX foaf.core: <http://x/> SELECT * WHERE { ?s ?p ?o }')).toBe('SELECT');
  });

  it('rejects mutating-form starts', () => {
    expect(detectSparqlQueryForm('INSERT DATA { <urn:x> <urn:y> <urn:z> }')).toBe('UNKNOWN');
    expect(detectSparqlQueryForm('DELETE WHERE { ?s ?p ?o }')).toBe('UNKNOWN');
    expect(detectSparqlQueryForm('DROP GRAPH <urn:x>')).toBe('UNKNOWN');
  });

  it('rejects entirely malformed input', () => {
    expect(detectSparqlQueryForm('not a sparql query at all')).toBe('UNKNOWN');
    expect(detectSparqlQueryForm('')).toBe('UNKNOWN');
    expect(detectSparqlQueryForm('   ')).toBe('UNKNOWN');
  });
});

describe('validateReadOnlySparql — happy path (functional equivalence)', () => {
  it('passes plain read-only queries', () => {
    expect(validateReadOnlySparql('SELECT * WHERE { ?s ?p ?o }').safe).toBe(true);
    expect(validateReadOnlySparql('ASK { ?s ?p ?o }').safe).toBe(true);
  });

  it('rejects mutating keywords inside otherwise-read-only-looking queries', () => {
    const r = validateReadOnlySparql('SELECT * WHERE { ?s ?p ?o } INSERT DATA { <urn:x> <urn:y> <urn:z> }');
    expect(r.safe).toBe(false);
    expect(r.reason).toMatch(/INSERT/i);
  });

  it('does not treat mutating words inside relative prologue IRIs as updates', () => {
    const r = validateReadOnlySparql('PREFIX ex: <1/INSERT/> SELECT * WHERE { ?s ?p ?o }');
    expect(r.safe).toBe(true);
  });

  it('rejects queries that do not start with a read-only form', () => {
    const r = validateReadOnlySparql('DROP GRAPH <urn:x>');
    expect(r.safe).toBe(false);
    expect(r.reason).toMatch(/must start with/i);
  });
});

describe('CodeQL js/redos regression: bounded runtime on adversarial preambles', () => {
  // The regression case the legacy regex was vulnerable to: a long
  // run of valid PREFIX declarations followed by NO terminal query
  // form. The legacy regex engine matched the preamble greedily, then
  // tried to anchor the form keyword, failed, and backtracked one
  // declaration at a time exploring polynomially-many states.
  //
  // The scanner replacement consumes each declaration via a single
  // anchored regex with no nested quantifier — total work is O(n).

  // Same-shape measurement helper as the epcis ReDoS regression so
  // CI flake characteristics stay consistent across packages.
  const measure = (input: string) => {
    let minMs = Infinity;
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      const r = detectSparqlQueryForm(input);
      const elapsed = performance.now() - t0;
      expect(typeof r).toBe('string');
      if (elapsed < minMs) minMs = elapsed;
    }
    return minMs;
  };

  it('rejects N=1000 dangling PREFIX decls (no terminal form) in linear time', () => {
    const decls = Array.from({ length: 1_000 }, (_, i) => `PREFIX p${i}: <http://x.org/${i}/>`).join('\n');
    const input = decls + '\n'; // no SELECT — adversarial tail
    const ms = measure(input);
    expect(ms).toBeLessThan(500);
  });

  it('rejects N=10_000 dangling PREFIX decls in bounded time (10x input → bounded growth)', () => {
    const smallInput = Array.from({ length: 1_000 }, (_, i) => `PREFIX p${i}: <http://x.org/${i}/>`).join('\n') + '\n';
    const largeInput = Array.from({ length: 10_000 }, (_, i) => `PREFIX p${i}: <http://x.org/${i}/>`).join('\n') + '\n';

    const smallMs = measure(smallInput);
    const largeMs = measure(largeInput);

    // Hang guard: 10k decls must reject in under a second. The buggy
    // regex took >>10s here in local repro.
    expect(largeMs).toBeLessThan(1000);
    // Linearity guard: 10x input → bounded growth. 25x ceiling +
    // 25ms cushion for noise (same calibration as epcis ReDoS test).
    expect(largeMs).toBeLessThan(smallMs * 25 + 25);
  });

  it('classifies N=10_000 valid PREFIX decls + trailing SELECT in linear time', () => {
    // Positive case at scale — the scanner must accept long but
    // legitimate preambles cleanly.
    const decls = Array.from({ length: 10_000 }, (_, i) => `PREFIX p${i}: <http://x.org/${i}/>`).join('\n');
    const input = decls + '\nSELECT * WHERE { ?s ?p ?o }';
    const ms = measure(input);
    expect(ms).toBeLessThan(500);
    expect(detectSparqlQueryForm(input)).toBe('SELECT');
  });

  it('rejects single PREFIX with unterminated label (no colon) in linear time', () => {
    // The single-regex backtrack-on-failure path: long label that
    // never reaches its required `:`.
    const input = 'PREFIX ' + 'a'.repeat(100_000) + '\n';
    const ms = measure(input);
    expect(ms).toBeLessThan(500);
    expect(detectSparqlQueryForm(input)).toBe('UNKNOWN');
  });
});
