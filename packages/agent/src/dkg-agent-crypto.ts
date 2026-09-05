// SPDX-License-Identifier: Apache-2.0

/**
 * Workspace-encryption / sender-key subsystem extracted from dkg-agent.ts as
 * a mixin holder: recipient/gate resolution, on-chain access-policy reads,
 * SWM sender-key epoch creation + distribution, pending-package queueing,
 * encrypt/decrypt of workspace payloads, and sender-key state persistence.
 * 1:1 move; methods take `this: DKGAgent` so cross-calls resolve against the
 * composed class.
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  PROTOCOL_SWM_SENDER_KEY,
  encodeGossipEnvelope,
  computeGossipSigningPayload,
  GOSSIP_ENVELOPE_VERSION,
  GOSSIP_TYPE_WORKSPACE_PUBLISH,
  createOperationContext,
  logKaLifecycleEvent,
  WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519,
  WORKSPACE_RECIPIENT_ENCRYPTION_KEY_PURPOSE,
  decodeWorkspaceEncryptionKey,
  SWM_SENDER_KEY_PACKAGE_ACK_TYPE,
  SWM_SENDER_KEY_PACKAGE_ACK_RETRYABLE_REASON_CODES,
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
  type OperationContext,
  type SwmSenderKeyMessageMsg,
  type SwmSenderKeyPackageAckReasonCode,
  type SwmSenderKeyPackageMsg,
  type WorkspaceRecipientEncryptionKey,
} from '@origintrail-official/dkg-core';

import { createRpcTimeoutError, type ChainAdapter } from '@origintrail-official/dkg-chain';
import {
  resolveWorkspaceAgentRecipients,
  resolveWorkspaceAgentRecipientKeys,
  type WorkspaceAgentRecipient,
  type WorkspaceAgentRecipientResolution,
  type WorkspaceAgentRecipientResolverInput,
  type WorkspaceSenderKeyEncryptInput,
} from '@origintrail-official/dkg-publisher';
import { ethers } from 'ethers';

import {
  resolveActivePublicContextGraphChainProof as resolveStrictActivePublicChainProof,
  type ActivePublicContextGraphChainProof,
} from './active-public-context-graph-chain-proof.js';
import {
  createContextGraphAuthorityError,
  resolveContextGraphAgentGateAuthorityDecision,
  type ContextGraphAgentGateAuthority,
} from './context-graph-agent-gate-authority.js';
import {
  resolveLiveOnChainAccessPolicyState as resolveLiveAccessPolicyState,
  type LiveOnChainAccessPolicyState,
} from './context-graph-access-policy-state.js';

import { FANOUT_RESPONSE_REJECTED, FANOUT_RESPONSE_RETRYABLE } from './swm/substrate-fanout.js';

import { resolveAssetUalFromKaIdentity } from './ka-identity.js';

import { type AgentKeyRecord } from './agent-keystore.js';

// rc.9 PR-10: JoinApprovalRetryQueue removed — substrate outbox
// (durable, SQLite-backed) replaces it. We keep a minimal local
// type alias so listPendingJoinApprovalRetries() retains its old
// public shape while it stubs out to []. PR-12 rebuilds the operator
// diagnostic surface on top of the substrate outbox and will return
// real entries with substrate-shaped metadata.
type JoinApprovalRetryEntry = {
  contextGraphId: string;
  agentAddress: string;
  attempts: number;
  firstFailureAt: number;
  nextAttemptAt: number;
  lastError: string;
};

import {
  TIMEOUT_SENTINEL,
  CHAIN_POLICY_READ_TIMEOUT_MS,
  SWM_SENDER_KEY_PENDING_DRAIN_LOG_CTX,
} from './dkg-agent-constants.js';

import {
  isBoundedOperationTimeoutError,
  runBoundedOperation,
} from './bounded-operation.js';

import {
  StaleSenderKeyTargetError,
  SwmSenderKeySetupRejectionError,
  type LocalSwmSenderKeySendState,
  type LocalSwmSenderKeyReceiveState,
  type PendingSenderKeyEntry,
} from './dkg-agent-types.js';

import {
  swmSenderStateKey,
  swmReceiverStateKey,
  serializeSwmSenderSendState,
  serializeSwmSenderReceiveState,
  serializePendingSenderKeyEntry,
  deserializeSwmSenderSendState,
  deserializeSwmSenderReceiveState,
  deserializePendingSenderKeyEntry,
} from './dkg-agent-swm-state.js';
import { DKGAgentBase } from './dkg-agent-base.js';
import type { DKGAgent } from './dkg-agent.js';
import type { ContextGraphMetaRecord } from './context-graph-meta-projection.js';
import { localContextGraphIdMatchesCommittedNameHash } from './context-graph-binding-state.js';

const KA_LIFECYCLE_ASSET_UAL_RESOLVE_TIMEOUT_MS = 50;

function delegationIsCurrentlyActive(expiresAtValues: readonly string[], nowMs: number): boolean {
  if (expiresAtValues.length === 0) return true;
  return expiresAtValues.some((value) => {
    const expiresAt = Number(value);
    return !Number.isFinite(expiresAt) || expiresAt <= 0 || expiresAt >= nowMs;
  });
}

function collectProjectedDelegatees(
  meta: ContextGraphMetaRecord,
  field: 'allowedPeers' | 'allowedKeys',
  normalizeValue: (value: string) => string,
): Map<string, string[]> {
  const members = new Set(
    [...meta.allowedAgents, ...meta.participantAgents].map((agent) => agent.toLowerCase()),
  );
  const revoked = new Set(meta.revokedAgents.map((agent) => agent.toLowerCase()));
  const out = new Map<string, string[]>();
  const nowMs = Date.now();

  for (const delegation of meta.delegations) {
    if (!delegationIsCurrentlyActive(delegation.expiresAtValues, nowMs)) continue;
    for (const rawAgent of delegation.agents) {
      const agent = rawAgent.toLowerCase();
      if (!agent || !members.has(agent) || revoked.has(agent)) continue;
      const values = out.get(agent) ?? [];
      for (const rawValue of delegation[field]) {
        const value = normalizeValue(rawValue);
        if (value && !values.includes(value)) values.push(value);
      }
      if (values.length > 0) out.set(agent, values);
    }
  }
  return out;
}

type ContextGraphSlotBindingOutcome =
  | { kind: 'match' }
  | { kind: 'mismatch' }
  | { kind: 'unprovable' }
  | { kind: 'transportFailure'; error: unknown };

export type ContextGraphSlotBindingMode =
  | 'legacy-policy'
  | 'chain-attested-repair'
  | 'retryable-durable';

type PublicPolicySlotBindingMode = Exclude<
  ContextGraphSlotBindingMode,
  'retryable-durable'
>;

function mapContextGraphSlotBindingOutcome(
  outcome: ContextGraphSlotBindingOutcome,
  mode: ContextGraphSlotBindingMode,
): boolean {
  if (outcome.kind === 'match') return true;
  if (outcome.kind === 'unprovable') return mode === 'legacy-policy';
  if (outcome.kind === 'transportFailure' && mode !== 'legacy-policy') {
    throw outcome.error;
  }
  return false;
}

async function evaluateContextGraphSlotBinding(
  chain: ChainAdapter,
  contextGraphId: string,
  onChainId: string,
  opCtx: OperationContext | undefined,
  signal: AbortSignal | undefined,
  allowNumericSelfAddress: boolean,
  isWireIdKeyedSubscription: (localId: string) => boolean,
  warn: (ctx: OperationContext, message: string) => void,
  raceRead: <T>(
    start: () => Promise<T>,
    label: string,
    readSignal?: AbortSignal,
  ) => Promise<T | typeof TIMEOUT_SENTINEL>,
): Promise<ContextGraphSlotBindingOutcome> {
  let numericId: bigint;
  try {
    numericId = BigInt(onChainId);
  } catch {
    return { kind: 'unprovable' };
  }
  if (numericId <= 0n) return { kind: 'unprovable' };

  const trimmed = contextGraphId.trim();
  if (
    allowNumericSelfAddress
    && /^\d+$/.test(trimmed)
    && trimmed === numericId.toString()
  ) {
    return { kind: 'match' };
  }
  const getNameHash = chain.getContextGraphNameHash;
  if (typeof getNameHash !== 'function') return { kind: 'unprovable' };

  let onChainHash: string | null | typeof TIMEOUT_SENTINEL;
  try {
    onChainHash = await raceRead(
      () => signal
        ? getNameHash.call(chain, numericId, { signal })
        : getNameHash.call(chain, numericId),
      `getContextGraphNameHash(${onChainId})`,
      signal,
    );
  } catch (error) {
    warn(
      opCtx ?? createOperationContext('share'),
      `isContextGraphPublicOnChain(${contextGraphId}): getContextGraphNameHash(${onChainId}) failed — `
      + 'cannot verify local-mapping identity, treating CG as NOT public (fail-closed): '
      + `${error instanceof Error ? error.message : String(error)}`,
    );
    return { kind: 'transportFailure', error };
  }
  if (onChainHash === TIMEOUT_SENTINEL) {
    warn(
      opCtx ?? createOperationContext('share'),
      `isContextGraphPublicOnChain(${contextGraphId}): getContextGraphNameHash(${onChainId}) timed out after `
      + `${CHAIN_POLICY_READ_TIMEOUT_MS}ms — cannot verify local-mapping identity, `
      + 'treating CG as NOT public (fail-closed)',
    );
    return {
      kind: 'transportFailure',
      error: createRpcTimeoutError(
        `getContextGraphNameHash(${onChainId}) timed out after ${CHAIN_POLICY_READ_TIMEOUT_MS}ms`,
      ),
    };
  }
  if (!onChainHash) {
    warn(
      opCtx ?? createOperationContext('share'),
      `isContextGraphPublicOnChain(${contextGraphId}): locally-mapped on-chain id ${onChainId} has NO `
      + 'committed name-hash — cannot affirmatively bind identity (slot reused on a fresh chain?). '
      + 'Treating CG as NOT public (fail-closed).',
    );
    return { kind: 'mismatch' };
  }
  if (localContextGraphIdMatchesCommittedNameHash(
    trimmed,
    onChainHash,
    isWireIdKeyedSubscription,
  )) return { kind: 'match' };

  warn(
    opCtx ?? createOperationContext('share'),
    `isContextGraphPublicOnChain(${contextGraphId}): locally-mapped on-chain id ${onChainId} commits `
    + `name-hash ${onChainHash.toLowerCase()} that does not match this CG's local identity — `
    + 'local mapping is STALE (slot reused on a fresh chain?). Treating CG as NOT public (fail-closed).',
  );
  return { kind: 'mismatch' };
}

export class WorkspaceCryptoMethods extends DKGAgentBase {
  getWorkspaceGossipSigningAgent(this: DKGAgent): (AgentKeyRecord & { privateKey: string }) | null {
    const defaultAddress = this.defaultAgentAddress?.toLowerCase();
    let fallback: (AgentKeyRecord & { privateKey: string }) | null = null;
    for (const record of this.localAgents.values()) {
      if (!record.privateKey) continue;
      // GH #787 — a node-level key record can carry a privateKey but no (or an
      // invalid) agentAddress (an operational identity, not an agent). Such a
      // record is NOT a usable gossip signer: encodeWorkspaceGossipMessage emits
      // `agentAddress` into the envelope and the downstream host-mode authority
      // check rejects a missing/invalid one. Skip it entirely — that both avoids
      // the original `toLowerCase()`-of-undefined crash (HTTP 500 on SWM write)
      // AND prevents it becoming a fallback that emits an unverifiable envelope.
      if (!record.agentAddress || !ethers.isAddress(record.agentAddress)) continue;
      const signingRecord = { ...record, privateKey: record.privateKey };
      if (defaultAddress && record.agentAddress.toLowerCase() === defaultAddress) {
        return signingRecord;
      }
      fallback ??= signingRecord;
    }
    return fallback;
  }

  /**
   * Codex review on PR #916 (`a15f25d` round 3) — return the local
   * agent record that matches `targetAddress`, or null if none of
   * `localAgents` is registered for that address (or has no
   * private key). Distinct from {@link getWorkspaceGossipSigningAgent}
   * which always picks the default/first available agent.
   *
   * Used by the beacon-registration path to honour
   * `createContextGraph(opts.callerAgentAddress)` on multi-agent
   * nodes: if the caller specified the curator address explicitly,
   * the beacon must be signed by THAT agent so the wireId-pinned
   * curator EOA matches whatever signer the host-catchup path
   * later recovers (which uses the same lookup tied to the
   * `beaconRegistry` entry for this CG).
   */
  getWorkspaceSigningAgentForAddress(this: DKGAgent,
    targetAddress: string | undefined,
  ): (AgentKeyRecord & { privateKey: string }) | null {
    if (!targetAddress) return null;
    const target = targetAddress.toLowerCase();
    for (const record of this.localAgents.values()) {
      if (!record.privateKey) continue;
      if (record.agentAddress.toLowerCase() === target) {
        return { ...record, privateKey: record.privateKey };
      }
    }
    return null;
  }

  protected async resolveContextGraphAgentGateAuthority(
    this: DKGAgent,
    contextGraphId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<ContextGraphAgentGateAuthority> {
    return resolveContextGraphAgentGateAuthorityDecision({
      contextGraphId,
      getRegisteredAuthority: () => this.resolveRegisteredContextGraphAuthority(
        contextGraphId,
        { signal: options.signal },
      ),
      resolveRfc64PrivateRoster: () => this.resolveRfc64PrivateReadRosterV1(contextGraphId),
      getLegacyMeta: () => this.getCgMeta(contextGraphId, { signal: options.signal }),
      getSubscriptionAgents: () => (
        this.subscribedContextGraphs.get(contextGraphId)?.participantAgents ?? []
      ),
    });
  }

  /** Compatibility projection for admission callers that only need fail-closed gate values. */
  async getContextGraphAgentGateAddresses(
    this: DKGAgent,
    contextGraphId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<string[] | null> {
    const authority = await this.resolveContextGraphAgentGateAuthority(contextGraphId, options);
    if (authority.kind === 'ungated') return null;
    if (authority.kind === 'available') return authority.agentAddresses;
    return [];
  }

  /**
   * R9 (SECURITY) — FRESH, `_meta`-only member-recovery gate.
   *
   * Resolves `allowedAgents ∪ participantAgents` minus `revokedAgents` from the
   * CG `_meta` projection (store-backed, write-invalidated), with the
   * network-influenced `subscribedContextGraphs` subscription cache
   * DELIBERATELY OMITTED — that cache is poisonable, and folding it in is
   * exactly what `member-recovery-auth.ts` forbids.
   *
   * Unlike {@link getContextGraphAgentGateAddresses} (which also feeds normal
   * sync admission and may fold in the subscription cache only for graphs that
   * are not registered on-chain), this read is used ONLY for `request.recovery`
   * and is passed straight to
   * `isMemberRecoveryAuthorized`, which hard-denies on null/empty. Returns
   * `null` when the CG has no `_meta` agent gate at all (⇒ hard-deny).
   */
  async getMemberRecoveryGate(
    this: DKGAgent,
    contextGraphId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<string[] | null> {
    const registeredAuthority = await this.resolveRegisteredContextGraphAuthority(
      contextGraphId,
      { signal: options.signal },
    );
    if (registeredAuthority.kind === 'private') return registeredAuthority.participantAgents;
    if (registeredAuthority.kind !== 'unregistered') return null;

    const seen = new Set<string>();
    const agents: string[] = [];
    const meta = await this.getCgMeta(contextGraphId, { signal: options.signal });
    if (meta.allowedAgents.length === 0 && meta.participantAgents.length === 0) {
      return null; // no _meta agent gate ⇒ hard-deny at the recovery gate
    }
    const revoked = new Set(meta.revokedAgents.map((addr) => addr.toLowerCase()));
    const add = (value: string | undefined) => {
      if (!value || !ethers.isAddress(value)) return;
      const checksum = ethers.getAddress(value);
      const key = checksum.toLowerCase();
      if (revoked.has(key)) return;
      if (seen.has(key)) return;
      seen.add(key);
      agents.push(checksum);
    };
    for (const agent of meta.allowedAgents) add(agent);
    for (const agent of meta.participantAgents) add(agent);
    return agents;
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
  async getContextGraphAllowedDelegateePeers(
    this: DKGAgent,
    contextGraphId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<Map<string, string[]>> {
    const meta = await this.getCgMeta(contextGraphId, { signal: options.signal });
    return collectProjectedDelegatees(meta, 'allowedPeers', (value) => value);
  }

  /**
   * Same as `getContextGraphAllowedDelegateePeers` but for ethereum
   * operational-key addresses authorised via a signed delegation.
   * Returns Map<agentLower, opKeyLower[]>. Both keys and values are
   * lowercased so callers can compare against `recoveredAddress.toLowerCase()`.
   * Expired rows are filtered out — see the peer-lookup helper for the
   * rationale (PR #448 review round 4).
   */
  async getContextGraphAllowedDelegateeKeys(
    this: DKGAgent,
    contextGraphId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<Map<string, string[]>> {
    const meta = await this.getCgMeta(contextGraphId, { signal: options.signal });
    return collectProjectedDelegatees(meta, 'allowedKeys', (value) => value.toLowerCase());
  }

  hasLocalAgentInGate(this: DKGAgent, agentGateAddresses: readonly string[]): boolean {
    const allowedSet = new Set(agentGateAddresses.map((agent) => agent.toLowerCase()));
    for (const record of this.localAgents.values()) {
      if (allowedSet.has(record.agentAddress.toLowerCase())) {
        return true;
      }
    }
    return false;
  }

  /**
   * Materialise every workspace recipient private key this node holds
   * across all local agents.
   *
   * `activeOnly` selects between two distinct call-site contracts:
   *
   *   - `activeOnly: false` (default) — include retired/revoked keys.
   *     This is the HISTORICAL-DECRYPTION shape: the envelope sitting
   *     in the SWM gossip queue may have been wrapped to a key we
   *     have since rotated away from, and we still want to read it.
   *     Wired into `SharedMemoryHandler` via the
   *     `workspaceRecipientPrivateKeys` getter.
   *
   *   - `activeOnly: true` — drop entries with `revokedAt` set. This
   *     is the FRESH-TRAFFIC bootstrap shape (e.g.
   *     `acceptSwmSenderKeyPackage`): once a key is revoked, no peer
   *     may set up a new sender-key epoch against it, otherwise a
   *     stale or malicious sender could pin all future traffic on a
   *     retired key indefinitely. Codex review of PR #540 / commit
   *     24aa4855.
   */
  getLocalWorkspaceRecipientPrivateKeys(this: DKGAgent,
    opts: { activeOnly?: boolean } = {},
  ): WorkspaceRecipientEncryptionKey[] {
    const activeOnly = opts.activeOnly === true;
    const keys: WorkspaceRecipientEncryptionKey[] = [];
    for (const record of this.localAgents.values()) {
      for (const entry of record.workspaceEncryptionKeys) {
        if (
          entry.encryptionKeyAlgorithm !== WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519 ||
          !entry.publicEncryptionKey ||
          !entry.privateEncryptionKey
        ) {
          continue;
        }
        if (activeOnly && entry.revokedAt) {
          continue;
        }
        const publicKeyBytes = decodeWorkspaceEncryptionKey(entry.publicEncryptionKey);
        const privateKeyBytes = decodeWorkspaceEncryptionKey(entry.privateEncryptionKey);
        const recipientId = `did:dkg:agent:${ethers.getAddress(record.agentAddress)}`;
        keys.push({
          purpose: WORKSPACE_RECIPIENT_ENCRYPTION_KEY_PURPOSE,
          recipientId,
          recipientKeyId: entry.encryptionKeyId,
          encryptionKeyAlgorithm: WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519,
          publicKeyBytes,
          privateKeyBytes,
        });
      }
    }
    return keys;
  }

  /**
   * #884 review — bound a single chain policy/liveness read on the hot path.
   * Mirrors the `withTimeout` race in {@link getContextGraphOnChainPolicy}:
   * resolves to {@link TIMEOUT_SENTINEL} if the underlying RPC HANGS past
   * {@link CHAIN_POLICY_READ_TIMEOUT_MS}, so callers fail closed instead of
   * blocking forever. The timer is `unref`'d so a dead RPC never keeps the
   * process alive.
   */
  private async raceChainPolicyRead<T>(
    start: () => Promise<T>,
    label: string,
    signal?: AbortSignal,
  ): Promise<T | typeof TIMEOUT_SENTINEL> {
    try {
      return await runBoundedOperation(start, {
        label,
        timeoutMs: CHAIN_POLICY_READ_TIMEOUT_MS,
        signal,
      });
    } catch (error) {
      if (isBoundedOperationTimeoutError(error)) return TIMEOUT_SENTINEL;
      throw error;
    }
  }

  /**
   * #884 review — LIVE-gated on-chain access-policy read for a CANDIDATE
   * numeric on-chain id. The single trust anchor shared by every "downgrade
   * to a less-protected path" decision (SWM-plaintext gate + publish-inline
   * curated probe), so both branches can never diverge.
   *
   * Returns an available access-policy enum (`0` = public, `1` =
   * private/curated) ONLY after
   * {@link ChainAdapter.isContextGraphActiveOnChain} proves the slot is
   * actually live on-chain; otherwise preserves a typed unavailable reason.
   * This is essential because `getContextGraphAccessPolicy` returns
   * Solidity's default `0` (= public) for UNKNOWN ids, and the local
   * access-policy cache can be seeded by best-effort probes of arbitrary ids —
   * so neither is trustworthy without a liveness proof. Both the liveness and
   * the policy reads are bounded by {@link raceChainPolicyRead} so a hung RPC
   * fails closed instead of blocking the hot path. A genuine RPC
   * rejection propagates to the caller (which logs + fails closed in its own
   * idiom). The canonical reason distinguishes retryable bounded timeouts
   * from terminal unknown policy; diagnostics retain the timed-out read name.
   */
  protected async resolveLiveOnChainAccessPolicyState(this: DKGAgent,
    onChainId: string,
    opCtx?: OperationContext,
    options: { signal?: AbortSignal } = {},
  ): Promise<LiveOnChainAccessPolicyState> {
    const readLiveness = this.chain.isContextGraphActiveOnChain;
    const readAccessPolicy = this.chain.getContextGraphAccessPolicy;
    return resolveLiveAccessPolicyState(
      {
        isContextGraphActiveOnChain: typeof readLiveness === 'function'
          ? (numericId, signal) => signal
            ? readLiveness.call(this.chain, numericId, { signal })
            : readLiveness.call(this.chain, numericId)
          : undefined,
        getContextGraphAccessPolicy: typeof readAccessPolicy === 'function'
          ? (numericId, signal) => signal
            ? readAccessPolicy.call(this.chain, numericId, { signal })
            : readAccessPolicy.call(this.chain, numericId)
          : undefined,
        runBoundedRead: async (start, label, signal) => {
          const value = await this.raceChainPolicyRead(start, label, signal);
          return value === TIMEOUT_SENTINEL
            ? { kind: 'timeout' }
            : { kind: 'value', value };
        },
        claimMissingLivenessWarning: () => {
          if (this.warnedMissingCgLivenessProbe) return false;
          this.warnedMissingCgLivenessProbe = true;
          return true;
        },
        warn: (ctx, message) => this.log.warn(ctx, message),
        cacheAccessPolicy: (id, policy) => this.onChainAccessPolicyCache.set(id, policy),
      },
      onChainId,
      opCtx,
      options,
    );
  }

  /** Compatibility projection for fail-closed policy consumers. */
  async readLiveOnChainAccessPolicy(this: DKGAgent,
    onChainId: string,
    opCtx?: OperationContext,
    options: { signal?: AbortSignal } = {},
  ): Promise<0 | 1 | null> {
    const state = await this.resolveLiveOnChainAccessPolicyState(onChainId, opCtx, options);
    return state.kind === 'available' ? state.accessPolicy : null;
  }

  async resolveActivePublicContextGraphChainProof(
    this: DKGAgent,
    contextGraphId: string,
    operationContext: OperationContext,
  ): Promise<ActivePublicContextGraphChainProof> {
    return resolveStrictActivePublicChainProof(
      (id, resolverOperationContext, options) => this.resolveOnChainAccessPolicyState(
        id,
        resolverOperationContext,
        options,
      ),
      contextGraphId,
      operationContext,
    );
  }

  /**
   * True iff `contextGraphId` is DEFINITIVELY public per its on-chain
   * access policy (policy enum `0`). Gates SWM encryption: an on-chain
   * public CG is public-readable, so its shared memory must be plaintext
   * even when it carries a `DKG_ALLOWED_AGENT` list — on a public CG that
   * list governs *publish authority* (`publishPolicy`), not *read access*.
   *
   * Encrypting a public CG's SWM would (a) bootstrap a sender-key
   * handshake that non-gated recipients correctly reject ("not DKG-agent
   * gated"), blocking promote/publish, and (b) diverge from the
   * publisher's plaintext-inline path. `isPrivateContextGraph` cannot
   * make this call on its own because its allowlist-implies-private
   * heuristic (for invite-only CGs that carry no `accessPolicy` triple)
   * also fires for public-with-publish-allowlist CGs — only the on-chain
   * policy distinguishes the two.
   *
   * A "public ⇒ plaintext" decision is gated on a LIVE on-chain proof
   * (`isContextGraphActiveOnChain`), never on local state alone: the chain
   * returns access-policy `0` (= public) for UNKNOWN ids, and every local
   * signal (the access-policy cache — also seeded by best-effort probes of
   * arbitrary ids, a rehydrated subscription `onChainId`, a persisted
   * `...OnChainId` triple, or a local `accessPolicy` literal) can be stale or
   * probe-poisoned after a devnet reset / partial registration.
   *
   * When the candidate id is resolved from a LOCAL mapping
   * (`getContextGraphOnChainId`), the live slot is additionally IDENTITY-BOUND
   * to this CG via its on-chain committed name-hash (#884 review): the mapping
   * is persisted local state that survives a devnet reset, so it can point at
   * a numeric slot now occupied by an UNRELATED CG on a fresh chain — and a
   * liveness probe alone only proves *some* CG is live there. The on-chain
   * name-hash is `keccak256(cleartextId)` (deterministic, write-once at
   * registration), so a reused slot commits a DIFFERENT name; an affirmative
   * mismatch fails closed. (When no name-hash is committed on either side we
   * can't disprove identity, so we don't add a new failure there.)
   *
   * Fail-closed: returns `false` for private (`1`), unknown/unregistered/
   * non-live, an identity mismatch, a missing chain getter, an RPC
   * stall/timeout, or any lookup error, so curated / invite-only /
   * pre-registration CGs keep their encrypted SWM. The optional `opCtx` tags
   * the fail-closed diagnostic with the caller's subsystem (share vs publish).
   */
  async isContextGraphPublicOnChain(this: DKGAgent,
    contextGraphId: string,
    opCtx?: OperationContext,
    options: { slotBindingMode?: PublicPolicySlotBindingMode } = {},
  ): Promise<boolean> {
    try {
      // DEFINITIVELY public iff the live-proven on-chain policy is `0`. Every
      // other tri-state value — `1` (private), `'unregistered'` (no resolvable
      // slot), `'unknown'` (resolvable but not live / stale mapping / missing
      // probe / timeout) — is NOT a proof of public, so it fails closed here
      // (the SWM-gossip caller then keeps the encrypted path). The shared
      // resolver collapses unknown↔not-public ONLY for this boolean predicate;
      // the publish-inline probe consumes the tri-state directly so it can
      // REFUSE (rather than choose plaintext) on a genuine UNKNOWN.
      return (await this.resolveOnChainAccessPolicyState(
        contextGraphId,
        opCtx,
        options,
      )) === 0;
    } catch (err) {
      // Fail closed (curated/encrypted) on any lookup failure, but not
      // silently — surface WHY the public override was skipped so operators
      // get a diagnostic instead of a silent regression. Tag with the CALLER's
      // operation context (share/promote vs publish-inline probe).
      this.log.warn(
        opCtx ?? createOperationContext('share'),
        `isContextGraphPublicOnChain(${contextGraphId}) lookup failed — treating CG as NOT public ` +
        `(fail-closed: SWM stays encrypted): ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  /**
   * #884 review (🔴 GZh-c) — the SINGLE tri-state on-chain access-policy
   * resolver shared by the SWM-plaintext gate ({@link isContextGraphPublicOnChain})
   * and the publish-inline curated probe (`probeIsCurated`). Distinguishing
   * "definitively not public" from "could not prove" is security-relevant:
   * the boolean gate treats both as fail-closed (encrypt), but the publish
   * path must REFUSE on a genuine UNKNOWN instead of silently defaulting a
   * possibly-private CG onto the plaintext-inline path. Returning a tri-state
   * (rather than a boolean) is what lets the publish caller fail closed by
   * THROWING while still letting a genuinely pure-local CG keep its plaintext
   * default.
   *
   * Resolution mirrors the addressing rules: a local id maps through
   * {@link getContextGraphOnChainId} (authoritative for a registered CG whose
   * user-chosen id is itself numeric), else a bare decimal is treated as a raw
   * on-chain slot the caller addressed directly. A locally-mapped candidate is
   * IDENTITY-BOUND to its on-chain committed name-hash before trust (a persisted
   * mapping survives a devnet reset and can point at a reused slot); an
   * affirmative mismatch downgrades to `'unknown'` (fail closed), never to a
   * clean `'unregistered'`.
   *
   * Returns:
   *   - `0` / `1`        — live-proven public / private on-chain policy.
   *   - `'unregistered'` — no resolvable on-chain slot (a pure-local CG); the
   *                        publish path keeps its plaintext-inline default.
   *   - `'unknown'`      — resolvable but UNPROVABLE (slot not live, stale local
   *                        mapping, no liveness probe, or a bounded-read
   *                        timeout) → callers fail closed.
   * A genuine RPC REJECTION propagates (NOT swallowed) so each caller applies
   * its own fail-closed idiom (the boolean gate logs+returns `false`; the
   * publish probe logs+returns `null` → "access-policy is unknown" throw).
   */
  async resolveOnChainAccessPolicyState(this: DKGAgent,
    contextGraphId: string,
    opCtx?: OperationContext,
    options: { slotBindingMode?: PublicPolicySlotBindingMode } = {},
  ): Promise<0 | 1 | 'unregistered' | 'unknown'> {
    const trimmed = contextGraphId.trim();

    // Resolve a CANDIDATE on-chain id. Local-id resolution is authoritative
    // for ADDRESSING: getContextGraphOnChainId maps any locally-known
    // context-graph id — including a registered CG whose user-chosen id is
    // numeric (a CG "named 42") — to THAT graph's persisted on-chain id.
    let onChainId: string | null = null;
    let resolvedFromLocalCg = false;
    if (typeof this.getContextGraphOnChainId === 'function') {
      onChainId = await this.getContextGraphOnChainId(contextGraphId);
      if (onChainId) resolvedFromLocalCg = true;
    }
    if (!onChainId && /^\d+$/.test(trimmed)) {
      // A bare decimal that did NOT resolve to a local mapping is AMBIGUOUS
      // (#884 review 🔴 GZumY). It is a raw on-chain slot the caller addressed
      // directly (`share('42')`) ONLY when there is no local context graph by
      // that id. A local CG whose canonical id is itself numeric (e.g.
      // `createContextGraph({ id: '42' })`) that simply isn't registered
      // on-chain yet must stay 'unregistered' (→ plaintext-inline default), not
      // be misclassified as a raw slot. Only a SUCCESSFUL negative existence
      // check enables the raw-slot branch.
      if (typeof this.contextGraphExists === 'function') {
        let localCgExists: boolean;
        try {
          localCgExists = await this.contextGraphExists(trimmed);
        } catch {
          // #884 review (🔴 GZ8L5): a flaked existence check is NOT a license
          // to treat "42" as a raw on-chain slot — slot 42 could be a live
          // public CG on the current chain and we'd force the WRONG graph onto
          // plaintext. Fail closed (UNKNOWN) instead of guessing.
          return 'unknown';
        }
        if (!localCgExists) onChainId = trimmed;
        // else: a local CG named "42" exists but has no on-chain mapping → it
        // is a pure-local (unregistered) CG; fall through to 'unregistered'.
      } else {
        // No local-existence oracle available (minimal adapters / harnesses):
        // preserve the bare-numeric raw-slot addressing behavior.
        onChainId = trimmed;
      }
    }
    // No resolvable on-chain slot at all — a pure-local CG (including a
    // numeric-named local CG not yet registered). This is NOT "unknown": there
    // is nothing on-chain to fail closed against, so the publish path keeps its
    // long-standing plaintext-inline default for local-only workspaces (and the
    // boolean gate reads it as not-public).
    if (!onChainId) return 'unregistered';

    // IDENTITY BINDING (#884 review GZEqF). A candidate resolved from the
    // LOCAL mapping must be proven to still BE this CG on the current chain
    // before we trust its policy — `getContextGraphOnChainId` is persisted
    // local state that survives a devnet reset, so it can point at a slot now
    // occupied by an unrelated CG. (The bare-numeric path is the caller
    // explicitly addressing a raw on-chain slot, so there is no local identity
    // to re-bind.) An affirmative name-hash mismatch is a STALE mapping → treat
    // as 'unknown' (fail closed), not 'unregistered' (which would re-enable the
    // plaintext default for a graph we just proved we can't trust).
    if (resolvedFromLocalCg && !(await this.localCgMatchesOnChainSlot(
      contextGraphId,
      onChainId,
      opCtx,
      { bindingMode: options.slotBindingMode },
    ))) {
      return 'unknown';
    }

    // LIVE-ON-CHAIN PROOF GATE (#884 review). A trust decision must be backed
    // by the chain, never by local state alone — see readLiveOnChainAccessPolicy
    // for the full rationale (default-zero access policy for unknown ids,
    // probe-poisoned cache, stale rehydrated subscriptions / persisted
    // mappings). It returns the policy ONLY once the slot is proven live, else
    // null (UNKNOWN). A genuine RPC rejection propagates to the caller.
    const policy = await this.readLiveOnChainAccessPolicy(onChainId, opCtx);
    return policy === 0 || policy === 1 ? policy : 'unknown';
  }

  /**
   * #884 review (GZEqF) — additive identity check binding a LOCALLY-resolved
   * on-chain id back to `contextGraphId` before a security downgrade.
   *
   * `getContextGraphOnChainId` reads persisted local state that survives a
   * devnet reset, so the mapping `localId → onChainId` can point at a numeric
   * slot now occupied by an UNRELATED CG on a fresh chain;
   * `isContextGraphActiveOnChain` only proves *some* CG is live at that slot.
   * The on-chain committed name-hash is the reset-proof identity anchor,
   * deterministic and write-once at registration. A locally-resolved id maps to
   * it two legitimate ways (#884 review 🔴 GZumc + 🔴 GaJf_), so an
   * AFFIRMATIVE match against EITHER clears the gate:
   *   - a curator-created CG stores its CLEARTEXT id (even one shaped like a
   *     0x+64-hex string) and registration commits `keccak256(utf8(cleartextId))`;
   *   - a host-only/core subscription is keyed by the WIRE id itself (cleartext
   *     never left the curator), so the local id already IS the committed hash —
   *     but the verbatim form is accepted ONLY when local metadata AFFIRMATIVELY
   *     proves the subscription is wire-id keyed (#884 review 🔴 GaZky), so a
   *     hash-shaped cleartext id can't borrow a reused slot's commitment.
   * A genuinely reused slot commits a DIFFERENT name that matches neither.
   *
   * The explicit binding mode owns both numeric self-address handling and
   * outcome mapping. `legacy-policy` preserves compatibility,
   * `chain-attested-repair` requires a committed mapping proof.
   * `retryable-durable` preserves the established raw numeric self-address
   * while propagating transport failures for every other identity read so
   * bounded durable verification can retry a fresh read.
   */
  async localCgMatchesOnChainSlot(this: DKGAgent,
    contextGraphId: string,
    onChainId: string,
    opCtx?: OperationContext,
    options: {
      bindingMode?: ContextGraphSlotBindingMode;
      /** @deprecated Use `bindingMode: 'chain-attested-repair'`. */
      requireCommittedNameHash?: boolean;
      signal?: AbortSignal;
    } = {},
  ): Promise<boolean> {
    const compatibilityBindingMode = options.requireCommittedNameHash === undefined
      ? undefined
      : options.requireCommittedNameHash
        ? 'chain-attested-repair'
        : 'legacy-policy';
    if (
      compatibilityBindingMode !== undefined
      && options.bindingMode !== undefined
      && options.bindingMode !== compatibilityBindingMode
    ) {
      throw new TypeError(
        'requireCommittedNameHash contradicts the explicit Context Graph binding mode',
      );
    }
    const bindingMode = options.bindingMode ?? compatibilityBindingMode ?? 'legacy-policy';
    const outcome = await evaluateContextGraphSlotBinding(
      this.chain,
      contextGraphId,
      onChainId,
      opCtx,
      options.signal,
      // The deprecated strict option accepted a direct numeric self-address;
      // preserve that exact compatibility while the new repair mode remains
      // stricter for callers that opt into it directly.
      options.requireCommittedNameHash === true
        || bindingMode !== 'chain-attested-repair',
      (localId) => this.isWireIdKeyedSubscription(localId),
      (ctx, message) => this.log.warn(ctx, message),
      (start, label, signal) => this.raceChainPolicyRead(start, label, signal),
    );
    return mapContextGraphSlotBindingOutcome(outcome, bindingMode);
  }

  /**
   * Strict durable-sync identity proof. Unlike the legacy policy probe, this
   * rejects malformed or unprovable mappings and propagates chain transport
   * failures so authentication can retry a fresh read.
   */
  async requireLocalCgMatchesOnChainSlot(this: DKGAgent,
    contextGraphId: string,
    onChainId: string,
    opCtx?: OperationContext,
    options: { signal?: AbortSignal } = {},
  ): Promise<boolean> {
    return this.localCgMatchesOnChainSlot(
      contextGraphId,
      onChainId,
      opCtx,
      { bindingMode: 'retryable-durable', signal: options.signal },
    );
  }

  /**
   * #884 review (🔴 GaZky) — AFFIRMATIVE proof that a 0x+64-hex local CG id is a
   * host-only/core subscription keyed by the WIRE id (the committed name-hash)
   * rather than a user-chosen cleartext id that merely looks hash-shaped.
   *
   * Host-only auto-subscribe paths (chain-event + discovery-beacon) stage the
   * wire id AS the local id and explicitly record `onChainHash === id`. Only
   * that self-referential subscription commitment licenses
   * {@link localCgMatchesOnChainSlot} to accept the verbatim id against the
   * on-chain name-hash. The general reverse index is deliberately insufficient:
   * every subscription is indexed there, including hash-shaped cleartext ids.
   */
  isWireIdKeyedSubscription(this: DKGAgent, localId: string): boolean {
    if (!/^0x[0-9a-fA-F]{64}$/.test(localId)) return false;
    const lower = localId.toLowerCase();
    const sub =
      this.subscribedContextGraphs?.get(localId) ?? this.subscribedContextGraphs?.get(lower);
    return !!sub?.onChainHash && sub.onChainHash.toLowerCase() === lower;
  }

  /**
   * Resolve SWM gossip recipients, gating on the CG's on-chain READ access
   * policy. The store-only resolver (`resolveWorkspaceAgentRecipients`)
   * flags ANY allowlisted CG as requiring encryption, but a CG that is
   * PUBLIC on-chain has public-readable SWM — its allowedAgent list
   * governs publish authority, not read access. Encrypting such a CG
   * bootstraps a sender-key handshake that non-gated recipients reject
   * ("not DKG-agent gated"), which surfaced as an HTTP 500 on WM→SWM
   * promote.
   *
   * Resolve the canonical registered authority BEFORE delegating to the store
   * resolver: a public CG takes the plaintext path without resolving recipient
   * keys at all. This also
   * avoids the resolver's "Missing public encryption key" throw for an
   * allowlisted agent whose key isn't locally available — irrelevant for
   * a public CG that never encrypts. Private graphs resolve recipients from
   * the live roster; unavailable registered authority fails closed.
   */
  async resolveWorkspaceRecipientsGated(this: DKGAgent,
    input: WorkspaceAgentRecipientResolverInput,
  ): Promise<WorkspaceAgentRecipientResolution> {
    return this.resolveWorkspaceAgentRecipientsForCurrentAuthority(input);
  }

  /**
   * Resolve encryption recipients from live registered-chain authority. The
   * local store remains the source of authenticated encryption keys and peer
   * routing, but only the chain roster selects which agents are resolved. When
   * the graph also has a peer allowlist, recipient routing must satisfy that
   * second, conjunctive authority gate. Every chain-authorized agent must have
   * at least one usable recipient key on an allowed peer before publishing can
   * proceed, otherwise either an unauthorized peer receives the sender key or
   * an authorized member cannot read the resulting write.
   */
  async resolveWorkspaceAgentRecipientsForCurrentAuthority(this: DKGAgent,
    input: WorkspaceAgentRecipientResolverInput,
  ): Promise<WorkspaceAgentRecipientResolution> {
    const registeredAuthority = await this.resolveRegisteredContextGraphAuthority(input.contextGraphId);
    if (registeredAuthority.kind === 'unregistered') {
      return resolveWorkspaceAgentRecipients(this.store, input);
    }
    if (registeredAuthority.kind === 'public') {
      return { requiresEncryption: false, recipients: [] };
    }
    if (registeredAuthority.kind === 'unavailable') {
      const message =
        `Registered context graph "${input.contextGraphId}" authority is unavailable (${registeredAuthority.reason})`;
      throw createContextGraphAuthorityError(message, registeredAuthority);
    }
    if (registeredAuthority.participantAgents.length === 0) {
      throw new Error(
        `Registered context graph "${input.contextGraphId}" requires encrypted SWM gossip but its authoritative chain roster is empty or unavailable`,
      );
    }

    const allowedPeers = await this.getContextGraphAllowedPeers(input.contextGraphId);
    const allowedPeerSet = allowedPeers === null ? null : new Set(allowedPeers);

    // Resolve only the live chain-authorized addresses. Filtering a completed
    // local resolution afterward is too late: stale removed members can have
    // malformed/missing key metadata that makes the local resolver throw
    // before the chain intersection is reached, blocking every post-revoke
    // write until the local cleanup retry succeeds.
    const recipients: WorkspaceAgentRecipient[] = [];
    for (const agentAddress of registeredAuthority.participantAgents) {
      const agentRecipients = await resolveWorkspaceAgentRecipientKeys(this.store, agentAddress);
      const authorizedRecipients = allowedPeerSet === null
        ? agentRecipients
        : agentRecipients.filter((recipient) => (
          recipient.peerId !== undefined && allowedPeerSet.has(recipient.peerId)
        ));
      if (authorizedRecipients.length === 0) {
        throw new Error(
          `Registered context graph "${input.contextGraphId}" requires encrypted SWM gossip but `
          + `chain-authorized DKG agent ${ethers.getAddress(agentAddress)} has no recipient key `
          + 'advertised by a peer in the context graph allowlist',
        );
      }
      recipients.push(...authorizedRecipients);
    }
    const [firstRecipient, ...remainingRecipients] = recipients;
    if (!firstRecipient) {
      throw new Error(
        `Registered context graph "${input.contextGraphId}" requires encrypted SWM gossip but has no chain-authorized DKG agent recipients`,
      );
    }
    return {
      requiresEncryption: true,
      recipients: [firstRecipient, ...remainingRecipients],
    };
  }

  async encryptWorkspacePayloadWithSenderKey(this: DKGAgent,
    input: WorkspaceSenderKeyEncryptInput,
  ): Promise<Uint8Array> {
    await this.loadSwmSenderKeyState();
    const ctx = createOperationContext('share', input.operationId);
    const sender = this.getLocalSigningAgentForAddress(input.senderAgentAddress);
    if (!sender) {
      throw new Error(`Cannot create SWM Sender Key epoch: no local custodial signing key for agent ${input.senderAgentAddress}`);
    }

    const resolution = input.resolution;
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
      const pruned = this.prunePendingSenderKeysForEpochRotation({
        contextGraphId: input.contextGraphId,
        subGraphName: input.subGraphName,
        senderAgentAddress: senderAddress,
      });
      if (pruned > 0) {
        this.log.warn(
          ctx,
          `SWM sender-key epoch rotation pruned ${pruned} stale pending setup package(s) ` +
          `for context graph "${input.contextGraphId}${input.subGraphName ? `/${input.subGraphName}` : ''}" sender ${senderAddress}`,
        );
        await this.saveSwmSenderKeyState();
      }
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
    } else {
      await this.drainPendingSenderKeyForRecipients(resolution.recipients, ctx);
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

  async createAndDistributeSwmSenderKeyEpoch(this: DKGAgent, input: {
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

    // A recipient agent may hold multiple registered keys. We try each one; if
    // a remote daemon owns the private half of one of them, that handshake
    // succeeds and we count the agent as delivered. The other keys will fail
    // (the recipient daemon has no matching local privkey for them) — that's
    // expected, not a hard error. We only abort when EVERY key for a given
    // agent failed.
    //
    // Fanout runs in parallel via Promise.allSettled. The pre-rc.12 loop
    // awaited each `messenger.sendReliable` sequentially, so foreground
    // publish latency scaled as `O(n_recipients × n_keys × send_timeout)` —
    // a single offline member paid the full per-send timeout before the
    // loop advanced. Concurrent fanout keeps the wall-clock cost bounded
    // by the slowest individual send (~`DEFAULT_SEND_TIMEOUT_MS`).
    //
    // Concurrent mutation is moot: each per-recipient async closure runs
    // on the single JS event loop and yields only at `await` points; the
    // aggregation maps are appended to ONLY in the post-settle pass below.
    type PerRecipientOutcome =
      | { kind: 'success'; agentAddress: string }
      | { kind: 'failure'; agentAddress: string; keyId: string; error: Error };

    let pendingSenderKeyQueued = false;
    const settled = await Promise.allSettled(
      input.recipients.map(async (recipient): Promise<PerRecipientOutcome> => {
        const recipientAgentAddress = ethers.getAddress(recipient.agentAddress);
        const pkg = await this.createSignedSwmSenderKeyPackage({
          state,
          recipient,
          senderPrivateKey: input.sender.privateKey,
        });
        const packageBytes = encodeSwmSenderKeyPackage(pkg);

        if (this.hasLocalAgent(recipientAgentAddress)) {
          try {
            await this.acceptSwmSenderKeyPackage(pkg, this.node.peerId.toString(), input.ctx);
            return { kind: 'success', agentAddress: recipientAgentAddress };
          } catch (err) {
            return {
              kind: 'failure',
              agentAddress: recipientAgentAddress,
              keyId: recipient.recipientKeyId,
              error: err instanceof Error ? err : new Error(String(err)),
            };
          }
        }

        if (!recipient.peerId) {
          // PR-2 (SWM-fanout plan): the recipient agent has no advertised
          // `dkg:peerId` triple in our local store (typically because we
          // haven't synced their profile yet, or they really were never
          // online). Pre-PR-2 this was a HARD failure for that key, and
          // if every key for the agent landed here the whole publish
          // threw — turning "one never-seen member" into "publish blocked
          // for everyone". We now match the messenger.sendReliable
          // soft-success contract: durably remember the package and
          // attempt delivery once the agent shows up (via the
          // connection:open drain below).
          this.enqueuePendingSenderKey({
            senderAgentAddress: senderAgentAddress.toLowerCase(),
            recipientAgentAddress: recipientAgentAddress.toLowerCase(),
            recipientKeyId: recipient.recipientKeyId,
            epochId: state.epochId,
            contextGraphId: state.contextGraphId,
            subGraphName: state.subGraphName,
            packageBytes,
            createdAtMs: Date.now(),
          });
          pendingSenderKeyQueued = true;
          this.log.warn(
            input.ctx,
            `SWM sender-key setup for ${recipientAgentAddress} keyId=${recipient.recipientKeyId} ` +
            `queued (no advertised peerId) — will deliver when recipient connects`,
          );
          return { kind: 'success', agentAddress: recipientAgentAddress };
        }

        this.log.info(
          input.ctx,
          `SWM sender-key setup send: senderAgent=${senderAgentAddress} recipientAgent=${recipientAgentAddress} ` +
          `peerId=${recipient.peerId} contextGraph=${state.contextGraphId}${state.subGraphName ? `/${state.subGraphName}` : ''} ` +
          `epoch=${state.epochId} membershipHash=${state.membershipHash} recipientKeyId=${recipient.recipientKeyId}`,
        );
        try {
          // rc.9 PR-8: route through messenger.sendReliable so
          // sender-side idempotency + durable outbox + retry-with-
          // backoff cover this protocol the same way they cover chat.
          //
          // Delivery semantics (C2 integration-pass relaxation):
          //   • `delivered=true && ack.accepted=true` → success.
          //   • `delivered=true && ack.accepted=false` with no reason code,
          //     or with a known terminal reason (`stale-target`,
          //     `active-private-key-missing`, `revoked-key`,
          //     `bad-signature`, `unknown`, ACL/config failures)
          //     → HARD failure: retrying the same package cannot help.
          //   • `delivered=true && ack.accepted=false` with an explicitly
          //     retryable reason → SOFT success: keep it queued so a later
          //     reconnect/publish can retry after remote view convergence.
          //   • `delivered=false` → SOFT success.
          //     The setup-package landed in the messenger's durable
          //     outbox, but the agent also keeps a local pending row
          //     under the same messageId so future retries still decode
          //     the Sender Key ACK and can rotate after delivered
          //     malformed/retryable responses. Treating this as a hard
          //     failure used to block any open-publish-CG write whenever
          //     the curator was offline mid-batch, breaking the "members
          //     keep publishing under intermittent curator availability"
          //     contract C2 exercises. The recipient still gets the
          //     epoch + chain key eventually; the only cost is that
          //     they can't decrypt the broadcast that immediately
          //     follows until the queued setup catches up.
          const messageId = this.swmSenderKeyPackageMessageId(packageBytes);
          const sendResult = await this.messenger.sendReliable(
            recipient.peerId,
            PROTOCOL_SWM_SENDER_KEY,
            packageBytes,
            { messageId },
          );
          if (!sendResult.delivered) {
            this.enqueuePendingSenderKey({
              senderAgentAddress: senderAgentAddress.toLowerCase(),
              recipientAgentAddress: recipientAgentAddress.toLowerCase(),
              recipientKeyId: recipient.recipientKeyId,
              epochId: state.epochId,
              contextGraphId: state.contextGraphId,
              subGraphName: state.subGraphName,
              packageBytes,
              messageId,
              createdAtMs: Date.now(),
            });
            pendingSenderKeyQueued = true;
            this.log.warn(
              input.ctx,
              `SWM sender-key setup for ${recipientAgentAddress} keyId=${recipient.recipientKeyId} ` +
              `queued (not synchronously deliverable): ${sendResult.error} — recipient will receive on next reconnect`,
            );
            return { kind: 'success', agentAddress: recipientAgentAddress };
          }
          let ack: ReturnType<typeof decodeSwmSenderKeyPackageAck>;
          try {
            ack = decodeSwmSenderKeyPackageAck(sendResult.response);
          } catch {
            this.enqueuePendingSenderKey({
              senderAgentAddress: senderAgentAddress.toLowerCase(),
              recipientAgentAddress: recipientAgentAddress.toLowerCase(),
              recipientKeyId: recipient.recipientKeyId,
              epochId: state.epochId,
              contextGraphId: state.contextGraphId,
              subGraphName: state.subGraphName,
              packageBytes,
              messageId: this.nextSwmSenderKeyPackageMessageId(packageBytes),
              createdAtMs: Date.now(),
            });
            pendingSenderKeyQueued = true;
            this.log.warn(
              input.ctx,
              `SWM sender-key setup for ${recipientAgentAddress} keyId=${recipient.recipientKeyId} ` +
              'queued after malformed Sender Key setup ACK',
            );
            return { kind: 'success', agentAddress: recipientAgentAddress };
          }
          if (
            ack.version !== SWM_SENDER_KEY_PACKAGE_VERSION ||
            ack.type !== SWM_SENDER_KEY_PACKAGE_ACK_TYPE
          ) {
            this.enqueuePendingSenderKey({
              senderAgentAddress: senderAgentAddress.toLowerCase(),
              recipientAgentAddress: recipientAgentAddress.toLowerCase(),
              recipientKeyId: recipient.recipientKeyId,
              epochId: state.epochId,
              contextGraphId: state.contextGraphId,
              subGraphName: state.subGraphName,
              packageBytes,
              messageId: this.nextSwmSenderKeyPackageMessageId(packageBytes),
              createdAtMs: Date.now(),
            });
            pendingSenderKeyQueued = true;
            this.log.warn(
              input.ctx,
              `SWM sender-key setup for ${recipientAgentAddress} keyId=${recipient.recipientKeyId} ` +
              `queued after incompatible Sender Key setup ACK version/type (${ack.version}/${ack.type})`,
            );
            return { kind: 'success', agentAddress: recipientAgentAddress };
          }
          if (!ack.accepted) {
            const reason = ack.reason ?? 'unknown reason';
            if (this.isRetryableSwmSenderKeySetupAckReason(ack.reasonCode)) {
              this.enqueuePendingSenderKey({
                senderAgentAddress: senderAgentAddress.toLowerCase(),
                recipientAgentAddress: recipientAgentAddress.toLowerCase(),
                recipientKeyId: recipient.recipientKeyId,
                epochId: state.epochId,
                contextGraphId: state.contextGraphId,
                subGraphName: state.subGraphName,
                packageBytes,
                messageId: this.nextSwmSenderKeyPackageMessageId(packageBytes),
                createdAtMs: Date.now(),
              });
              pendingSenderKeyQueued = true;
              this.log.warn(
                input.ctx,
                `SWM sender-key setup for ${recipientAgentAddress} keyId=${recipient.recipientKeyId} ` +
                `queued after retryable rejection (${ack.reasonCode ?? 'legacy-unknown'}): ${reason}`,
              );
              return { kind: 'success', agentAddress: recipientAgentAddress };
            }
            return {
              kind: 'failure',
              agentAddress: recipientAgentAddress,
              keyId: recipient.recipientKeyId,
              error: new Error(`${ack.reasonCode ? `${ack.reasonCode}: ` : ''}${reason}`),
            };
          }
          return { kind: 'success', agentAddress: recipientAgentAddress };
        } catch (err) {
          return {
            kind: 'failure',
            agentAddress: recipientAgentAddress,
            keyId: recipient.recipientKeyId,
            error: err instanceof Error ? err : new Error(String(err)),
          };
        }
      }),
    );

    const failuresByAgent = new Map<string, string[]>();
    const successByAgent = new Set<string>();
    for (let i = 0; i < settled.length; i++) {
      const r = settled[i];
      if (r.status === 'rejected') {
        // The per-recipient closure catches all throw paths and returns a
        // failure outcome, so a rejection here means the closure itself
        // crashed (programmer error). Record it against the recipient so
        // the surrounding logic doesn't lose track of the slot.
        const recipient = input.recipients[i];
        const agent = ethers.getAddress(recipient.agentAddress).toLowerCase();
        const list = failuresByAgent.get(agent) ?? [];
        list.push(`${recipient.recipientKeyId}: ${String(r.reason)}`);
        failuresByAgent.set(agent, list);
        continue;
      }
      const outcome = r.value;
      if (outcome.kind === 'success') {
        successByAgent.add(outcome.agentAddress.toLowerCase());
      } else {
        const agent = outcome.agentAddress.toLowerCase();
        const list = failuresByAgent.get(agent) ?? [];
        list.push(`${outcome.keyId}: ${outcome.error.message}`);
        failuresByAgent.set(agent, list);
      }
    }

    // Surface only agents for whom ALL keys failed. Mixed-success failures get
    // a per-key warning so operators can see the noise but SWM still progresses.
    const fatalAgents: string[] = [];
    for (const [agentAddress, reasons] of failuresByAgent.entries()) {
      if (successByAgent.has(agentAddress)) {
        this.log.warn(
          input.ctx,
          `SWM sender-key setup partial delivery for agent ${agentAddress} (epoch ${state.epochId}): ${reasons.join('; ')} — expected when recipient holds only a subset of registered keys`,
        );
      } else {
        fatalAgents.push(`${agentAddress}: ${reasons.join('; ')}`);
      }
    }
    if (fatalAgents.length > 0) {
      if (pendingSenderKeyQueued) {
        await this.saveSwmSenderKeyState();
      }
      throw new Error(
        `SWM Sender Key setup rejected by ${fatalAgents.length} agent(s): ${fatalAgents.join(' | ')}`,
      );
    }

    return state;
  }

  swmSenderKeySetupAckReasonCode(this: DKGAgent, err: unknown): SwmSenderKeyPackageAckReasonCode {
    if (err instanceof StaleSenderKeyTargetError) {
      return 'stale-target';
    }
    if (err instanceof SwmSenderKeySetupRejectionError) {
      return err.reasonCode;
    }
    return 'unknown';
  }

  isRetryableSwmSenderKeySetupAckReason(this: DKGAgent,
    reasonCode: SwmSenderKeyPackageAckReasonCode | undefined,
  ): boolean {
    if (!reasonCode) return false;
    return (SWM_SENDER_KEY_PACKAGE_ACK_RETRYABLE_REASON_CODES as readonly string[]).includes(reasonCode);
  }

  swmSenderKeyPackageMessageId(this: DKGAgent, packageBytes: Uint8Array): string {
    return `swm-sender-key:${createHash('sha256').update(packageBytes).digest('hex')}`;
  }

  nextSwmSenderKeyPackageMessageId(this: DKGAgent, packageBytes: Uint8Array): string {
    return `${this.swmSenderKeyPackageMessageId(packageBytes)}:${randomUUID()}`;
  }

  swmSenderKeyPendingMessageId(this: DKGAgent, entry: PendingSenderKeyEntry): string {
    return entry.messageId ?? this.swmSenderKeyPackageMessageId(entry.packageBytes);
  }

  rotateSwmSenderKeyPendingMessageId(this: DKGAgent, entry: PendingSenderKeyEntry): PendingSenderKeyEntry {
    return {
      ...entry,
      messageId: this.nextSwmSenderKeyPackageMessageId(entry.packageBytes),
    };
  }

  /**
   * PR-2 (SWM-fanout plan): enqueue a sender-key package whose recipient
   * has no advertised `dkg:peerId` (so we can't even ask the messenger
   * to queue it). Older epochs for the same `(sender, recipient)` pair
   * are evicted — a newer epoch supersedes them by definition.
   *
   * Per-key dedup: `(senderAgentAddress, recipientKeyId, epochId)`
   * matches an existing row, we replace it (idempotent re-enqueue).
   */
  enqueuePendingSenderKey(this: DKGAgent, entry: PendingSenderKeyEntry): void {
    const recipientKey = entry.recipientAgentAddress.toLowerCase();
    const existing = this.pendingSenderKeyByAgent.get(recipientKey) ?? [];
    // Drop older epochs for the same (sender, recipient) pair; the newer
    // epoch's membership-hash supersedes them. Keep entries for OTHER
    // senders / recipients unchanged.
    const filtered = existing.filter((e) => {
      if (e.senderAgentAddress !== entry.senderAgentAddress) return true;
      if (e.epochId === entry.epochId) {
        // Same epoch: dedupe by recipientKeyId — caller may re-enqueue
        // on retry. Replace by dropping the old slot; the new one is
        // appended below.
        return e.recipientKeyId !== entry.recipientKeyId;
      }
      return false;
    });
    filtered.push(entry);
    this.pendingSenderKeyByAgent.set(recipientKey, filtered);
  }

  prunePendingSenderKeysForEpochRotation(this: DKGAgent, input: {
    contextGraphId: string;
    subGraphName?: string;
    senderAgentAddress: string;
  }): number {
    const senderAgentAddress = ethers.getAddress(input.senderAgentAddress).toLowerCase();
    let removed = 0;
    for (const [recipientKey, queue] of this.pendingSenderKeyByAgent.entries()) {
      const kept = queue.filter((entry) => {
        const matches =
          entry.senderAgentAddress === senderAgentAddress &&
          entry.contextGraphId === input.contextGraphId &&
          (entry.subGraphName ?? undefined) === (input.subGraphName ?? undefined);
        if (matches) removed += 1;
        return !matches;
      });
      if (kept.length === 0) {
        this.pendingSenderKeyByAgent.delete(recipientKey);
      } else {
        this.pendingSenderKeyByAgent.set(recipientKey, kept);
      }
    }
    return removed;
  }

  async drainPendingSenderKeyQueueForPeer(this: DKGAgent, input: {
    peerId: string;
    recipientAgentAddress: string;
    ctx?: OperationContext;
  }): Promise<number> {
    const recipientAgentAddress = input.recipientAgentAddress.toLowerCase();
    const existingDrain = this.pendingSenderKeyDrainByAgent.get(recipientAgentAddress);
    if (existingDrain) {
      await existingDrain;
      if (!this.pendingSenderKeyByAgent.has(recipientAgentAddress)) return 0;
      return this.drainPendingSenderKeyQueueForPeer(input);
    }
    const drain = this.drainPendingSenderKeyQueueForPeerLocked({
      peerId: input.peerId,
      recipientAgentAddress,
      ctx: input.ctx,
    }).finally(() => {
      if (this.pendingSenderKeyDrainByAgent.get(recipientAgentAddress) === drain) {
        this.pendingSenderKeyDrainByAgent.delete(recipientAgentAddress);
      }
    });
    this.pendingSenderKeyDrainByAgent.set(recipientAgentAddress, drain);
    return drain;
  }

  async drainPendingSenderKeyQueueForPeerLocked(this: DKGAgent, input: {
    peerId: string;
    recipientAgentAddress: string;
    ctx?: OperationContext;
  }): Promise<number> {
    const recipientAgentAddress = input.recipientAgentAddress;
    const queue = this.pendingSenderKeyByAgent.get(recipientAgentAddress);
    if (!queue || queue.length === 0) return 0;

    let drained = 0;
    const remaining: PendingSenderKeyEntry[] = [];
    for (let i = 0; i < queue.length; i += 1) {
      const entry = queue[i];
      try {
        const sendResult = await this.messenger.sendReliable(
          input.peerId,
          PROTOCOL_SWM_SENDER_KEY,
          entry.packageBytes,
          { messageId: this.swmSenderKeyPendingMessageId(entry) },
        );
        if (!sendResult.delivered) {
          if (sendResult.queued || ('inFlight' in sendResult && sendResult.inFlight)) {
            remaining.push(entry);
            continue;
          }
          throw new Error(`Unexpected undelivered Sender Key retry result: ${sendResult.error}`);
        }
        let ack: ReturnType<typeof decodeSwmSenderKeyPackageAck>;
        try {
          ack = decodeSwmSenderKeyPackageAck(sendResult.response);
        } catch {
          // Malformed/legacy ACK: no positive acceptance yet. Keep the
          // row queued so a mixed-version rollout cannot strand the recipient.
          remaining.push(this.rotateSwmSenderKeyPendingMessageId(entry));
          continue;
        }
        if (
          ack.version !== SWM_SENDER_KEY_PACKAGE_VERSION ||
          ack.type !== SWM_SENDER_KEY_PACKAGE_ACK_TYPE
        ) {
          // Malformed/legacy ACK: no positive acceptance yet. Keep the
          // row queued so a mixed-version rollout cannot strand the recipient.
          remaining.push(this.rotateSwmSenderKeyPendingMessageId(entry));
          continue;
        }
        if (ack.accepted) {
          drained += 1;
        } else if (this.isRetryableSwmSenderKeySetupAckReason(ack.reasonCode)) {
          remaining.push(this.rotateSwmSenderKeyPendingMessageId(entry));
        } else {
          const reason = ack.reason ?? 'unknown reason';
          const reasonCode = ack.reasonCode ?? 'legacy-unknown';
          this.log.warn(
            input.ctx ?? SWM_SENDER_KEY_PENDING_DRAIN_LOG_CTX,
            `SWM sender-key pending retry for ${entry.recipientAgentAddress} keyId=${entry.recipientKeyId} ` +
            `peerId=${input.peerId} contextGraph=${entry.contextGraphId}${entry.subGraphName ? `/${entry.subGraphName}` : ''} ` +
            `dropped after terminal rejection (${reasonCode}): ${reason}`,
          );
          // Terminal rejection: keep it out of the queue, but do not
          // report it as a successful drain.
        }
      } catch (err) {
        remaining.push(...queue.slice(i));
        if (remaining.length === 0) {
          this.pendingSenderKeyByAgent.delete(recipientAgentAddress);
        } else {
          this.pendingSenderKeyByAgent.set(recipientAgentAddress, remaining);
        }
        await this.saveSwmSenderKeyState();
        const message = err instanceof Error ? err.message : String(err);
        this.log.warn(
          input.ctx ?? SWM_SENDER_KEY_PENDING_DRAIN_LOG_CTX,
          `SWM sender-key pending retry for ${entry.recipientAgentAddress} keyId=${entry.recipientKeyId} ` +
          `peerId=${input.peerId} contextGraph=${entry.contextGraphId}${entry.subGraphName ? `/${entry.subGraphName}` : ''} ` +
          `failed before the Messenger substrate queued a retry: ${message}`,
        );
        throw err;
      }
    }

    if (remaining.length === 0) {
      this.pendingSenderKeyByAgent.delete(recipientAgentAddress);
    } else {
      this.pendingSenderKeyByAgent.set(recipientAgentAddress, remaining);
    }
    await this.saveSwmSenderKeyState();
    return drained;
  }

  /**
   * Drain queued sender-key packages whose recipient agent is one of
   * the agent addresses advertised by `peerId`. Returns the number of
   * rows successfully delivered (acked) and removed.
   *
   * Fired from the `connection:open` listener — see line 2382 — so the
   * cost lives on the cold path of "we just connected to a new peer",
   * not on every share. Each successful `sendReliable` with
   * `delivered=true && ack.accepted=true` deletes the row and counts as
   * drained; soft (`delivered=false`) and explicitly retryable delivered
   * rejections leave it queued for the next attempt; terminal delivered
   * rejections are logged and deleted without counting as drained.
   */
  public async drainPendingSenderKeyForPeer(this: DKGAgent, peerId: string, ctx?: OperationContext): Promise<number> {
    await this.loadSwmSenderKeyState();
    if (this.pendingSenderKeyByAgent.size === 0) return 0;
    let drained = 0;
    let agentAddresses: string[] = [];
    try {
      const profile = await this.discovery.findAgentByPeerId(peerId);
      if (profile?.agentAddress) {
        agentAddresses = [profile.agentAddress.toLowerCase()];
      }
    } catch {
      // Resolution failure is benign — we'll try again on the next
      // connection:open burst. Don't propagate.
    }
    if (agentAddresses.length === 0) return 0;

    for (const recipientAgentAddress of agentAddresses) {
      drained += await this.drainPendingSenderKeyQueueForPeer({ peerId, recipientAgentAddress, ctx });
    }
    return drained;
  }

  /**
   * Retry queued sender-key setup for recipients that are reachable in the
   * current workspace recipient snapshot. This covers already-established
   * connections where no fresh connection:open event will fire after the
   * remote membership/key view converges.
   */
  async drainPendingSenderKeyForRecipients(this: DKGAgent,
    recipients: readonly WorkspaceAgentRecipient[],
    ctx?: OperationContext,
  ): Promise<number> {
    if (this.pendingSenderKeyByAgent.size === 0) return 0;

    const peerByAgent = new Map<string, string>();
    for (const recipient of recipients) {
      if (!recipient.peerId) continue;
      const recipientAgentAddress = recipient.agentAddress.toLowerCase();
      if (!this.pendingSenderKeyByAgent.has(recipientAgentAddress)) continue;
      if (!peerByAgent.has(recipientAgentAddress)) {
        peerByAgent.set(recipientAgentAddress, recipient.peerId);
      }
    }
    if (peerByAgent.size === 0) return 0;

    let drained = 0;
    for (const [recipientAgentAddress, peerId] of peerByAgent.entries()) {
      drained += await this.drainPendingSenderKeyQueueForPeer({ peerId, recipientAgentAddress, ctx });
    }
    if (drained > 0 && ctx) {
      this.log.info(ctx, `SWM sender-key pending retry drained ${drained} queued package(s) during publish`);
    }
    return drained;
  }

  async createSignedSwmSenderKeyPackage(this: DKGAgent, input: {
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

  /**
   * `PROTOCOL_SWM_UPDATE` substrate receiver. Routes substrate-
   * delivered SWM share bytes through `SharedMemoryHandler.handle()`
   * (the same in-process apply path the gossip subscription
   * drives) and maps the {@link SharedMemoryApplyOutcome} to a
   * substrate response:
   *
   *   - `applied: true`                          → empty Uint8Array
   *      (ACK; sender records `delivered`).
   *   - `applied: false, retryable: true`        → THROW so
   *      `messenger.sendReliable` reports a stream error,
   *      `isRecoverableSendError` classifies it as recoverable
   *      (the libp2p stream-reset signature contains "closed" /
   *      "reset"), and the substrate outbox keeps the share
   *      queued for retry. Dominant case: sender key package
   *      for the current epoch hasn't arrived yet — once it
   *      does, the SAME wire bytes apply cleanly on retry.
   *   - `applied: false, retryable: false`       → return
   *      {@link FANOUT_RESPONSE_REJECTED} (1-byte sentinel
   *      `0x01`). The sender's `classifySendResult` recognises
   *      the sentinel and records the outcome as `rejected`,
   *      NOT `delivered` (codex R6 on PR #576). The share is
   *      dropped — retrying the same wire bytes would produce
   *      the same permanent rejection (bad signature, peer not
   *      in allowlist, validation failed, malformed protobuf).
   *
   * Extracted into a named method so the receiver contract can
   * be unit-tested in isolation without spinning up a real
   * Messenger registration.
   */
  public async handleSwmUpdate(this: DKGAgent, data: Uint8Array, fromPeerId: string): Promise<Uint8Array> {
    const wh = this.getOrCreateSharedMemoryHandler();
    const outcome = await wh.handle(data, fromPeerId);
    if (outcome.applied) {
      if (outcome.assetUal) {
        logKaLifecycleEvent(this.log, createOperationContext('share'), {
          assetUal: outcome.assetUal,
          stage: 'swm_share',
          event: 'swm_update_applied',
          role: 'receiver',
          localPeerId: this.peerId,
          localNodeIdentityId: this.identityId.toString(),
          peer: fromPeerId,
          metadata: {
            contextGraphId: outcome.cgId,
            shareOperationId: outcome.shareOperationId,
            insertedCount: outcome.insertedTriples,
          },
        });
      }
      // PR-H bug 2: emit SwmShareAck on substrate-applied shares
      // too (not just gossip-applied). Pre-PR-H the sender only
      // counted substrate-`delivered` peers via the in-process
      // bookkeeper, which silently dropped any peer that started
      // as `queued`/`inFlight` and was delivered LATER by the
      // outbox — the outbox-completion callback isn't wired to
      // the quorum, so a successful eventual delivery never
      // called `onAck`. Those peers stayed pending until the
      // watchdog fired a top-up they didn't need.
      //
      // The fix is symmetric: the receiver emits an ack on
      // apply regardless of which transport delivered the
      // share. The publisher's `SwmAckQuorum.onAck` is
      // idempotent (no-op when the peer is already in the
      // `acked` set), so a fast substrate-bookkeeper ack
      // followed by a redundant SwmShareAck is harmless.
      // Late deliveries now reach quorum the same way fast
      // ones do.
      this.maybeEmitSwmShareAck(outcome).catch(() => { /* swallowed; logged inside */ });
      return new Uint8Array();
    }
    if (outcome.retryable) {
      if (outcome.assetUal) {
        logKaLifecycleEvent(this.log, createOperationContext('share'), {
          assetUal: outcome.assetUal,
          stage: 'swm_share',
          event: 'swm_update_rejected',
          role: 'receiver',
          localPeerId: this.peerId,
          localNodeIdentityId: this.identityId.toString(),
          peer: fromPeerId,
          level: 'warn',
          metadata: {
            contextGraphId: outcome.cgId,
            shareOperationId: outcome.shareOperationId,
            outcome: 'retryable',
            retryable: true,
            reason: outcome.reason,
          },
        });
      }
      // rc.9 PR-D (codex follow-up from PR-G #G1): return the
      // 0x02 sentinel instead of throwing. Pre-PR-D this branch
      // threw, hoping libp2p would surface the handler abort as
      // a recoverable stream-reset so `isRecoverableSendError`
      // would re-queue into the outbox. That hope was fragile:
      // the non-pooled ProtocolRouter aborts with the literal
      // string "handler error", which doesn't match
      // reset/closed/timeout — the share got DROPPED instead of
      // queued. The sentinel sidesteps the abort path entirely:
      // wire layer succeeds, sender's `classifySendResult`
      // re-buckets 0x02 into the `retryable` outcome, the peer
      // is NOT added to the pre-acked set, and SwmAckQuorum's
      // watchdog fires substrate top-up at watchdogMs — giving
      // upstream state time to converge before the retry.
      this.log.info(
        createOperationContext('share'),
        `SWM substrate receiver transient rejection from ${fromPeerId} (PR-D watchdog will retry): ${outcome.reason}`,
      );
      return FANOUT_RESPONSE_RETRYABLE;
    }
    if (outcome.assetUal) {
      logKaLifecycleEvent(this.log, createOperationContext('share'), {
        assetUal: outcome.assetUal,
        stage: 'swm_share',
        event: 'swm_update_rejected',
        role: 'receiver',
        localPeerId: this.peerId,
        localNodeIdentityId: this.identityId.toString(),
        peer: fromPeerId,
        level: 'warn',
        metadata: {
          contextGraphId: outcome.cgId,
          shareOperationId: outcome.shareOperationId,
          outcome: 'rejected',
          retryable: false,
          reason: outcome.reason,
        },
      });
    }
    // Permanent rejection: signal via the 1-byte sentinel so the
    // sender records `rejected` (not `delivered`) and stops here.
    this.log.warn(
      createOperationContext('share'),
      `SWM substrate receiver dropping share from ${fromPeerId} (permanent rejection): ${outcome.reason}`,
    );
    return FANOUT_RESPONSE_REJECTED;
  }

  public async handleSwmSenderKeyPackage(this: DKGAgent, data: Uint8Array, fromPeerId: string): Promise<Uint8Array> {
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
      const reasonCode = this.swmSenderKeySetupAckReasonCode(err);
      if (pkg) {
        // A sender-key setup may legitimately be fanned out across every
        // cached snapshot of our agent's public encryption keys. Each
        // bootstrap that targets a fingerprint we don't host as an
        // active local key throws `StaleSenderKeyTargetError` and is
        // not actionable for the operator — the matching bootstrap that
        // hits our active key is logged at INFO via
        // `SWM sender-key setup receive accepted`. Logging every stale
        // attempt at WARN swamps `daemon.log` (5 WARNs per peer per
        // session was routine on testnet edge nodes) without surfacing
        // anything operators need to act on, so this branch is demoted
        // to DEBUG. WARN is reserved for failure modes that DO require
        // intervention: signature mismatch, agent-gate violation,
        // recipient not local, and revoked-key targeting (the
        // last of which throws a generic `Error` with the explicit
        // `was revoked at` message above and therefore stays at WARN).
        const message =
          `SWM sender-key setup receive rejected: senderAgent=${pkg.senderAgentAddress} recipientAgent=${pkg.recipientAgentAddress} ` +
          `fromPeer=${fromPeerId} contextGraph=${pkg.contextGraphId}${pkg.subGraphName ? `/${pkg.subGraphName}` : ''} ` +
          `epoch=${pkg.epochId} membershipHash=${pkg.membershipHash} reason=${reason}`;
        if (err instanceof StaleSenderKeyTargetError) {
          this.log.debug(ctx, message);
        } else {
          this.log.warn(ctx, message);
        }
      }
      return encodeSwmSenderKeyPackageAck({
        version: SWM_SENDER_KEY_PACKAGE_VERSION,
        type: SWM_SENDER_KEY_PACKAGE_ACK_TYPE,
        accepted: false,
        reason,
        reasonCode,
        contextGraphId: pkg?.contextGraphId,
        subGraphName: pkg?.subGraphName,
        senderAgentAddress: pkg?.senderAgentAddress,
        epochId: pkg?.epochId,
        membershipHash: pkg?.membershipHash,
        recipientAgentAddress: pkg?.recipientAgentAddress,
      });
    }
  }

  async acceptSwmSenderKeyPackage(this: DKGAgent,
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
      throw new SwmSenderKeySetupRejectionError(
        'bad-signature',
        `Sender Key setup signature recovered ${recovered}, expected ${senderAgentAddress}`,
      );
    }

    const agentGateAddresses = await this.getContextGraphAgentGateAddresses(pkg.contextGraphId);
    if (!agentGateAddresses) {
      // A cold private member can receive Sender Key setup after the finalized
      // chain binding but before its accepted RFC-64 roster or legacy `_meta`
      // projection is materialized. The chain policy is affirmative authority
      // that this graph is private, but it does not authorize either endpoint;
      // ask the sender to retain and retry the exact package until the local
      // gate arrives. Unknown/public policy remains a terminal fail-closed
      // rejection so an arbitrary ungated graph cannot create retry state.
      const policy = await this.getContextGraphOnChainPolicy(pkg.contextGraphId);
      if (policy.accessPolicy === 1) {
        throw new SwmSenderKeySetupRejectionError(
          'agent-gate-pending',
          `Context graph "${pkg.contextGraphId}" private agent gate is not materialized yet`,
        );
      }
      throw new SwmSenderKeySetupRejectionError(
        'not-agent-gated',
        `Context graph "${pkg.contextGraphId}" is not DKG-agent gated`,
      );
    }
    const agentGateSet = new Set(agentGateAddresses.map((agent) => agent.toLowerCase()));
    if (!agentGateSet.has(senderAgentAddress.toLowerCase())) {
      throw new SwmSenderKeySetupRejectionError(
        'sender-not-allowed',
        `Sender agent ${senderAgentAddress} is not allowed for context graph "${pkg.contextGraphId}"`,
      );
    }
    if (!agentGateSet.has(recipientAgentAddress.toLowerCase())) {
      throw new SwmSenderKeySetupRejectionError(
        'recipient-not-allowed',
        `Recipient agent ${recipientAgentAddress} is not allowed for context graph "${pkg.contextGraphId}"`,
      );
    }
    const allowedPeers = await this.getContextGraphAllowedPeers(pkg.contextGraphId);
    if (allowedPeers !== null && !allowedPeers.includes(fromPeerId)) {
      throw new SwmSenderKeySetupRejectionError(
        'sender-not-allowed',
        `Sender peer ${fromPeerId} is not allowed for context graph "${pkg.contextGraphId}"`,
      );
    }
    if (allowedPeers !== null && !allowedPeers.includes(this.peerId)) {
      throw new SwmSenderKeySetupRejectionError(
        'recipient-not-allowed',
        `Recipient peer ${this.peerId} is not allowed for context graph "${pkg.contextGraphId}"`,
      );
    }
    if (!this.hasLocalAgent(recipientAgentAddress)) {
      throw new SwmSenderKeySetupRejectionError(
        'recipient-not-local',
        `Recipient agent ${recipientAgentAddress} is not local to this node`,
      );
    }

    // `activeOnly: true` is the security gate added in Codex review of
    // PR #540 / commit 24aa4855: a sender bootstrapping a NEW sender-key
    // epoch may only target a non-revoked recipient key. Without this,
    // a stale or malicious sender could keep pinning traffic on a key
    // we have already retired, defeating the point of revocation. The
    // historical decryption path (used by `SharedMemoryHandler`) still
    // sees retired keys via the default `activeOnly: false`.
    const localKey = this.getLocalWorkspaceRecipientPrivateKeys({ activeOnly: true }).find((key) => (
      key.recipientId.toLowerCase() === `did:dkg:agent:${recipientAgentAddress}`.toLowerCase() &&
      key.recipientKeyId === pkg.recipientKeyId
    ));
    if (!localKey) {
      // Distinguish "no such local key" from "key exists locally but is
      // revoked" — operators chasing a sudden setup failure after a
      // revoke flow want to see the latter explicitly. Use the same
      // localAgents map the active-only filter does so the diagnostic
      // matches the gate exactly.
      //
      // Codex round 2 on PR #654: a `Map.get(checksum)` here can miss
      // a record that's stored under a differently-cased Map key than
      // its own `record.agentAddress` field (legacy persisted state,
      // older fixtures, or any path that lowercased on persist while
      // keeping the EIP-55 form on the record itself). The miss falls
      // through to `StaleSenderKeyTargetError`, which demotes a real
      // revoked-or-known-key failure to DEBUG and silences operator
      // visibility. Mirror the case-insensitive scan already used by
      // `hasLocalAgent` (just above) and `getLocalWorkspaceRecipient
      // PrivateKeys` so this branch sees the record whenever the
      // existence-gate above did.
      let record: AgentKeyRecord | undefined;
      for (const candidate of this.localAgents.values()) {
        if (candidate.agentAddress.toLowerCase() === recipientAgentAddress.toLowerCase()) {
          record = candidate;
          break;
        }
      }
      const activeEntry = record?.workspaceEncryptionKeys.find(
        (entry) => entry.encryptionKeyId === pkg.recipientKeyId && !entry.revokedAt,
      );
      if (activeEntry) {
        throw new SwmSenderKeySetupRejectionError(
          'active-private-key-missing',
          `No local X25519 private key for DKG agent ${recipientAgentAddress} key ${pkg.recipientKeyId}`,
        );
      }
      const revokedEntry = record?.workspaceEncryptionKeys.find(
        (entry) => entry.encryptionKeyId === pkg.recipientKeyId && entry.revokedAt,
      );
      if (revokedEntry) {
        throw new SwmSenderKeySetupRejectionError(
          'revoked-key',
          `Recipient key ${pkg.recipientKeyId} for DKG agent ${recipientAgentAddress} ` +
          `was revoked at ${revokedEntry.revokedAt}; refusing to bootstrap a new sender-key ` +
          'epoch against a retired key. The sender must resolve the agent profile and retry ' +
          'against an active key.',
        );
      }
      throw new StaleSenderKeyTargetError(recipientAgentAddress, pkg.recipientKeyId);
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

  async decryptWorkspacePayloadWithSenderKey(this: DKGAgent,
    message: SwmSenderKeyMessageMsg,
    contextGraphId: string,
    ctx: OperationContext,
  ): Promise<Uint8Array> {
    await this.loadSwmSenderKeyState();
    const messageIndex = uint64ForProto(message.messageIndex);
    let senderAgentAddress = message.senderAgentAddress;
    if (message.contextGraphId !== contextGraphId) {
      const reason = `Sender Key message contextGraphId "${message.contextGraphId}" does not match envelope "${contextGraphId}"`;
      throw new Error(reason);
    }
    senderAgentAddress = ethers.getAddress(message.senderAgentAddress);
    const state = this.swmSenderKeyReceiveStates.get(
      swmReceiverStateKey(contextGraphId, message.subGraphName, senderAgentAddress, message.epochId),
    );
    if (!state) {
      const reason = `No local Sender Key state for ${senderAgentAddress} epoch ${message.epochId}`;
      this.log.warn(
        ctx,
        `SWM sender-key broadcast receive denied: reason=no-state senderAgent=${senderAgentAddress} ` +
        `contextGraph=${contextGraphId}${message.subGraphName ? `/${message.subGraphName}` : ''} ` +
        `epoch=${message.epochId} messageIndex=${messageIndex} membershipHash=${message.membershipHash}`,
      );
      throw new Error(reason);
    }
    if (state.membershipHash !== message.membershipHash) {
      const reason = `Sender Key membership hash mismatch for ${senderAgentAddress} epoch ${message.epochId}`;
      throw new Error(reason);
    }

    let chainKey = state.skippedChainKeys.get(messageIndex);
    let usedSkippedKey = false;
    if (chainKey) {
      usedSkippedKey = true;
      state.skippedChainKeys.delete(messageIndex);
    } else {
      if (messageIndex < state.nextMessageIndex) {
        const reason = `Sender Key replay rejected for index ${messageIndex}`;
        throw new Error(reason);
      }
      const gap = messageIndex - state.nextMessageIndex;
      if (gap > SWM_SENDER_KEY_SKIPPED_MESSAGE_CACHE_LIMIT) {
        const reason = `Sender Key message gap ${gap} exceeds skipped-message cache limit`;
        throw new Error(reason);
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

    const assetUal = await this.resolveKaLifecycleAssetUalFromWorkspacePlaintext(decrypted.plaintext, ctx);
    if (assetUal) {
      logKaLifecycleEvent(this.log, ctx, {
        assetUal,
        stage: 'sender_key',
        event: 'sender_key_payload_decrypted',
        role: 'receiver',
        localPeerId: this.peerId,
        localNodeIdentityId: this.identityId.toString(),
        metadata: {
          contextGraphId,
          subGraphName: message.subGraphName,
          senderAgentAddress,
          epochId: message.epochId,
          messageIndex,
          membershipHash: message.membershipHash,
        },
      });
    }

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

  async resolveKaLifecycleAssetUalFromWorkspacePlaintext(this: DKGAgent, plaintext: Uint8Array, ctx?: OperationContext): Promise<string | undefined> {
    try {
      const request = decodeWorkspacePublishRequest(plaintext);
      return this.resolveKaLifecycleAssetUalFromIdentity(request.agentAddress, request.kaNumber, ctx);
    } catch {
      return undefined;
    }
  }

  async resolveKaLifecycleAssetUalFromIdentity(this: DKGAgent, agentAddress?: string, kaNumber?: string, ctx?: OperationContext): Promise<string | undefined> {
    if (!agentAddress || !kaNumber) return undefined;
    try {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<typeof TIMEOUT_SENTINEL>((resolve) => {
        timer = setTimeout(() => resolve(TIMEOUT_SENTINEL), KA_LIFECYCLE_ASSET_UAL_RESOLVE_TIMEOUT_MS);
        timer.unref?.();
      });
      const result = await Promise.race([
        resolveAssetUalFromKaIdentity(this.chain, { agentAddress, kaNumber })
          .finally(() => { if (timer) clearTimeout(timer); }),
        timeout,
      ]);
      if (result === TIMEOUT_SENTINEL) {
        this.log.warn(
          ctx ?? createOperationContext('share'),
          `KA lifecycle assetUal derivation exceeded ${KA_LIFECYCLE_ASSET_UAL_RESOLVE_TIMEOUT_MS}ms; continuing without lifecycle assetUal`,
        );
        return undefined;
      }
      return result;
    } catch {
      return undefined;
    }
  }

  isSwmSenderKeyPayloadDebugLoggingEnabled(this: DKGAgent): boolean {
    const raw = process.env.DKG_SWM_SENDER_KEY_DEBUG_PAYLOADS;
    return raw === '1' || raw?.toLowerCase() === 'true';
  }

  logSwmSenderKeyDebugPlainPayload(this: DKGAgent,
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

  logSwmSenderKeyDebugEncryptedPayload(this: DKGAgent,
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

  hasLocalAgent(this: DKGAgent, agentAddress: string): boolean {
    const checksum = ethers.getAddress(agentAddress);
    for (const record of this.localAgents.values()) {
      if (record.agentAddress.toLowerCase() === checksum.toLowerCase()) {
        return true;
      }
    }
    return false;
  }

  getLocalSigningAgentForAddress(this: DKGAgent, agentAddress: string): (AgentKeyRecord & { privateKey: string }) | null {
    const checksum = ethers.getAddress(agentAddress);
    for (const record of this.localAgents.values()) {
      if (record.agentAddress.toLowerCase() === checksum.toLowerCase() && record.privateKey) {
        return { ...record, privateKey: record.privateKey };
      }
    }
    return null;
  }

  swmSenderKeyStatePath(this: DKGAgent): string | null {
    if (!this.config.dataDir) return null;
    return `${this.config.dataDir}/swm-sender-keys.json`;
  }

  async loadSwmSenderKeyState(this: DKGAgent): Promise<void> {
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
        pending?: Array<Record<string, unknown>>;
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
      const pendingByAgent = new Map<string, PendingSenderKeyEntry[]>();
      let skippedPendingRows = 0;
      for (const entry of parsed.pending ?? []) {
        let pending: PendingSenderKeyEntry;
        try {
          pending = deserializePendingSenderKeyEntry(entry);
        } catch (err) {
          skippedPendingRows += 1;
          const raw = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {};
          const sender = typeof raw.senderAgentAddress === 'string' ? raw.senderAgentAddress : 'unknown-sender';
          const recipient = typeof raw.recipientAgentAddress === 'string' ? raw.recipientAgentAddress : 'unknown-recipient';
          const contextGraph = typeof raw.contextGraphId === 'string' ? raw.contextGraphId : 'unknown-context-graph';
          const subGraph = typeof raw.subGraphName === 'string' ? `/${raw.subGraphName}` : '';
          this.log.warn(
            createOperationContext('share'),
            `Skipped malformed SWM sender-key pending row #${skippedPendingRows} ` +
            `(sender=${sender}, recipient=${recipient}, contextGraph=${contextGraph}${subGraph}): ` +
            `${err instanceof Error ? err.message : String(err)}`,
          );
          continue;
        }
        const recipientKey = pending.recipientAgentAddress.toLowerCase();
        const queue = pendingByAgent.get(recipientKey) ?? [];
        queue.push(pending);
        pendingByAgent.set(recipientKey, queue);
      }
      this.pendingSenderKeyByAgent.clear();
      for (const [recipientKey, queue] of pendingByAgent.entries()) {
        this.pendingSenderKeyByAgent.set(recipientKey, queue);
      }
    } catch {
      // No durable state yet, or a corrupt file that should not unblock startup.
      this.swmSenderKeySendStates.clear();
      this.swmSenderKeyReceiveStates.clear();
      this.pendingSenderKeyByAgent.clear();
    }
  }

  async saveSwmSenderKeyState(this: DKGAgent): Promise<void> {
    const path = this.swmSenderKeyStatePath();
    if (!path) return;
    const { mkdir, writeFile, chmod } = await import('node:fs/promises');
    const { dirname } = await import('node:path');
    await mkdir(dirname(path), { recursive: true });
    const payload = {
      version: 1,
      send: [...this.swmSenderKeySendStates.values()].map(serializeSwmSenderSendState),
      receive: [...this.swmSenderKeyReceiveStates.values()].map(serializeSwmSenderReceiveState),
      pending: [...this.pendingSenderKeyByAgent.values()]
        .flatMap((queue) => queue.map(serializePendingSenderKeyEntry)),
    };
    await writeFile(path, JSON.stringify(payload, null, 2), { mode: 0o600 });
    try {
      await chmod(path, 0o600);
    } catch {
      // Best-effort on platforms/filesystems that do not support chmod.
    }
  }

  async resolveWorkspaceGossipSigningAgent(this: DKGAgent,
    contextGraphId: string,
  ): Promise<(AgentKeyRecord & { privateKey: string }) | null> {
    const authority = await this.resolveContextGraphAgentGateAuthority(contextGraphId);
    if (authority.kind === 'ungated') {
      return this.getWorkspaceGossipSigningAgent();
    }
    if (authority.kind === 'unavailable') {
      const message =
        `Cannot gossip SWM write for context graph "${contextGraphId}": signing authority is unavailable (${authority.reason})`;
      throw createContextGraphAuthorityError(message, authority);
    }

    const allowedAgents = authority.agentAddresses;

    // An available-but-empty gate is authoritative (for example an empty
    // chain roster or a fully revoked legacy gate), so retrying cannot help.
    if (allowedAgents.length === 0) {
      throw new Error(
        `Cannot gossip SWM write for context graph "${contextGraphId}": authoritative signing roster is empty`,
      );
    }

    const allowedSet = new Set(allowedAgents.map((agent) => agent.toLowerCase()));
    for (const record of this.localAgents.values()) {
      if (record.privateKey && allowedSet.has(record.agentAddress.toLowerCase())) {
        return { ...record, privateKey: record.privateKey };
      }
    }

    throw new Error(`Cannot gossip SWM write for agent-gated context graph "${contextGraphId}": no local allowed signing agent key`);
  }

  async encodeWorkspaceGossipMessage(this: DKGAgent,
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

}
