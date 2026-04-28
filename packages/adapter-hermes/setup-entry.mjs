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
  const mode = api.registrationMode ?? 'setup-only';
  const log = api.logger ?? console;
  log.info?.(`[dkg-hermes-setup-entry] Loaded setup entry for registrationMode=${mode}`);
}
