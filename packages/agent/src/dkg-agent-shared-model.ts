import {
  createOperationContext,
  contextGraphMetaGraphUri,
  contextGraphDataGraphUri,
  PROTOCOL_SHARED_MODEL_INVOKE,
} from '@origintrail-official/dkg-core';
import type { DKGAgent } from './dkg-agent.js';
import type { Quad } from '@origintrail-official/dkg-storage';
import {
  SHARED_MODEL_PREDICATES,
  sanitizeModelId,
  type SharedModelGrant,
  type SharedModelMessage,
  type SharedModelRuntimeConfig,
  type SharedModelInvokeResponse,
} from './shared-model/types.js';
import { SharedModelClient } from './shared-model/client.js';
import { DailyQuota } from './shared-model/quota.js';
import { decideSharedModelAuthorization } from './shared-model/authorize.js';
import {
  encodeInvokeRequest,
  decodeInvokeRequest,
  encodeInvokeResponse,
  decodeInvokeResponse,
} from './shared-model/wire.js';

interface SharedModelState {
  config: SharedModelRuntimeConfig;
  quota: DailyQuota;
  client: SharedModelClient;
}

// Per-agent runtime state held off-instance so this mixin needs no constructor
// wiring. The API key lives here, in memory only.
const STATE = new WeakMap<object, SharedModelState>();

export interface InvokeOpts {
  maxTokens?: number;
  temperature?: number;
}

/**
 * Fallback transport budget (ms) for the remote invoke when this node has no
 * shared-model runtime config (a pure member node never calls
 * `configureSharedModel`, so STATE is unset there). Matches the daemon's
 * `invokeTimeoutMs` default and comfortably exceeds real LLM latency, unlike
 * the router default (`DEFAULT_SEND_TIMEOUT_MS`, 20s).
 */
const DEFAULT_INVOKE_TIMEOUT_MS = 120_000;

export class SharedModelMethods {
  /**
   * Attach/replace this node's shared-model runtime config. Called by the
   * daemon lifecycle after agent creation (and directly by tests).
   */
  configureSharedModel(this: DKGAgent, config: SharedModelRuntimeConfig): void {
    STATE.set(this, {
      config,
      quota: new DailyQuota(config.dailyRequestQuotaPerAgent),
      client: new SharedModelClient(),
    });
  }

  /** Curator toggles model sharing for a CG (writes the `_meta` grant). */
  async setContextGraphModelSharing(
    this: DKGAgent,
    contextGraphId: string,
    enabled: boolean,
    opts: { callerAgentAddress?: string; modelId?: string } = {},
  ): Promise<void> {
    const owner = await this.getContextGraphOwner(contextGraphId);
    if (!owner) throw new Error(`context graph "${contextGraphId}" not found`);
    this.assertCallerIsOwner(owner, opts.callerAgentAddress, 'share model access');

    const metaGraph = contextGraphMetaGraphUri(contextGraphId);
    const cgUri = contextGraphDataGraphUri(contextGraphId);
    await this.store.deleteByPattern({ graph: metaGraph, subject: cgUri, predicate: SHARED_MODEL_PREDICATES.ENABLED });
    await this.store.deleteByPattern({ graph: metaGraph, subject: cgUri, predicate: SHARED_MODEL_PREDICATES.MODEL_ID });
    if (!enabled) return;

    const quads: Quad[] = [
      { subject: cgUri, predicate: SHARED_MODEL_PREDICATES.ENABLED, object: '"true"', graph: metaGraph },
    ];
    const modelId = sanitizeModelId(opts.modelId) ?? STATE.get(this)?.config.model;
    if (modelId) {
      quads.push({ subject: cgUri, predicate: SHARED_MODEL_PREDICATES.MODEL_ID, object: `"${modelId}"`, graph: metaGraph });
    }
    await this.store.insert(quads);
  }

