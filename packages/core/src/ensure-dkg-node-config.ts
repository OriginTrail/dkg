/**
 * `ensureDkgNodeConfig` — create or update the DKG home config
 * (`~/.dkg/config.json`, or `config.yaml` on a YAML-configured node) with the
 * agent-agnostic field-level merge that adapter setup paths share.
 *
 * Moved here from the agent-agnostic chunk of OpenClaw's `writeDkgConfig`
 * (`packages/adapter-openclaw/src/setup.ts:504-538`) in S1 of issue #386
 * because adapter-hermes also needs to bootstrap a missing `~/.dkg/config.json`
 * during fresh setup (issue #386 acceptance criterion: "Fresh user flow:
 * install package → `dkg hermes setup` → ...").
 *
 * The write is a patch through `updateHomeConfigFile`: under the config lock
 * the daemon and CLI also take, the file is re-read, only the keys below are
 * set, and the file is replaced atomically in its own format. A daemon or CLI
 * edit made while setup runs therefore survives, and a YAML-only node never
 * gets a `config.json` that would shadow its `config.yaml`.
 *
 * **Ordering invariant — load-bearing.** Adapter-side wrappers
 * (`writeDkgConfig` in adapter-openclaw) pass their adapter-specific
 * migrations + cleanups + `pruneNetworkPinnedDefaults`-equivalents as
 * `migrateExisting`, which runs on the re-read file object BEFORE the
 * field-level merge, inside the same locked update. The order must not
 * change — see execution-plan.md §3.S1 step 4 + risk-register §8.
 *
 * Field-level merge contract (every other key is left as the file has it):
 *   - `name`: explicit override > existing > supplied agentName
 *   - `networkConfig`: always the selected network
 *   - `apiPort`: explicit override > existing > supplied apiPort
 *   - `nodeRole`: existing > network.defaultNodeRole
 *   - `contextGraphs`: existing > network defaults
 *   - `auth`: existing > { enabled: true }
 *   - `logging.kaPublishLifecycleDebug`: existing > false
 *   - `relay`: preserved from existing if present (never pinned new)
 *   - `autoUpdate`: only mirrors `enabled` from network when existing
 *     is absent; never pins repo/branch/checkIntervalMinutes
 *   - `store`: seeded with the `oxigraph-server` default only on a fresh
 *     home (issue #960); an existing node's store is never changed
 *
 * Logging: keeps the `[setup] ...` console.log prefix verbatim so
 * user-visible output is unchanged from pre-extraction.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDkgConfigHome } from './dkg-home.js';
import { homeConfigSources, updateHomeConfigFile, type HomeConfigFile } from './home-config-file.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Read a node's persisted config from its home directory, honoring BOTH
 * `config.json` and `config.yaml`. A present, parseable `config.json` is
 * authoritative (`config.yaml` is not consulted); `config.yaml` is read only
 * when `config.json` is absent. Returns the file's own object (no defaults)
 * and its path, or `undefined` when no readable config exists.
 *
 * NOTE: on a CORRUPT `config.json` this falls through to `config.yaml`
 * (best-effort), whereas the daemon's `loadConfig` re-throws and refuses to
 * boot — harmless divergence since a corrupt config.json makes the node
 * unbootable (and a setup write refuses it), so what is read is moot.
 */
export function readPersistedHomeConfig(
  home: string,
): { path: string; config: Record<string, unknown> } | undefined {
  for (const source of homeConfigSources(home)) {
    if (!existsSync(source.path)) continue;
    try {
      const raw = source.parse(readFileSync(source.path, 'utf-8'));
      if (raw && typeof raw === 'object') return { path: source.path, config: raw as Record<string, unknown> };
    } catch { /* corrupt — fall through to the next file (best-effort) */ }
  }
  return undefined;
}

/**
 * Read the persisted `networkConfig` selector from a node's home directory
 * via {@link readPersistedHomeConfig} (so `config.json`, else `config.yaml`).
 * Returns `undefined` when no config exists or `networkConfig` is
 * unset/blank.
 *
 * Setup flows use this (not a json-only read) so a YAML-only node's network
 * is correctly identified and not mis-resolved to the legacy testnet fallback
 * (which would misfire the testnet faucet against a mainnet node).
 */
