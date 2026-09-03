import { describe, expect, it } from 'vitest';
import {
  isDefaultContextGraphPlaceholder,
  isDkgConfigPath,
  referencesUnresolvedContextGraphAlias,
  rewriteCompactPredicatesForDkg,
  sanitizeContextGraphArguments,
  sanitizeDkgToolForLocalLlm,
  validateDkgToolCall,
  validateSparqlForDkg,
} from '../src/dkg-tool-validation.js';

describe('DKG SPARQL preflight', () => {
  it('ports qwen-dkg guards for config paths and generic graph placeholders', () => {
    expect(isDkgConfigPath('.dkg/config.yaml')).toBe(true);
    expect(isDkgConfigPath('/tmp/demo/.dkg/config.json')).toBe(true);
    expect(isDefaultContextGraphPlaceholder('default-context-graph-id')).toBe(true);
    expect(isDefaultContextGraphPlaceholder('testing')).toBe(false);
    expect(referencesUnresolvedContextGraphAlias('List catalogs for the default CG.')).toBe(true);
    expect(referencesUnresolvedContextGraphAlias('Inspect the current context graph.')).toBe(true);
    expect(referencesUnresolvedContextGraphAlias('Inspect context graph testing.')).toBe(false);
    expect(sanitizeContextGraphArguments({
      projectId: '.dkg/config.yaml',
      contextGraphId: 'the default context graph',
      selector: 'catalog/query',
    })).toEqual({
      args: { selector: 'catalog/query' },
      removed: ['projectId', 'contextGraphId'],
      reasons: [
        { key: 'projectId', reason: 'config-path', value: '.dkg/config.yaml' },
        { key: 'contextGraphId', reason: 'default-placeholder', value: 'the default context graph' },
      ],
    });
  });

  it('removes configuration-default bait from tool schemas shown to the local model', () => {
    const tool = sanitizeDkgToolForLocalLlm({
      name: 'dkg_query_catalog_list',
      inputSchema: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: 'Graph id. Defaults to .dkg/config.yaml.' },
        },
      },
    });
    const rendered = JSON.stringify(tool.inputSchema);
    expect(rendered).not.toContain('Defaults to .dkg/config.yaml');
    expect(rendered).toContain('Never pass a config filename');
  });

  it('rejects bare absolute IRIs but accepts angle-bracketed IRIs', () => {
    expect(validateSparqlForDkg('ASK { urn:test:item <schema:name> "x" }')).toEqual({
      ok: false,
      errors: ['wrap absolute IRI urn:test:item in angle brackets'],
    });
    expect(validateSparqlForDkg('ASK { <urn:test:item> <schema:name> "x" }').ok).toBe(true);
  });

  it('does not confuse declared or auto-injected prefixed names with absolute IRIs', () => {
    expect(validateSparqlForDkg('SELECT ?x WHERE { ?x schema:name ?name }').ok).toBe(true);
    expect(validateSparqlForDkg('PREFIX urn: <https://example.com/> SELECT ?x WHERE { urn:item schema:name ?x }').ok)
      .toBe(true);
  });

  it.each([
    'PREFIX foaf.core: <http://xmlns.com/foaf/0.1/> SELECT ?s WHERE { ?s foaf.core:name ?n }',
    'PREFIX café: <https://example.com/> SELECT ?s WHERE { ?s café:name ?n }',
    'PREFIX δοκιμή: <https://example.com/> SELECT ?s WHERE { ?s δοκιμή:name ?n }',
  ])('accepts a valid PN_PREFIX label and reaches SELECT: %s', (sparql) => {
    expect(validateSparqlForDkg(sparql)).toEqual({ ok: true, errors: [] });
  });

  it('accepts legal UCHAR prefix names and rejects malformed escapes', () => {
    expect(validateSparqlForDkg(
      String.raw`PREFIX \u0065x: <https://example.com/> SELECT ?s WHERE { ?s ex:name ?n }`,
    )).toEqual({ ok: true, errors: [] });
    expect(validateSparqlForDkg(
      String.raw`PREFIX \u00G0x: <https://example.com/> SELECT ?s WHERE { ?s ex:name ?n }`,
    ).ok).toBe(false);
  });

  it('applies UCHAR preprocessing to absolute-scheme policy checks', () => {
    expect(validateSparqlForDkg(
      String.raw`ASK { \u0075rn:test:item <schema:name> "x" }`,
    ).errors).toContain(String.raw`wrap absolute IRI \u0075rn:test:item in angle brackets`);
    expect(validateSparqlForDkg(
      String.raw`PREFIX \u0075rn: <https://example.com/> ASK { urn:item <schema:name> "x" }`,
    ).ok).toBe(true);
  });

  it('accepts a compact BASE prologue and digit-initial variables', () => {
    expect(validateSparqlForDkg(
      'BASE<https://example.com/>SELECT ?1value WHERE { BIND(<item> AS ?1value) }',
    )).toEqual({ ok: true, errors: [] });
  });

  it('handles long prefix whitespace and aggregate lookalikes without backtracking', () => {
    const paddedQuery = `PREFIX ex: <https://example.com/>${' '.repeat(20_000)}SELECT ?x WHERE { ?x ex:name ?name }`;
    expect(validateSparqlForDkg(paddedQuery).ok).toBe(true);

    const lookalikes = `SELECT ?x WHERE { ?x ?p ?o } ${' COUNTx('.repeat(4_000)}`;
    const result = validateSparqlForDkg(lookalikes);
    expect(result.errors).toContain('balance SPARQL parentheses');
    expect(result.errors).not.toContain('wrap aggregate aliases as (COUNT(...) AS ?count)');
  });

  it('indexes near-limit nested aggregate parentheses in linear work', () => {
    const depth = 8_000;
    const sparql = `SELECT ${' COUNT('.repeat(depth)}${')'.repeat(depth)}`;

    expect(sparql.length).toBeLessThanOrEqual(65_536);
    expect(validateSparqlForDkg(sparql)).toEqual({ ok: true, errors: [] });
  });

  it('keeps keywords in lexical regions inert and reports unterminated regions', () => {
    expect(validateSparqlForDkg([
      'SELECT ?x WHERE {',
      '  BIND("FROM STRCONTAINS(?x) FILTER NOT EXISTS(?x) urn:literal" AS ?x)',
      '  <urn:subject> <urn:predicate> <urn:object> .',
      '  # FROM STRCONTAINS(?x) urn:comment',
      '}',
    ].join('\n')).ok).toBe(true);
    expect(validateSparqlForDkg('SELECT ?x WHERE { BIND("unterminated AS ?x) }').errors)
      .toContain('close the unterminated string literal or IRI');
  });

  it.each([
    [
      'SELECT ?x FROM <urn:g> WHERE { ?x ?p ?o }',
      'remove FROM because projectId, subGraphName, and view already scope the query',
    ],
    [
      'SELECT ?x WHERE { FILTER NOT EXISTS(?x) }',
      'use braces for FILTER NOT EXISTS',
    ],
    [
      'SELECT ?x WHERE { FILTER(STRCONTAINS(str(?x), "a")) }',
      'use SPARQL CONTAINS instead of STRCONTAINS',
    ],
    [
      'SELECT ?x WHERE { FILTER(ex:value=STRCONTAINS(str(?x), "a")) }',
      'use SPARQL CONTAINS instead of STRCONTAINS',
    ],
    [
      'SELECT ?x WHERE { FILTER(?x-STRCONTAINS(str(?x), "a")) }',
      'use SPARQL CONTAINS instead of STRCONTAINS',
    ],
    [
      'SELECT ?x WHERE { ?x ?p ?o ',
      'balance SPARQL braces',
    ],
  ])('rejects an active scanner guard in %s', (sparql, message) => {
    expect(validateSparqlForDkg(sparql).errors).toContain(message);
  });

  it.each([
    'SELECT ?x WHERE { BIND("FROM" AS ?x) }',
    'SELECT ?x WHERE { BIND("FILTER NOT EXISTS(" AS ?x) }',
    'SELECT ?x WHERE { BIND("STRCONTAINS(" AS ?x) }',
    'SELECT ?x WHERE { BIND("{" AS ?x) }',
    'SELECT ?x WHERE { ?x ?p ?o # FROM FILTER NOT EXISTS( STRCONTAINS( {\n}',
  ])('keeps an equivalent string/comment lookalike inert: %s', (sparql) => {
    expect(validateSparqlForDkg(sparql)).toEqual({ ok: true, errors: [] });
  });

  it('rejects oversized SPARQL before preflight parsing', () => {
    const result = validateSparqlForDkg(`SELECT * WHERE {}${' '.repeat(70_000)}`);
    expect(result).toEqual({
      ok: false,
      errors: ['sparql must not exceed 65536 characters'],
    });
  });

  it('detects aggregate aliases that need an outer expression wrapper', () => {
    expect(validateSparqlForDkg(
      'SELECT COUNT(?item) AS ?count WHERE { ?item ?predicate ?object }',
    ).errors).toContain('wrap aggregate aliases as (COUNT(...) AS ?count)');
    expect(validateSparqlForDkg(
      'SELECT (COUNT(?item) AS ?count) WHERE { ?item ?predicate ?object }',
    ).ok).toBe(true);
    expect(validateSparqlForDkg(
      'SELECT COUNT(?item) AS ?1count WHERE { ?item ?predicate ?object }',
    ).errors).toContain('wrap aggregate aliases as (COUNT(...) AS ?count)');
  });

  it('validates both raw and saved-catalog query tools', () => {
    expect(validateDkgToolCall('dkg_query_catalog_save', {
      sparql: 'SELECT ?x WHERE { ?x <schema:category> {{category}} }',
    }).ok).toBe(true);
    expect(validateDkgToolCall('dkg_status', {}).ok).toBe(true);
  });

  it('builds a conservative compact-predicate alternate without changing terms', () => {
    expect(rewriteCompactPredicatesForDkg(
      'SELECT ?model WHERE { ?model a <urn:test:Class> ; schema:name ?name . ?model schema:category ?category }',
    )).toBe(
      'SELECT ?model WHERE { ?model <rdf:type> <urn:test:Class> ; <schema:name> ?name . ?model <schema:category> ?category }',
    );
  });

  it('rewrites only predicate tokens while preserving literals, IRIs, and comments byte-for-byte', () => {
    const input = [
      'SELECT ?s WHERE {',
      '  ?s <schema:description> "?x rdf:type legacy; schema:name untouched" ; schema:name ?name .',
      '  ?s schema:link <urn:example:rdf:type> .',
      '  # ?s rdf:type <urn:comment> ; schema:name ?ignored',
      '}',
    ].join('\n');
    const rewritten = rewriteCompactPredicatesForDkg(input);
    expect(rewritten).toContain('"?x rdf:type legacy; schema:name untouched"');
    expect(rewritten).toContain('<urn:example:rdf:type>');
    expect(rewritten).toContain('# ?s rdf:type <urn:comment> ; schema:name ?ignored');
    expect(rewritten).toContain('; <schema:name> ?name');
    expect(rewritten).toContain('?s <schema:link> <urn:example:rdf:type>');
  });
});
