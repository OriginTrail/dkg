import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DkgNodePlugin } from './dist/index.js';

/** Module-level singleton - prevents duplicate registration during gateway multi-phase init. */
let instance = null;

export default function (api) {
  const log = api.logger ?? console;

  if (instance) {
    log.info?.('[dkg-entry] Re-registering plugin surfaces (channel, memory, tools) into new registry (gateway multi-phase init)');
    instance.register(api);
    return;
  }

  // Read DKG config from workspace config.json (not openclaw.json)
  let workspaceDir = api.config?.agents?.defaults?.workspace;
  if (!workspaceDir) {
    workspaceDir = api.config?.workspace ?? api.workspaceDir;
  }

  let wsConfig = {};
  if (workspaceDir) {
    try {
      const raw = readFileSync(join(workspaceDir, 'config.json'), 'utf-8');
      wsConfig = JSON.parse(raw)['dkg-node'] || {};
    } catch (err) {
      log.warn?.(`[dkg-entry] Failed to read config.json from ${workspaceDir}: ${err.message}`);
    }
  } else {
    log.warn?.('[dkg-entry] No workspace directory found - using defaults only');
  }

  // Build config from workspace settings
  const config = { ...wsConfig };

  // Override daemon URL from environment if set
  if (process.env.DKG_DAEMON_URL) {
    config.daemonUrl = process.env.DKG_DAEMON_URL;
  }

  // Deep-clone integration sub-configs
  if (wsConfig.memory) {
    config.memory = { ...wsConfig.memory };
    // Do NOT auto-populate `config.memory.memoryDir` here. The key was
    // retired with the openclaw-dkg-primary-memory workstream along
    // with the retirement warning itself (that warning was removed in
    // commit 66211977 — first-product-release has no legacy install
    // base to migrate from). We still clone `wsConfig.memory` to preserve
    // any other fields operators may have set in their workspace config.
  }
  if (wsConfig.channel) {
    config.channel = { ...wsConfig.channel };
  }

  // Pass workspace directory to the API for auto-detection
  if (workspaceDir && !api.workspaceDir) {
    api.workspaceDir = workspaceDir;
  }

  log.info?.(
    `[dkg-entry] config - daemonUrl: ${config.daemonUrl ?? 'http://127.0.0.1:9200'}, `
      + `memory.enabled: ${config.memory?.enabled}, `
      + `channel.enabled: ${config.channel?.enabled}, `
      + `registrationMode: ${api.registrationMode ?? 'full'}`,
  );

  const dkg = new DkgNodePlugin(config);
  dkg.register(api);
  instance = dkg;

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

  // Reset singleton on gateway teardown so in-process restart re-registers fresh.
  // Listen on multiple lifecycle events - whichever the gateway version supports.
  if (typeof api.on === 'function') {
    const reset = () => {
      if (instance) {
        instance.stop().catch(() => {});
      }
      instance = null;
    };
    for (const event of ['shutdown', 'close', 'restart', 'reload']) {
      api.on(event, reset);
    }
  }

  log.info?.('[dkg-entry] DkgNodePlugin registered');
}
