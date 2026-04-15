import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DkgNodePlugin } from './dist/index.js';

/** Module-level singleton - prevents duplicate registration during gateway multi-phase init. */
let instance = null;

export default function (api) {
  const log = api.logger ?? console;

  if (instance) {
    log.info?.('[dkg-entry] Re-registering tools into new registry (gateway multi-phase init)');
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
    // B53: Do NOT auto-populate `config.memory.memoryDir` here. The key
    // was retired with the openclaw-dkg-primary-memory workstream (see
    // `DkgNodePlugin.warnOnLegacyMemoryFileWatcherConfig`), and injecting
    // a default made the B22 "retired key detected" warning fire on
    // every clean install — a permanent false positive. The warning
    // should only fire when an operator actually wrote `memoryDir` (or
    // `watchDebounceMs`) in their workspace config file, which the
    // clone above preserves without needing a default.
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
