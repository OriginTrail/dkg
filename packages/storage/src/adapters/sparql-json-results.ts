import { formatCanonicalRdfLiteralTerm } from '@origintrail-official/dkg-rdf-utils';

type SparqlJsonLiteralTerm = {
  type: 'literal' | 'typed-literal';
  value: string;
} & (
  | { 'xml:lang': string; datatype?: never }
  | { datatype: string; 'xml:lang'?: never }
  | { datatype?: never; 'xml:lang'?: never }
);

type AdapterSparqlJsonTerm =
  | { type: 'uri'; value: string }
  | { type: 'bnode'; value: string }
  | SparqlJsonLiteralTerm;

export interface AdapterSparqlJsonSelectResponse {
  head?: { vars?: string[] };
  results?: { bindings?: Array<Record<string, AdapterSparqlJsonTerm>> };
}

function formatSparqlJsonTerm(term: AdapterSparqlJsonTerm): string {
  if (term.type === 'bnode') return `_:${term.value}`;
  if (term.type === 'literal' || term.type === 'typed-literal') {
    if (term['xml:lang']) {
      return formatCanonicalRdfLiteralTerm({
        kind: 'language',
        value: term.value,
        language: term['xml:lang'],
      });
    }
    if (term.datatype) {
      return formatCanonicalRdfLiteralTerm({
        kind: 'typed',
        value: term.value,
        datatype: term.datatype,
      });
    }
    return formatCanonicalRdfLiteralTerm({ kind: 'plain', value: term.value });
  }
  return term.value;
}

/** Convert an adapter SPARQL Results JSON SELECT payload into DKG API bindings. */
export function formatSparqlJsonBindings(
  response: AdapterSparqlJsonSelectResponse,
): Array<Record<string, string>> {
  const variables = response.head?.vars ?? [];
  return (response.results?.bindings ?? []).map((row) => {
    const binding: Record<string, string> = {};
    for (const variable of variables) {
      const term = row[variable];
      if (term) binding[variable] = formatSparqlJsonTerm(term);
    }
    return binding;
  });
}
