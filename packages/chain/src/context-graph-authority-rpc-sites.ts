// SPDX-License-Identifier: Apache-2.0

/**
 * The bounded vocabulary of CALL SITES that reach the one-read Context Graph
 * live authority (`cgStorage.getContextGraph`).
 *
 * WHY a shared vocabulary rather than string literals at each site. That one
 * read is the single largest remaining chain-RPC term on a private node —
 * roughly 26 per asset on a curator — and every one of them bills to the same
 * `cgStorage.getContextGraph` label, so which caller costs what can only be
 * INFERRED from static reading. Routing a call site to an index, or leaving it
 * on the live path because it is a security gate, is a decision about a
 * measured number; until the split is measured it is a guess. Passing one of
 * these to `withRpcUsageSite` makes the read say who wanted it.
 *
 * Labels are code-owned constants, never derived from calldata, addresses or
 * peer input, and are kept short: the daemon's logfmt guard drops a
 * `readLabel:site` token longer than 64 characters back to the bare read label.
 *
 * The three SECURITY GATES are marked, because they are what the routing
 * decision turns on:
 *   G1  who receives the sender/decryption key for new private content;
 *   G2  whether content is written or gossiped in PLAINTEXT (public downgrade);
 *   G3  who may QUERY / READ, including inbound sync authorization.
 */
export const CONTEXT_GRAPH_AUTHORITY_FUNNEL_RPC_CONSUMER =
  'cgStorage.getContextGraph';

export const CONTEXT_GRAPH_AUTHORITY_RPC_SITES = Object.freeze({
  // --- funnel entries: reported only when no labelled caller sits above ---
  /** `resolveContextGraphAgentGateAuthority` — the shared agent-gate funnel. */
  gate: 'cgAuth.gate',
  /** `resolveWorkspaceGossipSigningAgent`. */
  signer: 'cgAuth.signer',
  /** `resolveWorkspaceAgentRecipientsForCurrentAuthority` — G1. */
  recipients: 'cgAuth.recipients',
  /** `getMemberRecoveryGate` — G3 (recovery sync). */
  recoveryGate: 'cgAuth.recoveryGate',
  /** `resolveContextGraphReadAuthority` — G3. */
  readAuthority: 'cgAuth.readAuth',
  /** `canReadContextGraph` — G3. */
  canRead: 'cgAuth.canRead',
  /** `resolveOnChainParticipantAgents` — host-mode participant oracle. */
  participants: 'cgAuth.participants',
  /** `readLiveOnChainAccessPolicy` / `resolveOnChainAccessPolicyState`. */
  livePolicy: 'cgAuth.livePolicy',
  /** `isContextGraphPublicOnChain` — G2. */
  publicProbe: 'cgAuth.publicProbe',
  /** `resolveRfc64VerifiedPrivateRosterV1` — RFC-64 roster establishment. */
  rfc64Roster: 'cgAuth.rfc64Roster',

  // --- call sites, which win over the funnel entry they pass through ---
  /** Publish-inline curated probe — G2. */
  curatedProbe: 'cgAuth.curatedProbe',
  /** `_resolveCuratedChainKeyContext` recipient resolution — G1. */
  curatedKeyContext: 'cgAuth.curatedKeyCtx',
  /** `shouldCreateImplicitSharedMemoryContextGraph` on the share path. */
  implicitContextGraph: 'cgAuth.implicitCg',
  /** Normal (non-recovery) inbound sync authorize — G3. */
  syncAuthorize: 'cgAuth.syncAuthz',
  /** The same authorize re-run after a curator `_meta` refresh — G3. */
  syncAuthorizeRetry: 'cgAuth.syncAuthzRetry',
  /** Recovery-branch inbound sync authorize — G3. */
  syncRecovery: 'cgAuth.syncRecovery',
  /** Changelog delta-page responder authorize — G3. */
  changelogAuthorize: 'cgAuth.changelogAuthz',
  /** Imported-artifact responder authorize — G3. */
  importedArtifactAuthorize: 'cgAuth.artifactAuthz',
  /** Ciphertext chunk serve. */
  chunkServe: 'cgAuth.chunkServe',
  /** Host-mode catch-up authorize. */
  hostCatchUp: 'cgAuth.hostCatchup',
  /** Host-mode gossip admission on a core with no local `_meta` allowlist. */
  hostAdmit: 'cgAuth.hostAdmit',
  /** SWM catch-up signer resolution. */
  catchUpSigner: 'cgAuth.catchupSigner',
  /** `resolveVmReconcileTarget` — every VM reconcile dispatch. */
  vmReconcile: 'cgAuth.vmReconcile',
  /** Exact-asset VM recovery fetch. */
  exactAssetFetch: 'cgAuth.exactAsset',
  /** VM recovery transfer sizing hint. */
  vmSizing: 'cgAuth.vmSizing',
  /** `acceptSwmSenderKeyPackage` — installs a peer's sender key. */
  senderKeyAccept: 'cgAuth.senderKeyAccept',
  /** Publisher-side recipient resolution on every private workspace write — G1. */
  publisherWrite: 'cgAuth.publisherWrite',
  /** Receiver-side plaintext-acceptance probe — G2. */
  plaintextProbe: 'cgAuth.plaintextProbe',
  /** SWM fan-out peer enumeration. */
  fanOut: 'cgAuth.fanout',
  /** Per-applied-write public-policy oracle — G2. */
  swmPublicOracle: 'cgAuth.swmPublicOracle',
  /** SWM chain agent-gate oracle. */
  swmGateOracle: 'cgAuth.swmGateOracle',
  /** Scoped `agent.query()` — G3, and the harness's polling path. */
  query: 'cgAuth.query',
  /** Receiver-side SWM apply agent-gate authorization — G3. */
  workspaceApply: 'cgAuth.workspaceApply',
  /** Host-mode envelope agent-gate authorization — G3. */
  hostEnvelope: 'cgAuth.hostEnvelope',
  /** Registered authority consulted by the read-authority resolver — G3. */
  readRegistered: 'cgAuth.readRegistered',
  /** Local agent gate consulted by the read-authority resolver — G3. */
  readLocalGate: 'cgAuth.readLocalGate',
  /** Inbound remote-query public-policy admission — G3. */
  remoteQuery: 'cgAuth.remoteQuery',
  /** Pending join metadata recovery read-authority gate — G3. */
  joinResume: 'cgAuth.joinResume',
  /** Shared-memory activation read-authority gate — G3. */
  sharedMemoryRead: 'cgAuth.swmRead',
  /** Random-sampling numeric-slot to local-CG binding resolution. */
  samplingBinding: 'cgAuth.samplingBinding',
  /** Join-policy active-member capacity census. */
  joinPolicyRoster: 'cgAuth.joinPolicyRoster',
  /** Join admission active-member capacity census. */
  joinAdmissionRoster: 'cgAuth.joinAdmission',
  /** Registered participant-add mutation preflight. */
  memberAdd: 'cgAuth.memberAdd',
  /** Registered participant-remove mutation preflight. */
  memberRemove: 'cgAuth.memberRemove',
  /** Query-catalog route read-authority gate — G3. */
  queryCatalog: 'cgAuth.queryCatalog',
  /** Memory-search route read-authority gate — G3. */
  memorySearch: 'cgAuth.memorySearch',
} as const);

export type ContextGraphAuthorityRpcSite =
  typeof CONTEXT_GRAPH_AUTHORITY_RPC_SITES[keyof typeof CONTEXT_GRAPH_AUTHORITY_RPC_SITES];
