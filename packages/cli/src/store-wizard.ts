/**
 * Triple-store wizard primitives (RFC 120, plan PR 2 items 1 + 3).
 *
 * Used by `dkg init` (interactive prompt) and by the adapter-setup
 * commands `dkg hermes setup` / `openclaw setup` / `mcp setup`
 * (non-interactive flag application). Centralised so URL validation,
 * the retry loop, and the "no Docker yet" PR 2 message stay identical
 * across every entry point.
 *
 * Extracted out of `cli.ts` so unit tests can exercise the prompt and
 * flag flows without loading the full Commander program (which has
 * side effects in process.exit and ApiClient.connect paths).
 *
 * PR 3 will replace the "no URL" branch with a Docker provisioner call;
 * the function signature stays stable so PR 3 only has to flip one
 * branch.
 */
import {
  checkExternalStoreReachable,
  formatHealthCheckFailure,
} from './daemon/store-health-check.js';
import { loadConfig, saveConfig, type DkgConfig } from './config.js';
import {
  isDockerAvailable as defaultIsDockerAvailable,
  provisionBlazegraphDocker as defaultProvisionBlazegraphDocker,
  type ProvisionBlazegraphDockerOptions,
  type ProvisionBlazegraphDockerResult,
} from './daemon/blazegraph-docker.js';

export interface PromptStoreBackendOptions {
  /** `ask` callback that closes over a shared readline interface. */
  ask: (q: string, def?: string) => Promise<string>;
  /** Existing config's store block (used as the wizard's default). */
  existingStore?: {
    backend: string;
    options?: Record<string, unknown>;
  };
  /** Pre-fill from `--store` flag. Always overrides existing config. */
  flagBackend?: string;
  /** Pre-fill from `--store-url` flag. Always overrides existing config. */
  flagUrl?: string;
  /**
   * Node name from the config — used as the Blazegraph namespace name
   * when the Docker provisioning branch fires. Falls back to
   * `"dkg-node"` if absent (matches `loadConfig` default).
   */
  nodeName?: string;
  /**
   * Override for the SPARQL HTTP transport. Tests inject a mock so the
   * URL validation step is deterministic; defaults to `globalThis.fetch`
   * via the shared health-check helper.
   */
  fetch?: typeof globalThis.fetch;
  /** Logger for status / warning messages. Defaults to console.log. */
  log?: (msg: string) => void;
  /**
   * PR 3 Docker convenience path. Tests inject a fake to exercise the
   * "Docker available + operator accepts" branch without spawning real
   * containers. Production callers omit these — they default to the
   * real Docker CLI probe + provisioner.
   */
  isDockerAvailable?: () => Promise<boolean>;
  provisionBlazegraphDocker?: (
    opts: ProvisionBlazegraphDockerOptions,
  ) => Promise<ProvisionBlazegraphDockerResult>;
}

export interface PromptStoreBackendResult {
  /**
   * Persisted store block. `null` means "use the local default" (caller
   * should omit the field or set it to undefined; saveConfig drops
   * undefined keys).
   *
   * `managedByDkg: true` is set by the Docker provisioner branch only;
   * manual URLs always get `managedByDkg: false`. The chain-reset-wipe
   * step in PR 1 uses this flag to decide between `DROP ALL` (safe on
   * DKG-owned namespaces) and scoped DELETE (mandatory on
   * shared / V6 / V8 instances).
   */
  storeBlock: ExternalStoreBlock | null;
}

export type ExternalStoreBlock =
  | {
      backend: 'blazegraph';
      options: { url: string; managedByDkg: boolean };
    }
  | {
      backend: 'sparql-http';
      options: {
        queryEndpoint: string;
        updateEndpoint: string;
        managedByDkg: boolean;
      };
    };

function externalStoreBlock(
  backend: 'blazegraph' | 'sparql-http',
  url: string,
  managedByDkg: boolean,
  updateUrl?: string,
): ExternalStoreBlock {
  if (backend === 'blazegraph') {
    return { backend, options: { url, managedByDkg } };
  }
  return {
    backend,
    options: {
      queryEndpoint: url,
      // Default the update endpoint to the query endpoint, but allow callers
      // to preserve a distinct existing `updateEndpoint` (sparql-http nodes
      // can point query/update at different URLs).
      updateEndpoint: updateUrl ?? url,
      managedByDkg,
    },
  };
}

