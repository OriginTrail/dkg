async function importSetup() {
  return import('./dist/setup.js');
}

const lazySetupExport = (name) => async (...args) => (await importSetup())[name](...args);

export const disconnect = lazySetupExport('disconnect');
export const disconnectHermesProfile = lazySetupExport('disconnectHermesProfile');
export const doctor = lazySetupExport('doctor');
export const planHermesSetup = lazySetupExport('planHermesSetup');
export const reconnect = lazySetupExport('reconnect');
export const resolveHermesProfile = lazySetupExport('resolveHermesProfile');
export const runDisconnect = lazySetupExport('runDisconnect');
export const runDoctor = lazySetupExport('runDoctor');
export const runReconnect = lazySetupExport('runReconnect');
export const runSetup = lazySetupExport('runSetup');
export const runStatus = lazySetupExport('runStatus');
export const runUninstall = lazySetupExport('runUninstall');
export const runVerify = lazySetupExport('runVerify');
export const setup = lazySetupExport('setup');
export const setupHermesProfile = lazySetupExport('setupHermesProfile');
export const status = lazySetupExport('status');
export const uninstall = lazySetupExport('uninstall');
export const uninstallHermesProfile = lazySetupExport('uninstallHermesProfile');
export const verify = lazySetupExport('verify');
export const verifyHermesProfile = lazySetupExport('verifyHermesProfile');

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

  const importRuntime = api._importRuntime ?? (() => import('./dist/index.js'));
  return importRuntime().then((runtime) => {
    const Plugin = runtime.HermesAdapterPlugin;
    if (typeof Plugin !== 'function') {
      log.warn?.('[dkg-hermes-setup-entry] HermesAdapterPlugin export unavailable; skipping runtime registration');
      return;
    }
    const plugin = new Plugin(api.config?.hermes);
    return plugin.register(api);
  });
}
