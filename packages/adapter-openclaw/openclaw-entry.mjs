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

  // Deep-clone chainConfig to avoid mutating the parsed object
  if (wsConfig.chainConfig) {
    config.chainConfig = { ...wsConfig.chainConfig };
  }

  // Inject EVM private key from environment (never store in config files).
  // If there's no chainConfig block but the env var is set, create one with
  // testnet defaults so the user only needs to set the env var.
  const envKey = process.env.DKG_EVM_PRIVATE_KEY;
  if (envKey) {
    if (!config.chainConfig) {
      config.chainConfig = {
        rpcUrl: 'https://sepolia.base.org',
        hubAddress: '0xC056e67Da4F51377Ad1B01f50F655fFdcCD809F6',
      };
    }
    if (!config.chainConfig.privateKey) {
      config.chainConfig.privateKey = envKey;
    }
  }

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

  // Pass workspace directory to the API for auto-detection
  if (workspaceDir && !api.workspaceDir) {
    api.workspaceDir = workspaceDir;
  }

  log.info?.(`[dkg-entry] config — memory.enabled: ${config.memory?.enabled}, channel.enabled: ${config.channel?.enabled}`);

  const dkg = new DkgNodePlugin(config);
  dkg.register(api);
  log.info?.('[dkg-entry] DkgNodePlugin registered');
}