  /** Read the per-CG grant from `_meta`. */
  async getContextGraphModelGrant(this: DKGAgent, contextGraphId: string): Promise<SharedModelGrant> {
    const metaGraph = contextGraphMetaGraphUri(contextGraphId);
    const cgUri = contextGraphDataGraphUri(contextGraphId);
    const result = await this.store.query(
      `SELECT ?p ?o WHERE { GRAPH <${metaGraph}> {
        <${cgUri}> ?p ?o .
        FILTER(?p IN (<${SHARED_MODEL_PREDICATES.ENABLED}>, <${SHARED_MODEL_PREDICATES.MODEL_ID}>))
      } }`,
    );
    let enabled = false;
    let modelId: string | undefined;
    if (result.type === 'bindings') {
      for (const row of result.bindings as Array<Record<string, string>>) {
        const p = row['p'];
        const o = (row['o'] ?? '').replace(/^"|"$/g, '');
        if (p === SHARED_MODEL_PREDICATES.ENABLED && o === 'true') enabled = true;
        if (p === SHARED_MODEL_PREDICATES.MODEL_ID) modelId = o;
      }
    }
    return { enabled, modelId };
  }

  /** Server side: handle an incoming P2P invoke from a member node. */
  async handleSharedModelInvoke(this: DKGAgent, data: Uint8Array, fromPeerId: string): Promise<Uint8Array> {
    const ctx = createOperationContext('share');
    let req;
    try {
      req = decodeInvokeRequest(data);
    } catch (err) {
      return encodeInvokeResponse({ ok: false, denied: `malformed request: ${err instanceof Error ? err.message : String(err)}` });
    }

    const st = STATE.get(this);
    const grant = await this.getContextGraphModelGrant(req.contextGraphId).catch(() => ({ enabled: false }) as SharedModelGrant);
    // SECURITY INVARIANT (per-agent membership binding):
    // `fromPeerId` is cryptographically authenticated by libp2p; the request
    // body may CLAIM any `agentAddress`, but it is authorized ONLY if THAT
    // specific agent recorded `fromPeerId` as one of its approved delegatee
    // peers. We bind the lookup to the claimed agent (lowercased — the helper
    // keys are lowercased; peer-ids stay case-sensitive) exactly as the sync
    // auth path binds to `requesterAgentAddress`. A missing/empty claim is
    // DENIED — there is NO union fallback. This defeats:
    //   (a) pending requesters     — not in the curator-APPROVED set at all;
    //   (b) impersonation          — the attacker's peer won't equal the
    //                                victim agent's recorded delegatee peer;
    //   (c) multi-agent inheritance — only the one approved agent whose
    //                                binding matches `fromPeerId` is allowed,
    //                                not every agent that shares the node.
    const isMember = await this.isAgentPeerContextGraphMember(req.contextGraphId, req.agentAddress, fromPeerId).catch(() => false);
    const promptChars = req.messages.reduce((n, m) => n + m.content.length, 0);
    const promptOk = !!st && promptChars <= st.config.maxPromptChars;
    // Quota is a non-mutating PEEK for the decision; the counter is consumed
    // only AFTER authorization succeeds (see below), so a request denied for
    // any other reason never burns the member's daily allowance.
    const quotaOk = !!st && st.quota.remaining(fromPeerId) > 0;

    const decision = decideSharedModelAuthorization({
      enabled: grant.enabled,
      providerConfigured: !!st && st.config.enabled,
      isMember,
      quotaOk,
      promptOk,
    });
    if (!decision.ok) {
      this.log.info(ctx, `shared-model invoke denied cg=${req.contextGraphId} from=${fromPeerId} agent=${req.agentAddress ?? 'n/a'}: ${decision.denied}`);
      return encodeInvokeResponse({ ok: false, denied: decision.denied });
    }
    // Authorized: consume exactly one quota unit before the provider call.
    st!.quota.allow(fromPeerId);
    try {
      const completion = await st!.client.complete(st!.config, req.messages, {
        maxTokens: req.maxTokens,
        temperature: req.temperature,
        providerTimeoutMs: st!.config.providerTimeoutMs,
      });
      return encodeInvokeResponse({ ok: true, content: completion.content, model: completion.model });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.log.warn(ctx, `shared-model provider error cg=${req.contextGraphId}: ${reason}`);
      return encodeInvokeResponse({ ok: false, denied: `provider error: ${reason}` });
    }
  }

