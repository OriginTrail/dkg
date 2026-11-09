import type { PreparedSparqlQuery } from '@origintrail-official/dkg-rdf-utils/sparql';

/**
 * Plain unordered projection preserves the number of solution mappings. Its
 * outer LIMIT can therefore also bound the internal graph-selection subquery.
 * DISTINCT, aggregates, expressions, ordering, offsets and trailing VALUES can
 * change the required inputs; leave those shapes to the original planner.
 */
export function graphSubselectLimit(scope: PreparedSparqlQuery): string {
  if (scope.operation !== 'SELECT' || !scope.where) return '';
  const tokens = scope.prepared.tokens;
  const projection = tokens.slice(scope.prepared.prologue.endTokenIndex + 1, scope.where.openingTokenIndex);
  const end = projection.at(-1);
  if (end?.kind === 'word' && end.upper === 'WHERE') projection.pop();
  const plainProjection = projection.length > 0 && (projection.every(t => t.kind === 'variable')
    || (projection.length === 1 && projection[0].kind === 'symbol' && projection[0].logicalValue === '*'));
  if (!plainProjection) return '';
  const tail = tokens.slice(scope.where.closingTokenIndex + 1);
  if (tail.length !== 2 || tail[0].kind !== 'word' || tail[0].upper !== 'LIMIT'
    || tail[1].kind !== 'number' || !/^[0-9]+$/.test(tail[1].logicalValue)
    || !Number.isSafeInteger(Number(tail[1].logicalValue))) return '';
  return ` LIMIT ${tail[1].logicalValue}`;
}
