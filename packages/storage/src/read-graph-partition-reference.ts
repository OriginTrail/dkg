// SPDX-License-Identifier: Apache-2.0
import { READ_GRAPH_SEGMENT } from '@origintrail-official/dkg-core';
import { isSparqlKeyword, prepareSparql, type ValidPreparedSparql } from '@origintrail-official/dkg-rdf-utils/sparql';
import { isReadGraphPartitionGraph } from './graph-enumeration-visibility.js';

const ABSOLUTE_IRI = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const LOCAL_NAME_ESCAPE = /\\([_~.\-!$&'()*+,;=/?#@%])/g;

function hasReadGraphSegment(iri: string): boolean {
  return iri.split(/[/?#]/).includes(READ_GRAPH_SEGMENT);
}

/**
 * Whether one IRI names a graph in a read-graph partition. A relative IRI
 * with a `_~read` segment counts, because the base it resolves against is not
 * checked here.
 */
function isReadGraphPartitionReference(iri: string): boolean {
  return ABSOLUTE_IRI.test(iri) ? isReadGraphPartitionGraph(iri) : hasReadGraphSegment(iri);
}

/**
 * Whether lexed SPARQL names a graph in a read-graph partition, by IRI or by a
 * prefixed name whose PREFIX is declared in the same text. A BASE with
 * a `_~read` segment counts as well, since relative IRIs resolve against it.
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
    } else if (isSparqlKeyword(tokens, index, 'BASE')) {
      const iri = tokens[index + 1];
      if (iri?.kind === 'iri' && hasReadGraphSegment(iri.logicalValue)) return true;
    }
  }
  return false;
}

/** Only text with the segment, an escape that could spell it, or a PREFIX can name a partition graph. */
function mayNameReadGraphPartition(sparql: string): boolean {
  return sparql.includes(READ_GRAPH_SEGMENT) || /\\[uU]/.test(sparql) || /prefix/i.test(sparql);
}

/**
 * The same test on SPARQL text. Text that cannot be lexed, or that leaves a
 * string open, counts as naming the partition.
 */
export function sparqlNamesReadGraphPartition(sparql: string): boolean {
  if (!mayNameReadGraphPartition(sparql)) return false;
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

const WHOLE_STORE_TARGETS = new Set(['ALL', 'NAMED', 'DEFAULT']);

/**
 * Whether a lexed SPARQL UPDATE clears or drops `ALL`, `NAMED` or `DEFAULT`
 * rather than graphs it names. The first two reach every named graph; on an
 * engine whose default graph merges the named graphs, the third does too.
 */
export function preparedSparqlUpdateReachesEveryGraph(prepared: ValidPreparedSparql): boolean {
  const { tokens } = prepared;
  for (let index = 0; index < tokens.length; index += 1) {
    if (!isSparqlKeyword(tokens, index, 'CLEAR') && !isSparqlKeyword(tokens, index, 'DROP')) continue;
    const target = tokens[isSparqlKeyword(tokens, index + 1, 'SILENT') ? index + 2 : index + 1];
    if (target?.kind === 'word' && WHOLE_STORE_TARGETS.has(target.upper)) return true;
  }
  return false;
}

/**
 * How far a SPARQL UPDATE may write: into a read-graph partition (it names a
 * graph in one, writes through a graph variable, or cannot be lexed or leaves
 * a string open), into every graph (it clears or drops a whole-store target),
 * or only elsewhere.
 */
export type SparqlUpdateReach = 'partition' | 'every-graph' | 'elsewhere';

export function sparqlUpdateReach(sparql: string): SparqlUpdateReach {
  // A graph variable needs a `?` or `$`, and a whole-store target one of its words, written out or as an escape.
  if (!mayNameReadGraphPartition(sparql) && !/[?$]/.test(sparql) && !/\b(?:all|named|default)\b/i.test(sparql)) return 'elsewhere';
  const prepared = prepareSparql(sparql);
  if (prepared.status !== 'valid' || prepared.unterminated) return 'partition';
  if (preparedSparqlNamesReadGraphPartition(prepared) || preparedSparqlWritesThroughGraphVariable(prepared)) return 'partition';
  return preparedSparqlUpdateReachesEveryGraph(prepared) ? 'every-graph' : 'elsewhere';
}

/** Whether a SPARQL UPDATE may write into a read-graph partition, whatever the store holds. */
export function sparqlUpdateMayWriteReadGraphPartition(sparql: string): boolean {
  return sparqlUpdateReach(sparql) === 'partition';
}
