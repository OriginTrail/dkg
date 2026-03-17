import type { Quad } from '@origintrail-official/dkg-storage';

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const SCHEMA_NAME = 'http://schema.org/name';

const PREDICATE_ALIASES = new Map<string, string>([
  [RDF_TYPE, 'is a'],
  ['http://schema.org/worksFor', 'works for'],
  ['http://schema.org/memberOf', 'member of'],
  ['http://schema.org/name', 'name'],
  ['http://schema.org/description', 'description'],
  ['http://schema.org/text', 'text'],
  ['http://schema.org/dateCreated', 'date created'],
  ['http://schema.org/location', 'location'],
  ['http://schema.org/brand', 'brand'],
  ['http://schema.org/manufacturer', 'manufacturer'],
  ['http://schema.org/owns', 'owns'],
  ['http://schema.org/knows', 'knows'],
  ['http://dkg.io/ontology/category', 'category'],
  ['http://dkg.io/ontology/importSource', 'import source'],
]);

export function splitCamelCase(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function uriLocalName(uri: string): string {
  if (!uri) return '';
  const normalized = uri.endsWith('/') ? uri.slice(0, -1) : uri;
  const hashIndex = normalized.lastIndexOf('#');
  const slashIndex = normalized.lastIndexOf('/');
  const colonIndex = normalized.lastIndexOf(':');
  const index = Math.max(hashIndex, slashIndex, colonIndex);
  const name = index >= 0 ? normalized.slice(index + 1) : normalized;
  return splitCamelCase(name);
}

export function predicateToPhrase(predicateUri: string): string {
  return PREDICATE_ALIASES.get(predicateUri) ?? uriLocalName(predicateUri);
}

export function buildLabelMap(quads: Quad[]): Map<string, string> {
  const labelMap = new Map<string, string>();
  for (const quad of quads) {
    if (quad.predicate !== SCHEMA_NAME && quad.predicate !== RDFS_LABEL) continue;
    const value = stripLiteral(quad.object);
    if (!value) continue;
    if (!labelMap.has(quad.subject)) {
      labelMap.set(quad.subject, value);
    }
  }
  return labelMap;
}

export function tripleToText(quad: Quad, labelMap: Map<string, string>): string {
  const subject = termToText(quad.subject, labelMap);
  const predicate = predicateToPhrase(quad.predicate);
  const object = termToText(quad.object, labelMap);
  return [subject, predicate, object]
    .map((part) => part.trim())
    .filter(Boolean)
    .join(', ');
}

function termToText(term: string, labelMap: Map<string, string>): string {
  if (!term) return '';
  if (term.startsWith('"')) return stripLiteral(term);
  if (labelMap.has(term)) return labelMap.get(term)!;
  if (term.startsWith('_:')) return splitCamelCase(term.slice(2));
  return uriLocalName(term);
}

function stripLiteral(value: string): string {
  if (!value.startsWith('"')) return value;

  let index = 1;
  let escaped = false;
  let raw = '';
  while (index < value.length) {
    const char = value[index];
    if (!escaped && char === '"') break;
    if (!escaped && char === '\\') {
      escaped = true;
    } else if (escaped) {
      raw += decodeEscape(char);
      escaped = false;
    } else {
      raw += char;
    }
    index++;
  }

  return raw.trim();
}

function decodeEscape(char: string): string {
  switch (char) {
    case 'n':
      return '\n';
    case 'r':
      return '\r';
    case 't':
      return '\t';
    case '"':
      return '"';
    case '\\':
      return '\\';
    default:
      return char;
  }
}
