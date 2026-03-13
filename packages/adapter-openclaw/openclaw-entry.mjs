import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DkgNodePlugin } from './dist/index.js';

export default function (api) {
  const log = api.logger ?? console;

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
    log.warn?.('[dkg-entry] No workspace directory found — using defaults only');
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
    // Auto-set memoryDir from workspace if not explicit
    if (!config.memory.memoryDir && workspaceDir) {
      config.memory.memoryDir = join(workspaceDir, 'memory');
    }
  }
  if (wsConfig.channel) {
    config.channel = { ...wsConfig.channel };
  }
  if (wsConfig.game) {
    config.game = { ...wsConfig.game };
  }

  // Pass workspace directory to the API for auto-detection
  if (workspaceDir && !api.workspaceDir) {
    api.workspaceDir = workspaceDir;
  }

  log.info?.(`[dkg-entry] config — daemonUrl: ${config.daemonUrl ?? 'http://127.0.0.1:9200'}, memory.enabled: ${config.memory?.enabled}, channel.enabled: ${config.channel?.enabled}, game.enabled: ${config.game?.enabled}`);

  const dkg = new DkgNodePlugin(config);
  dkg.register(api);
  log.info?.('[dkg-entry] DkgNodePlugin registered');
}
