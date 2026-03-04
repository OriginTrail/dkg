import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DkgNodePlugin } from './dist/index.js';

export default function (api) {
  // Read DKG config from workspace config.json (not openclaw.json)
  const workspaceDir = api.config?.agents?.defaults?.workspace;
  let wsConfig = {};
  if (workspaceDir) {
    try {
      const raw = readFileSync(join(workspaceDir, 'config.json'), 'utf-8');
      wsConfig = JSON.parse(raw)['dkg-node'] || {};
    } catch { /* no workspace config — rely on defaults */ }
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

  const dkg = new DkgNodePlugin(config);
  dkg.register(api);
}