  /** Client/dispatcher: a member invokes the curator's shared model. */
  async invokeContextGraphModel(
    this: DKGAgent,
    contextGraphId: string,
    messages: SharedModelMessage[],
    opts: InvokeOpts = {},
    callerAgentAddress?: string,
  ): Promise<SharedModelInvokeResponse> {
    // Local fast-path: this node hosts the CG's curator (no network hop). We
    // take this path iff the CG owner is one of THIS node's local agents — not
    // merely the default agent — so a multi-agent node serves CGs curated by
    // any of its agents locally instead of dialing itself.
    if (await this.isContextGraphCuratorSelf(contextGraphId)) {
      const st = STATE.get(this);
      const grant = await this.getContextGraphModelGrant(contextGraphId);
      // Caller-scoped authorization for the local path. The default-agent /
      // node-token fallback (`getDefaultAgentAddress`) is ONLY used to key the
      // quota bucket; it is NOT a membership grant. Membership is decided
      // explicitly below against the caller's real address.
      const selfKey = callerAgentAddress ?? this.getDefaultAgentAddress?.() ?? 'self';
      const promptChars = messages.reduce((n, m) => n + m.content.length, 0);
      // SECURITY: do NOT hardcode `isMember:true`. The caller is authorized
      // only if it IS the CG owner/curator OR an approved member of the CG.
      // A different LOCAL agent that is neither owner nor member is DENIED
      // here (and must NOT fall through to the remote path, which would dial
      // self). Same per-agent principle as the remote path: hosting an agent
      // on this node grants nothing on a CG that agent didn't curate or join.
      const isMember = await this.isCallerLocalCgMember(contextGraphId, callerAgentAddress).catch(() => false);
      const decision = decideSharedModelAuthorization({
        enabled: grant.enabled,
        providerConfigured: !!st && st.config.enabled,
        isMember,
        // Non-mutating peek; consume happens once, after the decision is ok.
        quotaOk: !!st && st.quota.remaining(selfKey) > 0,
        promptOk: !!st && promptChars <= st.config.maxPromptChars,
      });
      if (!decision.ok) return { ok: false, denied: decision.denied };
      st!.quota.allow(selfKey);
      try {
        const completion = await st!.client.complete(st!.config, messages, {
          ...opts,
          providerTimeoutMs: st!.config.providerTimeoutMs,
        });
        return { ok: true, content: completion.content, model: completion.model };
      } catch (err) {
        return { ok: false, denied: `provider error: ${err instanceof Error ? err.message : String(err)}` };
      }
    }

    // Remote path: send to the curator's node over P2P. The caller's agent
    // address travels in the request so the curator can bind it to the
    // transport peer (see the SECURITY INVARIANT in handleSharedModelInvoke).
    const peerId = await this.resolveCuratorPeerId(contextGraphId);
    if (!peerId) return { ok: false, denied: 'could not resolve curator peer for this context graph' };
    const reqBytes = encodeInvokeRequest({ contextGraphId, messages, maxTokens: opts.maxTokens, temperature: opts.temperature, agentAddress: callerAgentAddress });
    // The whole remote round trip (resolver + dial + write + LLM completion +
    // read) must fit the transport budget. The router default (20s) is shorter
    // than real LLM latency and would surface a false "node unreachable" on a
    // normal completion, so use the configured invoke timeout (member nodes
    // without shared-model config fall back to the matching default).
    const invokeTimeoutMs = STATE.get(this)?.config.invokeTimeoutMs ?? DEFAULT_INVOKE_TIMEOUT_MS;
    const sendResult = await this.messenger.sendReliable(peerId, PROTOCOL_SHARED_MODEL_INVOKE, reqBytes, { timeoutMs: invokeTimeoutMs });
    if (!sendResult.delivered) {
      const reason = 'error' in sendResult ? sendResult.error : 'undelivered';
      return { ok: false, denied: `curator node unreachable: ${reason}` };
    }
    return decodeInvokeResponse(sendResult.response);
  }

  // ---- helpers ----

  /**
   * Does THIS node host the CG's curator? Enumerates ALL of the node's local
   * agents (not just the default), mirroring `getContextGraphCurator`'s
   * local-DID set, so a multi-agent node serves CGs curated by any of its
   * agents on the local fast-path instead of dialing itself. NOTE: this answers
   * "should we take the local path", NOT "is the caller authorized" — the
   * caller is gated separately by {@link isCallerLocalCgMember}.
   */
  private async isContextGraphCuratorSelf(this: DKGAgent, contextGraphId: string): Promise<boolean> {
    const owner = await this.getContextGraphOwner(contextGraphId);
    if (!owner) return false;
    return this.localCgOwnerDids().has(owner.toLowerCase());
  }

