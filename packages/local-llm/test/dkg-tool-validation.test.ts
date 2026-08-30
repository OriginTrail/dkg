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
