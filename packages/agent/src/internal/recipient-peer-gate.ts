// SPDX-License-Identifier: Apache-2.0

/** Whether two lists name the same members, whatever their order. */
export function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return leftSet.size === rightSet.size && [...leftSet].every((value) => rightSet.has(value));
}

/**
 * Whether the peer gate is the one a resolution was collected with (`null` is no
 * gate). The gate is read through a cache that a concurrent write invalidates, and
 * a read that overlapped such an invalidation can return what was already out of
 * date, so it is read again until it finished while `revision()` stood still. A
 * gate that never settled is not current.
 */
export async function peerGateStayedCurrent(
  resolvedWith: readonly string[] | null,
  readGate: () => Promise<readonly string[] | null>,
  revision: () => string,
  attempts = 3,
): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const before = revision();
    const current = await readGate();
    if (revision() !== before) continue;
    return resolvedWith === null || current === null
      ? resolvedWith === current
      : sameStringSet(resolvedWith, current);
  }
  return false;
}