export async function promptStoreBackend(
  opts: PromptStoreBackendOptions,
): Promise<PromptStoreBackendResult> {
  const log = opts.log ?? console.log;
  const existingBackend = opts.existingStore?.backend;
  const existingUrl =
    typeof opts.existingStore?.options?.url === 'string'
      ? (opts.existingStore?.options?.url as string)
      : typeof opts.existingStore?.options?.queryEndpoint === 'string'
        ? (opts.existingStore?.options?.queryEndpoint as string)
        : undefined;
  // sparql-http nodes can point query/update at different URLs. Capture the
  // existing update endpoint so an Enter-through (reuse) of the current
  // config doesn't silently collapse it onto the query endpoint.
  const existingUpdateUrl =
    typeof opts.existingStore?.options?.updateEndpoint === 'string'
      ? (opts.existingStore?.options?.updateEndpoint as string)
      : undefined;

  const defaultBackend = opts.flagBackend
    ?? (existingBackend === 'blazegraph' || existingBackend === 'sparql-http' ? existingBackend : 'oxigraph');

  const backendChoices = ['oxigraph', 'blazegraph'] as const;
  // `sparql-http` is intentionally not listed (advanced bring-your-own-server
  // option) but is still accepted when typed or inherited from an existing
  // config / `--store` flag. Resolve the default *answer* by name for unlisted
  // backends so pressing Enter on a node already configured for `sparql-http`
  // preserves it instead of silently downgrading to oxigraph (option 1).
  const defaultIsListed = (backendChoices as readonly string[]).includes(defaultBackend);
  const defaultIdx = defaultIsListed
    ? backendChoices.indexOf(defaultBackend as typeof backendChoices[number])
    : 0;
  const defaultAnswer = defaultIsListed ? String(defaultIdx + 1) : defaultBackend;
  log('  Triple store backend:');
  for (let i = 0; i < backendChoices.length; i++) {
    log(`    ${i + 1}) ${backendChoices[i]}`);
  }
  // When the inherited/flagged backend isn't one of the numbered choices
  // (e.g. `sparql-http`), spell out that pressing Enter keeps it and that a
  // literal backend name is accepted — otherwise the `(sparql-http)` default
  // on a `Choose (1-2)` prompt reads as a contradiction.
  if (!defaultIsListed) {
    log(`    (current: ${defaultBackend} — press Enter to keep it, or type a number / backend name)`);
  }
  const backendInput = (await opts.ask(
    `Choose (1-${backendChoices.length})`,
    defaultAnswer,
  )).trim();

  // Accept both the number ("1", "2") and the name ("blazegraph")
  const backendAnswer = /^\d+$/.test(backendInput)
    ? (backendChoices[parseInt(backendInput, 10) - 1] ?? 'oxigraph')
    : backendInput.toLowerCase();

  if (backendAnswer !== 'blazegraph' && backendAnswer !== 'sparql-http') {
    return { storeBlock: null };
  }
  const backend = backendAnswer as 'blazegraph' | 'sparql-http';

  // URL prompt loop: validate each attempt, surface the operator-facing
  // failure message, allow retry or abort.
  while (true) {
    const defaultUrl = opts.flagUrl ?? existingUrl;
    const url = (await opts.ask(
      backend === 'blazegraph'
        ? 'Blazegraph SPARQL endpoint URL (leave empty to auto-provision via Docker)'
        : 'SPARQL query endpoint URL',
      defaultUrl,
    )).trim();

    if (!url) {
      // PR 3 Docker branch: only offered for blazegraph (sparql-http is
      // by definition bring-your-own-server). Probe `docker --version`
      // first so we don't prompt operators who don't have Docker.
      if (backend === 'blazegraph') {
        const probeDocker = opts.isDockerAvailable ?? defaultIsDockerAvailable;
        const dockerOk = await probeDocker();
        if (dockerOk) {
          const yes = (await opts.ask(
            'Provision a Blazegraph container via Docker? (y/n)',
            'y',
          )).toLowerCase();
          if (yes !== 'n') {
            const namespace = opts.nodeName || 'dkg-node';
            log(`  Starting Blazegraph in Docker (namespace: ${namespace})…`);
            try {
              const provision = opts.provisionBlazegraphDocker ?? defaultProvisionBlazegraphDocker;
              const result = await provision({ namespace, log });
              log(
                `  ${result.reused ? 'Reusing' : 'Created'} container "${result.containerName}" ` +
                `on port ${result.port}.`,
              );
              log(`  Store endpoint: ${result.url}`);
              return {
                storeBlock: {
                  backend: 'blazegraph',
                  options: { url: result.url, managedByDkg: true },
                },
              };
            } catch (err) {
              log('');
              log(`  Docker provisioning failed: ${(err as Error).message}`);
              log('');
              // Fall through to retry / manual URL.
            }
          }
        } else {
          log('');
          log('  Docker not detected on this system.');
          log('  Install or start Docker to auto-provision Blazegraph, or start it');
          log('  manually and enter its SPARQL endpoint URL below.');
          log('');
        }
      }
      const retry = (await opts.ask('Retry with a URL? (y/n)', 'y')).toLowerCase();
      if (retry === 'n') {
        log('  Aborting store setup; defaulting to local Oxigraph.');
        return { storeBlock: null };
      }
      continue;
    }

    const optionsForProbe =
      backend === 'blazegraph' ? { url } : { queryEndpoint: url };
    const health = await checkExternalStoreReachable({
      storeConfig: { backend, options: optionsForProbe },
      fetch: opts.fetch,
    });

    if (health.ok) {
      log(`  Store endpoint reachable: ${backend} ${url}`);
      // When the operator kept the existing sparql-http query URL
      // (Enter-through), preserve a distinct existing `updateEndpoint`
      // instead of collapsing it onto the query URL. If they typed a new
      // query URL we have no matching update URL, so fall back to the
      // query URL for both.
      const preservedUpdateUrl =
        backend === 'sparql-http' && url === existingUrl ? existingUpdateUrl : undefined;
      return {
        storeBlock: externalStoreBlock(backend, url, false, preservedUpdateUrl),
      };
    }

    log('');
    log(formatHealthCheckFailure(health));
    log('');
    const retry = (await opts.ask(
      'Retry with a different URL? (y/n)',
      'y',
    )).toLowerCase();
    if (retry === 'n') {
      log('  Aborting store setup; defaulting to local Oxigraph.');
      return { storeBlock: null };
    }
  }
}

