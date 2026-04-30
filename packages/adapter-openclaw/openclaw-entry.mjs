import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DkgNodePlugin } from './dist/index.js';

/** Module-level singleton - prevents duplicate registration during gateway multi-phase init. */
let instance = null;
const lifecycleServiceApis = new WeakMap();
let lifecycleOwnerToken = null;

export default function (api) {
  const log = api.logger ?? console;

  if (instance) {
    log.info?.('[dkg-entry] Re-registering plugin surfaces (channel, memory, tools) into new registry (gateway multi-phase init)');
    instance.register(api);
    registerLifecycleService(api, log);
    return;
  }

  // Mirror the fallback order used by isMemorySlotOwnedByThisAdapter in
  // DkgMemoryPlugin.ts — some OpenClaw gateway versions expose the merged
  // config on api.cfg / runtime.cfg instead of api.config.
  const anyApi = api;
  const runtime = anyApi?.runtime;
  const mergedConfig =
    anyApi?.cfg ??
    anyApi?.config ??
    runtime?.cfg ??
    runtime?.config ??
    {};

  // Workspace directory is still needed for the SKILL.md sync below and for
  // downstream auto-detection, even though per-workspace config.json is gone.
  let workspaceDir = mergedConfig?.agents?.defaults?.workspace;
  if (!workspaceDir) {
    workspaceDir = mergedConfig?.workspace ?? api.workspaceDir;
  }

  // Read DKG config from the OpenClaw plugin entry
  // (plugins.entries["adapter-openclaw"].config in openclaw.json).
  const entryConfig = mergedConfig?.plugins?.entries?.['adapter-openclaw']?.config ?? {};
  const config = { ...entryConfig };

  // Deep-clone integration sub-configs so we don't mutate the incoming config.
  if (entryConfig.memory) config.memory = { ...entryConfig.memory };
  if (entryConfig.channel) config.channel = { ...entryConfig.channel };

  // Env override: DKG_DAEMON_URL trumps the config-file value.
  if (process.env.DKG_DAEMON_URL) {
    config.daemonUrl = process.env.DKG_DAEMON_URL;
  }

  // Pass workspace directory to the API for auto-detection.
  if (workspaceDir && !api.workspaceDir) {
    api.workspaceDir = workspaceDir;
  }

  log.info?.(
    `[dkg-entry] config (from openclaw.json entry config) - daemonUrl: ${config.daemonUrl ?? 'http://127.0.0.1:9200'}, `
      + `memory.enabled: ${config.memory?.enabled}, `
      + `channel.enabled: ${config.channel?.enabled}, `
      + `registrationMode: ${api.registrationMode ?? 'full'}`,
  );

  const dkg = new DkgNodePlugin(config);
  dkg.register(api);
  instance = dkg;
  registerLifecycleService(api, log);

  // Sync SKILL.md to workspace so the agent always reads the latest version.
  // The CLI dist ships the canonical template; the workspace copy goes stale
  // after adapter/CLI upgrades unless re-synced. This runs on every plugin
  // load, is idempotent (skips when content matches), and non-fatal.
  try {
    // Try both monorepo and npm-installed relative paths. The CLI
    // package ships `skills/` in its `files` array. In the monorepo the
    // directory is named `cli`; on npm it's `dkg` (the package name).
    const candidates = [
      fileURLToPath(new URL('../cli/skills/dkg-node/SKILL.md', import.meta.url)),
      fileURLToPath(new URL('../dkg/skills/dkg-node/SKILL.md', import.meta.url)),
    ];
    const skillSrc = candidates.find(p => existsSync(p));
    if (workspaceDir && skillSrc) {
      const skillDest = join(workspaceDir, 'skills', 'dkg-node', 'SKILL.md');
      const srcContent = readFileSync(skillSrc, 'utf-8');
      if (!existsSync(skillDest) || readFileSync(skillDest, 'utf-8') !== srcContent) {
        mkdirSync(dirname(skillDest), { recursive: true });
        writeFileSync(skillDest, srcContent, 'utf-8');
        log.info?.('[dkg-entry] SKILL.md synced to workspace');
      }
    }
  } catch (err) {
    log.debug?.(`[dkg-entry] SKILL.md sync skipped: ${err.message}`);
  }

  log.info?.('[dkg-entry] DkgNodePlugin registered');
}

function registerLifecycleService(api, log) {
  if (!instance || typeof api.registerService !== 'function') return;
  if (lifecycleServiceApis.get(api) === instance) return;

  const serviceInstance = instance;
  const serviceToken = {};
  try {
    api.registerService({
      name: 'dkg-adapter-openclaw-runtime',
      start: async () => {},
      stop: async () => {
        if (lifecycleOwnerToken !== serviceToken) return;
        lifecycleOwnerToken = null;
        try {
          await serviceInstance.stop();
        } finally {
          if (instance === serviceInstance) {
            instance = null;
          }
        }
      },
    });
    lifecycleServiceApis.set(api, serviceInstance);
    lifecycleOwnerToken = serviceToken;
  } catch (err) {
    log.debug?.(`[dkg-entry] lifecycle service registration skipped: ${err.message}`);
  }
}
