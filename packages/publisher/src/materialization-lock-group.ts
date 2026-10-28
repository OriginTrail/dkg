import { withMaterializationLock } from './metadata.js';

/** Acquire one canonical, deduplicated lock set in the singleton lock domain. */
export function withMaterializationLocks<T>(
  assets: readonly { metaGraph: string; ual: string }[],
  fn: () => Promise<T>,
  options: { signal?: AbortSignal } = {},
): Promise<T> {
  const unique = new Map(assets.map(a => [`${a.metaGraph}\0${a.ual}`, a]));
  const ordered = [...unique].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, asset]) => asset);
  const acquire = (index: number): Promise<T> => index < ordered.length
    ? withMaterializationLock(ordered[index]!.metaGraph, ordered[index]!.ual, () => acquire(index + 1), options)
    : fn();
  return acquire(0);
}
