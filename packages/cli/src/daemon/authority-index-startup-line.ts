/**
 * Format the `[info] [authority-index]` daemon startup line.
 *
 * Extracted to a pure function so both bootstrap policies can be unit-tested
 * without standing up a daemon. Operators and the release harness grep this
 * line, so its field order is a contract:
 *
 * - an explicit operator `authorityIndex` block (pinned trusted cores) keeps
 *   the pre-10.0.18 shape, and so does `undefined` (a core, or a node without
 *   any index config), which reports `local-history`;
 * - the runtime-discovered edge default (`discovery: 'on-chain-cores'`) has no
 *   pinned peers to count, so it reports `trustedCoreCount=discovered`, the
 *   discovery source, and the local-history fallback it degrades to when no
 *   discovered core supplies a usable snapshot inside the bootstrap budget.
 *
 * The input is structural rather than the agent's `ResolvedAuthorityIndexConfig`
 * so this module has no transitive imports; that type is assignable to it.
 */
export interface AuthorityIndexStartupLineInput {
  readonly mode: 'core-snapshot';
  readonly trustedCorePeers: readonly string[];
  readonly maxTailBlocks: number;
  readonly cacheEpoch: number;
  /** Present only on the runtime-discovered edge default, never on explicit config. */
  readonly discovery?: 'on-chain-cores';
}

export function formatAuthorityIndexStartupLine(
  authorityIndex: AuthorityIndexStartupLineInput | undefined,
): string {
  if (authorityIndex?.discovery === 'on-chain-cores') {
    return `[info] [authority-index] mode=${authorityIndex.mode} trustedCoreCount=discovered `
      + `discovery=${authorityIndex.discovery} fallback=local-history `
      + `maxTailBlocks=${authorityIndex.maxTailBlocks} cacheEpoch=${authorityIndex.cacheEpoch}`;
  }
  return `[info] [authority-index] mode=${authorityIndex?.mode ?? 'local-history'} `
    + `trustedCoreCount=${authorityIndex?.trustedCorePeers.length ?? 0} `
    + `maxTailBlocks=${authorityIndex?.maxTailBlocks ?? 'unbounded'} `
    + `cacheEpoch=${authorityIndex?.cacheEpoch ?? 0}`;
}
