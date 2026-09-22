/**
 * Format the `[info] [authority-index]` daemon startup line from the agent's
 * authority-index bootstrap plan.
 *
 * Extracted to a pure function so every plan can be unit-tested without
 * standing up a daemon. Operators grep this line, so its field order is a
 * contract:
 *
 * - an operator `authorityIndex` block (pinned trusted cores) and local
 *   history (a core, or an edge that cannot seed) keep the pre-10.0.18 shape;
 * - the network-relay edge default adds its trust source and the
 *   local-history fallback it degrades to when no relay supplies a usable
 *   snapshot inside the bootstrap budget.
 *
 * The input is structural rather than the agent's `AuthorityIndexBootstrapPlan`
 * so this module has no transitive imports; that type is assignable to it.
 */
export interface AuthorityIndexStartupLineInput {
  readonly source: 'operator' | 'network-relays' | 'local-history';
  readonly config?: {
    readonly mode: 'core-snapshot';
    readonly trustedCorePeers: readonly string[];
    readonly maxTailBlocks: number;
    readonly cacheEpoch: number;
  };
}

export function formatAuthorityIndexStartupLine(plan: AuthorityIndexStartupLineInput): string {
  const config = plan.config;
  if (config === undefined) {
    return '[info] [authority-index] mode=local-history trustedCoreCount=0 maxTailBlocks=unbounded cacheEpoch=0';
  }
  const source = plan.source === 'network-relays' ? ' source=network-relays fallback=local-history' : '';
  return `[info] [authority-index] mode=${config.mode} trustedCoreCount=${config.trustedCorePeers.length}${source} `
    + `maxTailBlocks=${config.maxTailBlocks} cacheEpoch=${config.cacheEpoch}`;
}
