export default function setupEntry(api = {}) {
  const mode = api.registrationMode ?? 'full';
  const log = api.logger ?? console;

  if (mode === 'setup-only' || mode === 'cli-metadata') {
    log.info?.(`[dkg-setup-entry] Setup-safe load for registrationMode=${mode}; skipping runtime registration`);
    return;
  }

  const importRuntime = api._importRuntime ?? (() => import('./openclaw-entry.mjs'));
  return importRuntime().then(({ default: runtimeEntry }) => runtimeEntry(api));
}
