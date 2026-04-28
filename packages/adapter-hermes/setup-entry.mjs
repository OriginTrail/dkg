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

  const importRuntime = api._importRuntime ?? (() => import('./dist/index.js'));
  return importRuntime().then((runtime) => {
    const Plugin = runtime.HermesAdapterPlugin ?? runtime.default;
    if (typeof Plugin !== 'function') {
      throw new Error('Hermes setup entry could not find HermesAdapterPlugin');
    }
    const plugin = new Plugin(api.config?.hermes);
    if (typeof plugin.register !== 'function') {
      throw new Error('HermesAdapterPlugin does not expose register(api)');
    }
    return plugin.register(api);
  });
}
