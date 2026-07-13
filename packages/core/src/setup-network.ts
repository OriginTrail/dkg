/**
 * Shared "which network should a freshly set-up node use?" policy.
 *
 * Used by every config-writing entry point — `dkg init`, and the
 * OpenClaw / Hermes / MCP `setup` flows (via {@link ensureDkgNodeConfig}) —
 * so they agree on the default and on how to treat legacy nodes.
 *
 * Background: nothing historically wrote `config.networkConfig`, so every
 * node relied on the runtime fallback `project.json#defaultNetwork`
 * (= `testnet`). To make new nodes default to mainnet WITHOUT silently
 * retargeting existing testnet nodes, setup now *persists* the selected
 * network explicitly while the runtime fallback stays `testnet`. The rule
 * below encodes that split:
 *
 *   - a genuinely fresh node    → {@link DEFAULT_SETUP_NETWORK} (mainnet-gnosis)
 *   - a legacy node whose caller can infer a bundled network from its chain
 *     → keep that inferred network via `existingNetworkConfig`
 *   - any other legacy node (config on disk but no networkConfig)
 *     → {@link LEGACY_FALLBACK_NETWORK} (testnet)
 *   - a node that already chose  → keep its choice
 *   - an explicit `--network` /
 *     interactive answer         → wins outright
 */

/** The network a brand-new node is set up on when the operator doesn't choose. */
export const DEFAULT_SETUP_NETWORK = 'mainnet-gnosis';

/**
 * The network a pre-existing config WITHOUT an explicit `networkConfig`
 * resolves to. Matches the runtime fallback (`project.json#defaultNetwork`)
 * so a legacy node keeps running exactly where it was.
 */
export const LEGACY_FALLBACK_NETWORK = 'testnet';

/**
 * Networks offered in the interactive `dkg init` prompt, in display order.
 * `mainnet-neuroweb` is intentionally omitted until its network config is
 * deployment-ready (its bundled config is still pre-deployment gated). The
 * `--network` flag accepts any bundled, readiness-passing network name, so
 * this list governs the menu only, not what is selectable.
 */
export const SELECTABLE_SETUP_NETWORKS = [
  'mainnet-gnosis',
  'mainnet-base',
  'testnet',
] as const;

export interface ResolveSetupNetworkNameOptions {
  /**
   * Operator's explicit choice — the `--network <name>` flag value or the
   * interactive answer. When non-empty it wins over everything else.
   */
  explicit?: string | null;
  /**
   * The existing effective network, if known. Callers with access to bundled
   * network metadata should pass a chain-inferred name for legacy configs.
   */
  existingNetworkConfig?: string | null;
  /**
   * Whether a config file already existed on disk before this setup run.
   * Distinguishes a fresh install (→ default mainnet) from a legacy node
   * that never set a network (→ testnet, preserved).
   *
   * Fail-safe: only an explicit `false` (proven-fresh) selects the mainnet
   * default; `true` OR `undefined` (the signal was not provided) resolves to
   * the legacy testnet network, so a forgotten/ambiguous signal can never
   * silently flip a node onto a real-money chain.
   */
  configExisted?: boolean;
}

/**
 * Resolve the network name a setup flow should write into `config.networkConfig`.
 * Pure + total — see the module docstring for the precedence rationale.
 */
export function resolveSetupNetworkName(opts: ResolveSetupNetworkNameOptions): string {
  const explicit = opts.explicit?.trim();
  if (explicit) return explicit;

  const existing = opts.existingNetworkConfig?.trim();
  if (existing) return existing;

  // Fail-safe: only a proven-fresh node (configExisted === false) gets the
  // mainnet default. true OR undefined stays on the legacy testnet network.
  return opts.configExisted === false ? DEFAULT_SETUP_NETWORK : LEGACY_FALLBACK_NETWORK;
}
