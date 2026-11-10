// SPDX-License-Identifier: Apache-2.0
import { READ_GRAPH_SEGMENT } from '@origintrail-official/dkg-core';
import { isSparqlKeyword, prepareSparql, type ValidPreparedSparql } from '@origintrail-official/dkg-rdf-utils/sparql';
import { isReadGraphPartitionGraph } from './graph-enumeration-visibility.js';

const ABSOLUTE_IRI = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const LOCAL_NAME_ESCAPE = /\\([_~.\-!$&'()*+,;=/?#@%])/g;

/**
 * Whether one IRI (absolute, or relative to a BASE the text may declare)
 * names a graph in a read-graph partition. A relative IRI with a `_read`
 * segment counts, because the base it resolves against is not checked here.
 */
function isReadGraphPartitionReference(iri: string): boolean {
  if (ABSOLUTE_IRI.test(iri)) return isReadGraphPartitionGraph(iri);
  return iri.split(/[/?#]/).includes(READ_GRAPH_SEGMENT);
}

/**
 * Whether lexed SPARQL names a read-graph partition graph, by IRI or by a
 * prefixed name whose PREFIX is declared in the same text. An IRI built at
 * run time (`IRI(CONCAT(...))`) is not visible here.
 */
export function preparedSparqlNamesReadGraphPartition(prepared: ValidPreparedSparql): boolean {
  const prefixes = new Map<string, string>();
  const { tokens } = prepared;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token.kind === 'iri') {
      if (isReadGraphPartitionReference(token.logicalValue)) return true;
    } else if (token.kind === 'prefixed-name') {
      const colon = token.logicalValue.indexOf(':');
      const namespace = prefixes.get(token.logicalValue.slice(0, colon));
      const local = token.logicalValue.slice(colon + 1).replace(LOCAL_NAME_ESCAPE, '$1');
      if (namespace !== undefined && isReadGraphPartitionReference(namespace + local)) return true;
    } else if (isSparqlKeyword(tokens, index, 'PREFIX')) {
      const name = tokens[index + 1], iri = tokens[index + 2];
      if (name?.kind === 'prefixed-name' && iri?.kind === 'iri') {
        prefixes.set(name.logicalValue.slice(0, -1), iri.logicalValue);
      }
    }
  }
  return false;
}

/**
 * The same test on SPARQL text. Text that mentions the segment, or carries
 * escapes that could spell it, is lexed; text that cannot be lexed counts as
 * naming the partition.
 */
export function sparqlNamesReadGraphPartition(sparql: string): boolean {
  if (!sparql.includes(READ_GRAPH_SEGMENT) && !/\\[uU]/.test(sparql)) return false;
  const prepared = prepareSparql(sparql);
  return prepared.status !== 'valid' || preparedSparqlNamesReadGraphPartition(prepared);
}
