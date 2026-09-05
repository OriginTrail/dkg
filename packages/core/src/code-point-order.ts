/** Compare strings lexicographically by Unicode code point. */
export function compareCodePoint(leftValue: string, rightValue: string): number {
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < leftValue.length && rightIndex < rightValue.length) {
    const leftCodePoint = leftValue.codePointAt(leftIndex)!;
    const rightCodePoint = rightValue.codePointAt(rightIndex)!;
    const delta = leftCodePoint - rightCodePoint;
    if (delta !== 0) return delta;

    leftIndex += leftCodePoint > 0xFFFF ? 2 : 1;
    rightIndex += rightCodePoint > 0xFFFF ? 2 : 1;
  }

  if (leftIndex < leftValue.length) return 1;
  if (rightIndex < rightValue.length) return -1;
  return 0;
}

declare const sortedUniqueStringCatalogBrand: unique symbol;

/** Immutable strings proven unique and ordered by {@link compareCodePoint}. */
export type SortedUniqueStringCatalog = readonly string[] & {
  readonly [sortedUniqueStringCatalogBrand]: true;
};

/** Canonical boundary that establishes the sorted/unique catalog invariant. */
export function createSortedUniqueStringCatalog(
  values: Iterable<string>,
): SortedUniqueStringCatalog {
  return Object.freeze([...new Set(values)].sort(compareCodePoint)) as SortedUniqueStringCatalog;
}

function sortedCatalogLowerBound(
  source: SortedUniqueStringCatalog,
  target: string,
): number {
  let low = 0;
  let high = source.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (compareCodePoint(source[middle]!, target) < 0) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** Insert immutably; an existing value returns the original catalog. */
export function insertSortedUniqueStringCatalog(
  source: SortedUniqueStringCatalog,
  value: string,
): SortedUniqueStringCatalog {
  const index = sortedCatalogLowerBound(source, value);
  if (source[index] === value) return source;
  const next = [...source];
  next.splice(index, 0, value);
  return Object.freeze(next) as SortedUniqueStringCatalog;
}

/** Remove immutably; a missing value returns the original catalog. */
export function removeSortedUniqueStringCatalog(
  source: SortedUniqueStringCatalog,
  value: string,
): SortedUniqueStringCatalog {
  const index = sortedCatalogLowerBound(source, value);
  if (source[index] !== value) return source;
  const next = [...source];
  next.splice(index, 1);
  return Object.freeze(next) as SortedUniqueStringCatalog;
}

/** Filtering preserves the source catalog's ordering and uniqueness proof. */
export function filterSortedUniqueStringCatalog(
  source: SortedUniqueStringCatalog,
  predicate: (value: string) => boolean,
): SortedUniqueStringCatalog {
  const filtered = source.filter(predicate);
  return filtered.length === source.length
    ? source
    : Object.freeze(filtered) as SortedUniqueStringCatalog;
}
