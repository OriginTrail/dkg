import {
  DKGNode, ProtocolRouter, GossipSubManager, TypedEventBus, DKGEvent,
  LibP2PNetwork, PeerResolver, StubNetworkStateRegistry,
  PROTOCOL_ACCESS, PROTOCOL_PUBLISH, PROTOCOL_SYNC, PROTOCOL_QUERY_REMOTE, PROTOCOL_STORAGE_ACK, PROTOCOL_VERIFY_PROPOSAL, PROTOCOL_JOIN_REQUEST,
  PROTOCOL_SWM_SENDER_KEY,
  contextGraphPublishTopic, contextGraphWorkspaceTopic, contextGraphAppTopic, contextGraphUpdateTopic, contextGraphFinalizationTopic,
  contextGraphDataGraphUri, contextGraphMetaGraphUri, contextGraphWorkspaceGraphUri, contextGraphWorkspaceMetaGraphUri,
  contextGraphSharedMemoryUri,
  contextGraphVerifiedMemoryUri, contextGraphVerifiedMemoryMetaUri,
  contextGraphDataUri, contextGraphMetaUri, assertionLifecycleUri, contextGraphAssertionUri,
  deriveCuratorDidFromCgId,
  MemoryLayer,
  computeACKDigest,
  encodePublishRequest,
  encodeKAUpdateRequest,
  encodeGossipEnvelope,
  computeGossipSigningPayload,
  GOSSIP_ENVELOPE_VERSION,
  GOSSIP_TYPE_WORKSPACE_PUBLISH,
  encodeFinalizationMessage, type FinalizationMessageMsg,
  getGenesisQuads, computeNetworkId, SYSTEM_CONTEXT_GRAPHS, DKG_ONTOLOGY,
  Logger, createOperationContext, sparqlString, escapeSparqlLiteral, isSafeIri,
  TrustLevel,
  buildAuthorAttestationTypedData, AUTHOR_SCHEME_VERSION_V1, type AuthorAttestationTypedData,
  buildAssertionSealQuads, buildAssertionPublishReceiptQuads,
  parseAssertionSealQuads, type AssertionSeal,
  WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519,
  WORKSPACE_RECIPIENT_ENCRYPTION_KEY_PURPOSE,
  decodeWorkspaceEncryptionKey,
  encodeWorkspaceEncryptionKey,
  workspaceAgentEncryptionKeyId,
  SWM_SENDER_KEY_PACKAGE_ACK_TYPE,
  SWM_SENDER_KEY_PACKAGE_VERSION,
  computeSwmSenderKeyMembershipHash,
  computeSwmSenderKeyPackageAAD,
  decodeWorkspacePublishRequest,
  decodeSwmSenderKeyPackage,
  decodeSwmSenderKeyPackageAck,
  decryptSwmSenderKeyMessage,
  decryptSwmSenderKeyPackage,
  encodeSwmSenderKeyMessage,
  encodeSwmSenderKeyPackage,
  encodeSwmSenderKeyPackageAck,
  encryptSwmSenderKeyMessage,
  encryptSwmSenderKeyPackage,
  generateEd25519Keypair,
  generateSwmSenderChainKey,
  generateSwmSenderEpochId,
  ratchetSwmSenderChainKey,
  uint64ForProto,
  SWM_SENDER_KEY_SKIPPED_MESSAGE_CACHE_LIMIT,
  type DKGNodeConfig, type OperationContext, type GetView, type AssertionDescriptor, type AssertionEvent, type AssertionState,
  type SwmSenderKeyMessageMsg,
  type SwmSenderKeyPackageMsg,
  type WorkspaceRecipientEncryptionKey,
} from '@origintrail-official/dkg-core';
import { GraphManager, PrivateContentStore, createTripleStore, type TripleStore, type TripleStoreConfig, type Quad, type LargeLiteralStorageConfig } from '@origintrail-official/dkg-storage';
import { EVMChainAdapter, NoChainAdapter, enrichEvmError, type EVMAdapterConfig, type ChainAdapter, type CreateContextGraphParams, type CreateOnChainContextGraphParams, type CreateOnChainContextGraphResult } from '@origintrail-official/dkg-chain';
import {
  DKGPublisher, PublishHandler, SharedMemoryHandler, UpdateHandler, ChainEventPoller, AccessHandler, AccessClient,
  PublishJournal, StaleWriteError,
  ACKCollector, StorageACKHandler,
  VerifyCollector, VerifyProposalHandler, buildVerificationMetadata,
  resolveWorkspaceAgentRecipients,
  computeTripleHashV10 as computeTripleHash, computeFlatKCRootV10 as computeFlatKCRoot, autoPartition, isReservedSubject, computePrivateRootV10 as computePrivateRoot,
  canonicalPublishPayload,
  resolveLiftWorkspaceSlice,
  validateLiftPublishPayload,
  subtractFinalizedExactQuads,
  TripleStoreAsyncLiftPublisher,
  FileWorkspacePublicSnapshotStore,
  parseWorkspacePublicSnapshotNQuads,
  type PublishOptions, type PublishResult, type PhaseCallback, type KAMetadata, type CASCondition,
  type CollectedACK, type LiftAuthorityProof, type LiftTransitionType,
  type LiftRequest, type LiftRequestAuthorSeal,
  type WorkspaceAgentRecipient,
  type WorkspaceSenderKeyEncryptInput,
  type SharedMemoryPublicSnapshotStorageConfig, type WorkspacePublicSnapshotStore,
} from '@origintrail-official/dkg-publisher';
import { ethers } from 'ethers';
import { join } from 'node:path';
import {
  DKGQueryEngine, QueryHandler,
  emptyQueryResultForKind,
  validateReadOnlySparql,
  type QueryRequest, type QueryResponse, type QueryAccessConfig, type LookupType,
} from '@origintrail-official/dkg-query';
import { DKGAgentWallet, type AgentWallet } from './agent-wallet.js';

/**
 * Pre-signed AuthorAttestation payload supplied at finalize-time by
 * self-sovereign agents whose private key isn't held by the daemon.
 * Compact ECDSA `(r, vs)` over the EIP-712 typed data
 * `buildAuthorAttestationTypedData({ chainId, kav10Address,
 * contextGraphId, merkleRoot, authorAddress: address })`. The agent
 * verifies the recovered signer matches `address` before stamping the
 * seal.
 *
 * Lives at the agent layer (rather than as a publisher
 * `PublishOptions` field) since RFC-001 §9.x — Phase C — the
 * publisher only accepts already-sealed `precomputedAttestation`
 * payloads. Pre-signed signing is a finalize-time concern.
 */
type PreSignedAuthorAttestation = {
  address: string;
  signature: { r: Uint8Array; vs: Uint8Array };
};

type LocalSwmSenderKeySendState = {
  contextGraphId: string;
  subGraphName?: string;
  senderAgentAddress: string;
  epochId: string;
  membershipHash: string;
  chainKey: Uint8Array;
  nextMessageIndex: number;
  senderSigningSecretKey: Uint8Array;
  senderSigningPublicKey: Uint8Array;
  createdAtMs: number;
};

type LocalSwmSenderKeyReceiveState = {
  contextGraphId: string;
  subGraphName?: string;
  senderAgentAddress: string;
  epochId: string;
  membershipHash: string;
  chainKey: Uint8Array;
  nextMessageIndex: number;
  senderSigningPublicKey: Uint8Array;
  createdAtMs: number;
  skippedChainKeys: Map<number, Uint8Array>;
};
import { ProfileManager } from './profile-manager.js';
import { DiscoveryClient, type SkillSearchOptions, type DiscoveredAgent, type DiscoveredOffering } from './discovery.js';
import { MessageHandler, type SkillHandler, type SkillRequest, type SkillResponse, type ChatHandler, type ChatAclCheck } from './messaging.js';
import { ed25519ToX25519Private, ed25519ToX25519Public } from './encryption.js';
import { AGENT_REGISTRY_CONTEXT_GRAPH, canonicalAgentDidSubject, type AgentProfileConfig } from './profile.js';
import {
  signAgentDelegation,
  verifyAgentDelegation,
  type SignedAgentDelegation,
} from './auth/agent-delegation.js';
import { SyncVerifyWorker } from './sync-verify-worker.js';
import { bindRandomSampling, type RandomSamplingHandle, type RandomSamplingStatus } from './random-sampling-bind.js';
import { connectToMultiaddr, ensurePeerConnected as ensurePeerConnectedAtom, primeCatchupConnections as primeCatchupConnectionsAtom } from './p2p/peer-connect.js';
import { Messenger } from './p2p/messenger.js';
import { waitForPeerProtocol } from './p2p/protocol-readiness.js';
import { orderCatchupPeers } from './p2p/peer-selection.js';
import { fetchSyncPages, type SyncPageResult } from './sync/requester/page-fetch.js';
import { getSyncCheckpointKey } from './sync/checkpoint/state.js';
import { runDurableSync } from './sync/requester/durable-sync.js';
import { runSharedMemorySync } from './sync/requester/shared-memory-sync.js';
import { buildSyncRequestEnvelope, type SyncPhase } from './sync/auth/request-build.js';
import { authorizePrivateSyncRequest } from './sync/auth/request-authorize.js';
import { registerSyncHandler } from './sync/responder/sync-handler.js';
import { runSyncOnConnect } from './sync/on-connect/sync-on-connect.js';
import {
  generateCustodialAgent, registerSelfSovereignAgent, agentFromPrivateKey,
  ensureWorkspaceEncryptionKey,
  hashAgentToken,
  type AgentKeyRecord,
} from './agent-keystore.js';
import { GossipPublishHandler } from './gossip-publish-handler.js';
import { FinalizationHandler } from './finalization-handler.js';
import {
  JoinApprovalRetryQueue,
  type JoinApprovalRetryEntry,
} from './join-approval-retry-queue.js';
import {
  MessageOutbox,
  type ChatOutboxRetryEntry,
} from './message-outbox.js';
import { multiaddr } from '@multiformats/multiaddr';
import { buildCclPolicyQuads, buildPolicyApprovalQuads, buildPolicyRevocationQuads, hashCclPolicy, type CclPolicyRecord, type PolicyApprovalBinding } from './ccl-policy.js';
import { CclEvaluator, parseCclPolicy, validateCclPolicy, type CclEvaluationResult, type CclFactTuple } from './ccl-evaluator.js';
import { buildCclEvaluationQuads } from './ccl-evaluation-publish.js';
import { buildManualCclFacts, resolveFactsFromSnapshot, type CclFactResolutionMode } from './ccl-fact-resolution.js';
import {
  strip, stripLiteral, jsonLdToQuads,
  type JsonLdContent,
} from './dkg-agent-utils.js';

export interface CclPublishedResultEntry {
  entryUri: string;
  kind: 'derived' | 'decision';
  name: string;
  tuple: unknown[];
}

export interface CclPublishedEvaluationRecord {
  evaluationUri: string;
  policyUri: string;
  factSetHash: string;
   factQueryHash?: string;
   factResolverVersion?: string;
   factResolutionMode?: CclFactResolutionMode;
  createdAt?: string;
  view?: string;
  snapshotId?: string;
  scopeUal?: string;
  contextType?: string;
  results: CclPublishedResultEntry[];
}

export interface PublishOpts {
  onPhase?: PhaseCallback;
  operationCtx?: OperationContext;
  accessPolicy?: 'public' | 'ownerOnly' | 'allowList';
  allowedPeers?: string[];
  /** Target sub-graph within the context graph (e.g. "code", "decisions"). */
  subGraphName?: string;
}

export interface PublishAsyncOpts extends PublishOpts {
  namespace?: string;
  scope?: string;
  transitionType?: LiftTransitionType;
  authority?: LiftAuthorityProof;
  /** Prior KC reference; required for MUTATE/REVOKE. */
  priorVersion?: string;
  /** V10 selective-disclosure: per-entity kaRoot instead of flat-hash KC. */
  entityProofs?: boolean;
  /** RFC-001 §4 per-publish attribution override; `0n` = mode d. */
  publisherNodeIdentityIdOverride?: bigint;
  localOnly?: boolean;
  /** Registered local agent whose key signs the seal. Mirrors sync `assertionFinalize`. */
  authorAgentAddress?: string;
  /** Externally pre-signed seal. Mutually exclusive with `authorAgentAddress` / `authorSignTypedData`. */
  preSignedAuthorAttestation?: {
    expectedMerkleRoot: Uint8Array;
    authorAddress: string;
    signature: { r: Uint8Array; vs: Uint8Array };
    schemeVersion: number;
  };
  /** Caller signs typed-data built by the daemon. Requires `authorAgentAddress`. */
  authorSignTypedData?: (typedData: AuthorAttestationTypedData) => Promise<{ r: Uint8Array; vs: Uint8Array }>;
}

export interface PublishAsyncQuadEnvelope {
  publicQuads?: Quad[];
  privateQuads?: Quad[];
}

export type PublishAsyncContent = JsonLdContent | PublishAsyncQuadEnvelope;

export class ContextGraphNotFoundError extends Error {
  readonly code = 'ContextGraphNotFound';

  constructor(contextGraphId: string) {
    super(`Context graph "${contextGraphId}" does not exist or is not subscribed locally`);
    this.name = 'ContextGraphNotFound';
  }
}

export class InvalidContentError extends Error {
  readonly code = 'InvalidContent';

  constructor(message: string) {
    super(message);
    this.name = 'InvalidContent';
  }
}

const PRIVATE_DATA_ANCHOR = 'http://dkg.io/ontology/privateDataAnchor';

function normalizePublishContextGraphId(input: string): string {
  const value = String(input).trim().replace(/^<(.+)>$/, '$1');
  const prefix = 'did:dkg:context-graph:';
  if (!value.startsWith(prefix)) return value;
  const rest = value.slice(prefix.length);
  const slash = rest.indexOf('/');
  return slash >= 0 ? rest.slice(0, slash) : rest;
}

function isPublishAsyncQuadEnvelope(input: unknown): input is PublishAsyncQuadEnvelope {
  return !!input
    && typeof input === 'object'
    && !Array.isArray(input)
    && ('publicQuads' in input || 'privateQuads' in input);
}

function assertQuadArray(value: unknown, fieldName: string): Quad[] {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    throw new InvalidContentError(`${fieldName} must be an array of RDF quads`);
  }
  for (const quad of value) {
    if (
      !quad
      || typeof quad.subject !== 'string'
      || typeof quad.predicate !== 'string'
      || typeof quad.object !== 'string'
    ) {
      throw new InvalidContentError(`${fieldName} must contain RDF quads with subject, predicate, and object strings`);
    }
  }
  return value.map((quad) => ({ ...quad, graph: quad.graph ?? '' })) as Quad[];
}

function partitionPublishAsyncQuads(publicQuads: Quad[], privateQuads: Quad[]): {
  publicQuads: Quad[];
  privateQuadsByRoot: Map<string, Quad[]>;
  roots: string[];
} {
  const privateByRoot = autoPartition(privateQuads);
  let stagedPublicQuads = [...publicQuads];
  let publicByRoot = autoPartition(stagedPublicQuads);

  for (const rootEntity of privateByRoot.keys()) {
    if (!publicByRoot.has(rootEntity)) {
      stagedPublicQuads.push({
        subject: rootEntity,
        predicate: PRIVATE_DATA_ANCHOR,
        object: '"true"',
        graph: '',
      });
    }
  }

  publicByRoot = autoPartition(stagedPublicQuads);
  const roots = [...publicByRoot.keys()];
  if (roots.length === 0) {
    throw new InvalidContentError('Content produced no publishable root entities');
  }

  return {
    publicQuads: stagedPublicQuads,
    privateQuadsByRoot: privateByRoot,
    roots,
  };
}

/** Sign EIP-712 typed data with a raw private key, returning compact (r, vs). */
async function signWithPrivateKey(
  privateKey: string,
  typedData: AuthorAttestationTypedData,
): Promise<{ r: Uint8Array; vs: Uint8Array }> {
  const wallet = new ethers.Wallet(privateKey.startsWith('0x') ? privateKey : '0x' + privateKey);
  const sigHex = await wallet.signTypedData(typedData.domain, typedData.types, typedData.message);
  const sig = ethers.Signature.from(sigHex);
  return { r: ethers.getBytes(sig.r), vs: ethers.getBytes(sig.yParityAndS) };
}

/** Bytes → hex for lift-queue persistence. Inverse: `liftSealToPrecomputedAttestation`. */
function preSignedAttestationToLiftSeal(input: {
  expectedMerkleRoot: Uint8Array;
  authorAddress: string;
  signature: { r: Uint8Array; vs: Uint8Array };
  schemeVersion: number;
}): LiftRequestAuthorSeal {
  return {
    merkleRoot: ethers.hexlify(input.expectedMerkleRoot) as `0x${string}`,
    authorAddress: input.authorAddress as `0x${string}`,
    signature: {
      r: ethers.hexlify(input.signature.r) as `0x${string}`,
      vs: ethers.hexlify(input.signature.vs) as `0x${string}`,
    },
    schemeVersion: input.schemeVersion,
  };
}

const SYNC_PAGE_SIZE = 500;
const SYNC_PAGE_RETRY_ATTEMPTS = 3;
const SYNC_TOTAL_TIMEOUT_MS = 120_000;
/** Per-page timeout for sync when we have budget (relay links can be slow). */
const SYNC_PAGE_TIMEOUT_MS = 45_000;
/** ProtocolRouter.send retries internally 3 times with the same timeout; cap so 3× fits in remaining budget. */
const SYNC_ROUTER_ATTEMPTS = 3;
const SYNC_PROTOCOL_CHECK_ATTEMPTS = 3;
const SYNC_PROTOCOL_CHECK_DELAY_MS = 500;
const SYNC_AUTH_MAX_AGE_MS = 90_000;

/**
 * How long an agent's join-request delegation is valid for. The same
 * delegation authorises the joiner's node to sync this CG on behalf of
 * the agent for the lifetime of the membership; we default to 1 year so
 * that approved joiners don't silently lose access after a short window.
 * The agent can re-issue at any time by signing a fresh delegation.
 */
const JOIN_DELEGATION_VALIDITY_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * Send timeout for `/dkg/.../join-request` deliveries between joiner ↔ curator.
 *
 * Why 20s and not the previous 5s: `ProtocolRouter.send` shares a single
 * `AbortSignal.timeout(timeoutMs)` across its 3 retry attempts (see
 * `protocol-router.ts:82-97`), so this value is the budget for the *entire*
 * dial-retry loop, not per attempt. A fresh circuit-relay dial against a
 * NAT'd peer routinely takes 1-3s to establish; 5s leaves no headroom for
 * the back-off-and-retry path the loop is designed for, so the very first
 * approval-notification after a curator's `approve-join` would routinely
 * abort before libp2p got a chance to upgrade the relay connection. Two
 * laptops on home internet (PR #448) reproduced this consistently.
 *
 * 20s matches `DEFAULT_SEND_TIMEOUT_MS` and gives ProtocolRouter's loop room
 * for ~3 attempts of ~3-5s each before declaring the peer unreachable.
 *
 * The proper fix is per-attempt timeouts in ProtocolRouter (the shared signal
 * is a latent design issue) — tracked separately, not in scope here.
 */
const JOIN_REQUEST_SEND_TIMEOUT_MS = 20_000;

/**
 * Normalise an `did:dkg:agent:<id>` DID for case-insensitive equality
 * comparison. The agent ID can be either an Ethereum address (which IS
 * case-insensitive on the wire — checksum is purely advisory per
 * EIP-55) or a libp2p peer ID (which is NOT case-insensitive — base58
 * has uppercase characters that carry information). The previous
 * approach lower-cased the entire DID, which works in practice because
 * peer IDs round-trip the same way on both sides of a comparison, but
 * is semantically wrong: a non-EVM owner DID could in principle be
 * stored with one case and read back with another. Make the
 * normalisation explicit and only touch the EVM-address suffix.
 */
function normalizeAgentDid(did: string): string {
  const m = did.match(/^did:dkg:agent:(0x[0-9a-fA-F]{40})$/);
  if (m) return `did:dkg:agent:${m[1].toLowerCase()}`;
  return did;
}

/**
 * Scope string for join-request delegations. Authorises the named node
 * to sync the CG on the named DKG deployment.
 *
 * The `deploymentId` (e.g. `evm:84532:hub=0x...`) namespaces the scope
 * to a SPECIFIC deployment, not just a chain — every Hardhat instance
 * shares `evm:31337`, and a single chain can host multiple independent
 * DKG deployments with different Hub contracts. Without deployment-id
 * binding, a delegation signed against testnet's CG "X" could be
 * replayed against a devnet's CG "X" with the same delegatee
 * identifiers. See `ChainAdapter.deploymentId`.
 *
 * Fails closed if `deploymentId` is empty/undefined. `ChainAdapter` is
 * a TypeScript-only interface, so a JS / cast / custom adapter can omit
 * the field at runtime; without this guard we'd silently sign and
 * verify against `sync:deployment=undefined:<cgId>`, dropping the
 * cross-deployment replay protection this scope is meant to add.
 * PR #448 review (round 4): make misconfigured adapters fail loudly
 * instead of minting broad delegations.
 */
function joinDelegationScope(deploymentId: string | undefined, contextGraphId: string): string {
  if (!deploymentId || typeof deploymentId !== 'string' || deploymentId.trim().length === 0) {
    throw new Error(
      'Cannot derive join-delegation scope: chain adapter did not advertise a deploymentId. '
      + 'Every adapter (EVM, mock, custom) must implement `get deploymentId(): string` so '
      + 'delegations can\'t be cross-deployment replayed. Update the adapter or wrap it.',
    );
  }
  return `sync:deployment=${deploymentId}:${contextGraphId}`;
}

/**
 * Wire-level sentinel returned by the sync responder when ACL authorization
 * fails for a request. Distinguishes an explicit denial from an empty page
 * (peer is up but has no data) and a transport error (peer unreachable).
 * Chosen to never collide with nquads output (nquads lines always contain
 * `<…>` tokens and end with `.`; this is a `#`-comment string).
 */
const SYNC_ACCESS_DENIED_MARKER = '#DKG-SYNC-ACCESS-DENIED';

const LOCAL_ACCESS_OPEN = 0;
const LOCAL_ACCESS_CURATED = 1;
const EVM_PUBLISH_CURATED = 0;
const EVM_PUBLISH_OPEN = 1;
const MAX_CONTEXT_GRAPH_PARTICIPANT_AGENTS = 256;

/**
 * Thrown by `fetchSyncPages` when the remote responder returned
 * SYNC_ACCESS_DENIED_MARKER. Caught by `syncFromPeer` and surfaced as a
 * per-CG denial observation to the caller via its `onAccessDenied` hook,
 * so higher-level flows (catch-up job) can distinguish ACL denial from
 * transport errors without heuristics.
 */
class SyncAccessDeniedError extends Error {
  readonly contextGraphId: string;
  constructor(contextGraphId: string) {
    super(`Sync access denied for context graph "${contextGraphId}"`);
    this.name = 'SyncAccessDeniedError';
    this.contextGraphId = contextGraphId;
  }
}
const META_REFRESH_COOLDOWN_MS = 30_000;
const SYNC_MIN_GRAPH_BUDGET_MS = 10_000;
const DEBUG_SYNC_PROGRESS = process.env.DKG_DEBUG_SYNC_PROGRESS === '1';
const DEFAULT_SWM_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const SWM_CLEANUP_INTERVAL_MS = 15 * 60 * 1000; // run cleanup every 15 minutes
const SYNC_DENIED_RESPONSE = '__DKG_SYNC_DENIED__';
/**
 * How long to wait between reconnect-on-gossip dial attempts for the same peer.
 * A CG with chatty gossip could otherwise produce a dial per message; this
 * throttles us to at most one attempted dial per peer per window.
 */
const GOSSIP_DIAL_COOLDOWN_MS = 30_000;
/** Per-dial-attempt timeout for reconnect-on-gossip so a stuck dial can't starve the gossip handler path. */
const GOSSIP_DIAL_TIMEOUT_MS = 10_000;
/**
 * Cooldown for catchup-on-connection:open: suppresses duplicate catchup kicks
 * when the same peer briefly has overlapping direct + relayed connections
 * (each of which fires its own connection:open).
 */
const CATCHUP_ON_CONNECT_COOLDOWN_MS = 60_000;
/**
 * Period of the sync reconciler tick. The reconciler is the safety net
 * for the event-driven `peer:update` retry path: if libp2p drops a
 * `peer:update` event (in-process race, version bug, listener thrown),
 * or if a peer's protocol list changes via a transport we don't get
 * notified about, the reconciler eventually re-probes and re-syncs.
 *
 * Worst-case sync staleness for a connected peer is ~ this interval.
 * 5 minutes balances "catch missed events quickly enough that RS
 * proofs don't drift" against "don't pin the event loop with chatty
 * sync probes". See the dkg-agent design notes around
 * `startSyncReconciler` for the trade-off.
 */
const SYNC_RECONCILER_INTERVAL_MS = 5 * 60_000;
/**
 * A peer is considered "stale" — eligible for a reconciler-driven sync
 * retry — if no successful sync has completed for it within this window.
 * Set higher than `SYNC_RECONCILER_INTERVAL_MS` so a single missed
 * tick doesn't immediately retry every connected peer; that gives
 * the event-driven path time to win the race in the common case.
 */
const SYNC_STALENESS_THRESHOLD_MS = 10 * 60_000;
const RANDOM_SAMPLING_BIND_RETRY_MS = 30_000;
const STORAGE_ACK_REGISTRATION_RETRY_MS = 30_000;
/**
 * Period of the join-approval retry tick. The retry queue (see
 * `packages/agent/src/join-approval-retry-queue.ts`) holds entries for
 * `join-approved` notifications that the curator wrote locally but couldn't
 * deliver over libp2p — usually because of a transient transport reset
 * (`Remote closed connection during opening`, NAT mapping flap, the
 * invitee's daemon restarting). Without retry the invitee gets stuck:
 * the local curator state is correct but the invitee never learns to
 * sync, and their own retries can't help because they don't yet hold the
 * delegation that would let private-sync auth succeed. The tick walks the
 * queue's `due()` entries with exponential backoff. Opportunistic retries
 * also fire from `connection:open` when the invitee's peer reconnects,
 * which usually wins the race; the timer is the safety net for cases
 * where reconnect events are missed (e.g. relayed reconnects that don't
 * surface a fresh `connection:open` on the curator).
 */
const JOIN_APPROVAL_RETRY_TICK_MS = 30_000;

/**
 * Tick interval for the chat outbox retry queue. Same 30s cadence as
 * the join-approval queue (`JOIN_APPROVAL_RETRY_TICK_MS`). The cadence
 * doesn't gate the FIRST retry — a backoff-due entry that's been
 * waiting since 5s after first failure may sit idle for up to 25s
 * before this tick picks it up — but the dominant retry trigger in
 * practice is the `connection:open` opportunistic flush
 * (`processMessageOutboxOnConnect`), which fires the moment the
 * recipient peer becomes reachable again. The tick is the safety net
 * for cases where reconnect events are missed (e.g. relayed reconnects
 * that don't surface a fresh `connection:open` on the sender) or
 * where the recipient was reachable all along but transport failures
 * are coming from somewhere upstream of libp2p.
 */
const MESSAGE_OUTBOX_TICK_MS = 30_000;

type RandomSamplingStartResult = 'started' | 'retryable' | 'disabled';
type ACKSignerResolution = {
  wallet: ethers.Wallet | null;
  retryable: boolean;
};

interface SyncRequestEnvelope {
  contextGraphId: string;
  offset: number;
  limit: number;
  includeSharedMemory: boolean;
  phase?: SyncPhase;
  snapshotRef?: string;
  targetPeerId?: string;
  requesterPeerId?: string;
  requestId?: string;
  issuedAtMs?: number;
  requesterIdentityId?: string;
  requesterAgentAddress?: string;
  requesterSignatureR?: string;
  requesterSignatureVS?: string;
}

function normalizeSyncPhase(value: unknown): SyncPhase {
  if (value === 'meta' || value === 'snapshot') return value;
  return 'data';
}

/** Health status of a peer from the last ping round. */
export interface PeerHealth {
  peerId: string;
  alive: boolean;
  latencyMs: number | null;
  lastSeen: number | null;
  lastChecked: number;
}

/**
 * Caller-visible result of `DKGAgent.sendChat`. Backwards-compatible
 * extension of the original `{ delivered, error }` shape: existing
 * callers that only check `delivered` keep working, callers that want
 * to surface "queued for retry" (e.g. the MCP `dkg_send_message` tool)
 * can read `queued + attempts + nextAttemptAtMs`.
 */
export interface ChatSendResult {
  /** Whether the FIRST attempt's wire send + handler reply succeeded. */
  delivered: boolean;
  /** True iff `delivered=false` and the message was added to the outbox for retry. */
  queued?: boolean;
  /**
   * Outbox key fragment for this send. Stable across retries so a
   * caller can correlate the queued state with later delivery
   * notifications. Currently a uuidv4 unless the caller passed
   * `options.messageId`.
   */
  messageId?: string;
  /** Number of failed attempts so far (1 on first failure). Only set when `queued=true`. */
  attempts?: number;
  /** Epoch-ms when the next retry is due. Only set when `queued=true`. */
  nextAttemptAtMs?: number;
  /** Last error string from the wire send. Set on `delivered=false`. */
  error?: string;
}

/** Tracks the subscription and sync state of a context graph. */
export interface ContextGraphSub {
  name?: string;
  /** GossipSub topics are active for this context graph. */
  subscribed: boolean;
  /** Definition triples exist in the local triple store. */
  synced: boolean;
  /** Shared-memory catch-up has completed at least once for this subscription. */
  sharedMemorySynced?: boolean;
  /**
   * Whether the `_meta` graph (allowlist, registration status) has been
   * fetched via authenticated sync or is known from local creation.
   * When false, the gossip handler denies writes to prevent unauthorized
   * access during the window before _meta arrives.
   */
  metaSynced?: boolean;
  /** On-chain context graph ID (keccak256 hash), if known. */
  onChainId?: string;
  /** Local participant identities used for private SWM authorization before anchoring. */
  participantIdentityIds?: bigint[];
  /** Participant agent addresses (V10 agent identity model). */
  participantAgents?: string[];
  /**
   * Set to true between receiving a curator `join-approved` notification
   * and the first successful meta sync for this CG. Lets `listContextGraphs`
   * surface freshly-joined curated CGs in the UI's "waiting for sync" state
   * before `_meta` triples arrive — without this flag, a curated CG with
   * no `onChainId` and no local content yet is filtered out as a "phantom"
   * subscription and the project entry doesn't appear in the sidebar until
   * the periodic catchup reconciler eventually pulls meta (~2 min worst
   * case). In-memory only; not persisted because the periodic reconciler
   * always recovers post-restart by populating `metaSynced` directly.
   */
  pendingMeta?: boolean;
}

export interface ContextGraphSubscriptionRecord {
  id: string;
  name?: string;
  subscribed: boolean;
  synced: boolean;
  sharedMemorySynced?: boolean;
  metaSynced?: boolean;
  onChainId?: string;
  syncScoped: boolean;
}

export interface ContextGraphSubscriptionStore {
  loadAll(): Promise<ContextGraphSubscriptionRecord[]>;
  save(record: ContextGraphSubscriptionRecord): Promise<void>;
  delete(contextGraphId: string): Promise<void>;
}

export type ContextGraphMemberPrincipalType = 'node' | 'agent' | 'identity';
export type ContextGraphMemberStatus = 'active' | 'removed' | 'pending';

export interface ContextGraphMembershipRecord {
  contextGraphId: string;
  principalType: ContextGraphMemberPrincipalType;
  principalId: string;
  role?: string;
  status: ContextGraphMemberStatus;
  source?: string;
  displayName?: string;
  metadata?: Record<string, unknown>;
}

export interface ContextGraphMembershipStore {
  upsert(record: ContextGraphMembershipRecord & { firstSeenAt?: number; updatedAt: number }): Promise<void>;
  delete(contextGraphId: string, principalType: ContextGraphMemberPrincipalType, principalId: string): Promise<void>;
}

export interface DurableSyncDiagnostics {
  fetchedMetaTriples: number;
  fetchedDataTriples: number;
  insertedMetaTriples: number;
  insertedDataTriples: number;
  bytesReceived: number;
  resumedPhases: number;
  emptyResponses: number;
  metaOnlyResponses: number;
  dataRejectedMissingMeta: number;
  rejectedKcs: number;
  failedPeers: number;
}

export interface SharedMemorySyncDiagnostics {
  fetchedMetaTriples: number;
  fetchedDataTriples: number;
  insertedMetaTriples: number;
  insertedDataTriples: number;
  bytesReceived: number;
  resumedPhases: number;
  emptyResponses: number;
  droppedDataTriples: number;
  failedPeers: number;
}

export interface CatchupSyncDiagnostics {
  noProtocolPeers: number;
  durable: DurableSyncDiagnostics;
  sharedMemory: SharedMemorySyncDiagnostics;
}

interface DurableSyncResult extends DurableSyncDiagnostics {
  insertedTriples: number;
  deniedPhases: number;
}

interface SharedMemorySyncResult extends SharedMemorySyncDiagnostics {
  insertedTriples: number;
  deniedPhases: number;
}

export interface DKGAgentConfig {
  name: string;
  framework?: string;
  description?: string;
  listenPort?: number;
  /** IP address to listen on. Default: '0.0.0.0' (all interfaces). Use '127.0.0.1' for tests. */
  listenHost?: string;
  bootstrapPeers?: string[];
  /** Multiaddrs of relay nodes for NAT traversal. */
  relayPeers?: string[];
  /** Multiaddrs to announce to the network (for VPS/cloud nodes with a public IP not on the interface). */
  announceAddresses?: string[];
  skills?: Array<{
    skillType: string;
    pricePerCall?: number;
    currency?: string;
    handler: SkillHandler;
  }>;
  dataDir?: string;
  store?: TripleStore;
  /** Triple store backend configuration (e.g. oxigraph-worker, blazegraph). If omitted, defaults to oxigraph-worker when dataDir is set. */
  storeConfig?: TripleStoreConfig;
  /** Out-of-line storage for large public SWM RDF literal object terms. Defaults on for local Oxigraph-backed dataDir stores. */
  largeLiteralStorage?: LargeLiteralStorageConfig;
  /** Out-of-Oxigraph immutable public SWM operation snapshots. Defaults on when dataDir is set. */
  sharedMemoryPublicSnapshotStorage?: SharedMemoryPublicSnapshotStorageConfig;
  /** When false, peer-connect sync skips SWM catch-up and relies on gossip for new SWM writes. */
  syncSharedMemoryOnConnect?: boolean;
  /** Node deployment tier: 'core' (cloud, relay) or 'edge' (personal, behind NAT). Default: 'edge'. */
  nodeRole?: 'core' | 'edge';
  /**
   * Path to the V10 Random Sampling prover write-ahead log. Core
   * nodes only; ignored on edge. When omitted, an in-memory WAL is
   * used (loses crash-recovery context on restart). Production
   * deployments SHOULD set this to a persistent path under `dataDir`.
   */
  randomSamplingWalPath?: string;
  /**
   * If true (default on core), run the V10 Merkle proof build on a
   * `worker_threads` worker so a 100k-leaf KC does not block the
   * agent's event loop. Set false to keep the build on the main
   * thread (test ergonomics, deterministic profiling).
   */
  randomSamplingUseWorkerThread?: boolean;
  /**
   * Tick cadence for the prover loop (ms). Default 30s. The
   * orchestrator is idempotent under double-ticks; a tighter cadence
   * is safe but yields more chain reads.
   */
  randomSamplingTickIntervalMs?: number;
  /** Pre-built chain adapter (for testing). If provided, chainConfig is ignored. */
  chainAdapter?: ChainAdapter;
  /** Private key for the V10 ACK signer. When omitted, falls back to chainConfig.operationalKeys[0]. */
  ackSignerKey?: string;
  /**
   * Publisher EVM address used when publish signing is delegated to the
   * ChainAdapter instead of an in-process publisherPrivateKey.
   */
  publisherAddress?: string;
  /**
   * EVM chain configuration. If omitted, publishing won't have on-chain finality.
   * `adminPrivateKey` is the private key for the profile admin wallet used
   * only for profile/key-management transactions. Nodes may omit it when they
   * already have an on-chain identity and do not need profile creation/key-repair
   * privileges; profile mutation paths will fail fast if admin authority is
   * required but unavailable.
   * `operationalKeys` are the private keys for operational wallets.
   * The first key is the primary signer (identity, staking); all are used
   * round-robin for publish TXs to avoid nonce collisions on parallel publishes.
   */
  chainConfig?: {
    rpcUrl: string;
    hubAddress: string;
    adminPrivateKey?: string;
    operationalKeys: string[];
    chainId?: string;
  };
  /** Cross-agent query access configuration. */
  queryAccess?: QueryAccessConfig;
  /** Additional context graph IDs to sync on peer connect (beyond system context graphs). */
  syncContextGraphs?: string[];
  /** TTL for shared memory data in milliseconds. Expired operations are periodically cleaned up. Default: 48 hours. Set to 0 to disable. */
  sharedMemoryTtlMs?: number;
  /** Durable local store for subscribed context-graph runtime state. */
  contextGraphSubscriptionStore?: ContextGraphSubscriptionStore;
  /** Durable local cache for nodes/agents known to be members of a context graph. */
  contextGraphMembershipStore?: ContextGraphMembershipStore;
}

function normalizeAdapterPublisherAddress(value: unknown): string | undefined {
  if (typeof value !== 'string' || !ethers.isAddress(value)) return undefined;
  const address = ethers.getAddress(value);
  return address === ethers.ZeroAddress ? undefined : address;
}

function recoverCompactSigner(message: Uint8Array, compact: { r: Uint8Array; vs: Uint8Array }): string {
  const signature = ethers.Signature.from({
    r: ethers.hexlify(compact.r),
    yParityAndS: ethers.hexlify(compact.vs),
  }).serialized;
  return ethers.verifyMessage(message, signature);
}

function adapterOperationalPrivateKeyAddress(chain: ChainAdapter): string | undefined {
  const operationalKeyGetter = (chain as unknown as { getOperationalPrivateKey?: () => unknown })
    .getOperationalPrivateKey;
  if (typeof operationalKeyGetter !== 'function') return undefined;
  try {
    const privateKey = operationalKeyGetter.call(chain);
    return typeof privateKey === 'string' && privateKey.length > 0
      ? privateKeyAddress(privateKey)
      : undefined;
  } catch {
    return undefined;
  }
}

function adapterHasOperationalPrivateKey(chain: ChainAdapter): boolean {
  return adapterOperationalPrivateKeyAddress(chain) !== undefined;
}

async function adapterGenericSignMessageMatchesAddress(
  chain: ChainAdapter,
  expectedAddress: string,
): Promise<boolean> {
  if (chain.chainId === 'none' || typeof chain.signMessage !== 'function') return false;
  const normalized = normalizeAdapterPublisherAddress(expectedAddress);
  if (!normalized) return false;

  try {
    const challenge = ethers.getBytes(ethers.id(`dkg-agent:chain-signer-probe:${normalized.toLowerCase()}`));
    const compact = await chain.signMessage(challenge);
    const recovered = normalizeAdapterPublisherAddress(recoverCompactSigner(challenge, compact));
    return recovered?.toLowerCase() === normalized.toLowerCase();
  } catch {
    return false;
  }
}

async function adapterAdvertisesPublisherSigner(chain: ChainAdapter): Promise<boolean> {
  const hasReservingOrMultiAddressProbe = typeof chain.getAuthorizedPublisherAddress === 'function' ||
    typeof (chain as unknown as { getSignerAddresses?: unknown }).getSignerAddresses === 'function';
  const hasSingleAddressProbe = typeof (chain as unknown as { getSignerAddress?: unknown }).getSignerAddress === 'function' ||
    Boolean(normalizeAdapterPublisherAddress((chain as unknown as { signerAddress?: unknown }).signerAddress));
  const hasAnyAddressProbe = hasReservingOrMultiAddressProbe || hasSingleAddressProbe;

  if (typeof chain.signMessageAs === 'function') return hasAnyAddressProbe;
  if (adapterHasOperationalPrivateKey(chain)) return true;
  if (typeof chain.signMessage !== 'function') return false;

  const advertisedAddress = await inferAdapterPublisherAddress(chain, undefined, {
    includeReservingPublisherProbe: false,
    includeGenericSignMessageProbe: false,
  });
  if (!advertisedAddress) return false;
  return adapterGenericSignMessageMatchesAddress(chain, advertisedAddress);
}

function privateKeyAddress(privateKey: string | undefined): string | undefined {
  if (!privateKey) return undefined;
  try {
    return normalizeAdapterPublisherAddress(new ethers.Wallet(privateKey).address);
  } catch {
    return undefined;
  }
}

async function inferAdapterPublisherAddress(
  chain: ChainAdapter,
  contextGraphId?: bigint,
  options?: {
    includeReservingPublisherProbe?: boolean;
    includeGenericSignMessageProbe?: boolean;
  },
): Promise<string | undefined> {
  if (
    options?.includeReservingPublisherProbe !== false &&
    contextGraphId !== undefined &&
    typeof chain.getAuthorizedPublisherAddress === 'function'
  ) {
    try {
      const address = normalizeAdapterPublisherAddress(
        await chain.getAuthorizedPublisherAddress(contextGraphId),
      );
      if (address) return address;
    } catch {
      // Best-effort probe; the publisher resolver retries on later publish/update attempts.
    }
  }

  const signerAddressGetter = (chain as unknown as { getSignerAddress?: () => unknown }).getSignerAddress;
  if (typeof signerAddressGetter === 'function') {
    try {
      const address = normalizeAdapterPublisherAddress(
        await Promise.resolve(signerAddressGetter.call(chain)),
      );
      if (address) return address;
    } catch {
      // Best-effort probe; fall through to broader adapter surfaces.
    }
  }

  const signerAddresses = (chain as unknown as { getSignerAddresses?: () => unknown }).getSignerAddresses;
  if (typeof signerAddresses === 'function') {
    try {
      const advertised = await Promise.resolve(signerAddresses.call(chain));
      if (Array.isArray(advertised)) {
        for (const value of advertised) {
          const address = normalizeAdapterPublisherAddress(value);
          if (address) return address;
        }
      }
    } catch {
      // Best-effort probe; the publisher resolver retries on later publish/update attempts.
    }
  }

  const signerAddress = normalizeAdapterPublisherAddress(
    (chain as unknown as { signerAddress?: unknown }).signerAddress,
  );
  if (signerAddress) return signerAddress;

  const adapterOperationalAddress = adapterOperationalPrivateKeyAddress(chain);
  if (adapterOperationalAddress) return adapterOperationalAddress;

  if (options?.includeGenericSignMessageProbe === false) return undefined;
  if (chain.chainId === 'none' || typeof chain.signMessage !== 'function') return undefined;

  try {
    const challenge = ethers.getBytes(ethers.id('dkg-agent:publisher-address-probe'));
    const compact = await chain.signMessage(challenge);
    return normalizeAdapterPublisherAddress(recoverCompactSigner(challenge, compact));
  } catch {
    return undefined;
  }
}

function defaultLargeLiteralStorage(
  dataDir: string,
  config: LargeLiteralStorageConfig | undefined,
): LargeLiteralStorageConfig {
  return {
    enabled: config?.enabled ?? true,
    thresholdBytes: config?.thresholdBytes,
    directory: config?.directory ?? join(dataDir, 'literal-blobs'),
  };
}

function createPublicSnapshotStore(
  dataDir: string | undefined,
  config: SharedMemoryPublicSnapshotStorageConfig | undefined,
): WorkspacePublicSnapshotStore | undefined {
  if (!dataDir || config?.enabled === false) return undefined;
  return new FileWorkspacePublicSnapshotStore(config?.directory ?? join(dataDir, 'swm-public-snapshots'));
}

function applyDefaultLargeLiteralStorage(
  storeConfig: TripleStoreConfig,
  dataDir: string | undefined,
  config: LargeLiteralStorageConfig | undefined,
): TripleStoreConfig {
  if (storeConfig.largeLiteralStorage || !dataDir || !isLocalOxigraphConfig(storeConfig)) {
    return storeConfig;
  }

  return {
    ...storeConfig,
    largeLiteralStorage: defaultLargeLiteralStorage(dataDir, config),
  };
}

function isLocalOxigraphConfig(storeConfig: TripleStoreConfig): boolean {
  return storeConfig.backend === 'oxigraph'
    || storeConfig.backend === 'oxigraph-worker'
    || storeConfig.backend === 'oxigraph-persistent';
}

/**
 * High-level facade that ties together all DKG agent capabilities:
 * identity, networking, publishing, querying, discovery, and messaging.
 *
 * Usage:
 *   const agent = await DKGAgent.create({ name: 'MyBot', skills: [...] });
 *   await agent.start();
 *   const offerings = await agent.findSkills({ skillType: 'ImageAnalysis' });
 *   const response = await agent.invokeSkill(offerings[0], inputData);
 *   await agent.stop();
 */
export class DKGAgent {
  readonly wallet: AgentWallet;
  readonly node: DKGNode;
  readonly store: TripleStore;
  readonly publisher: DKGPublisher;
  readonly queryEngine: DKGQueryEngine;
  readonly discovery: DiscoveryClient;
  readonly profileManager: ProfileManager;
  gossip!: GossipSubManager;
  router!: ProtocolRouter;
  messenger!: Messenger;
  /** Single in-process peer-address resolver (RFC 07 §3). Used by Messenger
   * today; ProtocolRouter / /api/connect migrate in PR-3 / PR-4. */
  peerResolver!: PeerResolver;
  readonly eventBus: TypedEventBus;
  private readonly chain: ChainAdapter;
  /** Shared memory-owned root entities per context graph: entity → creatorPeerId. Used by publisher and shared memory handler. */
  private readonly workspaceOwnedEntities: Map<string, Map<string, string>>;
  /** Shared write locks so gossip writes serialize against local CAS writes. */
  private readonly writeLocks: Map<string, Promise<void>>;
  private readonly publicSnapshotStore?: WorkspacePublicSnapshotStore;
  private sharedMemoryHandler?: InstanceType<typeof SharedMemoryHandler>;
  private gossipPublishHandler?: GossipPublishHandler;
  private finalizationHandler?: FinalizationHandler;
  private readonly log = new Logger('DKGAgent');

  private messageHandler: MessageHandler | null = null;
  private chainPoller: ChainEventPoller | null = null;
  private swmCleanupTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * Retry queue for `join-approved` notifications whose libp2p delivery
   * failed. See `JOIN_APPROVAL_RETRY_TICK_MS` for the design rationale
   * and `join-approval-retry-queue.ts` for the queue semantics. The
   * queue is in-memory; daemon restarts drop pending entries. Operators
   * can re-trigger manually via `POST /api/context-graph/{id}/redeliver-approval`
   * and the invitee's own re-submission of the join request is also
   * handled idempotently by `approveJoinRequest`.
   */
  private readonly joinApprovalRetryQueue: JoinApprovalRetryQueue = new JoinApprovalRetryQueue();
  private joinApprovalRetryTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * Retry queue for outbound chat messages whose libp2p delivery
   * failed. Symmetric to `joinApprovalRetryQueue` but invitee-side:
   * the operator-typed text from `dkg_send_message` no longer drops
   * silently when the recipient peer is briefly unreachable. See
   * `message-outbox.ts` for the queue semantics and the chat thread
   * with Lex on PR #510 for the joint design notes.
   */
  private readonly messageOutbox: MessageOutbox = new MessageOutbox();
  private messageOutboxTimer: ReturnType<typeof setInterval> | null = null;
  private randomSamplingHandle: RandomSamplingHandle | null = null;
  private randomSamplingBindRetryTimer: ReturnType<typeof setInterval> | null = null;
  private randomSamplingBindRetryInFlight = false;
  private storageACKRegistrationRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private storageACKRegistrationRetryInFlight = false;
  private readonly config: DKGAgentConfig;
  private started = false;
  private readonly subscribedContextGraphs = new Map<string, ContextGraphSub>();
  private readonly gossipRegistered = new Set<string>();
  private readonly sharedMemoryGossipRegistered = new Set<string>();
  private readonly seenOnChainIds = new Set<string>();
  private readonly peerHealth = new Map<string, PeerHealth>();
  private readonly knownCorePeerIds = new Set<string>();
  private readonly syncingPeers = new Set<string>();
  private readonly seenPrivateSyncRequestIds = new Map<string, number>();
  private readonly metaRefreshTimestamps = new Map<string, number>();
  private readonly preferredSyncPeers = new Map<string, string>();
  /**
   * Remembers the libp2p peer ID that delivered each pending join request
   * to this curator. Keyed by `${contextGraphId}::${agentAddress_lower}`.
   *
   * This is the authoritative source when we later need to notify that
   * requester about approval/rejection — the agent registry can be stale
   * (a requester may P2P-reach us before their agent profile has indexed
   * locally), so without this map we'd drop notifications and leave the
   * invitee stuck on "Join request sent, awaiting approval". See
   * `notifyJoinApproval` / `notifyJoinRejection`.
   *
   * In-memory only: survives for the curator's process lifetime, which
   * matches the approval window in practice. On restart we fall back to
   * the agent registry.
   */
  private readonly joinRequestOriginPeers = new Map<string, string>();
  /**
   * Requester-side hint: which local agent did WE pick when signing the
   * join-delegation for a given context graph?
   *
   * Used by `findLocalAgentForContextGraph` to bind sync envelopes to
   * the actually-approved agent in the brief window between
   * `join-approved` arriving and the curator's `_meta` graph being
   * synced into our local store. Without this hint, a multi-agent node
   * would fall back to `defaultAgentAddress` for the first
   * post-approval catch-up, the responder's per-agent delegation lookup
   * would miss the real claim, and sync would silently fail until the
   * next `_meta` round-trip propagated the allowlist.
   *
   * Populated in two places:
   *  1. `signJoinRequest` — the moment we sign for a CG, we know our
   *     intent. Single-agent nodes are a no-op here (the default IS the
   *     agent), but it's free to maintain.
   *  2. The `join-approved` handler — definitive: the curator just
   *     told us this exact agent was promoted. Survives sign-then-restart
   *     because the curator's notification re-establishes the hint.
   *
   * Lower-cased agent address. In-memory only — restart loses it, but
   * after restart the `_meta` allowlist will have been synced (it's the
   * very first thing post-approval), so the hint is no longer needed.
   * Keyed by raw `contextGraphId` (no normalisation needed — every
   * caller already has the canonical id).
   */
  private readonly localApprovedAgentByCG = new Map<string, string>();
  /**
   * Symmetric companion to `joinRequestOriginPeers`, populated on the
   * REQUESTER side. When `forwardJoinRequest` broadcasts to all peers,
   * any peer that responds `{ok: true}` is self-claiming curator status
   * for this `(contextGraphId, agentAddress)` pair. We remember those
   * peers so a subsequent `join-approved` / `join-rejected` notification
   * can be authenticated against them — without requiring the requester
   * to have synced the CG's `_meta` graph (which is impossible by
   * definition: a curated CG denies meta sync until approval, and the
   * rejection notification is the one case where the request will
   * never be approved).
   *
   * Keyed identically (`${contextGraphId}::${agentAddress_lower}`).
   * Stored as a Set because the broadcast may legitimately reach
   * multiple curator nodes for the same CG (multi-curator deployments
   * are not yet a feature, but the data shape doesn't preclude them).
   *
   * Why this is the right authority surface: a peer that previously
   * accepted `{ok: true}` to a join request has already been trusted
   * with the request's authenticity; trusting them with the matching
   * decision is no expansion of attack surface. A peer that lied
   * about `ok: true` could already grief the requester by silently
   * dropping the request — letting them also forge a fake "rejected"
   * notification just collapses the same denial-of-service window
   * faster, never widens it.
   *
   * In-memory only, like `joinRequestOriginPeers`. On requester
   * restart between submit and decision, we fall back to the
   * `_meta`-based curator check (which works for already-approved
   * agents who later get re-rejected, the only scenario where the
   * requester has meta access).
   */
  private readonly joinRequestAcceptedBy = new Map<string, Set<string>>();
  /**
   * Per-peer timestamp of the last reconnect-on-gossip dial we attempted.
   * Prevents a noisy topic from generating a dial storm against a peer we
   * already tried recently. See DOC: p2p-resilience.md.
   */
  private readonly gossipDialAttemptedAt = new Map<string, number>();
  /**
   * Per-peer timestamp of the last catchup-on-connect we queued, to dedupe
   * connection:open events when the same peer briefly churns between
   * direct + relayed connections within a short window.
   */
  private readonly catchupOnConnectAt = new Map<string, number>();
  /**
   * Peers whose most recent sync attempt found that their advertised
   * protocol list did NOT include `PROTOCOL_SYNC` — almost always a
   * libp2p identify race on the inbound side of `connection:open`,
   * not a real "this peer doesn't speak sync" answer. The `peer:update`
   * listener drains entries from this set the moment libp2p reports
   * an updated protocol list that contains `PROTOCOL_SYNC`, and the
   * periodic reconciler treats membership as a strong hint to retry.
   *
   * Entries are also cleared on `connection:close` (no path to the peer
   * anyway — the next `connection:open` will re-trigger sync-on-connect)
   * and after a successful sync (see `lastSuccessfulSyncAt`).
   */
  private readonly skippedNoSyncPeers = new Set<string>();
  /**
   * Per-peer timestamp of the most recent successful run of sync-on-connect.
   * Driven by `runSyncOnConnect.onPeerSynced`. Used by the periodic
   * reconciler to skip peers that have already synced recently — the
   * staleness threshold is intentionally larger than the reconciler
   * interval so a single missed tick doesn't immediately retry every
   * connected peer.
   */
  private readonly lastSuccessfulSyncAt = new Map<string, number>();
  private syncReconcilerTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * v10-rc sync-refactor: per-(peer+CG) checkpoint offsets so the paged
   * sync requester in `sync/requester/page-fetch.ts` can resume where it
   * left off, and the worker-hosted verify path (`sync-verify-worker.ts`)
   * can run CPU-bound hash checks off the main thread. Both introduced
   * by PR #237 (sync-refactor-rebased).
   */
  private readonly syncCheckpoints = new Map<string, number>();
  private syncVerifyWorker?: SyncVerifyWorker;

  /** Registered agents on this node: agentAddress → AgentKeyRecord */
  private readonly localAgents = new Map<string, AgentKeyRecord>();
  /** Agent token → agentAddress lookup for Bearer-based agent resolution */
  private readonly agentTokenIndex = new Map<string, string>();
  /** The default "owner" agent address (first operational wallet, auto-registered on boot) */
  private defaultAgentAddress: string | undefined;
  private readonly swmSenderKeySendStates = new Map<string, LocalSwmSenderKeySendState>();
  private readonly swmSenderKeyReceiveStates = new Map<string, LocalSwmSenderKeyReceiveState>();
  private swmSenderKeyStateLoaded = false;

  private constructor(
    config: DKGAgentConfig,
    wallet: DKGAgentWallet,
    node: DKGNode,
    store: TripleStore,
    publisher: DKGPublisher,
    queryEngine: DKGQueryEngine,
    eventBus: TypedEventBus,
    chain: ChainAdapter,
    workspaceOwnedEntities: Map<string, Map<string, string>>,
    writeLocks: Map<string, Promise<void>>,
    publicSnapshotStore?: WorkspacePublicSnapshotStore,
  ) {
    this.config = config;
    this.wallet = wallet;
    this.node = node;
    this.store = store;
    this.publisher = publisher;
    this.queryEngine = queryEngine;
    this.workspaceOwnedEntities = workspaceOwnedEntities;
    this.writeLocks = writeLocks;
    this.publicSnapshotStore = publicSnapshotStore;
    this.eventBus = eventBus;
    this.chain = chain;
    this.discovery = new DiscoveryClient(queryEngine);
    this.profileManager = new ProfileManager(publisher, store);
    this.publisher.setWorkspaceAgentRecipientResolver((input) => resolveWorkspaceAgentRecipients(this.store, input));
    this.publisher.setWorkspaceSenderKeyEncryptor((input) => this.encryptWorkspacePayloadWithSenderKey(input));
  }

  static async create(config: DKGAgentConfig): Promise<DKGAgent> {
    let wallet: DKGAgentWallet;
    if (config.dataDir) {
      try {
        wallet = await DKGAgentWallet.load(config.dataDir);
      } catch {
        wallet = await DKGAgentWallet.generate();
        await wallet.save(config.dataDir);
      }
    } else {
      wallet = await DKGAgentWallet.generate();
    }
    const log = new Logger('DKGAgent');
    const ctx = createOperationContext('system');
    let store: TripleStore;
    if (config.store) {
      store = config.store;
    } else if (config.storeConfig) {
      store = await createTripleStore(applyDefaultLargeLiteralStorage(config.storeConfig, config.dataDir, config.largeLiteralStorage));
      log.info(ctx, `Triple store backend: ${config.storeConfig.backend}`);
    } else if (config.dataDir) {
      const { join } = await import('node:path');
      const persistPath = join(config.dataDir, 'store.nq');
      store = await createTripleStore({
        backend: 'oxigraph-worker',
        options: { path: persistPath },
        largeLiteralStorage: defaultLargeLiteralStorage(config.dataDir, config.largeLiteralStorage),
      });
      log.info(ctx, `Persistent triple store (worker thread): ${persistPath}`);
    } else {
      store = await createTripleStore({ backend: 'oxigraph' });
      log.warn(ctx, `No dataDir — triple store is in-memory (data will be lost on restart)`);
    }

    const nodeRole = config.nodeRole ?? 'edge';
    let chain: ChainAdapter;
    let opKeys = config.chainConfig?.operationalKeys;
    if (config.chainAdapter) {
      chain = config.chainAdapter;
      if (!opKeys?.length && typeof (chain as any).getOperationalPrivateKey === 'function') {
        opKeys = [(chain as any).getOperationalPrivateKey()];
      }
    } else if (config.chainConfig && opKeys?.length) {
      const evmConfigBase = {
        rpcUrl: config.chainConfig.rpcUrl,
        privateKey: opKeys[0],
        additionalKeys: opKeys.slice(1),
        hubAddress: config.chainConfig.hubAddress,
        chainId: config.chainConfig.chainId,
      };
      if (config.chainConfig.adminPrivateKey) {
        chain = new EVMChainAdapter({ ...evmConfigBase, adminPrivateKey: config.chainConfig.adminPrivateKey });
      } else {
        chain = new EVMChainAdapter({ ...evmConfigBase, allowNoAdminSigner: true });
      }
    } else {
      chain = new NoChainAdapter();
    }

    const eventBus = new TypedEventBus();
    const keypair = wallet.keypair;

    // Load genesis knowledge into the store (idempotent)
    await DKGAgent.loadGenesis(store);

    const port = config.listenPort ?? 0;
    const host = config.listenHost ?? '0.0.0.0';
    const nodeConfig: DKGNodeConfig = {
      listenAddresses: [`/ip4/${host}/tcp/${port}`],
      announceAddresses: config.announceAddresses,
      bootstrapPeers: config.bootstrapPeers,
      relayPeers: config.relayPeers,
      enableMdns: !config.bootstrapPeers?.length && !config.relayPeers?.length,
      privateKey: keypair.secretKey,
      nodeRole,
    };

    const node = new DKGNode(nodeConfig);
    const workspaceOwnedEntities = new Map<string, Map<string, string>>();
    const writeLocks = new Map<string, Promise<void>>();
    const publicSnapshotStore = createPublicSnapshotStore(config.dataDir, config.sharedMemoryPublicSnapshotStorage);
    const legacyAdapterOperationalKey = opKeys?.[0];
    const legacyAdapterOperationalAddress = privateKeyAddress(legacyAdapterOperationalKey);
    const configuredPublisherAddress = normalizeAdapterPublisherAddress(config.publisherAddress);
    const publisherAddressMatchesLegacyKey = Boolean(
      configuredPublisherAddress &&
      legacyAdapterOperationalAddress &&
      configuredPublisherAddress.toLowerCase() === legacyAdapterOperationalAddress.toLowerCase(),
    );
    const adapterCanPublishFromAdvertisedSigner = await adapterAdvertisesPublisherSigner(chain);
    const useLegacyAdapterOperationalKeyFallback = Boolean(
      config.chainAdapter &&
      legacyAdapterOperationalKey &&
      !adapterCanPublishFromAdvertisedSigner &&
      (!configuredPublisherAddress || publisherAddressMatchesLegacyKey),
    );
    const publisher = new DKGPublisher({
      store,
      chain,
      eventBus,
      keypair,
      publisherPrivateKey: useLegacyAdapterOperationalKeyFallback ? legacyAdapterOperationalKey : undefined,
      publisherAddress: config.publisherAddress,
      publisherAddressResolver: config.publisherAddress || useLegacyAdapterOperationalKeyFallback
        ? undefined
        : (contextGraphId?: bigint) => inferAdapterPublisherAddress(chain, contextGraphId),
      sharedMemoryOwnedEntities: workspaceOwnedEntities,
      writeLocks,
      publicSnapshotStore,
    });

    try {
      const restored = await publisher.reconstructWorkspaceOwnership();
      if (restored > 0) {
        const log = new Logger('DKGAgent');
        log.info(createOperationContext('init'), `Restored ${restored} shared memory ownership entries from store`);
      }
    } catch (err) {
      const log = new Logger('DKGAgent');
      log.warn(createOperationContext('init'), `Failed to reconstruct shared memory ownership, continuing without: ${err instanceof Error ? err.message : String(err)}`);
    }

    const queryEngine = new DKGQueryEngine(store);

    return new DKGAgent(
      config, wallet, node, store, publisher, queryEngine, eventBus, chain,
      workspaceOwnedEntities, writeLocks, publicSnapshotStore,
    );
  }

  private getACKSignerCandidateWallets(ctx: OperationContext): ethers.Wallet[] {
    const operationalKeys = this.config.chainAdapter
      ? []
      : (this.config.chainConfig?.operationalKeys ?? []);
    const keys = [
      this.config.ackSignerKey,
      ...operationalKeys,
      typeof this.chain.getACKSignerKey === 'function' ? this.chain.getACKSignerKey() : undefined,
    ].filter((key): key is string => Boolean(key));

    const wallets: ethers.Wallet[] = [];
    const seen = new Set<string>();
    for (const key of keys) {
      try {
        const wallet = new ethers.Wallet(key);
        const addressKey = wallet.address.toLowerCase();
        if (seen.has(addressKey)) continue;
        seen.add(addressKey);
        wallets.push(wallet);
      } catch (err) {
        this.log.warn(ctx, `Ignoring invalid ACK signer key: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return wallets;
  }

  private async resolveConfirmedACKSigner(
    identityId: bigint,
    candidates: ethers.Wallet[],
    ctx: OperationContext,
  ): Promise<ACKSignerResolution> {
    const isOperationalWalletRegistered = this.chain.isOperationalWalletRegistered;
    if (typeof isOperationalWalletRegistered !== 'function') {
      this.log.warn(
        ctx,
        'V10 StorageACK signer disabled: chain adapter does not implement required on-chain operational wallet confirmation',
      );
      return { wallet: null, retryable: false };
    }

    let sawLookupError = false;
    for (const wallet of candidates) {
      try {
        if (await isOperationalWalletRegistered.call(this.chain, identityId, wallet.address)) {
          return { wallet, retryable: false };
        }
      } catch (err) {
        sawLookupError = true;
        this.log.warn(
          ctx,
          `Unable to confirm ACK signer ${wallet.address} on-chain: ` +
          `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    if (sawLookupError) {
      this.log.warn(
        ctx,
        `V10 StorageACK handler registration deferred: signer confirmation failed due lookup error(s)`,
      );
      return { wallet: null, retryable: true };
    }

    this.log.warn(
      ctx,
      `V10 StorageACK signer disabled: no candidate key is confirmed on-chain as ` +
      `OPERATIONAL_KEY for identity ${identityId}`,
    );
    return { wallet: null, retryable: false };
  }

  async start(): Promise<void> {
    if (this.started) return;
    const ctx = createOperationContext('connect');
    this.log.info(ctx, `Starting DKG node`);

    await this.node.start();
    this.started = true;
    this.log.info(ctx, `Node started, peer ID: ${this.node.peerId.toString()}`);

    // Load registered agents from triple store; auto-register default if none exist.
    // loadAgentsFromStore restores defaultAgentAddress from the persisted
    // isDefaultAgent marker, avoiding reliance on SPARQL result ordering.
    await this.loadAgentsFromStore();
    if (this.localAgents.size === 0) {
      await this.autoRegisterDefaultAgent();
    }
    if (!this.defaultAgentAddress && this.localAgents.size > 0) {
      // Fallback: no persisted marker — pick first and persist for next boot
      const first = this.localAgents.values().next().value!;
      this.defaultAgentAddress = first.agentAddress;
      await this.markDefaultAgent(first.agentAddress).catch(() => {});
    }

    const network = new LibP2PNetwork(this.node);
    const peerResolver = new PeerResolver({
      network,
      registry: new StubNetworkStateRegistry(),
      agentDirectory: {
        // Wraps DiscoveryClient.findAgentByPeerId in the resolver's
        // minimal AgentDirectoryLookup shape so packages/core doesn't
        // need to know about the agents-CG SPARQL surface. Replaced
        // when RFC 04 Phase 2 lands — at that point, the registry
        // step takes precedence and this fallback is rarely hit.
        //
        // Codex review feedback on PR #496 round 5: the previous
        // revision dropped `opts.signal` entirely, leaving the
        // resolver's documented cancellation guarantee unhonored at
        // the only production AgentDirectoryLookup. DiscoveryClient
        // itself doesn't (yet) accept an AbortSignal, so we honor
        // the contract at the adapter boundary instead: if the
        // signal aborts the adapter resolves to `null` immediately,
        // unblocking the resolver and the outer caller. The
        // underlying SPARQL fetch then completes in the background
        // and its result is discarded — a small leak in the abort
        // path, acceptable given:
        //   (a) it's bounded by the discovery client's own internal
        //       timeout
        //   (b) RFC 04 Phase 2 replaces this fallback path entirely
        //   (c) the alternative (refactoring DiscoveryClient end-to-
        //       end signal threading) is out of scope for this PR
        // The follow-up to plumb signals into DiscoveryClient is
        // tracked separately.
        findRelayForPeer: async (peerId, opts) => {
          if (opts?.signal?.aborted) return null;
          const lookup = this.discovery.findAgentByPeerId(peerId)
            .then((agent) => agent?.relayAddress ?? null);
          const signal = opts?.signal;
          if (!signal) return lookup;
          return Promise.race<string | null>([
            lookup,
            new Promise<null>((resolve) => {
              // Codex PR #499 round 5 (dkg-agent.ts:1354): the early
              // `signal.aborted` check above and `addEventListener`
              // are not atomic — the signal could fire in between, and
              // since `abort` is a one-shot event, our late listener
              // would never see it and this Promise would hang for the
              // full lookup duration. Re-check INSIDE the constructor
              // before subscribing so the abort branch resolves
              // immediately if we lost that race.
              if (signal.aborted) {
                resolve(null);
                return;
              }
              signal.addEventListener(
                'abort',
                () => resolve(null),
                { once: true },
              );
            }),
          ]);
        },
      },
      // Bootstrap is a libp2p-startup concern (`bootstrap({ list })` in
      // peerDiscovery, see node.ts) — not a per-peer resolution concern.
      // Removed here per Codex review feedback on PR #496.
    });
    this.peerResolver = peerResolver;
    this.router = new ProtocolRouter(this.node, { peerResolver });
    this.messenger = new Messenger({ router: this.router });
    this.gossip = new GossipSubManager(this.node, this.eventBus);
    await this.loadSwmSenderKeyState();
    await this.rehydrateContextGraphSubscriptions();

    // Register protocol handlers
    const accessHandler = new AccessHandler(this.store, this.eventBus);
    this.router.register(PROTOCOL_ACCESS, accessHandler.handler);

    const journal = this.config.dataDir ? new PublishJournal(this.config.dataDir) : undefined;
    const publishHandler = new PublishHandler(this.store, this.eventBus, { journal });
    this.router.register(PROTOCOL_PUBLISH, publishHandler.handler);
    if (journal) {
      try {
        await publishHandler.restorePendingPublishes();
      } catch (err) {
        this.log.warn(ctx, `Journal restore failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Register cross-agent query handler (deny-by-default for security)
    const queryAccessConfig: QueryAccessConfig = this.config.queryAccess ?? {
      defaultPolicy: 'deny',
    };
    if (this.config.queryAccess?.defaultPolicy === 'public') {
      this.log.warn(ctx, 'Query access policy is "public" — all remote queries will be accepted. Set queryAccess.defaultPolicy to "deny" for stricter security.');
    }
    const queryRemoteHandler = new QueryHandler(this.queryEngine, queryAccessConfig);
    this.router.register(PROTOCOL_QUERY_REMOTE, queryRemoteHandler.handler);
    this.router.register(PROTOCOL_SWM_SENDER_KEY, async (data, peerId) => {
      return this.handleSwmSenderKeyPackage(data, peerId.toString());
    });

    const effectiveRole = this.config.nodeRole ?? 'edge';
    const ackSignerCandidates = this.getACKSignerCandidateWallets(ctx);
    let onChainIdentityId = 0n;
    const ensureACKCandidateWalletsRegistered = async (
      attemptCtx: OperationContext,
    ): Promise<boolean> => {
      if (onChainIdentityId <= 0n || typeof this.chain.ensureOperationalWalletsRegistered !== 'function') {
        return true;
      }
      try {
        const registration = await this.chain.ensureOperationalWalletsRegistered({
          identityId: onChainIdentityId,
          additionalAddresses: ackSignerCandidates.map((wallet) => wallet.address),
        });
        if (registration.registered.length > 0) {
          this.log.info(
            attemptCtx,
            `Registered ${registration.registered.length} operational wallet(s) on-chain for ` +
            `identityId=${onChainIdentityId}`,
          );
        }
        if (registration.taken.length > 0) {
          this.log.warn(
            attemptCtx,
            `Operational wallet(s) already registered to another identity: ` +
            registration.taken.map((w) => `${w.address}->${w.identityId}`).join(', '),
          );
        }
        return true;
      } catch (err) {
        this.log.warn(
          attemptCtx,
          `Operational wallet auto-registration failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        return false;
      }
    };

    // Auto-detect or register on-chain identity.
    // Edge nodes skip profile creation — they operate with agent identity only.
    if (this.chain.chainId !== 'none') {
      try {
        onChainIdentityId = await this.chain.getIdentityId();
        if (onChainIdentityId === 0n && effectiveRole === 'core') {
          this.log.info(ctx, `No on-chain identity found, creating profile and staking...`);
          onChainIdentityId = await this.chain.ensureProfile({
            nodeName: this.config.name,
          });
          this.log.info(ctx, `On-chain profile created, identityId=${onChainIdentityId}`);
        } else if (onChainIdentityId === 0n) {
          this.log.info(ctx, `Edge node — skipping on-chain profile creation (agent identity only)`);
        } else {
          this.log.info(ctx, `On-chain identity found: identityId=${onChainIdentityId}`);
        }
      } catch (err) {
        this.log.warn(ctx, `ensureProfile error: ${err instanceof Error ? err.message : String(err)}`);
        try {
          onChainIdentityId = await this.chain.getIdentityId();
          if (onChainIdentityId > 0n) {
            this.log.info(ctx, `Recovered identityId=${onChainIdentityId} after partial failure`);
          }
        } catch { /* ignore */ }
      }
      if (onChainIdentityId > 0n) {
        if (effectiveRole === 'core') {
          await ensureACKCandidateWalletsRegistered(ctx);
        }

        this.publisher.setIdentityId(onChainIdentityId);
        this.log.info(ctx, `Publisher using identityId=${onChainIdentityId}`);
      } else if (effectiveRole === 'core') {
        this.log.warn(ctx, `No valid on-chain identity — on-chain publishes will be skipped`);
      }
    }

    // Register V10 StorageACK handler AFTER ensureProfile so identity is resolved.
    // Only core nodes register the StorageACK handler — edge nodes cannot
    // sign ACKs (the handler would reject immediately) and advertising the
    // protocol confuses peer-role detection based on protocol support.
    if (effectiveRole === 'core') {
      if (ackSignerCandidates.length > 0) {
        let storageACKProtocolRegistered = false;
        let storageACKFailoverInFlight = false;
        const attemptStorageACKRegistration = async (
          attemptCtx: OperationContext,
          options: { repairWallets?: boolean } = {},
        ): Promise<'registered' | 'retryable' | 'disabled'> => {
          if (storageACKProtocolRegistered) return 'registered';
          if (onChainIdentityId > 0n) {
            const registrationSucceeded = options.repairWallets === false
              ? true
              : await ensureACKCandidateWalletsRegistered(attemptCtx);
            const signerResolution = await this.resolveConfirmedACKSigner(
              onChainIdentityId,
              ackSignerCandidates,
              attemptCtx,
            );
            const ackSignerWallet = signerResolution.wallet;
            if (!ackSignerWallet) {
              return (registrationSucceeded && !signerResolution.retryable) ? 'disabled' : 'retryable';
            }

            // The V10 ACK digest includes a (chainid, kav10Address) H5 prefix
            // per KnowledgeAssetsV10.sol:362-373. Resolve both from the chain
            // adapter BEFORE constructing the handler so the handler can sign
            // digests that actually verify on-chain. The handler itself has
            // no provider-backed dependency, so both values are passed in at
            // construction.
            const chainIdForHandler = typeof this.chain.getEvmChainId === 'function'
              ? await this.chain.getEvmChainId()
              : undefined;
            const kav10AddressForHandler = typeof this.chain.getKnowledgeAssetsV10Address === 'function'
              ? await this.chain.getKnowledgeAssetsV10Address()
              : undefined;
            if (chainIdForHandler === undefined || kav10AddressForHandler === undefined) {
              this.log.warn(
                attemptCtx,
                `Skipping V10 StorageACK handler: chain adapter does not expose ` +
                `getEvmChainId() + getKnowledgeAssetsV10Address(); handler cannot build the ` +
                `H5-prefixed ACK digest that KnowledgeAssetsV10 verifies on-chain`,
              );
              return 'disabled';
            }

            const ackHandler = new StorageACKHandler(this.store, {
              nodeRole: effectiveRole,
              nodeIdentityId: onChainIdentityId,
              signerWallet: ackSignerWallet,
              contextGraphSharedMemoryUri,
              chainId: chainIdForHandler,
              kav10Address: kav10AddressForHandler,
              isSignerRegistered: async () => {
                const isOperationalWalletRegistered = this.chain.isOperationalWalletRegistered;
                if (typeof isOperationalWalletRegistered !== 'function') return false;
                return isOperationalWalletRegistered.call(
                  this.chain,
                  onChainIdentityId,
                  ackSignerWallet.address,
                );
              },
              onSignerUnregistered: () => {
                if (storageACKFailoverInFlight) return;
                storageACKFailoverInFlight = true;
                storageACKProtocolRegistered = false;
                this.router.unregister(PROTOCOL_STORAGE_ACK);
                this.log.warn(
                  attemptCtx,
                  `Unregistered V10 StorageACK handler: signer ${ackSignerWallet.address} ` +
                  `is no longer confirmed on-chain for identity=${onChainIdentityId}`,
                );
                attemptStorageACKRegistration(
                  createOperationContext('connect'),
                  { repairWallets: false },
                )
                  .then((result) => {
                    if (result === 'retryable') {
                      scheduleStorageACKRegistrationRetry({ repairWallets: false });
                    }
                  })
                  .catch((err: unknown) => {
                    this.log.warn(
                      attemptCtx,
                      `V10 StorageACK signer failover failed: ` +
                      `${err instanceof Error ? err.message : String(err)}`,
                    );
                    scheduleStorageACKRegistrationRetry({ repairWallets: false });
                  })
                  .finally(() => {
                    storageACKFailoverInFlight = false;
                  });
              },
              onSignerRegistrationLookupFailed: (err) => {
                this.log.warn(
                  attemptCtx,
                  `V10 StorageACK signer registration lookup failed for ${ackSignerWallet.address}; ` +
                  `keeping handler active: ${err instanceof Error ? err.message : String(err)}`,
                );
              },
            }, this.eventBus);
            this.router.register(PROTOCOL_STORAGE_ACK, ackHandler.handler);
            storageACKProtocolRegistered = true;
            this.clearStorageACKRegistrationRetry();
            this.log.info(
              attemptCtx,
              `Registered V10 StorageACK handler (identity=${onChainIdentityId}, signer=${ackSignerWallet.address})`,
            );
            return 'registered';
          } else {
            this.log.warn(attemptCtx, `Skipping V10 StorageACK handler registration — identity not yet provisioned`);
            return 'disabled';
          }
          return 'disabled';
        };

        const scheduleStorageACKRegistrationRetry = (options: { repairWallets?: boolean } = {}) => {
          if (this.storageACKRegistrationRetryTimer || storageACKProtocolRegistered) return;
          this.log.warn(ctx, `V10 StorageACK handler registration will retry every ${STORAGE_ACK_REGISTRATION_RETRY_MS}ms`);
          this.storageACKRegistrationRetryTimer = setTimeout(() => {
            this.storageACKRegistrationRetryTimer = null;
            if (!this.started || storageACKProtocolRegistered || this.storageACKRegistrationRetryInFlight) return;
            this.storageACKRegistrationRetryInFlight = true;
            attemptStorageACKRegistration(createOperationContext('connect'), options)
              .then((result) => {
                if (result === 'retryable') scheduleStorageACKRegistrationRetry(options);
              })
              .catch((err: unknown) => {
                this.log.warn(
                  ctx,
                  `V10 StorageACK handler registration retry failed: ` +
                  `${err instanceof Error ? err.message : String(err)}`,
                );
                scheduleStorageACKRegistrationRetry(options);
              })
              .finally(() => {
                this.storageACKRegistrationRetryInFlight = false;
              });
          }, STORAGE_ACK_REGISTRATION_RETRY_MS);
          if (this.storageACKRegistrationRetryTimer.unref) this.storageACKRegistrationRetryTimer.unref();
        };

        try {
          const result = await attemptStorageACKRegistration(ctx);
          if (result === 'retryable') scheduleStorageACKRegistrationRetry();
        } catch (err) {
          this.log.warn(ctx, `Skipping V10 StorageACK handler: ${err instanceof Error ? err.message : String(err)}`);
          scheduleStorageACKRegistrationRetry();
        }
      } else if (typeof this.chain.signACKDigest === 'function') {
        this.log.info(ctx, `V10 StorageACK: adapter has signACKDigest but no extractable key — handler registration deferred until callback signing is supported`);
      }
    } else {
      this.log.info(ctx, `Node role is '${effectiveRole}' — skipping StorageACK handler registration (core-only)`);
    }

    // Register VERIFY proposal handler — responds to incoming M-of-N proposals.
    // Agents on the allowList sign the verify digest when they agree with the data.
    // Uses the ACK signer key (core nodes) or first operational key (edge nodes).
    const verifySignerKey = this.config.ackSignerKey
      ?? (typeof this.chain.getACKSignerKey === 'function' ? this.chain.getACKSignerKey() : undefined)
      ?? this.config.chainConfig?.operationalKeys?.[0];
    if (verifySignerKey) {
      const verifyWallet = new ethers.Wallet(verifySignerKey);
      const verifyHandler = new VerifyProposalHandler({
        store: this.store,
        agentPrivateKey: verifySignerKey,
        agentAddress: verifyWallet.address,
        getBatchMerkleRoot: async (cgId: string, batchId: bigint) => {
          const metaGraph = contextGraphMetaGraphUri(cgId);
          // Try typed literal first, fallback to untyped for backward compat
          for (const literal of [`"${batchId}"^^<http://www.w3.org/2001/XMLSchema#integer>`, `"${batchId}"`]) {
            const result = await this.store.query(
              `SELECT ?root WHERE { GRAPH <${metaGraph}> { ?kc <https://dkg.network/ontology#merkleRoot> ?root . ?kc <https://dkg.network/ontology#batchId> ${literal} } } LIMIT 1`,
            );
            if (result.type === 'bindings' && result.bindings.length > 0) {
              const hex = (result.bindings[0] as Record<string, string>)['root'];
              if (!hex) return null;
              return ethers.getBytes(hex.startsWith('"') ? hex.slice(1, -1) : hex);
            }
          }
          return null;
        },
        getContextGraphIdOnChain: async (cgId: string) => {
          const sub = this.subscribedContextGraphs.get(cgId);
          return sub?.onChainId ? BigInt(sub.onChainId) : null;
        },
      });
      this.router.register(PROTOCOL_VERIFY_PROPOSAL, verifyHandler.handler);
      this.log.info(ctx, 'Registered VERIFY proposal handler');
    }

    // Start chain event poller for trustless confirmation of tentative publishes
    // and discovery of on-chain context graphs. Only with a real chain adapter.
    if (this.chain.chainId !== 'none') {
      this.chainPoller = new ChainEventPoller({
        chain: this.chain,
        publishHandler,
        onContextGraphCreated: async ({ contextGraphId, creator, accessPolicy, blockNumber }) => {
          this.log.info(ctx, `Discovered on-chain context graph ${contextGraphId.slice(0, 16)}… (block ${blockNumber}, creator ${creator.slice(0, 10)}…, policy ${accessPolicy})`);

          // Track the hash for dedup but don't pollute subscribedContextGraphs.
          // Gossip topics are keyed by cleartext name, not the on-chain hash.
          // The context graph will be fully subscribed once ontology sync or
          // discoverContextGraphsFromChain resolves the cleartext name.
          const alreadyKnown = this.seenOnChainIds.has(contextGraphId)
            || [...this.subscribedContextGraphs.values()].some(s => s.onChainId === contextGraphId);
          if (!alreadyKnown) {
            this.seenOnChainIds.add(contextGraphId);
            this.log.info(ctx, `Noted on-chain context graph ${contextGraphId.slice(0, 16)}… — will subscribe once cleartext name is resolved`);
          }
        },
      });
      this.chainPoller.start();
      this.log.info(ctx, `Chain event poller started`);
    }

    // Set up messaging
    const x25519Priv = ed25519ToX25519Private(this.wallet.keypair.secretKey);
    this.messageHandler = new MessageHandler(
      this.router,
      this.messenger,
      this.wallet.keypair,
      x25519Priv,
      this.node.peerId,
      this.eventBus,
    );

    // Wire up pending chat handler
    if (this._pendingChatHandler) {
      this.messageHandler.onChat(this._pendingChatHandler);
      this._pendingChatHandler = null;
    }

    // Wire up pending chat ACL (set via `agent.setChatAcl(...)` before start)
    if (this._pendingChatAcl) {
      this.messageHandler.setChatAcl(this._pendingChatAcl);
      this._pendingChatAcl = null;
    }

    // Register skill handlers
    if (this.config.skills) {
      for (const skill of this.config.skills) {
        const uri = `https://dkg.origintrail.io/skill#${skill.skillType}`;
        this.messageHandler.registerSkill(uri, skill.handler);
      }
    }

    registerSyncHandler({
      router: this.router,
      protocolSync: PROTOCOL_SYNC,
      syncDeniedResponse: SYNC_DENIED_RESPONSE,
      syncPageSize: SYNC_PAGE_SIZE,
      sharedMemoryTtlMs: this.config.sharedMemoryTtlMs ?? DEFAULT_SWM_TTL_MS,
      store: this.store,
      publicSnapshotStore: this.publicSnapshotStore,
      peerId: this.peerId,
      parseSyncRequest: this.parseSyncRequest.bind(this),
      authorizeSyncRequest: this.authorizeSyncRequest.bind(this),
      logWarn: (ctx, message) => this.log.warn(ctx, message),
      logDebug: (ctx, message) => this.log.debug(ctx, message),
    });

    // Join-request protocol: receives signed join requests forwarded by peers.
    // Stores them locally if this node is the curator; ACKs with "ok" or "error".
    this.router.register(PROTOCOL_JOIN_REQUEST, async (data, peerId) => {
      try {
        const payload = JSON.parse(new TextDecoder().decode(data));

        // Handle "join-approved" notifications from curator → requester.
        // Only process if this node owns the target agentAddress AND the
        // sender is a peer we previously trusted as a curator candidate
        // for THIS specific (cgId, agentAddress) pair (or, as a fallback,
        // matches the curator triple in our local _meta graph — which
        // works for already-approved members getting re-approved).
        if (payload.type === 'join-approved') {
          const { contextGraphId, agentAddress: approvedAddr } = payload;
          // Require BOTH fields. Earlier the address was treated as
          // optional, so a forged payload carrying only `contextGraphId`
          // would skip the trusted-sender check, subscribe this node,
          // and emit JOIN_APPROVED unconditionally. Mirror the
          // rejection handler: if either field is missing, drop.
          if (contextGraphId && approvedAddr) {
            const isLocalAgent = [...this.localAgents.keys()].some(
              (addr) => addr.toLowerCase() === approvedAddr.toLowerCase(),
            );
            if (!isLocalAgent) {
              return new TextEncoder().encode(JSON.stringify({ ok: true, skipped: true }));
            }
            const senderTrusted = await this.isTrustedJoinDecisionSender(
              contextGraphId,
              approvedAddr,
              peerId.toString(),
            );
            if (!senderTrusted) {
              this.log.warn(
                createOperationContext('system'),
                `Dropping join-approved for "${contextGraphId}" from ${peerId.toString()} — sender did not previously accept the join request and is not the recorded curator`,
              );
              return new TextEncoder().encode(JSON.stringify({ ok: true, skipped: true }));
            }
            this.preferredSyncPeers.set(contextGraphId, peerId.toString());
            // Curator just confirmed `approvedAddr` is the principal —
            // record it BEFORE auto-subscribe / sync kick in, so the
            // first post-approval `buildSyncRequest` claims the right
            // agent (the curator's `_meta` graph hasn't been synced
            // yet at this point on multi-agent nodes).
            this.localApprovedAgentByCG.set(contextGraphId, approvedAddr.toLowerCase());
            this.log.info(createOperationContext('system'), `Join request approved for "${contextGraphId}" — auto-subscribing`);
            this.subscribeToContextGraph(contextGraphId);
            this.upsertContextGraphMember({
              contextGraphId,
              principalType: 'agent',
              principalId: approvedAddr,
              role: 'participant',
              status: 'active',
              source: 'join-approved',
            });
            this.joinRequestAcceptedBy.delete(`${contextGraphId}::${approvedAddr.toLowerCase()}`);
            // Mark the subscription as "expecting meta" so listContextGraphs
            // surfaces it in the UI immediately (with synced=false) instead
            // of filtering it out as a phantom subscription until meta-sync
            // completes. Cleared in `refreshMetaSyncedFlags` once meta lands.
            //
            // `metaSynced: false` is set together with `pendingMeta: true`
            // because the two are complementary, not redundant: `metaSynced`
            // is the FACTUAL state that downstream safety guards check
            // (`shouldCreateImplicitSharedMemoryContextGraph` and the curated
            // gossip pre-meta gate in gossip-publish-handler.ts both use
            // strict `metaSynced === false` equality), and `pendingMeta` is
            // the UI affordance layered on top. Without `metaSynced: false`,
            // a freshly-approved private CG slips past both guards in the
            // window between approval and the first `_meta` arrival — any
            // SWM write or inbound gossip in that window then gets inferred
            // as a public CG locally, which is the exact corruption these
            // guards exist to prevent. Lex review on PR #517 round 2 + Codex.
            this.markContextGraphSubscriptionState(contextGraphId, {
              pendingMeta: true,
              metaSynced: false,
            });
            // Sync immediately by targeting the curator peer we just received
            // this notification from, instead of relying on the periodic
            // catchup reconciler to pick it up minutes later. The previous
            // `.catch(() => {})` swallowed every failure mode silently and
            // also went through the regular peer-ranking path that produced
            // zero sync attempts in the just-approved-but-no-meta-yet window.
            void this.runImmediatePostApprovalSync(contextGraphId, peerId.toString());
            this.eventBus.emit(DKGEvent.JOIN_APPROVED, {
              contextGraphId,
              agentAddress: approvedAddr,
            });
          }
          return new TextEncoder().encode(JSON.stringify({ ok: true }));
        }

        // Handle "join-rejected" notifications from curator → requester.
        // Symmetric to join-approved: filter by localAgents and emit an
        // event so the UI can surface a notification instead of leaving
        // the invitee's Join modal stuck on "Join request sent…" forever.
        //
        // We deliberately do NOT mutate local subscription/ACL state —
        // cleanup of phantom auto-discovery is left to the daemon's
        // catch-up denial path, which is gated on the curator's actual
        // ACL response.
        if (payload.type === 'join-rejected') {
          const { contextGraphId, agentAddress: rejectedAddr } = payload;
          if (!contextGraphId || !rejectedAddr) {
            return new TextEncoder().encode(JSON.stringify({ ok: true, skipped: true }));
          }
          // The rejection target must be one of our local agents (Codex
          // tier-4h N14). This alone isn't enough though: a malicious
          // peer that knows a target's agent address can still forge a
          // rejection for any CG, driving our UI into a false "denied"
          // state. So also require the SENDER to be the CG's curator
          // — Codex tier-4k N27. The sender's peer ID is passed in by
          // the router; we match it against the CG's recorded curator
          // DID (direct peer-ID DID for legacy CGs) or, for
          // wallet-scoped curators, the current peer ID published by
          // the curator agent in the registry. Anything else is
          // dropped with a short `skipped` ACK.
          const isLocalAgent = [...this.localAgents.keys()].some(
            (addr) => addr.toLowerCase() === rejectedAddr.toLowerCase(),
          );
          if (!isLocalAgent) {
            return new TextEncoder().encode(JSON.stringify({ ok: true, skipped: true }));
          }
          const senderTrusted = await this.isTrustedJoinDecisionSender(
            contextGraphId,
            rejectedAddr,
            peerId.toString(),
          );
          if (!senderTrusted) {
            this.log.warn(
              createOperationContext('system'),
              `Dropping join-rejected for "${contextGraphId}" from ${peerId.toString()} — sender did not previously accept the join request and is not the recorded curator`,
            );
            return new TextEncoder().encode(JSON.stringify({ ok: true, skipped: true }));
          }
          this.log.info(createOperationContext('system'), `Join request rejected for "${contextGraphId}"`);
          this.upsertContextGraphMember({
            contextGraphId,
            principalType: 'agent',
            principalId: rejectedAddr,
            role: 'requester',
            status: 'removed',
            source: 'join-rejected',
          });
          this.joinRequestAcceptedBy.delete(`${contextGraphId}::${rejectedAddr.toLowerCase()}`);
          // Drop the optimistic "this CG belongs to <rejectedAddr>" hint
          // seeded by `signJoinRequest`. Otherwise multi-agent nodes keep
          // building authenticated sync requests on behalf of the rejected
          // agent and the curator denies the very next catch-up after a
          // *different* local agent is allowlisted, until something else
          // overwrites the map.
          const localHint = this.localApprovedAgentByCG.get(contextGraphId);
          if (localHint && localHint === rejectedAddr.toLowerCase()) {
            this.localApprovedAgentByCG.delete(contextGraphId);
          }
          this.eventBus.emit(DKGEvent.JOIN_REJECTED, {
            contextGraphId,
            agentAddress: rejectedAddr,
          });
          return new TextEncoder().encode(JSON.stringify({ ok: true }));
        }

        const { contextGraphId, delegation, agentName } = payload as {
          contextGraphId?: string;
          delegation?: SignedAgentDelegation;
          agentName?: string;
        };
        // Diagnostic surface for the rejection paths below. Without this
        // every silent-reject path (`missing fields`, `unknown CG`, `not
        // curator`, `verifyJoinRequest` throws) is invisible at runtime
        // — the failing joiner just sees "no reachable curator" and the
        // curator's log shows nothing. PR #448 round-6 testing burned a
        // lot of time on that gap; surface it.
        const remotePeer = peerId.toString();
        const peerTag = remotePeer.slice(-8);
        const requestCtx = createOperationContext('system');
        if (!contextGraphId || !delegation?.agentAddress || !delegation?.signature) {
          this.log.warn(
            requestCtx,
            `PROTOCOL_JOIN_REQUEST from ${peerTag}: rejected — missing fields ` +
              `(contextGraphId=${!!contextGraphId} agentAddress=${!!delegation?.agentAddress} signature=${!!delegation?.signature})`,
          );
          return new TextEncoder().encode(JSON.stringify({ ok: false, error: 'missing fields' }));
        }
        // Only store if this node is the curator (creator) of the CG
        const owner = await this.getContextGraphOwner(contextGraphId);
        if (!owner) {
          this.log.warn(
            requestCtx,
            `PROTOCOL_JOIN_REQUEST from ${peerTag} for "${contextGraphId}": rejected — unknown CG`,
          );
          return new TextEncoder().encode(JSON.stringify({ ok: false, error: 'unknown CG' }));
        }
        // Compare on normalised DIDs (see `normalizeAgentDid`): EVM
        // address suffixes are lowered (case-insensitive on-wire), peer-ID
        // suffixes pass through (case-sensitive base58). The cgId-derived
        // owner DID (`deriveCuratorDidFromCgId`) preserves whatever case
        // the cgId shipped with, while the locally-stored agent address
        // is typically `ethers.getAddress`'d to checksummed form — both
        // collapse to the same string here.
        const ownerNorm = normalizeAgentDid(owner);
        const selfDid = `did:dkg:agent:${this.peerId}`;
        const selfAgentDid = this.defaultAgentAddress
          ? normalizeAgentDid(`did:dkg:agent:${this.defaultAgentAddress}`)
          : null;
        const isCurator = ownerNorm === selfDid ||
          (selfAgentDid !== null && ownerNorm === selfAgentDid) ||
          [...this.localAgents.keys()].some((addr) => ownerNorm === normalizeAgentDid(`did:dkg:agent:${addr}`));
        if (!isCurator) {
          this.log.warn(
            requestCtx,
            `PROTOCOL_JOIN_REQUEST from ${peerTag} for "${contextGraphId}": rejected — not curator (owner=${owner})`,
          );
          return new TextEncoder().encode(JSON.stringify({ ok: false, error: 'not curator' }));
        }
        this.log.info(
          requestCtx,
          `PROTOCOL_JOIN_REQUEST from ${peerTag} for "${contextGraphId}": accepted, verifying delegation for ${delegation.agentAddress}`,
        );
        this.verifyJoinRequest(contextGraphId, delegation);

        // Remember which peer actually delivered this request so we can
        // send approval/rejection back to the same peer later, even if
        // the agent registry hasn't indexed them yet.
        const originKey = `${contextGraphId}::${delegation.agentAddress.toLowerCase()}`;
        this.joinRequestOriginPeers.set(originKey, peerId.toString());

        // Already-member short-circuit: if the requester is already in
        // the allowlist (e.g. they were added directly via add-agent,
        // or are re-pasting an old invite), skip the pending-request
        // dance and immediately fire `join-approved` so their UI flips
        // to success without curator action. Safe to disclose because
        // `verifyJoinRequest` already proved the requester owns the
        // private key for `agentAddress` — only the legitimate owner
        // learns "you're already a member".
        const allowed = await this.getContextGraphAllowedAgents(contextGraphId);
        const addrLower = delegation.agentAddress.toLowerCase();
        const alreadyMember = allowed.some((a) => a.toLowerCase() === addrLower);
        if (alreadyMember) {
          this.log.info(
            requestCtx,
            `PROTOCOL_JOIN_REQUEST from ${peerTag} for "${contextGraphId}": already-member short-circuit for ${delegation.agentAddress}`,
          );
          this.notifyJoinApproval(contextGraphId, delegation.agentAddress).catch(() => {});
          return new TextEncoder().encode(JSON.stringify({ ok: true, alreadyMember: true }));
        }

        await this.storePendingJoinRequest(contextGraphId, delegation, agentName);
        // Note: `storePendingJoinRequest` itself now emits JOIN_REQUEST_RECEIVED.
        // No duplicate emit here.
        return new TextEncoder().encode(JSON.stringify({ ok: true }));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Mirror the per-rejection-path warns above. The most common
        // throw-site is `verifyJoinRequest` (signature/scope/expiry
        // failure); without this log the curator silently NACKs and the
        // joiner sees only "no reachable curator".
        this.log.warn(
          createOperationContext('system'),
          `PROTOCOL_JOIN_REQUEST handler error: ${msg}`,
        );
        return new TextEncoder().encode(JSON.stringify({ ok: false, error: msg }));
      }
    });

    // Subscribe to both system context graph GossipSub topics
    for (const systemContextGraph of [SYSTEM_CONTEXT_GRAPHS.AGENTS, SYSTEM_CONTEXT_GRAPHS.ONTOLOGY]) {
      this.subscribeToContextGraph(systemContextGraph);
    }

    // Connect to bootstrap peers
    if (this.config.bootstrapPeers) {
      for (const addr of this.config.bootstrapPeers) {
        try {
          await this.node.libp2p.dial(multiaddr(addr));
        } catch {
          // Bootstrap peer may be unreachable
        }
      }
    }

    // On new peer connection, request sync of system context graphs so we discover
    // agents that published their profiles before we came online.
    // Wait for protocol identification to complete, then only sync with
    // peers that actually support the sync protocol (skips raw relay nodes).
    const handleSyncError = (remotePeer: string, err: unknown): void => {
      const shortPeer = remotePeer.slice(-8);
      const message = err instanceof Error ? err.message : String(err);
      this.log.warn(ctx, `Sync-on-connect failed for ${shortPeer}: ${message}`);
    };

    // Single source of truth for "new or reconnecting peer → trigger
    // catch-up sync": the `connection:open` listener below. It fires
    // both on the first connection to a new peer AND on every
    // subsequent reconnect for that same peer, so it fully subsumes
    // `peer:connect`. Registering both produced a double-queued
    // `trySyncFromPeer` for every new peer (one from each handler),
    // doubling initial catch-up traffic and racing the sync/store
    // path on first-contact peers. Codex tier-4g finding on this line.
    this.node.libp2p.addEventListener('connection:open', (evt) => {
      const remotePeer = evt.detail.remotePeer.toString();
      if (remotePeer === this.node.libp2p.peerId.toString()) return;
      // Opportunistically flush any pending join-approval retries that
      // were waiting for this peer to come back. Fires BEFORE the
      // catch-up cooldown returns so a flaky-relay reconnect that
      // happens twice in quick succession still gets two retry passes,
      // which matches the catch-up handler's own per-connection
      // semantics. Failures inside are swallowed and logged by the
      // helper — the connection:open listener must not throw.
      this.processJoinApprovalRetryQueueOnConnect(remotePeer).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        this.log.warn(ctx, `Opportunistic join-approval retry on connect failed for ${remotePeer}: ${message}`);
      });

      // Symmetric flush for the chat outbox: any messages we tried to
      // send to this peer while they were unreachable get a fresh
      // delivery attempt now that the peer is back. Independent of
      // the join-approval flush above (different queue, different
      // payload shape), but same opportunistic-on-reconnect rationale.
      this.processMessageOutboxOnConnect(remotePeer).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        this.log.warn(ctx, `Opportunistic message-outbox retry on connect failed for ${remotePeer}: ${message}`);
      });

      const now = Date.now();
      const last = this.catchupOnConnectAt.get(remotePeer) ?? 0;
      if (now - last < CATCHUP_ON_CONNECT_COOLDOWN_MS) return;
      this.catchupOnConnectAt.set(remotePeer, now);
      setTimeout(() => {
        this.trySyncFromPeer(remotePeer).catch((err: unknown) => {
          handleSyncError(remotePeer, err);
        });
      }, 3000);
    });

    // Clear the per-peer cooldown timestamp when the last live connection
    // to a peer is torn down. The cooldown's job is to dedupe overlapping
    // `connection:open` bursts (libp2p can fire more than one when
    // multiple transports come up for the same peer within a few hundred
    // ms). Without this close handler, a peer that dropped and
    // reconnected 10–20s later — exactly the flaky-relay case this
    // catch-up hook is meant to repair — would be silently skipped for
    // up to a minute, so catch-up would stall until some other trigger
    // fires. `connection:close` fires per connection, so we only forget
    // the timestamp once no live connection to the peer remains. Codex
    // tier-4i finding at packages/agent/src/dkg-agent.ts:1105.
    //
    // We also drop the peer from `skippedNoSyncPeers` and forget its
    // `lastSuccessfulSyncAt` here. The next `connection:open` will
    // re-trigger sync-on-connect from scratch, so keeping stale entries
    // would only cause memory leaks across long-lived nodes that see
    // many transient peers. Note: a brief disconnect+reconnect of the
    // SAME peer ID still benefits — the new sync-on-connect run will
    // either succeed (and re-stamp `lastSuccessfulSyncAt`) or get
    // re-added to `skippedNoSyncPeers` for the event/reconciler retry.
    this.node.libp2p.addEventListener('connection:close', (evt) => {
      const remotePeer = evt.detail.remotePeer.toString();
      if (remotePeer === this.node.libp2p.peerId.toString()) return;
      const stillConnected = this.node.libp2p
        .getPeers()
        .some((p) => p.toString() === remotePeer);
      if (stillConnected) return;
      this.catchupOnConnectAt.delete(remotePeer);
      this.skippedNoSyncPeers.delete(remotePeer);
      this.lastSuccessfulSyncAt.delete(remotePeer);
    });

    // Event-driven sync-retry: libp2p emits `peer:update` whenever a
    // peer record changes — including (and most importantly) when
    // identify completes and populates the protocol list for the first
    // time. The inbound side of `connection:open` reliably loses this
    // race in practice (the event fires on TCP accept, before identify
    // has been processed), so without this listener a node that mostly
    // accepts inbound dials — typically the relay node 1 in our devnet
    // topology — would never sync from any peer beyond the bootstrap
    // window. See `handlePeerUpdateForSyncRetry` for the dedup logic.
    this.node.libp2p.addEventListener('peer:update', (evt) => {
      const detail = evt.detail as { peer?: { id?: { toString(): string }; protocols?: readonly string[] } };
      const peerIdObj = detail?.peer?.id;
      if (!peerIdObj) return;
      const protocols = detail.peer?.protocols ?? [];
      this.handlePeerUpdateForSyncRetry(peerIdObj.toString(), protocols);
    });

    // Reconnect-on-gossip: when a gossip message arrives from a peer we're
    // not currently connected to, best-effort dial them. This catches the
    // case where two NAT'd edge nodes briefly lose their direct path but
    // gossipsub still routes their messages to each other via the mesh —
    // the arriving message is both proof-of-life *and* a cheap trigger to
    // rebuild the direct link so subsequent sync requests have a path.
    this.eventBus.on(DKGEvent.GOSSIP_MESSAGE, (data) => {
      const from = (data as { from?: string })?.from;
      if (!from || from === 'unknown') return;
      this.maybeDialGossipSender(from).catch(() => {
        // Swallow: reconnect-on-gossip is best-effort; failures are already
        // logged inside the method and we don't want to disrupt gossip
        // delivery if a single peer happens to be unreachable.
      });
    });

    // Sync from peers already connected (e.g. relay dialed during node.start())
    const alreadyConnected = this.node.libp2p.getPeers();
    for (const pid of alreadyConnected) {
      const remotePeer = pid.toString();
      setTimeout(() => {
        this.trySyncFromPeer(remotePeer).catch((err: unknown) => {
          handleSyncError(remotePeer, err);
        });
      }, 3000);
    }

    // Start periodic shared memory cleanup
    const ttl = this.config.sharedMemoryTtlMs ?? DEFAULT_SWM_TTL_MS;
    if (ttl > 0) {
      this.cleanupExpiredSharedMemory().catch(() => {});
      this.swmCleanupTimer = setInterval(() => {
        this.cleanupExpiredSharedMemory().catch(() => {});
      }, SWM_CLEANUP_INTERVAL_MS);
      if (this.swmCleanupTimer.unref) this.swmCleanupTimer.unref();
    }

    // Start the periodic sync reconciler — the safety net for the
    // event-driven `peer:update` retry path. See the constants block at
    // the top of this file (`SYNC_RECONCILER_INTERVAL_MS`,
    // `SYNC_STALENESS_THRESHOLD_MS`) and `reconcileSyncFromConnectedPeers`
    // for the full design rationale.
    this.syncReconcilerTimer = setInterval(() => {
      this.reconcileSyncFromConnectedPeers().catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        this.log.warn(ctx, `Sync reconciler tick failed: ${message}`);
      });
    }, SYNC_RECONCILER_INTERVAL_MS);
    if (this.syncReconcilerTimer.unref) this.syncReconcilerTimer.unref();

    // Periodic tick for the join-approval retry queue. See
    // JOIN_APPROVAL_RETRY_TICK_MS for the rationale (transient transport
    // resets used to silently lose approvals; this is the safety-net
    // retry loop that turns them into eventual successes).
    this.joinApprovalRetryTimer = setInterval(() => {
      this.processJoinApprovalRetryQueueTick().catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        this.log.warn(ctx, `Join-approval retry tick failed: ${message}`);
      });
    }, JOIN_APPROVAL_RETRY_TICK_MS);
    if (this.joinApprovalRetryTimer.unref) this.joinApprovalRetryTimer.unref();

    // Periodic tick for the chat outbox retry queue. See
    // MESSAGE_OUTBOX_TICK_MS for the rationale (silent-drop on
    // transport failure used to lose operator-typed messages from
    // `dkg_send_message`; this is the safety-net retry loop that turns
    // them into eventual successes, complemented by the
    // opportunistic-on-reconnect path in the connection:open listener).
    this.messageOutboxTimer = setInterval(() => {
      this.processMessageOutboxTick().catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        this.log.warn(ctx, `Message-outbox retry tick failed: ${message}`);
      });
    }, MESSAGE_OUTBOX_TICK_MS);
    if (this.messageOutboxTimer.unref) this.messageOutboxTimer.unref();

    // Wire V10 Random Sampling prover. Edge nodes no-op. Core nodes with
    // transient identity/RPC startup failures retry in the background so
    // one flaky `getIdentityId()` call does not disable proving until the
    // next process restart.
    const rsStart = await this.tryStartRandomSamplingProver(ctx, true);
    if (rsStart === 'retryable') {
      this.scheduleRandomSamplingBindRetry(ctx);
    }
  }

  private randomSamplingLogger(ctx: OperationContext) {
    return {
      info: (event: string, fields: Record<string, unknown>) =>
        this.log.info(ctx, `[${event}] ${JSON.stringify(fields)}`),
      warn: (event: string, fields: Record<string, unknown>) =>
        this.log.warn(ctx, `[${event}] ${JSON.stringify(fields)}`),
      error: (event: string, fields: Record<string, unknown>) =>
        this.log.error(ctx, `[${event}] ${JSON.stringify(fields)}`),
    };
  }

  private async tryStartRandomSamplingProver(
    ctx: OperationContext,
    logDisabled: boolean,
  ): Promise<RandomSamplingStartResult> {
    if (!this.started) return 'disabled';
    const rsRole: 'core' | 'edge' = (this.config.nodeRole ?? 'edge') === 'core' ? 'core' : 'edge';
    if (rsRole !== 'core' || this.chain.chainId === 'none') return 'disabled';

    let rsIdentityId = 0n;
    try {
      rsIdentityId = await this.chain.getIdentityId();
    } catch (err) {
      this.log.warn(
        ctx,
        `V10 Random Sampling identity lookup failed; prover bind will retry: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return 'retryable';
    }

    if (rsIdentityId === 0n) {
      if (logDisabled) {
        this.log.info(ctx, `V10 Random Sampling prover not started (identity=0, chain=${this.chain.chainId}); will retry`);
      }
      return 'retryable';
    }
    if (!this.started) return 'disabled';

    try {
      const handle = await bindRandomSampling({
        role: rsRole,
        chain: this.chain,
        store: this.store,
        identityId: rsIdentityId,
        walPath: this.config.randomSamplingWalPath,
        useWorkerThread: this.config.randomSamplingUseWorkerThread ?? true,
        tickIntervalMs: this.config.randomSamplingTickIntervalMs,
        log: this.randomSamplingLogger(ctx),
      });
      if (this.randomSamplingHandle && this.randomSamplingHandle !== handle) {
        try { await this.randomSamplingHandle.stop(); } catch { /* swallow bind replacement cleanup */ }
      }
      this.randomSamplingHandle = handle;
      if (handle.enabled) {
        if (!this.started) {
          try { await handle.stop(); } catch { /* swallow shutdown race cleanup */ }
          return 'disabled';
        }
        handle.start();
        this.clearRandomSamplingBindRetry();
        this.log.info(ctx, `V10 Random Sampling prover started (identityId=${rsIdentityId})`);
        return 'started';
      }
      if (logDisabled) {
        this.log.info(ctx, `V10 Random Sampling prover not started (identity=${rsIdentityId}, chain=${this.chain.chainId})`);
      }
      return 'disabled';
    } catch (err) {
      this.log.warn(ctx, `Failed to bind V10 Random Sampling prover: ${err instanceof Error ? err.message : String(err)}`);
      return 'retryable';
    }
  }

  private scheduleRandomSamplingBindRetry(ctx: OperationContext): void {
    if (this.randomSamplingBindRetryTimer) return;
    this.log.warn(ctx, `V10 Random Sampling prover bind will retry every ${RANDOM_SAMPLING_BIND_RETRY_MS}ms`);
    this.randomSamplingBindRetryTimer = setInterval(() => {
      if (!this.started || this.randomSamplingBindRetryInFlight || this.randomSamplingHandle?.enabled) return;
      this.randomSamplingBindRetryInFlight = true;
      this.tryStartRandomSamplingProver(ctx, false)
        .then((result) => {
          if (result === 'started' || result === 'disabled') {
            this.clearRandomSamplingBindRetry();
          }
        })
        .catch((err: unknown) => {
          this.log.warn(ctx, `V10 Random Sampling prover retry failed: ${err instanceof Error ? err.message : String(err)}`);
        })
        .finally(() => {
          this.randomSamplingBindRetryInFlight = false;
        });
    }, RANDOM_SAMPLING_BIND_RETRY_MS);
    if (this.randomSamplingBindRetryTimer.unref) this.randomSamplingBindRetryTimer.unref();
  }

  private clearRandomSamplingBindRetry(): void {
    if (!this.randomSamplingBindRetryTimer) return;
    clearInterval(this.randomSamplingBindRetryTimer);
    this.randomSamplingBindRetryTimer = null;
  }

  private clearStorageACKRegistrationRetry(): void {
    if (!this.storageACKRegistrationRetryTimer) return;
    clearTimeout(this.storageACKRegistrationRetryTimer);
    this.storageACKRegistrationRetryTimer = null;
  }

  /**
   * Pull all triples for the given context graphs from a remote peer and merge
   * them into our local store. Used on peer:connect for initial catch-up,
   * with a per-peer guard to avoid overlapping sync storms.
   */
  private async trySyncFromPeer(remotePeer: string): Promise<void> {
    if (!this.started) {
      return;
    }
    return runSyncOnConnect({
      remotePeer,
      syncingPeers: this.syncingPeers,
      getPeerProtocols: (peerId) => this.getPeerProtocols(peerId),
      knownCorePeerIds: this.knownCorePeerIds,
      getSyncContextGraphs: () => this.config.syncContextGraphs ?? [],
      syncFromPeer: (peerId, contextGraphIds) => this.syncFromPeer(peerId, contextGraphIds),
      refreshMetaSyncedFlags: (contextGraphIds) => this.refreshMetaSyncedFlags(contextGraphIds),
      discoverContextGraphsFromStore: () => this.discoverContextGraphsFromStore(),
      syncSharedMemoryFromPeer: (peerId, contextGraphIds) => this.syncSharedMemoryFromPeer(peerId, contextGraphIds),
      syncSharedMemoryOnConnect: this.config.syncSharedMemoryOnConnect ?? true,
      logInfo: (ctx, message) => this.log.info(ctx, message),
      onPeerSkippedNoSync: (peerId) => {
        this.skippedNoSyncPeers.add(peerId);
      },
      onPeerSynced: (peerId) => {
        this.lastSuccessfulSyncAt.set(peerId, Date.now());
        this.skippedNoSyncPeers.delete(peerId);
      },
    });
  }

  /**
   * Event-driven retry path for the libp2p identify race that otherwise
   * leaves a peer permanently in `skippedNoSyncPeers`. libp2p emits
   * `peer:update` whenever a peer record changes — most importantly when
   * identify completes and the protocol list gets populated for the
   * first time. If the new list now contains `PROTOCOL_SYNC` and we
   * previously skipped this peer for that exact reason, fire one
   * `trySyncFromPeer` immediately.
   *
   * Pairs with {@link reconcileSyncFromConnectedPeers}: the listener
   * handles the common case in <1s (libp2p delivers identify quickly
   * once it arrives), and the periodic reconciler is the safety net for
   * delivery failures of this event itself.
   */
  private handlePeerUpdateForSyncRetry(peerId: string, protocols: readonly string[]): void {
    if (peerId === this.node.libp2p.peerId.toString()) return;
    if (!this.skippedNoSyncPeers.has(peerId)) return;
    if (!protocols.includes(PROTOCOL_SYNC)) return;
    this.skippedNoSyncPeers.delete(peerId);
    const ctx = createOperationContext('sync');
    const shortPeer = peerId.slice(-8);
    this.log.info(ctx, `Peer ${shortPeer} now advertises sync protocol — retrying sync-on-connect`);
    setTimeout(() => {
      this.trySyncFromPeer(peerId).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        this.log.warn(ctx, `Sync retry after peer:update failed for ${shortPeer}: ${message}`);
      });
    }, 0);
  }

  /**
   * Periodic reconciler for sync-on-connect. Walks every currently
   * connected peer and retries `trySyncFromPeer` for any that either:
   *
   *   - is in {@link skippedNoSyncPeers} and now advertises `PROTOCOL_SYNC`
   *     (covers the case where the `peer:update` listener missed the
   *     event for whatever reason), or
   *   - has no `lastSuccessfulSyncAt` entry, or whose entry is older
   *     than {@link SYNC_STALENESS_THRESHOLD_MS} (covers slow identify,
   *     transport-level reconnects that didn't fire connection:open,
   *     and any future failure mode of the event-driven path).
   *
   * Designed to be safe to call concurrently with the event-driven path
   * — `runSyncOnConnect` itself is idempotent via `syncingPeers`.
   */
  private async reconcileSyncFromConnectedPeers(): Promise<void> {
    if (!this.started) return;
    const now = Date.now();
    const ctx = createOperationContext('sync');
    for (const pid of this.node.libp2p.getPeers()) {
      const peerId = pid.toString();
      if (this.syncingPeers.has(peerId)) continue;
      const lastOk = this.lastSuccessfulSyncAt.get(peerId);
      const stale = lastOk == null || (now - lastOk) >= SYNC_STALENESS_THRESHOLD_MS;
      if (!stale) continue;
      const shortPeer = peerId.slice(-8);
      this.log.info(ctx, `Sync reconciler retrying ${shortPeer} (last success: ${lastOk == null ? 'never' : `${Math.round((now - lastOk) / 1000)}s ago`})`);
      this.trySyncFromPeer(peerId).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        this.log.warn(ctx, `Sync reconciler retry failed for ${shortPeer}: ${message}`);
      });
    }
  }

  /**
   * Reconnect-on-gossip: ensure we have a live libp2p path to the sender of
   * a gossip message we just received. GossipSub delivers messages signed by
   * their original publisher, so `from` is the author regardless of how many
   * mesh hops the message took to reach us — making it a reliable signal
   * that the author is online *right now*.
   *
   * Why: two edge nodes behind NAT can briefly lose their direct circuit
   * without either side noticing until the next publish fails. By reacting
   * to incoming gossip with an opportunistic dial, we restore the path long
   * before the application-layer sync protocol is invoked.
   *
   * Best-effort only: for each configured relay that we are already connected
   * to, construct an explicit `/p2p-circuit` multiaddr and dial. Failures are
   * logged but never surface to the caller.
   */
  private async maybeDialGossipSender(peerIdStr: string): Promise<void> {
    const selfPeerId = this.node.libp2p.peerId.toString();
    if (peerIdStr === selfPeerId) return;

    // Already connected → nothing to do.
    const connected = this.node.libp2p.getPeers().some(p => p.toString() === peerIdStr);
    if (connected) return;

    // Cooldown: a single chatty CG can produce many gossip messages/second.
    // One dial-attempt per peer per GOSSIP_DIAL_COOLDOWN_MS is enough.
    const now = Date.now();
    const last = this.gossipDialAttemptedAt.get(peerIdStr) ?? 0;
    if (now - last < GOSSIP_DIAL_COOLDOWN_MS) return;
    this.gossipDialAttemptedAt.set(peerIdStr, now);

    const ctx = createOperationContext('connect');
    const shortPeer = peerIdStr.slice(-8);

    const { peerIdFromString } = await import('@libp2p/peer-id');
    try {
      peerIdFromString(peerIdStr);
    } catch (err) {
      this.log.warn(ctx, `Skipping gossip redial for invalid peer id ${shortPeer}: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    const relays = this.config.relayPeers ?? [];
    const connectedPeers = new Set(this.node.libp2p.getPeers().map(p => p.toString()));
    let skippedRelays = 0;

    for (const relayAddr of relays) {
      const relayPeerId = relayAddr.match(/\/p2p\/([^/]+)/)?.[1];
      if (relayPeerId == null || !connectedPeers.has(relayPeerId)) {
        skippedRelays++;
        continue;
      }

      const circuitAddr = `${relayAddr}/p2p-circuit/p2p/${peerIdStr}`;
      try {
        await this.node.libp2p.dial(
          multiaddr(circuitAddr),
          { signal: AbortSignal.timeout(GOSSIP_DIAL_TIMEOUT_MS) },
        );
        this.log.info(ctx, `Reconnect-on-gossip: dialed ${shortPeer} via ${relayAddr.slice(-16)}`);
        return;
      } catch {
        // Try next relay. We don't log per-relay failures at INFO to avoid
        // log spam when a peer simply has no reservation anywhere right now.
      }
    }

    this.log.info(ctx, `Reconnect-on-gossip: no path to ${shortPeer} via ${relays.length - skippedRelays}/${relays.length} connected relay(s); will retry after cooldown`);
  }

  /**
   * Pull triples for the given context graphs from a remote peer in pages,
   * verify merkle roots against the KC metadata, and only insert
   * triples that pass verification.
   *
   * Meta and data are fetched in separate pagination loops so that neither
   * response can exceed the 10 MB stream read limit.
   */
  async syncFromPeer(
    remotePeerId: string,
    contextGraphIds: string[] = [SYSTEM_CONTEXT_GRAPHS.AGENTS, SYSTEM_CONTEXT_GRAPHS.ONTOLOGY, ...(this.config.syncContextGraphs ?? [])],
    onPhase?: PhaseCallback,
    onAccessDenied?: (contextGraphId: string) => void,
  ): Promise<number> {
    const result = await this.syncFromPeerDetailed(remotePeerId, contextGraphIds, onPhase, onAccessDenied);
    return result.insertedTriples;
  }

  private async syncFromPeerDetailed(
    remotePeerId: string,
    contextGraphIds: string[],
    onPhase?: PhaseCallback,
    onAccessDenied?: (contextGraphId: string) => void,
  ): Promise<DurableSyncResult> {
    const ctx = createOperationContext('sync');
    return runDurableSync({
      ctx,
      remotePeerId,
      contextGraphIds,
      onPhase,
      onAccessDenied,
      createContextGraphSyncDeadline: this.createContextGraphSyncDeadline.bind(this),
      fetchSyncPages: this.fetchSyncPages.bind(this),
      processDurableBatchInWorker: this.processDurableBatchInWorker.bind(this),
      storeInsert: (quads) => this.store.insert(quads),
      deleteCheckpoint: (key) => this.syncCheckpoints.delete(key),
      setCheckpoint: (key, offset) => this.syncCheckpoints.set(key, offset),
      logInfo: (opCtx, message) => this.log.info(opCtx, message),
      logWarn: (opCtx, message) => this.log.warn(opCtx, message),
      logDebug: (opCtx, message) => this.log.debug(opCtx, message),
    });
  }

  /**
   * Paginate through sync pages for a single graph (data or meta).
   * Uses buildSyncRequest to produce authenticated requests for private CGs.
   */
  private async fetchSyncPages(
    ctx: OperationContext,
    remotePeerId: string,
    contextGraphId: string,
    includeSharedMemory: boolean,
    phase: SyncPhase,
    graphUri: string,
    deadline: number,
    snapshotRef?: string,
  ): Promise<SyncPageResult> {
    return fetchSyncPages({
      ctx,
      remotePeerId,
      contextGraphId,
      includeSharedMemory,
      phase,
      graphUri,
      snapshotRef,
      deadline,
      syncPageTimeoutMs: SYNC_PAGE_TIMEOUT_MS,
      syncRouterAttempts: SYNC_ROUTER_ATTEMPTS,
      syncPageRetryAttempts: SYNC_PAGE_RETRY_ATTEMPTS,
      syncPageSize: SYNC_PAGE_SIZE,
      syncDeniedResponse: SYNC_DENIED_RESPONSE,
      // Legacy sentinel that older (pre-v10-rc) responders still emit on ACL
      // denial. Recognising it in the requester is what keeps mixed-version
      // catch-up correct: without the second sentinel, a curated-CG denial
      // from a legacy peer would be parsed as N-quads, yield 0 triples, and
      // silently get misclassified as "nothing to sync" instead of flipping
      // `deniedPhases`. See also dkg-agent.ts's dual-sentinel response path
      // and the `_extraDeniedResponses` option on `fetchSyncPages` (tier-4 G1).
      extraDeniedResponses: [SYNC_ACCESS_DENIED_MARKER],
      debugSyncProgress: DEBUG_SYNC_PROGRESS,
      protocolSync: PROTOCOL_SYNC,
      checkpointStore: this.syncCheckpoints,
      buildSyncRequest: this.buildSyncRequest.bind(this),
      parseAndFilter: (nquadsText, targetGraphUri, targetContextGraphId) => {
        if (phase === 'snapshot') {
          const quads = parseWorkspacePublicSnapshotNQuads(nquadsText, snapshotRef ?? 'unknown');
          return Promise.resolve({ quads, totalQuads: quads.length });
        }
        return this.getOrCreateSyncVerifyWorker().parseAndFilter(nquadsText, targetGraphUri, targetContextGraphId);
      },
      send: (peerId, protocolId, data, sendTimeoutMs) => this.messenger.sendToPeer(peerId, protocolId, data, { timeoutMs: sendTimeoutMs }),
      logWarn: (opCtx, message) => this.log.warn(opCtx, message),
      logInfo: (opCtx, message) => this.log.info(opCtx, message),
      logDebug: (opCtx, message) => this.log.debug(opCtx, message),
    });
  }

  /**
   * Pull shared memory triples for the given context graphs from a remote peer.
   * SWM data is not merkle-verified (no chain finality) — it is
   * accepted as-is and merged into the local shared memory + SWM meta graphs.
   * The workspaceOwnedEntities set is updated so Rule 4 stays consistent.
   */
  async syncSharedMemoryFromPeer(
    remotePeerId: string,
    contextGraphIds: string[] = [...(this.config.syncContextGraphs ?? [])],
  ): Promise<number> {
    const result = await this.syncSharedMemoryFromPeerDetailed(remotePeerId, contextGraphIds);
    return result.insertedTriples;
  }

  private async syncSharedMemoryFromPeerDetailed(
    remotePeerId: string,
    contextGraphIds: string[],
  ): Promise<SharedMemorySyncResult> {
    const ctx = createOperationContext('sync');
    const allowedContextGraphIds: string[] = [];
    for (const contextGraphId of contextGraphIds) {
      if (await this.canUseSharedMemoryForContextGraph(contextGraphId)) {
        allowedContextGraphIds.push(contextGraphId);
      } else {
        this.log.warn(ctx, `Skipping SWM sync for unauthorized or unconfirmed context graph "${contextGraphId}"`);
      }
    }
    if (allowedContextGraphIds.length === 0) {
      return {
        insertedTriples: 0,
        fetchedMetaTriples: 0,
        fetchedDataTriples: 0,
        insertedMetaTriples: 0,
        insertedDataTriples: 0,
        bytesReceived: 0,
        resumedPhases: 0,
        emptyResponses: 0,
        droppedDataTriples: 0,
        failedPeers: 0,
        deniedPhases: 0,
      };
    }
    return runSharedMemorySync({
      ctx,
      remotePeerId,
      contextGraphIds: allowedContextGraphIds,
      createContextGraphSyncDeadline: this.createContextGraphSyncDeadline.bind(this),
      fetchSyncPages: this.fetchSyncPages.bind(this),
      processSharedMemoryBatch: (wsDataQuads, wsMetaQuads) => this.getOrCreateSyncVerifyWorker().processSharedMemoryBatch(wsDataQuads, wsMetaQuads),
      ensureContextGraph: async (contextGraphId) => {
        const graphManager = new GraphManager(this.store);
        await graphManager.ensureContextGraph(contextGraphId);
      },
      storeInsert: (quads) => this.store.insert(quads),
      publicSnapshotStore: this.publicSnapshotStore,
      deleteCheckpoint: (key) => this.syncCheckpoints.delete(key),
      setCheckpoint: (key, offset) => this.syncCheckpoints.set(key, offset),
      ensureOwnedMap: (contextGraphId) => {
        if (!this.workspaceOwnedEntities.has(contextGraphId)) {
          this.workspaceOwnedEntities.set(contextGraphId, new Map());
        }
        return this.workspaceOwnedEntities.get(contextGraphId)!;
      },
      logInfo: (opCtx, message) => this.log.info(opCtx, message),
      logWarn: (opCtx, message) => this.log.warn(opCtx, message),
      logDebug: (opCtx, message) => this.log.debug(opCtx, message),
    });
  }

  private createContextGraphSyncDeadline(remainingContextGraphs: number): number {
    const divisor = Math.max(1, remainingContextGraphs);
    const budgetMs = Math.max(SYNC_MIN_GRAPH_BUDGET_MS, Math.floor(SYNC_TOTAL_TIMEOUT_MS / divisor));
    return Date.now() + budgetMs;
  }

  /**
   * Catch up a single context graph from currently connected peers that advertise
   * the sync protocol. Useful after runtime subscribe so historical data is
   * backfilled immediately (not only future gossip messages).
   */
  async syncContextGraphFromConnectedPeers(
    contextGraphId: string,
    options?: { includeSharedMemory?: boolean },
  ): Promise<{
    connectedPeers: number;
    syncCapablePeers: number;
    peersTried: number;
    /**
     * Subset of `peersTried` whose sync round finished without a transport
     * failure AND without an explicit ACL denial. Used by the daemon
     * subscribe job to distinguish a real "curator unreachable" outcome
     * (`peersTried > 0 && peersSucceeded === 0 && !denied`) from a slow
     * public CG (some peers responded with empty / meta-only) — the UI
     * surfaces a dedicated `unreachable` terminal status with a "send
     * signed join request" CTA instead of the generic timeout copy.
     */
    peersSucceeded: number;
    dataSynced: number;
    sharedMemorySynced: number;
    /**
     * `true` iff at least one peer in this run explicitly denied the sync
     * by emitting a denial sentinel (`syncDenied` marker raised from
     * `sync/requester/page-fetch.ts`, rolled up via `deniedPhases`). Kept
     * as a boolean instead of v10-rc-style `accessDeniedPeers: number`
     * because the daemon catchup-status endpoint only ever cared about
     * "any peer denied us?"; see `cli/src/daemon.ts` subscribe job.
     * Replaces the pre-refactor per-peer `accessDeniedPeers` counter.
     */
    denied: boolean;
    diagnostics: CatchupSyncDiagnostics;
  }> {
    const ctx = createOperationContext('sync');
    const includeSharedMemory = options?.includeSharedMemory ?? false;
    const isPrivateContextGraph = await this.isPrivateContextGraph(contextGraphId);

    this.trackSyncContextGraph(contextGraphId);

    const preferredPeerId = await this.resolvePreferredSyncPeerId(contextGraphId);
    if (preferredPeerId) {
      await this.ensurePeerConnected(preferredPeerId);
    }

    await this.primeCatchupConnections();

    const peers = this.selectCatchupPeers(
      [...new Map(
        this.node.libp2p.getConnections().map((conn) => [conn.remotePeer.toString(), conn.remotePeer]),
      ).values()],
      preferredPeerId,
      isPrivateContextGraph,
    );
    return this.runCatchupOverPeers(contextGraphId, includeSharedMemory, peers);
  }

  private async runCatchupOverPeers(
    contextGraphId: string,
    includeSharedMemory: boolean,
    peers: Array<{ toString(): string }>,
  ): Promise<{
    connectedPeers: number;
    syncCapablePeers: number;
    peersTried: number;
    peersSucceeded: number;
    dataSynced: number;
    sharedMemorySynced: number;
    denied: boolean;
    diagnostics: CatchupSyncDiagnostics;
  }> {
    const ctx = createOperationContext('sync');
    let syncCapablePeers = 0;
    let peersTried = 0;
    let dataSynced = 0;
    let sharedMemorySynced = 0;
    let noProtocolPeers = 0;
    const diagnostics: CatchupSyncDiagnostics = {
      noProtocolPeers: 0,
      durable: {
        fetchedMetaTriples: 0,
        fetchedDataTriples: 0,
        insertedMetaTriples: 0,
        insertedDataTriples: 0,
        bytesReceived: 0,
        resumedPhases: 0,
        emptyResponses: 0,
        metaOnlyResponses: 0,
        dataRejectedMissingMeta: 0,
        rejectedKcs: 0,
        failedPeers: 0,
      },
      sharedMemory: {
        fetchedMetaTriples: 0,
        fetchedDataTriples: 0,
        insertedMetaTriples: 0,
        insertedDataTriples: 0,
        bytesReceived: 0,
        resumedPhases: 0,
        emptyResponses: 0,
        droppedDataTriples: 0,
        failedPeers: 0,
      },
    };

    if (DEBUG_SYNC_PROGRESS) {
      this.log.info(
        ctx,
        `Catch-up peer set for "${contextGraphId}": ${peers.map((peer) => peer.toString()).join(', ') || 'none'}`,
      );
    }

    // Phase 1: probe all peers for PROTOCOL_SYNC support serially. This is
    // cheap (peerStore lookup / waitForPeerProtocol), but we keep it a
    // separate pass so Phase 2's Promise.all only kicks off peers we know
    // can serve us — parallel-probing would multiply connection churn for
    // no gain. See the "Run per-peer syncs in parallel" comment below.
    const syncCapable: string[] = [];
    for (const pid of peers) {
      if (DEBUG_SYNC_PROGRESS) {
        this.log.info(ctx, `Checking sync protocol for peer ${pid.toString()} in catch-up for "${contextGraphId}"`);
      }
      const hasSync = await this.waitForSyncProtocol(pid);
      if (!hasSync) {
        noProtocolPeers++;
        if (DEBUG_SYNC_PROGRESS) {
          this.log.warn(ctx, `Peer ${pid.toString()} is connected but not sync-capable for "${contextGraphId}"`);
        }
        continue;
      }
      syncCapable.push(pid.toString());
    }
    syncCapablePeers = syncCapable.length;
    peersTried = syncCapable.length;

    // Run per-peer syncs in parallel. Without parallelism a curated CG
    // denial walks the whole peer set sequentially with 30s+ timeouts
    // each, causing the /api/subscribe catchup job to take minutes to
    // report denial and the UI to give up. We feed per-peer results into
    // v10-rc's new diagnostics shape (bytesReceived / resumedPhases /
    // deniedPhases, from `runDurableSync`), then translate `deniedPhases`
    // into HEAD's `accessDeniedPeers` counter so the existing daemon
    // catchup-status endpoint and UI keep working — see
    // `cli/src/daemon.ts` subscribe job and `catchup-runner.ts`.
    const emptyDurable = (): DurableSyncResult => ({
      insertedTriples: 0,
      fetchedMetaTriples: 0,
      fetchedDataTriples: 0,
      insertedMetaTriples: 0,
      insertedDataTriples: 0,
      bytesReceived: 0,
      resumedPhases: 0,
      emptyResponses: 0,
      metaOnlyResponses: 0,
      dataRejectedMissingMeta: 0,
      rejectedKcs: 0,
      failedPeers: 1,
      deniedPhases: 0,
    });
    const emptyShared = (): SharedMemorySyncResult => ({
      insertedTriples: 0,
      fetchedMetaTriples: 0,
      fetchedDataTriples: 0,
      insertedMetaTriples: 0,
      insertedDataTriples: 0,
      bytesReceived: 0,
      resumedPhases: 0,
      emptyResponses: 0,
      droppedDataTriples: 0,
      failedPeers: 1,
      deniedPhases: 0,
    });
    const results = await Promise.all(syncCapable.map(async (remotePeerId) => {
      const durable = await this.syncFromPeerDetailed(
        remotePeerId,
        [contextGraphId],
      ).catch(emptyDurable);
      const shared = includeSharedMemory
        ? await this.syncSharedMemoryFromPeerDetailed(remotePeerId, [contextGraphId]).catch(emptyShared)
        : null;
      return { durable, shared };
    }));
    let accessDeniedPeers = 0;
    let peersSucceeded = 0;
    for (const r of results) {
      // A peer "succeeded" when its sync round finished without a
      // transport failure AND without an explicit denial. We treat the
      // emergency `failedPeers: 1` produced by `emptyDurable()` /
      // `emptyShared()` (set when `syncFromPeerDetailed` rejected) as
      // the failure marker — anything else (data, meta-only, empty
      // response) counts as a legitimate response from a host that
      // happens to hold no/incomplete data for this CG.
      const durableFailed = r.durable.failedPeers > 0;
      const sharedFailed = r.shared ? r.shared.failedPeers > 0 : false;
      const peerDeniedRound = r.durable.deniedPhases > 0
        || (r.shared ? r.shared.deniedPhases > 0 : false);
      if (!durableFailed && !sharedFailed && !peerDeniedRound) {
        peersSucceeded++;
      }
      dataSynced += r.durable.insertedTriples;
      diagnostics.durable.fetchedMetaTriples += r.durable.fetchedMetaTriples;
      diagnostics.durable.fetchedDataTriples += r.durable.fetchedDataTriples;
      diagnostics.durable.insertedMetaTriples += r.durable.insertedMetaTriples;
      diagnostics.durable.insertedDataTriples += r.durable.insertedDataTriples;
      diagnostics.durable.bytesReceived += r.durable.bytesReceived;
      diagnostics.durable.resumedPhases += r.durable.resumedPhases;
      diagnostics.durable.emptyResponses += r.durable.emptyResponses;
      diagnostics.durable.metaOnlyResponses += r.durable.metaOnlyResponses;
      diagnostics.durable.dataRejectedMissingMeta += r.durable.dataRejectedMissingMeta;
      diagnostics.durable.rejectedKcs += r.durable.rejectedKcs;
      diagnostics.durable.failedPeers += r.durable.failedPeers;
      let peerDenied = r.durable.deniedPhases > 0;
      if (r.shared) {
        sharedMemorySynced += r.shared.insertedTriples;
        diagnostics.sharedMemory.fetchedMetaTriples += r.shared.fetchedMetaTriples;
        diagnostics.sharedMemory.fetchedDataTriples += r.shared.fetchedDataTriples;
        diagnostics.sharedMemory.insertedMetaTriples += r.shared.insertedMetaTriples;
        diagnostics.sharedMemory.insertedDataTriples += r.shared.insertedDataTriples;
        diagnostics.sharedMemory.bytesReceived += r.shared.bytesReceived;
        diagnostics.sharedMemory.resumedPhases += r.shared.resumedPhases;
        diagnostics.sharedMemory.emptyResponses += r.shared.emptyResponses;
        diagnostics.sharedMemory.droppedDataTriples += r.shared.droppedDataTriples;
        diagnostics.sharedMemory.failedPeers += r.shared.failedPeers;
        peerDenied = peerDenied || r.shared.deniedPhases > 0;
      }
      if (peerDenied) accessDeniedPeers++;
    }
    diagnostics.noProtocolPeers = noProtocolPeers;

    this.log.info(
      ctx,
      `Catch-up sync for "${contextGraphId}": peers=${peersTried}/${syncCapablePeers} data=${dataSynced} sharedMemory=${sharedMemorySynced} denied=${accessDeniedPeers}`,
    );

    await this.refreshMetaSyncedFlags([contextGraphId]);

    if (dataSynced > 0 || sharedMemorySynced > 0) {
      this.eventBus.emit(DKGEvent.PROJECT_SYNCED, {
        contextGraphId,
        dataSynced,
        sharedMemorySynced,
      });
    }

    return {
      connectedPeers: peers.length,
      syncCapablePeers,
      peersTried,
      peersSucceeded,
      dataSynced,
      sharedMemorySynced,
      denied: accessDeniedPeers > 0,
      diagnostics,
    };
  }

  private async primeCatchupConnections(): Promise<void> {
    await primeCatchupConnectionsAtom(this.node.libp2p as any, this.discovery, this.peerId);
  }

  /**
   * Pull `_meta` (and SWM) for a CG immediately after receiving a curator
   * `join-approved` notification, targeting the curator peer directly.
   *
   * Fixes the ~107s window where a freshly-approved curated CG sat
   * unsynced because the previous post-approval call
   * (`syncContextGraphFromConnectedPeers(...).catch(() => {})`):
   *
   *   1. Swallowed every failure mode — including the case where the
   *      regular peer-ranking heuristics produced zero sync attempts
   *      because no other peer announced the CG yet (the freshly-
   *      approved-but-no-meta-yet window). The next sync attempt only
   *      came from the periodic catchup reconciler ~2 min later.
   *
   *   2. Re-walked the full `selectCatchupPeers` ranking even though
   *      we already knew exactly who to ask: the curator peer that
   *      just sent us the approval. Skipping that walk gets us to a
   *      sync attempt within ~1s of approval.
   *
   * Falls back to the standard broadcast catchup if the curator-direct
   * attempt yields zero successful peers — defensive for the case
   * where the inbound notification connection was a one-shot relay
   * that won't re-open for catchup, or the curator process happened
   * to die between sending the approval and the catchup dial.
   */
  private async runImmediatePostApprovalSync(
    contextGraphId: string,
    curatorPeerId: string,
  ): Promise<void> {
    const ctx = createOperationContext('sync');
    const curatorShort = curatorPeerId.slice(-8);
    let curatorTargetSucceeded = false;

    // Curator-direct attempt. Any throw here (relay reservation gone,
    // dial timeout, AbortSignal, transient `Remote closed connection
    // during opening`) MUST fall through to the broadcast fallback
    // below — wrapping both the curator-direct attempt AND the
    // broadcast in a single try/catch reintroduces the silent-stall
    // bug this method exists to fix (Lex review on PR #517 + Codex).
    try {
      await this.ensurePeerConnected(curatorPeerId);
      const curatorRemote = this.node.libp2p
        .getConnections()
        .find((conn) => conn.remotePeer.toString() === curatorPeerId)?.remotePeer;
      if (curatorRemote) {
        const result = await this.runCatchupOverPeers(contextGraphId, true, [curatorRemote]);
        if (result.peersSucceeded > 0) {
          this.log.info(
            ctx,
            `Post-approval sync for "${contextGraphId}" from curator ${curatorShort} fetched ${result.dataSynced} data + ${result.sharedMemorySynced} SWM triples`,
          );
          curatorTargetSucceeded = true;
        } else {
          this.log.warn(
            ctx,
            `Post-approval sync for "${contextGraphId}" from curator ${curatorShort} produced no successful peer (denied=${result.denied}); falling back to broadcast catchup`,
          );
        }
      } else {
        this.log.warn(
          ctx,
          `Post-approval sync for "${contextGraphId}": curator ${curatorShort} not in connected peers after ensurePeerConnected; falling back to broadcast catchup`,
        );
      }
    } catch (err) {
      this.log.warn(
        ctx,
        `Post-approval sync for "${contextGraphId}": curator-direct attempt to ${curatorShort} failed (${err instanceof Error ? err.message : String(err)}); falling back to broadcast catchup`,
      );
    }

    if (!curatorTargetSucceeded) {
      try {
        await this.syncContextGraphFromConnectedPeers(contextGraphId, { includeSharedMemory: true });
      } catch (err) {
        this.log.warn(
          ctx,
          `Post-approval broadcast fallback for "${contextGraphId}" failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  private selectCatchupPeers(
    peers: Array<{ toString(): string }>,
    preferredPeerId?: string,
    privateOnly = false,
  ): Array<{ toString(): string }> {
    return orderCatchupPeers(peers, preferredPeerId, privateOnly);
  }

  private async resolvePreferredSyncPeerId(contextGraphId: string): Promise<string | undefined> {
    const preferredPeerId = this.preferredSyncPeers.get(contextGraphId);
    if (preferredPeerId) return preferredPeerId;

    const curatorPeerId = await this.resolveCuratorPeerId(contextGraphId);
    if (curatorPeerId) {
      this.preferredSyncPeers.set(contextGraphId, curatorPeerId);
    }
    return curatorPeerId;
  }

  private async ensurePeerConnected(peerId: string): Promise<void> {
    await ensurePeerConnectedAtom(this.node.libp2p as any, this.discovery, peerId);
  }

  private async waitForSyncProtocol(pid: { toString(): string }): Promise<boolean> {
    return waitForPeerProtocol(
      this.node.libp2p.peerStore as any,
      pid,
      PROTOCOL_SYNC,
      SYNC_PROTOCOL_CHECK_ATTEMPTS,
      SYNC_PROTOCOL_CHECK_DELAY_MS,
    );
  }

  private async refreshMetaSyncedFlags(contextGraphIds: Iterable<string>): Promise<void> {
    for (const contextGraphId of contextGraphIds) {
      const sub = this.subscribedContextGraphs.get(contextGraphId);
      if (!sub) continue;
      if (await this.hasConfirmedMetaState(contextGraphId)) {
        if (sub.metaSynced !== true) {
          sub.metaSynced = true;
          this.persistContextGraphSubscription(contextGraphId);
        }
        if (sub.pendingMeta) {
          // Meta arrived; the freshly-joined "waiting for sync" state
          // (set by the join-approved handler) no longer applies — the
          // CG will now surface via the normal `_meta` branch in
          // `listContextGraphs`.
          sub.pendingMeta = false;
        }
        this.queueSharedMemoryGossipSubscription(contextGraphId);
      }
    }
  }

  private setContextGraphSubscription(
    contextGraphId: string,
    next: ContextGraphSub,
    options?: { persist?: boolean },
  ): ContextGraphSub {
    this.subscribedContextGraphs.set(contextGraphId, next);
    if (options?.persist !== false) {
      this.persistContextGraphSubscription(contextGraphId);
      if (next.subscribed) {
        this.persistLocalNodeMembership(contextGraphId);
      } else {
        this.deleteContextGraphMember(contextGraphId, 'node', this.peerId);
      }
    }
    return next;
  }

  markContextGraphSubscriptionState(contextGraphId: string, patch: Partial<ContextGraphSub>): void {
    const existing = this.subscribedContextGraphs.get(contextGraphId);
    if (!existing) return;
    this.setContextGraphSubscription(contextGraphId, { ...existing, ...patch });
  }

  persistContextGraphSubscriptionState(contextGraphId: string): void {
    this.persistContextGraphSubscription(contextGraphId);
  }

  private persistContextGraphSubscription(contextGraphId: string): void {
    const store = this.config.contextGraphSubscriptionStore;
    if (!store) return;
    const sub = this.subscribedContextGraphs.get(contextGraphId);
    if (!sub?.subscribed) {
      void store.delete(contextGraphId).catch((err) => {
        this.log.warn(
          createOperationContext('system'),
          `Failed to delete persisted context-graph subscription for "${contextGraphId}": ${err instanceof Error ? err.message : String(err)}`,
        );
      });
      return;
    }
    void store.save({
      id: contextGraphId,
      name: sub.name,
      subscribed: sub.subscribed,
      synced: sub.synced,
      sharedMemorySynced: sub.sharedMemorySynced,
      metaSynced: sub.metaSynced,
      onChainId: sub.onChainId,
      syncScoped: (this.config.syncContextGraphs ?? []).includes(contextGraphId),
    }).catch((err) => {
      this.log.warn(
        createOperationContext('system'),
        `Failed to persist context-graph subscription for "${contextGraphId}": ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  private normalizeMembershipPrincipal(
    principalType: ContextGraphMemberPrincipalType,
    principalId: string,
  ): string {
    if (principalType === 'agent' && ethers.isAddress(principalId)) {
      return ethers.getAddress(principalId);
    }
    return principalId;
  }

  private upsertContextGraphMember(record: ContextGraphMembershipRecord): void {
    const store = this.config.contextGraphMembershipStore;
    if (!store) return;
    const normalizedRecord = {
      ...record,
      principalId: this.normalizeMembershipPrincipal(record.principalType, record.principalId),
    };
    const updatedAt = Date.now();
    void store.upsert({ ...normalizedRecord, updatedAt }).catch((err) => {
      this.log.warn(
        createOperationContext('system'),
        `Failed to persist context-graph membership for "${normalizedRecord.contextGraphId}" (${normalizedRecord.principalType}:${normalizedRecord.principalId}): ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  private deleteContextGraphMember(
    contextGraphId: string,
    principalType: ContextGraphMemberPrincipalType,
    principalId: string,
  ): void {
    const store = this.config.contextGraphMembershipStore;
    if (!store) return;
    const normalizedPrincipalId = this.normalizeMembershipPrincipal(principalType, principalId);
    void store.delete(contextGraphId, principalType, normalizedPrincipalId).catch((err) => {
      this.log.warn(
        createOperationContext('system'),
        `Failed to delete context-graph membership for "${contextGraphId}" (${principalType}:${normalizedPrincipalId}): ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  private persistLocalNodeMembership(contextGraphId: string, source = 'subscription'): void {
    const sub = this.subscribedContextGraphs.get(contextGraphId);
    this.upsertContextGraphMember({
      contextGraphId,
      principalType: 'node',
      principalId: this.peerId,
      role: 'subscriber',
      status: 'active',
      source,
      displayName: this.nodeName,
      metadata: {
        subscribed: sub?.subscribed ?? false,
        synced: sub?.synced ?? false,
        sharedMemorySynced: sub?.sharedMemorySynced ?? false,
        metaSynced: sub?.metaSynced ?? false,
        ...(sub?.onChainId ? { onChainId: sub.onChainId } : {}),
      },
    });
  }

  private async rehydrateContextGraphSubscriptions(): Promise<void> {
    const store = this.config.contextGraphSubscriptionStore;
    if (!store) return;
    const ctx = createOperationContext('init');
    try {
      const rows = await store.loadAll();
      for (const row of rows) {
        this.setContextGraphSubscription(row.id, {
          name: row.name,
          subscribed: row.subscribed,
          synced: row.synced,
          sharedMemorySynced: row.sharedMemorySynced,
          metaSynced: row.metaSynced,
          onChainId: row.onChainId,
        }, { persist: false });
      }
      for (const row of rows) {
        if (row.syncScoped) {
          this.trackSyncContextGraph(row.id);
        }
        if (row.subscribed) {
          this.subscribeToContextGraph(row.id, { trackSyncScope: false, persist: false });
          this.persistLocalNodeMembership(row.id, 'rehydrated-subscription');
        }
      }
      if (rows.length > 0) {
        this.log.info(ctx, `Rehydrated ${rows.length} persisted context-graph subscription(s)`);
      }
    } catch (err) {
      this.log.warn(ctx, `Failed to rehydrate persisted context-graph subscriptions: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async hasConfirmedMetaState(contextGraphId: string): Promise<boolean> {
    if ((Object.values(SYSTEM_CONTEXT_GRAPHS) as string[]).includes(contextGraphId)) {
      return true;
    }

    const metaGraph = contextGraphMetaGraphUri(contextGraphId);
    const metaResult = await this.store.query(
      `ASK WHERE { GRAPH <${metaGraph}> { ?s ?p ?o } }`,
    );
    if (metaResult.type === 'boolean' && metaResult.value === true) {
      return true;
    }

    // Ontology-only fallback: a CG declared `rdf:type dkg:ContextGraph` can be
    // treated as confirmably-public for the gossip race-opener ONLY when
    // no local evidence of a restriction exists. Raw contextGraph declaration
    // is not enough on its own — `inviteToContextGraph` writes
    // `dkg:allowedPeer` straight to `_meta` without updating ontology, so
    // a CG that was announced publicly and later allowlisted would look
    // "just a contextGraph" here even though the curator expects the allowlist
    // to gate gossip. Require `isPrivateContextGraph()` (now also reads
    // `DKG_ALLOWED_PEER`) to explicitly return false before honoring the
    // bypass.
    if (await this.isPrivateContextGraph(contextGraphId)) {
      return false;
    }

    const ontologyGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
    const contextGraphUri = contextGraphDataGraphUri(contextGraphId);
    const ontologyResult = await this.store.query(
      `ASK WHERE {
        GRAPH <${ontologyGraph}> {
          <${contextGraphUri}> <${DKG_ONTOLOGY.RDF_TYPE}> <${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}> .
        }
      }`,
    );
    return ontologyResult.type === 'boolean' && ontologyResult.value === true;
  }

  private async hasConfirmedSharedMemoryMetaState(contextGraphId: string): Promise<boolean> {
    return this.hasConfirmedMetaState(contextGraphId);
  }

  private async canUseSharedMemoryForContextGraph(
    contextGraphId: string,
    opts: { callerAgentAddress?: string } = {},
  ): Promise<boolean> {
    if (!(await this.hasConfirmedSharedMemoryMetaState(contextGraphId))) {
      return false;
    }
    return this.canReadContextGraph(contextGraphId, {
      callerAgentAddress: opts.callerAgentAddress,
      allowSubscriptionFallback: false,
    });
  }

  private async verifySyncedDataInWorker(
    dataQuads: Quad[],
    metaQuads: Quad[],
    ctx: OperationContext,
    acceptUnverified = false,
  ): Promise<{ data: Quad[]; meta: Quad[]; rejected: number }> {
    const worker = this.getOrCreateSyncVerifyWorker();
    const result = await worker.verify(dataQuads, metaQuads, acceptUnverified);
    for (const entry of result.logs) {
      if (entry.level === 'warn') this.log.warn(ctx, entry.message);
      else this.log.debug(ctx, entry.message);
    }
    return { data: result.data, meta: result.meta, rejected: result.rejected };
  }

  private async processDurableBatchInWorker(
    dataQuads: Quad[],
    metaQuads: Quad[],
    ctx: OperationContext,
    acceptUnverified = false,
  ): Promise<import('./sync-verify-worker.js').DurableBatchProcessResult> {
    const worker = this.getOrCreateSyncVerifyWorker();
    const result = await worker.processDurableBatch(dataQuads, metaQuads, acceptUnverified);
    for (const entry of result.logs) {
      if (entry.level === 'warn') this.log.warn(ctx, entry.message);
      else this.log.debug(ctx, entry.message);
    }
    return result;
  }

  private getOrCreateSyncVerifyWorker(): SyncVerifyWorker {
    if (!this.syncVerifyWorker) {
      this.syncVerifyWorker = new SyncVerifyWorker();
    }
    return this.syncVerifyWorker;
  }

  /**
   * Update the shared memory TTL at runtime. Takes effect immediately for queries
   * and the next cleanup cycle without requiring a restart.
   */
  setSharedMemoryTtlMs(ttlMs: number): void {
    const oldTtl = this.config.sharedMemoryTtlMs ?? DEFAULT_SWM_TTL_MS;
    (this.config as any).sharedMemoryTtlMs = ttlMs;

    if (oldTtl <= 0 && ttlMs > 0 && !this.swmCleanupTimer) {
      this.cleanupExpiredSharedMemory().catch(() => {});
      this.swmCleanupTimer = setInterval(() => {
        this.cleanupExpiredSharedMemory().catch(() => {});
      }, SWM_CLEANUP_INTERVAL_MS);
      if (this.swmCleanupTimer.unref) this.swmCleanupTimer.unref();
    } else if (ttlMs <= 0 && this.swmCleanupTimer) {
      clearInterval(this.swmCleanupTimer);
      this.swmCleanupTimer = null;
    }
  }

  /**
   * Remove expired shared memory operations and their data.
   * Queries SWM meta for operations with publishedAt older than the TTL,
   * deletes the corresponding triples from shared memory and SWM meta,
   * and removes the root entities from workspaceOwnedEntities.
   */
  async cleanupExpiredSharedMemory(): Promise<number> {
    const ttl = this.config.sharedMemoryTtlMs ?? DEFAULT_SWM_TTL_MS;
    if (ttl <= 0) return 0;

    const ctx = createOperationContext('share');
    const cutoff = new Date(Date.now() - ttl).toISOString();
    let totalDeleted = 0;

    try {
      const graphManager = new GraphManager(this.store);
      const contextGraphs = await graphManager.listContextGraphs();

      for (const pid of contextGraphs) {
        const wsGraph = contextGraphWorkspaceGraphUri(pid);
        const wsMetaGraph = contextGraphWorkspaceMetaGraphUri(pid);
        let graphDeleted = 0;

        const expiredOps = await this.store.query(
          `SELECT ?op WHERE {
            GRAPH <${wsMetaGraph}> {
              ?op <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://dkg.io/ontology/WorkspaceOperation> .
              ?op <http://dkg.io/ontology/publishedAt> ?ts .
              FILTER(?ts < "${cutoff}"^^<http://www.w3.org/2001/XMLSchema#dateTime>)
            }
          }`,
        );

        if (expiredOps.type !== 'bindings' || expiredOps.bindings.length === 0) continue;

        for (const row of expiredOps.bindings) {
          const opUri = row['op'];
          if (!opUri) continue;

          const rootEntitiesResult = await this.store.query(
            `SELECT ?re WHERE {
              GRAPH <${wsMetaGraph}> {
                <${opUri}> <http://dkg.io/ontology/rootEntity> ?re .
              }
            }`,
          );

          const rootEntities: string[] = [];
          if (rootEntitiesResult.type === 'bindings') {
            for (const r of rootEntitiesResult.bindings) {
              if (r['re']) rootEntities.push(r['re']);
            }
          }

          for (const re of rootEntities) {
            // Exact root only; then skolemized descendants only (prefix would over-delete e.g. urn:foo vs urn:foobar)
            const exactDeleted = await this.store.deleteByPattern({ graph: wsGraph, subject: re });
            graphDeleted += exactDeleted;
            const childPrefix = `${re}/.well-known/genid/`;
            const childDeleted = await this.store.deleteBySubjectPrefix(wsGraph, childPrefix);
            graphDeleted += childDeleted;
          }

          // Exact subject delete for this operation's metadata (prefix would match opUri that are prefixes of others, e.g. ...:ws-123 vs ...:ws-1234)
          const metaDeleted = await this.store.deleteByPattern({ graph: wsMetaGraph, subject: opUri });
          graphDeleted += metaDeleted;

          for (const re of rootEntities) {
            const ownerDeleted = await this.store.deleteByPattern({
              graph: wsMetaGraph, subject: re, predicate: 'http://dkg.io/ontology/workspaceOwner',
            });
            graphDeleted += ownerDeleted;
          }

          const ownedSet = this.workspaceOwnedEntities.get(pid);
          if (ownedSet) {
            for (const re of rootEntities) {
              ownedSet.delete(re);
            }
          }
        }

        totalDeleted += graphDeleted;
        if (expiredOps.bindings.length > 0) {
          this.log.info(ctx, `SWM cleanup for "${pid}": evicted ${expiredOps.bindings.length} expired operation(s), ${graphDeleted} triples`);
        }
      }
    } catch (err) {
      this.log.warn(ctx, `SWM cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    return totalDeleted;
  }

  async publishProfile(): Promise<PublishResult> {
    const pubKeyBase64 = Buffer.from(this.wallet.keypair.publicKey).toString('base64');
    const relayAddrs = this.config.relayPeers;
    const defaultAgent = this.defaultAgentAddress ? this.localAgents.get(this.defaultAgentAddress) : undefined;

    // Populate `contextGraphsServed` so peers can discover which CGs this
    // node hosts via the public agent profile, but ONLY include CGs whose
    // accessPolicy is open AND we are actively serving (subscribed=true).
    //
    // `isPrivateContextGraph` is the same predicate the responder consults
    // to gate sync requests, so the discovery layer and the data-plane
    // access control stay consistent.
    //
    // The `subscribed === true` filter is what Codex review on PR #431
    // (round 3) flagged. `discoverContextGraphsFromStore()` seeds entries
    // for OPEN CGs we merely learned about with `subscribed: false` (we
    // don't auto-subscribe public CGs — explicit user opt-in only). Without
    // this filter, those discovery-only entries would be advertised in
    // `contextGraphsServed`, so other peers would route join attempts to a
    // node that doesn't actually host the CG. The curated/private discovery
    // path immediately calls `subscribeToContextGraph()` (which flips
    // `subscribed: true`) before adding to the gossip mesh, so this filter
    // does not regress invited-curated discovery.
    //
    // System CGs (`agents`, `ontology`) are excluded — they are universal
    // and don't need to be re-advertised in every profile.
    const publicServed: string[] = [];
    for (const [id, sub] of this.subscribedContextGraphs) {
      if (id === SYSTEM_CONTEXT_GRAPHS.AGENTS || id === SYSTEM_CONTEXT_GRAPHS.ONTOLOGY) continue;
      if (!sub.subscribed) continue;
      if (await this.isPrivateContextGraph(id)) continue;
      publicServed.push(id);
    }

    const profileConfig: AgentProfileConfig = {
      peerId: this.node.peerId,
      name: this.config.name,
      description: this.config.description,
      framework: this.config.framework,
      nodeRole: this.config.nodeRole ?? 'edge',
      publicKey: pubKeyBase64,
      relayAddress: relayAddrs?.[0],
      agentAddress: this.defaultAgentAddress,
      encryptionKeyAlgorithm: defaultAgent?.encryptionKeyAlgorithm,
      publicEncryptionKey: defaultAgent?.publicEncryptionKey,
      encryptionKeyProof: defaultAgent?.encryptionKeyProof,
      skills: (this.config.skills ?? []).map(s => ({
        skillType: s.skillType,
        pricePerCall: s.pricePerCall,
        currency: s.currency ?? 'TRAC',
        pricingModel: s.pricePerCall ? 'PerInvocation' as const : 'Free' as const,
      })),
      ...(publicServed.length > 0 ? { contextGraphsServed: publicServed } : {}),
    };

    const profileCtx = createOperationContext('publish');
    this.log.info(profileCtx, `Publishing agent profile`);
    const result = await this.profileManager.publishProfile(profileConfig);
    await this.broadcastPublish(AGENT_REGISTRY_CONTEXT_GRAPH, result, profileCtx);

    return result;
  }

  /**
   * Sync this node's intended `relayCapable` flag onto chain (RFC 04 v0.3
   * / Issue #461 — Network State Registry).
   *
   * Called once at startup. Best-effort: missing chain config, no on-chain
   * profile, or adapters that pre-date the relay-registry surface
   * (`setRelayCapable` undefined) = silent skip. Chain RPC errors are
   * logged but never thrown so the daemon stays up.
   *
   * Idempotent: compares against the current on-chain value and skips the
   * tx when they match. Safe to call on every restart.
   *
   * Multiaddrs are NOT published here — they will be published per-RS-round
   * inside the attestation KC body when `submitProofV2` lands (RFC 04
   * Phase 2). This entry point only manages the on-chain hint flag.
   *
   * Three-way semantics for `opts.relayCapable` (Codex PR #506 fix):
   *   - `true`      → ensure on-chain flag is true (flip if currently false)
   *   - `false`     → ensure on-chain flag is false (flip if currently true)
   *   - `undefined` → leave on-chain alone (operator hasn't expressed an
   *                   opinion in config; respects manual `dkg admin
   *                   set-relay-capable` flips)
   *
   * The previous version treated false-or-absent as a no-op, making the
   * on-chain flag sticky: a node that once ran with `relayCapable: true`
   * would keep advertising relay capability forever even after the
   * operator removed it from config. Now `false` actively clears.
   */
  async publishRelayRegistry(opts?: { relayCapable?: boolean }): Promise<void> {
    const ctx = createOperationContext('publish');
    if (!('setRelayCapable' in this.chain) || typeof this.chain.setRelayCapable !== 'function') {
      this.log.info(ctx, 'publishRelayRegistry: chain adapter does not support relay registry — skipping');
      return;
    }

    let identityId: bigint;
    try {
      identityId = await this.chain.getIdentityId();
    } catch (err) {
      this.log.warn(
        ctx,
        `publishRelayRegistry: getIdentityId failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    if (identityId === 0n) {
      this.log.info(ctx, 'publishRelayRegistry: node has no on-chain profile yet — skipping');
      return;
    }

    // Only act on explicit booleans. Anything else (undefined, non-boolean
    // misconfigurations) is treated as "no opinion" so we don't clobber
    // operator-managed state.
    if (opts?.relayCapable !== true && opts?.relayCapable !== false) {
      return;
    }
    const desired = opts.relayCapable;
    try {
      const current = this.chain.getRelayCapable
        ? await this.chain.getRelayCapable(identityId)
        : false;
      if (current !== desired) {
        await this.chain.setRelayCapable(desired);
        this.log.info(ctx, `publishRelayRegistry: flipped relayCapable=${desired} on chain (was ${current})`);
      }
    } catch (err) {
      this.log.warn(
        ctx,
        `publishRelayRegistry: setRelayCapable failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async findAgents(options?: { framework?: string }): Promise<DiscoveredAgent[]> {
    return this.discovery.findAgents(options);
  }

  async findSkills(options?: SkillSearchOptions): Promise<DiscoveredOffering[]> {
    return this.discovery.findSkillOfferings(options);
  }

  async findAgentByPeerId(peerId: string): Promise<DiscoveredAgent | null> {
    return this.discovery.findAgentByPeerId(peerId);
  }

  // ---------------------------------------------------------------------------
  // Agent Registry — multi-agent identity management
  // ---------------------------------------------------------------------------

  private static readonly AGENT_SYSTEM_GRAPH = 'did:dkg:system/agents';

  /**
   * Register a new agent on this node.
   * - Custodial (publicKey omitted): node generates secp256k1 keypair
   * - Self-sovereign (publicKey provided): agent holds its own key
   */
  async registerAgent(
    name: string,
    opts?: {
      publicKey?: string;
      framework?: string;
      encryptionKeyAlgorithm?: typeof WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519;
      publicEncryptionKey?: string;
      encryptionKeyProof?: string;
    },
  ): Promise<AgentKeyRecord> {
    for (const existing of this.localAgents.values()) {
      if (existing.name === name) {
        throw new Error(`Agent name "${name}" already registered on this node`);
      }
    }
    if (opts?.publicKey && (opts.publicEncryptionKey || opts.encryptionKeyProof) && !(opts.publicEncryptionKey && opts.encryptionKeyProof)) {
      throw new Error('Self-sovereign agents must provide both publicEncryptionKey and encryptionKeyProof');
    }

    const record = opts?.publicKey
      ? registerSelfSovereignAgent(
        name,
        opts.publicKey,
        opts.framework,
        opts.publicEncryptionKey && opts.encryptionKeyProof
          ? {
            encryptionKeyAlgorithm: opts.encryptionKeyAlgorithm ?? WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519,
            publicEncryptionKey: opts.publicEncryptionKey,
            encryptionKeyProof: opts.encryptionKeyProof,
          }
          : undefined,
      )
      : generateCustodialAgent(name, opts?.framework);

    this.localAgents.set(record.agentAddress, record);
    this.agentTokenIndex.set(record.authToken, record.agentAddress);
    await this.persistAgentToStore(record);
    await this.saveToKeystore(record);

    const ctx = createOperationContext('system');
    this.log.info(ctx, `Registered agent "${name}" (${record.mode}) → ${record.agentAddress}`);
    return record;
  }

  /**
   * List all agents registered on this node.
   * Private keys are NOT included in the response.
   */
  listLocalAgents(): Array<Omit<AgentKeyRecord, 'privateKey'>> {
    return [...this.localAgents.values()].map(({ privateKey: _, ...rest }) => rest);
  }

  /**
   * Resolve an agent address from a Bearer token.
   * Returns undefined if the token is not an agent token (could be a node-level token).
   */
  resolveAgentByToken(token: string): string | undefined {
    return this.agentTokenIndex.get(token);
  }

  /**
   * Look up the custodial private key for a registered agent.
   *
   * Returns the hex-encoded private key for `mode === 'custodial'` agents
   * (the daemon generated and persisted the keypair at registration). Returns
   * `undefined` if the agent is unknown to this node, is `'self-sovereign'`
   * (the node never had the key), or does not have a `privateKey` field set
   * for any reason.
   *
   * Used by `publishFromSharedMemory` to resolve a per-publish author signer
   * without exposing the entire `AgentKeyRecord` (which would leak the auth
   * token hash and other off-axis material). Phase 4 / RFC-001 §4(b).
   *
   * @param address Ethereum address of the registered agent.
   */
  getCustodialAgentPrivateKey(address: string): string | undefined {
    const record = this.localAgents.get(address);
    if (!record || record.mode !== 'custodial') return undefined;
    return record.privateKey;
  }

  /**
   * Look up the registration mode for a known local agent.
   * Returns undefined if the agent is unknown to this node.
   */
  getLocalAgentMode(address: string): 'custodial' | 'self-sovereign' | undefined {
    return this.localAgents.get(address)?.mode;
  }

  /**
   * Get the default agent address for this node.
   * Used when requests come in with a node-level token.
   */
  getDefaultAgentAddress(): string | undefined {
    return this.defaultAgentAddress;
  }

  /**
   * Resolve the agent address for a request: first try agent token, then fall
   * back to the default agent (for node-level tokens / backward compatibility).
   */
  resolveAgentAddress(token: string | undefined): string {
    if (token) {
      const addr = this.agentTokenIndex.get(token);
      if (addr) return addr;
    }
    if (this.defaultAgentAddress) return this.defaultAgentAddress;
    return this.peerId;
  }

  private async persistAgentToStore(record: AgentKeyRecord): Promise<void> {
    const graph = DKGAgent.AGENT_SYSTEM_GRAPH;
    const agentUri = `did:dkg:agent:${record.agentAddress}`;
    const DKG = 'https://dkg.network/ontology#';
    const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
    const SCHEMA_NAME = 'https://schema.org/name';

    const quads: Quad[] = [
      { subject: agentUri, predicate: RDF_TYPE, object: `${DKG}Agent`, graph },
      { subject: agentUri, predicate: SCHEMA_NAME, object: `"${escapeSparqlLiteral(record.name)}"`, graph },
      { subject: agentUri, predicate: `${DKG}agentAddress`, object: `"${record.agentAddress}"`, graph },
      { subject: agentUri, predicate: `${DKG}agentMode`, object: `"${record.mode}"`, graph },
      { subject: agentUri, predicate: `${DKG}agentAuthTokenHash`, object: `"${hashAgentToken(record.authToken)}"`, graph },
      { subject: agentUri, predicate: `${DKG}createdAt`, object: `"${record.createdAt}"`, graph },
    ];
    if (record.publicKey) {
      quads.push({ subject: agentUri, predicate: `${DKG}publicKey`, object: `"${record.publicKey}"`, graph });
    }
    if (record.publicEncryptionKey && record.encryptionKeyAlgorithm && record.encryptionKeyProof) {
      quads.push(
        { subject: agentUri, predicate: `${DKG}publicEncryptionKey`, object: `"${record.publicEncryptionKey}"`, graph },
        { subject: agentUri, predicate: `${DKG}encryptionKeyAlgorithm`, object: `"${record.encryptionKeyAlgorithm}"`, graph },
        { subject: agentUri, predicate: `${DKG}encryptionKeyProof`, object: `"${record.encryptionKeyProof}"`, graph },
      );
    }
    if (record.framework) {
      quads.push({ subject: agentUri, predicate: 'https://dkg.origintrail.io/skill#framework', object: `"${record.framework}"`, graph });
    }

    await this.store.insert(quads);
  }

  /**
   * Load previously registered agents from the triple store on startup.
   */
  private async loadAgentsFromStore(): Promise<void> {
    const graph = DKGAgent.AGENT_SYSTEM_GRAPH;
    const DKG = 'https://dkg.network/ontology#';

    // Load raw tokens and custodial keys from the on-disk keystore
    const keystore = await this.loadKeystore();

    const sparql = `
      SELECT ?agent ?name ?address ?mode ?tokenHash ?legacyToken ?publicKey ?publicEncryptionKey ?encryptionKeyAlgorithm ?encryptionKeyProof ?framework ?createdAt ?isDefault WHERE {
        GRAPH <${graph}> {
          ?agent a <${DKG}Agent> ;
                 <https://schema.org/name> ?name ;
                 <${DKG}agentAddress> ?address ;
                 <${DKG}agentMode> ?mode .
          OPTIONAL { ?agent <${DKG}agentAuthTokenHash> ?tokenHash }
          OPTIONAL { ?agent <${DKG}agentAuthToken> ?legacyToken }
          OPTIONAL { ?agent <${DKG}publicKey> ?publicKey }
          OPTIONAL { ?agent <${DKG}publicEncryptionKey> ?publicEncryptionKey }
          OPTIONAL { ?agent <${DKG}encryptionKeyAlgorithm> ?encryptionKeyAlgorithm }
          OPTIONAL { ?agent <${DKG}encryptionKeyProof> ?encryptionKeyProof }
          OPTIONAL { ?agent <https://dkg.origintrail.io/skill#framework> ?framework }
          OPTIONAL { ?agent <${DKG}createdAt> ?createdAt }
          OPTIONAL { ?agent <${DKG}isDefaultAgent> ?isDefault }
        }
      }
    `;
    let markedDefaultAddr: string | undefined;
    const needsMigration: AgentKeyRecord[] = [];
    try {
      const result = await this.store.query(sparql);
      if (result.type !== 'bindings') return;
      const strip = (v?: string) => v?.replace(/^"|"$/g, '').replace(/"?\^\^.*$/, '') ?? '';
      for (const row of result.bindings) {
        const addr = strip(row['address']);
        const ksEntry = keystore[addr.toLowerCase()];
        const legacyToken = strip(row['legacyToken']);

        // Token resolution: prefer keystore file → legacy plaintext → empty
        let authToken = ksEntry?.authToken ?? '';
        if (!authToken && legacyToken) {
          authToken = legacyToken;
        }

        const storeHasEncryptionKey = Boolean(
          strip(row['publicEncryptionKey']) &&
          strip(row['encryptionKeyAlgorithm']) &&
          strip(row['encryptionKeyProof']),
        );
        const record: AgentKeyRecord = {
          agentAddress: addr,
          publicKey: strip(row['publicKey']) || '',
          publicEncryptionKey: strip(row['publicEncryptionKey']) || ksEntry?.publicEncryptionKey,
          privateEncryptionKey: ksEntry?.privateEncryptionKey,
          encryptionKeyAlgorithm: (strip(row['encryptionKeyAlgorithm']) || ksEntry?.encryptionKeyAlgorithm) as typeof WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519 | undefined,
          encryptionKeyProof: strip(row['encryptionKeyProof']) || ksEntry?.encryptionKeyProof,
          name: strip(row['name']),
          framework: strip(row['framework']) || undefined,
          mode: strip(row['mode']) as 'custodial' | 'self-sovereign',
          authToken,
          createdAt: strip(row['createdAt']) || '',
        };

        // Restore private key: prefer keystore file, fall back to operational keys
        if (record.mode === 'custodial' && !record.privateKey) {
          if (ksEntry?.privateKey) {
            record.privateKey = ksEntry.privateKey;
          } else {
            const opKeys = this.config.chainConfig?.operationalKeys;
            if (opKeys?.length) {
              for (const key of opKeys) {
                try {
                  const w = new ethers.Wallet(key);
                  if (w.address.toLowerCase() === record.agentAddress.toLowerCase()) {
                    record.privateKey = key;
                    break;
                  }
                } catch { /* skip invalid keys */ }
              }
            }
          }
        }

        if (record.publicEncryptionKey) {
          try {
            record.encryptionKeyId = workspaceAgentEncryptionKeyId(
              record.agentAddress,
              decodeWorkspaceEncryptionKey(record.publicEncryptionKey),
            );
          } catch {
            record.encryptionKeyId = undefined;
          }
        }
        const generatedEncryptionKey = ensureWorkspaceEncryptionKey(record);

        this.localAgents.set(record.agentAddress, record);
        if (record.authToken) {
          this.agentTokenIndex.set(record.authToken, record.agentAddress);
        }

        if (strip(row['isDefault']) === 'true') {
          markedDefaultAddr = record.agentAddress;
        }

        // Schedule migration: plaintext token in RDF but no keystore entry yet
        if (legacyToken && !ksEntry?.authToken) {
          needsMigration.push(record);
        }
        if (
          generatedEncryptionKey ||
          (
            !storeHasEncryptionKey &&
            record.publicEncryptionKey &&
            record.encryptionKeyAlgorithm &&
            record.encryptionKeyProof
          )
        ) {
          needsMigration.push(record);
        }
      }
      if (markedDefaultAddr) {
        this.defaultAgentAddress = markedDefaultAddr;
      }
      if (this.localAgents.size > 0) {
        const ctx = createOperationContext('system');
        this.log.info(ctx, `Loaded ${this.localAgents.size} registered agent(s) from store`);
      }
      // Migrate legacy plaintext tokens: save to keystore, replace RDF with hash
      for (const rec of needsMigration) {
        await this.saveToKeystore(rec);
        await this.persistAgentToStore(rec);
        await this.migrateTokenToHash(rec);
      }
    } catch {
      // Graph may not exist yet on first boot
    }
  }

  /**
   * Auto-register the default "owner" agent from the first operational wallet.
   * Called on boot when no agents have been previously registered.
   */
  private async autoRegisterDefaultAgent(): Promise<void> {
    let opKey = this.config.chainConfig?.operationalKeys?.[0];
    if (!opKey && typeof (this.chain as any).getOperationalPrivateKey === 'function') {
      try {
        opKey = (this.chain as any).getOperationalPrivateKey();
      } catch { /* adapter without key — skip */ }
    }
    if (!opKey) return;

    const record = agentFromPrivateKey(
      opKey,
      this.config.name ?? 'owner',
      this.config.framework,
    );

    this.localAgents.set(record.agentAddress, record);
    this.agentTokenIndex.set(record.authToken, record.agentAddress);
    this.defaultAgentAddress = record.agentAddress;
    await this.persistAgentToStore(record);
    await this.markDefaultAgent(record.agentAddress);
    await this.saveToKeystore(record);

    const ctx = createOperationContext('system');
    this.log.info(ctx, `Auto-registered default agent "${record.name}" → ${record.agentAddress}`);
  }

  // ---------------------------------------------------------------------------
  // Agent keystore — secrets kept out of queryable RDF
  // ---------------------------------------------------------------------------

  private keystorePath(): string | null {
    if (!this.config.dataDir) return null;
    return `${this.config.dataDir}/agent-keystore.json`;
  }

  private async loadKeystore(): Promise<Record<string, {
    authToken?: string;
    privateKey?: string;
    encryptionKeyAlgorithm?: typeof WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519;
    publicEncryptionKey?: string;
    privateEncryptionKey?: string;
    encryptionKeyProof?: string;
  }>> {
    const ksPath = this.keystorePath();
    if (!ksPath) return {};
    try {
      const { readFile } = await import('node:fs/promises');
      const raw = await readFile(ksPath, 'utf-8');
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }

  private async saveToKeystore(record: AgentKeyRecord): Promise<void> {
    const ksPath = this.keystorePath();
    if (!ksPath) return;
    try {
      const { readFile, writeFile, mkdir, chmod } = await import('node:fs/promises');
      const { dirname } = await import('node:path');
      let existing: Record<string, {
        authToken?: string;
        privateKey?: string;
        encryptionKeyAlgorithm?: typeof WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519;
        publicEncryptionKey?: string;
        privateEncryptionKey?: string;
        encryptionKeyProof?: string;
      }> = {};
      try {
        const raw = await readFile(ksPath, 'utf-8');
        existing = JSON.parse(raw);
      } catch { /* first write */ }
      existing[record.agentAddress.toLowerCase()] = {
        authToken: record.authToken,
        ...(record.privateKey ? { privateKey: record.privateKey } : {}),
        ...(record.encryptionKeyAlgorithm ? { encryptionKeyAlgorithm: record.encryptionKeyAlgorithm } : {}),
        ...(record.publicEncryptionKey ? { publicEncryptionKey: record.publicEncryptionKey } : {}),
        ...(record.privateEncryptionKey ? { privateEncryptionKey: record.privateEncryptionKey } : {}),
        ...(record.encryptionKeyProof ? { encryptionKeyProof: record.encryptionKeyProof } : {}),
      };
      await mkdir(dirname(ksPath), { recursive: true });
      await writeFile(ksPath, JSON.stringify(existing, null, 2), { mode: 0o600 });
      await chmod(ksPath, 0o600);
    } catch {
      // Non-fatal — agent still works, just won't survive restart
    }
  }

  /**
   * One-time migration: replace a legacy plaintext agentAuthToken triple
   * with an agentAuthTokenHash triple so future SPARQL queries never
   * reveal the raw token.
   */
  private async migrateTokenToHash(record: AgentKeyRecord): Promise<void> {
    const graph = DKGAgent.AGENT_SYSTEM_GRAPH;
    const DKG = 'https://dkg.network/ontology#';
    const agentUri = `did:dkg:agent:${record.agentAddress}`;
    try {
      await this.store.delete([{
        subject: agentUri,
        predicate: `${DKG}agentAuthToken`,
        object: `"${record.authToken}"`,
        graph,
      }]);
      await this.store.insert([{
        subject: agentUri,
        predicate: `${DKG}agentAuthTokenHash`,
        object: `"${hashAgentToken(record.authToken)}"`,
        graph,
      }]);
      const ctx = createOperationContext('system');
      this.log.info(ctx, `Migrated plaintext auth token to hash for agent ${record.agentAddress}`);
    } catch {
      // Non-fatal — old token remains readable until next migration attempt
    }
  }

  /**
   * Persist an explicit default-agent marker in the triple store so the
   * default agent is deterministic across restarts (independent of SPARQL
   * result ordering).
   */
  private async markDefaultAgent(agentAddress: string): Promise<void> {
    const graph = DKGAgent.AGENT_SYSTEM_GRAPH;
    const DKG = 'https://dkg.network/ontology#';
    // Clear any existing default marker
    try {
      const existing = await this.store.query(
        `SELECT ?agent WHERE { GRAPH <${graph}> { ?agent <${DKG}isDefaultAgent> "true" } }`,
      );
      if (existing.type === 'bindings') {
        for (const row of existing.bindings) {
          const agentUri = row['agent'];
          if (agentUri) {
            await this.store.delete([{
              subject: agentUri, predicate: `${DKG}isDefaultAgent`, object: `"true"`, graph,
            }]);
          }
        }
      }
    } catch { /* ignore */ }
    const agentUri = `did:dkg:agent:${agentAddress}`;
    await this.store.insert([{
      subject: agentUri, predicate: `${DKG}isDefaultAgent`, object: `"true"`, graph,
    }]);
  }

  /**
   * Check whether any locally registered agent is the curator/creator
   * of the given context graph.
   */
  async isCuratorOf(contextGraphId: string): Promise<boolean> {
    const owner = await this.getContextGraphOwner(contextGraphId);
    if (!owner) return false;
    // Mirror the comparison in PROTOCOL_JOIN_REQUEST. `normalizeAgentDid`
    // collapses EVM-address case drift but preserves peer-ID case.
    const ownerNorm = normalizeAgentDid(owner);
    const selfDid = `did:dkg:agent:${this.peerId}`;
    if (ownerNorm === selfDid) return true;
    for (const addr of this.localAgents.keys()) {
      if (ownerNorm === normalizeAgentDid(`did:dkg:agent:${addr}`)) return true;
    }
    return false;
  }

  /**
   * Chain-confirmed verified author identity for a knowledge collection's
   * latest merkle-root entry. Reads
   * `KnowledgeCollectionStorage.getLatestMerkleRootAuthor(kcId)` via the
   * configured chain adapter.
   *
   * Returns:
   *   - the address recovered from the EIP-712 author attestation (EOA
   *     publish path), or
   *   - the smart-contract author address verified via EIP-1271 for
   *     contract-based author identities, or
   *   - `address(0)` for legacy V8 / V9 publishes and current V10.1
   *     update-path mutations (which don't sign).
   *
   * Returns `null` when the chain adapter doesn't expose the view (no-chain
   * mode or pre-V10.1 evm-adapter copies). Callers that need to distinguish
   * "no attestation on file" from "feature unavailable" should use this
   * `null` signal — `address(0)` always means the former.
   */
  async getKnowledgeCollectionAuthor(kcId: bigint): Promise<string | null> {
    if (typeof this.chain.getLatestMerkleRootAuthor !== 'function') return null;
    return this.chain.getLatestMerkleRootAuthor(kcId);
  }

  /**
   * Publishing Conviction Account (PCA) facade for the agent-provenance
   * runbook surface. These methods are thin wrappers over the chain adapter
   * — the agent doesn't keep PCA state of its own; the on-chain
   * `PublishingConvictionAccount` is the source of truth. The wrappers
   * exist so daemon HTTP routes don't need to reach into the private
   * `chain` field, mirroring the `getKnowledgeCollectionAuthor` pattern.
   *
   * `createPublishingConvictionAccount`: tx is signed by the agent's
   * configured EOA; that EOA becomes the PCA `admin` and is automatically
   * added to its own `authorizedKeys` set. Operators driving the runbook
   * from a core node use this to stand up the PCA before mode (a)/(b).
   *
   * `addPCAAuthorizedKey` and `isPCAAuthorizedKey` are admin-gated on chain
   * (`require(msg.sender == account.admin)`), so the daemon must be running
   * as the PCA admin EOA for `addPCAAuthorizedKey` to succeed. Read-side
   * `isPCAAuthorizedKey` is permissionless on chain and works from any node.
   */
  async createPublishingConvictionAccount(
    amount: bigint,
    lockEpochs: number,
  ): Promise<{ accountId: bigint; txHash: string; blockNumber: number } | null> {
    if (typeof this.chain.createConvictionAccount !== 'function') return null;
    const result = await this.chain.createConvictionAccount(amount, lockEpochs);
    return {
      accountId: result.accountId,
      txHash: result.hash,
      blockNumber: result.blockNumber,
    };
  }

  async addPublishingConvictionAccountFunds(
    accountId: bigint,
    amount: bigint,
  ): Promise<{ txHash: string; blockNumber: number } | null> {
    if (typeof this.chain.addConvictionFunds !== 'function') return null;
    const result = await this.chain.addConvictionFunds(accountId, amount);
    return { txHash: result.hash, blockNumber: result.blockNumber };
  }

  async addPCAAuthorizedKey(
    accountId: bigint,
    key: string,
  ): Promise<{ txHash: string; blockNumber: number } | null> {
    if (typeof this.chain.addPCAAuthorizedKey !== 'function') return null;
    const result = await this.chain.addPCAAuthorizedKey(accountId, key);
    return { txHash: result.hash, blockNumber: result.blockNumber };
  }

  async isPCAAuthorizedKey(accountId: bigint, key: string): Promise<boolean | null> {
    if (typeof this.chain.isPCAAuthorizedKey !== 'function') return null;
    return this.chain.isPCAAuthorizedKey(accountId, key);
  }

  async getPublishingConvictionAccountInfo(accountId: bigint): Promise<{
    accountId: bigint;
    admin: string;
    balance: bigint;
    initialDeposit: bigint;
    lockEpochs: number;
    conviction: bigint;
    discountBps: number;
  } | null> {
    if (typeof this.chain.getConvictionAccountInfo !== 'function') return null;
    return this.chain.getConvictionAccountInfo(accountId);
  }

  // ---------------------------------------------------------------------------

  /**
   * Public send-bytes-to-peer primitive. Thin pass-through to `Messenger`,
   * which handles relay-prime + transport-level retry. All P2P call sites
   * SHOULD go through this rather than `this.router.send` directly.
   */
  async sendToPeer(
    peerId: string,
    protocolId: string,
    data: Uint8Array,
    opts?: { timeoutMs?: number },
  ): Promise<Uint8Array> {
    return this.messenger.sendToPeer(peerId, protocolId, data, opts);
  }

  async sendChat(
    recipientPeerId: string,
    text: string,
    options: { contextGraphId?: string; messageId?: string } = {},
  ): Promise<ChatSendResult> {
    if (!this.messageHandler) throw new Error('Agent not started');
    // Per-send unique id for the outbox key. Caller-supplied wins so a
    // higher-level component (e.g. the MCP tool layer or a UI) that
    // wants to correlate retries with its own bookkeeping can pass its
    // own id. Default is a uuidv4 from `node:crypto`.
    const messageId = options.messageId ?? crypto.randomUUID();
    const result = await this.messageHandler.sendChat(recipientPeerId, text, options);

    if (result.delivered) {
      // Successful delivery clears any pending retry from a prior
      // failure for THIS exact `(recipient, messageId)`. A fresh
      // first-attempt with a new messageId is a no-op here, which is
      // the correct semantic — markDelivered returns false in that case
      // and we ignore the bool.
      this.messageOutbox.markDelivered(recipientPeerId, messageId);
      return { delivered: true, messageId };
    }

    // First-attempt failure → enqueue for retry. The outbox keeps the
    // payload, the periodic tick (`processMessageOutboxTick`) and the
    // `connection:open` opportunistic flush (`processMessageOutboxOnConnect`)
    // will both try to deliver it again until it succeeds or
    // `maxAgeMs` runs out.
    //
    // The caller-visible return shape gains `queued`, `attempts`, and
    // `nextAttemptAtMs` so the MCP `dkg_send_message` tool can surface
    // "queued for retry" to the operator instead of an opaque error.
    // `delivered` and `error` retain their existing semantics for
    // backwards-compatibility with any pre-outbox caller.
    const entry = this.messageOutbox.enqueueFailure(
      {
        recipientPeerId,
        text,
        contextGraphId: options.contextGraphId,
        messageId,
      },
      result.error ?? 'unknown',
      Date.now(),
    );
    const ctx = createOperationContext('system');
    this.log.warn(
      ctx,
      `Queued chat outbox retry #${entry.attempts} for ${recipientPeerId.slice(-8)} ` +
        `(messageId=${messageId.slice(0, 8)}, ` +
        `next attempt at ${new Date(entry.nextAttemptAt).toISOString()}, ` +
        `lastError=${entry.lastError}). ` +
        `Will retry on the periodic tick (every ${MESSAGE_OUTBOX_TICK_MS / 1000}s) ` +
        `or opportunistically on the next direct re-connect from the recipient's peer.`,
    );
    return {
      delivered: false,
      queued: true,
      messageId,
      attempts: entry.attempts,
      nextAttemptAtMs: entry.nextAttemptAt,
      error: result.error,
    };
  }

  /**
   * Snapshot of the chat outbox for diagnostics. Used by the
   * `GET /api/chat/outbox` route + the MCP `dkg_outbox_status` tool
   * (if/when added) so operators can see what's pending after a long
   * recipient outage.
   */
  listMessageOutbox(): ChatOutboxRetryEntry[] {
    return this.messageOutbox.list();
  }

  onChat(handler: ChatHandler): void {
    if (!this.messageHandler) {
      this._pendingChatHandler = handler;
      return;
    }
    this.messageHandler.onChat(handler);
  }

  /**
   * Install / clear the inbound-chat ACL. Pass `null` to disable (legacy
   * "accept all authenticated peers" behaviour). The daemon constructs the
   * concrete callback from `chat.acl` config — see lifecycle.ts.
   */
  setChatAcl(check: ChatAclCheck | null): void {
    if (!this.messageHandler) {
      this._pendingChatAcl = check;
      return;
    }
    this.messageHandler.setChatAcl(check);
  }

  private _pendingChatHandler: ChatHandler | null = null;
  private _pendingChatAcl: ChatAclCheck | null = null;

  async invokeSkill(
    recipientPeerId: string,
    skillUri: string,
    inputData: Uint8Array,
  ): Promise<SkillResponse> {
    if (!this.messageHandler) throw new Error('Agent not started');
    return this.messageHandler.sendSkillRequest(recipientPeerId, {
      skillUri,
      inputData,
      callback: 'inline',
    });
  }

  async connectTo(multiaddress: string): Promise<void> {
    const ctx = createOperationContext('connect');
    await connectToMultiaddr(
      this.node.libp2p as any,
      multiaddress,
      (message) => this.log.info(ctx, message),
    );
  }

  /**
   * Resolve a peer's current multiaddrs via the {@link PeerResolver} and
   * dial them. Used by the V10 invite flow where invites carry only a peer
   * id — the daemon discovers up-to-date addresses at join time so the
   * invite stays valid across relay rotations and IP changes (which broke
   * the legacy multiaddr-in-invite design).
   *
   * After RFC 07 PR-4 the inline DHT walk is gone; resolution is delegated
   * to the resolver, which runs the full RFC 07 §3.1 order: live conn →
   * DHT → RFC 04 registry (stub) → agents-CG fallback. The resolver primes
   * the libp2p peerStore as a side effect, so a plain `libp2p.dial(peerId)`
   * here finds a route. The agents-CG fallback in particular is a new
   * capability — the legacy inline path had no way to reach a peer whose
   * DHT record was stale but whose relay was still advertised in the
   * agent registry.
   *
   * (PR #496 originally included a step-5 "bootstrap seeds" fallback in
   * the resolver itself; that was removed after Codex review pointed out
   * that bootstrap seeds are addresses for SEED peers, not for the
   * requested target. Bootstrap stays a libp2p-startup concern via
   * `bootstrap({ list })` peerDiscovery in node.ts.)
   *
   * Errors:
   *   - `INVALID_PEER_ID` — client-side parse failure (HTTP 400).
   *   - `SELF_DIAL` — caller asked us to dial our own peer id (HTTP 400).
   *   - `CONNECT_TIMEOUT` — caller's `timeoutMs` elapsed mid-resolution
   *     (the shared AbortSignal fired). Retriable → HTTP 504.
   *   - `PEER_NOT_FOUND` — resolver completed without aborting and
   *     returned no addresses (DHT miss AND no agents-CG record).
   *     Genuine negative lookup → HTTP 404.
   *     Retrying is unlikely to help until the remote node republishes.
   *   - `DIAL_FAILED` — resolver returned addresses but every dial attempt
   *     failed. Retriable transport-level → HTTP 502.
   *
   * Note (regression vs PR #431): the previous implementation distinguished
   * `DHT_TIMEOUT` (504) and `DHT_UNAVAILABLE` (503) from `PEER_NOT_FOUND`
   * because the inline walk surfaced the underlying per-step failure shape.
   * The resolver is best-effort and swallows per-step errors (returns `[]`
   * on miss). Codex review feedback on PR #499 round 5: at minimum the
   * timeout/aborted case must NOT collapse into 404, since `/api/connect`
   * upstream maps 404 to a terminal "wrong peer id" outcome and 504 to
   * retriable infrastructure errors. We split out aborted-signal → 504
   * here; the more granular 503 (DHT specifically unavailable but other
   * steps not exhausted) still requires a `resolveWithDiagnostics` API
   * on PeerResolver and is left as a follow-up — see RFC 07 §3.3.
   */
  async connectToPeerId(peerIdStr: string, options?: { timeoutMs?: number }): Promise<void> {
    const ctx = createOperationContext('connect');
    const timeoutMs = options?.timeoutMs ?? 15_000;
    const { peerIdFromString } = await import('@libp2p/peer-id');

    let peerId;
    try {
      peerId = peerIdFromString(peerIdStr);
    } catch (err: any) {
      const error = new Error(`Invalid peer id: ${err?.message ?? String(err)}`);
      (error as any).code = 'INVALID_PEER_ID';
      throw error;
    }

    if (peerId.toString() === this.node.peerId) {
      const error = new Error('Cannot dial self');
      (error as any).code = 'SELF_DIAL';
      throw error;
    }

    // Fast-path: already connected (e.g. via gossipsub mesh / mDNS / a
    // prior invite). Resolver step 1 would also short-circuit on this,
    // but the early return preserves the existing log message and skips
    // the rest of the resolution machinery entirely.
    const existing = this.node.libp2p.getConnections(peerId);
    if (existing.length > 0) {
      this.log.info(ctx, `Already connected to ${peerIdStr}`);
      return;
    }

    // Codex review feedback on PR #499: a single AbortSignal bounds the
    // entire connect (resolution + dial). Previously `timeoutMs` was
    // passed as a per-step budget to the resolver AND reused for the
    // final dial, so a slow DHT walk plus a slow dial could exceed the
    // caller's deadline by a wide margin. Using one signal threads the
    // remaining budget through both phases.
    const startedAt = Date.now();
    const signal = AbortSignal.timeout(timeoutMs);

    this.log.info(ctx, `Resolving ${peerIdStr} via PeerResolver...`);
    const addrs = await this.peerResolver.resolve(peerIdStr, {
      signal,
      perStepTimeoutMs: Math.max(0, timeoutMs - (Date.now() - startedAt)),
    });
    if (addrs.length === 0) {
      // Codex PR #499 round 5: distinguish "abort/timeout swallowed by
      // best-effort resolver" from "genuine negative lookup". Without
      // this, transient routing failures (DHT timeout, network blip)
      // surface as 404 PEER_NOT_FOUND in /api/connect — which the UI
      // treats as terminal. Mapping aborted-signal → CONNECT_TIMEOUT
      // (504) preserves the retriable-vs-terminal distinction that
      // PR #431's inline walk had.
      if (signal.aborted) {
        const error = new Error(
          `CONNECT_TIMEOUT: PeerResolver did not return addresses for ${peerIdStr} ` +
            `within ${timeoutMs}ms (caller signal aborted; transient routing failure)`,
        );
        (error as any).code = 'CONNECT_TIMEOUT';
        throw error;
      }
      const error = new Error(
        `PEER_NOT_FOUND: PeerResolver returned no addresses for ${peerIdStr}`,
      );
      (error as any).code = 'PEER_NOT_FOUND';
      throw error;
    }
    this.log.info(ctx, `Resolved ${peerIdStr} → ${addrs.length} addr(s); dialling...`);

    // peerStore is already primed by the resolver. dial(peerId) finds
    // the addresses there and goes — same AbortSignal so the overall
    // budget is honoured end-to-end.
    try {
      await this.node.libp2p.dial(peerId, { signal });
      this.log.info(ctx, `Connected to ${peerIdStr}`);
    } catch (err: any) {
      // Codex PR #499 round 5 (dkg-agent.ts:4096): the shared signal
      // covers BOTH resolution and dial. If most of the budget went
      // into resolve() and dial() then aborts on the same signal, we
      // must classify that as CONNECT_TIMEOUT (504, retriable), not
      // DIAL_FAILED (502, transport failure). Without this split, a
      // peer that resolves right before the deadline gets misclassified
      // and the UI's retry logic stops working.
      //
      // signal.aborted is the definitive check — it's our signal, so
      // an abort means the timeout fired. Also accept AbortError-named
      // errors (libp2p's transport layer surfaces those via DOMException
      // when the dial is cancelled).
      const isAbort =
        signal.aborted ||
        err?.name === 'AbortError' ||
        err?.code === 'ABORT_ERR';
      if (isAbort) {
        const error = new Error(
          `CONNECT_TIMEOUT: dial to ${peerIdStr} aborted after ` +
            `${Date.now() - startedAt}ms of ${timeoutMs}ms budget ` +
            `(resolution succeeded, dial timed out)`,
        );
        (error as any).code = 'CONNECT_TIMEOUT';
        throw error;
      }
      const error = new Error(`DIAL_FAILED: ${err?.message ?? String(err)}`);
      (error as any).code = 'DIAL_FAILED';
      throw error;
    }
  }

  // Overload: raw quads
  async publish(contextGraphId: string, quads: Quad[], privateQuads?: Quad[], opts?: PublishOpts): Promise<PublishResult>;
  // Overload: JSON-LD (bare doc = private, or { public?, private? } envelope)
  async publish(contextGraphId: string, content: JsonLdContent, opts?: PublishOpts): Promise<PublishResult>;
  async publish(
    contextGraphId: string,
    input: Quad[] | JsonLdContent,
    thirdArg?: Quad[] | PublishOpts,
    fourthArg?: PublishOpts,
  ): Promise<PublishResult> {
    // JSON-LD: convert to quads, then publish
    if (!Array.isArray(input)) {
      const { publicQuads, privateQuads } = await jsonLdToQuads(input);
      return this._publish(contextGraphId, publicQuads, privateQuads, thirdArg as PublishOpts);
    }
    // Quad[]: pass through directly
    if (Array.isArray(thirdArg)) {
      return this._publish(contextGraphId, input as Quad[], thirdArg, fourthArg);
    }
    return this._publish(contextGraphId, input as Quad[], undefined, thirdArg ?? fourthArg);
  }

  private getWorkspaceGossipSigningAgent(): (AgentKeyRecord & { privateKey: string }) | null {
    const defaultAddress = this.defaultAgentAddress?.toLowerCase();
    let fallback: (AgentKeyRecord & { privateKey: string }) | null = null;
    for (const record of this.localAgents.values()) {
      if (!record.privateKey) continue;
      const signingRecord = { ...record, privateKey: record.privateKey };
      if (defaultAddress && record.agentAddress.toLowerCase() === defaultAddress) {
        return signingRecord;
      }
      fallback ??= signingRecord;
    }
    return fallback;
  }

  private async getContextGraphAgentGateAddresses(contextGraphId: string): Promise<string[] | null> {
    const seen = new Set<string>();
    const agents: string[] = [];
    let sawAgentGate = false;
    const add = (value: string | undefined) => {
      if (!value || !ethers.isAddress(value)) return;
      const checksum = ethers.getAddress(value);
      const key = checksum.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      agents.push(checksum);
    };

    const subscriptionAgents = this.subscribedContextGraphs.get(contextGraphId)?.participantAgents ?? [];
    if (subscriptionAgents.length > 0) sawAgentGate = true;
    for (const agentAddress of subscriptionAgents) {
      add(agentAddress);
    }

    const contextGraphUri = contextGraphDataGraphUri(contextGraphId);
    const cgMetaGraph = contextGraphMetaGraphUri(contextGraphId);
    const result = await this.store.query(
      `SELECT ?agent WHERE {
        GRAPH <${cgMetaGraph}> {
          { <${contextGraphUri}> <${DKG_ONTOLOGY.DKG_ALLOWED_AGENT}> ?agent }
          UNION
          { <${contextGraphUri}> <${DKG_ONTOLOGY.DKG_PARTICIPANT_AGENT}> ?agent }
        }
      }`,
    );
    if (result.type === 'bindings') {
      if (result.bindings.length > 0) sawAgentGate = true;
      for (const row of result.bindings) {
        const raw = row['agent'];
        if (typeof raw === 'string') {
          add(raw.replace(/^"/, '').replace(/"(@[a-zA-Z-]+|\^\^<[^>]+>)?$/, ''));
        }
      }
    }

    return sawAgentGate ? agents : null;
  }

  /**
   * Read libp2p peer-ids that approved agents have authorised, via
   * signed delegations, to act on their behalf for sync against this
   * CG. Used by the sync auth path so a sync request signed by the
   * joiner's NODE (operational) key passes auth — the agent itself
   * doesn't co-sign every wire message.
   *
   * Returns a Map keyed by the lowercased agent address (the
   * delegating principal) → list of peer-ids that agent delegated.
   * Auth code looks up only the agent the inbound envelope claims to
   * act on behalf of (`requesterAgentAddress`), so a delegation
   * granted to agent A's node doesn't accidentally let traffic
   * "on behalf of agent B" through that same node.
   */
  private async getContextGraphAllowedDelegateePeers(contextGraphId: string): Promise<Map<string, string[]>> {
    const cgMetaGraph = contextGraphMetaGraphUri(contextGraphId);
    // SELECT also returns `expiresAtMs` so we can filter expired rows in
    // JS — pushing the FILTER into SPARQL would force a string→long
    // cast that not every store backend handles uniformly.
    // PR #448 review (round 4): without this, an approved delegation
    // remained authorised forever even after `expiresAtMs` had passed.
    // `approveJoinRequest()` re-validates expiry only at approval time;
    // sync auth never checked it again, turning `expiresAtMs` into a
    // one-time admission gate instead of an ongoing constraint.
    const result = await this.store.query(
      `SELECT ?agent ?peer ?expiresAt WHERE {
        GRAPH <${cgMetaGraph}> {
          ?d <${DKG_ONTOLOGY.DKG_DELEGATION_AGENT}> ?agent ;
             <${DKG_ONTOLOGY.DKG_ALLOWED_DELEGATEE_PEER}> ?peer .
          OPTIONAL { ?d <${DKG_ONTOLOGY.DKG_DELEGATION_EXPIRES_AT}> ?expiresAt }
        }
      }`,
    );
    const out = new Map<string, string[]>();
    if (result.type !== 'bindings') return out;
    const strip = (raw: unknown): string => {
      if (typeof raw !== 'string') return '';
      return raw.replace(/^"/, '').replace(/"(@[a-zA-Z-]+|\^\^<[^>]+>)?$/, '');
    };
    const nowMs = Date.now();
    for (const row of result.bindings) {
      const agent = strip(row['agent']).toLowerCase();
      const peer = strip(row['peer']);
      if (!agent || !peer) continue;
      const expiresStr = strip(row['expiresAt']);
      if (expiresStr) {
        const expiresAt = Number(expiresStr);
        if (Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt < nowMs) continue;
      }
      const list = out.get(agent) ?? [];
      if (!list.includes(peer)) list.push(peer);
      out.set(agent, list);
    }
    return out;
  }

  /**
   * Same as `getContextGraphAllowedDelegateePeers` but for ethereum
   * operational-key addresses authorised via a signed delegation.
   * Returns Map<agentLower, opKeyLower[]>. Both keys and values are
   * lowercased so callers can compare against `recoveredAddress.toLowerCase()`.
   * Expired rows are filtered out — see the peer-lookup helper for the
   * rationale (PR #448 review round 4).
   */
  private async getContextGraphAllowedDelegateeKeys(contextGraphId: string): Promise<Map<string, string[]>> {
    const cgMetaGraph = contextGraphMetaGraphUri(contextGraphId);
    const result = await this.store.query(
      `SELECT ?agent ?key ?expiresAt WHERE {
        GRAPH <${cgMetaGraph}> {
          ?d <${DKG_ONTOLOGY.DKG_DELEGATION_AGENT}> ?agent ;
             <${DKG_ONTOLOGY.DKG_ALLOWED_DELEGATEE_KEY}> ?key .
          OPTIONAL { ?d <${DKG_ONTOLOGY.DKG_DELEGATION_EXPIRES_AT}> ?expiresAt }
        }
      }`,
    );
    const out = new Map<string, string[]>();
    if (result.type !== 'bindings') return out;
    const strip = (raw: unknown): string => {
      if (typeof raw !== 'string') return '';
      return raw.replace(/^"/, '').replace(/"(@[a-zA-Z-]+|\^\^<[^>]+>)?$/, '');
    };
    const nowMs = Date.now();
    for (const row of result.bindings) {
      const agent = strip(row['agent']).toLowerCase();
      const key = strip(row['key']).toLowerCase();
      if (!agent || !key) continue;
      const expiresStr = strip(row['expiresAt']);
      if (expiresStr) {
        const expiresAt = Number(expiresStr);
        if (Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt < nowMs) continue;
      }
      const list = out.get(agent) ?? [];
      if (!list.includes(key)) list.push(key);
      out.set(agent, list);
    }
    return out;
  }

  private hasLocalAgentInGate(agentGateAddresses: readonly string[]): boolean {
    const allowedSet = new Set(agentGateAddresses.map((agent) => agent.toLowerCase()));
    for (const record of this.localAgents.values()) {
      if (allowedSet.has(record.agentAddress.toLowerCase())) {
        return true;
      }
    }
    return false;
  }

  private getLocalWorkspaceRecipientPrivateKeys(): WorkspaceRecipientEncryptionKey[] {
    const keys: WorkspaceRecipientEncryptionKey[] = [];
    for (const record of this.localAgents.values()) {
      if (
        record.encryptionKeyAlgorithm !== WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519 ||
        !record.publicEncryptionKey ||
        !record.privateEncryptionKey
      ) {
        continue;
      }
      const publicKeyBytes = decodeWorkspaceEncryptionKey(record.publicEncryptionKey);
      const privateKeyBytes = decodeWorkspaceEncryptionKey(record.privateEncryptionKey);
      const recipientId = `did:dkg:agent:${ethers.getAddress(record.agentAddress)}`;
      keys.push({
        purpose: WORKSPACE_RECIPIENT_ENCRYPTION_KEY_PURPOSE,
        recipientId,
        recipientKeyId: workspaceAgentEncryptionKeyId(record.agentAddress, publicKeyBytes),
        encryptionKeyAlgorithm: WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519,
        publicKeyBytes,
        privateKeyBytes,
      });
    }
    return keys;
  }

  private async encryptWorkspacePayloadWithSenderKey(
    input: WorkspaceSenderKeyEncryptInput,
  ): Promise<Uint8Array> {
    await this.loadSwmSenderKeyState();
    const ctx = createOperationContext('share', input.operationId);
    const sender = this.getLocalSigningAgentForAddress(input.senderAgentAddress);
    if (!sender) {
      throw new Error(`Cannot create SWM Sender Key epoch: no local custodial signing key for agent ${input.senderAgentAddress}`);
    }

    const resolution = await resolveWorkspaceAgentRecipients(this.store, { contextGraphId: input.contextGraphId });
    if (!resolution.requiresEncryption) {
      return input.plaintext;
    }
    if (resolution.recipients.length === 0) {
      throw new Error(`Context graph "${input.contextGraphId}" requires Sender Key SWM but has no DKG agent recipients`);
    }

    const senderAddress = ethers.getAddress(sender.agentAddress);
    const recipientSet = new Set(resolution.recipients.map((recipient) => recipient.agentAddress.toLowerCase()));
    if (!recipientSet.has(senderAddress.toLowerCase())) {
      throw new Error(`Sender agent ${senderAddress} is not a DKG agent recipient for context graph "${input.contextGraphId}"`);
    }

    this.logSwmSenderKeyDebugPlainPayload(ctx, 'plain-before-encrypt', input.plaintext, {
      senderAgentAddress: senderAddress,
      contextGraphId: input.contextGraphId,
      subGraphName: input.subGraphName,
    });

    const membershipHash = computeSwmSenderKeyMembershipHash({
      contextGraphId: input.contextGraphId,
      subGraphName: input.subGraphName,
      members: resolution.recipients.map((recipient) => ({
        agentAddress: recipient.agentAddress,
        recipientKeyId: recipient.recipientKeyId,
      })),
    });
    const stateKey = swmSenderStateKey(input.contextGraphId, input.subGraphName, senderAddress);
    let state = this.swmSenderKeySendStates.get(stateKey);
    if (!state || state.membershipHash !== membershipHash) {
      state = await this.createAndDistributeSwmSenderKeyEpoch({
        contextGraphId: input.contextGraphId,
        subGraphName: input.subGraphName,
        sender,
        recipients: resolution.recipients,
        membershipHash,
        ctx,
      });
      this.swmSenderKeySendStates.set(stateKey, state);
      await this.saveSwmSenderKeyState();
    }

    const encrypted = await encryptSwmSenderKeyMessage({
      chainKey: state.chainKey,
      plaintext: input.plaintext,
      senderSigningSecretKey: state.senderSigningSecretKey,
      contextGraphId: state.contextGraphId,
      subGraphName: state.subGraphName,
      senderAgentAddress: state.senderAgentAddress,
      epochId: state.epochId,
      membershipHash: state.membershipHash,
      messageIndex: state.nextMessageIndex,
    });
    state.chainKey = encrypted.nextChainKey;
    state.nextMessageIndex += 1;
    await this.saveSwmSenderKeyState();
    this.logSwmSenderKeyDebugEncryptedPayload(ctx, encrypted.message);

    this.log.info(
      ctx,
      `SWM sender-key broadcast send: senderAgent=${senderAddress} contextGraph=${state.contextGraphId}` +
      `${state.subGraphName ? `/${state.subGraphName}` : ''} epoch=${state.epochId} ` +
      `messageIndex=${uint64ForProto(encrypted.message.messageIndex)} membershipHash=${state.membershipHash} ` +
      `ciphertextBytes=${encrypted.message.ciphertext.length}`,
    );
    return encodeSwmSenderKeyMessage(encrypted.message);
  }

  private async createAndDistributeSwmSenderKeyEpoch(input: {
    contextGraphId: string;
    subGraphName?: string;
    sender: AgentKeyRecord & { privateKey: string };
    recipients: readonly WorkspaceAgentRecipient[];
    membershipHash: string;
    ctx: OperationContext;
  }): Promise<LocalSwmSenderKeySendState> {
    const senderAgentAddress = ethers.getAddress(input.sender.agentAddress);
    const createdAtMs = Date.now();
    const epochId = generateSwmSenderEpochId();
    const chainKey = generateSwmSenderChainKey();
    const senderSigningKeypair = await generateEd25519Keypair();
    const state: LocalSwmSenderKeySendState = {
      contextGraphId: input.contextGraphId,
      subGraphName: input.subGraphName,
      senderAgentAddress,
      epochId,
      membershipHash: input.membershipHash,
      chainKey,
      nextMessageIndex: 0,
      senderSigningSecretKey: senderSigningKeypair.secretKey,
      senderSigningPublicKey: senderSigningKeypair.publicKey,
      createdAtMs,
    };

    for (const recipient of input.recipients) {
      const recipientAgentAddress = ethers.getAddress(recipient.agentAddress);
      const pkg = await this.createSignedSwmSenderKeyPackage({
        state,
        recipient,
        senderPrivateKey: input.sender.privateKey,
      });

      const isLocalRecipient = this.hasLocalAgent(recipientAgentAddress);
      if (isLocalRecipient) {
        await this.acceptSwmSenderKeyPackage(pkg, this.node.peerId.toString(), input.ctx);
        continue;
      }

      if (!recipient.peerId) {
        throw new Error(
          `Cannot distribute SWM Sender Key epoch ${epochId}: DKG agent ${recipientAgentAddress} has no advertised peerId`,
        );
      }

      this.log.info(
        input.ctx,
        `SWM sender-key setup send: senderAgent=${senderAgentAddress} recipientAgent=${recipientAgentAddress} ` +
        `peerId=${recipient.peerId} contextGraph=${state.contextGraphId}${state.subGraphName ? `/${state.subGraphName}` : ''} ` +
        `epoch=${state.epochId} membershipHash=${state.membershipHash} recipientKeyId=${recipient.recipientKeyId}`,
      );
      const ackBytes = await this.messenger.sendToPeer(
        recipient.peerId,
        PROTOCOL_SWM_SENDER_KEY,
        encodeSwmSenderKeyPackage(pkg),
      );
      const ack = decodeSwmSenderKeyPackageAck(ackBytes);
      if (
        ack.version !== SWM_SENDER_KEY_PACKAGE_VERSION ||
        ack.type !== SWM_SENDER_KEY_PACKAGE_ACK_TYPE ||
        !ack.accepted
      ) {
        throw new Error(
          `SWM Sender Key setup rejected by agent ${recipientAgentAddress}: ${ack.reason ?? 'unknown reason'}`,
        );
      }
    }

    return state;
  }

  private async createSignedSwmSenderKeyPackage(input: {
    state: LocalSwmSenderKeySendState;
    recipient: WorkspaceAgentRecipient;
    senderPrivateKey: string;
  }): Promise<SwmSenderKeyPackageMsg> {
    if (!input.recipient.publicKeyBytes) {
      throw new Error(`Missing public encryption key bytes for DKG agent ${input.recipient.agentAddress}`);
    }
    const pkg = await encryptSwmSenderKeyPackage({
      contextGraphId: input.state.contextGraphId,
      subGraphName: input.state.subGraphName,
      senderAgentAddress: input.state.senderAgentAddress,
      epochId: input.state.epochId,
      membershipHash: input.state.membershipHash,
      recipientAgentAddress: ethers.getAddress(input.recipient.agentAddress),
      recipientKeyId: input.recipient.recipientKeyId,
      createdAtMs: input.state.createdAtMs,
      initialMessageIndex: 0,
      chainKey: input.state.chainKey,
      senderSigningPublicKey: input.state.senderSigningPublicKey,
      recipientPublicKey: input.recipient.publicKeyBytes,
    });
    const signature = await new ethers.Wallet(input.senderPrivateKey)
      .signMessage(computeSwmSenderKeyPackageAAD(pkg));
    return { ...pkg, signature: ethers.getBytes(signature) };
  }

  private async handleSwmSenderKeyPackage(data: Uint8Array, fromPeerId: string): Promise<Uint8Array> {
    const ctx = createOperationContext('share');
    let pkg: SwmSenderKeyPackageMsg | undefined;
    try {
      pkg = decodeSwmSenderKeyPackage(data);
      await this.acceptSwmSenderKeyPackage(pkg, fromPeerId, ctx);
      return encodeSwmSenderKeyPackageAck({
        version: SWM_SENDER_KEY_PACKAGE_VERSION,
        type: SWM_SENDER_KEY_PACKAGE_ACK_TYPE,
        accepted: true,
        contextGraphId: pkg.contextGraphId,
        subGraphName: pkg.subGraphName,
        senderAgentAddress: pkg.senderAgentAddress,
        epochId: pkg.epochId,
        membershipHash: pkg.membershipHash,
        recipientAgentAddress: pkg.recipientAgentAddress,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      if (pkg) {
        this.log.warn(
          ctx,
          `SWM sender-key setup receive rejected: senderAgent=${pkg.senderAgentAddress} recipientAgent=${pkg.recipientAgentAddress} ` +
          `fromPeer=${fromPeerId} contextGraph=${pkg.contextGraphId}${pkg.subGraphName ? `/${pkg.subGraphName}` : ''} ` +
          `epoch=${pkg.epochId} membershipHash=${pkg.membershipHash} reason=${reason}`,
        );
      }
      return encodeSwmSenderKeyPackageAck({
        version: SWM_SENDER_KEY_PACKAGE_VERSION,
        type: SWM_SENDER_KEY_PACKAGE_ACK_TYPE,
        accepted: false,
        reason,
        contextGraphId: pkg?.contextGraphId,
        subGraphName: pkg?.subGraphName,
        senderAgentAddress: pkg?.senderAgentAddress,
        epochId: pkg?.epochId,
        membershipHash: pkg?.membershipHash,
        recipientAgentAddress: pkg?.recipientAgentAddress,
      });
    }
  }

  private async acceptSwmSenderKeyPackage(
    pkg: SwmSenderKeyPackageMsg,
    fromPeerId: string,
    ctx: OperationContext,
  ): Promise<void> {
    const senderAgentAddress = ethers.getAddress(pkg.senderAgentAddress);
    const recipientAgentAddress = ethers.getAddress(pkg.recipientAgentAddress);
    const recovered = ethers.verifyMessage(
      computeSwmSenderKeyPackageAAD(pkg),
      ethers.hexlify(pkg.signature),
    );
    if (recovered.toLowerCase() !== senderAgentAddress.toLowerCase()) {
      throw new Error(`Sender Key setup signature recovered ${recovered}, expected ${senderAgentAddress}`);
    }

    const agentGateAddresses = await this.getContextGraphAgentGateAddresses(pkg.contextGraphId);
    if (!agentGateAddresses) {
      throw new Error(`Context graph "${pkg.contextGraphId}" is not DKG-agent gated`);
    }
    const agentGateSet = new Set(agentGateAddresses.map((agent) => agent.toLowerCase()));
    if (!agentGateSet.has(senderAgentAddress.toLowerCase())) {
      throw new Error(`Sender agent ${senderAgentAddress} is not allowed for context graph "${pkg.contextGraphId}"`);
    }
    if (!agentGateSet.has(recipientAgentAddress.toLowerCase())) {
      throw new Error(`Recipient agent ${recipientAgentAddress} is not allowed for context graph "${pkg.contextGraphId}"`);
    }
    if (!this.hasLocalAgent(recipientAgentAddress)) {
      throw new Error(`Recipient agent ${recipientAgentAddress} is not local to this node`);
    }

    const localKey = this.getLocalWorkspaceRecipientPrivateKeys().find((key) => (
      key.recipientId.toLowerCase() === `did:dkg:agent:${recipientAgentAddress}`.toLowerCase() &&
      key.recipientKeyId === pkg.recipientKeyId
    ));
    if (!localKey) {
      throw new Error(`No local X25519 private key for DKG agent ${recipientAgentAddress} key ${pkg.recipientKeyId}`);
    }

    const secret = await decryptSwmSenderKeyPackage({ package: pkg, recipientKey: localKey });
    const state: LocalSwmSenderKeyReceiveState = {
      contextGraphId: secret.contextGraphId,
      subGraphName: secret.subGraphName,
      senderAgentAddress: ethers.getAddress(secret.senderAgentAddress),
      epochId: secret.epochId,
      membershipHash: secret.membershipHash,
      chainKey: secret.chainKey,
      nextMessageIndex: uint64ForProto(secret.initialMessageIndex),
      senderSigningPublicKey: secret.senderSigningPublicKey,
      createdAtMs: uint64ForProto(secret.createdAtMs),
      skippedChainKeys: new Map(),
    };
    this.swmSenderKeyReceiveStates.set(
      swmReceiverStateKey(state.contextGraphId, state.subGraphName, state.senderAgentAddress, state.epochId),
      state,
    );
    await this.saveSwmSenderKeyState();

    this.log.info(
      ctx,
      `SWM sender-key setup receive accepted: senderAgent=${senderAgentAddress} recipientAgent=${recipientAgentAddress} ` +
      `fromPeer=${fromPeerId} contextGraph=${state.contextGraphId}${state.subGraphName ? `/${state.subGraphName}` : ''} ` +
      `epoch=${state.epochId} membershipHash=${state.membershipHash}`,
    );
  }

  private async decryptWorkspacePayloadWithSenderKey(
    message: SwmSenderKeyMessageMsg,
    contextGraphId: string,
    ctx: OperationContext,
  ): Promise<Uint8Array> {
    await this.loadSwmSenderKeyState();
    if (message.contextGraphId !== contextGraphId) {
      throw new Error(`Sender Key message contextGraphId "${message.contextGraphId}" does not match envelope "${contextGraphId}"`);
    }
    const senderAgentAddress = ethers.getAddress(message.senderAgentAddress);
    const state = this.swmSenderKeyReceiveStates.get(
      swmReceiverStateKey(contextGraphId, message.subGraphName, senderAgentAddress, message.epochId),
    );
    if (!state) {
      this.log.warn(
        ctx,
        `SWM sender-key broadcast receive denied: reason=no-state senderAgent=${senderAgentAddress} ` +
        `contextGraph=${contextGraphId}${message.subGraphName ? `/${message.subGraphName}` : ''} ` +
        `epoch=${message.epochId} messageIndex=${uint64ForProto(message.messageIndex)} membershipHash=${message.membershipHash}`,
      );
      throw new Error(`No local Sender Key state for ${senderAgentAddress} epoch ${message.epochId}`);
    }
    if (state.membershipHash !== message.membershipHash) {
      throw new Error(`Sender Key membership hash mismatch for ${senderAgentAddress} epoch ${message.epochId}`);
    }

    const messageIndex = uint64ForProto(message.messageIndex);
    let chainKey = state.skippedChainKeys.get(messageIndex);
    let usedSkippedKey = false;
    if (chainKey) {
      usedSkippedKey = true;
      state.skippedChainKeys.delete(messageIndex);
    } else {
      if (messageIndex < state.nextMessageIndex) {
        throw new Error(`Sender Key replay rejected for index ${messageIndex}`);
      }
      const gap = messageIndex - state.nextMessageIndex;
      if (gap > SWM_SENDER_KEY_SKIPPED_MESSAGE_CACHE_LIMIT) {
        throw new Error(`Sender Key message gap ${gap} exceeds skipped-message cache limit`);
      }
      chainKey = state.chainKey;
      for (let index = state.nextMessageIndex; index < messageIndex; index++) {
        state.skippedChainKeys.set(index, chainKey);
        chainKey = ratchetSwmSenderChainKey(chainKey);
      }
    }

    const decrypted = await decryptSwmSenderKeyMessage({
      chainKey,
      message,
      senderSigningPublicKey: state.senderSigningPublicKey,
    });

    if (!usedSkippedKey) {
      state.chainKey = decrypted.nextChainKey;
      state.nextMessageIndex = messageIndex + 1;
    }
    while (state.skippedChainKeys.size > SWM_SENDER_KEY_SKIPPED_MESSAGE_CACHE_LIMIT) {
      const oldest = [...state.skippedChainKeys.keys()].sort((a, b) => a - b)[0];
      state.skippedChainKeys.delete(oldest);
    }
    await this.saveSwmSenderKeyState();

    this.log.info(
      ctx,
      `SWM sender-key broadcast receive success: senderAgent=${senderAgentAddress} ` +
      `contextGraph=${contextGraphId}${message.subGraphName ? `/${message.subGraphName}` : ''} ` +
      `epoch=${message.epochId} messageIndex=${messageIndex} membershipHash=${message.membershipHash}`,
    );
    this.logSwmSenderKeyDebugPlainPayload(ctx, 'plain-after-decrypt', decrypted.plaintext, {
      senderAgentAddress,
      contextGraphId,
      subGraphName: message.subGraphName,
      epochId: message.epochId,
      membershipHash: message.membershipHash,
      messageIndex,
    });
    return decrypted.plaintext;
  }

  private isSwmSenderKeyPayloadDebugLoggingEnabled(): boolean {
    const raw = process.env.DKG_SWM_SENDER_KEY_DEBUG_PAYLOADS;
    return raw === '1' || raw?.toLowerCase() === 'true';
  }

  private logSwmSenderKeyDebugPlainPayload(
    ctx: OperationContext,
    phase: 'plain-before-encrypt' | 'plain-after-decrypt',
    payload: Uint8Array,
    extra: Record<string, unknown>,
  ): void {
    if (!this.isSwmSenderKeyPayloadDebugLoggingEnabled()) return;
    try {
      const request = decodeWorkspacePublishRequest(payload);
      const nquads = new TextDecoder().decode(request.nquads);
      this.log.warn(ctx, `SWM sender-key DEBUG ${phase}: ${JSON.stringify({
        warning: 'private SWM plaintext debug logging is enabled',
        ...extra,
        shareOperationId: request.shareOperationId,
        operationId: request.operationId,
        requestContextGraphId: request.contextGraphId,
        requestSubGraphName: request.subGraphName,
        nquads,
      })}`);
    } catch (err) {
      this.log.warn(
        ctx,
        `SWM sender-key DEBUG ${phase}: failed to decode plaintext WorkspacePublishRequest: ` +
        `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private logSwmSenderKeyDebugEncryptedPayload(
    ctx: OperationContext,
    message: SwmSenderKeyMessageMsg,
  ): void {
    if (!this.isSwmSenderKeyPayloadDebugLoggingEnabled()) return;
    this.log.warn(ctx, `SWM sender-key DEBUG encrypted-before-broadcast: ${JSON.stringify({
      warning: 'private SWM encrypted payload debug logging is enabled',
      senderAgentAddress: message.senderAgentAddress,
      contextGraphId: message.contextGraphId,
      subGraphName: message.subGraphName,
      epochId: message.epochId,
      membershipHash: message.membershipHash,
      messageIndex: uint64ForProto(message.messageIndex),
      cipherAlgorithm: message.cipherAlgorithm,
      nonceBytes: message.nonce.length,
      ciphertextBytes: message.ciphertext.length,
      ciphertextBase64: Buffer.from(message.ciphertext).toString('base64'),
    })}`);
  }

  private hasLocalAgent(agentAddress: string): boolean {
    const checksum = ethers.getAddress(agentAddress);
    for (const record of this.localAgents.values()) {
      if (record.agentAddress.toLowerCase() === checksum.toLowerCase()) {
        return true;
      }
    }
    return false;
  }

  private getLocalSigningAgentForAddress(agentAddress: string): (AgentKeyRecord & { privateKey: string }) | null {
    const checksum = ethers.getAddress(agentAddress);
    for (const record of this.localAgents.values()) {
      if (record.agentAddress.toLowerCase() === checksum.toLowerCase() && record.privateKey) {
        return { ...record, privateKey: record.privateKey };
      }
    }
    return null;
  }

  private swmSenderKeyStatePath(): string | null {
    if (!this.config.dataDir) return null;
    return `${this.config.dataDir}/swm-sender-keys.json`;
  }

  private async loadSwmSenderKeyState(): Promise<void> {
    if (this.swmSenderKeyStateLoaded) return;
    this.swmSenderKeyStateLoaded = true;
    const path = this.swmSenderKeyStatePath();
    if (!path) return;
    try {
      const { readFile } = await import('node:fs/promises');
      const raw = await readFile(path, 'utf-8');
      const parsed = JSON.parse(raw) as {
        send?: Array<Record<string, unknown>>;
        receive?: Array<Record<string, unknown>>;
      };
      for (const entry of parsed.send ?? []) {
        const state = deserializeSwmSenderSendState(entry);
        this.swmSenderKeySendStates.set(
          swmSenderStateKey(state.contextGraphId, state.subGraphName, state.senderAgentAddress),
          state,
        );
      }
      for (const entry of parsed.receive ?? []) {
        const state = deserializeSwmSenderReceiveState(entry);
        this.swmSenderKeyReceiveStates.set(
          swmReceiverStateKey(state.contextGraphId, state.subGraphName, state.senderAgentAddress, state.epochId),
          state,
        );
      }
    } catch {
      // No durable state yet, or a corrupt file that should not unblock startup.
      this.swmSenderKeySendStates.clear();
      this.swmSenderKeyReceiveStates.clear();
    }
  }

  private async saveSwmSenderKeyState(): Promise<void> {
    const path = this.swmSenderKeyStatePath();
    if (!path) return;
    const { mkdir, writeFile, chmod } = await import('node:fs/promises');
    const { dirname } = await import('node:path');
    await mkdir(dirname(path), { recursive: true });
    const payload = {
      version: 1,
      send: [...this.swmSenderKeySendStates.values()].map(serializeSwmSenderSendState),
      receive: [...this.swmSenderKeyReceiveStates.values()].map(serializeSwmSenderReceiveState),
    };
    await writeFile(path, JSON.stringify(payload, null, 2), { mode: 0o600 });
    try {
      await chmod(path, 0o600);
    } catch {
      // Best-effort on platforms/filesystems that do not support chmod.
    }
  }

  private async resolveWorkspaceGossipSigningAgent(
    contextGraphId: string,
  ): Promise<(AgentKeyRecord & { privateKey: string }) | null> {
    const allowedAgents = await this.getContextGraphAgentGateAddresses(contextGraphId);
    if (!allowedAgents) {
      return this.getWorkspaceGossipSigningAgent();
    }

    const allowedSet = new Set(allowedAgents.map((agent) => agent.toLowerCase()));
    for (const record of this.localAgents.values()) {
      if (record.privateKey && allowedSet.has(record.agentAddress.toLowerCase())) {
        return { ...record, privateKey: record.privateKey };
      }
    }

    throw new Error(`Cannot gossip SWM write for agent-gated context graph "${contextGraphId}": no local allowed signing agent key`);
  }

  private async encodeWorkspaceGossipMessage(
    contextGraphId: string,
    message: Uint8Array,
    resolvedSigner?: (AgentKeyRecord & { privateKey: string }) | null,
  ): Promise<Uint8Array> {
    const signer = resolvedSigner === undefined
      ? await this.resolveWorkspaceGossipSigningAgent(contextGraphId)
      : resolvedSigner;
    if (!signer) {
      return message;
    }

    const timestamp = new Date().toISOString();
    const payload = new Uint8Array(message);
    const signingPayload = computeGossipSigningPayload(
      GOSSIP_TYPE_WORKSPACE_PUBLISH,
      contextGraphId,
      timestamp,
      payload,
    );
    const signature = await new ethers.Wallet(signer.privateKey).signMessage(signingPayload);
    return encodeGossipEnvelope({
      version: GOSSIP_ENVELOPE_VERSION,
      type: GOSSIP_TYPE_WORKSPACE_PUBLISH,
      contextGraphId,
      agentAddress: signer.agentAddress,
      timestamp,
      signature: ethers.getBytes(signature),
      payload,
    });
  }

  private async publishWorkspaceGossip(
    contextGraphId: string,
    message: Uint8Array,
    ctx: OperationContext,
    resolvedSigner?: (AgentKeyRecord & { privateKey: string }) | null,
  ): Promise<void> {
    const topic = contextGraphWorkspaceTopic(contextGraphId);
    const wireMessage = await this.encodeWorkspaceGossipMessage(contextGraphId, message, resolvedSigner);
    try {
      await this.gossip.publish(topic, wireMessage);
    } catch {
      this.log.warn(ctx, `No peers subscribed to ${topic} yet`);
    }
  }

  async publishAsync(
    contextGraphIdOrUal: string,
    content: PublishAsyncContent,
    opts?: PublishAsyncOpts,
  ): Promise<{ captureID: string }> {
    const contextGraphId = normalizePublishContextGraphId(contextGraphIdOrUal);
    const ctx = opts?.operationCtx ?? createOperationContext('publish');

    const exists = await this.contextGraphExists(contextGraphId);
    if (!exists) {
      throw new ContextGraphNotFoundError(contextGraphId);
    }

    // Validate caller-controlled options before workspace staging so a rejected publishAsync leaves no orphan data.
    if (opts?.preSignedAuthorAttestation !== undefined) {
      if (opts?.authorAgentAddress !== undefined) {
        throw new Error('publishAsync: preSignedAuthorAttestation and authorAgentAddress are mutually exclusive');
      }
      if (opts?.authorSignTypedData !== undefined) {
        throw new Error('publishAsync: preSignedAuthorAttestation and authorSignTypedData are mutually exclusive');
      }
    }
    if (opts?.authorSignTypedData !== undefined && opts?.authorAgentAddress === undefined) {
      throw new Error('publishAsync: authorSignTypedData requires authorAgentAddress');
    }
    if (opts?.authorAgentAddress != null && opts.authorSignTypedData == null) {
      const mode = this.getLocalAgentMode(opts.authorAgentAddress);
      if (mode === undefined) {
        throw new Error(`publishAsync: ${opts.authorAgentAddress} is not a registered local agent`);
      }
      if (mode === 'self-sovereign') {
        throw new Error(
          `publishAsync: agent ${opts.authorAgentAddress} is self-sovereign — supply ` +
            'authorSignTypedData callback or preSignedAuthorAttestation instead',
        );
      }
    }

    let publicQuads: Quad[];
    let privateQuads: Quad[];
    try {
      if (isPublishAsyncQuadEnvelope(content)) {
        publicQuads = assertQuadArray(content.publicQuads, 'publicQuads');
        privateQuads = assertQuadArray(content.privateQuads, 'privateQuads');
      } else {
        const parsed = await jsonLdToQuads(content as JsonLdContent, {
          defaultVisibility: 'private',
          syntheticPrivateAnchor: false,
        });
        publicQuads = parsed.publicQuads;
        privateQuads = parsed.privateQuads;
      }
    } catch (err) {
      if (err instanceof InvalidContentError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      throw new InvalidContentError(`Invalid JSON-LD content: ${message}`);
    }

    if (publicQuads.length === 0 && privateQuads.length === 0) {
      throw new InvalidContentError('Content must include at least one public or private payload');
    }

    const partitioned = partitionPublishAsyncQuads(publicQuads, privateQuads);
    const gossipSigner = opts?.localOnly ? null : await this.resolveWorkspaceGossipSigningAgent(contextGraphId);
    const { shareOperationId, message } = await this.publisher.writeToWorkspace(
      contextGraphId,
      partitioned.publicQuads,
      {
        publisherPeerId: this.peerId,
        operationCtx: ctx,
        subGraphName: opts?.subGraphName,
        localOnly: opts?.localOnly,
        senderAgentAddress: gossipSigner?.agentAddress,
      },
    );

    if (partitioned.privateQuadsByRoot.size > 0) {
      const privateStore = new PrivateContentStore(this.store, new GraphManager(this.store));
      for (const [rootEntity, rootPrivateQuads] of partitioned.privateQuadsByRoot) {
        await privateStore.storePrivateTriplesForOperation(
          contextGraphId,
          shareOperationId,
          rootEntity,
          rootPrivateQuads,
          opts?.subGraphName,
        );
      }
    }

    const liftRequestDraft = {
      swmId: shareOperationId,
      shareOperationId,
      roots: partitioned.roots,
      contextGraphId,
      namespace: opts?.namespace ?? 'async-publish',
      scope: opts?.scope ?? 'context-graph',
      transitionType: opts?.transitionType ?? 'CREATE',
      authority: opts?.authority ?? { type: 'owner', proofRef: `urn:dkg:publish-async:${shareOperationId}` },
      priorVersion: opts?.priorVersion,
      subGraphName: opts?.subGraphName,
      accessPolicy: opts?.accessPolicy,
      allowedPeers: opts?.allowedPeers,
      entityProofs: opts?.entityProofs,
      // Stringify bigint for JSON-safe persistence; preserve `0n` (mode d).
      publisherNodeIdentityIdOverride: opts?.publisherNodeIdentityIdOverride !== undefined
        ? (opts.publisherNodeIdentityIdOverride.toString() as `${bigint}`)
        : undefined,
    } as const;

    // Seal-build: caller-callback errors propagate; daemon-internal misses degrade to sealless (sync `_publish` parity).
    let seal: LiftRequestAuthorSeal | undefined;
    if (opts?.preSignedAuthorAttestation) {
      seal = preSignedAttestationToLiftSeal(opts.preSignedAuthorAttestation);
    } else if (opts?.authorSignTypedData !== undefined) {
      seal = await this.buildAsyncLiftSeal(liftRequestDraft, opts?.authorAgentAddress, opts.authorSignTypedData);
    } else {
      try {
        seal = await this.buildAsyncLiftSeal(liftRequestDraft, opts?.authorAgentAddress, undefined);
      } catch (err) {
        this.log.warn(ctx, `Async seal mint failed; on-chain publish will fall back to tentative: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const asyncPublisher = new TripleStoreAsyncLiftPublisher(this.store, {
      publicSnapshotStore: this.publicSnapshotStore,
    });
    const captureID = await asyncPublisher.lift({
      ...liftRequestDraft,
      ...(seal !== undefined ? { seal } : {}),
    });

    if (!opts?.localOnly) {
      await this.publishWorkspaceGossip(contextGraphId, message, ctx, gossipSigner);
    }

    return { captureID };
  }

  /** Build the EIP-712 author seal for the lift request. Runs the same
   *  canonicalization + subtraction pipeline as the publisher so the
   *  merkle matches at processNext-time. Returns undefined on non-V10 chains. */
  private async buildAsyncLiftSeal(
    request: {
      readonly contextGraphId: string;
      readonly subGraphName?: string;
      readonly shareOperationId: string;
      readonly roots: readonly string[];
      readonly namespace: string;
      readonly scope: string;
      readonly transitionType: LiftTransitionType;
      readonly authority: LiftAuthorityProof;
      readonly priorVersion?: string;
      readonly accessPolicy?: 'public' | 'ownerOnly' | 'allowList';
      readonly allowedPeers?: readonly string[];
      readonly swmId: string;
    },
    authorAgentAddress?: string,
    authorSignTypedData?: (typedData: AuthorAttestationTypedData) => Promise<{ r: Uint8Array; vs: Uint8Array }>,
  ): Promise<LiftRequestAuthorSeal | undefined> {
    if (this.chain.isV10Ready?.() !== true) return undefined;
    if (typeof this.chain.getEvmChainId !== 'function') return undefined;
    if (typeof this.chain.getKnowledgeAssetsV10Address !== 'function') return undefined;

    const onChainId = await this.getContextGraphOnChainId(request.contextGraphId);
    if (onChainId == null) return undefined; // CG not on-chain — publisher goes tentative


    const chainId = await this.chain.getEvmChainId();
    const kav10Address = await this.chain.getKnowledgeAssetsV10Address();
    if (chainId === undefined || kav10Address === undefined) return undefined;

    const graphManager = new GraphManager(this.store);
    const resolved = await resolveLiftWorkspaceSlice({
      request,
      store: this.store,
      graphManager,
    });

    // Rewrite raw root URIs (urn:uuid:…) → canonical (dkg:cg:ns:scope/…-hash).
    const validated = validateLiftPublishPayload({
      request: { ...request, authority: request.authority } as LiftRequest,
      resolved,
    });

    // Strip already-finalized quads (no-op for non-CREATE). Matches publisher.
    const subtracted = await subtractFinalizedExactQuads({
      store: this.store,
      graphManager,
      request: { ...request, authority: request.authority } as LiftRequest,
      validation: validated.validation,
      resolved: validated.resolved,
    });

    // Full overlap → publisher returns noop without checking the seal.
    if (
      subtracted.resolved.quads.length === 0 &&
      (subtracted.resolved.privateQuads?.length ?? 0) === 0
    ) {
      return undefined;
    }

    const canonical = canonicalPublishPayload(
      subtracted.resolved.quads,
      subtracted.resolved.privateQuads ?? [],
    );

    // Resolve author: callback → custodial keystore → publisher fallback. User-input pre-validated in publishAsync entry.
    let authorAddress: string;
    let signerPrivateKey: string | undefined;
    if (authorSignTypedData !== undefined) {
      authorAddress = authorAgentAddress as string;
    } else if (authorAgentAddress != null) {
      signerPrivateKey = this.getCustodialAgentPrivateKey(authorAgentAddress);
      if (!signerPrivateKey) return undefined;
      authorAddress = authorAgentAddress;
    } else {
      const fallback = await this.publisher.publisherFallbackAuthorAddress();
      if (!fallback) return undefined;
      authorAddress = fallback;
    }

    const typedData = buildAuthorAttestationTypedData({
      chainId,
      kav10Address,
      contextGraphId: BigInt(onChainId),
      merkleRoot: canonical.kcMerkleRoot,
      authorAddress,
      schemeVersion: AUTHOR_SCHEME_VERSION_V1,
    });

    const { r, vs } = await (
      authorSignTypedData !== undefined
        ? authorSignTypedData(typedData)
        : signerPrivateKey
          ? signWithPrivateKey(signerPrivateKey, typedData)
          : this.publisher.signAuthorAttestationAsPublisher(typedData)
    );

    return {
      merkleRoot: ethers.hexlify(canonical.kcMerkleRoot) as `0x${string}`,
      authorAddress: authorAddress as `0x${string}`,
      signature: {
        r: ethers.hexlify(r) as `0x${string}`,
        vs: ethers.hexlify(vs) as `0x${string}`,
      },
      schemeVersion: AUTHOR_SCHEME_VERSION_V1,
    };
  }

  private async _publish(
    contextGraphId: string,
    quads: Quad[],
    privateQuads?: Quad[],
    opts?: PublishOpts,
  ): Promise<PublishResult> {
    const ctx = opts?.operationCtx ?? createOperationContext('publish');
    const onPhase = opts?.onPhase;
    this.log.info(ctx, `Starting publish to context graph "${contextGraphId}" with ${quads.length} triples`);

    const isSystem = contextGraphId === SYSTEM_CONTEXT_GRAPHS.AGENTS || contextGraphId === SYSTEM_CONTEXT_GRAPHS.ONTOLOGY;
    if (!isSystem) {
      const exists = await this.contextGraphExists(contextGraphId);
      if (!exists) {
        throw new Error(
          `Context graph "${contextGraphId}" does not exist. Create it first with createContextGraph().`,
        );
      }
    }
    const v10ACKProvider = this.createV10ACKProvider(contextGraphId);

    const onChainId = await this.getContextGraphOnChainId(contextGraphId);

    // RFC-001 §9.x — sign-at-creation. The publisher refuses on-chain
    // publishes without a `precomputedAttestation`, so the agent
    // mints one here at the publish boundary using the publisher
    // fallback signer (legacy `agent.publish(quads)` callers don't
    // carry author identity hints — mode (a) of Phase 4: daemon signs
    // as itself). The seal binds (chainId, kav10Address,
    // contextGraphId, merkleRoot, authorAddress); any drift between
    // the agent-computed merkleRoot and the publisher's recompute
    // surfaces as the publisher's `expectedMerkleRoot mismatch`
    // guard. Skip when the chain isn't V10-capable or the CG isn't
    // on-chain — the publisher will go tentative anyway.
    let precomputedAttestation: PublishOptions['precomputedAttestation'];
    if (
      onChainId != null &&
      typeof this.chain.getEvmChainId === 'function' &&
      typeof this.chain.getKnowledgeAssetsV10Address === 'function'
    ) {
      try {
        precomputedAttestation = await this._buildPrecomputedAttestationForSelection(
          contextGraphId,
          quads,
          {
            targetOnChainCgId: onChainId,
            // Round 4 review §11 — propagate privateQuads so the
            // pre-seal merkle includes their per-entity private roots
            // (the publisher computes `kcMerkleRoot` over public
            // leaves + privateRoots; without this, every V10 publish
            // with private content silently downgrades to tentative on
            // the publisher's `expectedMerkleRoot` guard).
            privateQuads,
          },
        );
      } catch (err) {
        this.log.warn(
          ctx,
          `Inline seal mint failed; on-chain publish will fall back to tentative: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    const result = await this.publisher.publish({
      contextGraphId,
      quads,
      privateQuads,
      publisherPeerId: this.peerId,
      accessPolicy: opts?.accessPolicy,
      allowedPeers: opts?.allowedPeers,
      subGraphName: opts?.subGraphName,
      operationCtx: ctx,
      onPhase,
      v10ACKProvider,
      publishContextGraphId: onChainId ?? undefined,
      precomputedAttestation,
    });

    onPhase?.('broadcast', 'start');
    this.log.info(ctx, `Local publish complete, broadcasting to peers`);
    await this.broadcastPublish(contextGraphId, result, ctx);
    onPhase?.('broadcast', 'end');
    this.log.info(ctx, `Publish complete — status=${result.status} kcId=${result.kcId}`);
    return result;
  }

  async update(
    kcId: bigint, contextGraphId: string, quads: Quad[], privateQuads?: Quad[],
    opts?: { onPhase?: PhaseCallback; operationCtx?: OperationContext },
  ): Promise<PublishResult> {
    const ctx = opts?.operationCtx ?? createOperationContext('update');
    const onPhase = opts?.onPhase;
    this.log.info(ctx, `Starting update of kcId=${kcId} in context graph "${contextGraphId}" with ${quads.length} triples`);
    const result = await this.publisher.update(kcId, {
      contextGraphId,
      quads,
      privateQuads,
      publisherPeerId: this.node.peerId.toString(),
      operationCtx: ctx,
      onPhase,
    });
    this.log.info(ctx, `Update complete — status=${result.status}`);

    onPhase?.('broadcast', 'start');
    if (result.onChainResult && result.publicQuads) {
      try {
        const dataGraph = `did:dkg:context-graph:${contextGraphId}`;
        const nquadsStr = result.publicQuads
          .map((q) => `<${q.subject}> <${q.predicate}> ${q.object.startsWith('"') ? q.object : `<${q.object}>`} <${dataGraph}> .`)
          .join('\n');
        const nquadsBytes = new TextEncoder().encode(nquadsStr);
        const message = encodeKAUpdateRequest({
          contextGraphId: contextGraphId,
          batchId: kcId,
          nquads: nquadsBytes,
          manifest: result.kaManifest.map((m) => ({
            rootEntity: m.rootEntity,
            privateMerkleRoot: m.privateMerkleRoot,
            privateTripleCount: m.privateTripleCount ?? 0,
          })),
          publisherPeerId: this.node.peerId.toString(),
          publisherAddress: result.onChainResult.publisherAddress,
          txHash: result.onChainResult.txHash,
          blockNumber: result.onChainResult.blockNumber,
          newMerkleRoot: result.merkleRoot,
          timestampMs: Date.now(),
          operationId: ctx.operationId,
        });
        const topic = contextGraphUpdateTopic(contextGraphId);
        await this.gossip.publish(topic, message);
        this.log.info(ctx, `Broadcast KA update for batchId=${kcId} on ${topic}`);
      } catch (err) {
        this.log.warn(ctx, `Failed to broadcast KA update: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    onPhase?.('broadcast', 'end');

    return result;
  }

  /**
   * Write quads to the context graph's shared memory (no chain, no TRAC).
   * When localOnly is false (default), replicates via GossipSub shared memory topic.
   * When localOnly is true, stores locally without broadcasting — use for private data.
   */
  async share(contextGraphId: string, quads: Quad[], opts?: { localOnly?: boolean; operationCtx?: OperationContext; subGraphName?: string; callerAgentAddress?: string }): Promise<{ shareOperationId: string }> {
    const ctx = opts?.operationCtx ?? createOperationContext('share');
    const sgLabel = opts?.subGraphName ? ` (sub-graph: ${opts.subGraphName})` : '';
    this.log.info(ctx, `Sharing ${quads.length} quads to SWM for context graph ${contextGraphId}${sgLabel}${opts?.localOnly ? ' (local-only)' : ''}`);
    const shouldCreateImplicitContextGraph = await this.shouldCreateImplicitSharedMemoryContextGraph(contextGraphId);
    const gossipSigner = opts?.localOnly ? null : await this.resolveWorkspaceGossipSigningAgent(contextGraphId);
    const { shareOperationId, message } = await this.publisher.writeToWorkspace(contextGraphId, quads, {
      publisherPeerId: this.node.peerId.toString(),
      operationCtx: ctx,
      subGraphName: opts?.subGraphName,
      localOnly: opts?.localOnly,
      senderAgentAddress: gossipSigner?.agentAddress,
    });
    if (shouldCreateImplicitContextGraph) {
      await this.ensureImplicitSharedMemoryContextGraph(contextGraphId, {
        callerAgentAddress: opts?.callerAgentAddress,
      });
    }
    if (!opts?.localOnly) {
      await this.publishWorkspaceGossip(contextGraphId, message, ctx, gossipSigner);
    }
    return { shareOperationId };
  }

  /**
   * Compare-and-swap shared memory write. Verifies each condition against the
   * current shared memory graph before applying the write atomically.
   * Throws StaleWriteError if any condition fails.
   */
  async conditionalShare(
    contextGraphId: string,
    quads: Quad[],
    conditions: CASCondition[],
    opts?: { localOnly?: boolean; operationCtx?: OperationContext; subGraphName?: string; callerAgentAddress?: string },
  ): Promise<{ shareOperationId: string }> {
    const ctx = opts?.operationCtx ?? createOperationContext('share');
    const sgLabel = opts?.subGraphName ? ` (sub-graph: ${opts.subGraphName})` : '';
    this.log.info(ctx, `CAS write: ${quads.length} quads, ${conditions.length} conditions for ${contextGraphId}${sgLabel}`);
    const shouldCreateImplicitContextGraph = await this.shouldCreateImplicitSharedMemoryContextGraph(contextGraphId);
    const gossipSigner = opts?.localOnly ? null : await this.resolveWorkspaceGossipSigningAgent(contextGraphId);
    const { shareOperationId, message } = await this.publisher.writeConditionalToWorkspace(contextGraphId, quads, {
      publisherPeerId: this.node.peerId.toString(),
      operationCtx: ctx,
      conditions,
      subGraphName: opts?.subGraphName,
      localOnly: opts?.localOnly,
      senderAgentAddress: gossipSigner?.agentAddress,
    });
    if (shouldCreateImplicitContextGraph) {
      await this.ensureImplicitSharedMemoryContextGraph(contextGraphId, {
        callerAgentAddress: opts?.callerAgentAddress,
      });
    }
    if (!opts?.localOnly) {
      await this.publishWorkspaceGossip(contextGraphId, message, ctx, gossipSigner);
    }
    return { shareOperationId };
  }

  private async hasAuthoritativeContextGraphDefinition(contextGraphId: string): Promise<boolean> {
    const contextGraphUri = contextGraphDataGraphUri(contextGraphId);
    const ontologyGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
    const cgMetaGraph = contextGraphMetaGraphUri(contextGraphId);
    const result = await this.store.query(`
      ASK WHERE {
        {
          GRAPH <${ontologyGraph}> {
            <${contextGraphUri}> <${DKG_ONTOLOGY.RDF_TYPE}> <${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}> .
          }
        }
        UNION
        {
          GRAPH <${cgMetaGraph}> {
            <${contextGraphUri}> <${DKG_ONTOLOGY.RDF_TYPE}> <${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}> .
          }
        }
      }
    `);
    return result.type === 'boolean' && result.value === true;
  }

  private async shouldCreateImplicitSharedMemoryContextGraph(contextGraphId: string): Promise<boolean> {
    if (await this.hasAuthoritativeContextGraphDefinition(contextGraphId)) {
      return false;
    }

    if ((await this.getContextGraphAgentGateAddresses(contextGraphId)) !== null) {
      return false;
    }

    const existingSub = this.subscribedContextGraphs.get(contextGraphId);
    if (existingSub?.metaSynced === false) {
      throw new Error(
        `Context graph "${contextGraphId}" is awaiting metadata sync; refusing to infer public metadata from an SWM write`,
      );
    }

    return true;
  }

  private async ensureImplicitSharedMemoryContextGraph(
    contextGraphId: string,
    opts: { callerAgentAddress?: string } = {},
  ): Promise<void> {
    if (!(await this.shouldCreateImplicitSharedMemoryContextGraph(contextGraphId))) {
      return;
    }

    const gm = new GraphManager(this.store);
    const contextGraphUri = contextGraphDataGraphUri(contextGraphId);
    const ontologyGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
    const cgMetaGraph = contextGraphMetaGraphUri(contextGraphId);
    const now = new Date().toISOString();
    const existingSub = this.subscribedContextGraphs.get(contextGraphId);
    const name = existingSub?.name ?? contextGraphId;
    const curatorAgentAddress = opts.callerAgentAddress ?? this.defaultAgentAddress ?? this.peerId;
    const quads: Quad[] = [
      { subject: contextGraphUri, predicate: DKG_ONTOLOGY.RDF_TYPE, object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH, graph: ontologyGraph },
      { subject: contextGraphUri, predicate: DKG_ONTOLOGY.SCHEMA_NAME, object: `"${escapeSparqlLiteral(name)}"`, graph: ontologyGraph },
      { subject: contextGraphUri, predicate: DKG_ONTOLOGY.DKG_CREATOR, object: `did:dkg:agent:${this.peerId}`, graph: ontologyGraph },
      { subject: contextGraphUri, predicate: DKG_ONTOLOGY.DKG_CREATED_AT, object: `"${now}"`, graph: ontologyGraph },
      { subject: contextGraphUri, predicate: DKG_ONTOLOGY.DKG_GOSSIP_TOPIC, object: `"${contextGraphPublishTopic(contextGraphId)}"`, graph: ontologyGraph },
      { subject: contextGraphUri, predicate: DKG_ONTOLOGY.DKG_REPLICATION_POLICY, object: '"full"', graph: ontologyGraph },
      { subject: contextGraphUri, predicate: DKG_ONTOLOGY.DKG_ACCESS_POLICY, object: '"public"', graph: ontologyGraph },
      { subject: contextGraphUri, predicate: DKG_ONTOLOGY.DKG_REGISTRATION_STATUS, object: '"unregistered"', graph: cgMetaGraph },
      { subject: contextGraphUri, predicate: DKG_ONTOLOGY.DKG_CURATOR, object: `did:dkg:agent:${curatorAgentAddress}`, graph: cgMetaGraph },
    ];

    await this.store.insert(quads);
    await gm.ensureContextGraph(contextGraphId);
    await this.store.flush?.();
    this.subscribeToContextGraph(contextGraphId);
    this.setContextGraphSubscription(contextGraphId, {
      ...existingSub,
      name,
      subscribed: true,
      synced: true,
      metaSynced: true,
    });

    if (curatorAgentAddress) {
      this.upsertContextGraphMember({
        contextGraphId,
        principalType: 'agent',
        principalId: curatorAgentAddress,
        role: 'curator',
        status: 'active',
        source: 'implicit-swm-write',
      });
    }

    this.log.info(
      createOperationContext('share'),
      `Implicitly registered public context graph "${contextGraphId}" from first SWM write`,
    );
  }

  /**
   * RFC-001 §9.x — finalize an assertion: compute merkleRoot, build the
   * EIP-712 AuthorAttestation typed data, sign (or accept pre-signed),
   * and write seal triples to the CG `_meta` graph keyed by the
   * assertion URI.
   *
   * Implementation lives on the class (not inside the `assertion` getter
   * closure) so that the substantial business logic — keystore lookup,
   * EIP-712 binding, idempotency check, seal write — is independently
   * testable and visible in stack traces.
   *
   * See `assertion.finalize` (the public-facing wrapper) for usage docs.
   */
  async assertionFinalize(
    contextGraphId: string,
    name: string,
    agentAddress: string,
    opts?: {
      subGraphName?: string;
      authorAgentAddress?: string;
      preSignedAuthorAttestation?: PreSignedAuthorAttestation;
      schemeVersion?: number;
    },
  ): Promise<{
    assertionUri: string;
    merkleRoot: Uint8Array;
    authorAddress: string;
    schemeVersion: number;
    chainId: bigint;
    kav10Address: string;
    eip712Digest: string;
  }> {
    if (
      opts?.authorAgentAddress != null &&
      opts?.preSignedAuthorAttestation != null
    ) {
      throw new Error(
        'assertionFinalize: authorAgentAddress and preSignedAuthorAttestation are mutually exclusive',
      );
    }

    // 1. Resolve URIs.
    const assertionUri = contextGraphAssertionUri(
      contextGraphId,
      agentAddress,
      name,
      opts?.subGraphName,
    );
    const metaGraph = contextGraphMetaUri(contextGraphId);

    // 2. Pull the assertion's quads. Refuse to finalize an empty
    //    assertion — there's nothing to commit.
    const rawQuads = await this.publisher.assertionQuery(
      contextGraphId,
      name,
      agentAddress,
      opts?.subGraphName,
    );
    if (rawQuads.length === 0) {
      throw new Error(
        `Cannot finalize assertion <${assertionUri}>: it has no quads. ` +
          `Write at least one quad with /api/assertion/${name}/write before finalizing.`,
      );
    }

    // 2b. Apply the same `isReservedSubject` filter that
    //     `assertionPromote` runs at promote time. WM-only bookkeeping
    //     rows in the `urn:dkg:file:` / `urn:dkg:extraction:` namespaces
    //     (file descriptors, ExtractionProvenance blocks — see
    //     `19_MARKDOWN_CONTENT_TYPE.md §10.2`) are stripped before the
    //     assertion crosses the SWM boundary, so the seal MUST hash
    //     the post-strip set or it commits to a root the publish path
    //     can never recompute. (Round 4 review §8 — "assertionFinalize
    //     hashes WM-only urn:dkg:file: rows".)
    const quads = rawQuads.filter((q) => !isReservedSubject(q.subject));
    if (quads.length === 0) {
      throw new Error(
        `Cannot finalize assertion <${assertionUri}>: every quad has a ` +
          `reserved-namespace subject (urn:dkg:file:* / urn:dkg:extraction:*) ` +
          `which is filtered out before SWM. Add at least one user-authored ` +
          `quad on a non-reserved subject before finalizing.`,
      );
    }

    // 3. Compute merkleRoot using the SAME algorithm the publisher
    //    uses at publish-time (V10: keccak256-based merkle, sort+dedupe
    //    leaves). Drift between these two compute paths is the silent
    //    failure mode this whole architecture is trying to eliminate —
    //    so we reuse the publisher's exported helpers verbatim.
    //
    //    Round 5 review §1 — `kaMap` may contain unsafe-IRI roots
    //    (e.g. RFC-3987-valid IRIs with `|` `^` etc that fail
    //    `isSafeIri`'s SPARQL-interpolation rules). Those cannot be
    //    referenced from the SPARQL CONSTRUCT that
    //    `publishFromFinalizedAssertion` uses to reload the
    //    promoted-SWM payload, so they MUST NOT contribute to the
    //    sealed merkleRoot — otherwise the seal commits to a root
    //    the publish path can never recompute. Reject finalize
    //    instead of silently dropping content: silent-drop hides a
    //    real input error and would let a partial assertion ship
    //    with a seal that doesn't cover all of its quads.
    //    Defense-in-depth: the current oxigraph storage adapter
    //    rejects most unsafe characters at write time, so this guard
    //    is rarely triggered through `assertion.write`. It still
    //    matters for non-oxigraph adapters and for code paths that
    //    seed the WM graph directly (bulk-import / `_meta` fixtures
    //    / future storage backends). The canonical wire pin lives
    //    at `core/test/assertion-seal-root-entities.test.ts` —
    //    `buildAssertionSealQuads` rejects unsafe roots at the seal
    //    boundary. This guard surfaces the same failure earlier
    //    with a more actionable message.
    const kaMap = autoPartition(quads);
    const allRootEntities = [...kaMap.keys()];
    const unsafeRootEntities = allRootEntities.filter((r) => !isSafeIri(r));
    if (unsafeRootEntities.length > 0) {
      const sample = unsafeRootEntities
        .slice(0, 3)
        .map((r) => `<${r}>`)
        .join(', ');
      const more = unsafeRootEntities.length > 3 ? ` (+${unsafeRootEntities.length - 3} more)` : '';
      throw new Error(
        `Cannot finalize assertion <${assertionUri}>: ${unsafeRootEntities.length} root ` +
          `entit${unsafeRootEntities.length === 1 ? 'y has' : 'ies have'} an unsafe IRI: ${sample}${more}. ` +
          `The publish path reloads SWM via SPARQL CONSTRUCT scoped to these roots — unsafe IRIs ` +
          `would be filtered, recomputing a different merkleRoot from the truncated payload, so the ` +
          `sealed assertion could never be republished. Rename these subjects to safe IRIs ` +
          `(no blank nodes, control chars, or unbalanced delimiters) before finalizing.`,
      );
    }
    const allSkolemizedQuads = [...kaMap.values()].flat();
    const merkleRoot = computeFlatKCRoot(allSkolemizedQuads, []);
    // 3b. Capture rootEntities from the SAME `autoPartition` call that
    //     drives the merkle leaves. The seal binds these so
    //     `publishFromFinalizedAssertion` can scope its SWM CONSTRUCT
    //     instead of bundling everything currently sitting in shared
    //     memory (Round 4 review §9). Now safe by construction — the
    //     guard above guarantees every key passes `isSafeIri`.
    const rootEntities = allRootEntities;
    if (rootEntities.length === 0) {
      throw new Error(
        `Cannot finalize assertion <${assertionUri}>: autoPartition produced ` +
          `no root entities. The assertion has no quads; add at least one ` +
          `user-authored quad on a non-reserved subject before finalizing.`,
      );
    }

    // 4. Idempotency: if a seal already exists for this assertion,
    //    return it as-is when the merkleRoot matches. Mismatch means
    //    the assertion was mutated since the previous finalize —
    //    refuse to overwrite silently.
    const existingMetaResult = await this.store.query(
      `CONSTRUCT { <${assertionUri}> ?p ?o } WHERE { GRAPH <${metaGraph}> { <${assertionUri}> ?p ?o } }`,
    );
    const existingMetaQuads =
      existingMetaResult.type === 'quads' ? existingMetaResult.quads : [];
    let existingSeal: AssertionSeal | undefined;
    try {
      existingSeal = parseAssertionSealQuads(existingMetaQuads, assertionUri);
    } catch (err) {
      // Corrupt seal — surface to the caller. Do NOT silently overwrite
      // because the original author's signature is still on record and
      // overwriting would lose the audit trail.
      throw new Error(
        `assertionFinalize: existing _meta seal for <${assertionUri}> is corrupt: ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
    if (existingSeal) {
      if (
        existingSeal.merkleRoot.length !== merkleRoot.length ||
        !existingSeal.merkleRoot.every((b, i) => b === merkleRoot[i])
      ) {
        throw new Error(
          `assertionFinalize: assertion <${assertionUri}> is already finalized with a ` +
            `different merkleRoot (existing=${ethers.hexlify(existingSeal.merkleRoot)}, ` +
            `current=${ethers.hexlify(merkleRoot)}). Discard and re-create the assertion if ` +
            `you intended to change its content; in-place mutation of a finalized assertion ` +
            `breaks the author signature and is rejected.`,
        );
      }
      // Seal exists and matches — return the existing record.
      const typedData = buildAuthorAttestationTypedData({
        chainId: existingSeal.chainId,
        kav10Address: existingSeal.kav10Address,
        contextGraphId: await this.requireOnChainContextGraphId(contextGraphId),
        merkleRoot: existingSeal.merkleRoot,
        authorAddress: existingSeal.authorAddress,
        schemeVersion: existingSeal.authorSchemeVersion,
      });
      return {
        assertionUri,
        merkleRoot: existingSeal.merkleRoot,
        authorAddress: existingSeal.authorAddress,
        schemeVersion: existingSeal.authorSchemeVersion,
        chainId: existingSeal.chainId,
        kav10Address: existingSeal.kav10Address,
        eip712Digest: ethers.TypedDataEncoder.hash(
          typedData.domain,
          typedData.types,
          typedData.message,
        ),
      };
    }

    // 5. Resolve chain identity. Finalize commits to a specific
    //    `(chainId, kav10Address)` pair — both must be available.
    if (
      typeof this.chain.getEvmChainId !== 'function' ||
      typeof this.chain.getKnowledgeAssetsV10Address !== 'function'
    ) {
      throw new Error(
        'assertionFinalize requires a V10-capable chain adapter that exposes ' +
          'getEvmChainId() and getKnowledgeAssetsV10Address(); the current adapter does not.',
      );
    }
    const chainId = await this.chain.getEvmChainId();
    const kav10Address = await this.chain.getKnowledgeAssetsV10Address();

    // 6. Resolve the on-chain CG id — the EIP-712 digest binds to it.
    const onChainCgId = await this.requireOnChainContextGraphId(contextGraphId);

    // 7. Resolve author. preSigned > custodial agent > publisher fallback.
    const schemeVersion = opts?.schemeVersion ?? AUTHOR_SCHEME_VERSION_V1;
    let authorAddress: string;
    let signerPrivateKey: string | undefined;
    let preSigned: PreSignedAuthorAttestation | undefined;
    if (opts?.preSignedAuthorAttestation != null) {
      preSigned = opts.preSignedAuthorAttestation;
      authorAddress = preSigned.address;
    } else if (opts?.authorAgentAddress != null) {
      const mode = this.getLocalAgentMode(opts.authorAgentAddress);
      if (mode === undefined) {
        throw new Error(
          `assertionFinalize: authorAgentAddress ${opts.authorAgentAddress} is not a registered local agent on this node`,
        );
      }
      if (mode === 'self-sovereign') {
        throw new Error(
          `assertionFinalize: agent ${opts.authorAgentAddress} is registered as self-sovereign — ` +
            `this node does not hold its private key. Use preSignedAuthorAttestation instead.`,
        );
      }
      signerPrivateKey = this.getCustodialAgentPrivateKey(opts.authorAgentAddress);
      if (!signerPrivateKey) {
        throw new Error(
          `assertionFinalize: custodial agent ${opts.authorAgentAddress} has no private key on file`,
        );
      }
      authorAddress = opts.authorAgentAddress;
    } else {
      // Publisher-wallet fallback: use the daemon's own publisher EOA
      // as the author. This preserves Phase 4 mode (a) — node admin
      // signs on its own behalf when no agent attribution is supplied.
      const fallbackAddress = await this.publisher.publisherFallbackAuthorAddress();
      if (!fallbackAddress) {
        throw new Error(
          'assertionFinalize: no agent override supplied and no publisher signer is available. ' +
            'Either supply authorAgentAddress / preSignedAuthorAttestation, or configure a publisher private key on the daemon.',
        );
      }
      authorAddress = fallbackAddress;
    }

    // 8. Build EIP-712 typed data.
    const typedData = buildAuthorAttestationTypedData({
      chainId,
      kav10Address,
      contextGraphId: onChainCgId,
      merkleRoot,
      authorAddress,
      schemeVersion,
    });
    const eip712Digest = ethers.TypedDataEncoder.hash(
      typedData.domain,
      typedData.types,
      typedData.message,
    );

    // 9. Produce the compact signature (r, vs).
    let r: Uint8Array;
    let vs: Uint8Array;
    if (preSigned) {
      const sig = ethers.Signature.from({
        r: ethers.hexlify(preSigned.signature.r),
        yParityAndS: ethers.hexlify(preSigned.signature.vs),
      });
      // Off-chain seal-integrity preflight: only EOAs can be verified
      // by ECDSA recover-and-compare. For smart-contract authors
      // (incl. EIP-7702-delegated EOAs), the on-chain
      // `_verifyAuthorAttestation` dispatches to
      // `IERC1271.isValidSignature` and is the authoritative check —
      // the off-chain ECDSA recover would (correctly) report a
      // mismatch since 1271 wallets typically sign through an owner
      // EOA that's distinct from the wallet contract address. Skip the
      // off-chain check for contract authors so the seal-build pipeline
      // doesn't reject 1271 publishes that the chain would accept.
      const isContractAuthor =
        typeof this.chain.hasContractCode === 'function'
          ? await this.chain.hasContractCode(authorAddress)
          : false;
      if (!isContractAuthor) {
        const recovered = ethers.recoverAddress(eip712Digest, sig);
        if (recovered.toLowerCase() !== authorAddress.toLowerCase()) {
          throw new Error(
            `assertionFinalize: preSignedAuthorAttestation signer mismatch — ` +
              `signature recovers ${recovered} but address claims ${authorAddress}.`,
          );
        }
      }
      r = preSigned.signature.r;
      vs = preSigned.signature.vs;
    } else if (signerPrivateKey) {
      const wallet = new ethers.Wallet(
        signerPrivateKey.startsWith('0x') ? signerPrivateKey : '0x' + signerPrivateKey,
      );
      const sigHex = await wallet.signTypedData(
        typedData.domain,
        typedData.types,
        typedData.message,
      );
      const sig = ethers.Signature.from(sigHex);
      r = ethers.getBytes(sig.r);
      vs = ethers.getBytes(sig.yParityAndS);
    } else {
      // Publisher fallback: ask the publisher to sign with its own
      // wallet. Returns the compact (r, vs) form.
      const compact = await this.publisher.signAuthorAttestationAsPublisher(typedData);
      r = compact.r;
      vs = compact.vs;
    }

    // 10. Persist the seal as `_meta` triples.
    const finalizedAtIso = new Date().toISOString();
    const sealQuads = buildAssertionSealQuads({
      assertionUri,
      metaGraph,
      merkleRoot,
      authorAddress,
      authorAttestationR: r,
      authorAttestationVS: vs,
      authorSchemeVersion: schemeVersion,
      chainId,
      kav10Address,
      finalizedAtIso,
      rootEntities,
    });
    await this.store.insert(sealQuads);

    return {
      assertionUri,
      merkleRoot,
      authorAddress,
      schemeVersion,
      chainId,
      kav10Address,
      eip712Digest,
    };
  }

  /**
   * Helper: resolve the on-chain context graph id used by the EIP-712
   * AuthorAttestation domain. Throws when the CG is not yet
   * registered on-chain — finalize cannot bind a sig to a missing CG.
   */
  private async requireOnChainContextGraphId(contextGraphId: string): Promise<bigint> {
    const onChainId = await this.getContextGraphOnChainId(contextGraphId);
    if (onChainId == null) {
      throw new Error(
        `Context graph "${contextGraphId}" is not registered on-chain. ` +
          `Run 'dkg context-graph register ${contextGraphId}' before finalizing an assertion ` +
          `targeted at it; finalize binds the author signature to the on-chain CG id.`,
      );
    }
    try {
      return BigInt(onChainId);
    } catch {
      throw new Error(
        `Context graph "${contextGraphId}" has a non-numeric on-chain id ("${onChainId}") — ` +
          `the EIP-712 binding requires a uint256.`,
      );
    }
  }

  /**
   * RFC-001 §9.x — selection-based publish bridge.
   *
   * Mints a `precomputedAttestation` inline for a given quads bag,
   * without writing seal triples to `_meta`. Used by
   * `publishFromSharedMemory(selection)` to preserve the
   * "agent picks rootEntities post-hoc, then publishes" UX while
   * keeping the sign-at-creation invariant: the seal is computed and
   * signed at the agent boundary, before the publisher gets the
   * payload. The publisher then refuses the on-chain publish if the
   * seal is absent or its merkleRoot doesn't match what it recomputes
   * from the quads (defence against in-flight tampering between
   * selection and broadcast).
   *
   * Author resolution mirrors `assertionFinalize`:
   *   1. `preSignedAuthorAttestation` (self-sovereign agent's pre-sig)
   *   2. `authorAgentAddress` (custodial agent — daemon holds the key)
   *   3. publisher fallback (the daemon's own publisher EOA signs)
   *
   * Unlike `assertionFinalize`, the seal is NOT persisted: it lives
   * only in the publish call. This is by design — selection-based
   * publishes are inherently ephemeral curations, not long-lived
   * named assertions. If you need persistent seal provenance, use the
   * named-assertion lifecycle (`createAssertion` + `appendToAssertion`
   * + `finalizeAssertion` + `publishFromFinalizedAssertion`).
   */
  private async _buildPrecomputedAttestationForSelection(
    contextGraphId: string,
    quads: Quad[],
    opts?: {
      authorAgentAddress?: string;
      preSignedAuthorAttestation?: PreSignedAuthorAttestation;
      schemeVersion?: number;
      /**
       * On-chain CG id the seal binds to. Defaults to the source
       * `contextGraphId`'s on-chain id; override for remap-flow
       * publishes (`publishContextGraphId` / `subContextGraphId` set
       * on the publish call) where the assertion lives in a different
       * CG than the SWM source.
       */
      targetOnChainCgId?: bigint | string;
      /**
       * Private quads for the same publish. Round 4 review §11 —
       * `DKGPublisher.publish` computes `kcMerkleRoot` over the
       * concatenation of public quads + private roots (see
       * `dkg-publisher.ts:1567-1575`). The seal must hash the same
       * leaves or every V10 publish with `privateQuads` falls back to
       * `tentative` on the publisher's `expectedMerkleRoot mismatch`
       * guard. Pass them through so the agent's pre-seal merkle
       * matches what the publisher will recompute.
       */
      privateQuads?: Quad[];
    },
  ): Promise<PublishOptions['precomputedAttestation']> {
    if (
      opts?.authorAgentAddress != null &&
      opts?.preSignedAuthorAttestation != null
    ) {
      throw new Error(
        '_buildPrecomputedAttestationForSelection: authorAgentAddress and preSignedAuthorAttestation are mutually exclusive',
      );
    }
    if (
      typeof this.chain.getEvmChainId !== 'function' ||
      typeof this.chain.getKnowledgeAssetsV10Address !== 'function'
    ) {
      throw new Error(
        'Selection-based VM publish requires a V10-capable chain adapter that exposes ' +
          'getEvmChainId() and getKnowledgeAssetsV10Address().',
      );
    }

    const kaMap = autoPartition(quads);
    const allSkolemizedQuads = [...kaMap.values()].flat();
    // Mirror the publisher's per-rootEntity private partition + root
    // derivation (see `dkg-publisher.ts:1526-1570`). Each public root
    // entity gets the private quads whose subjects either equal it or
    // skolemize beneath its `…/.well-known/genid/` namespace; each
    // such non-empty bag becomes a `computePrivateRootV10` leaf in the
    // KC merkle. The order MUST follow the publisher's manifest
    // iteration over `kaMap`, which is the insertion order — same map
    // we built two lines up.
    const privateQuads = opts?.privateQuads ?? [];
    const privateRoots: Uint8Array[] = [];
    for (const rootEntity of kaMap.keys()) {
      if (privateQuads.length === 0) break;
      const entityPrivateQuads = privateQuads.filter(
        (q) =>
          q.subject === rootEntity ||
          q.subject.startsWith(rootEntity + '/.well-known/genid/'),
      );
      if (entityPrivateQuads.length === 0) continue;
      const root = computePrivateRoot(entityPrivateQuads);
      if (root) privateRoots.push(root);
    }
    const merkleRoot = computeFlatKCRoot(allSkolemizedQuads, privateRoots);

    const chainId = await this.chain.getEvmChainId();
    const kav10Address = await this.chain.getKnowledgeAssetsV10Address();
    const onChainCgId =
      opts?.targetOnChainCgId !== undefined
        ? BigInt(opts.targetOnChainCgId)
        : await this.requireOnChainContextGraphId(contextGraphId);

    const schemeVersion = opts?.schemeVersion ?? AUTHOR_SCHEME_VERSION_V1;
    let authorAddress: string;
    let signerPrivateKey: string | undefined;
    let preSigned: PreSignedAuthorAttestation | undefined;
    if (opts?.preSignedAuthorAttestation != null) {
      preSigned = opts.preSignedAuthorAttestation;
      authorAddress = preSigned.address;
    } else if (opts?.authorAgentAddress != null) {
      const mode = this.getLocalAgentMode(opts.authorAgentAddress);
      if (mode === undefined) {
        throw new Error(
          `Selection-based VM publish: authorAgentAddress ${opts.authorAgentAddress} is not a registered local agent on this node`,
        );
      }
      if (mode === 'self-sovereign') {
        throw new Error(
          `Selection-based VM publish: agent ${opts.authorAgentAddress} is registered as self-sovereign — ` +
            `this node does not hold its private key. Use preSignedAuthorAttestation instead.`,
        );
      }
      signerPrivateKey = this.getCustodialAgentPrivateKey(opts.authorAgentAddress);
      if (!signerPrivateKey) {
        throw new Error(
          `Selection-based VM publish: custodial agent ${opts.authorAgentAddress} has no private key on file`,
        );
      }
      authorAddress = opts.authorAgentAddress;
    } else {
      const fallbackAddress = await this.publisher.publisherFallbackAuthorAddress();
      if (!fallbackAddress) {
        throw new Error(
          'Selection-based VM publish: no agent override supplied and no publisher signer is available. ' +
            'Either supply authorAgentAddress / preSignedAuthorAttestation, or configure a publisher private key on the daemon.',
        );
      }
      authorAddress = fallbackAddress;
    }

    const typedData = buildAuthorAttestationTypedData({
      chainId,
      kav10Address,
      contextGraphId: onChainCgId,
      merkleRoot,
      authorAddress,
      schemeVersion,
    });
    const eip712Digest = ethers.TypedDataEncoder.hash(
      typedData.domain,
      typedData.types,
      typedData.message,
    );

    let r: Uint8Array;
    let vs: Uint8Array;
    if (preSigned) {
      const sig = ethers.Signature.from({
        r: ethers.hexlify(preSigned.signature.r),
        yParityAndS: ethers.hexlify(preSigned.signature.vs),
      });
      // Same EOA-vs-1271 dispatch as `assertionFinalize` (see comment
      // there). Skip ECDSA recover for smart-contract / 7702-delegated
      // authors so the on-chain `IERC1271.isValidSignature` branch can
      // be the authoritative check.
      const isContractAuthor =
        typeof this.chain.hasContractCode === 'function'
          ? await this.chain.hasContractCode(authorAddress)
          : false;
      if (!isContractAuthor) {
        const recovered = ethers.recoverAddress(eip712Digest, sig);
        if (recovered.toLowerCase() !== authorAddress.toLowerCase()) {
          throw new Error(
            `Selection-based VM publish: preSignedAuthorAttestation signer mismatch — ` +
              `signature recovers ${recovered} but address claims ${authorAddress}.`,
          );
        }
      }
      r = preSigned.signature.r;
      vs = preSigned.signature.vs;
    } else if (signerPrivateKey) {
      const wallet = new ethers.Wallet(
        signerPrivateKey.startsWith('0x') ? signerPrivateKey : '0x' + signerPrivateKey,
      );
      const sigHex = await wallet.signTypedData(
        typedData.domain,
        typedData.types,
        typedData.message,
      );
      const sig = ethers.Signature.from(sigHex);
      r = ethers.getBytes(sig.r);
      vs = ethers.getBytes(sig.yParityAndS);
    } else {
      const compact = await this.publisher.signAuthorAttestationAsPublisher(typedData);
      r = compact.r;
      vs = compact.vs;
    }

    return {
      expectedMerkleRoot: merkleRoot,
      authorAddress,
      signature: { r, vs },
      schemeVersion,
    };
  }

  /**
   * Load the quads that a selection-based publish would target.
   * Mirrors the SPARQL CONSTRUCT inside
   * `publisher.publishFromSharedMemory` so the agent can pre-compute
   * the assertion seal over the same content the publisher will see
   * at broadcast time. Any drift (e.g. concurrent SWM mutation
   * between this load and the publisher's load) surfaces as the
   * publisher's `expectedMerkleRoot mismatch` error rather than a
   * silent wrong-content publish.
   */
  private async _loadSelectedSWMQuads(
    contextGraphId: string,
    selection: 'all' | { rootEntities: string[] },
    subGraphName?: string,
  ): Promise<Quad[]> {
    const swmGraph = contextGraphSharedMemoryUri(contextGraphId, subGraphName);
    let sparql: string;
    if (selection === 'all') {
      sparql = `CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${swmGraph}> { ?s ?p ?o } }`;
    } else {
      // Round 4 review §10 — mirror the `isSafeIri` filter that
      // `DKGPublisher.publishFromSharedMemory` applies before its own
      // SPARQL CONSTRUCT. Without this guard a caller could craft a
      // `selection.rootEntities` value containing `>` / SPARQL syntax
      // that breaks out of the `<…>` IRI literal and rewrites the
      // pre-seal CONSTRUCT into a wider scope. Both seams must agree
      // on the IRI shape that survives interpolation; the `_meta`
      // seal writer (`buildAssertionSealQuads`) applies the same
      // reject-set when it persists rootEntities so any value that
      // round-trips through finalize → publish is safe here.
      const roots = [...new Set(
        selection.rootEntities
          .map((r) => String(r).trim())
          .filter((r) => isSafeIri(r)),
      )];
      if (roots.length === 0) {
        const hadInput = selection.rootEntities.length > 0;
        throw new Error(
          hadInput
            ? `_loadSelectedSWMQuads: no valid rootEntities provided ` +
                `(all ${selection.rootEntities.length} entries failed IRI validation) ` +
                `for context graph ${contextGraphId}`
            : `_loadSelectedSWMQuads: no rootEntities supplied for context graph ${contextGraphId}`,
        );
      }
      const values = roots.map((r) => `<${r}>`).join(' ');
      sparql = `CONSTRUCT { ?s ?p ?o } WHERE {
        GRAPH <${swmGraph}> {
          VALUES ?root { ${values} }
          ?s ?p ?o .
          FILTER(
            ?s = ?root
            || STRSTARTS(STR(?s), CONCAT(STR(?root), "/.well-known/genid/"))
          )
        }
      }`;
    }
    const result = await this.store.query(sparql);
    return result.type === 'quads' ? result.quads : [];
  }

  /**
   * RFC-001 §9.x — publish a previously-finalized assertion to the
   * verified-memory chain.
   *
   * Reads the seal from `_meta`, plumbs the seal's
   * `(merkleRoot, authorAddress, signature, schemeVersion)` into the
   * publisher as `precomputedAttestation`, and lets
   * `publishFromSharedMemory` handle everything else (CG registration
   * check, ACK collection, on-chain submission, post-confirmation
   * cleanup).
   *
   * Pre-condition: the assertion's quads have already been promoted
   * into SWM via `assertion.promote()`. The publisher pulls quads
   * from the canonical CG `_shared-memory` graph; if the assertion
   * hasn't been promoted yet, publish will see an empty/wrong quad
   * set and the merkleRoot sanity check inside `publish()` will fire.
   */
  async publishFromFinalizedAssertion(
    contextGraphId: string,
    name: string,
    opts?: {
      subGraphName?: string;
      operationCtx?: OperationContext;
      onPhase?: PhaseCallback;
      publisherNodeIdentityIdOverride?: bigint;
      clearSharedMemoryAfter?: boolean;
    },
  ): Promise<PublishResult & { assertionUri: string; seal: AssertionSeal }> {
    const agentAddress = this.defaultAgentAddress ?? this.peerId;
    const assertionUri = contextGraphAssertionUri(
      contextGraphId,
      agentAddress,
      name,
      opts?.subGraphName,
    );
    const metaGraph = contextGraphMetaUri(contextGraphId);

    // 1. Read the seal from _meta.
    const metaResult = await this.store.query(
      `CONSTRUCT { <${assertionUri}> ?p ?o } WHERE { GRAPH <${metaGraph}> { <${assertionUri}> ?p ?o } }`,
    );
    const metaQuads = metaResult.type === 'quads' ? metaResult.quads : [];
    const seal = parseAssertionSealQuads(metaQuads, assertionUri);
    if (!seal) {
      throw new Error(
        `publishFromFinalizedAssertion: assertion <${assertionUri}> is not finalized. ` +
          `Call /api/assertion/${name}/finalize before publishing.`,
      );
    }

    // 2. Cross-check chain target — refuse to publish a sig signed
    //    against a different deployment than this daemon currently
    //    points at. This is the cross-deployment safety the EIP-712
    //    domain is buying us; surface as an early 4xx-equivalent
    //    rather than a tx revert.
    if (
      typeof this.chain.getEvmChainId === 'function' &&
      typeof this.chain.getKnowledgeAssetsV10Address === 'function'
    ) {
      const liveChainId = await this.chain.getEvmChainId();
      const liveKav10 = await this.chain.getKnowledgeAssetsV10Address();
      if (liveChainId !== seal.chainId) {
        throw new Error(
          `publishFromFinalizedAssertion: seal binds chainId=${seal.chainId.toString()} but daemon ` +
            `is configured for chainId=${liveChainId.toString()}. The author signature is not valid ` +
            `against this chain. Re-finalize the assertion against the target chain.`,
        );
      }
      if (liveKav10.toLowerCase() !== seal.kav10Address.toLowerCase()) {
        throw new Error(
          `publishFromFinalizedAssertion: seal binds KAv10=${seal.kav10Address} but daemon ` +
            `is configured for KAv10=${liveKav10}. The signature is not valid against this deployment.`,
        );
      }
    }

    // 3. Run the standard publishFromSharedMemory flow with the
    //    pre-computed attestation. The publisher will sanity-check
    //    that its own merkle re-derivation matches the seal.
    //
    //    Round 4 review §9 — scope the SWM CONSTRUCT to the seal's
    //    `rootEntities` instead of `'all'`. With `'all'` a named
    //    publish would bundle every other promoted assertion sitting
    //    in shared memory into the same KC; the publisher's recompute
    //    would then disagree with the seal's `expectedMerkleRoot` and
    //    flip to `tentative kcId: "0"`. The seal's rootEntities were
    //    captured at finalize time from the same `autoPartition` call
    //    that drove the merkle leaves, so this selection deterministically
    //    yields the post-promote SWM slice the seal commits to.
    const result = await this.publishFromSharedMemory(
      contextGraphId,
      { rootEntities: seal.rootEntities },
      {
        operationCtx: opts?.operationCtx,
        onPhase: opts?.onPhase,
        subGraphName: opts?.subGraphName,
        publisherNodeIdentityIdOverride: opts?.publisherNodeIdentityIdOverride,
        clearSharedMemoryAfter: opts?.clearSharedMemoryAfter,
        // Wired through to the inner publisher.publish() via
        // publishFromSharedMemory's `precomputedAttestation` option.
        // Skips the publisher's signing entirely.
        precomputedAttestation: {
          expectedMerkleRoot: seal.merkleRoot,
          authorAddress: seal.authorAddress,
          signature: { r: seal.authorAttestationR, vs: seal.authorAttestationVS },
          schemeVersion: seal.authorSchemeVersion,
        },
      },
    );

    // 4. On confirmed publish, write receipt triples to _meta.
    if (result.status === 'confirmed' && result.onChainResult) {
      try {
        const receiptQuads = buildAssertionPublishReceiptQuads({
          assertionUri,
          metaGraph,
          txHash: result.onChainResult.txHash ?? '',
          blockNumber: BigInt(result.onChainResult.blockNumber ?? 0),
          kcId: result.onChainResult.batchId ?? 0n,
        });
        await this.store.insert(receiptQuads);
      } catch (err) {
        this.log.warn(
          opts?.operationCtx ?? createOperationContext('publishFromSWM'),
          `Failed to write publish receipt for <${assertionUri}>: ` +
            (err instanceof Error ? err.message : String(err)),
        );
      }
    }

    return { ...result, assertionUri, seal };
  }

  /**
   * Publish shared memory content: read from SWM graph and publish with full finality (data graph + chain).
   * After on-chain confirmation, broadcasts a lightweight FinalizationMessage so peers with matching
   * SWM state can promote it to canonical without re-downloading the full payload.
   */
  async publishFromSharedMemory(
    contextGraphId: string,
    selection: 'all' | { rootEntities: string[] },
    options?: {
      clearSharedMemoryAfter?: boolean;
      operationCtx?: OperationContext;
      onPhase?: PhaseCallback;
      /** @deprecated Use subContextGraphId */
      contextGraphId?: string | bigint;
      subContextGraphId?: string | bigint;
      contextGraphSignatures?: Array<{ identityId: bigint; r: Uint8Array; vs: Uint8Array }>;
      /** Target sub-graph within the context graph (e.g. "code", "decisions"). */
      subGraphName?: string;
      /**
       * Per-publish override for the on-chain
       * `KnowledgeAssetsV10.PublishParams.publisherNodeIdentityId`
       * attribution field (RFC-001 §4). Threaded as a per-call option
       * into `publisher.publishFromSharedMemory` — no global mutation,
       * so concurrent publishes with conflicting overrides are safe.
       *
       * Lets an edge-mode operator route a publish through the
       * home-core's `publishFromSharedMemory` while attributing the
       * publishing-factor credit (and PCA discount, when the submitter
       * is on the named core's `authorizedKeys`) to a different core.
       * `0n` is a valid explicit value and means "no attribution"
       * (RFC-001 §4(d)) — the contract validates this case and the
       * publish proceeds on-chain. The publisher's own
       * `publisherNodeIdentityId` is unchanged and continues to be
       * used for ACK self-signing and signer resolution.
       */
      publisherNodeIdentityIdOverride?: bigint;
      /**
       * RFC-001 §9.x — pre-computed attestation captured by
       * `agent.assertion.finalize()`. When the caller has already
       * sealed a named assertion they can plumb the seal here verbatim
       * and the publisher forwards it unchanged.
       *
       * If omitted AND the publish is going on-chain (V10-capable
       * adapter + on-chain CG id), the agent mints a seal inline at
       * the selection boundary using `authorAgentAddress` /
       * `preSignedAuthorAttestation` / publisher fallback. This is the
       * "selection-based publish" UX bridge — agents/users keep
       * picking rootEntities post-hoc, but the seal is still computed
       * and signed before the publisher sees the payload.
       */
      precomputedAttestation?: PublishOptions['precomputedAttestation'];
      /**
       * Agent address to attribute authorship to when minting an
       * inline seal at this layer. Must be a registered local agent
       * with custodial keys (the daemon holds the private key). For
       * self-sovereign agents use `preSignedAuthorAttestation`. Has
       * no effect when `precomputedAttestation` is also supplied.
       */
      authorAgentAddress?: string;
      /**
       * Pre-signed AuthorAttestation by a self-sovereign agent whose
       * private key isn't held by the daemon. Has no effect when
       * `precomputedAttestation` is also supplied. Mutually exclusive
       * with `authorAgentAddress`.
       */
      preSignedAuthorAttestation?: PreSignedAuthorAttestation;
      /** Author scheme version override (defaults to AUTHOR_SCHEME_VERSION_V1). */
      schemeVersion?: number;
    },
  ): Promise<PublishResult> {
    const ctx = options?.operationCtx ?? createOperationContext('publishFromSWM');
    const effectiveSubCG = options?.subContextGraphId ?? options?.contextGraphId;
    const ctxGraphIdStr = effectiveSubCG != null ? String(effectiveSubCG) : undefined;

    const onChainId = ctxGraphIdStr ?? (await this.getContextGraphOnChainId(contextGraphId)) ?? undefined;

    const v10ACKProvider = this.createV10ACKProvider(contextGraphId);

    // RFC-001 §9.x — selection-based publish bridge. If the caller
    // already sealed the content (named-assertion lifecycle) they
    // pass `precomputedAttestation` through and we forward verbatim.
    // Otherwise, when we know we're going on-chain (V10 adapter + CG
    // has on-chain id), we mint the seal here at the selection
    // boundary so the publisher's "no on-chain publish without
    // precomputedAttestation" guard is satisfied.
    let resolvedSeal = options?.precomputedAttestation;
    if (
      !resolvedSeal &&
      onChainId != null &&
      typeof this.chain.getEvmChainId === 'function' &&
      typeof this.chain.getKnowledgeAssetsV10Address === 'function'
    ) {
      const swmQuads = await this._loadSelectedSWMQuads(
        contextGraphId,
        selection,
        options?.subGraphName,
      );
      if (swmQuads.length > 0) {
        resolvedSeal = await this._buildPrecomputedAttestationForSelection(
          contextGraphId,
          swmQuads,
          {
            targetOnChainCgId: onChainId,
            ...(options?.authorAgentAddress != null
              ? { authorAgentAddress: options.authorAgentAddress }
              : {}),
            ...(options?.preSignedAuthorAttestation != null
              ? { preSignedAuthorAttestation: options.preSignedAuthorAttestation }
              : {}),
            ...(options?.schemeVersion !== undefined
              ? { schemeVersion: options.schemeVersion }
              : {}),
          },
        );
      }
    }

    const result = await this.publisher.publishFromSharedMemory(contextGraphId, selection, {
      operationCtx: ctx,
      clearSharedMemoryAfter: options?.clearSharedMemoryAfter,
      onPhase: options?.onPhase,
      publishContextGraphId: ctxGraphIdStr,
      onChainContextGraphId: onChainId,
      contextGraphSignatures: options?.contextGraphSignatures,
      v10ACKProvider,
      subGraphName: options?.subGraphName,
      publisherNodeIdentityIdOverride: options?.publisherNodeIdentityIdOverride,
      precomputedAttestation: resolvedSeal,
    });

    if (result.status === 'confirmed' && result.onChainResult) {
      const rootEntities = result.kaManifest.map(ka => ka.rootEntity);

      const msg: FinalizationMessageMsg = {
        ual: result.ual,
        contextGraphId: contextGraphId,
        kcMerkleRoot: result.merkleRoot,
        txHash: result.onChainResult.txHash ?? '',
        blockNumber: result.onChainResult.blockNumber ?? 0,
        batchId: result.onChainResult.batchId ?? 0n,
        startKAId: result.onChainResult.startKAId ?? 0n,
        endKAId: result.onChainResult.endKAId ?? 0n,
        publisherAddress: result.onChainResult.publisherAddress ?? '',
        rootEntities,
        timestampMs: Date.now(),
        operationId: ctx.operationId,
        targetContextGraphId: result.contextGraphError ? undefined : ctxGraphIdStr,
        subGraphName: options?.subGraphName,
      };

      const topic = contextGraphFinalizationTopic(contextGraphId);
      try {
        await this.gossip.publish(topic, encodeFinalizationMessage(msg));
        this.log.info(ctx, `Broadcast finalization for ${result.ual} to ${topic}${ctxGraphIdStr ? ` (contextGraph=${ctxGraphIdStr})` : ''}${result.contextGraphError ? ' (ctx-graph registration failed, omitting targetContextGraphId)' : ''}`);
      } catch {
        this.log.warn(ctx, `No peers subscribed to ${topic} yet`);
      }
    }

    return result;
  }

  /** @deprecated Use publishFromSharedMemory. Will be removed in V10.1. */
  async enshrineFromWorkspace(
    ...args: Parameters<DKGAgent['publishFromSharedMemory']>
  ): ReturnType<DKGAgent['publishFromSharedMemory']> {
    return this.publishFromSharedMemory(...args);
  }

  /**
   * Register a new M/N signature-gated context graph on-chain.
   */
  async registerContextGraphOnChain(params: CreateOnChainContextGraphParams): Promise<CreateOnChainContextGraphResult> {
    const ctx = createOperationContext('system');
    if (typeof this.chain.createOnChainContextGraph !== 'function') {
      throw new Error('createOnChainContextGraph not available on chain adapter');
    }
    const result = await this.chain.createOnChainContextGraph(params);
    const contextGraphId = result.contextGraphId.toString();
    for (const identityId of params.participantIdentityIds) {
      this.upsertContextGraphMember({
        contextGraphId,
        principalType: 'identity',
        principalId: identityId.toString(),
        role: 'hosting-node',
        status: 'active',
        source: 'on-chain-registration',
      });
    }
    for (const agentAddress of params.participantAgents ?? []) {
      this.upsertContextGraphMember({
        contextGraphId,
        principalType: 'agent',
        principalId: agentAddress,
        role: 'participant-agent',
        status: 'active',
        source: 'on-chain-registration',
      });
    }
    this.log.info(ctx, `Created on-chain context graph ${result.contextGraphId} (M=${params.requiredSignatures}, N=${params.participantIdentityIds.length})`);
    return result;
  }

  /**
   * Link an already-published KC batch to a context graph.
   * Collects participant signatures and calls addBatchToContextGraph on-chain.
   */
  async addBatchToContextGraph(params: {
    contextGraphId: string | bigint;
    batchId: bigint;
    merkleRoot?: Uint8Array;
    participantSignatures?: Array<{ identityId: bigint; r: Uint8Array; vs: Uint8Array }>;
  }): Promise<{ success: boolean }> {
    const ctx = createOperationContext('system');
    if (typeof this.chain.verify !== 'function') {
      throw new Error('verify not available on chain adapter');
    }

    let merkleRoot = params.merkleRoot;
    if (!merkleRoot) {
      const batch = (this.chain as any).getBatch?.(params.batchId);
      merkleRoot = batch?.merkleRoot;
    }

    const result = await this.chain.verify({
      contextGraphId: BigInt(params.contextGraphId),
      batchId: params.batchId,
      merkleRoot,
      signerSignatures: params.participantSignatures ?? [],
    });
    this.log.info(ctx, `addBatchToContextGraph: batch=${params.batchId} → ctxGraph=${params.contextGraphId} success=${result.success}`);
    return { success: result.success };
  }

  /**
   * (Re-)attempt on-chain identity registration. Safe to call multiple times.
   * Returns the identityId (>0n on success, 0n if chain is not configured).
   */
  async ensureIdentity(): Promise<bigint> {
    if (this.chain.chainId === 'none') return 0n;
    const effectiveRole = this.config.nodeRole ?? 'edge';
    const ctx = createOperationContext('system');
    let identityId = 0n;
    try {
      identityId = await this.chain.getIdentityId();
      if (identityId === 0n && effectiveRole === 'core') {
        this.log.info(ctx, 'ensureIdentity: no on-chain identity, creating profile...');
        identityId = await this.chain.ensureProfile({ nodeName: this.config.name });
        this.log.info(ctx, `ensureIdentity: profile created, identityId=${identityId}`);
      } else if (identityId === 0n) {
        return 0n;
      }
    } catch (err) {
      this.log.warn(ctx, `ensureIdentity error: ${err instanceof Error ? err.message : String(err)}`);
      try {
        identityId = await this.chain.getIdentityId();
      } catch { /* ignore */ }
    }
    if (identityId > 0n) {
      this.publisher.setIdentityId(identityId);
    }
    return identityId;
  }

  async query(
    sparql: string,
    options?: string | {
      contextGraphId?: string;
      graphSuffix?: '_shared_memory';
      includeSharedMemory?: boolean;
      /** @deprecated Use includeSharedMemory */
      includeWorkspace?: boolean;
      operationCtx?: OperationContext;
      view?: GetView;
      agentAddress?: string;
      verifiedGraph?: string;
      assertionName?: string;
      subGraphName?: string;
      /**
       * EVM address of the authenticated caller, as resolved by an
       * outer layer (typically the daemon's per-request auth token).
       * When set, the agent layer enforces that `view: 'working-memory'`
       * queries can only read this caller's own WM — cross-agent reads
       * via a foreign `agentAddress` are silently denied.
       *
       * Undefined = no caller authentication context (in-process call
       * from trusted code). Backwards-compatible with callers that
       * predate A-1 — they bypass the isolation check.
       *
       * Invariant: on a `view: 'working-memory'` read, the agent layer
       * rejects (silently, with an empty-per-kind result) any
       * `agentAddress` that differs from `callerAgentAddress`. If
       * `agentAddress` is omitted, it defaults to `callerAgentAddress`
       * so an authenticated caller cannot escape isolation by omission.
       * See spec §04 / RFC-29 for the policy source.
       */
      callerAgentAddress?: string;
      /**
       * Minimum trust level for the verified-memory view (spec §14, P-13).
       * When set to `TrustLevel.Endorsed`, the root content graph is
       * excluded from resolution so only quorum-verified sub-graphs survive.
       * Values above `Endorsed` (`PartiallyVerified`, `ConsensusVerified`)
       * are currently rejected — see `QueryOptions.minTrust` in
       * `packages/query/src/query-engine.ts` for the full rationale and
       * the Q-1 gap tracking per-graph trust tagging.
       * Ignored for views other than `verified-memory`.
       */
      minTrust?: TrustLevel;
      /**
       * @deprecated Use `minTrust`. Legacy underscore alias preserved for
       * V10-rc SDK consumers. When both are supplied, `minTrust` wins.
       * See QueryOptions._minTrust for the deprecation policy.
       */
      _minTrust?: TrustLevel;
    },
  ) {
    const rawOpts = typeof options === 'string' ? { contextGraphId: options } : options ?? {};
    const opts = {
      ...rawOpts,
      contextGraphId: rawOpts.contextGraphId,
      includeSharedMemory: rawOpts.includeSharedMemory ?? rawOpts.includeWorkspace,
    };
    const ctx = opts.operationCtx ?? createOperationContext('query');
    const sgLabel = opts.subGraphName ? `/${opts.subGraphName}` : '';
    const viewLabel = opts.view ? ` view=${opts.view}` : '';
    this.log.info(ctx, `Query on contextGraph="${opts.contextGraphId ?? 'all'}"${sgLabel}${viewLabel} sparql="${sparql.slice(0, 80)}"`);

    // Validate the SPARQL query is read-only BEFORE any access-denied
    // fast-path. `DKGQueryEngine.query` runs this guard too, but the
    // three early returns below (canReadContextGraph deny, WM
    // isolation deny, private-CG deny) short-circuit before reaching
    // it. Without this check, a caller can send `INSERT DATA { ... }`
    // through a cross-agent WM request and get a 200 empty result
    // instead of the 400 rejection that plain queries receive —
    // effectively silently swallowing a mutation attempt. Run it
    // once here so the deny path and the engine path share the same
    // input contract.
    const readOnlyGuard = validateReadOnlySparql(sparql);
    if (!readOnlyGuard.safe) {
      throw new Error(`SPARQL rejected: ${readOnlyGuard.reason}`);
    }

    const targetsSharedMemory =
      opts.graphSuffix === '_shared_memory'
      || opts.includeSharedMemory === true
      || opts.view === 'shared-working-memory';

    // A-1: Working-Memory isolation. When the caller is authenticated
    // (an outer layer like the daemon's `/api/query` route has resolved
    // the request to a specific agent and passed `callerAgentAddress`),
    // a WM query must not be allowed to read a different agent's
    // private memory. Cross-agent WM reads are silently denied (empty
    // bindings) rather than thrown — that matches the spec-safe
    // "deny without leaking existence" semantics used elsewhere in
    // this file for private context graphs.
    //
    // When `callerAgentAddress` is undefined we assume a trusted
    // in-process caller (e.g. ChatMemoryManager running inside the
    // daemon process) and leave the legacy behaviour intact. Those
    // call sites are tracked as follow-up A-1.2 for migration to an
    // authenticated scoped handle.
    // A-1 review: `/api/query` passes the raw JSON body through, so
    // `agentAddress` / `callerAgentAddress` can arrive as any JSON type
    // (number, array, object, null). Before this guard `.toLowerCase()`
    // would throw and the daemon turned a bad request into a 500.
    //
    // A-1 follow-up review: simply coercing non-strings to `undefined`
    // meant malformed input like `{ view: 'working-memory',
    // agentAddress: 123 }` silently fell through to the
    // `this.peerId` fallback below — so a caller could land in the
    // node-default WM namespace and get a 200 with real data.
    // Reject non-string `agentAddress` / `callerAgentAddress` up
    // front and let the daemon classify the resulting error as 400.
    if (opts.agentAddress !== undefined && typeof opts.agentAddress !== 'string') {
      throw new Error(
        `query: 'agentAddress' must be a string, got ${typeof opts.agentAddress}`,
      );
    }
    if (opts.callerAgentAddress !== undefined && typeof opts.callerAgentAddress !== 'string') {
      throw new Error(
        `query: 'callerAgentAddress' must be a string, got ${typeof opts.callerAgentAddress}`,
      );
    }
    const callerAgentAddressStr = opts.callerAgentAddress;

    if (
      opts.contextGraphId
      && targetsSharedMemory
      && !(await this.canUseSharedMemoryForContextGraph(opts.contextGraphId, {
        callerAgentAddress: callerAgentAddressStr,
      }))
    ) {
      this.log.info(ctx, `Shared memory query denied for unauthorized or unconfirmed context graph "${opts.contextGraphId}"`);
      return emptyQueryResultForKind(sparql);
    }

    if (opts.contextGraphId && !(await this.canReadContextGraph(opts.contextGraphId, {
      callerAgentAddress: callerAgentAddressStr,
    }))) {
      this.log.info(ctx, `Query denied for private context graph "${opts.contextGraphId}"`);
      // A-1 follow-up review: synthetic deny must match the SPARQL form
      // so ASK / CONSTRUCT / DESCRIBE clients get `false` / empty-quads
      // instead of a SELECT-shaped `{ bindings: [] }`.
      return emptyQueryResultForKind(sparql);
    }

    // A-1 canonicalization (Codex PR #242 iter-9 re-review): the
    // node's default agent has TWO identifiers that key the same WM
    // namespace — its EVM address (`this.defaultAgentAddress`) and
    // the legacy `this.peerId`. In-repo WM callers / docs still use
    // `peerId` as `agentAddress` (e.g. `ChatMemoryManager`,
    // `packages/cli/skills/dkg-node/SKILL.md`), and the engine
    // stores WM under
    // `did:dkg:context-graph:<cg>/assertion/<agentAddress>/`, so EVM
    // and peerId hash to DIFFERENT graphs. If the isolation check
    // compared raw strings, an agent-scoped token with
    // `callerAgentAddress=<defaultAgent.evm>` querying its own WM
    // with `agentAddress=<peerId>` (or the reverse) would get a
    // silent empty deny even though both sides are the same
    // identity. Canonicalize both sides: when the default agent is
    // known, fold its `peerId` alias onto its EVM address.
    const defaultEvmLc = this.defaultAgentAddress?.toLowerCase();
    const peerIdLc = this.peerId?.toLowerCase();
    const canonicaliseWmId = (addr: string | undefined): string | undefined => {
      if (!addr) return undefined;
      const lc = addr.toLowerCase();
      if (peerIdLc && lc === peerIdLc && defaultEvmLc) return defaultEvmLc;
      return lc;
    };

    // An authenticated (agent-bound) /api/query call could previously
    // OMIT `agentAddress` and fall through to the `this.peerId`
    // fallback at the engine call below, reading the node-default WM
    // namespace instead of the caller's own. Default an omitted
    // `agentAddress` to `callerAgentAddress` on working-memory reads
    // so an agent-bound caller cannot escape its own WM by just not
    // supplying the field.
    //
    // Legacy preservation (Codex iter-9 re-review): if the caller is
    // the node default agent, default to `this.peerId` instead of
    // the EVM address. Pre-existing WM data for the default agent
    // lives under the peerId-keyed namespace; defaulting to the EVM
    // form would strand that data. The isolation check below is
    // alias-aware (`canonicaliseWmId`), so both forms resolve to the
    // same canonical identity and still pass the caller===target
    // invariant.
    const callerIsDefaultAgent =
      !!callerAgentAddressStr
      && !!defaultEvmLc
      && callerAgentAddressStr.toLowerCase() === defaultEvmLc;
    const agentAddressStr =
      opts.agentAddress
      ?? (opts.view === 'working-memory' && callerAgentAddressStr
        ? (callerIsDefaultAgent && this.peerId ? this.peerId : callerAgentAddressStr)
        : undefined);
    if (
      opts.view === 'working-memory' &&
      callerAgentAddressStr &&
      agentAddressStr &&
      canonicaliseWmId(callerAgentAddressStr) !== canonicaliseWmId(agentAddressStr)
    ) {
      this.log.info(
        ctx,
        `WM query denied: caller=${callerAgentAddressStr} cannot read agentAddress=${agentAddressStr} — A-1 isolation`,
      );
      // A-1 follow-up review: preserve the SPARQL query-form shape on
      // denial so ASK clients see `{ bindings: [{ result: 'false' }] }`
      // and CONSTRUCT / DESCRIBE clients see `{ bindings: [], quads: [] }`.
      // Returning a SELECT-shaped `{ bindings: [] }` on every form leaks
      // the fact that access was denied (versus an empty match) via the
      // changed response shape.
      return emptyQueryResultForKind(sparql);
    }

    // When no context graph is specified, exclude private CGs the caller cannot
    // read to prevent data leakage via unscoped or FROM-less SPARQL.
    let excludeGraphPrefixes: string[] | undefined;
    if (!opts.contextGraphId) {
      excludeGraphPrefixes = await this.getDisallowedGraphPrefixes({
        callerAgentAddress: callerAgentAddressStr,
      });
      // Per spec Axiom 1 every shared query must be resolved within a CG.
      // Reject explicit GRAPH/FROM clauses that reference private CGs the
      // caller cannot read — post-filtering alone cannot prevent leaks via
      // aggregates (ASK, COUNT) or projections that omit graph/subject.
      if (excludeGraphPrefixes.length > 0 && this.sparqlReferencesPrivateGraphs(sparql, excludeGraphPrefixes)) {
        this.log.info(ctx, 'Query denied: SPARQL references private context graphs the caller cannot read');
        return emptyQueryResultForKind(sparql);
      }
    }

    const result = await this.queryEngine.query(sparql, {
      contextGraphId: opts.contextGraphId,
      excludeGraphPrefixes,
      graphSuffix: opts.graphSuffix,
      includeSharedMemory: opts.includeSharedMemory,
      view: opts.view,
      agentAddress: agentAddressStr ?? (opts.view === 'working-memory' ? this.peerId : undefined),
      verifiedGraph: opts.verifiedGraph,
      assertionName: opts.assertionName,
      subGraphName: opts.subGraphName,
      // PR #239 Codex iter-5: fall back to the deprecated underscore alias
      // here (and only here — we do not propagate both fields further) so
      // callers on the legacy shape still get the trust gate without
      // engines needing to know about both names.
      minTrust: opts.minTrust ?? opts._minTrust,
    });
    this.log.info(ctx, `Query returned ${result.bindings?.length ?? 0} bindings`);
    return result;
  }

  private isAgentAddressAllowed(agentAddress: string | undefined, agentGateAddresses: readonly string[]): boolean {
    if (!agentAddress) return false;
    const normalized = agentAddress.toLowerCase();
    return agentGateAddresses.some((agent) => agent.toLowerCase() === normalized);
  }

  private async canReadContextGraph(
    contextGraphId: string,
    opts: {
      callerAgentAddress?: string;
      allowSubscriptionFallback?: boolean;
    } = {},
  ): Promise<boolean> {
    if (!(await this.isPrivateContextGraph(contextGraphId))) {
      return true;
    }

    const agentGateAddresses = await this.getContextGraphAgentGateAddresses(contextGraphId);
    const allowedPeers = await this.getContextGraphAllowedPeers(contextGraphId);

    // Mixed legacy peer-id and V10 agent gates are conjunctive: a node must
    // be invited by peer id and also hold a local allowed agent identity.
    const agentGateAllowed = agentGateAddresses === null
      ? false
      : opts.callerAgentAddress
        ? this.isAgentAddressAllowed(opts.callerAgentAddress, agentGateAddresses)
        : this.hasLocalAgentInGate(agentGateAddresses);

    if (agentGateAddresses !== null && allowedPeers !== null) {
      return allowedPeers.includes(this.peerId) && agentGateAllowed;
    }

    if (agentGateAddresses !== null) {
      return agentGateAllowed;
    }

    const participants = await this.getPrivateContextGraphParticipants(contextGraphId);

    if ((!participants || participants.length === 0) && allowedPeers !== null) {
      return allowedPeers.includes(this.peerId);
    }

    // No participant or peer list at all. Durable CG reads preserve the legacy
    // subscribed-node fallback, but SWM must fail closed here because SWM
    // GossipSub carries plaintext bytes.
    if (!participants || participants.length === 0) {
      if (opts.allowSubscriptionFallback === false) {
        return false;
      }
      return this.subscribedContextGraphs.has(contextGraphId)
        || (this.config.syncContextGraphs ?? []).includes(contextGraphId);
    }

    if (
      opts.callerAgentAddress
      && participants.some((p) => p.toLowerCase() === opts.callerAgentAddress!.toLowerCase())
    ) {
      return true;
    }

    // Check if any local agent address is in the participants list
    const myAgentAddress = this.defaultAgentAddress;
    if (myAgentAddress && participants.some((p) => p.toLowerCase() === myAgentAddress.toLowerCase())) {
      return true;
    }

    // Check if the local identity ID is in the participants list
    let myIdentityId = 0n;
    try {
      myIdentityId = await this.chain.getIdentityId();
      if (myIdentityId > 0n && participants.includes(String(myIdentityId))) {
        return true;
      }
    } catch { /* identity lookup failed — continue to deny */ }

    // Legacy peer-ID allowlist: `inviteToContextGraph` writes `DKG_ALLOWED_PEER`
    // quads. Honor them for local reads so a peer-ID-invited node can query
    // the data it just synced.
    if (allowedPeers?.includes(this.peerId)) {
      return true;
    }

    // Edge nodes without an on-chain identity (identityId 0n) fall back to
    // subscription-based access — the subscription itself is an authorization
    // (the node was invited or created this CG).
    if (myIdentityId === 0n && opts.allowSubscriptionFallback !== false) {
      return this.subscribedContextGraphs.has(contextGraphId);
    }

    return false;
  }

  /**
   * Returns graph URI prefixes for private CGs the caller cannot read.
   * Used to exclude them from unscoped queries.
   */
  private async getDisallowedGraphPrefixes(opts: { callerAgentAddress?: string } = {}): Promise<string[]> {
    const ontologyGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
    const result = await this.store.query(
      `SELECT ?cg WHERE {
        GRAPH <${ontologyGraph}> {
          ?cg <${DKG_ONTOLOGY.DKG_ACCESS_POLICY}> "private"
        }
      }`,
    );
    if (result.type !== 'bindings' || result.bindings.length === 0) return [];

    const prefixes: string[] = [];
    for (const row of result.bindings) {
      const cgUri = row['cg'];
      if (!cgUri) continue;
      // cgUri is like "did:dkg:context-graph:some-id" — extract the ID
      const match = cgUri.match(/^<?did:dkg:context-graph:([^>]+)>?$/);
      if (!match) continue;
      const contextGraphId = match[1];
      if (await this.canReadContextGraph(contextGraphId, {
        callerAgentAddress: opts.callerAgentAddress,
      })) continue;
      // Exclude all named graphs under this CG (data, _meta, _shared_memory, etc.)
      prefixes.push(`did:dkg:context-graph:${contextGraphId}`);
    }
    return prefixes;
  }

  private sparqlReferencesPrivateGraphs(sparql: string, disallowedPrefixes: string[]): boolean {
    if (disallowedPrefixes.length === 0) return false;
    const upper = sparql.toUpperCase();
    if (!upper.includes('GRAPH') && !upper.includes('FROM')) return false;
    return disallowedPrefixes.some(prefix => sparql.includes(prefix));
  }

  /**
   * Send a cross-agent query to a remote peer via the /dkg/query/2.0.0 protocol.
   */
  async queryRemote(
    peerId: string,
    request: Omit<QueryRequest, 'operationId'>,
  ): Promise<QueryResponse> {
    const ctx = createOperationContext('query');
    const operationId = crypto.randomUUID();
    const fullRequest: QueryRequest = { ...request, operationId };

    this.log.info(ctx, `Remote query to ${peerId.slice(-8)} type=${request.lookupType}`);

    const payload = new TextEncoder().encode(JSON.stringify(fullRequest));
    const responseBytes = await this.messenger.sendToPeer(peerId, PROTOCOL_QUERY_REMOTE, payload);
    const response = JSON.parse(new TextDecoder().decode(responseBytes)) as QueryResponse;

    this.log.info(ctx, `Remote query response: status=${response.status} resultCount=${response.resultCount}`);
    return response;
  }

  /**
   * Look up a specific knowledge asset on a remote peer by UAL.
   */
  async lookupEntity(peerId: string, ual: string): Promise<QueryResponse> {
    return this.queryRemote(peerId, { lookupType: 'ENTITY_BY_UAL', ual });
  }

  /**
   * Find entities of a given RDF type on a remote peer's context graph.
   */
  async findEntitiesByType(
    peerId: string,
    contextGraphId: string,
    rdfType: string,
    limit?: number,
  ): Promise<QueryResponse> {
    return this.queryRemote(peerId, {
      lookupType: 'ENTITIES_BY_TYPE',
      contextGraphId: contextGraphId,
      rdfType,
      limit,
    });
  }

  /**
   * Get all triples for a specific entity from a remote peer's context graph.
   */
  async getEntityTriples(
    peerId: string,
    contextGraphId: string,
    entityUri: string,
  ): Promise<QueryResponse> {
    return this.queryRemote(peerId, {
      lookupType: 'ENTITY_TRIPLES',
      contextGraphId: contextGraphId,
      entityUri,
    });
  }

  /**
   * Run a SPARQL query on a remote peer (if they allow it).
   */
  async queryRemoteSparql(
    peerId: string,
    contextGraphId: string,
    sparql: string,
    limit?: number,
    timeout?: number,
  ): Promise<QueryResponse> {
    return this.queryRemote(peerId, {
      lookupType: 'SPARQL_QUERY',
      contextGraphId: contextGraphId,
      sparql,
      limit,
      timeout,
    });
  }

  subscribeToContextGraph(contextGraphId: string, options?: { trackSyncScope?: boolean; persist?: boolean }): void {
    if (options?.trackSyncScope !== false) {
      this.trackSyncContextGraph(contextGraphId);
    }

    // Idempotent: skip if gossip handlers already installed for this context graph.
    if (this.gossipRegistered.has(contextGraphId)) {
      this.queueSharedMemoryGossipSubscription(contextGraphId);
      const existing = this.subscribedContextGraphs.get(contextGraphId);
      if (!existing?.subscribed) {
        this.setContextGraphSubscription(
          contextGraphId,
          { ...existing, subscribed: true, synced: existing?.synced ?? false },
          { persist: options?.persist },
        );
      }
      return;
    }
    this.gossipRegistered.add(contextGraphId);

    const publishTopic = contextGraphPublishTopic(contextGraphId);
    const appTopic = contextGraphAppTopic(contextGraphId);

    this.gossip.subscribe(publishTopic);
    this.gossip.subscribe(appTopic);

    const existing = this.subscribedContextGraphs.get(contextGraphId);
    this.setContextGraphSubscription(
      contextGraphId,
      { ...existing, subscribed: true, synced: existing?.synced ?? false },
      { persist: options?.persist },
    );

    this.gossip.onMessage(publishTopic, async (_topic, data, from) => {
      const gph = this.getOrCreateGossipPublishHandler();
      await gph.handlePublishMessage(data, contextGraphId, undefined, from);
    });

    this.queueSharedMemoryGossipSubscription(contextGraphId);

    const updateTopic = contextGraphUpdateTopic(contextGraphId);
    this.gossip.subscribe(updateTopic);
    this.gossip.onMessage(updateTopic, async (_topic, data, from) => {
      const uh = this.getOrCreateUpdateHandler();
      await uh.handle(data, from);
    });

    const finalizationTopic = contextGraphFinalizationTopic(contextGraphId);
    this.gossip.subscribe(finalizationTopic);
    this.gossip.onMessage(finalizationTopic, async (_topic, data) => {
      const fh = this.getOrCreateFinalizationHandler();
      await fh.handleFinalizationMessage(data, contextGraphId);
    });
  }

  private queueSharedMemoryGossipSubscription(contextGraphId: string): void {
    void this.reconcileSharedMemoryGossipSubscription(contextGraphId).catch((err) => {
      this.log.warn(
        createOperationContext('system'),
        `SWM gossip subscription check failed for "${contextGraphId}": ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  private async reconcileSharedMemoryGossipSubscription(contextGraphId: string): Promise<void> {
    const swmTopic = contextGraphWorkspaceTopic(contextGraphId);
    const isRegistered = this.sharedMemoryGossipRegistered.has(contextGraphId);
    const ctx = createOperationContext('system');
    if (!(await this.canUseSharedMemoryForContextGraph(contextGraphId))) {
      if (isRegistered) {
        this.gossip.unsubscribe(swmTopic);
        this.sharedMemoryGossipRegistered.delete(contextGraphId);
        this.log.warn(ctx, `SWM gossip unsubscribed for "${contextGraphId}": local node is no longer authorized`);
        return;
      }
      this.log.warn(ctx, `SWM gossip subscription denied for "${contextGraphId}": local node is not authorized`);
      return;
    }

    if (isRegistered) return;

    this.sharedMemoryGossipRegistered.add(contextGraphId);
    this.gossip.subscribe(swmTopic);
    this.gossip.onMessage(swmTopic, async (_topic, data, from) => {
      const wh = this.getOrCreateSharedMemoryHandler();
      await wh.handle(data, from);
    });
  }

  /**
   * Add a context graph to runtime sync scope so sync-on-connect includes it.
   * System context graphs are already included by default and are skipped here.
   */
  private trackSyncContextGraph(contextGraphId: string): void {
    const systemContextGraphs = new Set<string>(Object.values(SYSTEM_CONTEXT_GRAPHS) as string[]);
    if (systemContextGraphs.has(contextGraphId)) return;

    const syncSet = new Set<string>(this.config.syncContextGraphs ?? []);
    if (syncSet.has(contextGraphId)) return;
    syncSet.add(contextGraphId);
    this.config.syncContextGraphs = [...syncSet];
  }

  private getOrCreateGossipPublishHandler(): GossipPublishHandler {
    if (!this.gossipPublishHandler) {
      this.gossipPublishHandler = new GossipPublishHandler(
        this.store,
        this.chain.chainId === 'none' ? undefined : this.chain,
        this.subscribedContextGraphs,
        {
          contextGraphExists: (id) => this.contextGraphExists(id),
          // Gossip validation compares `approvedBy`/`revokedBy` against the
          // contextGraph owner. Those triples are emitted with `dkg:creator` (peer
          // DID) so peers validate against the same creator-scoped DID.
          // `dkg:curator` (wallet DID) is for local authorization only.
          getContextGraphOwner: (id) => this.getContextGraphCreator(id),
          subscribeToContextGraph: (id, options) => this.subscribeToContextGraph(id, options),
          hasConfirmedMetaState: (id) => this.hasConfirmedMetaState(id),
          persistContextGraphSubscription: (id) => this.persistContextGraphSubscriptionState(id),
        },
      );
    }
    return this.gossipPublishHandler;
  }

  private getOrCreateSharedMemoryHandler(): InstanceType<typeof SharedMemoryHandler> {
    if (!this.sharedMemoryHandler) {
      this.sharedMemoryHandler = new SharedMemoryHandler(this.store, this.eventBus, {
        sharedMemoryOwnedEntities: this.workspaceOwnedEntities,
        writeLocks: this.writeLocks,
        localAgentAddresses: () => [...this.localAgents.keys()],
        workspaceRecipientPrivateKeys: () => this.getLocalWorkspaceRecipientPrivateKeys(),
        workspaceSenderKeyDecryptor: (message: SwmSenderKeyMessageMsg, contextGraphId: string, ctx: OperationContext) =>
          this.decryptWorkspacePayloadWithSenderKey(message, contextGraphId, ctx),
        publicSnapshotStore: this.publicSnapshotStore,
      });
    }
    return this.sharedMemoryHandler;
  }

  private updateHandler?: UpdateHandler;

  private getOrCreateUpdateHandler(): UpdateHandler {
    if (!this.updateHandler) {
      this.updateHandler = new UpdateHandler(this.store, this.chain, this.eventBus, {
        knownBatchContextGraphs: this.publisher.knownBatchContextGraphs,
      });
    }
    return this.updateHandler;
  }

  private getOrCreateFinalizationHandler(): FinalizationHandler {
    if (!this.finalizationHandler) {
      this.finalizationHandler = new FinalizationHandler(
        this.store,
        this.chain.chainId === 'none' ? undefined : this.chain,
        this.eventBus,
      );
    }
    return this.finalizationHandler;
  }

  /**
   * Create a context graph. All CGs start as free, P2P collaborative spaces.
   * No blockchain transaction is required. On-chain registration is a separate
   * explicit step via {@link registerContextGraph}.
   *
   * The `private` flag still works for truly local-only CGs (no gossip, no sync).
   * For curated CGs, provide `allowedPeers` to restrict gossip writes to listed peers.
   */
  async createContextGraph(opts: {
    id: string;
    name: string;
    description?: string;
    replicationPolicy?: string;
    accessPolicy?: number;
    /** @deprecated Use allowedAgents. Peer allowlist for curated CGs. */
    allowedPeers?: string[];
    /** Agent address allowlist for curated CGs. Omit for open CGs. */
    allowedAgents?: string[];
    /** Identity IDs for private CG access control (chain-based). */
    participantIdentityIds?: bigint[];
    /** Required signatures threshold for participant-based CGs. */
    requiredSignatures?: number;
    /** Participant agent addresses for on-chain context graphs. */
    participantAgents?: string[];
    /** When true, skips gossip subscription and broadcast. Data stays local-only. */
    private?: boolean;
    /** Caller's agent address (resolved from token). Used for curator/creator triples. */
    callerAgentAddress?: string;
  }): Promise<void> {
    const ctx = createOperationContext('system');
    const gm = new GraphManager(this.store);
    const contextGraphUri = `did:dkg:context-graph:${opts.id}`;
    const ontologyGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
    const cgMetaGraph = contextGraphMetaGraphUri(opts.id);
    const now = new Date().toISOString();

    const exists = await this.contextGraphExists(opts.id);
    if (exists) {
      throw new Error(`Context graph "${opts.id}" already exists`);
    }

    const hasLocalAccessControl = opts.accessPolicy === LOCAL_ACCESS_CURATED
      || opts.private === true
      || !!opts.allowedAgents?.length
      || !!opts.allowedPeers?.length;
    if (opts.participantAgents && opts.participantAgents.length > 0 && !hasLocalAccessControl) {
      throw new Error(
        'participantAgents are on-chain registration metadata for curated context graphs. ' +
        'Set accessPolicy: 1 (or private: true) and use allowedAgents for local access control.',
      );
    }

    const isCurated = opts.accessPolicy === LOCAL_ACCESS_CURATED
      || (opts.allowedAgents && opts.allowedAgents.length > 0)
      || (opts.allowedPeers && opts.allowedPeers.length > 0);
    // pcaAccountId is a register-time-only knob (Codex PR #502
    // round-3: `createContextGraph` no longer persists it). The field
    // is intentionally NOT part of the public `createContextGraph`
    // TypeScript signature — TS-first callers get a compile-time
    // excess-property error if they try to set it (Codex round-7).
    // The runtime check below still fires so untyped/JS callers (or
    // typed callers using `as any`) get an immediate, actionable
    // error instead of a confusing "EOA-curated when I asked for PCA"
    // outcome at register time. Daemon callers can't hit this path —
    // the HTTP route already strips the param before calling
    // `createContextGraph`.
    const optsRecord = opts as unknown as Record<string, unknown>;
    if (optsRecord.publishAuthorityAccountId !== undefined) {
      throw new Error(
        '`publishAuthorityAccountId` is not supported on createContextGraph(). '
        + 'PCA account ids are register-time-only — supply `publishAuthorityAccountId` '
        + 'on registerContextGraph() instead. Background: createContextGraph no '
        + 'longer persists PCA ids locally, so any value passed here would silently '
        + 'be dropped before registration (Codex PR #502 round-3/round-6/round-7).',
      );
    }

    if (opts.private) {
      this.log.info(ctx, `Creating private context graph "${opts.id}" (local-only, no gossip)`);
    } else if (isCurated) {
      this.log.info(ctx, `Creating curated context graph "${opts.id}" (invite-only, definition hidden from ONTOLOGY)`);
    } else {
      this.log.info(ctx, `Creating context graph "${opts.id}" (P2P, no chain)`);
    }

    // Curated CGs store definition triples in their own _meta graph so they
    // are NOT discoverable via ONTOLOGY sync. Only invited/subscribed nodes
    // will see them. Open CGs go to ONTOLOGY for network-wide discovery.
    const defGraph = isCurated ? cgMetaGraph : ontologyGraph;

    // DKG_CREATOR records the libp2p peer ID of the hosting node — this is
    // the deterministic handle used by `resolveCuratorPeerId()` to dial the
    // curator for meta refreshes. It must NOT be replaced with a wallet DID.
    //
    // DKG_CURATOR records the caller's wallet identity and is what ownership
    // checks consult (via `getContextGraphOwner`). When a non-default local
    // agent creates a CG, its wallet DID ends up here so later authorization
    // — threaded through daemon routes as `callerAgentAddress` — can match.
    //
    // On-chain operations (registerContextGraph, verify) still bind to the
    // node wallet; per-agent chain signers are a known future enhancement.
    const creatorPeerDid = `did:dkg:agent:${this.peerId}`;
    const curatorDid = `did:dkg:agent:${opts.callerAgentAddress ?? this.defaultAgentAddress ?? this.peerId}`;
    const quads: Quad[] = [
      { subject: contextGraphUri, predicate: DKG_ONTOLOGY.RDF_TYPE, object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH, graph: defGraph },
      { subject: contextGraphUri, predicate: DKG_ONTOLOGY.SCHEMA_NAME, object: `"${opts.name}"`, graph: defGraph },
      { subject: contextGraphUri, predicate: DKG_ONTOLOGY.DKG_CREATOR, object: creatorPeerDid, graph: defGraph },
      { subject: contextGraphUri, predicate: DKG_ONTOLOGY.DKG_CREATED_AT, object: `"${now}"`, graph: defGraph },
      { subject: contextGraphUri, predicate: DKG_ONTOLOGY.DKG_GOSSIP_TOPIC, object: `"${contextGraphPublishTopic(opts.id)}"`, graph: defGraph },
      { subject: contextGraphUri, predicate: DKG_ONTOLOGY.DKG_REPLICATION_POLICY, object: `"${opts.replicationPolicy ?? 'full'}"`, graph: defGraph },
      { subject: contextGraphUri, predicate: DKG_ONTOLOGY.DKG_ACCESS_POLICY, object: `"${isCurated || opts.private ? 'private' : 'public'}"`, graph: defGraph },
    ];

    // Store registration status and curator in _meta. We do NOT
    // store any PCA account id here — that param is register-time-only
    // and createContextGraph rejects it at the boundary (Codex PR
    // #502 round-3 + round-6).
    quads.push(
      { subject: contextGraphUri, predicate: DKG_ONTOLOGY.DKG_REGISTRATION_STATUS, object: `"unregistered"`, graph: cgMetaGraph },
      { subject: contextGraphUri, predicate: DKG_ONTOLOGY.DKG_CURATOR, object: curatorDid, graph: cgMetaGraph },
    );

    // Store peer allowlist for curated CGs (with validation)
    if (opts.allowedPeers && opts.allowedPeers.length > 0) {
      const { peerIdFromString } = await import('@libp2p/peer-id');
      for (const peer of opts.allowedPeers) {
        try { peerIdFromString(peer); } catch {
          throw new Error(`Invalid peer ID in allowedPeers: "${peer}". Expected a libp2p peer ID (e.g. 12D3KooW…).`);
        }
        quads.push({
          subject: contextGraphUri,
          predicate: DKG_ONTOLOGY.DKG_ALLOWED_PEER,
          object: `"${escapeSparqlLiteral(peer)}"`,
          graph: cgMetaGraph,
        });
      }
      quads.push({
        subject: contextGraphUri,
        predicate: DKG_ONTOLOGY.DKG_ALLOWED_PEER,
        object: `"${this.peerId}"`,
        graph: cgMetaGraph,
      });
    }

    // Store agent allowlist (V10 agent identity model)
    if (opts.allowedAgents && opts.allowedAgents.length > 0) {
      const ethAddrRe = /^0x[0-9a-fA-F]{40}$/;
      for (const addr of opts.allowedAgents) {
        if (!ethAddrRe.test(addr)) {
          throw new Error(`Invalid Ethereum address in allowedAgents: "${addr}".`);
        }
        quads.push({
          subject: contextGraphUri,
          predicate: DKG_ONTOLOGY.DKG_ALLOWED_AGENT,
          object: `"${addr}"`,
          graph: cgMetaGraph,
        });
      }
    }

    // Store explicit on-chain participant agents separately from the local
    // curated allowlist. These addresses are forwarded to
    // ContextGraphs.createContextGraph participantAgents on registration.
    if (opts.participantAgents && opts.participantAgents.length > 0) {
      if (opts.participantAgents.length > MAX_CONTEXT_GRAPH_PARTICIPANT_AGENTS) {
        throw new Error(`participantAgents cannot exceed ${MAX_CONTEXT_GRAPH_PARTICIPANT_AGENTS} addresses.`);
      }
      const seenParticipantAgents = new Set<string>();
      for (const addr of opts.participantAgents) {
        if (!ethers.isAddress(addr)) {
          throw new Error(`Invalid Ethereum address in participantAgents: "${addr}".`);
        }
        const checksumAddress = ethers.getAddress(addr);
        if (checksumAddress === ethers.ZeroAddress) {
          throw new Error('Invalid Ethereum address in participantAgents: zero address is not allowed.');
        }
        const key = checksumAddress.toLowerCase();
        if (seenParticipantAgents.has(key)) {
          throw new Error(`Duplicate Ethereum address in participantAgents: "${checksumAddress}".`);
        }
        seenParticipantAgents.add(key);
        quads.push({
          subject: contextGraphUri,
          predicate: DKG_ONTOLOGY.DKG_PARTICIPANT_AGENT,
          object: `"${checksumAddress}"`,
          graph: cgMetaGraph,
        });
      }
    }

    // Auto-include creator in allowlist for curated/private CGs
    if (isCurated || opts.private) {
      const creatorAddr = opts.callerAgentAddress ?? this.defaultAgentAddress;
      if (creatorAddr) {
        quads.push({
          subject: contextGraphUri,
          predicate: DKG_ONTOLOGY.DKG_ALLOWED_AGENT,
          object: `"${creatorAddr}"`,
          graph: cgMetaGraph,
        });
      }
    }

    // Store participant identity IDs for private CG access control (chain-based, legacy)
    const creatorIdentityId = await this.chain.getIdentityId();
    const participantIdentityIds = new Set<bigint>(opts.participantIdentityIds ?? []);
    if (creatorIdentityId > 0n) {
      participantIdentityIds.add(creatorIdentityId);
    }
    for (const participantIdentityId of participantIdentityIds) {
      quads.push({
        subject: contextGraphUri,
        predicate: DKG_ONTOLOGY.DKG_PARTICIPANT_IDENTITY_ID,
        object: `"${participantIdentityId.toString()}"`,
        graph: cgMetaGraph,
      });
    }
    if (participantIdentityIds.size > 0 && typeof opts.requiredSignatures === 'number' && opts.requiredSignatures > 0) {
      const reqSig = Math.floor(opts.requiredSignatures);
      if (reqSig < 1) {
        throw new Error(`requiredSignatures must be >= 1, got ${opts.requiredSignatures}`);
      }
      if (reqSig > participantIdentityIds.size) {
        throw new Error(`requiredSignatures (${reqSig}) exceeds participant count (${participantIdentityIds.size})`);
      }
      quads.push({
        subject: contextGraphUri,
        predicate: `${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}RequiredSignatures`,
        object: `"${reqSig}"`,
        graph: cgMetaGraph,
      });
    }

    if (opts.description) {
      quads.push({
        subject: contextGraphUri,
        predicate: DKG_ONTOLOGY.SCHEMA_DESCRIPTION,
        object: `"${opts.description}"`,
        graph: defGraph,
      });
    }

    // Provenance activity
    const activityUri = `did:dkg:activity:create-context-graph:${opts.id}:${Date.now()}`;
    quads.push(
      { subject: contextGraphUri, predicate: DKG_ONTOLOGY.PROV_GENERATED_BY, object: activityUri, graph: defGraph },
      { subject: activityUri, predicate: DKG_ONTOLOGY.RDF_TYPE, object: DKG_ONTOLOGY.PROV_ACTIVITY, graph: defGraph },
      { subject: activityUri, predicate: DKG_ONTOLOGY.PROV_ASSOCIATED_WITH, object: `did:dkg:agent:${this.peerId}`, graph: defGraph },
      { subject: activityUri, predicate: DKG_ONTOLOGY.PROV_ENDED_AT_TIME, object: `"${now}"`, graph: defGraph },
    );

    await this.store.insert(quads);
    await gm.ensureContextGraph(opts.id);

    // Force the triple-store flush BEFORE the SQLite caches are written.
    // Without this, a daemon crash within 50ms of the insert would lose the
    // declaration triples (best-effort debounced flush) while SQLite's WAL
    // would survive — leaving ghost CGs that show up in the dashboard but
    // don't exist in the graph. Awaiting flush here makes the create durable
    // before the caller is told it succeeded.
    await this.store.flush?.();

    this.setContextGraphSubscription(opts.id, {
      name: opts.name,
      subscribed: !opts.private,
      synced: true,
      metaSynced: true,
    });

    if (opts.private || isCurated) {
      this.upsertContextGraphMember({
        contextGraphId: opts.id,
        principalType: 'node',
        principalId: this.peerId,
        role: 'curator',
        status: 'active',
        source: 'local-create',
        displayName: this.nodeName,
      });
    }

    const curatorAgentAddress = opts.callerAgentAddress ?? this.defaultAgentAddress;
    if (curatorAgentAddress) {
      this.upsertContextGraphMember({
        contextGraphId: opts.id,
        principalType: 'agent',
        principalId: curatorAgentAddress,
        role: 'curator',
        status: 'active',
        source: 'local-create',
      });
    }

    for (const peer of opts.allowedPeers ?? []) {
      this.upsertContextGraphMember({
        contextGraphId: opts.id,
        principalType: 'node',
        principalId: peer,
        role: 'participant',
        status: 'active',
        source: 'allowed-peer',
      });
    }

    for (const addr of opts.allowedAgents ?? []) {
      this.upsertContextGraphMember({
        contextGraphId: opts.id,
        principalType: 'agent',
        principalId: addr,
        role: 'participant',
        status: 'active',
        source: 'allowed-agent',
      });
    }

    for (const addr of opts.participantAgents ?? []) {
      if (!ethers.isAddress(addr)) continue;
      this.upsertContextGraphMember({
        contextGraphId: opts.id,
        principalType: 'agent',
        principalId: ethers.getAddress(addr),
        role: 'participant-agent',
        status: 'active',
        source: 'participant-agent',
      });
    }

    for (const identityId of participantIdentityIds) {
      this.upsertContextGraphMember({
        contextGraphId: opts.id,
        principalType: 'identity',
        principalId: identityId.toString(),
        role: 'hosting-node',
        status: 'active',
        source: 'participant-identity',
      });
    }

    // On-chain registration is intentionally NOT done here — per v10 spec
    // §2.2 / §2.3 Context Graphs are a local-first primitive. A CG exists
    // the moment its definition triples land in the store; it can be
    // shared with peers over gossip (SWM writes/reads work across the
    // subscriber set), joined, sub-graphed, and queried without ever
    // touching chain state. Verified Memory is the value-add layer that
    // requires chain registration, and earlier revisions silently minted
    // a `ContextGraphs.createContextGraph` tx from inside this method
    // whenever the adapter supported it. That broke the "free CG"
    // contract the API advertises (HTTP caller opts in via
    // `register: true` on `/api/context-graph/create`), caused surprise
    // TRAC spend, and made test §27e's "VM publish on unregistered CG
    // should fail" impossible to satisfy — the CG was always already
    // registered by the time the test ran.
    //
    // Callers that want on-chain registration MUST now take the
    // explicit path: either `POST /api/context-graph/create` with
    // `register: true` (daemon chains a `registerContextGraph` call
    // after this method returns) or `POST /api/context-graph/register`
    // on an existing local CG. Both paths go through
    // {@link registerContextGraph}, which preserves the creator /
    // curator checks and writes the V10 `onChainId` + flips
    // `dkg:registrationStatus` to `"registered"`. Until then the CG
    // carries the `unregistered` marker inserted above, and
    // `dkg-publisher`'s `publishFromSharedMemory` guard
    // (`packages/publisher/src/dkg-publisher.ts:569-594`) throws
    // `Context graph "<id>" is not registered on-chain` on any VM
    // publish attempt.

    if (!opts.private) {
      this.subscribeToContextGraph(opts.id);

      // Curated CGs: definition lives in _meta, NOT in ONTOLOGY. Do not
      // broadcast to the network — only invited nodes will discover it via
      // the explicit subscribe→sync flow.
      if (!isCurated) {
        const ontologyTopic = contextGraphPublishTopic(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
        const broadcastQuads = quads.filter(q => q.graph === ontologyGraph);
        const nquads = broadcastQuads.map(q => {
          const obj = q.object.startsWith('"') ? q.object : `<${q.object}>`;
          return `<${q.subject}> <${q.predicate}> ${obj} <${q.graph}> .`;
        }).join('\n');

        const msg = encodePublishRequest({
          ual: `did:dkg:context-graph:${opts.id}`,
          nquads: new TextEncoder().encode(nquads),
          contextGraphId: SYSTEM_CONTEXT_GRAPHS.ONTOLOGY,
          kas: [],
          publisherIdentity: this.wallet.keypair.publicKey,
          publisherAddress: '',
          startKAId: 0,
          endKAId: 0,
          chainId: '',
          publisherSignatureR: new Uint8Array(0),
          publisherSignatureVs: new Uint8Array(0),
        });

        try {
          await this.gossip.publish(ontologyTopic, msg);
        } catch {
          // No peers subscribed — ok for now
        }
      }
    }
  }

  /**
   * Register an existing context graph on-chain. This is the explicit upgrade
   * step that unlocks Verified Memory, chain-based discovery, and economic
   * participation. Requires a funded wallet with TRAC.
   */
  async registerContextGraph(id: string, opts?: {
    /** @deprecated V10 ContextGraphs registration ignores metadata reveal. */
    revealOnChain?: boolean;
    accessPolicy?: number;
    publishPolicy?: number;
    callerAgentAddress?: string;
    publishAuthorityAccountId?: bigint;
  }): Promise<{ onChainId: string; txHash?: string }> {
    const ctx = createOperationContext('system');

    if (opts?.revealOnChain === true) {
      this.log.warn(
        ctx,
        'revealOnChain is deprecated and ignored by V10 ContextGraphs registration; metadata reveal uses the legacy name registry path.',
      );
    }

    const exists = await this.contextGraphExists(id);
    if (!exists) {
      throw new Error(`Context graph "${id}" does not exist locally. Create it first.`);
    }

    if (this.chain.chainId === 'none') {
      throw new Error('On-chain registration requires a configured chain adapter');
    }

    // Only the address-scoped curator can register a CG on-chain.
    // Peer IDs are transport contact handles for sync/meta refresh, not EVM
    // authority identifiers. For legacy local CGs that only have a creator
    // peer DID, the local creator node may lazily stamp its address curator
    // before registering; foreign peer-only CGs must first sync a curator.
    //
    // If no owner triple exists yet (bootstrap CGs created via
    // `ensureContextGraphLocal` deliberately do not stamp ownership), the
    // calling node lazily becomes both creator/contact and curator here.
    // This keeps the stamp single-writer (no race over `LIMIT 1`).
    const selfPeerDid = `did:dkg:agent:${this.peerId}`;
    const stampAddressCurator = async (): Promise<string> => {
      const curatorAddress = opts?.callerAgentAddress ?? this.defaultAgentAddress;
      if (!curatorAddress || !ethers.isAddress(curatorAddress)) {
        throw new Error(
          `Context graph "${id}" cannot be registered on-chain without an address-scoped curator. ` +
          'Use an authenticated agent wallet or configure a default agent address.',
        );
      }

      const cgMetaGraph = contextGraphMetaUri(id);
      const ontologyGraph = contextGraphDataUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
      const contextGraphUri = `did:dkg:context-graph:${id}`;
      const accessPolicyResult = await this.store.query(
        `SELECT ?ap WHERE {
          { GRAPH <${ontologyGraph}> { <${contextGraphUri}> <${DKG_ONTOLOGY.DKG_ACCESS_POLICY}> ?ap } }
          UNION
          { GRAPH <${cgMetaGraph}> { <${contextGraphUri}> <${DKG_ONTOLOGY.DKG_ACCESS_POLICY}> ?ap } }
        } LIMIT 1`,
      );
      const apValue = accessPolicyResult.type === 'bindings'
        ? accessPolicyResult.bindings[0]?.['ap']?.replace(/^"|"$/g, '')
        : undefined;
      const isCurated = apValue === 'private';
      const defGraph = isCurated ? cgMetaGraph : ontologyGraph;
      const creatorPeerDid = `did:dkg:agent:${this.peerId}`;
      const curatorDid = `did:dkg:agent:${curatorAddress}`;
      // Defensive: replace any stray creator/curator triples (e.g. from
      // a previous build that backfilled per node) so this register call
      // becomes the single source of truth.
      await this.store.deleteByPattern({ graph: defGraph, subject: contextGraphUri, predicate: DKG_ONTOLOGY.DKG_CREATOR });
      await this.store.deleteByPattern({ graph: cgMetaGraph, subject: contextGraphUri, predicate: DKG_ONTOLOGY.DKG_CREATOR });
      await this.store.deleteByPattern({ graph: cgMetaGraph, subject: contextGraphUri, predicate: DKG_ONTOLOGY.DKG_CURATOR });
      await this.store.insert([
        { subject: contextGraphUri, predicate: DKG_ONTOLOGY.DKG_CREATOR, object: creatorPeerDid, graph: defGraph },
        { subject: contextGraphUri, predicate: DKG_ONTOLOGY.DKG_CURATOR, object: curatorDid, graph: cgMetaGraph },
      ]);
      this.log.info(ctx, `Stamped local node as creator contact and address curator for "${id}" (registration-time lazy stamp)`);
      return curatorDid;
    };

    let owner = await this.getContextGraphCurator(id);
    if (!owner) {
      const existingCreator = await this.getContextGraphCreator(id);
      if (existingCreator && !this.isCallerOrNodeOwner(existingCreator, opts?.callerAgentAddress)) {
        throw new Error(
          `Context graph "${id}" has no address-scoped curator and was created by ${existingCreator}. ` +
          'Sync curator metadata or ask the curator to register it on-chain.',
        );
      }
      owner = await stampAddressCurator();
    } else {
      const ownerTail = owner.replace(/^did:dkg:agent:/, '');
      if (!ethers.isAddress(ownerTail)) {
        if (owner === selfPeerDid) {
          owner = await stampAddressCurator();
        } else {
          throw new Error(
            `Context graph "${id}" has a peer-scoped curator (${owner}) and cannot be registered on-chain by this node. ` +
            'Sync address-scoped curator metadata or ask the curator to register it on-chain.',
          );
        }
      }
    }
    if (!this.isCallerOrNodeAddressOwner(owner, opts?.callerAgentAddress)) {
      throw new Error(
        `Only the context graph curator can register it on-chain. ` +
        `Curator=${owner}, caller=${`did:dkg:agent:${opts?.callerAgentAddress ?? this.defaultAgentAddress ?? this.peerId}`}`,
      );
    }
    const ownerAddress = ethers.getAddress(owner.replace(/^did:dkg:agent:/, ''));
    // Check if already registered
    const cgMetaGraph = contextGraphMetaUri(id);
    const contextGraphUri = `did:dkg:context-graph:${id}`;
    const statusResult = await this.store.query(
      `SELECT ?status WHERE { GRAPH <${cgMetaGraph}> { <${contextGraphUri}> <${DKG_ONTOLOGY.DKG_REGISTRATION_STATUS}> ?status } } LIMIT 1`,
    );
    if (statusResult.type === 'bindings' && statusResult.bindings[0]?.['status']?.replace(/^"|"$/g, '') === 'registered') {
      const existingOnChainId = this.subscribedContextGraphs.get(id)?.onChainId;
      throw new Error(`Context graph "${id}" is already registered on-chain${existingOnChainId ? ` (${existingOnChainId})` : ''}`);
    }

    // Read existing description and access policy. Curated CGs store
    // definition in _meta rather than ONTOLOGY, so check both locations.
    const ontologyGraph = contextGraphDataUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
    const descResult = await this.store.query(
      `SELECT ?desc WHERE {
        { GRAPH <${ontologyGraph}> { <${contextGraphUri}> <${DKG_ONTOLOGY.SCHEMA_DESCRIPTION}> ?desc } }
        UNION
        { GRAPH <${cgMetaGraph}> { <${contextGraphUri}> <${DKG_ONTOLOGY.SCHEMA_DESCRIPTION}> ?desc } }
      } LIMIT 1`,
    );
    const description = descResult.type === 'bindings' ? descResult.bindings[0]?.['desc']?.replace(/^"|"$/g, '') : undefined;

    let resolvedLocalAccessPolicy = opts?.accessPolicy;
    if (resolvedLocalAccessPolicy !== undefined && resolvedLocalAccessPolicy !== LOCAL_ACCESS_OPEN && resolvedLocalAccessPolicy !== LOCAL_ACCESS_CURATED) {
      throw new Error('accessPolicy must be 0 (open) or 1 (private/curated)');
    }
    if (resolvedLocalAccessPolicy === undefined) {
      resolvedLocalAccessPolicy = await this.isPrivateContextGraph(id)
        ? LOCAL_ACCESS_CURATED
        : LOCAL_ACCESS_OPEN;
    }
    if (opts?.publishPolicy !== undefined && opts.publishPolicy !== EVM_PUBLISH_CURATED && opts.publishPolicy !== EVM_PUBLISH_OPEN) {
      throw new Error('publishPolicy must be 0 (curated) or 1 (open)');
    }
    const publishPolicy = opts?.publishPolicy ?? (resolvedLocalAccessPolicy === LOCAL_ACCESS_CURATED
      ? EVM_PUBLISH_CURATED
      : EVM_PUBLISH_OPEN);
    // PCA account id is ONLY honored from the explicit option here.
    // We deliberately do NOT fall back to a stored value (Codex PR
    // #502 round-6): legacy CGs created under the old create-time
    // persistence could have stale/bad ids that would silently replay
    // on every register retry that omits the param. With explicit-only
    // resolution, `undefined` unambiguously means "no PCA".
    //
    // The option type advertises `bigint`, but untyped / JS callers can
    // pass `1` or `'1'` — comparing a non-bigint to `0n` would throw a
    // raw `TypeError: Cannot mix BigInt and other types` instead of the
    // actionable validation error this API is supposed to provide
    // (Codex PR #502 round-8). Coerce safely before the `<= 0n` check.
    const rawPublishAuthorityAccountId = opts?.publishAuthorityAccountId as unknown;
    let requestedPublishAuthorityAccountId: bigint | undefined;
    if (rawPublishAuthorityAccountId !== undefined && rawPublishAuthorityAccountId !== null) {
      if (typeof rawPublishAuthorityAccountId === 'bigint') {
        requestedPublishAuthorityAccountId = rawPublishAuthorityAccountId;
      } else if (typeof rawPublishAuthorityAccountId === 'number') {
        // Codex PR #502 round-9: reject unsafe JS integers. Anything
        // above `Number.MAX_SAFE_INTEGER` (2^53-1) is silently
        // rounded BEFORE `BigInt(...)` sees it, which would let an
        // untyped caller register against an entirely different PCA
        // account id than they intended. Mirrors
        // `parseOptionalPcaAccountId` in the daemon route.
        if (!Number.isSafeInteger(rawPublishAuthorityAccountId) || rawPublishAuthorityAccountId <= 0) {
          throw new Error('PCA account id must be a positive integer.');
        }
        requestedPublishAuthorityAccountId = BigInt(rawPublishAuthorityAccountId);
      } else if (typeof rawPublishAuthorityAccountId === 'string' && /^[1-9]\d*$/.test(rawPublishAuthorityAccountId)) {
        // Decimal strings can carry arbitrary-precision values
        // safely (BigInt preserves them), so no safe-integer ceiling
        // applies — that's the recommended path for ids above 2^53.
        requestedPublishAuthorityAccountId = BigInt(rawPublishAuthorityAccountId);
      } else {
        throw new Error('PCA account id must be a positive integer.');
      }
      if (requestedPublishAuthorityAccountId <= 0n) {
        throw new Error('PCA account id must be a positive integer.');
      }
    }
    const publishAuthorityAccountId = requestedPublishAuthorityAccountId;
    // PCA account ids are only invalid when the publish policy is
    // open (`publishPolicy === EVM_PUBLISH_OPEN`) — that combination
    // is incoherent on-chain because `isAuthorizedPublisher`'s PCA
    // branch never fires for open publish policy.
    //
    // We do NOT also reject `accessPolicy=0 (public/discoverable)`
    // here: the on-chain `ContextGraphs.createContextGraph` contract
    // explicitly supports `{ accessPolicy: 0, publishPolicy: 0,
    // publishAuthorityAccountId: !=0 }` — a publicly-discoverable CG
    // where only the PCA owner / authorized publishers can write.
    // Rejecting that combo client-side blocks a valid registration
    // mode (Codex PR #502 round-7).
    if (publishAuthorityAccountId !== undefined && publishPolicy === EVM_PUBLISH_OPEN) {
      throw new Error('PCA account id can only be used with curated publish policy.');
    }
    // NOTE: we intentionally defer persisting `requestedPublishAuthorityAccountId`
    // until *after* on-chain registration succeeds (further down). If we
    // wrote it here and the subsequent owner check / on-chain call failed
    // with a bad PCA id, the bad id would stick in local CG metadata and
    // every retry would replay the same failure (Codex review #502-1).
    const isPcaCurated = publishPolicy === EVM_PUBLISH_CURATED
      && publishAuthorityAccountId !== undefined;

    const participantsResult = await this.store.query(
      `SELECT ?identityId WHERE { GRAPH <${cgMetaGraph}> { <${contextGraphUri}> <${DKG_ONTOLOGY.DKG_PARTICIPANT_IDENTITY_ID}> ?identityId } }`,
    );
    const participantIdentityIds = participantsResult.type === 'bindings'
      ? participantsResult.bindings
          .map((binding) => binding['identityId']?.replace(/^"|"$/g, ''))
          .filter((value): value is string => !!value)
          .map((value) => BigInt(value))
          .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
          .filter((value, index, arr) => index === 0 || value !== arr[index - 1])
      : [];

    const requiredSignaturesResult = await this.store.query(
      `SELECT ?required WHERE { GRAPH <${cgMetaGraph}> { <${contextGraphUri}> <${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}RequiredSignatures> ?required } } LIMIT 1`,
    );
    const storedRequiredSignatures = requiredSignaturesResult.type === 'bindings'
      ? Number(requiredSignaturesResult.bindings[0]?.['required']?.replace(/^"|"$/g, ''))
      : NaN;

    // Check if already registered on-chain (prevents duplicate minting)
    const existingOnChainId = await this.getContextGraphOnChainId(id);
    if (existingOnChainId) {
      this.log.info(ctx, `Context graph "${id}" already has on-chain ID ${existingOnChainId} — skipping chain call`);
      await this.store.deleteByPattern({
        graph: cgMetaGraph,
        subject: contextGraphUri,
        predicate: DKG_ONTOLOGY.DKG_REGISTRATION_STATUS,
      });
      await this.store.insert([
        { subject: contextGraphUri, predicate: DKG_ONTOLOGY.DKG_REGISTRATION_STATUS, object: `"registered"`, graph: cgMetaGraph },
      ]);
      return { onChainId: existingOnChainId, txHash: undefined };
    }

    let effectiveParticipantIdentityIds = participantIdentityIds;
    if (effectiveParticipantIdentityIds.length === 0) {
      const selfIdentityId = await this.ensureIdentity();
      if (selfIdentityId === 0n) {
        throw new Error(
          `Context graph "${id}" cannot be registered on-chain without an on-chain identity. ` +
          'Create/ensure the curator identity first.',
        );
      }
      effectiveParticipantIdentityIds = [selfIdentityId];
    }

    const effectiveRequiredSignatures = Number.isInteger(storedRequiredSignatures) && storedRequiredSignatures > 0
      ? storedRequiredSignatures
      : 1;
    const participantAgents = await this.getContextGraphParticipantAgentAddresses(id);
    if (participantAgents.length > MAX_CONTEXT_GRAPH_PARTICIPANT_AGENTS) {
      throw new Error(
        `Context graph "${id}" cannot be registered on-chain: participantAgents cannot exceed ` +
        `${MAX_CONTEXT_GRAPH_PARTICIPANT_AGENTS} addresses after merging local allowedAgents.`,
      );
    }
    let publishAuthority: string | undefined;
    if (publishPolicy === EVM_PUBLISH_CURATED) {
      if (isPcaCurated) {
        if (typeof this.chain.getPublishingConvictionAccountOwner !== 'function') {
          throw new Error('PCA curated context graph registration requires chain adapter PCA owner lookup support.');
        }
        // Translate KNOWN nonexistent-token reverts on the PCA NFT into
        // a stable, caller-input-shaped error so the daemon route can
        // map it cleanly to 404. Anything else (RPC outage, network
        // glitch, adapter-internal failure) is rethrown with its
        // original class/message so the daemon's catch surfaces it as a
        // retriable 500/503 rather than a misleading 404 (Codex review
        // #502-3 follow-up: don't blanket-translate every adapter
        // failure as "does not exist").
        try {
          publishAuthority = ethers.getAddress(
            await this.chain.getPublishingConvictionAccountOwner(publishAuthorityAccountId),
          );
        } catch (lookupErr: any) {
          const lookupMsg = String(lookupErr?.message ?? lookupErr ?? '');
          const errCode = String(lookupErr?.code ?? '');
          // Patterns we recognise as "this PCA token doesn't exist":
          //   - OZ ERC721 custom error (modern: `ERC721NonexistentToken`,
          //     legacy: `ERC721: invalid token ID` / `nonexistent token`).
          //   - The built-in `MockChainAdapter.getPublishingConvictionAccountOwner`
          //     throws `Mock: PCA account <id> does not exist` (production
          //     mock used by SDK callers). Recognized via the broader
          //     `/PCA account \d+ does not exist/` pattern (Codex PR #502
          //     round-6: this matcher used to recognize only the test
          //     double's wording, so the built-in mock path bypassed
          //     normalization).
          //   - The agent-test test double's `No mock PCA owner for
          //     account ...` parity throw.
          //   - ethers v6 surfaces these as `BAD_DATA` / `CALL_EXCEPTION`
          //     with the OZ error name in the message.
          const isNonexistentToken =
            /ERC721NonexistentToken/.test(lookupMsg)
            || /invalid token ID/i.test(lookupMsg)
            || /nonexistent token/i.test(lookupMsg)
            || /PCA account \d+ does not exist/.test(lookupMsg)
            || /No mock PCA owner for account/.test(lookupMsg)
            || (errCode === 'CALL_EXCEPTION' && /ERC721/.test(lookupMsg));
          if (isNonexistentToken) {
            throw new Error(
              `PCA account ${publishAuthorityAccountId} does not exist or cannot be looked up: ${lookupMsg}`,
            );
          }
          throw lookupErr;
        }
      } else {
        publishAuthority = await this.getChainPublishAuthorityAddress(id);
      }
      // Uniform strict check across EOA and PCA modes:
      //  - EOA: publishAuthority is the chain signer; local curator
      //    must equal the chain signer.
      //  - PCA: publishAuthority is ownerOf(pcaAccountId); local curator
      //    must equal the PCA owner. Registered agents are publish-time
      //    delegates only — publish-time authorization lives on chain in
      //    `ContextGraphs.isAuthorizedPublisher`.
      if (publishAuthority && ownerAddress.toLowerCase() !== publishAuthority.toLowerCase()) {
        const reason = isPcaCurated
          ? `PCA account ${publishAuthorityAccountId} is owned by ${publishAuthority}; only the PCA owner can register, registered agents may only publish.`
          : `the configured chain signer is ${publishAuthority}. Per-agent chain signers are not supported yet.`;
        throw new Error(
          `Context graph "${id}" cannot be registered as curated by local curator ${ownerAddress} because ${reason}`,
        );
      }
      // PCA-only: the chain signer (= msg.sender for the registration
      // tx) MUST equal the PCA owner. `ContextGraphs.createContextGraph`
      // on-chain mints the governance NFT to msg.sender, so any
      // divergence between the configured chain signer and the PCA
      // owner would make the chain signer (not the advertised PCA owner)
      // the actual on-chain context-graph owner — breaking later
      // `onlyContextGraphOwner` operations (publish-policy/authority
      // updates, etc.). Per Codex PR #502 round-4/5: keep "advertised
      // curator == on-chain owner == chain signer == PCA owner" and
      // FAIL CLOSED when the registration signer cannot be
      // introspected — a custom adapter that exposes
      // `getPublishingConvictionAccountOwner()` but not its tx signer
      // would otherwise sneak past the invariant. Codex PR #502
      // round-8: use the dedicated `getRegistrationTxSignerAddress`
      // probe so future readers can't confuse it with a publish-time
      // delegate principal.
      if (isPcaCurated && publishAuthority) {
        const chainSigner = await this.getRegistrationTxSignerAddress();
        if (!chainSigner) {
          throw new Error(
            `Context graph "${id}" cannot be PCA-registered: the chain adapter does not expose its registration-tx signer, so the "chain signer == PCA owner" invariant cannot be verified. PCA mode requires a chain adapter that surfaces its signer (e.g. via \`signerAddress\` / \`getSignerAddress()\` / \`getOperationalPrivateKey()\`) so the on-chain governance NFT is guaranteed to mint to the advertised PCA owner.`,
          );
        }
        if (chainSigner.toLowerCase() !== publishAuthority.toLowerCase()) {
          throw new Error(
            `Context graph "${id}" cannot be PCA-registered: chain signer ${chainSigner} differs from PCA owner ${publishAuthority}. The PCA owner must control the chain signer used to submit the registration tx; otherwise the on-chain governance NFT mints to ${chainSigner} rather than the advertised curator.`,
          );
        }
      }
      if (
        !publishAuthority
        && opts?.callerAgentAddress
        && this.defaultAgentAddress
        && opts.callerAgentAddress.toLowerCase() !== this.defaultAgentAddress.toLowerCase()
      ) {
        throw new Error(
          `Context graph "${id}" cannot be registered as curated by non-default local curator ` +
          `${opts.callerAgentAddress} without chain signer introspection. Per-agent chain signers are not supported yet.`,
        );
      }
    }

    const result = await this.registerContextGraphOnChain({
      participantIdentityIds: effectiveParticipantIdentityIds,
      requiredSignatures: effectiveRequiredSignatures,
      accessPolicy: resolvedLocalAccessPolicy,
      publishPolicy,
      ...(publishAuthority ? { publishAuthority } : {}),
      ...(isPcaCurated ? { publishAuthorityAccountId } : {}),
      participantAgents,
    });
    const onChainId = result.contextGraphId.toString();

    this.log.info(ctx, `Context graph "${id}" registered on-chain: ${onChainId}`);

    // Update _meta with registered status and on-chain ID
    await this.store.deleteByPattern({
      graph: cgMetaGraph,
      subject: contextGraphUri,
      predicate: DKG_ONTOLOGY.DKG_REGISTRATION_STATUS,
    });
    await this.store.insert([
      { subject: contextGraphUri, predicate: DKG_ONTOLOGY.DKG_REGISTRATION_STATUS, object: `"registered"`, graph: cgMetaGraph },
      { subject: contextGraphUri, predicate: `${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}OnChainId`, object: `"${onChainId}"`, graph: ontologyGraph },
    ]);
    // We no longer persist `publishAuthorityAccountId` locally even on
    // success (Codex PR #502 round-6 follow-through): with the
    // stored-value fallback gone, nothing reads it. A CG can only
    // register on-chain once anyway — re-reads of the stored id
    // wouldn't be useful.

    // Update in-memory subscription record and ensure we're subscribed
    const sub = this.subscribedContextGraphs.get(id);
    if (sub) {
      sub.onChainId = onChainId;
      if (!sub.subscribed) {
        sub.subscribed = true;
        this.subscribeToContextGraph(id, { trackSyncScope: true });
        this.log.info(ctx, `Subscribed to newly registered context graph "${id}"`);
      }
      this.persistContextGraphSubscription(id);
    }

    // Registration status is in _meta — it propagates to peers via sync, not
    // gossip, so that only the authenticated sync path can update it.
    // Broadcast the ontology-graph OnChainId quad so peers see the link.
    try {
      const onChainNquad = `<${contextGraphUri}> <${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}OnChainId> "${onChainId}" <${ontologyGraph}> .`;
      const ontologyTopic = contextGraphPublishTopic(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
      const regMsg = encodePublishRequest({
        ual: `did:dkg:context-graph:${id}`,
        nquads: new TextEncoder().encode(onChainNquad),
        contextGraphId: SYSTEM_CONTEXT_GRAPHS.ONTOLOGY,
        kas: [],
        publisherIdentity: this.wallet.keypair.publicKey,
        publisherAddress: '',
        startKAId: 0,
        endKAId: 0,
        chainId: '',
        publisherSignatureR: new Uint8Array(0),
        publisherSignatureVs: new Uint8Array(0),
      });
      await this.gossip.publish(ontologyTopic, regMsg);
    } catch (err) {
      this.log.debug(ctx, `Registration gossip broadcast failed (peers may not be subscribed yet): ${err instanceof Error ? err.message : String(err)}`);
    }

    return { onChainId };
  }

  /**
   * Invite a peer to join an existing context graph.
   * Adds the peer to the local allowlist in `_meta`.
   */
  async inviteToContextGraph(contextGraphId: string, peerId: string, callerAgentAddress?: string): Promise<void> {
    const ctx = createOperationContext('system');

    // Validate peer ID format (libp2p Ed25519 base58btc, e.g. 12D3KooW…)
    try {
      const { peerIdFromString } = await import('@libp2p/peer-id');
      peerIdFromString(peerId);
    } catch {
      throw new Error(`Invalid peer ID format: "${peerId}". Expected a libp2p peer ID (e.g. 12D3KooW…).`);
    }

    const exists = await this.contextGraphExists(contextGraphId);
    if (!exists) {
      throw new Error(`Context graph "${contextGraphId}" does not exist`);
    }

    // Only the curator/creator can manage the allowlist
    const owner = await this.getContextGraphOwner(contextGraphId);
    if (!owner) {
      throw new Error(
        `Context graph "${contextGraphId}" has no known creator. ` +
        `Wait for sync to complete or create it locally first.`,
      );
    }
    this.assertCallerIsOwner(owner, callerAgentAddress, 'manage peer invitations');

    const cgMetaGraph = contextGraphMetaGraphUri(contextGraphId);
    const contextGraphUri = `did:dkg:context-graph:${contextGraphId}`;
    const escapedPeerId = escapeSparqlLiteral(peerId);

    const existingAllowlist = await this.getContextGraphAllowedPeers(contextGraphId);
    const quadsToInsert: Quad[] = [];

    // If this is the first allowlist entry (CG was open), also add our own
    // peer ID so the curator doesn't lock themselves out.
    if (existingAllowlist === null || existingAllowlist.length === 0) {
      const curatorPeerId = escapeSparqlLiteral(this.peerId);
      quadsToInsert.push({
        subject: contextGraphUri,
        predicate: DKG_ONTOLOGY.DKG_ALLOWED_PEER,
        object: `"${curatorPeerId}"`,
        graph: cgMetaGraph,
      });
    }

    // Skip if already in the allowlist (idempotent)
    if (existingAllowlist?.includes(peerId)) {
      this.upsertContextGraphMember({
        contextGraphId,
        principalType: 'node',
        principalId: peerId,
        role: 'participant',
        status: 'active',
        source: 'allowed-peer',
      });
      this.log.info(ctx, `Peer ${peerId} already in allowlist for "${contextGraphId}" — skipping`);
      return;
    }

    quadsToInsert.push({
      subject: contextGraphUri,
      predicate: DKG_ONTOLOGY.DKG_ALLOWED_PEER,
      object: `"${escapedPeerId}"`,
      graph: cgMetaGraph,
    });

    await this.store.insert(quadsToInsert);

    if (existingAllowlist === null || existingAllowlist.length === 0) {
      this.upsertContextGraphMember({
        contextGraphId,
        principalType: 'node',
        principalId: this.peerId,
        role: 'curator',
        status: 'active',
        source: 'allowed-peer',
        displayName: this.nodeName,
      });
    }
    this.upsertContextGraphMember({
      contextGraphId,
      principalType: 'node',
      principalId: peerId,
      role: 'participant',
      status: 'active',
      source: 'allowed-peer',
    });

    // Allowlist updates are in _meta and propagate to peers via the
    // authenticated sync protocol, not unauthenticated gossip.

    this.log.info(ctx, `Invited peer ${peerId} to context graph "${contextGraphId}"`);
  }

  /**
   * Invite an agent (by Ethereum address) to join an existing context graph.
   * Adds the agent to the local allowlist in `_meta`.
   */
  async inviteAgentToContextGraph(
    contextGraphId: string,
    agentAddress: string,
    callerAgentAddress?: string,
    delegation?: SignedAgentDelegation,
  ): Promise<void> {
    const ctx = createOperationContext('system');
    const ethAddrRe = /^0x[0-9a-fA-F]{40}$/;
    if (!ethAddrRe.test(agentAddress)) {
      throw new Error(`Invalid Ethereum address: "${agentAddress}".`);
    }

    const exists = await this.contextGraphExists(contextGraphId);
    if (!exists) {
      throw new Error(`Context graph "${contextGraphId}" does not exist`);
    }

    const owner = await this.getContextGraphOwner(contextGraphId);
    if (!owner) {
      throw new Error(
        `Context graph "${contextGraphId}" has no known creator. ` +
        `Wait for sync to complete or create it locally first.`,
      );
    }
    this.assertCallerIsOwner(owner, callerAgentAddress, 'manage invitations');

    const cgMetaGraph = contextGraphMetaGraphUri(contextGraphId);
    const contextGraphUri = contextGraphDataGraphUri(contextGraphId);
    const quadsToInsert: Quad[] = [];

    const existingParticipants = await this.getPrivateContextGraphParticipants(contextGraphId);
    if ((!existingParticipants || existingParticipants.length === 0) && this.defaultAgentAddress) {
      quadsToInsert.push({
        subject: contextGraphUri,
        predicate: DKG_ONTOLOGY.DKG_ALLOWED_AGENT,
        object: `"${this.defaultAgentAddress}"`,
        graph: cgMetaGraph,
      });
      this.upsertContextGraphMember({
        contextGraphId,
        principalType: 'agent',
        principalId: this.defaultAgentAddress,
        role: 'curator',
        status: 'active',
        source: 'allowed-agent',
      });
    }

    quadsToInsert.push({
      subject: contextGraphUri,
      predicate: DKG_ONTOLOGY.DKG_ALLOWED_AGENT,
      object: `"${agentAddress}"`,
      graph: cgMetaGraph,
    });

    // If the agent gave us a signed delegation (via the join-request
    // path), promote its delegatee identifiers into the CG's allowlist
    // so post-approval sync requests from the joiner's node pass auth
    // even though they're signed by the node's operational key (which
    // is NOT the agent's primary key).
    //
    // Each (cg, agent) pair gets ONE delegation node — re-approving
    // the same agent overwrites the prior delegation.
    if (delegation) {
      const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
      const DKG = 'https://dkg.network/ontology#';
      const delegationUri = `did:dkg:agent-delegation:${contextGraphId}:${agentAddress.toLowerCase()}`;
      await this.store.deleteByPattern({ graph: cgMetaGraph, subject: delegationUri });
      quadsToInsert.push({ subject: delegationUri, predicate: RDF_TYPE, object: `${DKG}AgentDelegation`, graph: cgMetaGraph });
      quadsToInsert.push({ subject: delegationUri, predicate: DKG_ONTOLOGY.DKG_DELEGATION_AGENT, object: `"${agentAddress.toLowerCase()}"`, graph: cgMetaGraph });
      quadsToInsert.push({ subject: delegationUri, predicate: DKG_ONTOLOGY.DKG_DELEGATION_ISSUED_AT, object: `"${delegation.issuedAtMs}"`, graph: cgMetaGraph });
      if (delegation.expiresAtMs && delegation.expiresAtMs > 0) {
        quadsToInsert.push({ subject: delegationUri, predicate: DKG_ONTOLOGY.DKG_DELEGATION_EXPIRES_AT, object: `"${delegation.expiresAtMs}"`, graph: cgMetaGraph });
      }
      if (delegation.delegateePeerId) {
        quadsToInsert.push({ subject: delegationUri, predicate: DKG_ONTOLOGY.DKG_ALLOWED_DELEGATEE_PEER, object: `"${delegation.delegateePeerId}"`, graph: cgMetaGraph });
      }
      if (delegation.delegateeOpKey) {
        quadsToInsert.push({ subject: delegationUri, predicate: DKG_ONTOLOGY.DKG_ALLOWED_DELEGATEE_KEY, object: `"${delegation.delegateeOpKey.toLowerCase()}"`, graph: cgMetaGraph });
      }
    }

    await this.store.insert(quadsToInsert);
    this.upsertContextGraphMember({
      contextGraphId,
      principalType: 'agent',
      principalId: agentAddress,
      role: 'participant',
      status: 'active',
      source: 'allowed-agent',
    });

    this.log.info(
      ctx,
      delegation
        ? `Invited agent ${agentAddress} to context graph "${contextGraphId}" with delegation (peer=${delegation.delegateePeerId ?? 'n/a'}, opKey=${delegation.delegateeOpKey ?? 'n/a'})`
        : `Invited agent ${agentAddress} to context graph "${contextGraphId}"`,
    );
  }

  /**
   * Remove an agent from a context graph's allowlist.
   */
  async removeAgentFromContextGraph(contextGraphId: string, agentAddress: string, callerAgentAddress?: string): Promise<void> {
    const ctx = createOperationContext('system');
    const ethAddrRe = /^0x[0-9a-fA-F]{40}$/;
    if (!ethAddrRe.test(agentAddress)) {
      throw new Error(`Invalid Ethereum address: "${agentAddress}".`);
    }

    const exists = await this.contextGraphExists(contextGraphId);
    if (!exists) {
      throw new Error(`Context graph "${contextGraphId}" does not exist`);
    }

    const owner = await this.getContextGraphOwner(contextGraphId);
    if (!owner) {
      throw new Error(
        `Context graph "${contextGraphId}" has no known creator. ` +
        `Wait for sync to complete or create it locally first.`,
      );
    }
    this.assertCallerIsOwner(owner, callerAgentAddress, 'manage participants');

    const cgMetaGraph = contextGraphMetaGraphUri(contextGraphId);
    const contextGraphUri = contextGraphDataGraphUri(contextGraphId);

    await this.store.deleteByPattern({
      graph: cgMetaGraph,
      subject: contextGraphUri,
      predicate: DKG_ONTOLOGY.DKG_ALLOWED_AGENT,
      object: `"${agentAddress}"`,
    });
    // Also drop any agent-delegation for this agent, otherwise their
    // node retains sync access via the delegation gate (peer-id /
    // op-key allowlist) even after the agent is removed from the
    // primary allowlist. See `inviteAgentToContextGraph` for the
    // matching write side.
    const delegationUri = `did:dkg:agent-delegation:${contextGraphId}:${agentAddress.toLowerCase()}`;
    await this.store.deleteByPattern({ graph: cgMetaGraph, subject: delegationUri });
    this.deleteContextGraphMember(contextGraphId, 'agent', agentAddress);
    this.queueSharedMemoryGossipSubscription(contextGraphId);

    this.log.info(ctx, `Removed agent ${agentAddress} from context graph "${contextGraphId}"`);
  }

  /**
   * Rename a context graph (updates its `schema:name` display label).
   *
   * Writes into BOTH the ONTOLOGY graph (primary source for
   * `listContextGraphs()` on open CGs) and the CG's `_meta` graph
   * (used as the private/curated CG definition index) so the rename is
   * durable regardless of which graph type the CG was originally created
   * in. Previous display-name triples are wiped from both graphs first
   * to guarantee idempotent rename (no "two names in the store").
   *
   * Authorization: same as other CG mutations — only the creator can
   * rename. Enforced via `assertCallerIsOwner`.
   */
  async renameContextGraph(
    contextGraphId: string,
    name: string,
    callerAgentAddress?: string,
  ): Promise<void> {
    const ctx = createOperationContext('system');
    const trimmed = typeof name === 'string' ? name.trim() : '';
    if (!trimmed) {
      throw new Error('Context graph name must be a non-empty string.');
    }

    const exists = await this.contextGraphExists(contextGraphId);
    if (!exists) {
      throw new Error(`Context graph "${contextGraphId}" does not exist`);
    }

    const owner = await this.getContextGraphOwner(contextGraphId);
    if (!owner) {
      throw new Error(
        `Context graph "${contextGraphId}" has no known creator. ` +
        `Wait for sync to complete or create it locally first.`,
      );
    }
    this.assertCallerIsOwner(owner, callerAgentAddress, 'rename context graph');

    const ontologyGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
    const cgMetaGraph = contextGraphMetaGraphUri(contextGraphId);
    const contextGraphUri = contextGraphDataGraphUri(contextGraphId);
    const schemaName = DKG_ONTOLOGY.SCHEMA_NAME;

    await this.store.deleteByPattern({
      subject: contextGraphUri,
      predicate: schemaName,
      graph: ontologyGraph,
    });
    await this.store.deleteByPattern({
      subject: contextGraphUri,
      predicate: schemaName,
      graph: cgMetaGraph,
    });

    const escaped = `"${escapeSparqlLiteral(trimmed)}"`;
    await this.store.insert([
      { subject: contextGraphUri, predicate: schemaName, object: escaped, graph: ontologyGraph },
      { subject: contextGraphUri, predicate: schemaName, object: escaped, graph: cgMetaGraph },
    ]);

    this.log.info(ctx, `Renamed context graph "${contextGraphId}" to "${trimmed}"`);
  }

  /**
   * List allowed agents for a context graph.
   */
  async getContextGraphAllowedAgents(contextGraphId: string): Promise<string[]> {
    const cgMetaGraph = contextGraphMetaGraphUri(contextGraphId);
    const contextGraphUri = contextGraphDataGraphUri(contextGraphId);
    const result = await this.store.query(
      `SELECT ?agent WHERE {
        GRAPH <${cgMetaGraph}> {
          <${contextGraphUri}> <${DKG_ONTOLOGY.DKG_ALLOWED_AGENT}> ?agent
        }
      }`,
    );
    if (result.type !== 'bindings') return [];
    return result.bindings
      .map((row) => (row as Record<string, string>)['agent'])
      .filter((v): v is string => typeof v === 'string')
      .map((v) => v.replace(/^"|"$/g, ''));
  }

  // ---------------------------------------------------------------------------
  // Join Request — signed request / approval flow for curated CGs
  // ---------------------------------------------------------------------------

  /**
   * Create a signed join request for a curated context graph.
   * The requesting agent signs `keccak256(contextGraphId ‖ agentAddress ‖ timestamp)`
   * with its custodial wallet, producing a verifiable proof of identity.
   */
  async signJoinRequest(
    contextGraphId: string,
    agentAddress?: string,
  ): Promise<SignedAgentDelegation> {
    const addr = agentAddress ?? this.defaultAgentAddress;
    if (!addr) throw new Error('No agent address available');

    const agent = this.localAgents.get(addr);
    if (!agent?.privateKey) {
      throw new Error(`No private key for agent ${addr} — self-sovereign agents must sign externally`);
    }

    // Bind to BOTH delegatee shapes when available so the agent's
    // approval survives rotation of either key. The libp2p peer-id is
    // always available; the operational key is available when the chain
    // adapter advertises one (typical V10 nodes do).
    const delegateePeerId = this.peerId;
    let delegateeOpKey: string | undefined;
    try {
      delegateeOpKey = await inferAdapterPublisherAddress(this.chain);
    } catch {
      // Best-effort — delegateePeerId alone is sufficient.
    }

    const issuedAtMs = Date.now();
    const expiresAtMs = issuedAtMs + JOIN_DELEGATION_VALIDITY_MS;

    const signed = await signAgentDelegation({
      agentAddress: addr,
      scope: joinDelegationScope(this.chain.deploymentId, contextGraphId),
      issuedAtMs,
      expiresAtMs,
      delegateePeerId,
      delegateeOpKey,
      agentPrivateKey: agent.privateKey,
    });
    // Remember our intent so multi-agent post-approval sync binds to
    // the right agent before `_meta` catches up. Last-write-wins is
    // intentional: a node that re-signs with a different agent has
    // changed its intent for this CG.
    this.localApprovedAgentByCG.set(contextGraphId, addr.toLowerCase());
    return signed;
  }

  /**
   * Verify a signed join-request delegation. Re-uses the generic
   * `verifyAgentDelegation` primitive and pins the scope to this CG.
   * Throws on any failure.
   */
  verifyJoinRequest(contextGraphId: string, delegation: SignedAgentDelegation): SignedAgentDelegation {
    verifyAgentDelegation(delegation, { expectedScope: joinDelegationScope(this.chain.deploymentId, contextGraphId) });
    return delegation;
  }

  /**
   * Store a pending join request — the agent's signed delegation — in
   * the CG's `_meta` graph. The curator can later approve or reject.
   *
   * Persists the FULL delegation (agentAddress, scope, issuedAtMs,
   * expiresAtMs, delegateePeerId, delegateeOpKey, signature) so that
   * approval can re-verify against the same digest, and so that the
   * approved delegatee identifiers can be promoted into the CG's
   * allowlist via `inviteAgentToContextGraph` without round-tripping
   * the joiner.
   */
  async storePendingJoinRequest(
    contextGraphId: string,
    delegation: SignedAgentDelegation,
    agentName?: string,
  ): Promise<void> {
    const cgMetaGraph = contextGraphMetaGraphUri(contextGraphId);
    const requestUri = `did:dkg:join-request:${contextGraphId}:${delegation.agentAddress.toLowerCase()}`;
    const DKG = 'https://dkg.network/ontology#';
    const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
    const SCHEMA_NAME = 'https://schema.org/name';

    await this.store.deleteByPattern({ graph: cgMetaGraph, subject: requestUri });

    // Escape every user-controllable literal. `contextGraphId`, `delegation.scope`,
    // and `agentName` flow from joiner input and can contain `"` or `\`, which
    // would produce invalid N-Quads and fail the insert (or open a SPARQL
    // injection surface). Other fields are validated upstream:
    //   - `agentAddress` and `signature` are 0x-hex (verifyAgentDelegation
    //     recovers an EVM address, so non-hex throws before we get here)
    //   - `issuedAtMs` / `expiresAtMs` are numbers serialised by JS
    //   - `delegateePeerId` / `delegateeOpKey` are protocol-shaped identifiers.
    const quads: Quad[] = [
      { subject: requestUri, predicate: RDF_TYPE, object: `${DKG}JoinRequest`, graph: cgMetaGraph },
      { subject: requestUri, predicate: `${DKG}agentAddress`, object: `"${delegation.agentAddress}"`, graph: cgMetaGraph },
      { subject: requestUri, predicate: `${DKG}contextGraphId`, object: `"${escapeSparqlLiteral(contextGraphId)}"`, graph: cgMetaGraph },
      { subject: requestUri, predicate: `${DKG}signature`, object: `"${delegation.signature}"`, graph: cgMetaGraph },
      { subject: requestUri, predicate: `${DKG}requestTimestamp`, object: `"${delegation.issuedAtMs}"`, graph: cgMetaGraph },
      { subject: requestUri, predicate: `${DKG}requestStatus`, object: `"pending"`, graph: cgMetaGraph },
      { subject: requestUri, predicate: `${DKG}delegationScope`, object: `"${escapeSparqlLiteral(delegation.scope)}"`, graph: cgMetaGraph },
      { subject: requestUri, predicate: DKG_ONTOLOGY.DKG_DELEGATION_ISSUED_AT, object: `"${delegation.issuedAtMs}"`, graph: cgMetaGraph },
    ];
    if (delegation.expiresAtMs && delegation.expiresAtMs > 0) {
      quads.push({ subject: requestUri, predicate: DKG_ONTOLOGY.DKG_DELEGATION_EXPIRES_AT, object: `"${delegation.expiresAtMs}"`, graph: cgMetaGraph });
    }
    if (delegation.delegateePeerId) {
      quads.push({ subject: requestUri, predicate: DKG_ONTOLOGY.DKG_DELEGATION_DELEGATEE_PEER, object: `"${delegation.delegateePeerId}"`, graph: cgMetaGraph });
    }
    if (delegation.delegateeOpKey) {
      quads.push({ subject: requestUri, predicate: DKG_ONTOLOGY.DKG_DELEGATION_DELEGATEE_KEY, object: `"${delegation.delegateeOpKey.toLowerCase()}"`, graph: cgMetaGraph });
    }
    if (agentName) {
      quads.push({ subject: requestUri, predicate: SCHEMA_NAME, object: `"${escapeSparqlLiteral(agentName)}"`, graph: cgMetaGraph });
    }
    await this.store.insert(quads);
    this.upsertContextGraphMember({
      contextGraphId,
      principalType: 'agent',
      principalId: delegation.agentAddress,
      role: 'requester',
      status: 'pending',
      source: 'join-request',
      ...(agentName ? { displayName: agentName } : {}),
      metadata: { timestamp: delegation.issuedAtMs },
    });
    const ctx = createOperationContext('system');
    this.log.info(ctx, `Stored pending join request from ${delegation.agentAddress} for "${contextGraphId}"`);
    // Emit JOIN_REQUEST_RECEIVED here (single source of truth) so the daemon's
    // lifecycle.ts hook turns it into a SQLite notification + SSE broadcast
    // for the curator's UI bell. Previously this emit lived only on the P2P
    // handler in `setupNetworkHandlers`, so a join request that reached the
    // curator via the HTTP `request-join` route's `isCurator` branch (e.g.
    // when joiner and curator are the same node, or when a relay/bridge
    // re-posts the request locally) silently stored without surfacing in
    // notifications. Centralising the emit here means every successful
    // store — regardless of inbound path — produces a notification.
    this.eventBus.emit(DKGEvent.JOIN_REQUEST_RECEIVED, {
      contextGraphId,
      agentAddress: delegation.agentAddress,
      agentName,
    });
  }

  /**
   * Reload a stored join-request delegation in its full
   * `SignedAgentDelegation` shape so it can be re-verified at approval
   * time and its delegatee identifiers promoted into the CG allowlist.
   */
  async loadPendingJoinDelegation(
    contextGraphId: string,
    agentAddress: string,
  ): Promise<SignedAgentDelegation | null> {
    const cgMetaGraph = contextGraphMetaGraphUri(contextGraphId);
    const requestUri = `did:dkg:join-request:${contextGraphId}:${agentAddress.toLowerCase()}`;
    const DKG = 'https://dkg.network/ontology#';
    // Pin to `requestStatus = "pending"` so a previously-rejected (or
    // already-approved) request is not re-loaded and re-approved by
    // mistake — the join-request URI persists across status transitions
    // (only `requestStatus` flips), so without this filter
    // `approveJoinRequest` could resurrect a rejection.
    const result = await this.store.query(
      `SELECT ?sig ?ts ?scope ?expires ?peer ?opkey WHERE {
        GRAPH <${cgMetaGraph}> {
          <${requestUri}> <${DKG}signature> ?sig ;
                          <${DKG}requestTimestamp> ?ts ;
                          <${DKG}requestStatus> "pending" .
          OPTIONAL { <${requestUri}> <${DKG}delegationScope> ?scope }
          OPTIONAL { <${requestUri}> <${DKG_ONTOLOGY.DKG_DELEGATION_EXPIRES_AT}> ?expires }
          OPTIONAL { <${requestUri}> <${DKG_ONTOLOGY.DKG_DELEGATION_DELEGATEE_PEER}> ?peer }
          OPTIONAL { <${requestUri}> <${DKG_ONTOLOGY.DKG_DELEGATION_DELEGATEE_KEY}> ?opkey }
        }
      } LIMIT 1`,
    );
    if (result.type !== 'bindings' || result.bindings.length === 0) return null;
    const strip = (v?: string) => v?.replace(/^"|"$/g, '').replace(/"?\^\^.*$/, '') ?? '';
    const row = result.bindings[0];
    const signature = strip(row['sig']);
    const issuedAtMs = parseInt(strip(row['ts']), 10) || 0;
    const expires = row['expires'] ? parseInt(strip(row['expires']), 10) || 0 : 0;
    const scope = row['scope'] ? strip(row['scope']) : joinDelegationScope(this.chain.deploymentId, contextGraphId);
    const delegateePeerId = row['peer'] ? strip(row['peer']) : undefined;
    const delegateeOpKey = row['opkey'] ? strip(row['opkey']) : undefined;
    if (!signature || !issuedAtMs) return null;
    if (!delegateePeerId && !delegateeOpKey) {
      // Legacy pending row from before the delegation rework — has
      // signature + timestamp but no delegatee identifiers, so the
      // new verifier would reject it with a generic "at least one
      // delegatee identifier is required". Throw a curator-readable
      // error with a migration hint instead.
      throw new Error(
        `Pending join request from ${agentAddress} predates the V10 delegation rework ` +
        `(missing delegatee identifiers). Reject this request and ask the joiner to re-submit; ` +
        `the upgrade is a clean break in the join-request wire format.`,
      );
    }
    return {
      agentAddress,
      scope,
      issuedAtMs,
      ...(expires ? { expiresAtMs: expires } : {}),
      ...(delegateePeerId ? { delegateePeerId } : {}),
      ...(delegateeOpKey ? { delegateeOpKey } : {}),
      signature,
    };
  }

  /**
   * List pending join requests for a context graph.
   */
  async listPendingJoinRequests(
    contextGraphId: string,
  ): Promise<Array<{ agentAddress: string; name?: string; signature: string; timestamp: number; status: string }>> {
    const cgMetaGraph = contextGraphMetaGraphUri(contextGraphId);
    const DKG = 'https://dkg.network/ontology#';
    const result = await this.store.query(
      `SELECT ?addr ?name ?sig ?ts ?status WHERE {
        GRAPH <${cgMetaGraph}> {
          ?req a <${DKG}JoinRequest> ;
               <${DKG}agentAddress> ?addr ;
               <${DKG}signature> ?sig ;
               <${DKG}requestTimestamp> ?ts ;
               <${DKG}requestStatus> ?status .
          OPTIONAL { ?req <https://schema.org/name> ?name }
        }
      }`,
    );
    if (result.type !== 'bindings') return [];
    const strip = (v?: string) => v?.replace(/^"|"$/g, '').replace(/"?\^\^.*$/, '') ?? '';
    return result.bindings.map((row) => ({
      agentAddress: strip(row['addr']),
      name: row['name'] ? strip(row['name']) : undefined,
      signature: strip(row['sig']),
      timestamp: parseInt(strip(row['ts']), 10) || 0,
      status: strip(row['status']),
    })).filter((r) => r.status === 'pending');
  }

  /**
   * Approve a pending join request: verify the signature, add the agent
   * to the allowlist, and mark the request as approved.
   */
  async approveJoinRequest(contextGraphId: string, agentAddress: string, callerAgentAddress?: string): Promise<void> {
    const cgMetaGraph = contextGraphMetaGraphUri(contextGraphId);
    const requestUri = `did:dkg:join-request:${contextGraphId}:${agentAddress.toLowerCase()}`;
    const DKG = 'https://dkg.network/ontology#';

    const delegation = await this.loadPendingJoinDelegation(contextGraphId, agentAddress);
    if (!delegation) {
      throw new Error(`No pending join request found from ${agentAddress}`);
    }
    // Re-verify the signed delegation against the CURRENT clock —
    // approval is an authorisation event so the delegation's
    // expiry must still be in force. If the curator took longer than
    // the joiner's `expiresAtMs` to review, the joiner has to re-sign
    // (their UI will surface the now-expired pending request and
    // prompt them); silently promoting an expired delegation into the
    // sync allowlist would defeat the whole point of binding an expiry
    // into the signed payload. The standard `JOIN_DELEGATION_VALIDITY_MS`
    // is 1 year so this is a non-issue in practice.
    verifyAgentDelegation(delegation, {
      expectedScope: joinDelegationScope(this.chain.deploymentId, contextGraphId),
    });

    await this.inviteAgentToContextGraph(contextGraphId, agentAddress, callerAgentAddress, delegation);

    // Mark request as approved
    await this.store.deleteByPattern({
      graph: cgMetaGraph,
      subject: requestUri,
      predicate: `${DKG}requestStatus`,
    });
    await this.store.insert([{
      subject: requestUri,
      predicate: `${DKG}requestStatus`,
      object: `"approved"`,
      graph: cgMetaGraph,
    }]);

    const ctx = createOperationContext('system');
    this.log.info(ctx, `Approved join request from ${agentAddress} for "${contextGraphId}"`);

    // Notify the requester via P2P so they can auto-subscribe
    this.notifyJoinApproval(contextGraphId, agentAddress).catch((err) => {
      this.log.warn(ctx, `Failed to notify ${agentAddress} of approval: ${err instanceof Error ? err.message : err}`);
    });
  }

  /**
   * Send a P2P notification to the approved agent so their node
   * automatically retries the subscription.
   *
   * Delivers the message ONLY to the requester's peer, resolved via the
   * local agent registry. The earlier implementation broadcast to every
   * connected peer and relied on each recipient's handler to filter by
   * `agentAddress`. That leaked membership information for curated
   * context graphs: every peer on the P2P network learned that
   * `agentAddress` had just been invited to `contextGraphId`, which is
   * exactly the metadata a curated CG is supposed to hide.
   *
   * If the requester isn't in the local registry we fall back to a
   * best-effort dial through their relay address when available. We do
   * NOT broadcast in any case — the invitee will re-learn on their next
   * subscribe attempt if the direct notification fails.
   */
  private async notifyJoinApproval(contextGraphId: string, agentAddress: string): Promise<void> {
    const payload = JSON.stringify({
      type: 'join-approved',
      contextGraphId,
      agentAddress,
    });
    const result = await this.deliverPrivateJoinNotification(
      contextGraphId,
      agentAddress,
      payload,
      'join-approval',
    );
    if (result.delivered) {
      // Successful delivery clears any pending retry from a prior failure
      // (covers the "transport hiccup recovered on its own before the
      // periodic tick fired" case).
      this.joinApprovalRetryQueue.markDelivered(contextGraphId, agentAddress);
      return;
    }
    // The transport-level failure path (`no target peer` is also covered:
    // the peer may show up in discovery later or the invitee may
    // re-submit the join request, both of which we want to retry into).
    const entry = this.joinApprovalRetryQueue.enqueueFailure(
      contextGraphId,
      agentAddress,
      result.error ?? 'unknown',
      Date.now(),
    );
    const ctx = createOperationContext('system');
    this.log.warn(
      ctx,
      `Queued join-approval retry #${entry.attempts} for "${contextGraphId}" → ${agentAddress} ` +
        `(next attempt at ${new Date(entry.nextAttemptAt).toISOString()}, ` +
        `firstFailureAt=${new Date(entry.firstFailureAt).toISOString()}, ` +
        `lastError=${entry.lastError}). ` +
        `Curator-local state is correct; retry will fire on the periodic tick ` +
        `(every ${JOIN_APPROVAL_RETRY_TICK_MS / 1000}s) or opportunistically on the next ` +
        `direct re-connect from the invitee's peer.`,
    );
  }

  /**
   * Re-fire the `join-approved` P2P notification for a previously-approved
   * agent. Idempotent and safe to call multiple times; only the most recent
   * delivery state matters.
   *
   * Used by:
   *   * The periodic retry tick (`processJoinApprovalRetryQueueTick`),
   *   * Opportunistic retry from `connection:open` when the invitee's peer
   *     reconnects (`processJoinApprovalRetryQueueOnConnect`),
   *   * The operator-facing route `POST /api/context-graph/{id}/redeliver-approval`,
   *     which lets an operator (or peer agent via the chat MCP) re-poke
   *     the curator when the automated retry isn't fast enough.
   *
   * Returns delivery details so the caller can surface them in HTTP
   * responses / MCP tool output. Throws on caller errors (no approval row,
   * malformed agent address) so the route handler can return a 4xx.
   */
  async redeliverJoinApproval(
    contextGraphId: string,
    agentAddress: string,
    _callerAgentAddress?: string,
  ): Promise<{
    delivered: boolean;
    peerId: string | null;
    attempts: number;
    error: string | null;
  }> {
    const ethAddrRe = /^0x[0-9a-fA-F]{40}$/;
    if (!ethAddrRe.test(agentAddress)) {
      throw new Error(`Invalid Ethereum address: "${agentAddress}".`);
    }
    const status = await this.getJoinRequestStatus(contextGraphId, agentAddress);
    if (status !== 'approved') {
      // We deliberately don't accept `pending` here. A pending request
      // means the curator hasn't actually approved — re-firing a
      // join-approved notification in that state would be a protocol
      // violation. The caller should go through approveJoinRequest.
      throw new Error(
        `Cannot redeliver join-approval for "${contextGraphId}" → ${agentAddress}: ` +
          `request status is "${status ?? 'none'}", expected "approved". ` +
          `Approve the request first (or have the joiner re-submit if there is no record).`,
      );
    }
    const payload = JSON.stringify({
      type: 'join-approved',
      contextGraphId,
      agentAddress,
    });
    const result = await this.deliverPrivateJoinNotification(
      contextGraphId,
      agentAddress,
      payload,
      'join-approval',
    );
    if (result.delivered) {
      this.joinApprovalRetryQueue.markDelivered(contextGraphId, agentAddress);
      const existing = this.joinApprovalRetryQueue.getEntry(contextGraphId, agentAddress);
      return {
        delivered: true,
        peerId: result.peerId,
        // The successful attempt counts on top of any prior failures —
        // `existing` is now undefined (we just removed it), so the caller
        // sees attempts=N where N includes this final successful send.
        attempts: (existing?.attempts ?? 0) + 1,
        error: null,
      };
    }
    const entry = this.joinApprovalRetryQueue.enqueueFailure(
      contextGraphId,
      agentAddress,
      result.error ?? 'unknown',
      Date.now(),
    );
    return {
      delivered: false,
      peerId: result.peerId,
      attempts: entry.attempts,
      error: result.error,
    };
  }

  /**
   * Read the `requestStatus` of a join request. Returns `'pending' |
   * 'approved' | 'rejected'` or `null` if no row exists. Used by
   * `redeliverJoinApproval` to validate the operator-driven re-fire
   * path; not exported as a public method to avoid leaking the raw
   * status string into other code paths (the dedicated `loadPending…`
   * / `redeliver…` helpers are the supported API).
   */
  private async getJoinRequestStatus(
    contextGraphId: string,
    agentAddress: string,
  ): Promise<'pending' | 'approved' | 'rejected' | null> {
    const cgMetaGraph = contextGraphMetaGraphUri(contextGraphId);
    const requestUri = `did:dkg:join-request:${contextGraphId}:${agentAddress.toLowerCase()}`;
    const DKG = 'https://dkg.network/ontology#';
    const result = await this.store.query(
      `SELECT ?status WHERE {
        GRAPH <${cgMetaGraph}> {
          <${requestUri}> <${DKG}requestStatus> ?status .
        }
      } LIMIT 1`,
    );
    if (result.type !== 'bindings' || result.bindings.length === 0) return null;
    const raw = result.bindings[0]['status'];
    if (typeof raw !== 'string') return null;
    const stripped = raw.replace(/^"|"$/g, '').replace(/"?\^\^.*$/, '');
    if (stripped === 'pending' || stripped === 'approved' || stripped === 'rejected') {
      return stripped;
    }
    return null;
  }

  /**
   * Snapshot of pending approval retries. Surfaced via the daemon for
   * operator-facing diagnostics ("how many approvals are stuck on
   * transport, and how long since the first failure?"). Returns a shallow
   * copy so callers can't mutate queue internals.
   */
  listPendingJoinApprovalRetries(): JoinApprovalRetryEntry[] {
    return this.joinApprovalRetryQueue.list();
  }

  /**
   * Periodic tick: walk the retry queue and fire `redeliverJoinApproval`
   * for every entry whose `nextAttemptAt` has passed. Also evicts
   * entries past their max age (24h since first failure by default).
   * Failures re-enqueue with longer backoffs; successes clear the entry.
   * Errors thrown by `redeliverJoinApproval` (e.g. the row went away
   * because the curator manually cleaned it up) are caught and the
   * entry is dropped to prevent the tick from spinning on a permanently
   * unrecoverable target.
   */
  private async processJoinApprovalRetryQueueTick(): Promise<void> {
    const ctx = createOperationContext('system');
    const now = Date.now();
    const expired = this.joinApprovalRetryQueue.dropExpired(now);
    for (const entry of expired) {
      this.log.warn(
        ctx,
        `Giving up on join-approval retry for "${entry.contextGraphId}" → ${entry.agentAddress} ` +
          `after ${entry.attempts} attempt(s) over ${Math.round((now - entry.firstFailureAt) / 1000)}s; ` +
          `lastError=${entry.lastError}. Operator can re-trigger via ` +
          `POST /api/context-graph/{id}/redeliver-approval or have the joiner re-submit.`,
      );
    }
    const due = this.joinApprovalRetryQueue.due(now);
    if (due.length === 0) return;
    this.log.info(
      ctx,
      `Processing ${due.length} due join-approval retry/retries`,
    );
    for (const entry of due) {
      try {
        await this.redeliverJoinApproval(entry.contextGraphId, entry.agentAddress);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        // The most common cause is "approval row no longer exists" —
        // e.g. operator manually rejected after queueing, or the CG was
        // deleted. Drop the entry rather than spinning on it forever.
        this.log.warn(
          ctx,
          `Dropping retry for "${entry.contextGraphId}" → ${entry.agentAddress}: ${errMsg}`,
        );
        this.joinApprovalRetryQueue.markDelivered(entry.contextGraphId, entry.agentAddress);
      }
    }
  }

  /**
   * Opportunistic retry from a `connection:open` event. When the
   * invitee's peer reconnects, the periodic tick may be up to
   * `JOIN_APPROVAL_RETRY_TICK_MS` away — much longer than necessary now
   * that the transport is back. Fire any matching retries immediately.
   *
   * Matching is done by re-resolving each entry's target peer via the
   * agent registry / remembered peer map, which is the same logic
   * `deliverPrivateJoinNotification` uses. Per-tick cost scales with
   * queue size, which is bounded in practice (typically < 20 entries)
   * so the linear scan is acceptable.
   */
  private async processJoinApprovalRetryQueueOnConnect(remotePeerId: string): Promise<void> {
    if (this.joinApprovalRetryQueue.size() === 0) return;
    const ctx = createOperationContext('system');
    const candidates = this.joinApprovalRetryQueue.list();
    for (const entry of candidates) {
      // Cheap pre-filter: skip entries whose remembered origin peer is
      // known and does NOT match the connecting peer. Falls through to
      // a full redeliver attempt (which re-resolves via the registry)
      // for entries with no remembered peer, so a NAT-flipped peer ID
      // still benefits.
      const originKey = `${entry.contextGraphId}::${entry.agentAddress.toLowerCase()}`;
      const remembered = this.joinRequestOriginPeers.get(originKey);
      if (remembered && remembered !== remotePeerId) continue;
      try {
        const result = await this.redeliverJoinApproval(entry.contextGraphId, entry.agentAddress);
        if (result.delivered) {
          this.log.info(
            ctx,
            `Opportunistic redelivery succeeded for "${entry.contextGraphId}" → ${entry.agentAddress} ` +
              `on reconnect from ${remotePeerId} (attempts=${result.attempts})`,
          );
        }
      } catch (err) {
        // Same drop-on-permanent-failure semantics as the periodic tick.
        const errMsg = err instanceof Error ? err.message : String(err);
        this.log.warn(
          ctx,
          `Dropping retry for "${entry.contextGraphId}" → ${entry.agentAddress} on reconnect: ${errMsg}`,
        );
        this.joinApprovalRetryQueue.markDelivered(entry.contextGraphId, entry.agentAddress);
      }
    }
  }

  /**
   * Re-attempt delivery of a single chat outbox entry. Centralised so
   * the periodic tick + the connection:open opportunistic flush share
   * one code path. Returns the entry's current state so the caller can
   * decide what to log.
   *
   * Goes through `messageHandler.sendChat` directly (bypassing
   * `DKGAgent.sendChat`) so a successful retry doesn't recursively
   * re-enqueue or re-mint a fresh `messageId` — the outbox owns the
   * messageId for the lifetime of the entry.
   */
  private async retryOutboxEntry(entry: ChatOutboxRetryEntry): Promise<void> {
    if (!this.messageHandler) return;
    const ctx = createOperationContext('system');
    // Per-key inflight guard against the duplicate-delivery race
    // identified by Lex review on PR #521: the periodic tick and the
    // connection:open opportunistic flush can both call this method
    // for the same entry, the first call's `messageHandler.sendChat`
    // yields, and the second call observes the entry still in the
    // queue (`markDelivered` hasn't fired yet) and starts a concurrent
    // second send. Without this guard the recipient sees the message
    // twice — real user-visible UX corruption. See `MessageOutbox.tryBeginAttempt`
    // for the full rationale.
    if (!this.messageOutbox.tryBeginAttempt(entry.recipientPeerId, entry.messageId)) {
      return;
    }
    try {
      const result = await this.messageHandler.sendChat(entry.recipientPeerId, entry.text, {
        contextGraphId: entry.contextGraphId,
      });
      if (result.delivered) {
        this.messageOutbox.markDelivered(entry.recipientPeerId, entry.messageId);
        this.log.info(
          ctx,
          `Outbox redelivery succeeded for ${entry.recipientPeerId.slice(-8)} ` +
            `(messageId=${entry.messageId.slice(0, 8)}) after ${entry.attempts + 1} attempt(s)`,
        );
        return;
      }
      const updated = this.messageOutbox.enqueueFailure(
        {
          recipientPeerId: entry.recipientPeerId,
          text: entry.text,
          contextGraphId: entry.contextGraphId,
          messageId: entry.messageId,
        },
        result.error ?? 'unknown',
        Date.now(),
      );
      this.log.warn(
        ctx,
        `Outbox redelivery still failing for ${entry.recipientPeerId.slice(-8)} ` +
          `(messageId=${entry.messageId.slice(0, 8)}, attempts=${updated.attempts}, ` +
          `next=${new Date(updated.nextAttemptAt).toISOString()}, error=${updated.lastError})`,
      );
    } finally {
      this.messageOutbox.endAttempt(entry.recipientPeerId, entry.messageId);
    }
  }

  /**
   * Periodic tick: walk the chat outbox and re-attempt every entry
   * whose `nextAttemptAt` has passed. Also evicts entries past their
   * max age (24h since first failure by default). Symmetric to
   * `processJoinApprovalRetryQueueTick` — same shape, different queue.
   */
  private async processMessageOutboxTick(): Promise<void> {
    const ctx = createOperationContext('system');
    const now = Date.now();
    const expired = this.messageOutbox.dropExpired(now);
    for (const entry of expired) {
      this.log.warn(
        ctx,
        `Giving up on chat outbox delivery for ${entry.recipientPeerId.slice(-8)} ` +
          `(messageId=${entry.messageId.slice(0, 8)}) after ${entry.attempts} attempt(s) ` +
          `over ${Math.round((now - entry.firstFailureAt) / 1000)}s; lastError=${entry.lastError}. ` +
          `Operator will need to re-send via dkg_send_message if they still want it delivered.`,
      );
    }
    const due = this.messageOutbox.due(now);
    if (due.length === 0) return;
    this.log.info(ctx, `Processing ${due.length} due chat outbox retry/retries`);
    for (const entry of due) {
      try {
        await this.retryOutboxEntry(entry);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        // Defensive: retryOutboxEntry already routes failures through
        // enqueueFailure, so a thrown error here is a bug-or-bypass
        // case (e.g. messageHandler dropped during shutdown). Log and
        // continue rather than letting the tick crash mid-batch.
        this.log.warn(
          ctx,
          `Outbox retry for ${entry.recipientPeerId.slice(-8)} threw unexpectedly: ${errMsg}`,
        );
      }
    }
  }

  /**
   * Opportunistic retry from a `connection:open` event. When a peer
   * we've been waiting on reconnects, fire any queued messages for
   * that peer NOW — drains in send-order (FIFO by `firstFailureAt`).
   * Symmetric to `processJoinApprovalRetryQueueOnConnect` and shares
   * the same opportunistic-on-reconnect rationale: the periodic tick
   * may be up to `MESSAGE_OUTBOX_TICK_MS` away, but the transport is
   * back NOW, so retry NOW.
   */
  private async processMessageOutboxOnConnect(remotePeerId: string): Promise<void> {
    const pending = this.messageOutbox.pendingFor(remotePeerId);
    if (pending.length === 0) return;
    const ctx = createOperationContext('system');
    this.log.info(
      ctx,
      `Flushing ${pending.length} pending chat outbox entry/entries for ${remotePeerId.slice(-8)} on reconnect`,
    );
    for (const entry of pending) {
      try {
        await this.retryOutboxEntry(entry);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        this.log.warn(
          ctx,
          `Outbox retry for ${remotePeerId.slice(-8)} on reconnect threw unexpectedly: ${errMsg}`,
        );
      }
    }
  }

  /**
   * Reject a pending join request.
   */
  async rejectJoinRequest(contextGraphId: string, agentAddress: string): Promise<void> {
    const cgMetaGraph = contextGraphMetaGraphUri(contextGraphId);
    const requestUri = `did:dkg:join-request:${contextGraphId}:${agentAddress.toLowerCase()}`;
    const DKG = 'https://dkg.network/ontology#';

    await this.store.deleteByPattern({
      graph: cgMetaGraph,
      subject: requestUri,
      predicate: `${DKG}requestStatus`,
    });
    await this.store.insert([{
      subject: requestUri,
      predicate: `${DKG}requestStatus`,
      object: `"rejected"`,
      graph: cgMetaGraph,
    }]);
    this.upsertContextGraphMember({
      contextGraphId,
      principalType: 'agent',
      principalId: agentAddress,
      role: 'requester',
      status: 'removed',
      source: 'join-rejected',
    });

    const ctx = createOperationContext('system');
    this.log.info(ctx, `Rejected join request from ${agentAddress} for "${contextGraphId}"`);

    // Notify the requester via P2P so their UI can flip from the stale
    // "Join request sent, awaiting approval" state to a clear denied
    // state. Non-fatal: if the invitee is unreachable they'll just
    // re-learn on their next subscribe attempt.
    this.notifyJoinRejection(contextGraphId, agentAddress).catch((err) => {
      this.log.warn(ctx, `Failed to notify ${agentAddress} of rejection: ${err instanceof Error ? err.message : err}`);
    });
  }

  /**
   * Send a P2P notification to the rejected agent. Same privacy model
   * as `notifyJoinApproval` — delivered only to the rejectee's peer,
   * never broadcast. See that method's doc comment for rationale.
   */
  private async notifyJoinRejection(contextGraphId: string, agentAddress: string): Promise<void> {
    const payload = JSON.stringify({
      type: 'join-rejected',
      contextGraphId,
      agentAddress,
    });
    // Discard the result object — rejection deliveries don't enter the
    // retry queue. The semantics are intentionally weaker than approval:
    // if the rejection notification is lost the joiner observes silence,
    // which they'll already treat as "still pending" and either re-poll
    // or eventually time out. That's a much milder failure than a lost
    // approval (which leaves a sync-blocked invitee with no recovery path).
    await this.deliverPrivateJoinNotification(contextGraphId, agentAddress, payload, 'join-rejection');
  }

  /**
   * Resolve the target agent's peer ID and send the payload only to that
   * peer. Never broadcasts — leaking a curated CG's membership to every
   * peer on the network is a real privacy violation, and dropping the
   * notification is a far milder failure (the invitee relearns on next
   * subscribe).
   *
   * Two resolution sources, in order:
   *
   *   1. `joinRequestOriginPeers` — the peer that actually delivered the
   *      original join request over P2P. Set by the handler at register
   *      time and persists for the curator's process lifetime. This
   *      avoids a regression from the old broadcast implementation: the
   *      requester may reach us via P2P before their agent profile is
   *      indexed locally, so relying on `findAgents()` alone would drop
   *      every approval/rejection until registry replication catches up.
   *   2. `discovery.findAgents()` fallback for the case where the
   *      curator restarted between receiving the request and acting on
   *      it (and thus lost the in-memory peer mapping).
   *
   * @returns void (logged success/failure; callers treat this as
   *          fire-and-forget)
   */
  private async deliverPrivateJoinNotification(
    contextGraphId: string,
    agentAddress: string,
    payload: string,
    label: 'join-approval' | 'join-rejection',
  ): Promise<{ delivered: boolean; peerId: string | null; error: string | null }> {
    const payloadBytes = new TextEncoder().encode(payload);
    const ctx = createOperationContext('system');
    const addrLower = agentAddress.toLowerCase();

    let targetPeerId: string | null = null;

    // Preferred source: the peer that actually delivered the join
    // request. This is always correct for the common flow and doesn't
    // depend on registry replication timing.
    const originKey = `${contextGraphId}::${addrLower}`;
    const rememberedPeerId = this.joinRequestOriginPeers.get(originKey);
    if (rememberedPeerId) {
      targetPeerId = rememberedPeerId;
    }

    // Always consult the registry when we either had no remembered peer
    // OR we have one but no live connection to it right now. This fixes
    // two related regressions:
    //
    //   * If the requester disconnected between submitting the request
    //     and the curator acting on it, with only the remembered-peer
    //     path we'd have no relay address to redial and the
    //     notification would be silently dropped even though the
    //     registry knows exactly how to reach them.
    //   * If the requester reconnected with a brand-new peer ID (e.g.
    //     ephemeral peer IDs, node restart on a volatile host), the
    //     remembered ID is now stale. Sending to a dead peer ID just
    //     times out; the registry's current peer ID is authoritative.
    //
    // So when the remembered peer isn't connected, we REPLACE it with
    // the registry's current peer ID (not just supplement it with a
    // relay hint), which is what Codex N25 asks for. Registry lookup is
    // cheap (local graph query).
    const rememberedIsConnected = rememberedPeerId
      ? this.node.libp2p
          .getConnections()
          .some((c) => c.remotePeer.toString() === rememberedPeerId)
      : false;
    if (!targetPeerId || !rememberedIsConnected) {
      try {
        const agents = await this.discovery.findAgents();
        const match = agents.find((a) => a.agentAddress?.toLowerCase() === addrLower);
        if (match) {
          // Take the registry's peer ID whenever we don't have a live
          // connection to the remembered one — it may be fresher.
          targetPeerId = match.peerId;
        }
      } catch {
        // Registry unavailable — we'll just skip delivery below if we
        // also have no live connection to the remembered peer.
      }
    }

    if (!targetPeerId) {
      const errMsg = `no origin peer remembered and agent not in local registry`;
      this.log.warn(
        ctx,
        `Cannot deliver ${label} for "${contextGraphId}" to ${agentAddress} — ${errMsg}. ` +
          `Dropping notification (invitee will re-learn on next subscribe).`,
      );
      return { delivered: false, peerId: null, error: errMsg };
    }

    if (targetPeerId === this.peerId) {
      this.log.info(ctx, `Skipping ${label} to ${agentAddress}: target is this node`);
      // Self-loopback "delivery" is treated as success — there is no peer to
      // retry against and the local state is authoritative anyway.
      return { delivered: true, peerId: targetPeerId, error: null };
    }

    try {
      await this.messenger.sendToPeer(targetPeerId, PROTOCOL_JOIN_REQUEST, payloadBytes, { timeoutMs: JOIN_REQUEST_SEND_TIMEOUT_MS });
      this.log.info(ctx, `Delivered ${label} for "${contextGraphId}" to ${agentAddress} (${targetPeerId})`);
      // The join request is finalised now — forget the origin peer so
      // the map doesn't grow unbounded over the curator's lifetime.
      this.joinRequestOriginPeers.delete(originKey);
      return { delivered: true, peerId: targetPeerId, error: null };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.log.warn(
        ctx,
        `Could not deliver ${label} for "${contextGraphId}" to ${agentAddress} (${targetPeerId}): ${errMsg}`,
      );
      return { delivered: false, peerId: targetPeerId, error: errMsg };
    }
  }

  /**
   * Forward a signed join request to the curator via P2P.
   *
   * Two-tier delivery:
   *   1. Targeted send to `curatorPeerId` first (if the V10 invite carried
   *      one — the common case). On success returns immediately, avoiding
   *      a fan-out to dozens of unrelated peers.
   *   2. Fallback broadcast in PARALLEL to every other connected peer via
   *      `Promise.allSettled`. This bounds total wall-clock time to one
   *      per-peer timeout (~5s) regardless of peer count, and lets the
   *      request still find its curator when the targeted dial fails or
   *      no curator peer id is known (legacy invites).
   *
   * The earlier sequential-await loop scaled as O(connected-peers ×
   * per-peer-timeout). On a real testnet node connected to 30+ peers the
   * worst-case wait was ~2.5 minutes per click; observed 2-3 min in the
   * field. Targeted-first collapses the common case to one round-trip,
   * and parallel broadcast caps the fallback at the timeout.
   *
   * Every peer that returns `{ok: true}` (whether via targeted or
   * broadcast path) is recorded in `joinRequestAcceptedBy` so the
   * matching `join-approved` / `join-rejected` notification can be
   * authenticated against them later (see that field's doc comment).
   *
   * Returns the number of peers that accepted the request.
   */
  async forwardJoinRequest(
    contextGraphId: string,
    delegation: SignedAgentDelegation,
    agentName: string | undefined,
    curatorPeerId: string,
  ): Promise<{ delivered: number; errors: string[]; alreadyMember?: boolean }> {
    if (!curatorPeerId) {
      // Required: V10 invites carry the curator's libp2p peer-id
      // (`<cgId>\n<peerId>`). Without it we can't authenticate the
      // returning `join-approved` / `join-rejected` notification —
      // caching arbitrary broadcast acceptors as trusted decision
      // senders is a security hole (any peer that ack'd the broadcast
      // could later forge a decision message). Fail fast at the entry
      // point with a clear error so the UI can surface it to the user.
      throw new Error(
        `forwardJoinRequest requires curatorPeerId. ` +
        `The invite code must include the curator's peer id (V10 format: "<cgId>\\n<peerId>"). ` +
        `Ask the curator to share an updated invite code.`,
      );
    }
    const payload = JSON.stringify({ contextGraphId, delegation, agentName });
    const payloadBytes = new TextEncoder().encode(payload);
    const ctx = createOperationContext('system');
    const errors: string[] = [];
    const agentAddress = delegation.agentAddress;
    const acceptedKey = `${contextGraphId}::${agentAddress.toLowerCase()}`;

    const recordAcceptedBy = (remotePeerId: string): void => {
      let set = this.joinRequestAcceptedBy.get(acceptedKey);
      if (!set) {
        set = new Set<string>();
        this.joinRequestAcceptedBy.set(acceptedKey, set);
      }
      set.add(remotePeerId);
    };

    // Track whether the targeted send to `curatorPeerId` SUCCEEDED.
    // Two reasons matter for the broadcast fallback:
    //  - if it succeeded, curator is excluded from broadcast targets
    //    (no point re-sending), and we record it as the trusted
    //    decision sender.
    //  - if it failed (timeout, transient connection drop, response
    //    other than `ok`), curator is INCLUDED in the broadcast so a
    //    second chance over a fresh stream still finds them. The
    //    earlier behaviour skipped curator unconditionally — a single
    //    transient error then meant the request never reached them.
    let curatorTargetedSuccess = false;
    if (curatorPeerId !== this.peerId) {
      try {
        const responseBytes = await this.messenger.sendToPeer(curatorPeerId, PROTOCOL_JOIN_REQUEST, payloadBytes, { timeoutMs: JOIN_REQUEST_SEND_TIMEOUT_MS });
        const response = JSON.parse(new TextDecoder().decode(responseBytes));
        if (response.ok) {
          // Only the explicit invite-supplied curator is recorded as a
          // trusted decision sender — see `isTrustedJoinDecisionSender`
          // for why we won't trust arbitrary broadcast acceptors.
          recordAcceptedBy(curatorPeerId);
          curatorTargetedSuccess = true;
          const alreadyMember = !!response.alreadyMember;
          this.log.info(
            ctx,
            `Forwarded join request for "${contextGraphId}" from ${agentAddress}: 1 curator(s) received (direct${alreadyMember ? ', already-member' : ''})`,
          );
          return { delivered: 1, errors, ...(alreadyMember ? { alreadyMember: true } : {}) };
        }
        // Curator was reachable but rejected the request. Log + record
        // the reason so the joiner can see WHY (e.g. "unknown CG"
        // implies the cgId in the invite text is wrong).
        const rejectReason = response.error ?? 'unknown';
        this.log.warn(
          ctx,
          `Targeted join-request to curator ${curatorPeerId.slice(-8)} returned non-ok: ${rejectReason}`,
        );
        if (response.error && response.error !== 'unknown CG') {
          errors.push(`${curatorPeerId.slice(-8)}: ${response.error}`);
        } else if (response.error === 'unknown CG') {
          // Surface "unknown CG" too — silent-filter was hiding the
          // most common invite-text-mismatch failure mode.
          errors.push(`${curatorPeerId.slice(-8)}: unknown CG`);
        }
        // The curator gave us an authoritative answer — no point
        // broadcasting the signed delegation to non-curator peers
        // (PROTOCOL_JOIN_REQUEST handler at dkg-agent.ts:1788 returns
        // `not curator` and does not relay; broadcasting just leaks the
        // delegation payload to unrelated peers without any chance of
        // delivery). Return the rejection now.
        return { delivered: 0, errors };
      } catch (dialErr) {
        // Targeted dial failed — fall through to broadcast WITH curator
        // re-included as a target.
        const msg = dialErr instanceof Error ? dialErr.message : String(dialErr);
        this.log.warn(
          ctx,
          `Targeted join-request dial to curator ${curatorPeerId.slice(-8)} failed: ${msg}`,
        );
        errors.push(`${curatorPeerId.slice(-8)}: dial failed (${msg})`);
      }
    }

    // Reaching here means either (a) `curatorPeerId` was unset (legacy
    // multiaddr invite — broadcast is the only delivery option), or (b)
    // the targeted curator dial threw a transport error and broadcast
    // re-includes curatorPeerId in the cohort as a second chance over a
    // fresh stream. Non-curator peers that receive PROTOCOL_JOIN_REQUEST
    // for a CG they don't curate respond `{ ok: false, error: 'not
    // curator' }` and don't relay (see handler at dkg-agent.ts:1788),
    // so a broader "drop V10 broadcast entirely" cleanup is tracked as
    // a follow-up rather than landed here.
    const peers = this.node.libp2p.getPeers();
    const broadcastTargets = peers
      .map((p) => p.toString())
      .filter((id) => id !== this.peerId && (!curatorTargetedSuccess || id !== curatorPeerId));
    const results = await Promise.allSettled(
      broadcastTargets.map(async (remotePeerId) => {
        const responseBytes = await this.messenger.sendToPeer(remotePeerId, PROTOCOL_JOIN_REQUEST, payloadBytes, { timeoutMs: JOIN_REQUEST_SEND_TIMEOUT_MS });
        const response = JSON.parse(new TextDecoder().decode(responseBytes));
        return { remotePeerId, response };
      }),
    );
    let delivered = 0;
    let alreadyMember = false;
    for (const r of results) {
      if (r.status !== 'fulfilled') continue;
      const { remotePeerId, response } = r.value;
      if (response.ok) {
        delivered++;
        // SECURITY: do NOT cache broadcast acceptors as trusted
        // decision senders. Any peer can ack `{ ok: true }` (e.g.
        // because they speak the protocol) — caching them here would
        // let a non-curator peer subsequently forge a join-approved
        // notification and have it accepted (see
        // `isTrustedJoinDecisionSender`). Trust is granted only to
        // the explicit `curatorPeerId` from the invite (above) or
        // to the recorded curator triple in `_meta` (the fallback
        // inside `isTrustedJoinDecisionSender`).
        //
        // The matched curator inside the broadcast cohort can still
        // deliver the decision: the joiner will accept it via the
        // `_meta` curator-triple path once that triple lands locally
        // (curator metadata is gossiped along with the CG itself).
        if (remotePeerId === curatorPeerId) {
          recordAcceptedBy(remotePeerId);
          if (response.alreadyMember) alreadyMember = true;
        }
      } else if (response.error !== 'unknown CG') {
        errors.push(`${remotePeerId.slice(-8)}: ${response.error}`);
      }
    }

    this.log.info(
      ctx,
      `Forwarded join request for "${contextGraphId}" from ${agentAddress}: ${delivered} curator(s) received (broadcast over ${broadcastTargets.length} peer(s)${alreadyMember ? ', already-member' : ''})`,
    );
    return { delivered, errors, ...(alreadyMember ? { alreadyMember: true } : {}) };
  }

  /**
   * Check whether a context graph has been registered on-chain.
   */
  async isContextGraphRegistered(contextGraphId: string): Promise<boolean> {
    const cgMetaGraph = contextGraphMetaGraphUri(contextGraphId);
    const contextGraphUri = `did:dkg:context-graph:${contextGraphId}`;
    const result = await this.store.query(
      `SELECT ?status WHERE { GRAPH <${cgMetaGraph}> { <${contextGraphUri}> <${DKG_ONTOLOGY.DKG_REGISTRATION_STATUS}> ?status } } LIMIT 1`,
    );
    return result.type === 'bindings' && result.bindings[0]?.['status']?.replace(/^"|"$/g, '') === 'registered';
  }

  async getContextGraphOnChainId(contextGraphId: string): Promise<string | null> {
    const subscribed = this.subscribedContextGraphs.get(contextGraphId)?.onChainId;
    if (subscribed) return subscribed;

    const ontologyGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
    const contextGraphUri = `did:dkg:context-graph:${contextGraphId}`;
    const result = await this.store.query(
      `SELECT ?id WHERE { GRAPH <${ontologyGraph}> { <${contextGraphUri}> <${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}OnChainId> ?id } } LIMIT 1`,
    );
    if (result.type !== 'bindings' || result.bindings.length === 0) return null;
    const value = result.bindings[0]?.['id'];
    return typeof value === 'string' ? value.replace(/^"|"$/g, '') : null;
  }

  /**
   * Get the peer allowlist for a context graph (if curated).
   * Returns null if no allowlist is set (open CG).
   */
  async getContextGraphAllowedPeers(contextGraphId: string): Promise<string[] | null> {
    const cgMetaGraph = contextGraphMetaGraphUri(contextGraphId);
    const contextGraphUri = contextGraphDataGraphUri(contextGraphId);
    const result = await this.store.query(
      `SELECT ?peer WHERE { GRAPH <${cgMetaGraph}> { <${contextGraphUri}> <${DKG_ONTOLOGY.DKG_ALLOWED_PEER}> ?peer } }`,
    );
    if (result.type !== 'bindings' || result.bindings.length === 0) {
      return null;
    }
    return result.bindings
      .map(row => row['peer'])
      .filter((v): v is string => typeof v === 'string')
      .map(v => v.replace(/^"|"$/g, ''));
  }

  // ── Sub-Graph Management ───────────────────────────────────────────────

  /**
   * Create a named sub-graph within a context graph.
   * Registers it in the CG's `_meta` graph and creates the named graph in storage.
   * Sub-graphs use convention-based URI partitioning — no on-chain enforcement in V10.0.
   *
   * V10.0 replication behavior:
   * - Registration triples are stored locally by the admin. Peers also auto-register
   *   sub-graphs on gossip publish, SWM write, and finalization replay paths:
   *   `gossip-publish-handler.ts`, `workspace-handler.ts`, and
   *   `finalization-handler.ts` call `ensureSubGraph()` and backfill the full
   *   `_meta` registration when it is missing.
   * - Because `subGraphName` is carried on the wire (in the workspace publish request
   *   and the N-Quads' named-graph field), replicated data is routed into the correct
   *   sub-graph named graph on receiving nodes — not into the root data graph.
   * - On-chain contracts are unaware of sub-graphs; enforcement remains convention-based.
   */
  async createSubGraph(contextGraphId: string, subGraphName: string, opts?: {
    description?: string;
    authorizedWriters?: string[];
  }): Promise<{ uri: string }> {
    const { validateSubGraphName, contextGraphSubGraphUri: sgUri } = await import('@origintrail-official/dkg-core');
    const validation = validateSubGraphName(subGraphName);
    if (!validation.valid) throw new Error(`Invalid sub-graph name "${subGraphName}": ${validation.reason}`);

    const exists = await this.contextGraphExists(contextGraphId);
    if (!exists) throw new Error(`Context graph "${contextGraphId}" does not exist`);

    const gm = new GraphManager(this.store);
    const uri = sgUri(contextGraphId, subGraphName);

    // Idempotency: check if already registered before inserting
    const existing = await this.listSubGraphs(contextGraphId);
    if (existing.some(sg => sg.name === subGraphName)) {
      this.log.info(
        createOperationContext('system'),
        `Sub-graph "${subGraphName}" already exists in context graph "${contextGraphId}" → ${uri}`,
      );
      return { uri };
    }

    const { generateSubGraphRegistration } = await import('@origintrail-official/dkg-publisher');
    const registrationQuads = generateSubGraphRegistration({
      contextGraphId,
      subGraphName,
      createdBy: this.peerId,
      authorizedWriters: opts?.authorizedWriters,
      description: opts?.description,
      timestamp: new Date(),
    });

    await gm.ensureSubGraph(contextGraphId, subGraphName);
    await this.store.insert(registrationQuads);

    this.log.info(
      createOperationContext('system'),
      `Created sub-graph "${subGraphName}" in context graph "${contextGraphId}" → ${uri}`,
    );
    return { uri };
  }

  /**
   * List registered sub-graphs for a context graph.
   * Queries the CG's `_meta` graph for `dkg:SubGraph` registrations.
   */
  async listSubGraphs(contextGraphId: string): Promise<Array<{
    uri: string;
    name: string;
    createdBy: string;
    createdAt?: string;
    description?: string;
  }>> {
    const { subGraphDiscoverySparql } = await import('@origintrail-official/dkg-publisher');
    const sparql = subGraphDiscoverySparql(contextGraphId);
    const result = await this.store.query(sparql);
    if (result.type !== 'bindings') return [];
    return result.bindings.map(row => ({
      uri: row['subGraph'] ?? '',
      name: stripLiteral(row['name'] ?? ''),
      createdBy: row['createdBy'] ?? '',
      createdAt: row['createdAt'] ? stripLiteral(row['createdAt']) : undefined,
      description: row['description'] ? stripLiteral(row['description']) : undefined,
    }));
  }

  /**
   * Remove a sub-graph registration from `_meta` and drop its named graphs.
   * Does NOT delete on-chain data — this is a local bookkeeping operation.
   */
  async removeSubGraph(contextGraphId: string, subGraphName: string): Promise<void> {
    const { validateSubGraphName } = await import('@origintrail-official/dkg-core');
    const validation = validateSubGraphName(subGraphName);
    if (!validation.valid) throw new Error(`Invalid sub-graph name "${subGraphName}": ${validation.reason}`);

    const gm = new GraphManager(this.store);

    const { subGraphDeregistrationSparql } = await import('@origintrail-official/dkg-publisher');
    try {
      await this.store.query(subGraphDeregistrationSparql(contextGraphId, subGraphName));
    } catch {
      // SPARQL DELETE WHERE may not be supported — delete quads manually
      const metaGraph = `did:dkg:context-graph:${contextGraphId}/_meta`;
      const subGraphUri = `did:dkg:context-graph:${contextGraphId}/${subGraphName}`;
      await this.store.deleteByPattern({ graph: metaGraph, subject: subGraphUri });
    }

    const dataUri = gm.subGraphUri(contextGraphId, subGraphName);
    const metaUri = gm.subGraphMetaUri(contextGraphId, subGraphName);
    const privateUri = gm.subGraphPrivateUri(contextGraphId, subGraphName);
    const swmUri = gm.sharedMemoryUri(contextGraphId, subGraphName);
    const swmMetaUri = gm.sharedMemoryMetaUri(contextGraphId, subGraphName);
    for (const uri of [dataUri, metaUri, privateUri, swmUri, swmMetaUri]) {
      try { await this.store.dropGraph(uri); } catch { /* graph may not exist */ }
    }

    // Drop assertion graphs under the sub-graph prefix
    const sgPrefix = `did:dkg:context-graph:${contextGraphId}/${subGraphName}/assertion/`;
    const allGraphs = await this.store.listGraphs();
    for (const g of allGraphs) {
      if (g.startsWith(sgPrefix)) {
        try { await this.store.dropGraph(g); } catch { /* graph may not exist */ }
      }
    }

    // Clear SWM ownership cache for this sub-graph
    const ownershipKey = `${contextGraphId}\0${subGraphName}`;
    this.publisher.clearSubGraphOwnership(ownershipKey);

    this.log.info(
      createOperationContext('system'),
      `Removed sub-graph "${subGraphName}" from context graph "${contextGraphId}"`,
    );
  }

  /**
   * Idempotent "ensure" variant of createContextGraph for boot-time defaults.
   * If the context graph already exists locally, just ensures GossipSub subscription
   * and registry entry. If not, inserts definition triples. No on-chain registration
   * — use {@link registerContextGraph} for that.
   *
   * For curated CGs (detected by access policy in existing triples, or by the
   * caller passing `curated: true`), definition triples are written to the CG's
   * own `_meta` graph — never to ONTOLOGY — so they don't leak to the network.
   */
  async ensureContextGraphLocal(opts: {
    id: string;
    name: string;
    description?: string;
    curated?: boolean;
  }): Promise<void> {
    const ctx = createOperationContext('system');

    const exists = await this.contextGraphExists(opts.id);
    if (exists) {
      // Bootstrap is a subscriber path: do NOT mint or backfill ownership
      // here. Creator/curator are stamped by `createContextGraph` (explicit
      // create) and `registerContextGraph` (explicit on-chain mint). When
      // every node backfilled itself on boot the `_meta` graph accumulated
      // one curator triple per node and `getContextGraphOwner`'s
      // `LIMIT 1` made ownership nondeterministic — any subscriber could
      // win the unordered query and look like the curator.
      this.subscribeToContextGraph(opts.id);
      this.setContextGraphSubscription(opts.id, {
        name: opts.name,
        subscribed: true,
        synced: true,
        metaSynced: true,
        onChainId: this.subscribedContextGraphs.get(opts.id)?.onChainId,
      });
      return;
    }

    const gm = new GraphManager(this.store);
    const contextGraphUri = contextGraphDataGraphUri(opts.id);
    const ontologyGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
    const cgMetaGraph = contextGraphMetaGraphUri(opts.id);
    const now = new Date().toISOString();

    // Curated CGs write definition triples to _meta so they stay invisible
    // to other nodes that sync ONTOLOGY. Open CGs go to ONTOLOGY for
    // network-wide discovery.
    const defGraph = opts.curated ? cgMetaGraph : ontologyGraph;

    // No creator/curator triples here — bootstrap is a subscriber-style
    // path. Ownership is established only when a node explicitly calls
    // `createContextGraph` (UI flow) or `registerContextGraph` (on-chain
    // mint), which both stamp the calling node. Stamping every booting
    // node would let `getContextGraphOwner` ("LIMIT 1" over `dkg:curator`)
    // resolve to an arbitrary subscriber and create a registration race
    // where node B mints a second V10 CG before node A's `onChainId`
    // propagates.
    const quads: Quad[] = [
      { subject: contextGraphUri, predicate: DKG_ONTOLOGY.RDF_TYPE, object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH, graph: defGraph },
      { subject: contextGraphUri, predicate: DKG_ONTOLOGY.SCHEMA_NAME, object: `"${opts.name}"`, graph: defGraph },
      { subject: contextGraphUri, predicate: DKG_ONTOLOGY.DKG_CREATED_AT, object: `"${now}"`, graph: defGraph },
      { subject: contextGraphUri, predicate: DKG_ONTOLOGY.DKG_GOSSIP_TOPIC, object: `"${contextGraphPublishTopic(opts.id)}"`, graph: defGraph },
      { subject: contextGraphUri, predicate: DKG_ONTOLOGY.DKG_REPLICATION_POLICY, object: `"full"`, graph: defGraph },
      { subject: contextGraphUri, predicate: DKG_ONTOLOGY.DKG_ACCESS_POLICY, object: `"${opts.curated ? 'private' : 'public'}"`, graph: defGraph },
    ];

    // _meta triples: only registration status. `dkg:curator` is written
    // by `registerContextGraph` (or `createContextGraph` for the UI
    // create path) so exactly one node owns the graph locally.
    quads.push(
      { subject: contextGraphUri, predicate: DKG_ONTOLOGY.DKG_REGISTRATION_STATUS, object: `"unregistered"`, graph: cgMetaGraph },
    );

    if (opts.description) {
      quads.push({
        subject: contextGraphUri,
        predicate: DKG_ONTOLOGY.SCHEMA_DESCRIPTION,
        object: `"${opts.description}"`,
        graph: defGraph,
      });
    }

    await this.store.insert(quads);
    await gm.ensureContextGraph(opts.id);

    this.subscribeToContextGraph(opts.id);
    this.setContextGraphSubscription(opts.id, {
      name: opts.name,
      subscribed: true,
      synced: true,
      metaSynced: true,
    });

    this.log.info(ctx, `Ensured context graph "${opts.id}" locally (${opts.curated ? 'curated' : 'open'})`);
  }

  // ── ENDORSE ─���────────────────────────────────────────────────────────

  /**
   * Endorse a published Knowledge Asset. Publishes a `dkg:endorses` triple
   * to the Context Graph's data graph. Endorsements ride regular PUBLISH
   * batches — no separate chain transaction required.
   */
  async endorse(opts: {
    contextGraphId: string;
    knowledgeAssetUal: string;
    agentAddress?: string;
  }): Promise<PublishResult> {
    const { buildEndorsementQuads } = await import('./endorse.js');
    // A-12: spec §03 / §22 require the endorser DID to be the
    // Ethereum-address form. Passing a libp2p peer id here produced
    // a `did:dkg:agent:${peerId}` URI (12D3KooW-prefixed in practice),
    // which is non-spec. Prefer the per-call agentAddress, then the
    // node's default agent address, then fall back to the peer id
    // only if no EVM identity is known (kept for backward
    // compatibility with test harnesses; runtime always has a
    // defaultAgentAddress after auto-registration).
    //
    // A-12 review: normalise the address casing through
    // `canonicalAgentDidSubject` so the endorsement DID converges
    // with the profile DID for the same wallet (checksum vs
    // lowercase inputs previously produced two distinct RDF
    // subjects). Callers must also verify the address is owned by
    // this node before calling — /api/endorse does that via the
    // bearer token; see packages/cli/src/daemon.ts.
    const raw = opts.agentAddress ?? this.defaultAgentAddress ?? this.peerId;
    const endorser = canonicalAgentDidSubject(raw);
    const quads = buildEndorsementQuads(
      endorser,
      opts.knowledgeAssetUal,
      opts.contextGraphId,
    );
    return this.publish(opts.contextGraphId, quads);
  }

  // ── VERIFY ────────────────────────────────────────────────────────

  /**
   * Propose verification for a published batch: collect M-of-N approvals,
   * anchor on-chain, and promote triples to Verified Memory.
   */
  async verify(opts: {
    contextGraphId: string;
    verifiedMemoryId: string;
    batchId: bigint;
    requiredSignatures?: number;
    timeoutMs?: number;
  }): Promise<{
    txHash: string;
    blockNumber: number;
    verifiedMemoryId: string;
    signers: string[];
  }> {
    const ctx = createOperationContext('verify');

    // 1. Look up batch merkle root from local metadata (use typed literal for batchId)
    const metaGraph = contextGraphMetaGraphUri(opts.contextGraphId);
    // Try typed literal first, fallback to untyped for backward compat
    let batchBindings: Record<string, string>[] | null = null;
    for (const literal of [`"${opts.batchId}"^^<http://www.w3.org/2001/XMLSchema#integer>`, `"${opts.batchId}"`]) {
      const r = await this.store.query(
        `SELECT ?root WHERE { GRAPH <${metaGraph}> { ?kc <https://dkg.network/ontology#merkleRoot> ?root . ?kc <https://dkg.network/ontology#batchId> ${literal} } } LIMIT 1`,
      );
      if (r.type === 'bindings' && r.bindings.length > 0) {
        batchBindings = r.bindings as Record<string, string>[];
        break;
      }
    }
    if (!batchBindings) {
      throw new Error(`Batch ${opts.batchId} not found in context graph ${opts.contextGraphId}`);
    }
    const rootHex = batchBindings[0]['root'];
    const merkleRoot = ethers.getBytes(rootHex.startsWith('"') ? rootHex.slice(1, -1) : rootHex);

    // 2. Look up context graph on-chain config
    const sub = this.subscribedContextGraphs.get(opts.contextGraphId);
    const contextGraphIdOnChain = sub?.onChainId ? BigInt(sub.onChainId) : null;
    if (!contextGraphIdOnChain) {
      throw new Error(`Context graph ${opts.contextGraphId} not found on-chain`);
    }

    // 3. Get required signatures from chain config or opts
    let requiredSignatures = opts.requiredSignatures ?? 0;
    if (requiredSignatures === 0 && typeof (this.chain as any).getContextGraphConfig === 'function') {
      try {
        const cgConfig = await (this.chain as any).getContextGraphConfig(contextGraphIdOnChain);
        const raw = cgConfig?.requiredSignatures;
        const parsed = raw != null ? Number(raw) : 0;
        if (!Number.isInteger(parsed) || parsed < 1) {
          throw new Error(`getContextGraphConfig returned invalid requiredSignatures: ${raw} (must be a positive integer)`);
        }
        requiredSignatures = parsed;
      } catch (err: any) {
        throw new Error(
          `Cannot determine requiredSignatures for context graph ${contextGraphIdOnChain}: ${err?.message ?? err}. ` +
          `Pass opts.requiredSignatures explicitly or fix the chain adapter connection.`,
        );
      }
    }
    if (requiredSignatures === 0) {
      requiredSignatures = 1;
      this.log.warn(ctx, `requiredSignatures defaults to 1 — adapter does not implement getContextGraphConfig. ` +
        `For M-of-N context graphs, pass --required-signatures via CLI or requiredSignatures in the API body.`);
    }

    // 4. Sign the verify digest as proposer
    const signerKey = this.config.ackSignerKey
      ?? (typeof this.chain.getACKSignerKey === 'function' ? this.chain.getACKSignerKey() : undefined)
      ?? this.config.chainConfig?.operationalKeys?.[0];
    if (!signerKey) throw new Error('No signer key available for verify');

    const digest = computeACKDigest(contextGraphIdOnChain, merkleRoot);
    const prefixedHash = ethers.hashMessage(digest);
    const signingKey = new ethers.SigningKey(signerKey);
    const proposerSig = signingKey.sign(prefixedHash);
    const proposerAddress = ethers.computeAddress(signingKey.publicKey);

    // 5. Collect M-of-N approvals
    const collector = new VerifyCollector({
      sendP2P: async (peerId: string, protocol: string, data: Uint8Array) => this.messenger.sendToPeer(peerId, protocol, data),
      getParticipantPeers: (cgId?: string) => {
        const allPeers = this.node.libp2p.getPeers().map(p => p.toString()).filter(id => id !== this.peerId);
        // TODO: Filter by on-chain participant set once getContextGraphParticipants() is available.
        // Currently relies on signature recovery + identityId resolution to reject non-participants.
        return allPeers;
      },
      log: (msg: string) => this.log.info(ctx, msg),
    });

    const entities = await this.getRootEntities(opts.contextGraphId, opts.batchId);

    const result = await collector.collect({
      contextGraphId: opts.contextGraphId,
      contextGraphIdOnChain,
      verifiedMemoryId: (() => {
        try { return BigInt(opts.verifiedMemoryId); }
        catch { throw new Error(`verifiedMemoryId must be a numeric string, got: "${opts.verifiedMemoryId}"`); }
      })(),
      batchId: opts.batchId,
      merkleRoot,
      entities,
      proposerSignature: { r: ethers.getBytes(proposerSig.r), vs: ethers.getBytes(proposerSig.yParityAndS) },
      requiredSignatures,
      timeoutMs: opts.timeoutMs ?? 30 * 60 * 1000, // 30 min default
    });

    // 6. Submit on-chain
    if (typeof this.chain.verify !== 'function') {
      throw new Error('Chain adapter does not support verify');
    }

    // 6. Resolve identity IDs for each approver before on-chain submission.
    const resolvedSignatures: Array<{ identityId: bigint; r: Uint8Array; vs: Uint8Array }> = [
      {
        identityId: this.identityId,
        r: ethers.getBytes(proposerSig.r),
        vs: ethers.getBytes(proposerSig.yParityAndS),
      },
    ];
    const resolvedSignerAddresses: string[] = [proposerAddress];
    for (const a of result.approvals) {
      let id = a.identityId;
      if ((!id || id === 0n) && typeof (this.chain as any).getIdentityIdForAddress === 'function') {
        try { id = await (this.chain as any).getIdentityIdForAddress(a.approverAddress); } catch { /* use 0n */ }
      }
      if (!id || id === 0n) continue;
      resolvedSignatures.push({ identityId: id, r: a.signatureR, vs: a.signatureVS });
      resolvedSignerAddresses.push(a.approverAddress);
    }
    if (resolvedSignatures.length < requiredSignatures) {
      throw new Error(`verify_identity_resolution: only ${resolvedSignatures.length}/${requiredSignatures} signers have resolvable identities (including proposer)`);
    }

    const txResult = await this.chain.verify({
      contextGraphId: contextGraphIdOnChain,
      batchId: opts.batchId,
      merkleRoot,
      signerSignatures: resolvedSignatures,
    });

    // 7. Promote triples to Verified Memory (only include signers actually sent on-chain)
    await this.promoteToVerifiedMemory(
      opts.contextGraphId,
      opts.verifiedMemoryId,
      opts.batchId,
      txResult.hash,
      txResult.blockNumber,
      resolvedSignerAddresses,
    );

    this.log.info(ctx, `Verified batch ${opts.batchId} → _verified_memory/${opts.verifiedMemoryId} (tx=${txResult.hash.slice(0, 16)}...)`);

    return {
      txHash: txResult.hash,
      blockNumber: txResult.blockNumber,
      verifiedMemoryId: opts.verifiedMemoryId,
      signers: resolvedSignerAddresses,
    };
  }

  private async promoteToVerifiedMemory(
    contextGraphId: string,
    verifiedMemoryId: string,
    batchId: bigint,
    txHash: string,
    blockNumber: number,
    signers: string[],
  ): Promise<void> {
    // Query only the triples belonging to this batch via root entities in _meta
    const rootEntities = await this.getRootEntities(contextGraphId, batchId);
    if (rootEntities.length === 0) {
      this.log.warn(createOperationContext('verify'), `No root entities found for batch ${batchId} — skipping VM promotion`);
      return;
    }
    const dataGraph = contextGraphDataGraphUri(contextGraphId);
    // Query root entities AND their skolemized children (subjects starting
    // with the root entity URI, e.g. <root>/.well-known/genid/...).
    // We use FILTER with STRSTARTS to capture the full closure instead of
    // an exact VALUES match, which would miss child/blank-node subjects.
    const filterClauses = rootEntities
      .map(e => `(STR(?s) = ${JSON.stringify(e)} || STRSTARTS(STR(?s), ${JSON.stringify(e + '/.well-known/genid/')}))`)
      .join(' || ');
    const result = await this.store.query(
      `SELECT ?s ?p ?o WHERE { GRAPH <${dataGraph}> { ?s ?p ?o . FILTER(${filterClauses}) } }`,
    );
    if (result.type !== 'bindings') return;

    const vmGraph = contextGraphVerifiedMemoryUri(contextGraphId, verifiedMemoryId);
    const vmQuads: Quad[] = (result.bindings as Record<string, string>[]).map(row => ({
      subject: row['s'],
      predicate: row['p'],
      object: row['o'],
      graph: vmGraph,
    }));
    if (vmQuads.length > 0) {
      await this.store.insert(vmQuads);
    }

    // Write verification metadata
    const vmMetaGraph = contextGraphVerifiedMemoryMetaUri(contextGraphId, verifiedMemoryId);
    const metaQuads = buildVerificationMetadata({
      contextGraphId,
      verifiedMemoryId,
      batchId,
      txHash,
      blockNumber,
      signers,
      verifiedAt: new Date(),
      graph: vmMetaGraph,
    });
    await this.store.insert(metaQuads);
  }

  private async getRootEntities(contextGraphId: string, batchId: bigint): Promise<string[]> {
    const metaGraph = contextGraphMetaGraphUri(contextGraphId);
    // Try typed literal first, fallback to untyped for backward compat
    for (const literal of [`"${batchId}"^^<http://www.w3.org/2001/XMLSchema#integer>`, `"${batchId}"`]) {
      const result = await this.store.query(
        `SELECT ?entity WHERE { GRAPH <${metaGraph}> { ?ka <https://dkg.network/ontology#rootEntity> ?entity . ?ka <https://dkg.network/ontology#batchId> ${literal} } }`,
      );
      if (result.type === 'bindings' && result.bindings.length > 0) {
        return (result.bindings as Record<string, string>[]).map(r => r['entity']).filter(Boolean);
      }
    }
    return [];
  }

  // ── CCL ──────────────────────────────────────────────────────────────

  async publishCclPolicy(opts: {
    contextGraphId: string;
    name: string;
    version: string;
    content: string;
    description?: string;
    contextType?: string;
    language?: string;
    format?: string;
  }): Promise<{ policyUri: string; hash: string; status: 'proposed' }> {
    const ctx = createOperationContext('system');
    if (!(await this.contextGraphExists(opts.contextGraphId))) {
      throw new Error(`Context Graph "${opts.contextGraphId}" does not exist. Create it first.`);
    }

    validateCclPolicy(opts.content, { expectedName: opts.name, expectedVersion: opts.version });

    const existing = (await this.listCclPolicies({ contextGraphId: opts.contextGraphId, name: opts.name }))
      .find(policy => policy.version === opts.version);
    const existingHash = existing?.hash;
    const nextHash = hashCclPolicy(opts.content);
    if (existingHash && existingHash !== nextHash) {
      throw new Error(`CCL policy ${opts.contextGraphId}/${opts.name}@${opts.version} already exists with different content`);
    }
    if (existing?.policyUri && existingHash === nextHash) {
      return { policyUri: existing.policyUri, hash: existing.hash, status: 'proposed' };
    }

    const ontologyGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
    const now = new Date().toISOString();
    const { policyUri, hash, quads } = buildCclPolicyQuads(opts, `did:dkg:agent:${this.peerId}`, ontologyGraph, now);
    await this.store.insert(quads);
    await this.publishOntologyQuads(policyUri, quads);
    this.log.info(ctx, `Published CCL policy ${opts.name}@${opts.version} for contextGraph "${opts.contextGraphId}"`);
    return { policyUri, hash, status: 'proposed' };
  }

  async approveCclPolicy(opts: {
    contextGraphId: string;
    policyUri: string;
    contextType?: string;
    callerAgentAddress?: string;
  }): Promise<{ policyUri: string; bindingUri: string; contextType?: string; approvedAt: string }> {
    const ctx = createOperationContext('system');
    await this.assertContextGraphPolicyOwner(opts.contextGraphId, opts.callerAgentAddress);
    const record = await this.getCclPolicyByUri(opts.policyUri, { includeBody: true });
    if (!record) throw new Error(`CCL policy not found: ${opts.policyUri}`);
    if (record.contextGraphId !== opts.contextGraphId) {
      throw new Error(`CCL policy ${opts.policyUri} belongs to contextGraph "${record.contextGraphId}", not "${opts.contextGraphId}"`);
    }
    if (record.contextType && opts.contextType && record.contextType !== opts.contextType) {
      throw new Error(`CCL policy contextType mismatch: policy=${record.contextType}, requested=${opts.contextType}`);
    }
    if (!record.body) throw new Error(`CCL policy body missing: ${opts.policyUri}`);
    validateCclPolicy(record.body, { expectedName: record.name, expectedVersion: record.version });

    // Guard against duplicate approvals for the same policy+scope
    const existingBindings = await this.listCclPolicyBindings({ contextGraphId: opts.contextGraphId, name: record.name });
    const activeForScope = existingBindings.find(
      b => b.policyUri === opts.policyUri && b.status === 'approved' &&
           (b.contextType ?? '') === (opts.contextType ?? record.contextType ?? ''),
    );
    if (activeForScope) {
      return { policyUri: opts.policyUri, bindingUri: activeForScope.bindingUri, contextType: activeForScope.contextType, approvedAt: activeForScope.approvedAt };
    }

    const ontologyGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
    const approvedAt = new Date().toISOString();
    const effectiveContextType = opts.contextType ?? record.contextType;
    // Emit the public `dkg:creator` peer DID as the binding owner: it's the
    // handle remote peers resolve via ONTOLOGY gossip, so gossip-publish-handler
    // will accept the approval. `_meta`-only `dkg:curator` (wallet DID) is
    // used for local authorization via `assertContextGraphOwner` above.
    const ownerDid = await this.getContextGraphCreator(opts.contextGraphId)
      ?? `did:dkg:agent:${this.peerId}`;
    const { bindingUri, quads } = buildPolicyApprovalQuads({
      contextGraphId: opts.contextGraphId,
      policyUri: opts.policyUri,
      policyName: record.name,
      creator: ownerDid,
      graph: ontologyGraph,
      approvedAt,
      contextType: effectiveContextType,
    });

    quads.push(
      { subject: opts.policyUri, predicate: DKG_ONTOLOGY.DKG_POLICY_STATUS, object: sparqlString('approved'), graph: ontologyGraph },
      { subject: opts.policyUri, predicate: DKG_ONTOLOGY.DKG_APPROVED_BY, object: ownerDid, graph: ontologyGraph },
      { subject: opts.policyUri, predicate: DKG_ONTOLOGY.DKG_APPROVED_AT, object: sparqlString(approvedAt), graph: ontologyGraph },
    );

    await this.store.insert(quads);
    await this.publishOntologyQuads(bindingUri, quads);
    this.log.info(ctx, `Approved CCL policy ${record.name}@${record.version} for contextGraph "${opts.contextGraphId}"${effectiveContextType ? ` (context ${effectiveContextType})` : ''}`);
    return { policyUri: opts.policyUri, bindingUri, contextType: effectiveContextType, approvedAt };
  }

  async revokeCclPolicy(opts: {
    contextGraphId: string;
    policyUri: string;
    contextType?: string;
    callerAgentAddress?: string;
  }): Promise<{ policyUri: string; bindingUri: string; contextType?: string; revokedAt: string; status: 'revoked' }> {
    const ctx = createOperationContext('system');
    await this.assertContextGraphPolicyOwner(opts.contextGraphId, opts.callerAgentAddress);

    const target = await this.getActiveCclPolicyBinding({
      contextGraphId: opts.contextGraphId,
      policyUri: opts.policyUri,
      contextType: opts.contextType,
    });
    if (!target) {
      throw new Error(`No active CCL policy binding found for ${opts.policyUri} in contextGraph "${opts.contextGraphId}"${opts.contextType ? ` and context "${opts.contextType}"` : ''}.`);
    }

    const ontologyGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
    const revokedAt = new Date().toISOString();
    // See note in approveCclPolicy — use `dkg:creator` (peer DID) for the
    // public binding metadata so it round-trips through ONTOLOGY gossip.
    const ownerDid = await this.getContextGraphCreator(opts.contextGraphId)
      ?? `did:dkg:agent:${this.peerId}`;
    const quads = buildPolicyRevocationQuads({
      bindingUri: target.bindingUri,
      revoker: ownerDid,
      graph: ontologyGraph,
      revokedAt,
      contextGraphUri: `did:dkg:context-graph:${opts.contextGraphId}`,
    });

    await this.store.insert(quads);
    await this.publishOntologyQuads(target.bindingUri, quads);
    this.log.info(ctx, `Revoked CCL policy binding ${target.bindingUri} for contextGraph "${opts.contextGraphId}"${target.contextType ? ` (context ${target.contextType})` : ''}`);
    return { policyUri: opts.policyUri, bindingUri: target.bindingUri, contextType: target.contextType, revokedAt, status: 'revoked' };
  }

  async listCclPolicies(opts: {
    contextGraphId?: string;
    name?: string;
    contextType?: string;
    status?: string;
    includeBody?: boolean;
  } = {}): Promise<CclPolicyRecord[]> {
    const ontologyGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
    const filters: string[] = [];
    if (opts.contextGraphId) filters.push(`?contextGraph = <did:dkg:context-graph:${opts.contextGraphId}>`);
    if (opts.name) filters.push(`?name = ${sparqlString(opts.name)}`);
    if (opts.contextType) filters.push(`?contextType = ${sparqlString(opts.contextType)}`);
    const filterBlock = filters.length > 0 ? `FILTER(${filters.join(' && ')})` : '';
    const bodyClause = opts.includeBody ? `OPTIONAL { ?policy <${DKG_ONTOLOGY.DKG_POLICY_BODY}> ?body }` : '';

    const result = await this.store.query(`
      SELECT ?policy ?contextGraph ?name ?version ?hash ?language ?format ?status ?creator ?created ?approvedBy ?approvedAt ?desc ?contextType ${opts.includeBody ? '?body' : ''} WHERE {
        GRAPH <${ontologyGraph}> {
          ?policy <${DKG_ONTOLOGY.RDF_TYPE}> <${DKG_ONTOLOGY.DKG_CCL_POLICY}> ;
                  <${DKG_ONTOLOGY.DKG_POLICY_APPLIES_TO_CONTEXT_GRAPH}> ?contextGraph ;
                  <${DKG_ONTOLOGY.SCHEMA_NAME}> ?name ;
                  <${DKG_ONTOLOGY.DKG_POLICY_VERSION}> ?version ;
                  <${DKG_ONTOLOGY.DKG_POLICY_HASH}> ?hash ;
                  <${DKG_ONTOLOGY.DKG_POLICY_LANGUAGE}> ?language ;
                  <${DKG_ONTOLOGY.DKG_POLICY_FORMAT}> ?format ;
                  <${DKG_ONTOLOGY.DKG_POLICY_STATUS}> ?status .
          OPTIONAL { ?policy <${DKG_ONTOLOGY.DKG_CREATOR}> ?creator }
          OPTIONAL { ?policy <${DKG_ONTOLOGY.DKG_CREATED_AT}> ?created }
          OPTIONAL { ?policy <${DKG_ONTOLOGY.DKG_APPROVED_BY}> ?approvedBy }
          OPTIONAL { ?policy <${DKG_ONTOLOGY.DKG_APPROVED_AT}> ?approvedAt }
          OPTIONAL { ?policy <${DKG_ONTOLOGY.SCHEMA_DESCRIPTION}> ?desc }
          OPTIONAL { ?policy <${DKG_ONTOLOGY.DKG_POLICY_CONTEXT_TYPE}> ?contextType }
          ${bodyClause}
          ${filterBlock}
        }
      }
      ORDER BY ?name ?version
    `);

    const bindings = await this.listCclPolicyBindings({ contextGraphId: opts.contextGraphId, name: opts.name });
    const latestByScope = this.selectLatestNonRevokedBindings(bindings);

    const records = new Map<string, CclPolicyRecord>();
    if (result.type === 'bindings') {
      for (const row of result.bindings as Record<string, string>[]) {
        const contextGraphUri = row['contextGraph'];
        const contextGraphId = contextGraphUri.startsWith('did:dkg:context-graph:') ? contextGraphUri.slice('did:dkg:context-graph:'.length) : contextGraphUri;
        const name = stripLiteral(row['name']);
        const defaultActive = latestByScope.get(`${contextGraphId}|${name}|`);
        const activeContexts = Array.from(latestByScope.values())
          .filter(binding => binding.contextGraphId === contextGraphId && binding.name === name && binding.contextType && binding.policyUri === row['policy'])
          .map(binding => binding.contextType as string)
          .sort();
        const nextRecord: CclPolicyRecord = {
          policyUri: row['policy'],
          contextGraphId,
          name,
          version: stripLiteral(row['version']),
          hash: stripLiteral(row['hash']),
          language: stripLiteral(row['language']),
          format: stripLiteral(row['format']),
          status: this.deriveCclPolicyStatus(row['policy'], stripLiteral(row['status']), bindings, latestByScope),
          creator: row['creator'],
          createdAt: row['created'] ? stripLiteral(row['created']) : undefined,
          approvedBy: row['approvedBy'],
          approvedAt: row['approvedAt'] ? stripLiteral(row['approvedAt']) : undefined,
          description: row['desc'] ? stripLiteral(row['desc']) : undefined,
          contextType: row['contextType'] ? stripLiteral(row['contextType']) : undefined,
          body: row['body'] ? stripLiteral(row['body']) : undefined,
          isActiveDefault: defaultActive?.policyUri === row['policy'],
          activeContexts,
        };

        const current = records.get(row['policy']);
        if (!current || (current.status !== 'approved' && nextRecord.status === 'approved')) {
          records.set(row['policy'], nextRecord);
        }
      }
    }

    return Array.from(records.values())
      .filter(record => !opts.status || record.status === opts.status)
      .sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`));
  }

  async resolveCclPolicy(opts: {
    contextGraphId: string;
    name: string;
    contextType?: string;
    includeBody?: boolean;
  }): Promise<CclPolicyRecord | null> {
    const bindings = await this.listCclPolicyBindings({ contextGraphId: opts.contextGraphId, name: opts.name });
    const latestByScope = this.selectLatestNonRevokedBindings(bindings);
    const selected = this.resolveCclPolicyBinding(latestByScope, opts.contextGraphId, opts.name, opts.contextType);
    if (!selected) return null;
    const record = await this.getCclPolicyByUri(selected.policyUri, { includeBody: opts.includeBody });
    if (!record) return null;
    record.isActiveDefault = !selected.contextType;
    record.activeContexts = selected.contextType ? [selected.contextType] : record.activeContexts;
    return record;
  }

  async resolveFactsFromSnapshot(opts: {
    contextGraphId: string;
    snapshotId?: string;
    view?: string;
    scopeUal?: string;
    policyName?: string;
    contextType?: string;
  }): Promise<{
    facts: CclFactTuple[];
    factSetHash: string;
    factQueryHash: string;
    factResolverVersion: string;
    factResolutionMode: 'snapshot-resolved';
    context: {
      contextGraphId: string;
      contextType?: string;
      view?: string;
      snapshotId?: string;
      scopeUal?: string;
    };
  }> {
    return resolveFactsFromSnapshot(this.store, opts);
  }

  async evaluateCclPolicy(opts: {
    contextGraphId: string;
    name: string;
    facts?: CclFactTuple[];
    contextType?: string;
    view?: string;
    snapshotId?: string;
    scopeUal?: string;
  }): Promise<{
    policy: Pick<CclPolicyRecord, 'policyUri' | 'contextGraphId' | 'name' | 'version' | 'hash' | 'language' | 'format' | 'contextType'>;
    context: {
      contextGraphId: string;
      contextType?: string;
      view?: string;
      snapshotId?: string;
      scopeUal?: string;
    };
    factSetHash: string;
    factQueryHash: string;
    factResolverVersion: string;
    factResolutionMode: CclFactResolutionMode;
    result: CclEvaluationResult;
  }> {
    const policy = await this.resolveCclPolicy({
      contextGraphId: opts.contextGraphId,
      name: opts.name,
      contextType: opts.contextType,
      includeBody: true,
    });
    if (!policy?.body) {
      throw new Error(`No approved policy found for ${opts.contextGraphId}/${opts.name}${opts.contextType ? `/${opts.contextType}` : ''}`);
    }

    const parsed = parseCclPolicy(policy.body);
    const factInput = opts.facts
      ? buildManualCclFacts(opts.facts)
      : await this.resolveFactsFromSnapshot({
          contextGraphId: opts.contextGraphId,
          snapshotId: opts.snapshotId,
          view: opts.view,
          scopeUal: opts.scopeUal,
          policyName: policy.name,
          contextType: opts.contextType ?? policy.contextType,
        });
    const evaluator = new CclEvaluator(parsed, factInput.facts);
    const result = evaluator.run();

    return {
      policy: {
        policyUri: policy.policyUri,
        contextGraphId: policy.contextGraphId,
        name: policy.name,
        version: policy.version,
        hash: policy.hash,
        language: policy.language,
        format: policy.format,
        contextType: opts.contextType ?? policy.contextType,
      },
      context: {
        contextGraphId: opts.contextGraphId,
        contextType: opts.contextType,
        view: opts.view,
        snapshotId: opts.snapshotId,
        scopeUal: opts.scopeUal,
      },
      factSetHash: factInput.factSetHash,
      factQueryHash: factInput.factQueryHash,
      factResolverVersion: factInput.factResolverVersion,
      factResolutionMode: factInput.factResolutionMode,
      result,
    };
  }

  async evaluateAndPublishCclPolicy(opts: {
    contextGraphId: string;
    name: string;
    facts?: CclFactTuple[];
    contextType?: string;
    view?: string;
    snapshotId?: string;
    scopeUal?: string;
  }): Promise<{
    evaluationUri: string;
    publish: PublishResult;
    evaluation: {
      policy: Pick<CclPolicyRecord, 'policyUri' | 'contextGraphId' | 'name' | 'version' | 'hash' | 'language' | 'format' | 'contextType'>;
      context: {
        contextGraphId: string;
        contextType?: string;
        view?: string;
        snapshotId?: string;
        scopeUal?: string;
      };
      factSetHash: string;
      factQueryHash: string;
      factResolverVersion: string;
      factResolutionMode: CclFactResolutionMode;
      result: CclEvaluationResult;
    };
  }> {
    const evaluation = await this.evaluateCclPolicy(opts);
    const graph = contextGraphDataGraphUri(opts.contextGraphId);
    const { evaluationUri, quads } = buildCclEvaluationQuads({
      contextGraphId: opts.contextGraphId,
      policyUri: evaluation.policy.policyUri,
      factSetHash: evaluation.factSetHash,
      factQueryHash: evaluation.factQueryHash,
      factResolverVersion: evaluation.factResolverVersion,
      factResolutionMode: evaluation.factResolutionMode,
      result: evaluation.result,
      evaluatedAt: new Date().toISOString(),
      view: evaluation.context.view,
      snapshotId: evaluation.context.snapshotId,
      scopeUal: evaluation.context.scopeUal,
      contextType: evaluation.context.contextType,
    }, graph);
    const publish = await this.publish(opts.contextGraphId, quads);
    return { evaluationUri, publish, evaluation };
  }

  async listCclEvaluations(opts: {
    contextGraphId: string;
    policyUri?: string;
    snapshotId?: string;
    view?: string;
    contextType?: string;
    resultKind?: 'derived' | 'decision';
    resultName?: string;
  }): Promise<CclPublishedEvaluationRecord[]> {
    const graph = contextGraphDataGraphUri(opts.contextGraphId);
    const filters: string[] = [];
    if (opts.policyUri) filters.push(`?policy = <${opts.policyUri}>`);
    if (opts.snapshotId) filters.push(`?snapshotId = ${sparqlString(opts.snapshotId)}`);
    if (opts.view) filters.push(`?view = ${sparqlString(opts.view)}`);
    if (opts.contextType) filters.push(`?contextType = ${sparqlString(opts.contextType)}`);
    if (opts.resultKind) filters.push(`?kind = ${sparqlString(opts.resultKind)}`);
    if (opts.resultName) filters.push(`?resultName = ${sparqlString(opts.resultName)}`);
    const filterBlock = filters.length > 0 ? `FILTER(${filters.join(' && ')})` : '';

    const result = await this.store.query(`
      SELECT ?evaluation ?policy ?factSetHash ?factQueryHash ?factResolverVersion ?factResolutionMode ?createdAt ?view ?snapshotId ?scopeUal ?contextType ?entry ?kind ?resultName ?arg ?argIndex ?argValue WHERE {
        GRAPH <${graph}> {
          ?evaluation <${DKG_ONTOLOGY.RDF_TYPE}> <${DKG_ONTOLOGY.DKG_CCL_EVALUATION}> ;
                      <${DKG_ONTOLOGY.DKG_EVALUATED_POLICY}> ?policy ;
                      <${DKG_ONTOLOGY.DKG_FACT_SET_HASH}> ?factSetHash .
          OPTIONAL { ?evaluation <${DKG_ONTOLOGY.DKG_FACT_QUERY_HASH}> ?factQueryHash }
          OPTIONAL { ?evaluation <${DKG_ONTOLOGY.DKG_FACT_RESOLVER_VERSION}> ?factResolverVersion }
          OPTIONAL { ?evaluation <${DKG_ONTOLOGY.DKG_FACT_RESOLUTION_MODE}> ?factResolutionMode }
          OPTIONAL { ?evaluation <${DKG_ONTOLOGY.DKG_CREATED_AT}> ?createdAt }
          OPTIONAL { ?evaluation <${DKG_ONTOLOGY.DKG_VIEW}> ?view }
          OPTIONAL { ?evaluation <${DKG_ONTOLOGY.DKG_SNAPSHOT_ID}> ?snapshotId }
          OPTIONAL { ?evaluation <${DKG_ONTOLOGY.DKG_SCOPE_UAL}> ?scopeUal }
          OPTIONAL { ?evaluation <${DKG_ONTOLOGY.DKG_POLICY_CONTEXT_TYPE}> ?contextType }
          OPTIONAL {
            ?evaluation <${DKG_ONTOLOGY.DKG_HAS_RESULT}> ?entry .
            ?entry <${DKG_ONTOLOGY.DKG_RESULT_KIND}> ?kind ;
                   <${DKG_ONTOLOGY.DKG_RESULT_NAME}> ?resultName .
            OPTIONAL {
              ?entry <${DKG_ONTOLOGY.DKG_HAS_RESULT_ARG}> ?arg .
              ?arg <${DKG_ONTOLOGY.DKG_RESULT_ARG_INDEX}> ?argIndex ;
                   <${DKG_ONTOLOGY.DKG_RESULT_ARG_VALUE}> ?argValue .
            }
          }
          ${filterBlock}
        }
      }
      ORDER BY DESC(?createdAt) ?evaluation ?kind ?resultName ?argIndex
    `);

    if (result.type !== 'bindings') return [];
    const records = new Map<string, CclPublishedEvaluationRecord>();
    const entryArgs = new Map<string, Map<number, unknown>>();
    for (const row of result.bindings as Record<string, string>[]) {
      const evaluationUri = row['evaluation'];
      let record = records.get(evaluationUri);
      if (!record) {
        record = {
          evaluationUri,
          policyUri: row['policy'],
          factSetHash: stripLiteral(row['factSetHash']),
          factQueryHash: row['factQueryHash'] ? stripLiteral(row['factQueryHash']) : undefined,
          factResolverVersion: row['factResolverVersion'] ? stripLiteral(row['factResolverVersion']) : undefined,
          factResolutionMode: row['factResolutionMode'] ? stripLiteral(row['factResolutionMode']) as CclFactResolutionMode : undefined,
          createdAt: row['createdAt'] ? stripLiteral(row['createdAt']) : undefined,
          view: row['view'] ? stripLiteral(row['view']) : undefined,
          snapshotId: row['snapshotId'] ? stripLiteral(row['snapshotId']) : undefined,
          scopeUal: row['scopeUal'] ? stripLiteral(row['scopeUal']) : undefined,
          contextType: row['contextType'] ? stripLiteral(row['contextType']) : undefined,
          results: [],
        };
        records.set(evaluationUri, record);
      }

      if (row['entry']) {
        const entryUri = row['entry'];
        let existing = record.results.find(resultEntry => resultEntry.entryUri === entryUri);
        if (!existing) {
          existing = {
            entryUri,
            kind: stripLiteral(row['kind']) as 'derived' | 'decision',
            name: stripLiteral(row['resultName']),
            tuple: [],
          };
          record.results.push(existing);
        }

        if (row['arg'] && row['argIndex'] && row['argValue']) {
          let args = entryArgs.get(entryUri);
          if (!args) {
            args = new Map<number, unknown>();
            entryArgs.set(entryUri, args);
          }
          args.set(Number(stripLiteral(row['argIndex'])), JSON.parse(stripLiteral(row['argValue'])));
        }
      }
    }

    for (const record of records.values()) {
      for (const resultEntry of record.results) {
        const args = entryArgs.get(resultEntry.entryUri);
        if (args && args.size > 0) {
          resultEntry.tuple = [...args.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([, value]) => value);
        }
      }
    }

    return Array.from(records.values());
  }

  /**
   * Check whether a context graph exists in local storage. Definition triples in
   * ONTOLOGY/_meta count, and storage-backed graph presence also counts so local
   * shared-memory-only survivors are not treated as nonexistent.
   */
  async contextGraphExists(contextGraphId: string): Promise<boolean> {
    const contextGraphUri = `did:dkg:context-graph:${contextGraphId}`;
    const result = await this.store.query(
      `SELECT ?g WHERE {
        GRAPH ?g { <${contextGraphUri}> <${DKG_ONTOLOGY.RDF_TYPE}> <${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}> }
      } LIMIT 1`,
    );
    if (result.type === 'bindings' && result.bindings.length > 0) {
      return true;
    }

    const graphManager = new GraphManager(this.store);
    const storedContextGraphs = await graphManager.listContextGraphs();
    return storedContextGraphs.includes(contextGraphId);
  }

  /**
   * Check whether the context graph has any actual content locally. A
   * contextGraph declaration triple in the ontology graph (from auto-discovery
   * via chain registry or ontology sync) does NOT count as content; it
   * only indicates the contextGraph was announced, not that we have access to
   * its data. This predicate is used to distinguish "genuinely synced /
   * has access" from "declaration only / probably denied".
   *
   * Looks for at least one triple in ANY graph under the context-graph
   * prefix (`did:dkg:context-graph:<cg>`, `…/<sg>`, `…/assertion/…`,
   * `…/_shared_memory`, …) except the `_meta` bookkeeping graphs. Tier-4l
   * Codex feedback: the previous check only inspected the root data
   * graph, so a project whose content was synced into sub-graphs
   * (`/tasks`, `/chat`, assertion graphs, SWM) looked like "no local
   * content" and the denial-cleanup path would unsubscribe it. Sub-graph
   * content is the normal state for any non-trivial project so the root
   * data graph is routinely empty.
   */
  async contextGraphHasLocalContent(contextGraphId: string): Promise<boolean> {
    const prefix = `did:dkg:context-graph:${contextGraphId}`;
    // ASK is cheap on Oxigraph; the FILTER keeps us inside this CG's
    // namespace and excludes `_meta` / `_shared_memory_meta` bookkeeping
    // which is written even for declaration-only discoveries.
    const sparql = `ASK WHERE {
      GRAPH ?g { ?s ?p ?o }
      FILTER(STRSTARTS(STR(?g), "${prefix}"))
      FILTER(!STRENDS(STR(?g), "/_meta"))
      FILTER(!STRENDS(STR(?g), "/_shared_memory_meta"))
    }`;
    const result = await this.store.query(sparql);
    if (result.type === 'boolean') return result.value;
    return result.type === 'bindings' && result.bindings.length > 0;
  }

  /**
   * Check whether a context graph is declared as curated (private/allowlist)
   * locally. Reads the DKG accessPolicy predicate from either the ontology
   * graph (public CGs) or the CG's _meta graph (curated CGs). Returns false
   * when no declaration is present locally (caller should treat that as
   * "unknown, assume public" — this predicate is only used to gate
   * optimistic denial inference, not access control decisions).
   */
  async contextGraphIsCurated(contextGraphId: string): Promise<boolean> {
    const contextGraphUri = `did:dkg:context-graph:${contextGraphId}`;
    const cgMetaGraph = contextGraphMetaGraphUri(contextGraphId);
    const ontologyGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
    try {
      const res = await this.store.query(
        `SELECT ?ap WHERE {
          { GRAPH <${ontologyGraph}> { <${contextGraphUri}> <${DKG_ONTOLOGY.DKG_ACCESS_POLICY}> ?ap } }
          UNION
          { GRAPH <${cgMetaGraph}> { <${contextGraphUri}> <${DKG_ONTOLOGY.DKG_ACCESS_POLICY}> ?ap } }
        } LIMIT 1`,
      );
      if (res.type !== 'bindings' || res.bindings.length === 0) return false;
      const ap = res.bindings[0]?.['ap']?.replace(/^"|"$/g, '');
      return ap === 'private';
    } catch {
      return false;
    }
  }

  private parseSyncRequest(data: Uint8Array): SyncRequestEnvelope {
    const text = new TextDecoder().decode(data).trim();
    if (text.startsWith('{')) {
      let parsed: SyncRequestEnvelope;
      try {
        parsed = JSON.parse(text) as SyncRequestEnvelope;
      } catch {
        // Malformed JSON — fall through to pipe-delimited parsing
        return this.parsePipeDelimitedSyncRequest(text);
      }
      return {
        contextGraphId: parsed.contextGraphId,
        offset: parsed.offset ?? 0,
        limit: Math.min(parsed.limit ?? SYNC_PAGE_SIZE, SYNC_PAGE_SIZE),
        includeSharedMemory: parsed.includeSharedMemory ?? false,
        phase: normalizeSyncPhase(parsed.phase),
        snapshotRef: typeof parsed.snapshotRef === 'string' ? parsed.snapshotRef : undefined,
        targetPeerId: parsed.targetPeerId,
        requesterPeerId: parsed.requesterPeerId,
        requestId: parsed.requestId,
        issuedAtMs: parsed.issuedAtMs,
        requesterIdentityId: parsed.requesterIdentityId,
        requesterAgentAddress: parsed.requesterAgentAddress,
        requesterSignatureR: parsed.requesterSignatureR,
        requesterSignatureVS: parsed.requesterSignatureVS,
      };
    }

    return this.parsePipeDelimitedSyncRequest(text);
  }

  private parsePipeDelimitedSyncRequest(text: string): SyncRequestEnvelope {
    const parts = text.split('|');
    const ctxGraphPart = parts[0] || '';
    const includeSharedMemory = ctxGraphPart.startsWith('workspace:');
    const contextGraphId = includeSharedMemory ? ctxGraphPart.slice('workspace:'.length) : (ctxGraphPart || SYSTEM_CONTEXT_GRAPHS.AGENTS);
    const phase = normalizeSyncPhase(parts[3]);
    return {
      contextGraphId,
      offset: parseInt(parts[1], 10) || 0,
      limit: Math.min(parseInt(parts[2], 10) || SYNC_PAGE_SIZE, SYNC_PAGE_SIZE),
      includeSharedMemory,
      phase,
      snapshotRef: phase === 'snapshot' ? parts[4] : undefined,
    };
  }

  /**
   * Pick which local agent should sign sync requests for this CG.
   *
   * On a multi-agent node, hard-coding `defaultAgentAddress` for every
   * sync envelope is wrong: if agent B is allowlisted on the CG but
   * agent A happens to be the process default, the responder's
   * per-agent delegation lookup will only see A's claim and miss B's
   * stored delegation, silently failing sync auth for the actually
   * approved agent.
   *
   * Resolution order:
   *  1. If the process default is in the curator's allowlist (mirrored
   *     into our local `_meta` after first sync), keep using it. This
   *     preserves historical behavior for single-agent nodes.
   *  2. Otherwise pick the first local agent the curator allowlisted.
   *  3. If neither (no `_meta` yet, e.g. the very first catch-up after
   *     `join-approved` arrives), fall back to the locally-known
   *     join-request / join-approved hint in `localApprovedAgentByCG`.
   *     This is the codex round-4 fix — without it, the first
   *     post-approval sync on multi-agent nodes would bind to
   *     `defaultAgentAddress` and the responder would deny.
   *  4. If even the hint is unset (we're the curator handling our own
   *     CG, or restarted after approval), fall back to
   *     `defaultAgentAddress`.
   *
   * PR #448 review (rounds 4 and 5) — Codex flagged the multi-agent
   * silent-sync-failure bug, then the still-broken first-catch-up
   * case after the round-4 fix landed.
   */
  private async findLocalAgentForContextGraph(contextGraphId: string): Promise<string | undefined> {
    if (this.localAgents.size === 0) return this.defaultAgentAddress;

    // Hint first: if we have a definitive locally-known choice (just
    // signed, or just received a join-approved for this CG), prefer it
    // — but only if it still maps to a local agent we can sign with.
    const hintAddr = this.localApprovedAgentByCG.get(contextGraphId);
    const hintLocal = hintAddr
      ? [...this.localAgents.keys()].find((a) => a.toLowerCase() === hintAddr)
      : undefined;

    let allowedAgents: string[] = [];
    try {
      allowedAgents = await this.getContextGraphAllowedAgents(contextGraphId);
    } catch {
      return hintLocal ?? this.defaultAgentAddress;
    }
    if (allowedAgents.length === 0) {
      // No `_meta` yet — the hint is the most authoritative answer we
      // have for the post-approval bootstrap window.
      return hintLocal ?? this.defaultAgentAddress;
    }
    const allowedLower = new Set(allowedAgents.map((a) => a.toLowerCase()));
    // Hint wins if it's also on the allowlist — covers the "approved
    // agent ≠ process default, _meta has caught up" case.
    if (hintLocal && allowedLower.has(hintLocal.toLowerCase())) return hintLocal;
    const defaultLower = this.defaultAgentAddress?.toLowerCase();
    if (defaultLower && allowedLower.has(defaultLower)) return this.defaultAgentAddress;
    for (const localAddr of this.localAgents.keys()) {
      if (allowedLower.has(localAddr.toLowerCase())) return localAddr;
    }
    return hintLocal ?? this.defaultAgentAddress;
  }

  private async buildSyncRequest(
    contextGraphId: string,
    offset: number,
    limit: number,
    includeSharedMemory: boolean,
    responderPeerId: string,
    phase: SyncPhase = 'data',
    snapshotRef?: string,
  ): Promise<Uint8Array> {
    const isPrivate = await this.isPrivateContextGraph(contextGraphId);

    // If we don't have any local data for this CG yet (e.g. just subscribed
    // via invite), we can't determine the access policy. Send an
    // authenticated request so the remote peer can verify our identity
    // against its allowlist.
    const hasLocalData = this.subscribedContextGraphs.get(contextGraphId)?.synced === true;
    const needsAuth = isPrivate || !hasLocalData;
    const claimedAgentAddress = await this.findLocalAgentForContextGraph(contextGraphId);
    const claimedAgent = claimedAgentAddress ? this.localAgents.get(claimedAgentAddress) : undefined;
    return buildSyncRequestEnvelope({
      contextGraphId,
      offset,
      limit,
      includeSharedMemory,
      targetPeerId: responderPeerId,
      requesterPeerId: this.peerId,
      phase,
      snapshotRef,
      needsAuth,
      computeSyncDigest: this.computeSyncDigest.bind(this),
      getIdentityId: () => this.chain.getIdentityId(),
      signMessage: typeof this.chain.signMessage === 'function' ? this.chain.signMessage.bind(this.chain) : undefined,
      claimedAgentAddress: claimedAgentAddress,
      claimedAgentPrivateKey: claimedAgent?.privateKey,
    });
  }

  private computeSyncDigest(
    contextGraphId: string,
    offset: number,
    limit: number,
    includeSharedMemory: boolean,
    targetPeerId: string,
    requesterPeerId: string | undefined,
    requestId: string | undefined,
    issuedAtMs: number | undefined,
    requesterAgentAddress: string | undefined,
  ): Uint8Array {
    // `requesterAgentAddress` participates in the digest so the
    // "on behalf of" claim is signed, not free-form envelope data.
    // Without it, the responder's delegation lookup can be steered by
    // tampering with `requesterAgentAddress` after the signature was
    // produced — which would be a way to bypass the per-agent
    // delegation binding in `request-authorize`.
    return ethers.getBytes(
      ethers.solidityPackedKeccak256(
        ['string', 'uint256', 'uint256', 'bool', 'string', 'string', 'string', 'uint256', 'string'],
        [
          contextGraphId,
          BigInt(offset),
          BigInt(limit),
          includeSharedMemory,
          targetPeerId,
          requesterPeerId ?? '',
          requestId ?? '',
          BigInt(issuedAtMs ?? 0),
          (requesterAgentAddress ?? '').toLowerCase(),
        ],
      ),
    );
  }

  private async authorizeSyncRequest(request: SyncRequestEnvelope, remotePeerId: string): Promise<boolean> {
    const isPrivate = await this.isPrivateContextGraph(request.contextGraphId);
    if (!isPrivate) {
      return true;
    }
    const verifyIdentity = this.chain.verifySyncIdentity ?? this.chain.verifyACKIdentity;
    return authorizePrivateSyncRequest({
      ctx: createOperationContext('sync'),
      request,
      remotePeerId,
      localPeerId: this.peerId,
      syncAuthMaxAgeMs: SYNC_AUTH_MAX_AGE_MS,
      seenRequestIds: this.seenPrivateSyncRequestIds,
      computeSyncDigest: this.computeSyncDigest.bind(this),
      verifyIdentity: typeof verifyIdentity === 'function' ? verifyIdentity.bind(this.chain) : undefined,
      getParticipants: (contextGraphId) => this.getPrivateContextGraphParticipants(contextGraphId),
      getAllowedPeers: (contextGraphId) => this.getContextGraphAllowedPeers(contextGraphId),
      getAgentGateAddresses: (contextGraphId) => this.getContextGraphAgentGateAddresses(contextGraphId),
      getAllowedDelegateePeers: (contextGraphId) => this.getContextGraphAllowedDelegateePeers(contextGraphId),
      getAllowedDelegateeKeys: (contextGraphId) => this.getContextGraphAllowedDelegateeKeys(contextGraphId),
      refreshMetaFromCurator: (contextGraphId) => this.refreshMetaFromCurator(contextGraphId),
      logWarn: (ctx, message) => this.log.warn(ctx, message),
      logInfo: (ctx, message) => this.log.info(ctx, message),
    });
  }

  private async isPrivateContextGraph(contextGraphId: string): Promise<boolean> {
    if ((Object.values(SYSTEM_CONTEXT_GRAPHS) as string[]).includes(contextGraphId)) {
      return false;
    }

    const ontologyGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
    const cgMetaGraph = contextGraphMetaGraphUri(contextGraphId);
    const contextGraphUri = `did:dkg:context-graph:${contextGraphId}`;
    const result = await this.store.query(
      `SELECT ?policy WHERE {
        {
          GRAPH <${ontologyGraph}> {
            <${contextGraphUri}> <${DKG_ONTOLOGY.DKG_ACCESS_POLICY}> ?policy
          }
        } UNION {
          GRAPH <${cgMetaGraph}> {
            <${contextGraphUri}> <${DKG_ONTOLOGY.DKG_ACCESS_POLICY}> ?policy
          }
        }
      } LIMIT 1`,
    );

    if (result.type === 'bindings' && result.bindings[0]?.['policy'] === '"private"') {
      return true;
    }

    // Also treat CGs with any allowlist predicate as private, even when no
    // explicit `accessPolicy` triple exists (e.g. `inviteToContextGraph`
    // writes `DKG_ALLOWED_PEER` straight into `_meta` without touching the
    // ontology's access_policy; `inviteAgentToContextGraph` does the same
    // with `DKG_ALLOWED_AGENT`). Both the V10 agent model AND the legacy
    // peer-ID model need to be recognized here, otherwise the store-
    // discovery path would misclassify a freshly-invited CG as "open /
    // discoverable only" and skip the same-connect catchup.
    const allowlistResult = await this.store.query(
      `ASK WHERE {
        GRAPH <${cgMetaGraph}> {
          { <${contextGraphUri}> <${DKG_ONTOLOGY.DKG_ALLOWED_AGENT}> ?agent }
          UNION
          { <${contextGraphUri}> <${DKG_ONTOLOGY.DKG_PARTICIPANT_AGENT}> ?participantAgent }
          UNION
          { <${contextGraphUri}> <${DKG_ONTOLOGY.DKG_ALLOWED_PEER}> ?peer }
        }
      }`,
    );
    if (allowlistResult.type === 'boolean' && allowlistResult.value === true) {
      return true;
    }

    return false;
  }

  private async getPrivateContextGraphParticipants(contextGraphId: string): Promise<string[] | null> {
    const merged: string[] = [];
    const seen = new Set<string>();
    const add = (value: string | undefined) => {
      if (!value) return;
      const key = value.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      merged.push(value);
    };

    const localAgentParticipants = this.subscribedContextGraphs.get(contextGraphId)?.participantAgents;
    if (localAgentParticipants) {
      for (const p of localAgentParticipants) add(p);
    }

    const contextGraphUri = `did:dkg:context-graph:${contextGraphId}`;
    const cgMetaGraph = contextGraphMetaGraphUri(contextGraphId);

    // V10 agent model: local allowedAgent entries plus explicit on-chain
    // participantAgent entries both grant local curated access.
    const agentResult = await this.store.query(
      `SELECT ?agent WHERE {
        GRAPH <${cgMetaGraph}> {
          { <${contextGraphUri}> <${DKG_ONTOLOGY.DKG_ALLOWED_AGENT}> ?agent }
          UNION
          { <${contextGraphUri}> <${DKG_ONTOLOGY.DKG_PARTICIPANT_AGENT}> ?agent }
        }
      }`,
    );
    if (agentResult.type === 'bindings') {
      for (const row of agentResult.bindings) {
        const raw = row['agent'];
        if (typeof raw === 'string') add(raw.replace(/^"|"$/g, ''));
      }
    }

    // Legacy identity model: participantIdentityIds (numeric IDs as strings)
    const metaResult = await this.store.query(
      `SELECT ?identityId WHERE {
        GRAPH <${cgMetaGraph}> {
          <${contextGraphUri}> <${DKG_ONTOLOGY.DKG_PARTICIPANT_IDENTITY_ID}> ?identityId
        }
      }`,
    );
    if (metaResult.type === 'bindings') {
      for (const row of metaResult.bindings) {
        const raw = row['identityId'];
        if (typeof raw === 'string') add(raw.replace(/^"|"$/g, ''));
      }
    }

    if (merged.length > 0) return merged;

    // Fall back to on-chain participants (identity IDs as strings)
    const onChainId = this.subscribedContextGraphs.get(contextGraphId)?.onChainId;
    if (!onChainId || typeof this.chain.getContextGraphParticipants !== 'function') {
      return null;
    }
    const onChainParticipants = await this.chain.getContextGraphParticipants(BigInt(onChainId));
    if (!onChainParticipants) return null;
    return onChainParticipants.map((id) => String(id));
  }

  /**
   * Re-sync the meta graph for a private CG from the curator to pick up
   * newly added participants. Rate-limited to avoid abuse.
   * Returns true if meta was refreshed, false if skipped or failed.
   */
  private async resolveCuratorPeerId(contextGraphId: string): Promise<string | undefined> {
    const cgMetaGraph = contextGraphMetaGraphUri(contextGraphId);
    const contextGraphUri = contextGraphDataGraphUri(contextGraphId);

    const curatorResult = await this.store.query(
      `SELECT ?curator WHERE {
        GRAPH <${cgMetaGraph}> {
          <${contextGraphUri}> <${DKG_ONTOLOGY.DKG_CURATOR}> ?curator
        }
      } LIMIT 1`,
    );
    if (curatorResult.type !== 'bindings' || curatorResult.bindings.length === 0) {
      return undefined;
    }
    const curatorDid = (curatorResult.bindings[0] as Record<string, string>)['curator'] ?? '';
    const didPrefix = 'did:dkg:agent:';
    if (!curatorDid.startsWith(didPrefix)) {
      return undefined;
    }
    const curatorIdentifier = curatorDid.slice(didPrefix.length);

    // Resolve curator identifier to a peer ID. The DID value is either a
    // libp2p peer ID (legacy) or an Ethereum wallet address (V10). For
    // wallet addresses, prefer the deterministic DKG_CREATOR triple (which
    // stores the libp2p peer ID) over the agent registry (which may return
    // an arbitrary match when multiple agents register the same wallet).
    let curatorPeerId = curatorIdentifier;
    if (curatorIdentifier.startsWith('0x')) {
      let resolved = false;

      // Preferred: look up the creator peer ID from the ontology definition
      // graph or the _meta graph. The dkg:creator triple uses the libp2p
      // peer ID while dkg:curator uses the wallet address.
      const ontologyGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
      const creatorResult = await this.store.query(
        `SELECT ?creator WHERE {
          {
            GRAPH <${ontologyGraph}> {
              <${contextGraphUri}> <${DKG_ONTOLOGY.DKG_CREATOR}> ?creator
            }
          } UNION {
            GRAPH <${cgMetaGraph}> {
              <${contextGraphUri}> <${DKG_ONTOLOGY.DKG_CREATOR}> ?creator
            }
          }
        } LIMIT 1`,
      );
      if (creatorResult.type === 'bindings' && creatorResult.bindings.length > 0) {
        const creatorDid = (creatorResult.bindings[0] as Record<string, string>)['creator'] ?? '';
        if (creatorDid.startsWith(didPrefix)) {
          const creatorId = creatorDid.slice(didPrefix.length);
          if (!creatorId.startsWith('0x')) {
            curatorPeerId = creatorId;
            resolved = true;
          }
        }
      }

      // Fallback: agent registry lookup (non-deterministic if multiple agents
      // share the same wallet address, but better than failing outright)
      if (!resolved) {
        try {
          const agents = await this.discovery.findAgents();
          const match = agents.find(
            (a) => a.agentAddress?.toLowerCase() === curatorIdentifier.toLowerCase(),
          );
          if (match) {
            curatorPeerId = match.peerId;
            resolved = true;
          }
        } catch { /* registry unavailable */ }
      }

      if (!resolved) return undefined;
    }

    return curatorPeerId;
  }

  private async refreshMetaFromCurator(contextGraphId: string): Promise<boolean> {
    const now = Date.now();
    const lastRefresh = this.metaRefreshTimestamps.get(contextGraphId) ?? 0;
    if (now - lastRefresh < META_REFRESH_COOLDOWN_MS) {
      return false;
    }

    const ctx = createOperationContext('sync');
    const cgMetaGraph = contextGraphMetaGraphUri(contextGraphId);
    const curatorPeerId = await this.resolveCuratorPeerId(contextGraphId);
    if (!curatorPeerId) {
      return false;
    }

    if (curatorPeerId === this.peerId) {
      return false;
    }

    let connections = this.node.libp2p.getConnections();
    let isConnected = connections.some((c) => c.remotePeer.toString() === curatorPeerId);

    // If not directly connected, try dialing — first a regular dial (the peer
    // store may already have direct multiaddrs), then via relay as fallback.
    if (!isConnected) {
      try {
        const { peerIdFromString } = await import('@libp2p/peer-id');
        const pid = peerIdFromString(curatorPeerId);

        try {
          await this.node.libp2p.dial(pid);
          connections = this.node.libp2p.getConnections();
          isConnected = connections.some((c) => c.remotePeer.toString() === curatorPeerId);
        } catch { /* direct dial failed, try relay */ }

        if (!isConnected) {
          const agent = await this.discovery.findAgentByPeerId(curatorPeerId);
          if (agent?.relayAddress) {
            const { multiaddr } = await import('@multiformats/multiaddr');
            const circuitAddr = multiaddr(`${agent.relayAddress}/p2p-circuit/p2p/${curatorPeerId}`);
            await this.node.libp2p.peerStore.merge(pid, { multiaddrs: [circuitAddr] });
            await this.node.libp2p.dial(pid);
            connections = this.node.libp2p.getConnections();
            isConnected = connections.some((c) => c.remotePeer.toString() === curatorPeerId);
          }
        }
      } catch (err) {
        this.log.warn(ctx, `Failed to dial curator ${curatorPeerId.slice(-8)} for meta refresh: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (!isConnected) {
      return false;
    }

    try {
      const deadline = Date.now() + 10_000;
      const metaResult = await this.fetchSyncPages(ctx, curatorPeerId, contextGraphId, false, 'meta', cgMetaGraph, deadline);
      if (metaResult.quads.length > 0) {
        await this.store.insert(metaResult.quads);
        this.syncCheckpoints.delete(metaResult.checkpointKey);
        this.log.info(ctx, `Meta refresh for "${contextGraphId}": ${metaResult.quads.length} triples from curator ${curatorPeerId.slice(-8)}`);
        return true;
      }
      this.syncCheckpoints.delete(metaResult.checkpointKey);
      return false;
    } catch (err) {
      this.log.warn(ctx, `Meta refresh for "${contextGraphId}" failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    } finally {
      this.metaRefreshTimestamps.set(contextGraphId, now);
    }
  }

  /**
   * List all known context graphs by merging the subscription registry with
   * SPARQL-discovered definition triples. Returns enriched entries with
   * `subscribed` and `synced` flags.
   *
   * Rows are backfilled from `_meta` with `DKG_CURATOR` when missing — open CGs only publish
   * curator triples locally in `_meta` while definitions sync on ONTOLOGY.
   *
   * With a valid `callerAgentAddress` option, each row includes `callerInvolved`.
   * With no usable caller wallet, omit that field entirely so callers can infer membership from `curator`.
   */
  async listContextGraphs(opts?: { callerAgentAddress?: string | null }): Promise<Array<{
    id: string;
    uri: string;
    name: string;
    description?: string;
    creator?: string;
    /** Wallet-scoped curator DID (from _meta / ontology), if present. */
    curator?: string;
    /** Declared access policy literal, e.g. public / private. */
    accessPolicy?: string;
    createdAt?: string;
    isSystem: boolean;
    subscribed: boolean;
    synced: boolean;
    onChainId?: string;
    /**
     * When `callerAgentAddress` is omitted or invalid: property is omitted —
     * clients fall back to comparing `curator` to identity (listing was not scoped to a caller).
     * When a valid caller is provided: explicit true/false.
     */
    callerInvolved?: boolean;
  }>> {
    const ontologyGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
    const agentsGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.AGENTS);
    const result = await this.store.query(`
      SELECT ?ctxGraph ?name ?desc ?creator ?created ?curator ?access ?isSystem WHERE {
        {
          GRAPH <${ontologyGraph}> {
            ?ctxGraph <${DKG_ONTOLOGY.RDF_TYPE}> <${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}> .
            OPTIONAL { ?ctxGraph <${DKG_ONTOLOGY.SCHEMA_NAME}> ?name }
            OPTIONAL { ?ctxGraph <${DKG_ONTOLOGY.SCHEMA_DESCRIPTION}> ?desc }
            OPTIONAL { ?ctxGraph <${DKG_ONTOLOGY.DKG_CREATOR}> ?creator }
            OPTIONAL { ?ctxGraph <${DKG_ONTOLOGY.DKG_CURATOR}> ?curator }
            OPTIONAL { ?ctxGraph <${DKG_ONTOLOGY.DKG_ACCESS_POLICY}> ?access }
            OPTIONAL { ?ctxGraph <${DKG_ONTOLOGY.DKG_CREATED_AT}> ?created }
            OPTIONAL { ?ctxGraph <${DKG_ONTOLOGY.RDF_TYPE}> <${DKG_ONTOLOGY.DKG_SYSTEM_CONTEXT_GRAPH}> . BIND(true AS ?isSystem) }
          }
        } UNION {
          GRAPH <${agentsGraph}> {
            ?ctxGraph <${DKG_ONTOLOGY.RDF_TYPE}> <${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}> .
            OPTIONAL { ?ctxGraph <${DKG_ONTOLOGY.SCHEMA_NAME}> ?name }
            OPTIONAL { ?ctxGraph <${DKG_ONTOLOGY.SCHEMA_DESCRIPTION}> ?desc }
            OPTIONAL { ?ctxGraph <${DKG_ONTOLOGY.DKG_CREATOR}> ?creator }
            OPTIONAL { ?ctxGraph <${DKG_ONTOLOGY.DKG_CURATOR}> ?curator }
            OPTIONAL { ?ctxGraph <${DKG_ONTOLOGY.DKG_ACCESS_POLICY}> ?access }
            OPTIONAL { ?ctxGraph <${DKG_ONTOLOGY.DKG_CREATED_AT}> ?created }
            OPTIONAL { ?ctxGraph <${DKG_ONTOLOGY.RDF_TYPE}> <${DKG_ONTOLOGY.DKG_SYSTEM_CONTEXT_GRAPH}> . BIND(true AS ?isSystem) }
          }
        }
      }
    `);

    const prefix = 'did:dkg:context-graph:';
    const seen = new Map<string, {
      id: string; uri: string; name: string; description?: string;
      creator?: string; curator?: string; accessPolicy?: string; createdAt?: string; isSystem: boolean;
      subscribed: boolean; synced: boolean; onChainId?: string;
    }>();

    if (result.type === 'bindings') {
      const byUri = new Map<string, Record<string, string>>();
      for (const row of result.bindings as Record<string, string>[]) {
        const uri = row['ctxGraph'] ?? '';
        if (!uri || byUri.has(uri)) continue;
        byUri.set(uri, row);
      }
      // Parallel lookups — sequential await per ontology row multiplied list latency noticeably.
      await Promise.all([...byUri.values()].map(async (row) => {
        const uri = row['ctxGraph'] ?? '';
        if (seen.has(uri)) return;
        const id = uri.startsWith(prefix) ? uri.slice(prefix.length) : uri;
        const sub = this.subscribedContextGraphs.get(id);
        const onChainId = sub?.onChainId ?? (await this.getContextGraphOnChainId(id)) ?? undefined;
        seen.set(uri, {
          id,
          uri,
          name: stripLiteral(row['name'] ?? id),
          description: row['desc'] ? stripLiteral(row['desc']) : undefined,
          creator: row['creator'],
          ...(row['curator'] ? { curator: row['curator'] } : {}),
          ...(row['access'] ? { accessPolicy: stripLiteral(row['access']) } : {}),
          createdAt: row['created'] ? stripLiteral(row['created']) : undefined,
          isSystem: !!row['isSystem'],
          subscribed: sub?.subscribed ?? false,
          // `synced` now means "we've actually pulled CG data from a peer
          // and stored it locally" — not "we've seen the definition
          // triple gossip across ONTOLOGY/AGENTS." The earlier behaviour
          // hard-coded `true` here, which made every gossip-discovered
          // CG look fully synced and let stale public CGs (curators
          // long gone) persist in the Oracle browse catalogue
          // indefinitely. Now `synced` mirrors the daemon's authoritative
          // subscription state set by the catchup runner (see
          // `markContextGraphSubscriptionState` at routes/context-graph.ts:1301).
          synced: sub?.synced ?? false,
          ...(onChainId ? { onChainId } : {}),
        });
      }));
    }

    // Curated CGs store their definition in their own _meta graph, not in
    // ONTOLOGY. Check _meta for any subscribed CGs not yet found above.
    for (const [id, sub] of this.subscribedContextGraphs) {
      const uri = `${prefix}${id}`;
      if (seen.has(uri)) continue;
      if (id === SYSTEM_CONTEXT_GRAPHS.AGENTS || id === SYSTEM_CONTEXT_GRAPHS.ONTOLOGY) continue;

      const metaGraph = contextGraphMetaGraphUri(id);
      const pUri = contextGraphDataGraphUri(id);
      const metaResult = await this.store.query(`
        SELECT ?name ?desc ?creator ?created ?curator ?access WHERE {
          GRAPH <${metaGraph}> {
            <${pUri}> <${DKG_ONTOLOGY.RDF_TYPE}> <${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}> .
            OPTIONAL { <${pUri}> <${DKG_ONTOLOGY.SCHEMA_NAME}> ?name }
            OPTIONAL { <${pUri}> <${DKG_ONTOLOGY.SCHEMA_DESCRIPTION}> ?desc }
            OPTIONAL { <${pUri}> <${DKG_ONTOLOGY.DKG_CREATOR}> ?creator }
            OPTIONAL { <${pUri}> <${DKG_ONTOLOGY.DKG_CURATOR}> ?curator }
            OPTIONAL { <${pUri}> <${DKG_ONTOLOGY.DKG_ACCESS_POLICY}> ?access }
            OPTIONAL { <${pUri}> <${DKG_ONTOLOGY.DKG_CREATED_AT}> ?created }
          }
        } LIMIT 1
      `);

      if (metaResult.type === 'bindings' && metaResult.bindings.length > 0) {
        const row = metaResult.bindings[0] as Record<string, string>;
        const onChainId = sub.onChainId ?? (await this.getContextGraphOnChainId(id)) ?? undefined;
        seen.set(uri, {
          id,
          uri,
          name: stripLiteral(row['name'] ?? sub.name ?? id),
          description: row['desc'] ? stripLiteral(row['desc']) : undefined,
          creator: row['creator'],
          ...(row['curator'] ? { curator: row['curator'] } : {}),
          ...(row['access'] ? { accessPolicy: stripLiteral(row['access']) } : {}),
          createdAt: row['created'] ? stripLiteral(row['created']) : undefined,
          isSystem: false,
          subscribed: sub.subscribed,
          synced: sub.synced,
          ...(onChainId ? { onChainId } : {}),
        });
        continue;
      }

      // No declaration in ontology, agents, or _meta graphs. Three cases:
      //
      //  1. Chain-attested but not-yet-synced (sub.onChainId set):
      //     auto-discovery from the on-chain registry found this CG and
      //     subscribed us. Surface it as subscribed+synced=false so the
      //     UI can show a legitimate "waiting for sync" state. Any
      //     genuinely inaccessible curated CG will be removed from
      //     `subscribedContextGraphs` by the daemon's authoritative
      //     denial path (accessDeniedPeers > 0) before we get here.
      //
      //  2. Curator-approved but not-yet-meta-synced (sub.pendingMeta
      //     set): the join-approved handler subscribed us seconds ago
      //     and the first meta sync hasn't completed yet. Same UX
      //     treatment as case 1 — surface as "waiting for sync" so the
      //     project entry shows up in the sidebar immediately on
      //     approval, instead of disappearing for ~107s until the
      //     periodic catchup reconciler eventually pulls _meta. Cleared
      //     in `refreshMetaSyncedFlags` once meta arrives, at which
      //     point this entry instead surfaces via the `_meta` branch
      //     above.
      //
      //  3. Not chain-attested, not pending-meta, AND no local content:
      //     a truly phantom entry (pre-discovery subscribe that never
      //     resolved). Hide it to avoid polluting the UI. If the user
      //     legitimately subscribes later, the next catch-up writes
      //     _meta or data and the entry will appear on the next
      //     refresh.
      if (!sub.onChainId && !sub.pendingMeta) {
        // Delegate to `contextGraphHasLocalContent()` so the check
        // covers sub-graphs, assertion graphs and SWM — not just the
        // root data graph. For any non-trivial project the root data
        // graph is routinely empty (content lives in `/tasks`,
        // `/chat`, `/assertion/...`, `_shared_memory`), and checking
        // only the root caused legitimate synced projects to be
        // hidden as phantoms here (Codex tier-4m follow-up to N29,
        // same issue in a separate call site).
        const hasContent = await this.contextGraphHasLocalContent(id);
        if (!hasContent) continue;
      }

      seen.set(uri, {
        id,
        uri,
        name: sub.name ?? id,
        isSystem: false,
        subscribed: sub.subscribed,
        synced: sub.synced,
        ...(sub.onChainId ? { onChainId: sub.onChainId } : {}),
      });
    }

    const graphManager = new GraphManager(this.store);
    const storedContextGraphs = await graphManager.listContextGraphs();
    for (const id of storedContextGraphs) {
      const uri = `${prefix}${id}`;
      if (seen.has(uri)) continue;
      if (id === SYSTEM_CONTEXT_GRAPHS.AGENTS || id === SYSTEM_CONTEXT_GRAPHS.ONTOLOGY) continue;

      const sub = this.subscribedContextGraphs.get(id);
      const onChainId = sub?.onChainId ?? (await this.getContextGraphOnChainId(id)) ?? undefined;
      seen.set(uri, {
        id,
        uri,
        name: sub?.name ?? id,
        isSystem: false,
        subscribed: sub?.subscribed ?? false,
        synced: sub?.synced ?? false,
        ...(onChainId ? { onChainId } : {}),
      });
    }

    let rows = Array.from(seen.values());

    /**
     * Open CGs replicate `DKG_CREATOR`/name/policy on ONTOLOGY but keep `DKG_CURATOR` in `_meta` only,
     * so list rows lack `curator` and the sidebar cannot classify "mine" without a Bearer-scoped pass.
     * Backfill once (parallelised) — also removes duplicate SPARQL in the involvement pass below.
     */
    rows = await Promise.all(rows.map(async (r) => {
      if (r.curator?.trim()) return r;
      const c = await this.getContextGraphCurator(r.id);
      return c ? { ...r, curator: c } : r;
    }));

    let checksum: string | null = null;
    const rawCaller = opts?.callerAgentAddress?.trim();
    if (rawCaller && ethers.isAddress(rawCaller)) {
      try {
        checksum = ethers.getAddress(rawCaller);
      } catch {
        checksum = null;
      }
    }

    // Privacy filter: curated/private CGs must never leak past the daemon to a non-member
    // caller. With no caller wallet (Bearer absent), drop all private rows; with a caller,
    // keep private rows only when they are curator or allowlisted participant.
    const isPrivateRow = (ap?: string): boolean => {
      if (!ap?.trim()) return false;
      const t = ap.trim().replace(/^["']|["']$/g, '').toLowerCase();
      return t === 'private';
    };

    if (!checksum) {
      // Without a caller wallet we still leave `callerInvolved` unset so the UI can use the
      // curator-vs-identity fallback for OPEN graphs.
      return rows.filter((r) => !isPrivateRow(r.accessPolicy));
    }

    const annotated = await Promise.all(rows.map(async (r) => {
      const curatorMatch = this.curatorDidMatchesChecksumAgent(r.curator, checksum);
      const allowlisted = await this.callerIsAllowlistedAgentParticipant(r.id, checksum);
      // `callerInvolved` must reflect ONLY the provided caller wallet.
      // Using local node identity (`creatorIsSelf`) leaks curated rows to unrelated callers.
      const involved = curatorMatch || allowlisted;
      return { ...r, callerInvolved: involved };
    }));

    return annotated.filter((r) => !isPrivateRow(r.accessPolicy) || r.callerInvolved === true);
  }

  async networkId(): Promise<string> {
    return computeNetworkId();
  }

  get peerId(): string {
    return this.node.peerId;
  }

  get nodeName(): string {
    return this.config.name;
  }

  get nodeFramework(): string | undefined {
    return this.config.framework;
  }

  private async getCclPolicyByUri(policyUri: string, opts: { includeBody?: boolean } = {}): Promise<CclPolicyRecord | null> {
    const records = await this.listCclPolicies({ includeBody: opts.includeBody });
    return records.find(record => record.policyUri === policyUri) ?? null;
  }

  /**
   * Verify that the caller is the owner of a context graph. When an explicit
   * callerAgentAddress is provided (agent-level token), only that identity is
   * checked — no fallback to node-level identities. This prevents non-owner
   * agents on the same node from piggybacking on the node's default agent.
   *
   * Legacy fallback (peerId / defaultAgentAddress) only applies when no
   * explicit caller is known (node-level token / backward compat).
   */
  private assertCallerIsOwner(owner: string, callerAgentAddress: string | undefined, action: string): void {
    const callerDid = callerAgentAddress ? `did:dkg:agent:${callerAgentAddress}` : null;
    const selfDid = `did:dkg:agent:${this.peerId}`;

    let authorized: boolean;
    if (callerDid) {
      // Explicit caller: check only their DID.
      // Also allow through if the caller is the default agent and the owner
      // is stored under the legacy peerId-based DID (pre-agent-model CGs).
      authorized = owner === callerDid ||
        (callerAgentAddress === this.defaultAgentAddress && owner === selfDid);
    } else {
      // No explicit caller (node-level token): allow peerId and default agent only
      const defaultDid = this.defaultAgentAddress ? `did:dkg:agent:${this.defaultAgentAddress}` : null;
      authorized = owner === selfDid || (defaultDid != null && owner === defaultDid);
    }

    if (!authorized) {
      throw new Error(
        `Only the context graph creator can ${action}. ` +
        `Creator=${owner}, caller=${callerDid ?? selfDid}`,
      );
    }
  }

  private async assertContextGraphPolicyOwner(contextGraphId: string, callerAgentAddress?: string): Promise<void> {
    const owner = await this.getContextGraphOwner(contextGraphId);
    if (!owner) {
      throw new Error(`ContextGraph "${contextGraphId}" has no registered owner; cannot manage policies.`);
    }
    if (!this.isCallerOrNodeOwner(owner, callerAgentAddress)) {
      throw new Error(`Only the contextGraph owner can manage policies for "${contextGraphId}". Owner=${owner}, caller=${`did:dkg:agent:${callerAgentAddress ?? this.defaultAgentAddress ?? this.peerId}`}`);
    }
  }

  /**
   * Public owner-check used by HTTP routes that need to gate curator-only
   * actions (manifest publish, SWM template rewrites, etc.). Throws a
   * caller-friendly "Only the …" error when the caller isn't the CG's
   * registered owner/curator; returns silently when they are.
   *
   * The `action` string is interpolated into the error message so the
   * 403 response can tell the user exactly what they tried to do
   * ("publish a project manifest", "overwrite onboarding templates", …).
   */
  async assertContextGraphOwner(contextGraphId: string, callerAgentAddress: string | undefined, action: string): Promise<void> {
    const owner = await this.getContextGraphOwner(contextGraphId);
    if (!owner) {
      throw new Error(`Context graph "${contextGraphId}" has no registered owner; cannot ${action}.`);
    }
    if (!this.isCallerOrNodeOwner(owner, callerAgentAddress)) {
      const caller = callerAgentAddress
        ? `did:dkg:agent:${callerAgentAddress}`
        : `did:dkg:agent:${this.defaultAgentAddress ?? this.peerId}`;
      throw new Error(
        `Only the context graph curator can ${action} for "${contextGraphId}". ` +
        `Owner=${owner}, caller=${caller}.`,
      );
    }
  }

  /**
   * Check if the given owner DID matches the caller or the node's own identity.
   * When `callerAgentAddress` is provided, only that exact address is accepted
   * (plus legacy peerId compat only for the default agent).
   * Without a caller (node-level token), falls back to defaultAgentAddress and peerId.
   */
  private isCallerOrNodeOwner(ownerDid: string, callerAgentAddress?: string): boolean {
    const peerDid = `did:dkg:agent:${this.peerId}`;
    if (callerAgentAddress) {
      if (ownerDid === `did:dkg:agent:${callerAgentAddress}`) return true;
      if (callerAgentAddress === this.defaultAgentAddress && ownerDid === peerDid) return true;
      return false;
    }
    // No explicit caller (SDK / node-level token): accept only the node's
    // own identities (peerId + defaultAgentAddress). On multi-agent nodes,
    // callers must supply callerAgentAddress to operate on non-default CGs.
    if (ownerDid === peerDid) return true;
    if (this.defaultAgentAddress && ownerDid === `did:dkg:agent:${this.defaultAgentAddress}`) return true;
    return false;
  }

  /**
   * Chain registration must be authorized by an EVM-address principal. A
   * libp2p peer ID proves transport identity, not on-chain authority.
   */
  private isCallerOrNodeAddressOwner(ownerDid: string, callerAgentAddress?: string): boolean {
    const ownerAddress = ownerDid.replace(/^did:dkg:agent:/, '');
    if (!ethers.isAddress(ownerAddress)) return false;
    if (callerAgentAddress) {
      return ethers.isAddress(callerAgentAddress) && ownerAddress.toLowerCase() === callerAgentAddress.toLowerCase();
    }
    return !!this.defaultAgentAddress
      && ethers.isAddress(this.defaultAgentAddress)
      && ownerAddress.toLowerCase() === this.defaultAgentAddress.toLowerCase();
  }

  /**
   * Address that will SIGN on-chain CG-state-changing txs (the wallet
   * the adapter binds to `contracts.contextGraphs` and invokes
   * `createContextGraph`/`updatePublishPolicy`/etc with).
   *
   * Codex PR #502 round-8/round-9: this MUST be the actual tx signer,
   * NOT the publishing principal. We deliberately skip:
   *   - `config.publisherAddress` — the configured KA publisher
   *     address, which can be a publishing delegate that does NOT
   *     sign chain txs.
   *   - `getAuthorizedPublisherAddress(contextGraphId)` — per-CG
   *     publish-time delegate registered on chain.
   *   - The generic `signMessage` probe — returns the adapter's
   *     signing principal for arbitrary messages, not its tx-signing
   *     wallet specifically.
   *
   * We only probe signer-specific adapter surfaces:
   *   1. `getSignerAddress()` (modern method — used by the EVM
   *      adapter).
   *   2. `getSignerAddresses()` (multi-signer pool; we take the
   *      first valid address).
   *   3. `signerAddress` property (mock adapter and parity tests).
   *   4. `getOperationalPrivateKey()` (legacy adapters).
   *
   * Returning `undefined` triggers the round-5 "fail closed" branch
   * in `registerContextGraph`: PCA registration is rejected because
   * the invariant cannot be verified.
   */
  private async getRegistrationTxSignerAddress(): Promise<string | undefined> {
    const chain = this.chain;

    const signerAddressGetter = (chain as unknown as { getSignerAddress?: () => unknown }).getSignerAddress;
    if (typeof signerAddressGetter === 'function') {
      try {
        const address = normalizeAdapterPublisherAddress(await Promise.resolve(signerAddressGetter.call(chain)));
        if (address) return address;
      } catch {
        // Best-effort probe; fall through to broader signer surfaces.
      }
    }

    const signerAddressesGetter = (chain as unknown as { getSignerAddresses?: () => unknown }).getSignerAddresses;
    if (typeof signerAddressesGetter === 'function') {
      try {
        const advertised = await Promise.resolve(signerAddressesGetter.call(chain));
        if (Array.isArray(advertised)) {
          for (const value of advertised) {
            const address = normalizeAdapterPublisherAddress(value);
            if (address) return address;
          }
        }
      } catch {
        // Best-effort probe.
      }
    }

    const signerAddress = normalizeAdapterPublisherAddress(
      (chain as unknown as { signerAddress?: unknown }).signerAddress,
    );
    if (signerAddress) return signerAddress;

    const adapterOperationalAddress = adapterOperationalPrivateKeyAddress(chain);
    if (adapterOperationalAddress) return adapterOperationalAddress;

    return undefined;
  }

  private async getChainPublishAuthorityAddress(contextGraphId?: string): Promise<string | undefined> {
    const configuredPublisherAddress = normalizeAdapterPublisherAddress(this.config.publisherAddress);
    if (configuredPublisherAddress) return configuredPublisherAddress;

    const legacyAdapterOperationalKey = this.config.chainConfig?.operationalKeys?.[0];
    const legacyAdapterOperationalAddress = privateKeyAddress(legacyAdapterOperationalKey);
    if (
      this.config.chainAdapter &&
      legacyAdapterOperationalAddress &&
      !(await adapterAdvertisesPublisherSigner(this.chain))
    ) {
      return legacyAdapterOperationalAddress;
    }

    let publisherContextGraphId: bigint | undefined;
    try {
      const parsed = BigInt(contextGraphId ?? '');
      if (parsed > 0n) publisherContextGraphId = parsed;
    } catch {
      // Local descriptive CG ids cannot be used as adapter context hints.
    }
    // This mirrors the publisher resolver, including the adapter-only
    // `getOperationalPrivateKey()` fallback used by custom ChainAdapters.
    return inferAdapterPublisherAddress(this.chain, publisherContextGraphId, {
      includeReservingPublisherProbe: false,
      includeGenericSignMessageProbe: false,
    });
  }

  // NOTE: `getContextGraphPublishAuthorityAccountId` and
  // `setContextGraphPublishAuthorityAccountId` helpers were removed in
  // Codex PR #502 round-6. With `registerContextGraph` no longer
  // falling back to stored values and `createContextGraph` no longer
  // persisting them, nothing on this code path reads or writes the
  // `DKG_PUBLISH_AUTHORITY_ACCOUNT_ID` triple anymore — pcaAccountId
  // lives strictly in the explicit `publishAuthorityAccountId` opt on
  // `registerContextGraph`.

  /**
   * Return true when `senderPeerId` is currently acting as the curator
   * of `contextGraphId`. Used as a minimal anti-spoof gate on join
   * lifecycle notifications (approve/reject) — those arrive unsigned
   * over p2p, so without this check any peer that knows a local
   * agent's address could forge a rejection and drive our UI into a
   * false "denied" state (Codex tier-4k N27).
   *
   * Resolution order:
   *  1. If the CG's recorded curator is a peer-ID DID
   *     (`did:dkg:agent:<libp2p-peer-id>`, legacy/creator path), match
   *     directly against `senderPeerId`.
   *  2. Otherwise the CG was registered with a wallet-scoped curator
   *     (`did:dkg:agent:0x…`). Consult the agent registry and accept
   *     the sender iff the curator agent's currently advertised peer
   *     ID matches. Registry lookup is cheap (local graph query).
   *
   * A missing curator / registry failure is treated as "not curator"
   * — we'd rather drop a real rejection than surface a forged one.
   */
  /**
   * Authorise the sender of a join-approved/rejected notification for
   * `(contextGraphId, agentAddress)`. Tries two sources, in order:
   *
   *   1. `joinRequestAcceptedBy` — peers that returned `{ok: true}`
   *      to our broadcast in `forwardJoinRequest`. This is the only
   *      check that works for the freshly-rejected case (no _meta
   *      access yet).
   *   2. `senderIsContextGraphCurator` — meta-graph curator lookup
   *      with registry fallback. This catches the case where we
   *      restarted between submit and decision (in-memory map lost),
   *      or where we're an already-approved member receiving a later
   *      decision (we have meta access from the prior approval).
   */
  private async isTrustedJoinDecisionSender(
    contextGraphId: string,
    agentAddress: string,
    senderPeerId: string,
  ): Promise<boolean> {
    const acceptedKey = `${contextGraphId}::${agentAddress.toLowerCase()}`;
    const accepted = this.joinRequestAcceptedBy.get(acceptedKey);
    if (accepted?.has(senderPeerId)) return true;
    return this.senderIsContextGraphCurator(contextGraphId, senderPeerId);
  }

  private async senderIsContextGraphCurator(contextGraphId: string, senderPeerId: string): Promise<boolean> {
    try {
      const owner = await this.getContextGraphOwner(contextGraphId);
      if (!owner) return false;
      const ownerTail = owner.replace(/^did:dkg:agent:/, '');
      if (ownerTail === senderPeerId) return true;
      // Wallet-scoped curator: resolve via registry. The curator's
      // peer ID is whatever they currently advertise — `findAgents()`
      // returns the freshest mapping we know about.
      if (/^0x[0-9a-fA-F]{40}$/.test(ownerTail)) {
        const agents = await this.discovery.findAgents();
        const match = agents.find((a) => a.agentAddress?.toLowerCase() === ownerTail.toLowerCase());
        if (match && match.peerId === senderPeerId) return true;
      }
    } catch {
      // Any lookup failure → err on the side of "not curator" and drop.
    }
    return false;
  }

  private async getContextGraphOwner(contextGraphId: string): Promise<string | null> {
    const cgMetaGraph = contextGraphMetaGraphUri(contextGraphId);
    const contextGraphUri = `did:dkg:context-graph:${contextGraphId}`;
    // Prefer the curator (wallet-scoped owner) so per-agent authorization
    // works on multi-agent nodes. Fall back to the creator (libp2p peer ID)
    // for legacy CGs created before the curator triple existed.
    const curatorResult = await this.store.query(`
      SELECT ?owner WHERE {
        GRAPH <${cgMetaGraph}> {
          <${contextGraphUri}> <${DKG_ONTOLOGY.DKG_CURATOR}> ?owner .
        }
      }
      LIMIT 1
    `);
    if (curatorResult.type === 'bindings' && curatorResult.bindings.length > 0) {
      const owner = (curatorResult.bindings[0] as Record<string, string>)['owner'];
      if (owner) return owner;
    }
    const fromCreator = await this.getContextGraphCreator(contextGraphId);
    if (fromCreator) return fromCreator;
    // Final fallback: V10 wallet-scoped cgId convention (`0x.../<name>`)
    // encodes the curator structurally, which lets us answer for CGs
    // whose RDF `_meta` triples were never written locally — most
    // commonly because on-chain registration didn't complete (no
    // identity, RPC down, mid-flight crash). Without this fallback, the
    // PROTOCOL_JOIN_REQUEST handler silently rejects every join attempt
    // for these CGs and the joiner sees only a generic "no reachable
    // curator". See `deriveCuratorDidFromCgId` for the full rationale.
    //
    // Gate: only return the structurally-derived curator when the CG
    // actually exists locally. Without this gate, a node would accept
    // PROTOCOL_JOIN_REQUEST for any wallet-prefixed CG id starting
    // with one of its agent addresses (`0x<my-addr>/<anything>`) and
    // create stray `_meta` rows for graphs that were never created
    // here. The fallback is meant to rescue real-but-half-registered
    // graphs, not impersonate ownership of unknown ones.
    const exists = await this.contextGraphExists(contextGraphId);
    if (!exists) return null;
    return deriveCuratorDidFromCgId(contextGraphId);
  }

  private async getContextGraphCurator(contextGraphId: string): Promise<string | null> {
    const cgMetaGraph = contextGraphMetaUri(contextGraphId);
    const contextGraphUri = `did:dkg:context-graph:${contextGraphId}`;
    const curatorResult = await this.store.query(`
      SELECT ?owner WHERE {
        GRAPH <${cgMetaGraph}> {
          <${contextGraphUri}> <${DKG_ONTOLOGY.DKG_CURATOR}> ?owner .
        }
      }
      LIMIT 1
    `);
    if (curatorResult.type === 'bindings' && curatorResult.bindings.length > 0) {
      const owner = (curatorResult.bindings[0] as Record<string, string>)['owner'];
      if (owner) return owner;
    }
    return null;
  }

  /**
   * Curator DID (`did:dkg:agent:0x…`) matches the caller's checksummed wallet address.
   */
  private curatorDidMatchesChecksumAgent(curatorRaw: string | undefined, checksumAddress: string): boolean {
    if (!curatorRaw?.trim()) return false;
    let t = curatorRaw.trim().replace(/^["']|["']$/g, '');
    if (t.startsWith('<') && t.endsWith('>')) t = t.slice(1, -1);
    const expected = `did:dkg:agent:${checksumAddress.toLowerCase()}`;
    return t.toLowerCase() === expected;
  }

  /**
   * Creator DID (`did:dkg:agent:<peerId>`) matches THIS node's libp2p peer id.
   * Membership signal for CGs created via this node before wallet-based curator metadata
   * was the convention — without this, a node admin (bearer-authed) loses sight of CGs
   * their own node created. Peer ids are case-sensitive base58, so we match exactly after
   * stripping IRI/quote framing.
   */
  private creatorDidMatchesSelfPeer(creatorRaw: string | undefined): boolean {
    if (!creatorRaw?.trim()) return false;
    let t = creatorRaw.trim().replace(/^["']|["']$/g, '');
    if (t.startsWith('<') && t.endsWith('>')) t = t.slice(1, -1);
    const expected = `did:dkg:agent:${this.node.peerId}`;
    return t === expected;
  }

  /**
   * Whether the wallet is on the CG allowlist (participant / allowed-agent) or tied to a
   * listed on-chain identity ID. Does not consult curator — compose with curator checks separately.
   */
  private async callerIsAllowlistedAgentParticipant(contextGraphId: string, checksumAddress: string): Promise<boolean> {
    const participants = await this.getPrivateContextGraphParticipants(contextGraphId);
    if (!participants?.length) return false;

    for (const raw of participants) {
      const p = String(raw).replace(/^["']|["']$/g, '');
      if (ethers.isAddress(p)) {
        if (ethers.getAddress(p).toLowerCase() === checksumAddress.toLowerCase()) return true;
        continue;
      }
      if (/^\d+$/.test(p) && this.chain.isOperationalWalletRegistered) {
        try {
          if (await this.chain.isOperationalWalletRegistered(BigInt(p), checksumAddress)) return true;
        } catch {
          // ignore chain read errors — treat as non-participant
        }
      }
    }
    return false;
  }

  private async getContextGraphParticipantAgentAddresses(contextGraphId: string): Promise<string[]> {
    const merged: string[] = [];
    const seen = new Set<string>();
    const add = (value: string | undefined) => {
      if (!value) return;
      const normalized = value.replace(/^"|"$/g, '');
      if (!ethers.isAddress(normalized)) return;
      const checksumAddress = ethers.getAddress(normalized);
      if (checksumAddress === ethers.ZeroAddress) {
        throw new Error('Invalid Ethereum address in participantAgents: zero address is not allowed.');
      }
      const key = normalized.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      merged.push(checksumAddress);
    };

    const contextGraphUri = `did:dkg:context-graph:${contextGraphId}`;
    const cgMetaGraph = contextGraphMetaUri(contextGraphId);
    const agentResult = await this.store.query(
      `SELECT ?agent WHERE {
        GRAPH <${cgMetaGraph}> {
          <${contextGraphUri}> <${DKG_ONTOLOGY.DKG_PARTICIPANT_AGENT}> ?agent
        }
      }`,
    );
    if (agentResult.type === 'bindings') {
      for (const row of agentResult.bindings) {
        add(row['agent']);
      }
    }
    return merged;
  }

  /**
   * Read `dkg:creator` (peer-ID DID) for a contextGraph. This is the publicly
   * discoverable owner handle used in gossip validation — it propagates
   * through ONTOLOGY sync for open CGs, while `dkg:curator` stays in `_meta`.
   * Emitted approve/revoke binding metadata must use this value so remote
   * peers validating via `gossip-publish-handler` see a matching owner.
   */
  private async getContextGraphCreator(contextGraphId: string): Promise<string | null> {
    const ontologyGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
    const cgMetaGraph = contextGraphMetaGraphUri(contextGraphId);
    const contextGraphUri = `did:dkg:context-graph:${contextGraphId}`;
    const result = await this.store.query(`
      SELECT ?owner WHERE {
        {
          GRAPH <${ontologyGraph}> {
            <${contextGraphUri}> <${DKG_ONTOLOGY.DKG_CREATOR}> ?owner .
          }
        } UNION {
          GRAPH <${cgMetaGraph}> {
            <${contextGraphUri}> <${DKG_ONTOLOGY.DKG_CREATOR}> ?owner .
          }
        }
      }
      LIMIT 1
    `);
    if (result.type !== 'bindings' || result.bindings.length === 0) return null;
    return (result.bindings[0] as Record<string, string>)['owner'] ?? null;
  }

  private async listCclPolicyBindings(opts: {
    contextGraphId?: string;
    name?: string;
  } = {}): Promise<PolicyApprovalBinding[]> {
    const ontologyGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
    const filters: string[] = [];
    if (opts.contextGraphId) filters.push(`?contextGraph = <did:dkg:context-graph:${opts.contextGraphId}>`);
    if (opts.name) filters.push(`?name = ${sparqlString(opts.name)}`);
    const filterBlock = filters.length > 0 ? `FILTER(${filters.join(' && ')})` : '';
    const result = await this.store.query(`
      SELECT ?binding ?policy ?contextGraph ?name ?contextType ?bindingStatus ?approvedAt ?approvedBy ?revokedAt ?revokedBy WHERE {
        GRAPH <${ontologyGraph}> {
          ?binding <${DKG_ONTOLOGY.RDF_TYPE}> <${DKG_ONTOLOGY.DKG_POLICY_BINDING}> ;
                   <${DKG_ONTOLOGY.DKG_POLICY_APPLIES_TO_CONTEXT_GRAPH}> ?contextGraph ;
                   <${DKG_ONTOLOGY.SCHEMA_NAME}> ?name ;
                   <${DKG_ONTOLOGY.DKG_ACTIVE_POLICY}> ?policy ;
                   <${DKG_ONTOLOGY.DKG_APPROVED_AT}> ?approvedAt .
          OPTIONAL { ?binding <${DKG_ONTOLOGY.DKG_POLICY_BINDING_STATUS}> ?bindingStatus }
          OPTIONAL { ?binding <${DKG_ONTOLOGY.DKG_APPROVED_BY}> ?approvedBy }
          OPTIONAL { ?binding <${DKG_ONTOLOGY.DKG_REVOKED_AT}> ?revokedAt }
          OPTIONAL { ?binding <${DKG_ONTOLOGY.DKG_REVOKED_BY}> ?revokedBy }
          OPTIONAL { ?binding <${DKG_ONTOLOGY.DKG_POLICY_CONTEXT_TYPE}> ?contextType }
          ${filterBlock}
        }
      }
      ORDER BY DESC(?approvedAt)
    `);

    if (result.type !== 'bindings') return [];
    const byBinding = new Map<string, PolicyApprovalBinding>();
    for (const row of result.bindings as Record<string, string>[]) {
      const bindingUri = row['binding'];
      const revokedAt = row['revokedAt'] ? stripLiteral(row['revokedAt']) : undefined;
      const next: PolicyApprovalBinding = {
        bindingUri,
        policyUri: row['policy'],
        contextGraphId: row['contextGraph'].startsWith('did:dkg:context-graph:') ? row['contextGraph'].slice('did:dkg:context-graph:'.length) : row['contextGraph'],
        name: stripLiteral(row['name']),
        contextType: row['contextType'] ? stripLiteral(row['contextType']) : undefined,
        status: revokedAt || (row['bindingStatus'] && stripLiteral(row['bindingStatus']) === 'revoked') ? 'revoked' : 'approved',
        approvedAt: stripLiteral(row['approvedAt']),
        approvedBy: row['approvedBy'],
        revokedAt,
        revokedBy: row['revokedBy'],
      };
      const current = byBinding.get(bindingUri);
      if (!current) {
        byBinding.set(bindingUri, next);
        continue;
      }
      byBinding.set(bindingUri, {
        ...current,
        status: (current.revokedAt || next.revokedAt) ? 'revoked'
          : (current.status === 'superseded' || next.status === 'superseded') ? 'superseded'
          : 'approved',
        revokedAt: current.revokedAt ?? next.revokedAt,
        revokedBy: current.revokedBy ?? next.revokedBy,
        approvedBy: current.approvedBy ?? next.approvedBy,
      });
    }
    const allBindings = Array.from(byBinding.values()).sort((a, b) => b.approvedAt.localeCompare(a.approvedAt));

    // Mark non-revoked, non-latest bindings as "superseded" per scope
    const latestByScope = new Map<string, string>();
    for (const b of allBindings) {
      if (b.status === 'revoked') continue;
      const key = `${b.contextGraphId}|${b.name}|${b.contextType ?? ''}`;
      if (!latestByScope.has(key)) {
        latestByScope.set(key, b.bindingUri);
      } else if (b.bindingUri !== latestByScope.get(key)) {
        b.status = 'superseded';
      }
    }
    return allBindings;
  }

  private selectLatestNonRevokedBindings(bindings: PolicyApprovalBinding[]): Map<string, PolicyApprovalBinding> {
    const latestByScope = new Map<string, PolicyApprovalBinding>();
    for (const binding of bindings) {
      if (binding.status === 'revoked' || binding.status === 'superseded') continue;
      const key = `${binding.contextGraphId}|${binding.name}|${binding.contextType ?? ''}`;
      const current = latestByScope.get(key);
      if (!current || binding.approvedAt > current.approvedAt) {
        latestByScope.set(key, binding);
      }
    }
    return latestByScope;
  }

  private resolveCclPolicyBinding(
    latestByScope: Map<string, PolicyApprovalBinding>,
    contextGraphId: string,
    name: string,
    contextType?: string,
  ): PolicyApprovalBinding | null {
    return latestByScope.get(`${contextGraphId}|${name}|${contextType ?? ''}`)
      ?? latestByScope.get(`${contextGraphId}|${name}|`)
      ?? null;
  }

  private async getActiveCclPolicyBinding(opts: {
    contextGraphId: string;
    policyUri: string;
    contextType?: string;
  }): Promise<PolicyApprovalBinding | null> {
    const record = await this.getCclPolicyByUri(opts.policyUri);
    if (!record) return null;
    const bindings = await this.listCclPolicyBindings({ contextGraphId: opts.contextGraphId, name: record.name });
    const latestByScope = this.selectLatestNonRevokedBindings(bindings);
    const active = this.resolveCclPolicyBinding(latestByScope, opts.contextGraphId, record.name, opts.contextType);
    if (!active || active.policyUri !== opts.policyUri) return null;
    return active;
  }

  private deriveCclPolicyStatus(
    policyUri: string,
    storedStatus: string,
    bindings: PolicyApprovalBinding[],
    latestByScope: Map<string, PolicyApprovalBinding>,
  ): string {
    if (Array.from(latestByScope.values()).some(binding => binding.policyUri === policyUri)) {
      return 'approved';
    }
    if (bindings.some(binding => binding.policyUri === policyUri)) {
      return 'revoked';
    }
    return storedStatus;
  }

  private async publishOntologyQuads(ual: string, quads: Quad[]): Promise<void> {
    const ontologyTopic = contextGraphPublishTopic(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
    const nquads = quads.map(q => {
      const obj = q.object.startsWith('"') ? q.object : `<${q.object}>`;
      return `<${q.subject}> <${q.predicate}> ${obj} <${q.graph}> .`;
    }).join('\n');

    const msg = encodePublishRequest({
      ual,
      nquads: new TextEncoder().encode(nquads),
      contextGraphId: SYSTEM_CONTEXT_GRAPHS.ONTOLOGY,
      kas: [],
      publisherIdentity: this.wallet.keypair.publicKey,
      publisherAddress: '',
      startKAId: 0,
      endKAId: 0,
      chainId: '',
      publisherSignatureR: new Uint8Array(0),
      publisherSignatureVs: new Uint8Array(0),
    });

    try {
      await this.gossip.publish(ontologyTopic, msg);
    } catch {
      // No peers subscribed — ok for local-only operation
    }
  }

  get identityId(): bigint {
    return this.publisher.getIdentityId();
  }

  /**
   * Sign the context graph participant digest: keccak256(contextGraphId, merkleRoot).
   * Returns the caller's identity ID and compact ECDSA (r, vs) values that the
   * ContextGraphs contract can verify via ecrecover.
   */
  async signContextGraphDigest(
    contextGraphId: bigint,
    merkleRoot: Uint8Array,
  ): Promise<{ identityId: bigint; r: Uint8Array; vs: Uint8Array }> {
    if (typeof this.chain.signMessage !== 'function') {
      throw new Error('Chain adapter does not support signMessage');
    }
    const digest = ethers.solidityPackedKeccak256(
      ['uint256', 'bytes32'],
      [contextGraphId, ethers.hexlify(merkleRoot)],
    );
    const sig = await this.chain.signMessage(ethers.getBytes(digest));
    return { identityId: this.identityId, ...sig };
  }

  get multiaddrs(): string[] {
    return this.node.multiaddrs;
  }

  /** Returns a snapshot of the context graph subscription registry. */
  getSubscribedContextGraphs(): ReadonlyMap<string, ContextGraphSub> {
    return this.subscribedContextGraphs;
  }

  /** Returns the latest health snapshot for all known peers. */
  getPeerHealth(): ReadonlyMap<string, PeerHealth> {
    return this.peerHealth;
  }

  async getPeerProtocols(peerId: string): Promise<string[]> {
    try {
      const { peerIdFromString } = await import('@libp2p/peer-id');
      const pid = peerIdFromString(peerId);
      const peer = await this.node.libp2p.peerStore.get(pid);
      return [...(peer.protocols ?? [])];
    } catch {
      return [];
    }
  }

  /**
   * Ping all known peers to check liveness. Updates the peerHealth map with
   * latency and last-seen timestamps. Returns the number of peers that responded.
   */
  async pingPeers(): Promise<number> {
    const ctx = createOperationContext('system');
    const peers = this.node.libp2p.getPeers();
    if (peers.length === 0) return 0;

    const PING_TIMEOUT_MS = 10_000;
    let alive = 0;
    const now = Date.now();

    const results = await Promise.allSettled(
      peers.map(async (peerId) => {
        const id = peerId.toString();
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), PING_TIMEOUT_MS);
        try {
          const latency = await this.node.libp2p.services.ping.ping(peerId, { signal: ac.signal });
          clearTimeout(timer);
          this.peerHealth.set(id, {
            peerId: id,
            alive: true,
            latencyMs: latency,
            lastSeen: now,
            lastChecked: now,
          });
          return true;
        } catch {
          clearTimeout(timer);
          const prev = this.peerHealth.get(id);
          this.peerHealth.set(id, {
            peerId: id,
            alive: false,
            latencyMs: null,
            lastSeen: prev?.lastSeen ?? null,
            lastChecked: now,
          });
          return false;
        }
      }),
    );

    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) alive++;
    }

    this.log.info(ctx, `Peer health ping: ${alive}/${peers.length} peers alive`);
    return alive;
  }

  /**
   * Scan the local ONTOLOGY graph and curated/private _meta graphs for context
   * graph definitions and auto-subscribe to any that aren't yet in the
   * subscription registry. Called after syncFromPeer to catch context graphs
   * discovered via ONTOLOGY sync or authenticated _meta sync.
   */
  async discoverContextGraphsFromStore(): Promise<number> {
    const ctx = createOperationContext('system');
    const ontologyGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
    const prefix = 'did:dkg:context-graph:';
    let discovered = 0;

    const discoveredEntries = new Map<string, { id: string; name: string; source: 'ontology' | 'meta' }>();

    const collectEntries = (
      rows: Record<string, string>[],
      source: 'ontology' | 'meta',
    ) => {
      for (const row of rows) {
        const uri = row['ctxGraph'] ?? '';
        const id = uri.startsWith(prefix) ? uri.slice(prefix.length) : null;
        if (!id) continue;
        if (id === SYSTEM_CONTEXT_GRAPHS.AGENTS || id === SYSTEM_CONTEXT_GRAPHS.ONTOLOGY) continue;

        const existing = discoveredEntries.get(id);
        const name = row['name'] ? stripLiteral(row['name']) : existing?.name ?? id;

        if (!existing || (existing.source === 'meta' && source === 'ontology')) {
          discoveredEntries.set(id, { id, name, source });
        }
      }
    };

    const ontologyResult = await this.store.query(`
      SELECT ?ctxGraph ?name WHERE {
        GRAPH <${ontologyGraph}> {
          ?ctxGraph <${DKG_ONTOLOGY.RDF_TYPE}> <${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}> .
          OPTIONAL { ?ctxGraph <${DKG_ONTOLOGY.SCHEMA_NAME}> ?name }
        }
      }
    `);
    if (ontologyResult.type === 'bindings') {
      collectEntries(ontologyResult.bindings as Record<string, string>[], 'ontology');
    }

    const metaResult = await this.store.query(`
      SELECT ?ctxGraph ?name WHERE {
        GRAPH ?metaGraph {
          ?ctxGraph <${DKG_ONTOLOGY.RDF_TYPE}> <${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}> .
          OPTIONAL { ?ctxGraph <${DKG_ONTOLOGY.SCHEMA_NAME}> ?name }
          FILTER(STRENDS(STR(?metaGraph), "/_meta"))
        }
      }
    `);
    if (metaResult.type === 'bindings') {
      collectEntries(metaResult.bindings as Record<string, string>[], 'meta');
    }

    for (const { id, name, source } of discoveredEntries.values()) {
      const existing = this.subscribedContextGraphs.get(id);
      if (existing) continue;

      // Two kinds of discovered CG, two different opt-in semantics:
      //
      // - Open / public CG (no curated _meta graph locally): Viktor's
      //   v10-rc hardening (commit b9a73e7e "better sync") says do
      //   NOT auto-subscribe — a node shouldn't auto-ingest every
      //   public CG a peer happens to know about. Explicit subscribe
      //   (UI "Join" / `subscribeToContextGraph`) is the opt-in.
      //
      // - Curated / private CG (access policy "private" or has an
      //   allowlist): auto-subscribe so `trySyncFromPeer`'s
      //   "newly discovered CGs" catchup pass (see dkg-agent.ts
      //   ~#1009) actually fetches the KC data on the same connect
      //   cycle. Without this, a freshly invited node would see
      //   the CG registered locally but never pull any KCs —
      //   regressed the e2e-privacy "B discovers and syncs a
      //   private CG in a single connect cycle via trySyncFromPeer"
      //   test. `authorizeSyncRequest` still enforces the allowlist
      //   on the responder side, so auto-subscribing here cannot
      //   leak private data to non-participants; it only means
      //   "attempt the catchup now instead of deferring it".
      //   NOTE: we use `isPrivateContextGraph` (which reads the
      //   ontology OR the _meta graph for `dkg:accessPolicy
      //   "private"`, and also treats any CG with a `DKG_ALLOWED_
      //   AGENT` allowlist as private) rather than
      //   `source === 'meta'`, because the ontology-vs-meta
      //   collision resolver above lets an ontology row shadow a
      //   meta row when both exist for the same id.
      const isCurated = await this.isPrivateContextGraph(id);

      if (isCurated) {
        // Seed the subscription entry BEFORE calling subscribeToContextGraph
        // so the `...existing` spread in `subscribeToContextGraph` preserves
        // the discovered human-readable `name` (otherwise the UI/listing
        // APIs fall back to the raw CG id).
        //
        // `synced: false` is the truthful state at discovery — we have
        // the definition triple but no CG content yet. The catchup
        // runner flips it to true once data has actually been pulled
        // (see `markContextGraphSubscriptionState` at
        // routes/context-graph.ts:1301).
        //
        // Intentionally leave `metaSynced` FALSE here for the same
        // reason: the gossip handler's "deny until _meta is synced"
        // guard must stay armed until the authenticated allowlist
        // (`_meta` graph) has actually arrived. The follow-up
        // `refreshMetaSyncedFlags(newlyDiscovered)` call from
        // `trySyncFromPeer` will flip it once the allowlist has been
        // fetched via the authenticated sync path.
        this.setContextGraphSubscription(id, {
          name,
          subscribed: false,
          synced: false,
          metaSynced: false,
          onChainId: undefined,
        }, { persist: false });
        this.subscribeToContextGraph(id);
        this.log.info(ctx, `Discovered invited context graph "${name}" (${id}) — auto-subscribed (private/allowlisted)`);
      } else {
        // Same truthful-flag rationale as the curated branch above:
        // `synced` reflects "have CG data locally", not "have heard the
        // definition triple from gossip."
        this.setContextGraphSubscription(id, {
          name,
          subscribed: false,
          synced: false,
          metaSynced: source === 'meta',
          onChainId: undefined,
        }, { persist: false });
        this.log.info(ctx, `Discovered context graph "${name}" (${id}) from ${source} store — added as discoverable only`);
      }
      discovered++;
    }

    if (discovered > 0) {
      this.log.info(ctx, `Added ${discovered} new context graph(s) from store`);
    }
    return discovered;
  }

  /**
   * Query the on-chain registry for all registered context graphs and
   * auto-subscribe to any not yet in the subscription registry.
   * Returns the number of newly discovered context graphs.
   */
  async discoverContextGraphsFromChain(): Promise<number> {
    const ctx = createOperationContext('system');
    if (!this.chain.listContextGraphsFromChain) {
      this.log.info(ctx, 'Chain adapter does not support listContextGraphsFromChain — skipping');
      return 0;
    }

    let onChainContextGraphs;
    try {
      onChainContextGraphs = await this.chain.listContextGraphsFromChain();
    } catch (err) {
      this.log.warn(ctx, `Chain context graph scan failed: ${err instanceof Error ? err.message : String(err)}`);
      return 0;
    }

    // Build a set of all known on-chain IDs (stored and computed) for fast dedup
    const knownOnChainIds = new Set<string>();
    for (const [localId, sub] of this.subscribedContextGraphs) {
      if (sub.onChainId) knownOnChainIds.add(sub.onChainId);
      // Also compute expected hash for locally-known context graph IDs
      knownOnChainIds.add(ethers.keccak256(ethers.toUtf8Bytes(localId)));
    }

    let discovered = 0;
    for (const p of onChainContextGraphs) {
      if (knownOnChainIds.has(p.contextGraphId)) continue;

      if (!p.name) {
        // Hash-only entry (metadata not revealed) — record for dedup but don't
        // subscribe to gossip topics since hash-keyed topics are unusable.
        this.log.info(ctx, `Noted unresolved on-chain context graph ${p.contextGraphId.slice(0, 16)}… (no metadata)`);
        knownOnChainIds.add(p.contextGraphId);
        continue;
      }

      // Curated CGs (accessPolicy=1) must not silently land in non-participants' lists.
      // We can't query the V10 ContextGraphs participant set from a NameRegistry event alone,
      // so apply the strict default: only auto-subscribe when this node's wallet matches
      // `creator` (the address that called claimName). Real participants will have the CG
      // surfaced through manual subscribe / catch-up triggered by their curator.
      if (Number(p.accessPolicy) === 1) {
        const isCurator = !!this.defaultAgentAddress
          && typeof p.creator === 'string'
          && p.creator.toLowerCase() === this.defaultAgentAddress.toLowerCase();
        if (!isCurator) {
          this.log.info(ctx, `Skipping auto-subscribe to curated chain entry "${p.name}" (${p.contextGraphId.slice(0, 16)}…) — not curator`);
          knownOnChainIds.add(p.contextGraphId);
          continue;
        }
      }

      this.setContextGraphSubscription(p.name, {
        name: p.name,
        subscribed: true,
        synced: false,
        metaSynced: false,
        onChainId: p.contextGraphId,
      });
      this.subscribeToContextGraph(p.name, { trackSyncScope: false });

      // Persist the on-chain ID to the ontology graph so the publisher's
      // VM registration guard can find it via RDF (it has no access to
      // the in-memory subscribedContextGraphs map).
      const cgUri = contextGraphDataGraphUri(p.name);
      const ontoGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
      await this.store.insert([{
        subject: cgUri,
        predicate: `${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}OnChainId`,
        object: `"${p.contextGraphId}"`,
        graph: ontoGraph,
      }]);

      this.log.info(ctx, `Discovered on-chain context graph "${p.name}" (${p.contextGraphId.slice(0, 16)}…) — auto-subscribed (synced=false)`);
      discovered++;
    }

    if (discovered > 0) {
      this.log.info(ctx, `Discovered ${discovered} new context graph(s) from chain`);
    }
    return discovered;
  }

  /**
   * Snapshot of the V10 Random Sampling prover's recent activity.
   * Returns a disabled-handle status when the prover never started
   * (edge node, no identity, missing chain methods). Used by the
   * daemon's `/api/random-sampling/status` route + the CLI's
   * `random-sampling status` subcommand.
   */
  getRandomSamplingStatus(): RandomSamplingStatus {
    if (this.randomSamplingHandle) return this.randomSamplingHandle.getStatus();
    return {
      enabled: false,
      role: (this.config.nodeRole ?? 'edge') as 'core' | 'edge',
      identityId: '0',
      loop: null,
    };
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    if (this.chainPoller) {
      this.chainPoller.stop();
      this.chainPoller = null;
    }
    if (this.swmCleanupTimer) {
      clearInterval(this.swmCleanupTimer);
      this.swmCleanupTimer = null;
    }
    if (this.syncReconcilerTimer) {
      clearInterval(this.syncReconcilerTimer);
      this.syncReconcilerTimer = null;
    }
    if (this.joinApprovalRetryTimer) {
      clearInterval(this.joinApprovalRetryTimer);
      this.joinApprovalRetryTimer = null;
    }
    if (this.messageOutboxTimer) {
      clearInterval(this.messageOutboxTimer);
      this.messageOutboxTimer = null;
    }
    // Drop in-memory retry queue on shutdown; entries don't survive a
    // restart (the operator can re-fire via the redeliver-approval route
    // when needed).
    this.joinApprovalRetryQueue.clear();
    this.clearRandomSamplingBindRetry();
    this.clearStorageACKRegistrationRetry();
    this.storageACKRegistrationRetryInFlight = false;
    if (this.randomSamplingHandle) {
      try { await this.randomSamplingHandle.stop(); } catch { /* swallow on shutdown */ }
      this.randomSamplingHandle = null;
    }
    await this.node.stop();
    if (this.syncVerifyWorker) {
      await this.syncVerifyWorker.close();
      this.syncVerifyWorker = undefined;
    }
    this.started = false;
  }

  /**
   * Loads genesis knowledge into the triple store if not already present.
   * Creates the system context graph graphs and inserts the genesis quads.
   */
  private static async loadGenesis(store: TripleStore): Promise<void> {
    const gm = new GraphManager(store);

    // Ensure system context graphs exist
    await gm.ensureContextGraph(SYSTEM_CONTEXT_GRAPHS.AGENTS);
    await gm.ensureContextGraph(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);

    // Check if genesis is already loaded by looking for the network definition
    const result = await store.query(
      `SELECT ?v WHERE { <did:dkg:network:v9-testnet> <https://dkg.network/ontology#genesisVersion> ?v } LIMIT 1`,
    );
    if (result.type === 'bindings' && result.bindings.length > 0) return;

    // Insert genesis quads
    const genesisQuads = getGenesisQuads();
    const quads: Quad[] = genesisQuads.map(gq => ({
      subject: gq.subject,
      predicate: gq.predicate,
      object: gq.object.startsWith('"') ? gq.object : gq.object,
      graph: gq.graph,
    }));
    await store.insert(quads);
  }

  /**
   * Create a V10 ACK provider callback for the publisher.
   * Uses ACKCollector to broadcast PublishIntent and collect StorageACKs
   * via direct P2P from connected core nodes. The required number of ACKs
   * is read from chain ParametersStorage.minimumRequiredSignatures().
   */
  private createV10ACKProvider(contextGraphId: string) {
    if (!this.router || !this.gossip) return undefined;
    // `isV10Ready()` is the authoritative V10 capability gate. Using it
    // (instead of probing for `createKnowledgeAssetsV10`) keeps
    // `NoChainAdapter` — whose stub methods throw — out of the V10 path.
    if (typeof this.chain.isV10Ready !== 'function' || !this.chain.isV10Ready()) return undefined;
    // Require on-chain identity verification to prevent accepting unverified ACKs
    // that would fail on-chain and waste gas. Fall back to legacy path if unavailable.
    if (typeof this.chain.verifyACKIdentity !== 'function') return undefined;
    // The H5 prefix requires a numeric chain id AND the deployed KAV10
    // address. Without BOTH, the collector cannot build a digest that
    // matches what core-node ACK handlers sign, so refuse to hand back a
    // provider at all rather than crash on the first publish with
    // `chain.getEvmChainId is not a function`. Mirrors the guard at
    // `packages/cli/src/publisher-runner.ts:createV10ACKProviderForPublisher`.
    if (typeof this.chain.getEvmChainId !== 'function') return undefined;
    if (typeof this.chain.getKnowledgeAssetsV10Address !== 'function') return undefined;

    const collector = new ACKCollector({
      gossipPublish: async (topic: string, data: Uint8Array) => {
        await this.gossip.publish(topic, data);
      },
      sendP2P: async (peerId: string, protocol: string, data: Uint8Array) => {
        return this.messenger.sendToPeer(peerId, protocol, data);
      },
      getConnectedCorePeers: () => {
        const peers = this.node.libp2p.getPeers();
        const connected = peers.map(p => p.toString()).filter(id => id !== this.peerId);
        // Prefer peers confirmed as core nodes (advertise StorageACK protocol).
        if (this.knownCorePeerIds.size > 0) {
          const filtered = connected.filter(id => this.knownCorePeerIds.has(id));
          if (filtered.length > 0) return filtered;
        }
        // Fallback: return all connected peers during early startup before
        // protocol discovery completes. Since only core nodes register the
        // StorageACK handler, requests to edge nodes fail at protocol
        // negotiation (fast, no error logs on the remote side).
        return connected;
      },
      verifyIdentity: typeof this.chain.verifyACKIdentity === 'function'
        ? async (recoveredAddress: string, claimedIdentityId: bigint) => {
            try {
              return await this.chain.verifyACKIdentity!(recoveredAddress, claimedIdentityId);
            } catch {
              return false;
            }
          }
        : undefined,
      log: (msg: string) => {
        const ctx = createOperationContext('publish');
        this.log.info(ctx, msg);
      },
    });

    const chain = this.chain;

    return async (
      merkleRoot: Uint8Array,
      contextGraphId: string,
      kaCount: number,
      rootEntities: string[],
      publicByteSize: bigint,
      stagingQuads: Uint8Array | undefined,
      epochs: number | undefined,
      tokenAmount: bigint | undefined,
      swmGraphId: string | undefined,
      subGraphName: string | undefined,
      merkleLeafCount: number,
    ) => {
      // Fail loud on non-numeric or non-positive CG ids: V10 publish requires
      // a real on-chain context graph and the contract rejects `cgId == 0`
      // with `ZeroContextGraphId`. Reject `<= 0n` (not `=== 0n`) because
      // `BigInt("-1")` returns `-1n` without throwing — a naive zero check
      // would let negative ids through to the evm-adapter pre-tx guard,
      // where ethers' uint256 encoder would throw a cryptic low-level
      // error. Matches the same guard in dkg-publisher, storage-ack-handler,
      // and async publisher-runner so ACK signers, ACK verifiers, and the
      // chain submitter all agree on the legal domain. `contextGraphId`
      // here is the TARGET on-chain id — `swmGraphId` (optional) is the
      // source SWM graph name and is NOT required to be numeric.
      let cgIdBigInt: bigint;
      try {
        cgIdBigInt = BigInt(contextGraphId);
      } catch {
        throw new Error(
          `V10 ACK collection requires a numeric on-chain context graph id; ` +
          `got '${contextGraphId}'. Register the CG on-chain via ContextGraphs.createContextGraph first.`,
        );
      }
      if (cgIdBigInt <= 0n) {
        throw new Error(
          `V10 ACK collection requires a positive on-chain context graph id; got ${cgIdBigInt}. ` +
          `Register the CG on-chain via ContextGraphs.createContextGraph first.`,
        );
      }
      if (!Number.isInteger(merkleLeafCount) || merkleLeafCount < 1) {
        throw new Error(
          `V10 ACK collection requires a positive integer merkleLeafCount; got ${merkleLeafCount}. ` +
          'Publishers must pass the V10 flat-KC leaf count computed by V10MerkleTree.',
        );
      }

      const requiredACKs = typeof chain.getMinimumRequiredSignatures === 'function'
        ? await chain.getMinimumRequiredSignatures()
        : undefined;

      // H5 prefix inputs — both come from the chain adapter so that
      // publisher-side digest construction matches what core-node handlers
      // produced on their side. These are required for any V10 path; the
      // adapter must implement them.
      const chainIdBig = await chain.getEvmChainId();
      const kav10Address = await chain.getKnowledgeAssetsV10Address();

      const result = await collector.collect({
        merkleRoot,
        contextGraphId: cgIdBigInt,
        contextGraphIdStr: contextGraphId,
        publisherPeerId: this.peerId,
        publicByteSize,
        isPrivate: false,
        kaCount,
        rootEntities,
        chainId: chainIdBig,
        kav10Address,
        requiredACKs,
        stagingQuads,
        epochs,
        tokenAmount,
        swmGraphId,
        subGraphName,
        merkleLeafCount,
      });
      return result.acks;
    };
  }

  private async broadcastPublish(contextGraphId: string, result: PublishResult, ctx: OperationContext): Promise<void> {
    // Use the public quads from the publish result to avoid leaking private
    // triples that are stored in the same data graph.
    const publicQuads = result.publicQuads ?? [];
    const ntriples = publicQuads.map(q => {
      const obj = q.object.startsWith('"') ? q.object : `<${q.object}>`;
      return `<${q.subject}> <${q.predicate}> ${obj} .`;
    }).join('\n');

    const onChain = result.onChainResult;
    const msg = encodePublishRequest({
      ual: result.ual,
      nquads: new TextEncoder().encode(ntriples),
      contextGraphId: contextGraphId,
      kas: result.kaManifest.map(ka => ({
        tokenId: Number(ka.tokenId),
        rootEntity: ka.rootEntity,
        privateMerkleRoot: ka.privateMerkleRoot ?? new Uint8Array(0),
        privateTripleCount: ka.privateTripleCount ?? 0,
      })),
      publisherIdentity: this.wallet.keypair.publicKey,
      publisherAddress: onChain?.publisherAddress ?? '',
      startKAId: Number(onChain?.startKAId ?? 0),
      endKAId: Number(onChain?.endKAId ?? 0),
      chainId: this.chain.chainId,
      publisherSignatureR: new Uint8Array(0),
      publisherSignatureVs: new Uint8Array(0),
      txHash: onChain?.txHash ?? '',
      blockNumber: onChain?.blockNumber ?? 0,
      operationId: ctx.operationId,
      subGraphName: result.subGraphName,
    });

    const topic = contextGraphPublishTopic(contextGraphId);
    this.log.info(ctx, `Broadcasting to topic ${topic}`);
    try {
      await this.gossip.publish(topic, msg);
    } catch {
      this.log.warn(ctx, `No peers subscribed to ${topic} yet`);
    }
  }

  // ── Working Memory Assertion Operations (spec §6) ───────────────────

  get assertion() {
    const agent = this;
    const agentAddress = this.defaultAgentAddress ?? this.peerId;
    return {
      async create(contextGraphId: string, name: string, opts?: { subGraphName?: string }): Promise<string> {
        return agent.publisher.assertionCreate(contextGraphId, name, agentAddress, opts?.subGraphName);
      },

      /**
       * Write triples to a WM assertion. Accepts:
       * - `Quad[]` — standard quad array (same as publish/share)
       * - `JsonLdContent` — JSON-LD document, auto-converted to quads
       * - `Array<{ subject, predicate, object }>` — simple triple array
       */
      async write(
        contextGraphId: string,
        name: string,
        input: import('@origintrail-official/dkg-storage').Quad[] | JsonLdContent | Array<{ subject: string; predicate: string; object: string }>,
        opts?: { subGraphName?: string },
      ): Promise<void> {
        let quads: import('@origintrail-official/dkg-storage').Quad[];
        if (Array.isArray(input) && input.length > 0 && 'graph' in input[0]) {
          quads = input as import('@origintrail-official/dkg-storage').Quad[];
        } else if (!Array.isArray(input) || (input.length > 0 && !('subject' in input[0]))) {
          const { publicQuads, privateQuads } = await jsonLdToQuads(input as JsonLdContent);
          quads = [...publicQuads, ...privateQuads];
        } else {
          quads = (input as Array<{ subject: string; predicate: string; object: string }>)
            .map(t => ({ subject: t.subject, predicate: t.predicate, object: t.object, graph: '' }));
        }
        return agent.publisher.assertionWrite(contextGraphId, name, agentAddress, quads, opts?.subGraphName);
      },

      async query(contextGraphId: string, name: string, opts?: { subGraphName?: string }): Promise<import('@origintrail-official/dkg-storage').Quad[]> {
        return agent.publisher.assertionQuery(contextGraphId, name, agentAddress, opts?.subGraphName);
      },
      async promote(contextGraphId: string, name: string, opts?: { entities?: string[] | 'all'; subGraphName?: string }): Promise<{ promotedCount: number }> {
        // Resolve the gossip signer up-front (mirrors `share()` /
        // `conditionalShare()` patterns) so the publisher can wrap the
        // promoted SWM gossip in the Sender Key encrypted envelope.
        // Without this, private/agent-gated CGs receive plaintext
        // gossip and the new `SharedMemoryHandler` check rejects it.
        const gossipSigner = await agent.resolveWorkspaceGossipSigningAgent(contextGraphId);
        const { promotedCount, gossipMessage } = await agent.publisher.assertionPromote(
          contextGraphId, name, agentAddress,
          {
            ...opts,
            publisherPeerId: agent.node.peerId.toString(),
            senderAgentAddress: gossipSigner?.agentAddress,
          },
        );
        if (gossipMessage) {
          try {
            await agent.publishWorkspaceGossip(contextGraphId, gossipMessage, createOperationContext('share'), gossipSigner);
          } catch (err: any) {
            agent.log.warn(createOperationContext('share'), `Promote gossip failed (local SWM committed): ${err?.message ?? err}`);
          }
        }
        return { promotedCount };
      },
      async discard(contextGraphId: string, name: string, opts?: { subGraphName?: string }): Promise<void> {
        return agent.publisher.assertionDiscard(contextGraphId, name, agentAddress, opts?.subGraphName);
      },

      /**
       * RFC-001 §9.x — finalize a Working Memory assertion.
       *
       * This is the moment the assertion's content is cryptographically
       * committed to a chain target: the daemon computes the canonical
       * merkleRoot from the assertion's quads, builds the EIP-712
       * AuthorAttestation typed data, signs it (or verifies a pre-signed
       * payload), and stamps the result as a block of `_meta` triples
       * keyed by the assertion URI.
       *
       * After finalize, the assertion's content is sealed: subsequent
       * `write` calls would invalidate the seal. The seal travels with
       * the assertion through SWM gossip (because `_meta` propagates by
       * default) and is consumed verbatim by the chain publish path —
       * publish never re-signs or re-hashes.
       *
       * Authorship resolution mirrors `publishFromSharedMemory`:
       *   1. `preSignedAuthorAttestation` wins (self-sovereign agents).
       *   2. `authorAgentAddress` → custodial agent's private key from
       *      the local keystore.
       *   3. Otherwise → throw. The route layer is responsible for
       *      defaulting to the request token's agent (or to the
       *      publisher EOA when an admin token is presented).
       *
       * Idempotent: re-finalizing an already-sealed assertion with the
       * same content returns the existing seal without re-signing. A
       * conflicting re-finalize (different content / author) throws.
       */
      async finalize(
        contextGraphId: string,
        name: string,
        opts?: {
          subGraphName?: string;
          authorAgentAddress?: string;
          preSignedAuthorAttestation?: PreSignedAuthorAttestation;
          schemeVersion?: number;
        },
      ): Promise<{
        assertionUri: string;
        merkleRoot: Uint8Array;
        authorAddress: string;
        schemeVersion: number;
        chainId: bigint;
        kav10Address: string;
        eip712Digest: string;
      }> {
        return agent.assertionFinalize(contextGraphId, name, agentAddress, opts);
      },

      async history(contextGraphId: string, name: string, opts?: { agentAddress?: string; subGraphName?: string }): Promise<AssertionDescriptor | null> {
        const addr = opts?.agentAddress ?? agentAddress;
        const lifecycleUri = assertionLifecycleUri(contextGraphId, addr, name, opts?.subGraphName);
        const metaGraph = contextGraphMetaUri(contextGraphId);
        const DKG_NS = 'http://dkg.io/ontology/';
        const PROV_NS = 'http://www.w3.org/ns/prov#';

        const strip = (v?: string) => v?.replace(/^"|"$/g, '').replace(/"\^\^<.*>$/, '') ?? undefined;

        // Query assertion entity (current state + layer)
        const entityResult = await agent.store.query(
          `SELECT ?state ?memoryLayer ?assertionGraph WHERE {
            GRAPH <${metaGraph}> {
              <${lifecycleUri}> <${DKG_NS}state> ?state .
              OPTIONAL { <${lifecycleUri}> <${DKG_NS}memoryLayer> ?memoryLayer }
              OPTIONAL { <${lifecycleUri}> <${DKG_NS}assertionGraph> ?assertionGraph }
            }
          } LIMIT 1`,
        );
        if (entityResult.type !== 'bindings' || entityResult.bindings.length === 0) return null;

        const row = entityResult.bindings[0];
        const stateStr = strip(row['state']) as AssertionState;
        const layerStr = strip(row['memoryLayer']);
        const graphUri = row['assertionGraph'] ?? contextGraphAssertionUri(contextGraphId, addr, name);

        // Query all prov:Activity events that acted on this assertion
        // (linked via prov:used or prov:generated)
        const eventsResult = await agent.store.query(
          `SELECT ?event ?type ?timestamp ?fromLayer ?toLayer ?shareOpId ?kcUal ?rootEntity WHERE {
            GRAPH <${metaGraph}> {
              { ?event <${PROV_NS}generated> <${lifecycleUri}> }
              UNION
              { ?event <${PROV_NS}used> <${lifecycleUri}> }
              ?event a <${PROV_NS}Activity> .
              ?event a ?type .
              FILTER(STRSTARTS(STR(?type), "${DKG_NS}"))
              ?event <${PROV_NS}startedAtTime> ?timestamp .
              ?event <${DKG_NS}fromLayer> ?fromLayer .
              ?event <${DKG_NS}toLayer> ?toLayer .
              OPTIONAL { ?event <${DKG_NS}shareOperationId> ?shareOpId }
              OPTIONAL { ?event <${DKG_NS}kcUal> ?kcUal }
              OPTIONAL { ?event <${DKG_NS}rootEntity> ?rootEntity }
            }
          } ORDER BY ?timestamp`,
        );

        // Group event rows by event URI (rootEntity may produce multiple rows)
        const eventMap = new Map<string, AssertionEvent>();
        if (eventsResult.type === 'bindings') {
          for (const b of eventsResult.bindings) {
            const eventUri = b['event'];
            if (!eventUri) continue;
            if (!eventMap.has(eventUri)) {
              const typeSuffix = (b['type'] ?? '').replace(DKG_NS, '').replace('Assertion', '').toLowerCase();
              eventMap.set(eventUri, {
                type: (typeSuffix || stateStr) as AssertionState,
                timestamp: strip(b['timestamp']) ?? '',
                fromLayer: strip(b['fromLayer']) ?? '',
                toLayer: strip(b['toLayer']) ?? '',
                shareOperationId: strip(b['shareOpId']),
                kcUal: strip(b['kcUal']),
                rootEntities: b['rootEntity'] ? [b['rootEntity']] : undefined,
              });
            } else if (b['rootEntity']) {
              const existing = eventMap.get(eventUri)!;
              if (!existing.rootEntities) existing.rootEntities = [];
              if (!existing.rootEntities.includes(b['rootEntity'])) {
                existing.rootEntities.push(b['rootEntity']);
              }
            }
          }
        }

        return {
          contextGraphId,
          agentAddress: addr,
          name,
          state: stateStr,
          memoryLayer: (layerStr as MemoryLayer) ?? null,
          assertionGraph: graphUri,
          events: [...eventMap.values()],
        };
      },
    };
  }

}

function swmSenderStateKey(contextGraphId: string, subGraphName: string | undefined, senderAgentAddress: string): string {
  return `${contextGraphId}\0${subGraphName ?? ''}\0${senderAgentAddress.toLowerCase()}`;
}

function swmReceiverStateKey(
  contextGraphId: string,
  subGraphName: string | undefined,
  senderAgentAddress: string,
  epochId: string,
): string {
  return `${swmSenderStateKey(contextGraphId, subGraphName, senderAgentAddress)}\0${epochId}`;
}

function serializeSwmSenderSendState(state: LocalSwmSenderKeySendState): Record<string, unknown> {
  return {
    contextGraphId: state.contextGraphId,
    subGraphName: state.subGraphName,
    senderAgentAddress: state.senderAgentAddress,
    epochId: state.epochId,
    membershipHash: state.membershipHash,
    chainKey: encodeWorkspaceEncryptionKey(state.chainKey),
    nextMessageIndex: state.nextMessageIndex,
    senderSigningSecretKey: encodeWorkspaceEncryptionKey(state.senderSigningSecretKey),
    senderSigningPublicKey: encodeWorkspaceEncryptionKey(state.senderSigningPublicKey),
    createdAtMs: state.createdAtMs,
  };
}

function serializeSwmSenderReceiveState(state: LocalSwmSenderKeyReceiveState): Record<string, unknown> {
  return {
    contextGraphId: state.contextGraphId,
    subGraphName: state.subGraphName,
    senderAgentAddress: state.senderAgentAddress,
    epochId: state.epochId,
    membershipHash: state.membershipHash,
    chainKey: encodeWorkspaceEncryptionKey(state.chainKey),
    nextMessageIndex: state.nextMessageIndex,
    senderSigningPublicKey: encodeWorkspaceEncryptionKey(state.senderSigningPublicKey),
    createdAtMs: state.createdAtMs,
    skippedChainKeys: [...state.skippedChainKeys.entries()].map(([index, chainKey]) => ({
      index,
      chainKey: encodeWorkspaceEncryptionKey(chainKey),
    })),
  };
}

function deserializeSwmSenderSendState(entry: Record<string, unknown>): LocalSwmSenderKeySendState {
  return {
    contextGraphId: requiredString(entry.contextGraphId, 'contextGraphId'),
    subGraphName: optionalString(entry.subGraphName),
    senderAgentAddress: ethers.getAddress(requiredString(entry.senderAgentAddress, 'senderAgentAddress')),
    epochId: requiredString(entry.epochId, 'epochId'),
    membershipHash: requiredString(entry.membershipHash, 'membershipHash'),
    chainKey: decodeWorkspaceEncryptionKey(requiredString(entry.chainKey, 'chainKey')),
    nextMessageIndex: requiredNumber(entry.nextMessageIndex, 'nextMessageIndex'),
    senderSigningSecretKey: decodeWorkspaceEncryptionKey(requiredString(entry.senderSigningSecretKey, 'senderSigningSecretKey')),
    senderSigningPublicKey: decodeWorkspaceEncryptionKey(requiredString(entry.senderSigningPublicKey, 'senderSigningPublicKey')),
    createdAtMs: requiredNumber(entry.createdAtMs, 'createdAtMs'),
  };
}

function deserializeSwmSenderReceiveState(entry: Record<string, unknown>): LocalSwmSenderKeyReceiveState {
  const skippedChainKeys = new Map<number, Uint8Array>();
  const skipped = Array.isArray(entry.skippedChainKeys) ? entry.skippedChainKeys : [];
  for (const raw of skipped) {
    const item = raw as Record<string, unknown>;
    skippedChainKeys.set(
      requiredNumber(item.index, 'skippedChainKeys.index'),
      decodeWorkspaceEncryptionKey(requiredString(item.chainKey, 'skippedChainKeys.chainKey')),
    );
  }
  return {
    contextGraphId: requiredString(entry.contextGraphId, 'contextGraphId'),
    subGraphName: optionalString(entry.subGraphName),
    senderAgentAddress: ethers.getAddress(requiredString(entry.senderAgentAddress, 'senderAgentAddress')),
    epochId: requiredString(entry.epochId, 'epochId'),
    membershipHash: requiredString(entry.membershipHash, 'membershipHash'),
    chainKey: decodeWorkspaceEncryptionKey(requiredString(entry.chainKey, 'chainKey')),
    nextMessageIndex: requiredNumber(entry.nextMessageIndex, 'nextMessageIndex'),
    senderSigningPublicKey: decodeWorkspaceEncryptionKey(requiredString(entry.senderSigningPublicKey, 'senderSigningPublicKey')),
    createdAtMs: requiredNumber(entry.createdAtMs, 'createdAtMs'),
    skippedChainKeys,
  };
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Invalid Sender Key state: ${name} is required`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function requiredNumber(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`Invalid Sender Key state: ${name} must be a non-negative safe integer`);
  }
  return value as number;
}
