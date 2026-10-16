import { decodeRdfStringLiteral } from '../rdf-literal.js';

interface SparqlBinding {
  value: string;
  type?: 'uri' | 'bnode' | 'literal' | 'typed-literal';
  datatype?: string;
  'xml:lang'?: string;
}

function binding(term: unknown): SparqlBinding | undefined {
  return term !== null && typeof term === 'object' && 'value' in term
    ? term as SparqlBinding : undefined;
}

/** Standard JSON values are already lexical; daemon strings serialize RDF terms. */
export function bindingLexicalValue(term: unknown): string | undefined {
  const json = binding(term);
  if (json) return String(json.value);
  if (term == null) return undefined;
  const value = String(term);
  if (value.startsWith('<') && value.endsWith('>')) return value.slice(1, -1);
  return decodeRdfStringLiteral(value);
}

/** Preserve RDF identity, including literal quotes, language, datatype and blank labels. */
export function bindingRdfTerm(term: unknown): string | undefined {
  const json = binding(term);
  if (!json) return term == null ? undefined : String(term);
  if (json.type === 'bnode') return `_:${json.value.replace(/^_:/, '')}`;
  if (json.type === 'literal' || json.type === 'typed-literal') {
    const text = JSON.stringify(json.value);
    if (json['xml:lang']) return `${text}@${json['xml:lang']}`;
    if (json.datatype) return `${text}^^<${json.datatype}>`;
    return text;
  }
  return String(json.value);
}
