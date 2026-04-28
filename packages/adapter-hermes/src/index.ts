/**
 * @origintrail-official/dkg-adapter-hermes
 *
 * Connects Hermes AI agents to a DKG V10 node for verifiable shared memory.
 * The Hermes Python plugin (plugins/memory/dkg/) talks to this adapter
 * via HTTP. All knowledge goes through DKG Working Memory assertions.
 */

export { HermesAdapterPlugin } from './HermesAdapterPlugin.js';
export { HermesDkgClient, redact } from './dkg-client.js';
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
  setupHermesProfile,
  setup,
  status,
  uninstall,
  uninstallHermesProfile,
  verify,
  verifyHermesProfile,
} from './setup.js';
export type {
  HermesAdapterConfig,
  DaemonPluginApi,
  HermesChannelHealthResponse,
  HermesChannelPersistTurnPayload,
  HermesChannelSendPayload,
  HermesChannelSendResponse,
  HermesChannelStreamEvent,
  HermesLocalAgentIntegrationPayload,
  HermesProfileMetadata,
  HermesPublishGuardPolicy,
  HermesSetupState,
  SessionTurnPayload,
  SessionEndPayload,
} from './types.js';
export type { HermesDkgClientOptions } from './dkg-client.js';
export type { HermesCliOptions, HermesSetupOptions, HermesSetupPlan, HermesVerifyResult } from './setup.js';
