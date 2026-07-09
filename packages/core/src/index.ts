export * from './types.js';
export * from './constants.js';
export * from './assertion-scoped-graphs.js';
export * from './protocol-limits.js';
export * from './catalog.js';
export { parseDotenvValue } from './dotenv.js';
export * from './memory-model.js';
export * from './trust.js';
export * from './publisher-extension.js';
export * from './imported-artifact-bytes.js';
export * from './imported-artifact-metadata.js';
export * from './event-bus.js';
export {
  Logger,
  createOperationContext,
  type OperationContext,
  type OperationName,
  type LogSink,
  type LogRecord,
} from './logger.js';
export {
  KA_LIFECYCLE_ROLES,
  KA_LIFECYCLE_STAGES,
  isKaPublishLifecycleDebugLoggingEnabled,
  logKaLifecycleEvent,
  resolveKaLifecycleLogDetail,
  setKaPublishLifecycleDebugLoggingEnabled,
  type KaLifecycleLogDetail,
  type KaLifecycleLogEvent,
  type KaLifecycleLogLevel,
  type KaLifecycleMetadataValue,
  type KaLifecycleRole,
  type KaLifecycleStage,
} from './ka-lifecycle-logger.js';
export { createLogRedactor, redactLogEntry, redactMessage, DEFAULT_SENSITIVE_KEYS, REDACTED } from './log-redaction.js';
export {
  getTracer, withSpan, linkedSpan, currentTraceIds, activeSpanContext,
  getMetrics, rebuildMetrics, type WithSpanOpts, type DkgMetrics,
} from './telemetry-api.js';
export * from './crypto/index.js';
export * from './proto/index.js';
export {
  DKGNode,
  type RelayStats,
  type RelayReservationDetail,
  // Capacity helpers + constants from PR #524 (libp2p reachability hardening PR1).
  // Re-exported here so dashboards / route handlers can import them
  // without reaching into the deep import path.
  DEFAULT_RELAY_SERVER_CAPACITY,
  RELAY_CAPACITY_MULTIPLIER,
  RELAY_DEFAULT_DURATION_LIMIT_MS,
  RELAY_RESERVATION_TTL_MS,
  EDGE_NODE_MAX_CONNECTIONS,
  deriveRelayCaps,
  checkFdLimit,
  validateRelayServerCapacity,
  type RelayCapacityValidation,
  type DerivedRelayCaps,
  // Multi-reservation tuning (PR3).
  DEFAULT_RELAY_RESERVATION_COUNT,
  MAX_RELAY_RESERVATION_COUNT,
  validateRelayReservationCount,
  type RelayReservationCountValidation,
  // Single-source-of-truth interface for the small / sparse-network
  // tunables forwarded `DkgConfig.network` → `DKGAgentConfig` →
  // `DKGNodeConfig`, plus the choke-point helper every forwarder
  // calls. Exported because `cli/src/daemon/lifecycle.ts` and
  // `agent/src/dkg-agent.ts` BOTH need to call it; centralising
  // here keeps the field list and forwarding logic identical at
  // every hop. Codex review of PR #698 round 3.
  type NetworkTunables,
  pickNetworkTunables,
  // Public-address classifier (used by profile.ts to filter what we
  // advertise as `dkg:multiaddr` so peers don't learn RFC1918/CGNAT
  // entries from the phonebook).
  isPublicLikeAddress,
  isLocalOrInternalHostname,
} from './node.js';
// NOTE: `isFinitePositiveInteger`, `buildPeerStoreOverrides`, and
// `buildKadDHTOptions` are intentionally NOT re-exported. They are
// implementation details of `DKGNode.start()`; the wiring test in
// `core/test/libp2p-tunables-wiring.test.ts` reaches them via
// `../src/node.js` directly so the package root stays free of
// internals that would otherwise commit us to a semver contract
// for test-only surface. Codex review of PR #698 round 3 flagged
// the prior leak. Same rule for `nodeHasDirectPublicAddress` (the
// relay watchdog's public-reachability gate, PR #1508): it has no
// production consumer outside `node.ts`, and its tests
// (`core/test/relay-public-reachability.test.ts`, `core/test/relay.test.ts`)
// deep-import it from `../src/node.js`.
export {
  type Network,
  type NodeIdentity,
  type Address,
  type DialOpts,
  type ProtocolHandler,
  LibP2PNetwork,
  type NetworkStateRegistry,
  StubNetworkStateRegistry,
  type AgentDirectoryLookup,
  type PeerResolverDeps,
  type PeerResolverLogger,
  type ResolveOpts,
  PeerResolver,
  dkgGossipMsgId,
  dkgGossipMsgIdRaw,
  type DkgGossipMsgIdInput,
  DkgGossipUnsignedMessageError,
  DkgGossipMissingPublisherError,
} from './network/index.js';
export {
  ProtocolRouter,
  QuietRetryableHandlerError,
  type AdmissionCheckOptions,
  type ProtocolRouterOptions,
  type SendOptions,
  DEFAULT_MAX_READ_BYTES,
  DEFAULT_SEND_TIMEOUT_MS,
  isRecoverableSendError,
  isProtocolUnsupportedError,
} from './protocol-router.js';
export {
  MessageStreamPool,
  POOLED_MESSAGE_PROTOCOL,
  DEFAULT_KEEPALIVE_MS,
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  PooledStreamResetError,
  type MessageStreamPoolOptions,
  type PooledStreamHandler,
  type PerPeerStats,
  type PoolNode,
} from './message-stream-pool.js';
export {
  FrameType,
  encodeFrame,
  encodeVarint,
  tryDecodeVarint,
  decodeFrames,
  DEFAULT_MAX_FRAME_BYTES,
  type DecodedFrame,
} from './message-frame.js';
export { GossipSubManager, type GossipMessageHandler } from './gossipsub-manager.js';
export { PeerDiscoveryManager } from './discovery.js';
export {
  DEFAULT_GENESIS_ID,
  getGenesisQuads,
  computeNetworkId,
  getGenesisRaw,
  SYSTEM_CONTEXT_GRAPHS,
  isAgentRegistryContextGraph,
  DKG_ONTOLOGY,
  type GenesisQuad,
} from './genesis.js';
export {
  DKG_ENTITY,
  DKG_ROOT_ENTITY_LEGACY,
  DKG_ASSERTION_ENTITY,
  DKG_ASSERTION_ROOT_ENTITY_LEGACY,
  ENTITY_PRED_ALT,
  ASSERTION_ENTITY_PRED_ALT,
  isEntityPredicate,
  isAssertionEntityPredicate,
} from './entity-predicate.js';
export { withRetry, type RetryOptions } from './retry.js';
export {
  RetryQueue,
  type RetryEntry,
  type RetryMetadata,
  type RetryQueueOptions,
} from './retry-queue.js';
export {
  type MessageIdempotencyStore,
  type MessageDirection,
  type IdempotencyCheckResult,
  type ProtocolOutboxStore,
  type ProtocolOutboxEntry,
  type KaNumberStore,
  RESPONSE_CACHE_BYTES,
  RESPONSE_GONE_MARKER,
} from './messenger-types.js';
export {
  ProtocolOutbox,
  type ProtocolOutboxOptions,
  DEFAULT_PROTOCOL_OUTBOX_BACKOFFS_MS,
  DEFAULT_PROTOCOL_OUTBOX_MAX_AGE_MS,
  InMemoryProtocolOutboxStore,
  InMemoryMessageIdempotencyStore,
} from './protocol-outbox.js';
export {
  findPackageRepoDir,
  blueGreenSlotEntryPoint,
  blueGreenSlotReady,
} from './blue-green.js';
export {
  FAUCET_WALLETS_PER_REQUEST,
  getFundableWalletAddresses,
  requestFaucetFunding,
  type FaucetResult,
  type FundableWalletConfigLike,
  type FundableWalletEntryLike,
  type FundableWalletSource,
} from './faucet.js';
export {
  fundWalletsBestEffort,
  logManualFundingInstructions,
  readWallets,
  readWalletsWithRetry,
  type FundWalletsBestEffortOptions,
  type FundWalletsNetworkConfig,
} from './faucet-orchestration.js';
export {
  ensureDkgNodeConfig,
  readPersistedNetworkConfigName,
  type DkgNodeConfigOverrides,
  type DkgNodeNetworkConfig,
  type EnsureDkgNodeConfigOptions,
} from './ensure-dkg-node-config.js';
export {
  DEFAULT_SETUP_NETWORK,
  LEGACY_FALLBACK_NETWORK,
  SELECTABLE_SETUP_NETWORKS,
  resolveSetupNetworkName,
  type ResolveSetupNetworkNameOptions,
} from './setup-network.js';
export { resolveCliPackageDir } from './resolve-cli-package-dir.js';
export { resolveDkgCli, type ResolvedDkgCli } from './resolve-dkg-cli.js';
export { startDaemon } from './daemon-lifecycle.js';
export {
  assertSafeIri,
  isSafeIri,
  sparqlIri,
  escapeSparqlLiteral,
  sparqlString,
  sparqlInt,
  assertSafeRdfTerm,
} from './sparql-safe.js';
export {
  JAVA_WRITE_UTF_MAX_BYTES,
  DKG_RDF_LITERAL_SAFE_MUTF8_BYTES,
  OVERSIZED_RDF_LITERAL_ERROR_CODE,
  OversizedRdfLiteralError,
  javaModifiedUtf8ByteLength,
  rdfLiteralTermMutf8ByteLength,
  isOversizedRdfLiteralError,
  assertRdfLiteralMutf8Safe,
  assertQuadLiteralsMutf8Safe,
  type RdfLiteralSizeContext,
  type QuadLiteralLike,
} from './rdf-literal-size.js';
export {
  DKGError,
  DKGUserError,
  DKGInternalError,
  PayloadTooLargeError,
  SwmGossipPayloadTooLargeError,
  toErrorMessage,
  hasErrorCode,
  NO_FUNDED_PUBLISHER_WALLET_CODE,
  NO_FUNDED_PUBLISHER_WALLET_MESSAGE_PREFIX,
  messageIndicatesNoFundedPublisherWallet,
} from './errors.js';
export {
  dkgHomeDir,
  resolveDkgConfigHome,
  dkgAuthTokenPath,
  isDkgMonorepoRoot,
  findDkgMonorepoRoot,
  resolveDkgHome,
  readDaemonPid,
  isProcessAlive,
  readDkgApiPort,
  loadAuthTokenSync,
  loadAuthToken,
  toEip55Checksum,
} from './dkg-home.js';
export {
  type Quad as ExtractionQuad,
  type ExtractionInput,
  type ConverterOutput,
  type ExtractionOutput,
  type ExtractionPipeline,
  ExtractionPipelineRegistry,
} from './extraction-pipeline.js';
export * from './transducers.js';
export { RateLimiter, type RateLimitConfig } from './rate-limiter.js';
export {
  ASSERTION_SEAL_PREDICATES,
  ASSERTION_PUBLISH_RECEIPT_PREDICATES,
  buildAssertionSealQuads,
  buildAssertionPublishReceiptQuads,
  parseAssertionSealQuads,
  type AssertionSeal,
} from './assertion-seal.js';
