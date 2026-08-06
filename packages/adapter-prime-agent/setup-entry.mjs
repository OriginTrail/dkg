/**
 * Setup-safe lazy entry.
 *
 * The CLI and daemon import this file merely to enumerate metadata, so it must
 * never pull the runtime in as a side effect: every setup verb below is a thunk
 * that imports `dist/setup.js` only when actually called.
 */

async function importSetup() {
  return import('./dist/setup.js');
}

const lazySetupExport = (name) => async (...args) => (await importSetup())[name](...args);

export const disconnect = lazySetupExport('disconnect');
export const disconnectPrimeAgentProfile = lazySetupExport('disconnectPrimeAgentProfile');
export const doctor = lazySetupExport('doctor');
export const planPrimeAgentSetup = lazySetupExport('planPrimeAgentSetup');
export const reconnect = lazySetupExport('reconnect');
export const resolvePrimeAgentProfile = lazySetupExport('resolvePrimeAgentProfile');
export const restorePrimeAgentProfile = lazySetupExport('restorePrimeAgentProfile');
export const runDisconnect = lazySetupExport('runDisconnect');
export const runDoctor = lazySetupExport('runDoctor');
export const runPrimeAgentSetup = lazySetupExport('runPrimeAgentSetup');
export const runReconnect = lazySetupExport('runReconnect');
export const runSetup = lazySetupExport('runSetup');
export const runStatus = lazySetupExport('runStatus');
export const runUninstall = lazySetupExport('runUninstall');
export const runVerify = lazySetupExport('runVerify');
export const setup = lazySetupExport('setup');
export const setupPrimeAgentProfile = lazySetupExport('setupPrimeAgentProfile');
export const status = lazySetupExport('status');
export const uninstall = lazySetupExport('uninstall');
export const verify = lazySetupExport('verify');
export const verifyPrimeAgentProfile = lazySetupExport('verifyPrimeAgentProfile');

export default function setupEntry(api = {}) {
  const mode = api.registrationMode ?? 'full';
  const log = api.logger ?? console;
  if (mode === 'setup-only' || mode === 'cli-metadata') {
    log.info?.(
      `[dkg-prime-agent-setup-entry] Setup-safe load for registrationMode=${mode}; skipping runtime registration`,
    );
    return;
  }

  if (typeof api.registerHttpRoute !== 'function' || typeof api.registerHook !== 'function') {
    log.info?.('[dkg-prime-agent-setup-entry] Daemon plugin API unavailable; skipping runtime registration');
    return;
  }

  const importRuntime = api._importRuntime ?? (() => import('./dist/index.js'));
  return importRuntime().then((runtime) => {
    const Plugin = runtime.PrimeAgentAdapterPlugin;
    if (typeof Plugin !== 'function') {
      log.warn?.('[dkg-prime-agent-setup-entry] PrimeAgentAdapterPlugin export unavailable; skipping');
      return;
    }
    const plugin = new Plugin(api.config?.primeAgent);
    return plugin.register(api);
  });
}
