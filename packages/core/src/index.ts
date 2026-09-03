export * from './types.js';
export * from './constants.js';
export * from './agent-identity.js';
export * from './assertion-scoped-graphs.js';
export * from './protocol-limits.js';
export * from './context-graph-join-policy.js';
export * from './catalog.js';
export { parseDotenvValue } from './dotenv.js';
export * from './memory-model.js';
export * from './ka-content-scope.js';
export * from './rfc64-shared-projection-address-v1.js';
export * from './graph-knowledge-asset-metadata.js';
export * from './trust.js';
export * from './sparql-operation.js';
export * from './code-point-order.js';
export { BoundedLruCache } from './bounded-lru-cache.js';
export * from './query-result.js';
export * from './publisher-extension.js';
export * from './imported-artifact-bytes.js';
export * from './imported-artifact-metadata.js';
export * from './sync-control-object.js';
export * from './sync-checkpoint-state.js';
export * from './cg-policy-objects.js';
export * from './administrative-authority-objects.js';
export * from './author-catalog-authority-objects.js';
export {
  MAX_DECIMAL_U64,
  MAX_DECIMAL_U256,
  assertCanonicalChainId,
  assertCanonicalDecimalU64,
  assertCanonicalDecimalU256,
  assertCanonicalDigest,
  assertCanonicalEvmAddress,
  assertCanonicalHexBytes,
  assertCanonicalKaId,
  assertCanonicalTimestampMs,
  parseCanonicalDecimalU64,
  parseCanonicalDecimalU256,
} from './sync-wire-scalars.js';
export type {
  BatchIdV1,
  BlockNumberV1,
  ByteLengthV1,
  ChainIdV1,
  CountV1,
  DecimalU64V1,
  DecimalU256V1,
  Digest32V1,
  EndKaIdV1,
  EvmAddressV1,
  IndexV1,
  KaIdV1,
  ReservedKaIdV1,
  StartKaIdV1,
  TimestampMsV1,
} from './sync-wire-scalars.js';
export * from './ka-transfer-descriptor.js';
export * from './ka-bundle-v1.js';
export * from './ka-chunk-tree.js';
export * from './ka-chunk-proof.js';
export * from './cg-shared-projection.js';
export {
  FinalizedVmSetAccumulatorV1,
  FinalizedVmSetV1Error,
  computeFinalizedVmSetEvidenceV1,
  computeFinalizedVmSetLeafDigestV1,
  type FinalizedVmLaneV1,
  type FinalizedVmSetEvidenceV1,
  type FinalizedVmSetRowV1,
  type FinalizedVmSetScopeV1,
  type FinalizedVmSetV1ErrorCode,
} from './finalized-vm-set-v1.js';
export * from './author-catalog-codec.js';
export * from './author-catalog-objects.js';
export * from './author-catalog-directory.js';
export * from './swm-author-inventory-v1.js';
export * from './rfc64-semantic-addresses-v1.js';
export * from './rfc64-semantic-records-v1.js';
export * from './rfc64-semantic-read-manifest-v1.js';
export * from './rfc64-author-seal-read-manifest-v1.js';
export * from './rfc64-shared-projection-stream-manifest-v1.js';
export {
  isClosedDataRecord,
  readOwnEnumerableDataProperty,
  snapshotDenseDataArray,
  snapshotExactDataRecord,
  type ClosedDataPrototypePolicy,
  type ClosedDataReject,
  type ClosedDataSnapshotOptions,
} from './sync-wire-objects.js';
export * from './typed-rdf-store-row-v1.js';
export * from './event-bus.js';
export * from './backpressure-observability.js';
export {
  Logger,
  createOperationContext,
  formatLogRecord,
  type OperationContext,
  type OperationName,
  type LogSink,
  type LogRecord,
  type LogRecordFormatOptions,
  type CanonicalLogRecord,
  type LogLevel,
  LOG_LEVELS,
  normalizeLogLevel,
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
export type { LogRedactor } from './log-redaction.js';
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
  type PeerConnectionNetwork,
  type NodeIdentity,
  type Address,
  type DialOpts,
  type PeerConnectOpts,
  type ProtocolHandler,
  LibP2PNetwork,
  canonicalPeerIdString,
  tryCanonicalPeerIdString,
  type CanonicalPeerId,
  type NetworkStateRegistry,
  StubNetworkStateRegistry,
  type AgentDirectoryLookup,
  type PeerResolverDeps,
  type PeerConnectionOutcome,
  connectLibp2pCandidate,
  parseLibp2pConnectCandidate,
  Libp2pConnectCandidateParseError,
  type Libp2pConnectCandidate,
  type Libp2pConnectHost,
  type PeerResolverLogger,
  type ResolveOpts,
  type ConnectOpts,
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
  type ProtocolRegistrationOptions,
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
export { resolveWithinAbort } from './abort-boundary.js';
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
  type LegacyProtocolOutboxStore,
  type CompatibleProtocolOutboxStore,
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
  BoundedResponseBodyLimitError,
  readResponseBodyBytesBounded,
  type BoundedResponseBodyLimitSource,
} from './bounded-response-body.js';
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
  maskSparqlLexicalRegions,
  scanSparqlLexically,
  type SparqlLexicalMask,
  type SparqlLexicalScan,
  type SparqlLexicalToken,
} from './sparql-lexical-scanner.js';
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
  PUBLISH_AUTHOR_NOT_CUSTODIAL_CODE,
  PUBLISH_AUTHOR_NOT_CUSTODIAL_MESSAGE_MARKER,
  AMBIGUOUS_ASSERTION_AUTHOR_CODE,
  ASSERTION_AUTHOR_NOT_RESIDENT_CODE,
  PUBLISH_AUTHOR_SELECTION_CONFLICT_CODE,
  messageIndicatesNoFundedPublisherWallet,
  messageIndicatesPublishAuthorNotCustodial,
  formatPublishAuthorNotCustodialMessage,
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
export {
  ASSERTION_SEAL_PREDICATES,
  ASSERTION_PUBLISH_RECEIPT_PREDICATES,
  buildAssertionSealQuads,
  buildAssertionPublishReceiptQuads,
  parseAssertionSealQuads,
  parseGraphScopedAssertionSealCandidate,
  type GraphScopedAssertionSealCandidate,
  type AssertionSealBuildArgs,
  type AssertionSeal,
} from './assertion-seal.js';
export {
  CANONICAL_GRAPH_SCOPED_AUTHOR_SEAL_DIGEST_DOMAIN_V1,
  MAX_CANONICAL_GRAPH_SCOPED_AUTHOR_SEAL_BYTES_V1,
  MAX_SEAL_TRIPLE_COUNT_V1,
  CanonicalGraphScopedAuthorSealError,
  assertCanonicalGraphScopedAuthorSealV1,
  canonicalGraphScopedAuthorSealFromAssertionSealV1,
  canonicalizeCanonicalGraphScopedAuthorSealV1,
  canonicalizeCanonicalGraphScopedAuthorSealBytesV1,
  parseCanonicalGraphScopedAuthorSealV1,
  computeCanonicalGraphScopedAuthorSealDigestV1,
  assertCanonicalGraphScopedAuthorSealCoordinateV1,
  deriveCanonicalGraphScopedAuthorSealPlacementV1,
  projectCanonicalGraphScopedAuthorSealRowsV1,
  projectCanonicalGraphScopedAuthorSealStoreRowsV1,
  renderCanonicalAuthorSealStoreRowV1,
  canonicalizeAuthorSealStoreRoundTripRowV1,
  decodeCanonicalGraphScopedAuthorSealRowsV1,
  decodeCanonicalGraphScopedAuthorSealRenderedRowsV1,
  classifyCanonicalGraphScopedAuthorSealRowsV1,
  type Hex32V1,
  type PositiveDecimalU64V1,
  type SealTripleCountV1,
  type CanonicalIsoUtcMillisV1,
  type CanonicalGraphScopedAuthorSealV1,
  type CanonicalGraphScopedAuthorSealCoordinateV1,
  type CanonicalGraphScopedAuthorSealRowV1,
  type CanonicalAuthorSealStoreObjectV1,
  type CanonicalAuthorSealStoreRowV1,
  type CanonicalGraphScopedAuthorSealPlacementV1,
  type DecodedCanonicalGraphScopedAuthorSealRowsV1,
  type ClassifiedCanonicalGraphScopedAuthorSealRowsV1,
  type CanonicalGraphScopedAuthorSealErrorCode,
} from './canonical-graph-scoped-author-seal.js';
export * from './catalog-seal-binding.js';
export * from './transferred-catalog-bundle.js';
export * from './vm-update-convergence.js';
export * from './ka-ual-identity.js';
export {
  MAX_NODE_TIMER_DELAY_MS,
  assertNodeTimerDelayMs,
  resolveNodeTimerDelayMs,
} from './node-timer.js';
export * from './query-catalog-parameters.js';
export * from './query-catalog.js';
