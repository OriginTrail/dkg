import { parseRdfLiteralTerm } from '../../packages/rdf-utils/dist/index.js';
const XSD_STRING = 'http://www.w3.org/2001/XMLSchema#string';
const RDF_LANG_STRING = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#langString';

/** RDF term equality preserves lexical value, node kind, datatype and language. */
export function capturedTermIdentity(term) {
  if (typeof term !== 'string') throw Error('Invalid captured RDF term');
  if (term.startsWith('"')) {
    const parsed = parseRdfLiteralTerm(term, { combineSurrogatePairs: true });
    if (!parsed) throw Error('Invalid captured RDF literal');
    return ['literal', parsed.value, parsed.kind === 'language' ? RDF_LANG_STRING
      : parsed.kind === 'typed' ? parsed.datatype : XSD_STRING,
    parsed.kind === 'language' ? parsed.language.toLowerCase() : ''];
  }
  return term.startsWith('_:') ? ['bnode', term.slice(2)] : ['uri', term];
}

export function bindingTermIdentity(term) {
  if (!term || typeof term.value !== 'string') throw Error('Invalid SPARQL RDF term');
  if (term.type === 'uri' || term.type === 'bnode') return [term.type, term.value];
  if (term.type !== 'literal' && term.type !== 'typed-literal') throw Error('Unsupported SPARQL RDF term');
  const language = term['xml:lang']?.toLowerCase() ?? '';
  if (language && term.datatype && term.datatype !== RDF_LANG_STRING) throw Error('Inconsistent language datatype');
  return ['literal', term.value, language ? RDF_LANG_STRING : term.datatype ?? XSD_STRING, language];
}

export function sameCapturedTerm(captured, binding) {
  return JSON.stringify(capturedTermIdentity(captured)) === JSON.stringify(bindingTermIdentity(binding));
}
