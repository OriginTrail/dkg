import type { SparqlLexicalToken } from '@origintrail-official/dkg-rdf-utils/sparql';

function isSymbol(token: SparqlLexicalToken | undefined, value: string): boolean {
  return token?.kind === 'symbol' && token.logicalValue === value;
}

/**
 * How many tokens from `index`, the one after a string, belong to its literal:
 * 2 for `@tag`, 3 for `^^datatype`, 0 for none, and -1 for `^^` with no datatype.
 */
export function literalSuffixLength(tokens: readonly SparqlLexicalToken[], index: number): number {
  if (isSymbol(tokens[index], '@') && tokens[index + 1]?.kind === 'word') return 2;
  if (!isSymbol(tokens[index], '^') || !isSymbol(tokens[index + 1], '^')) return 0;
  const datatype = tokens[index + 2]?.kind;
  return datatype === 'iri' || datatype === 'prefixed-name' ? 3 : -1;
}
