/**
 * `ensureDkgNodeConfig` — write/merge `~/.dkg/config.json` with the
 * agent-agnostic field-level merge that adapter setup paths share.
 *
 * Moved here from the agent-agnostic chunk of OpenClaw's `writeDkgConfig`
 * (`packages/adapter-openclaw/src/setup.ts:504-538`) in S1 of issue #386
 * because adapter-hermes also needs to bootstrap a missing `~/.dkg/config.json`
 * during fresh setup (issue #386 acceptance criterion: "Fresh user flow:
 * install package → `dkg hermes setup` → ...").
 *
 * **Ordering invariant — load-bearing.** Adapter-side wrappers
 * (`writeDkgConfig` in adapter-openclaw, the future Hermes equivalent in
 * adapter-hermes) MUST run their adapter-specific migrations + cleanups
 * + `pruneNetworkPinnedDefaults`-equivalents on the loaded `existing`
 * BEFORE invoking this helper. The `existing` parameter passed in is
 * assumed to be post-migration. The order must not change — see
 * execution-plan.md §3.S1 step 4 + risk-register §8.
 *
 * Field-level merge contract:
 *   - `name`: explicit override > existing > supplied agentName
 *   - `apiPort`: explicit override > existing > supplied apiPort
 *   - `nodeRole`: existing > network.defaultNodeRole
 *   - `contextGraphs`: existing > existing.paranets > network defaults
 *   - `auth`: existing > { enabled: true }
 *   - `relay`: preserved from existing if present (never pinned new)
 *   - `autoUpdate`: only mirrors `enabled` from network when existing
 *     is absent; never pins repo/branch/checkIntervalMinutes
 *
 * Logging: keeps the `[setup] ...` console.log prefix verbatim so
 * user-visible output is unchanged from pre-extraction.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDkgConfigHome } from './dkg-home.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function log(msg: string): void {
  console.log(`[setup] ${msg}`);
}

function dkgDir(): string {
  return resolveDkgConfigHome({ startDir: __dirname });
}

/**
 * The fields of `network/<env>.json` that `ensureDkgNodeConfig` actually
 * reads. Adapters can pass their full `NetworkConfig` shape — the helper
 * only consumes this subset.
 */
export interface DkgNodeNetworkConfig {
  networkName: string;
  defaultNodeRole: string;
  defaultContextGraphs?: string[];
  /** @deprecated Legacy key in older network config files. */
  defaultParanets?: string[];
  autoUpdate?: {
    enabled: boolean;
    [key: string]: unknown;
  };
}

/**
 * Caller-explicit-override flags. Mirrors OpenClaw's
 * `DkgConfigOverrides`: when the user passes `--name` or `--port`, the
 * incoming value wins over any preserved value in the existing config.
 */
export interface DkgNodeConfigOverrides {
  /** True when the user explicitly passed --name. */
  nameExplicit?: boolean;
  /** True when the user explicitly passed --port. */
  portExplicit?: boolean;
}

export interface EnsureDkgNodeConfigOptions {
  /** Discovered or operator-supplied agent name. */
  agentName: string;
  /** Loaded `network/<env>.json` slice. */
  network: DkgNodeNetworkConfig;
  /** Daemon API port to use when no existing config has one. */
  apiPort: number;
  /**
   * The existing `~/.dkg/config.json` parsed into a plain object,
   * **post-adapter-specific migration + prune**. The helper reads
   * `existing.{name,apiPort,nodeRole,contextGraphs,paranets,auth,relay,autoUpdate}`
   * to decide what to keep. Pass `{}` for a fresh setup.
   *
   * Adapter wrappers that own legacy migrations (e.g. OpenClaw's
   * `migrateLegacyOpenClawTransport`, `delete existing.openclawAdapter`,
   * `delete existing.openclawChannel`) MUST run those mutations on this
   * object BEFORE calling this helper. The ordering is load-bearing —
   * see the module-level docstring + execution-plan.md §3.S1 step 4.
   */
  existing: Record<string, any>;
  overrides?: DkgNodeConfigOverrides;
}

/**
 * Merge the post-migration `existing` with network defaults + overrides
 * and write to `~/.dkg/config.json`. Returns nothing; caller logs as
 * needed (this helper logs once via `[setup]` prefix to mirror pre-
 * extraction output).
 */
export function ensureDkgNodeConfig(opts: EnsureDkgNodeConfigOptions): void {
  const { agentName, network, apiPort, existing, overrides } = opts;

  const dir = dkgDir();
  const configPath = join(dir, 'config.json');
  mkdirSync(dir, { recursive: true });

  // Explicit CLI overrides (--name, --port) take precedence over existing
  // config. Auto-detected values only fill in when no existing value is
  // present.
  //
  // We intentionally do NOT persist `chain` or `autoUpdate` from
  // `network/<env>.json` into the user's config when they're absent —
  // the daemon already does field-level merging at runtime via
  // `resolveChainConfig` (cli/src/config.ts) and `resolveAutoUpdateConfig`
  // (same file). Pinning the network defaults here would cement them and
  // break future hub rotations / branch rotations / RPC swaps in
  // `network/<env>.json`. The `...existing` spread below still preserves
  // any chain/autoUpdate the operator added manually (e.g. private RPC
  // override).
  const config: Record<string, any> = {
    ...existing,
    name: overrides?.nameExplicit ? agentName : (existing.name ?? agentName),
    apiPort: overrides?.portExplicit ? apiPort : (existing.apiPort ?? apiPort),
    nodeRole: existing.nodeRole ?? (network.defaultNodeRole as 'edge' | 'core'),
    contextGraphs: existing.contextGraphs
      ?? existing.paranets
      ?? network.defaultContextGraphs
      ?? network.defaultParanets,
    auth: existing.auth ?? { enabled: true },
  };

  // Preserve an existing relay override but never pin a new one — the
  // daemon reads the full relay list from network config (testnet.json)
  // automatically, which is better than hard-coding a single relay into
  // the user's config.
  if (existing.relay) {
    config.relay = existing.relay;
  }

  // Persist only the `enabled` flag mirrored from the network default.
  // `repo`/`branch`/`checkIntervalMinutes`/etc. are intentionally omitted
  // (see big comment above on the resolver contract), but the `enabled`
  // flag has to stay because several consumers — `/api/status`,
  // `/api/info`, the telemetry log pusher in `lifecycle.ts`, and
  // `resolveAutoUpdateEnabled` itself — read `config.autoUpdate?.enabled`
  // directly without falling back to `network.autoUpdate.enabled`.
  // Dropping the whole block would make those report auto-update as
  // disabled on fresh testnet installs even though the updater is in fact
  // running.
  if (!existing.autoUpdate && network.autoUpdate?.enabled !== undefined) {
    config.autoUpdate = { enabled: network.autoUpdate.enabled };
  }

  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  log(`Wrote ${configPath} (${network.networkName}, ${config.nodeRole}, port ${config.apiPort})`);
}
