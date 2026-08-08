/**
 * Compare Unicode-scalar strings in canonical UTF-8 byte order without
 * allocating encoded buffers inside Array.sort comparators.
 *
 * UTF-8 preserves scalar-value order. The callers validate scalar Unicode
 * before sorting, so a code-point walk is byte-order equivalent while keeping
 * maximum-size inspections from allocating on every O(n log n) comparison.
 */
export function compareSystemRecordUtf8V1(left: string, right: string): number {
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    const leftPoint = left.codePointAt(leftIndex) as number;
    const rightPoint = right.codePointAt(rightIndex) as number;
    if (leftPoint !== rightPoint) return leftPoint < rightPoint ? -1 : 1;
    leftIndex += leftPoint > 0xffff ? 2 : 1;
    rightIndex += rightPoint > 0xffff ? 2 : 1;
  }
  if (leftIndex === left.length && rightIndex === right.length) return 0;
  return leftIndex === left.length ? -1 : 1;
}
