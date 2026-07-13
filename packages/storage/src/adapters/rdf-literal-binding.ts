import { formatCanonicalRdfLiteralTerm } from '@origintrail-official/dkg-rdf-utils';

export interface AdapterRdfLiteralBinding {
  value: string;
  language?: string;
  datatype?: string;
}

/**
 * Normalize adapter literal metadata at the storage boundary. Language takes
 * precedence because RDFJS language literals also expose rdf:langString as
 * their datatype, while SPARQL JSON providers may expose either field shape.
 */
export function formatAdapterRdfLiteralBinding(binding: AdapterRdfLiteralBinding): string {
  if (binding.language) {
    return formatCanonicalRdfLiteralTerm({
      kind: 'language',
      value: binding.value,
      language: binding.language,
    });
  }
  if (binding.datatype) {
    return formatCanonicalRdfLiteralTerm({
      kind: 'typed',
      value: binding.value,
      datatype: binding.datatype,
    });
  }
  return formatCanonicalRdfLiteralTerm({ kind: 'plain', value: binding.value });
}
