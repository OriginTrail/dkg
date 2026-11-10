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
 * prefixed name whose PREFIX is declared in the same text.
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
 * The same test on SPARQL text. Text that mentions the segment, carries
 * escapes that could spell it, or declares a prefix whose names could complete
 * it is lexed; text that cannot be lexed, or that leaves a string, IRI or
 * comment open, counts as naming the partition.
 */
export function sparqlNamesReadGraphPartition(sparql: string): boolean {
  if (!sparql.includes(READ_GRAPH_SEGMENT) && !/\\[uU]/.test(sparql) && !/prefix/i.test(sparql)) return false;
  const prepared = prepareSparql(sparql);
  return prepared.status !== 'valid' || prepared.unterminated || preparedSparqlNamesReadGraphPartition(prepared);
}

const DATA_OR_WHERE = new Set(['DATA', 'WHERE']);

/**
 * Whether a lexed SPARQL UPDATE writes through a graph variable: an INSERT or
 * DELETE template, or a DELETE WHERE pattern, with `GRAPH ?var` in it. Its
 * target is only known when it runs, so it cannot be shown to stay outside
 * read-graph partitions. A graph variable only in a WHERE clause reads.
 */
export function preparedSparqlWritesThroughGraphVariable(prepared: ValidPreparedSparql): boolean {
  const { tokens } = prepared;
  for (let index = 0; index < tokens.length; index += 1) {
    if (!isSparqlKeyword(tokens, index, 'INSERT') && !isSparqlKeyword(tokens, index, 'DELETE')) continue;
    let open = index + 1;
    const next = tokens[open];
    if (next?.kind === 'word' && DATA_OR_WHERE.has(next.upper)) {
      if (next.upper === 'DATA') continue;
      open += 1;
    }
    const brace = tokens[open];
    if (brace?.kind !== 'symbol' || brace.logicalValue !== '{') continue;
    let depth = 0;
    for (let at = open; at < tokens.length; at += 1) {
      const token = tokens[at]!;
      if (token.kind === 'symbol' && token.logicalValue === '{') depth += 1;
      else if (token.kind === 'symbol' && token.logicalValue === '}') {
        depth -= 1;
        if (depth === 0) break;
      } else if (isSparqlKeyword(tokens, at, 'GRAPH') && tokens[at + 1]?.kind === 'variable') {
        return true;
      }
    }
  }
  return false;
}

/**
 * Whether a SPARQL UPDATE may write into a read-graph partition: it names a
 * partition graph, or writes through a graph variable.
 */
export function sparqlUpdateMayWriteReadGraphPartition(sparql: string): boolean {
  if (sparqlNamesReadGraphPartition(sparql)) return true;
  if (!/graph\s*[?$]/i.test(sparql)) return false;
  const prepared = prepareSparql(sparql);
  return prepared.status !== 'valid' || preparedSparqlWritesThroughGraphVariable(prepared);
}
