import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import oxigraph from 'oxigraph';
import {
  formatIriPrefix,
  formatSparqlTerm,
  getMetrics,
  SparqlTermValidationError,
  type SparqlTermPosition,
} from '@origintrail-official/dkg-core';
import {
  ADAPTER_SPARQL_TERM_POLICY,
  createSparqlTermPolicy,
  type SparqlTermSite,
} from '../src/adapters/sparql-term-policy.js';
import { observeInvalidSparqlTerms } from './helpers/invalid-sparql-term-observer.js';

// Frozen copies of the adapter formatters sparql-terms replaced. They are the
// byte-identity oracle, so they must never be imported from src.
function legacyEscapeUri(uri: string): string {
  return uri.replace(/[<>"{}|\\^`]/g, '');
}
function legacyFormatTerm(term: string): string {
  if (term.startsWith('"')) {
    const m = term.match(/^("(?:[^"\\]|\\.)*")\^\^(?!<)(.+)$/);
    if (m) return `${m[1]}^^<${m[2]}>`;
    return term;
  }
  if (term.startsWith('_:')) return term;
  if (term.startsWith('<')) return term;
  return `<${term}>`;
}
function legacyEscapeString(s: string): string {
  return s.replace(/[\\"]/g, '\\$&');
}

const SITE: SparqlTermSite = { adapter: 'sparql-http', operation: 'insert' };

// The entry points the adapters' statement builders call.
const {
  iriTerm: sparqlIriTerm,
  rdfTerm: sparqlRdfTerm,
  iriPrefix: sparqlIriPrefix,
} = ADAPTER_SPARQL_TERM_POLICY;

const IRIS = [
  'http://ex.org/s',
  'https://ex.org/path/to/thing?q=1&r=two#frag',
  'urn:uuid:6f1d6c50-8b2c-4f3e-9a55-3f0b8b1c2d11',
  'did:dkg:context-graph:0x1234abcd/research/_shared_memory',
  'did:dkg:base:84532/0xabc/42',
  'http://ex.org/caf%C3%A9',
  'http://ex.org/café/Δ/😀',
  'urn:dkg:internal:atomic-graph-replace:1',
  'relative/path',
];

const LITERALS = [
  '""',
  '"plain"',
  '"with \\"escaped\\" quotes and a \\\\ backslash"',
  '"line\\nbreak\\r\\n and \\t tab escapes"',
  '"raw\ttab"',
  '"café Δ 😀"',
  '"\\u00E9 and \\U0001F600"',
  '"hello"@en',
  '"hallo"@de-CH-1996',
  '"42"^^<http://www.w3.org/2001/XMLSchema#integer>',
  '"42"^^http://www.w3.org/2001/XMLSchema#integer',
  '"2026-09-23T00:00:00Z"^^<http://www.w3.org/2001/XMLSchema#dateTime>',
];

const BLANK_NODES = ['_:b0', '_:c14n0', '_:7f3a9c0e5d', '_:0', '_:n3-0', '_:a.b', '_:genid_1', '_:é', '_:x·y'];

let clock = 0;
beforeEach(() => {
  // Step past the once-a-minute warn limit on every read, so each case sees
  // its own warning. The rate-limit case pins the clock instead.
  vi.spyOn(Date, 'now').mockImplementation(() => (clock += 61_000));
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('well-formed terms render byte-identically to the replaced formatters', () => {
  it.each(IRIS)('IRI %s in every IRI position', (iri) => {
    const observed = observeInvalidSparqlTerms();
    for (const position of ['graph', 'subject', 'predicate', 'object'] as const) {
      expect(sparqlIriTerm(iri, position, SITE)).toBe(`<${legacyEscapeUri(iri)}>`);
    }
    expect(observed.counted).toEqual([]);
    expect(observed.warnings).toEqual([]);
  });

  it.each(IRIS)('angle-bracketed IRI <%s> outside the graph position', (iri) => {
    const observed = observeInvalidSparqlTerms();
    const bracketed = `<${iri}>`;
    for (const position of ['subject', 'predicate', 'object'] as const) {
      expect(sparqlIriTerm(bracketed, position, SITE)).toBe(`<${legacyEscapeUri(bracketed)}>`);
    }
    for (const position of ['subject', 'object'] as const) {
      expect(sparqlRdfTerm(bracketed, position, SITE, 'reject')).toBe(legacyFormatTerm(bracketed));
      expect(sparqlRdfTerm(iri, position, SITE, 'reject')).toBe(legacyFormatTerm(iri));
    }
    expect(observed.counted).toEqual([]);
  });

  it.each(LITERALS)('object literal %s', (literal) => {
    const observed = observeInvalidSparqlTerms();
    expect(sparqlRdfTerm(literal, 'object', SITE, 'reject')).toBe(legacyFormatTerm(literal));
    expect(observed.counted).toEqual([]);
    expect(observed.warnings).toEqual([]);
  });

  it.each(BLANK_NODES)('blank node %s where the statement allows one', (label) => {
    const observed = observeInvalidSparqlTerms();
    for (const position of ['subject', 'object'] as const) {
      expect(sparqlRdfTerm(label, position, SITE, 'allow')).toBe(legacyFormatTerm(label));
    }
    expect(observed.counted).toEqual([]);
  });

  it.each([
    '',
    'http://ex.org/',
    'did:dkg:context-graph:0x1234/',
    'https://ex.org/entity/.well-known/genid/',
    'urn:café#',
  ])('subject prefix %j', (prefix) => {
    const observed = observeInvalidSparqlTerms();
    expect(sparqlIriPrefix(prefix, SITE)).toBe(`"${legacyEscapeString(prefix)}"`);
    expect(observed.counted).toEqual([]);
  });
});

interface MalformedCase {
  name: string;
  /** The adapter entry point (observe mode). */
  render: (site: SparqlTermSite) => string;
  /** The strict formatter behind it (the hard-reject path). */
  strict: () => string;
  term: string;
  legacy: string;
  position: SparqlTermPosition;
  kind: 'iri' | 'literal' | 'blank-node';
}

const iri = (term: string, position: SparqlTermPosition): Omit<MalformedCase, 'name'> => ({
  render: (site) => sparqlIriTerm(term, position, site),
  strict: () => formatSparqlTerm(term, { position }),
  term,
  legacy: `<${legacyEscapeUri(term)}>`,
  position,
  kind: term.startsWith('_:') ? 'blank-node' : 'iri',
});
const rdf = (
  term: string,
  position: 'subject' | 'object',
  blankNodes: 'allow' | 'reject',
): Omit<MalformedCase, 'name'> => ({
  render: (site) => sparqlRdfTerm(term, position, site, blankNodes),
  strict: () => formatSparqlTerm(term, { position, blankNodes }),
  term,
  legacy: legacyFormatTerm(term),
  position,
  kind: term.startsWith('"') ? 'literal' : term.startsWith('_:') ? 'blank-node' : 'iri',
});

const MALFORMED: MalformedCase[] = [
  { name: 'IRI with a caret (stripped, so retargeted)', ...iri('urn:parity:x^y', 'graph') },
  { name: 'IRI with a space', ...iri('urn:a b', 'graph') },
  { name: 'IRI with a newline', ...iri('urn:a\nb', 'predicate') },
  { name: 'IRI containing a closing angle bracket', ...iri('urn:p> <urn:q', 'predicate') },
  { name: 'empty IRI', ...iri('', 'graph') },
  { name: 'angle-bracketed graph name', ...iri('<urn:g>', 'graph') },
  { name: 'blank node as a graph name', ...iri('_:g', 'graph') },
  { name: 'blank node as a pattern subject', ...iri('_:b0', 'subject') },
  { name: 'literal as a subject', ...rdf('"x"', 'subject', 'allow') },
  { name: 'literal with a raw newline', ...rdf('"line\nbreak"', 'object', 'allow') },
  { name: 'unterminated literal', ...rdf('"abc', 'object', 'allow') },
  { name: 'literal followed by more statement text', ...rdf('"x" . <urn:a> <urn:b> "y"', 'object', 'allow') },
  { name: 'bare datatype with a space', ...rdf('"5"^^urn:dt with space', 'object', 'allow') },
  { name: 'bracketed object holding two IRIs', ...rdf('<urn:x> <urn:y>', 'object', 'allow') },
  { name: 'bare object IRI containing a closing angle bracket', ...rdf('urn:x> <urn:y', 'object', 'allow') },
  { name: 'blank node label with a space', ...rdf('_:a b', 'subject', 'allow') },
  { name: 'blank node label ending in a dot', ...rdf('_:b.', 'object', 'allow') },
  { name: 'empty blank node label', ...rdf('_:', 'subject', 'allow') },
  { name: 'blank node in a DELETE template', ...rdf('_:b0', 'object', 'reject') },
];

describe('malformed terms are logged and counted, then sent in the pre-validation form', () => {
  it.each(MALFORMED)('$name', ({ render, term, legacy, position, kind }) => {
    const observed = observeInvalidSparqlTerms();
    const site: SparqlTermSite = { adapter: 'blazegraph', operation: 'deleteByPattern' };

    expect(render(site)).toBe(legacy);

    expect(observed.counted).toEqual([{
      value: 1,
      adapter: 'blazegraph',
      operation: 'deleteByPattern',
      position,
      kind,
      enforcement: 'observe',
    }]);
    expect(observed.warnings).toHaveLength(1);
    const [warning] = observed.warnings;
    expect(warning).toContain(
      `blazegraph.deleteByPattern: invalid ${kind} in SPARQL ${position} position (${term.length} chars, fingerprint `,
    );
    expect(warning).not.toContain(JSON.stringify(term));
    if (term !== '') expect(warning).not.toContain(term);
    expect(warning).not.toMatch(/[\r\n]/);
  });

  it('never lets a metrics failure fail the write', () => {
    vi.spyOn(getMetrics().storeSparqlInvalidTermsTotal, 'add').mockImplementation(() => {
      throw new Error('meter unavailable');
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(sparqlIriTerm('urn:a b', 'graph', SITE)).toBe('<urn:a b>');
  });

  it('warns at most once a minute per site, position and kind, but counts every term', () => {
    const observed = observeInvalidSparqlTerms();
    const site: SparqlTermSite = { adapter: 'oxigraph', operation: 'dropGraph' };
    const now = vi.mocked(Date.now);
    now.mockReturnValue(1_000_000);
    sparqlIriTerm('urn:a b', 'graph', site);
    now.mockReturnValue(1_059_999);
    sparqlIriTerm('urn:c d', 'graph', site);
    sparqlIriTerm('_:g', 'graph', site);
    now.mockReturnValue(1_060_000);
    sparqlIriTerm('urn:e f', 'graph', site);

    expect(observed.counted).toHaveLength(4);
    expect(observed.warnings.map((line) => line.match(/invalid (\S+) in SPARQL graph position \((\d+) chars/)?.slice(1)))
      .toEqual([['iri', '7'], ['blank-node', '3'], ['iri', '7']]);
  });

  it('never logs the term itself, only its length and a keyed fingerprint', () => {
    const observed = observeInvalidSparqlTerms();
    const secret = '"apiKey=sk-secret\n"';
    sparqlRdfTerm(secret, 'object', SITE, 'allow');
    sparqlRdfTerm(secret, 'object', SITE, 'allow');
    sparqlRdfTerm('"apiKey=sk-other\n"', 'object', SITE, 'allow');

    const fingerprints = observed.warnings.map((line) => {
      expect(line).not.toContain('apiKey');
      expect(line).not.toContain('sk-');
      return line.match(/\((\d+) chars, fingerprint ([0-9a-f]{12}); the value is not logged\)/)?.slice(1);
    });
    // The same term fingerprints the same within a process, so repeats correlate.
    expect(fingerprints).toEqual([
      [String(secret.length), fingerprints[0]![1]],
      [String(secret.length), fingerprints[0]![1]],
      ['18', expect.not.stringMatching(fingerprints[0]![1])],
    ]);
  });
});

describe('the strict serializer behind each adapter entry point', () => {
  it.each(MALFORMED)('$name throws', ({ strict }) => {
    expect(strict).toThrow(SparqlTermValidationError);
  });
});

describe('subject prefixes', () => {
  it.each([
    ['a line break', 'urn:line\nbreak'],
    ['a carriage return', 'urn:line\rbreak'],
    ['a tab', 'urn:tab\there'],
    ['a space', 'urn:a b'],
    ['a quote', 'urn:with "quotes"'],
    ['a backslash', 'urn:back\\slash'],
  ])('counts a prefix with %s and renders it as before', (_name, prefix) => {
    const observed = observeInvalidSparqlTerms();
    expect(sparqlIriPrefix(prefix, SITE)).toBe(`"${legacyEscapeString(prefix)}"`);
    expect(observed.counted).toEqual([{
      value: 1, adapter: 'sparql-http', operation: 'insert', position: 'subject-prefix', kind: 'iri', enforcement: 'observe',
    }]);
    expect(() => formatIriPrefix(prefix)).toThrow(SparqlTermValidationError);
  });

  it('keeps a line-break prefix failing loudly instead of deleting nothing', () => {
    const store = new oxigraph.Store();
    store.load('<urn:keep> <urn:p> "v" <urn:g> .', { format: 'application/n-quads' });
    const update = (prefix: string) =>
      `DELETE { GRAPH <urn:g> { ?s ?p ?o } } WHERE { GRAPH <urn:g> { ?s ?p ?o . FILTER(STRSTARTS(STR(?s), ${sparqlIriPrefix(prefix, SITE)})) } }`;
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(() => store.update(update('urn:ke\nep'))).toThrow();
    expect(store.size).toBe(1);
    store.update(update('urn:ke'));
    expect(store.size).toBe(0);
  });
});

describe('the enforcement policy', () => {
  const invalid = (enforcement: 'observe' | 'reject', position: string, kind: string) => ({
    value: 1, adapter: 'sparql-http', operation: 'insert', position, kind, enforcement,
  });

  it('runs the adapters in observe mode', () => {
    expect(ADAPTER_SPARQL_TERM_POLICY.enforcement).toBe('observe');
  });

  it('observe mode sends the pre-validation form and reports observe', () => {
    const observed = observeInvalidSparqlTerms();
    const policy = createSparqlTermPolicy('observe');
    expect(policy.iriTerm('urn:a^b', 'graph', SITE)).toBe('<urn:ab>');
    expect(observed.counted).toEqual([invalid('observe', 'graph', 'iri')]);
    // Rendering is all the policy knows about; the adapter may never dispatch it.
    expect(observed.warnings).toEqual([
      expect.stringContaining('Rendered it in the pre-validation form (observe mode)'),
    ]);
    expect(observed.warnings[0]).not.toMatch(/\bsent\b/i);
  });

  it('reject mode throws without quoting the term, and reports reject', () => {
    const observed = observeInvalidSparqlTerms();
    const policy = createSparqlTermPolicy('reject');
    const secret = '"apiKey=sk-secret\n"';
    let error: unknown;
    try {
      policy.rdfTerm(secret, 'object', SITE, 'allow');
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(SparqlTermValidationError);
    expect((error as SparqlTermValidationError).kind).toBe('literal');
    expect((error as Error).message).toMatch(
      /^sparql-http\.insert: invalid literal in SPARQL object position \(19 chars, fingerprint [0-9a-f]{12}\)$/,
    );
    // The validator's own error quotes the term, so it is not kept as the cause.
    expect((error as Error).cause).toBeUndefined();
    expect(observed.counted).toEqual([invalid('reject', 'object', 'literal')]);
    expect(observed.warnings).toEqual([expect.stringContaining('(reject mode)')]);
    expect(observed.warnings[0]).not.toContain('sk-secret');
  });

  it('reject mode throws from every entry point and passes well-formed terms', () => {
    const observed = observeInvalidSparqlTerms();
    const policy = createSparqlTermPolicy('reject');
    expect(() => policy.iriTerm('urn:a b', 'graph', SITE)).toThrow(SparqlTermValidationError);
    expect(() => policy.rdfTerm('_:b0', 'object', SITE, 'reject')).toThrow(SparqlTermValidationError);
    expect(() => policy.iriPrefix('urn:a\nb', SITE)).toThrow(SparqlTermValidationError);
    expect(() => policy.checkBlankNodeLabel('_:a b', 'subject', SITE)).toThrow(SparqlTermValidationError);
    expect(observed.counted.map(({ enforcement }) => enforcement)).toEqual(['reject', 'reject', 'reject', 'reject']);

    expect(policy.iriTerm('urn:g', 'graph', SITE)).toBe('<urn:g>');
    expect(policy.rdfTerm('"v"', 'object', SITE, 'reject')).toBe('"v"');
    expect(policy.iriPrefix('urn:', SITE)).toBe('"urn:"');
    expect(() => policy.checkBlankNodeLabel('_:b0', 'subject', SITE)).not.toThrow();
    expect(observed.counted).toHaveLength(4);
  });
});

describe('the observe policy', () => {
  it('lets a formatter bug propagate instead of counting it as an invalid term', () => {
    const observed = observeInvalidSparqlTerms();
    let calls = 0;
    // Throws on the formatter's first call and behaves on every later one, so
    // a catch-all would count it and render the stripped IRI without a throw.
    const term = Object.assign(new String('urn:ok'), {
      startsWith(this: string, search: string) {
        calls += 1;
        if (calls === 1) throw new RangeError('formatter bug');
        return String.prototype.startsWith.call(this, search);
      },
    }) as unknown as string;

    expect(() => sparqlIriTerm(term, 'graph', SITE)).toThrow(RangeError);
    expect(observed.counted).toEqual([]);
    expect(observed.warnings).toEqual([]);
  });
});