export function readPersistedNetworkConfigName(home: string): string | undefined {
  const networkConfig = readPersistedHomeConfig(home)?.config.networkConfig;
  return typeof networkConfig === 'string' && networkConfig.trim() ? networkConfig.trim() : undefined;
}

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
  /**
   * The network overlay name to persist as `config.networkConfig` (e.g.
   * `'mainnet-gnosis'`). Callers resolve this via `resolveSetupNetworkName`
   * and MUST load `network` from the SAME name so the persisted selector and
   * the network slice agree. Persisting it explicitly is what makes setup
   * default new nodes onto mainnet without relying on (or mutating) the
   * `project.json#defaultNetwork` runtime fallback.
   */
  networkConfigName: string;
  /** Daemon API port to use when no existing config has one. */
  apiPort: number;
  /**
   * Adapter-specific migrations, cleanups and prunes (e.g. OpenClaw's
   * `migrateLegacyOpenClawTransport`, `delete existing.openclawAdapter`,
   * `delete existing.openclawChannel`, `pruneNetworkPinnedDefaults`). It gets
   * the config file's own object, re-read under the config lock, and runs
   * BEFORE the field-level merge reads
   * `existing.{name,apiPort,nodeRole,contextGraphs,auth,logging,relay,autoUpdate,store}`.
   * It must be synchronous and change only keys its adapter owns. The
   * ordering is load-bearing — see the module-level docstring +
   * execution-plan.md §3.S1 step 4.
   */
  migrateExisting?: (existing: Record<string, any>, file: HomeConfigFile) => void;
  overrides?: DkgNodeConfigOverrides;
}

export interface EnsureDkgNodeConfigResult {
  /** The file holding the node config: `config.json`, or `config.yaml` on a YAML-only node. */
  path: string;
  /** False when the config already matched, in which case nothing was written. */
  changed: boolean;
  /** The merged config as persisted, for reading back the effective `name` / `apiPort`. */
  config: Record<string, any>;
}

/**
 * Merge network defaults + overrides into the node config and persist it
 * through the locked, atomic `updateHomeConfigFile`, setting only the keys
 * listed in the module docstring. Logs once via the `[setup]` prefix to
 * mirror pre-extraction output.
 */
export async function ensureDkgNodeConfig(opts: EnsureDkgNodeConfigOptions): Promise<EnsureDkgNodeConfigResult> {
  const { agentName, network, networkConfigName, apiPort, migrateExisting, overrides } = opts;

  let persisted: Record<string, any> = {};
  const { path, changed } = await updateHomeConfigFile<Record<string, any>>(dkgDir(), (config, file) => {
    migrateExisting?.(config, file);
    persisted = config;

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
    // `network/<env>.json`. Keys this helper does not set keep whatever the
    // file has, including any chain/autoUpdate the operator added manually
    // (e.g. private RPC override).
    config.name = overrides?.nameExplicit ? agentName : (config.name ?? agentName);
    // Persist the selected network EXPLICITLY. Unlike `chain`/`autoUpdate`
    // (deliberately left to the runtime resolver above), the network
    // selector is pinned so a node never silently follows a change to the
    // `project.json#defaultNetwork` runtime fallback — switching networks is
    // a deliberate, money-bearing act, not an implicit default drift.
    config.networkConfig = networkConfigName;
    config.apiPort = overrides?.portExplicit ? apiPort : (config.apiPort ?? apiPort);
    config.nodeRole = config.nodeRole ?? (network.defaultNodeRole as 'edge' | 'core');
    config.contextGraphs = config.contextGraphs ?? network.defaultContextGraphs;
    config.auth = config.auth ?? { enabled: true };
    config.logging = config.logging ?? { kaPublishLifecycleDebug: false };

    // `relay` is deliberately left alone: an existing relay override is
    // preserved, but a new one is never pinned — the daemon reads the full
    // relay list from network config (testnet.json) automatically, which is
    // better than hard-coding a single relay into the user's config.

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
    if (!config.autoUpdate && network.autoUpdate?.enabled !== undefined) {
      config.autoUpdate = { enabled: network.autoUpdate.enabled };
    }

    // issue #960: on a FRESH install (no config yet) with no explicit store
    // backend, adopt the `oxigraph-server` default — the same recommended choice
    // the `dkg init` store-wizard offers — so the OpenClaw / Hermes / MCP setups
    // (and any other caller of this helper) bootstrap a node with MVCC concurrent
    // reads out of the box, matching a wizard-driven install. We seed ONLY on a
    // fresh config: an existing node is never rewritten onto a new backend here
    // (that would force a store reset on its next boot), and an explicit existing
    // `store` block is left as it is. "Fresh" means neither `config.json` nor
    // `config.yaml` existed when the lock was taken — `loadConfig` /
    // `resolveDkgConfigHome` both treat a YAML-only config as a valid existing
    // node — so a config another process created while setup waited for the
    // lock also counts as existing.
    if (!file.existed && config.store === undefined) {
      config.store = { backend: 'oxigraph-server' };
    }
  });
  const summary = `(${network.networkName}, ${persisted.nodeRole}, port ${persisted.apiPort})`;
  log(changed ? `Wrote ${path} ${summary}` : `${path} is already up to date ${summary}`);
  return { path, changed, config: persisted };
}
