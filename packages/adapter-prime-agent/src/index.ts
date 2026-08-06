/**
 * Public surface of the Prime Agent adapter.
 *
 * Value exports are the daemon plugin plus every setup verb the CLI and the
 * Node UI call. Type exports are the contract surface daemon-side code needs.
 */

export { PrimeAgentAdapterPlugin } from './PrimeAgentAdapterPlugin.js';
export { registerPrimeAgentRoutes } from './prime-agent-routes.js';

export {
  ADAPTER_CONFIG_FILENAME,
  ADAPTER_STATE_DIRNAME,
  DEFAULT_CONTEXT_GRAPH,
  DEFAULT_DAEMON_URL,
  DEFAULT_MEMORY_ASSERTION,
  DEFAULT_PUBLISH_GUARD,
  MANAGED_BY,
  SETUP_STATE_FILENAME,
  defaultExtensionPath,
  disconnect,
  disconnectPrimeAgentProfile,
  doctor,
  planPrimeAgentSetup,
  readSettings,
  readSetupState,
  reconnect,
  resolveAgentDir,
  resolvePrimeAgentProfile,
  restorePrimeAgentProfile,
  runDisconnect,
  runDoctor,
  runPrimeAgentSetup,
  runReconnect,
  runSetup,
  runStatus,
  runUninstall,
  runVerify,
  setup,
  setupPrimeAgentProfile,
  status,
  uninstall,
  verify,
  verifyPrimeAgentProfile,
} from './setup.js';

export {
  isLoopbackBridgeUrl,
  isProcessAlive,
  isSafeSessionId,
  readLiveSessions,
  removeSessionDescriptor,
  selectSession,
  sessionDescriptorPath,
  writeSessionDescriptor,
} from './session-registry.js';

export type { PrimeAgentSetupOptions } from './setup.js';
export type {
  DaemonPluginApi,
  PrimeAgentAdapterConfig,
  PrimeAgentChannelHealthResponse,
  PrimeAgentChannelMessage,
  PrimeAgentChannelSendPayload,
  PrimeAgentChannelSendResponse,
  PrimeAgentChannelStreamEvent,
  PrimeAgentLocalAgentIntegrationPayload,
  PrimeAgentMemoryMode,
  PrimeAgentPriorSettings,
  PrimeAgentProfileMetadata,
  PrimeAgentPublishGuardPolicy,
  PrimeAgentRestoreRequest,
  PrimeAgentRestoreResult,
  PrimeAgentRuntimeStatus,
  PrimeAgentSessionDescriptor,
  PrimeAgentSetupPlan,
  PrimeAgentSetupPlanAction,
  PrimeAgentSetupRequest,
  PrimeAgentSetupResult,
  PrimeAgentSetupState,
  PrimeAgentVerifyResult,
} from './types.js';
