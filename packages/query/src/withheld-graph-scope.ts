import { assertSafeIri, sparqlString } from '@origintrail-official/dkg-core';
import type { SparqlLexicalToken } from '@origintrail-official/dkg-rdf-utils/sparql';
import { transitionGraphScope, type PreparedGraphScope } from './sparql-graph-scope.js';

export const WITHHELD_GRAPH_QUERY_CODE = 'WITHHELD_GRAPH_QUERY';

/**
 * An unscoped query asked for a withheld graph by name, or used syntax whose
 * graph could not be placed (a relative IRI, an undeclared prefix, BASE).
 */
export class WithheldGraphQueryError extends Error {
  readonly code = WITHHELD_GRAPH_QUERY_CODE;

  constructor(message: string) {
    super(message);
    this.name = 'WithheldGraphQueryError';
  }
}

export function isWithheldGraphQueryError(error: unknown): error is WithheldGraphQueryError {
  return error instanceof Error && (error as { code?: unknown }).code === WITHHELD_GRAPH_QUERY_CODE;
}

const ABSOLUTE_IRI = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/**
 * Leave graphs out of an unscoped query: every root IRI and every graph below
 * it (`<root>/...`). The result is the query's answer over a dataset without
 * those graphs.
 *
 * Each `GRAPH ?var { … }` becomes `{ GRAPH ?var { … } FILTER(…) }`, which
 * drops that pattern's solutions from a withheld graph wherever it stands: at
 * top level, in OPTIONAL, MINUS, UNION, (NOT) EXISTS, a subquery or another
 * GRAPH. A solution that leaves the variable unbound is dropped too, so this
 * can only ever remove rows. An explicit GRAPH or FROM / FROM NAMED IRI inside
 * a withheld root is refused, and so is any graph IRI this rewrite cannot place.
 *
 * Triple patterns outside GRAPH read the store's own default graph, which
 * holds no named graph's content on the stores that run unscoped queries
 * (embedded Oxigraph and its worker).
 */
export function withholdGraphsFromUnscopedQuery(
  scope: PreparedGraphScope,
  roots: readonly string[],
): PreparedGraphScope {
  if (roots.length === 0) return scope;
  for (const root of roots) assertSafeIri(root);
  const { tokens } = scope.prepared;
  if (scope.prepared.wordTokens.has('BASE')) {
    throw new WithheldGraphQueryError('BASE cannot be used while graphs are withheld from unscoped queries');
  }
  const withheld = (iri: string) => roots.some(root => iri === root || iri.startsWith(`${root}/`));
  const place = (token: SparqlLexicalToken | undefined): string | undefined => {
    const iri = token?.kind === 'iri' ? token.logicalValue : prefixedIri(scope, token);
    return iri !== undefined && ABSOLUTE_IRI.test(iri) ? iri : undefined;
  };
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token.kind !== 'word' || token.upper !== 'FROM') continue;
    const next = tokens[index + 1];
    const iri = place(tokens[index + (next?.kind === 'word' && next.upper === 'NAMED' ? 2 : 1)]);
    if (iri === undefined || withheld(iri)) throw refusal(iri);
  }
  const edits: Array<{ at: number; rank: number; text: string }> = [];
  for (const target of scope.graphTargets) {
    if (target.kind !== 'variable') {
      const iri = target.kind === 'iri' && ABSOLUTE_IRI.test(target.iri) ? target.iri : undefined;
      if (iri === undefined || withheld(iri)) throw refusal(iri);
      continue;
    }
    const opening = target.targetTokenIndex + 1;
    const closing = scope.structure.braces.matchingTokenIndexes[opening] ?? -1;
    if (tokens[opening]?.kind !== 'symbol' || tokens[opening]!.logicalValue !== '{' || closing < 0) {
      throw new WithheldGraphQueryError('GRAPH pattern must be followed by a group');
    }
    const variable = target.variable.source;
    const exact = `STR(${variable}) IN (${roots.map(root => sparqlString(root)).join(', ')})`;
    const below = roots.map(root => `STRSTARTS(STR(${variable}), ${sparqlString(`${root}/`)})`).join(' || ');
    // A pattern's closing edit sorts before an adjacent pattern's opening edit.
    edits.push({ at: tokens[target.keywordTokenIndex]!.start, rank: 1, text: '{ ' });
    // Oxigraph leaves the variable unbound for some groups that still read
    // named graphs (a subquery, a nested GRAPH), so an unbound row is dropped.
    edits.push({ at: tokens[closing]!.end, rank: 0,
      text: ` FILTER(BOUND(${variable}) && !(isIRI(${variable}) && (${exact} || ${below}))) }` });
  }
  if (edits.length === 0) return scope;
  edits.sort((left, right) => left.at - right.at || left.rank - right.rank);
  let source = '';
  let cursor = 0;
  for (const edit of edits) {
    source += scope.source.slice(cursor, edit.at) + edit.text;
    cursor = edit.at;
  }
  return transitionGraphScope(scope, source + scope.source.slice(cursor));
}

function prefixedIri(scope: PreparedGraphScope, token: SparqlLexicalToken | undefined): string | undefined {
  if (token?.kind !== 'prefixed-name') return undefined;
  const colon = token.logicalValue.indexOf(':');
  const base = scope.prefixes.get(token.logicalValue.slice(0, colon));
  return base === undefined ? undefined : `${base}${token.logicalValue.slice(colon + 1)}`;
}

function refusal(iri: string | undefined): WithheldGraphQueryError {
  return new WithheldGraphQueryError(iri === undefined
    ? 'A graph named by this query cannot be resolved while graphs are withheld from unscoped queries'
    : `Graph <${iri}> is withheld from unscoped queries`);
}