  /** Lowercased `did:dkg:agent:*` DIDs for every identity this node hosts. */
  private localCgOwnerDids(this: DKGAgent): Set<string> {
    const mine = new Set<string>();
    const addr = this.getDefaultAgentAddress?.();
    if (addr) mine.add(`did:dkg:agent:${addr}`.toLowerCase());
    if (this.peerId) mine.add(`did:dkg:agent:${this.peerId}`.toLowerCase());
    for (const a of this.localAgents.keys()) {
      mine.add(`did:dkg:agent:${a}`.toLowerCase());
    }
    return mine;
  }

  /**
   * Local-path caller authorization (#2). The CG is curated on THIS node, so
   * there is no transport peer to bind against; we authorize the CALLER's agent
   * address directly. Allowed iff the caller IS the CG owner/curator OR an
   * approved member of the CG. Returns false (DENY) for a different local agent
   * that is neither — the caller must NOT be silently treated as a member just
   * because the curator lives on this node. Comparison is case-insensitive on
   * the (checksummed-or-lowercased) wallet address; the allowed-agent set is
   * sourced from the same curator-authoritative state used everywhere else.
   */
  private async isCallerLocalCgMember(this: DKGAgent, contextGraphId: string, callerAgentAddress: string | undefined): Promise<boolean> {
    // Deny outright with no caller principal. This guard MUST come first: it
    // also stops `isCallerOrNodeOwner(owner, undefined)` below from taking its
    // permissive no-caller branch (which would authorise a node-level token
    // whenever the owner is one of the node's own identities).
    if (!callerAgentAddress) return false;
    // Owner / curator via the CANONICAL check so this gate matches
    // `setContextGraphModelSharing` (which uses `assertCallerIsOwner`) exactly,
    // including the legacy case where the CG owner is stored under the
    // peerId-based DID and the caller is this node's default agent. Without it,
    // a curator could enable sharing on a legacy CG and then be denied invoking
    // their own model.
    const owner = await this.getContextGraphOwner(contextGraphId);
    if (owner && this.isCallerOrNodeOwner(owner, callerAgentAddress)) return true;
    // Approved member? `getContextGraphAllowedAgents` returns bare,
    // quote-stripped wallet addresses (NOT lowercased, NOT DID-framed) minus
    // revoked tombstones — the curator's authoritative allowlist.
    const caller = callerAgentAddress.toLowerCase();
    const allowed = await this.getContextGraphAllowedAgents(contextGraphId);
    return allowed.some((a) => a.toLowerCase() === caller);
  }

  /**
   * Per-agent membership for the remote path (#1). Membership is verified
   * against the set of APPROVED, UNEXPIRED delegatee peers for the CG — exactly
   * the set used by the sync auth path. We reuse the canonical
   * {@link getContextGraphAllowedDelegateePeers} helper (WorkspaceCryptoMethods
   * mixin), which returns `Map<agentLower, peerId[]>` and reads ONLY the
   * curator-approved `allowedDelegateePeer` bindings — never the self-asserted,
   * pre-approval `delegationDelegateePeer` value written at join-request time.
   *
   * UNLIKE the previous union check, we look up ONLY the binding for the
   * SPECIFIC agent the request claims to act on behalf of (`agentAddress`) and
   * require `fromPeerId` to be among THAT agent's approved peers — mirroring
   * the sync path's `allowedDelegateePeers.get(claimedAgent)?.includes(peer)`.
   *
   * Denials (all by construction of the per-agent lookup):
   *   - missing/empty `agentAddress`           → DENY (no union fallback).
   *   - claimed agent has no approved binding  → DENY (e.g. a PENDING joiner:
   *     its `delegationDelegateePeer` is never returned by the helper; or a
   *     REMOVED agent whose `did:dkg:agent-delegation:*` subject was deleted).
   *   - `fromPeerId` not in the claimed agent's binding → DENY (impersonation:
   *     the attacker's authenticated peer won't equal the victim agent's
   *     recorded delegatee peer; and inheritance: a sibling approved agent's
   *     peer is in a DIFFERENT map entry, so it can't satisfy this agent).
   *
   * The libp2p `fromPeerId` is cryptographically authenticated by the
   * transport, so matching it against the claimed agent's approved delegatee
   * peer authorises the request without a separate signature.
   */
  private async isAgentPeerContextGraphMember(
    this: DKGAgent,
    contextGraphId: string,
    agentAddress: string | undefined,
    peerId: string,
  ): Promise<boolean> {
    if (!agentAddress) return false;
    const byAgent = await this.getContextGraphAllowedDelegateePeers(contextGraphId);
    return byAgent.get(agentAddress.toLowerCase())?.includes(peerId) ?? false;
  }
}
