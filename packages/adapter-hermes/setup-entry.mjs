import { HermesAdapterPlugin } from './dist/index.js';

export {
  disconnect,
  disconnectHermesProfile,
  doctor,
  planHermesSetup,
  reconnect,
  resolveHermesProfile,
  runDisconnect,
  runDoctor,
  runReconnect,
  runSetup,
  runStatus,
  runUninstall,
  runVerify,
  setup,
  setupHermesProfile,
  status,
  uninstall,
  uninstallHermesProfile,
  verify,
  verifyHermesProfile,
} from './dist/setup.js';

export default function setupEntry(api = {}) {
  const mode = api.registrationMode ?? 'full';
  const log = api.logger ?? console;
  if (mode === 'setup-only' || mode === 'cli-metadata') {
    log.info?.(`[dkg-hermes-setup-entry] Setup-safe load for registrationMode=${mode}; skipping runtime registration`);
    return;
  }

  if (typeof api.registerHttpRoute !== 'function' || typeof api.registerHook !== 'function') {
    log.info?.('[dkg-hermes-setup-entry] Daemon plugin API unavailable; skipping runtime registration');
    return;
  }

  const plugin = new HermesAdapterPlugin(api.config?.hermes);
  return plugin.register(api);
}
