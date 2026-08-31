/**
 * Compare strings lexicographically by Unicode code point.
 *
 * The return value follows the conventional comparator contract: negative,
 * zero, or positive. It deliberately does not expose a distance between
 * prefix lengths, which keeps an exhausted-prefix decision constant-time.
 */
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