// ---------------------------------------------------------------------
// Flag-driven flow for adapter setup commands
// ---------------------------------------------------------------------

export interface ApplyStoreFlagsOptions {
  storeFlag?: string;
  storeUrlFlag?: string;
  /** Mock for tests; defaults to the real `loadConfig` from config.ts. */
  loadConfig?: () => Promise<DkgConfig>;
  /** Mock for tests; defaults to the real `saveConfig` from config.ts. */
  saveConfig?: (config: DkgConfig) => Promise<void>;
  /** Mock for tests; defaults to `globalThis.fetch` via the probe helper. */
  fetch?: typeof globalThis.fetch;
  log?: (msg: string) => void;
}

/**
 * Non-interactive sibling of `promptStoreBackend`. Used by the
 * adapter-setup commands which delegate to action modules that don't
 * run the init wizard — so the operator has no chance to type a URL.
 *
 * Validates via the shared boot-time health-check probe, then writes
 * the store block into `~/.dkg/config.json` after the action module
 * has already created/updated the rest of the config.
 *
 * Returns silently when no flags are passed (default behaviour: leave
 * the existing config alone). Throws on validation failure so the CLI
 * dispatch wrapper catches and exits cleanly.
 */
export async function applyStoreFlagsToConfig(
  opts: ApplyStoreFlagsOptions,
): Promise<void> {
  const log = opts.log ?? console.log;
  const backend = opts.storeFlag;
  if (!backend) return;

  const load = opts.loadConfig ?? loadConfig;
  const save = opts.saveConfig ?? saveConfig;

  // Operators who pass `--store oxigraph` may be trying to FORCE local
  // even though their existing config has a `store` block — honour
  // that by clearing the block.
  if (
    backend === 'oxigraph' ||
    backend === 'oxigraph-worker' ||
    backend === 'oxigraph-persistent'
  ) {
    const existing = await load();
    if (existing.store) {
      log(`  Removing existing store block (--store ${backend} → local default).`);
      const next = { ...existing };
      delete next.store;
      await save(next);
    }
    return;
  }

  if (backend !== 'blazegraph' && backend !== 'sparql-http') {
    throw new Error(
      `--store must be one of: oxigraph, blazegraph, sparql-http (got "${backend}")`,
    );
  }

  const url = opts.storeUrlFlag?.trim();
  if (!url) {
    throw new Error(`--store ${backend} requires --store-url <SPARQL endpoint URL>`);
  }

  const optionsForProbe =
    backend === 'blazegraph' ? { url } : { queryEndpoint: url };
  const health = await checkExternalStoreReachable({
    storeConfig: { backend, options: optionsForProbe },
    fetch: opts.fetch,
  });
  if (!health.ok) {
    throw new Error(`store URL validation failed:\n${formatHealthCheckFailure(health)}`);
  }

  const existing = await load();
  const next: DkgConfig = {
    ...existing,
    store: externalStoreBlock(backend, url, false),
  };
  await save(next);
  log(`  Store configured: ${backend} (${url}) — verified reachable.`);
}
