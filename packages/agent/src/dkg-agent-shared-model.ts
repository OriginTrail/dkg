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
    const isMember = await this.isPeerContextGraphMember(req.contextGraphId, fromPeerId).catch(() => false);
    const promptChars = req.messages.reduce((n, m) => n + m.content.length, 0);
    const promptOk = !!st && promptChars <= st.config.maxPromptChars;
    const quotaOk = !!st && st.quota.allow(fromPeerId);

    const decision = decideSharedModelAuthorization({
      enabled: grant.enabled,
      providerConfigured: !!st && st.config.enabled,
      isMember,
      quotaOk,
      promptOk,
    });
    if (!decision.ok) {
      this.log.info(ctx, `shared-model invoke denied cg=${req.contextGraphId} from=${fromPeerId}: ${decision.denied}`);
      return encodeInvokeResponse({ ok: false, denied: decision.denied });
    }
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
    // Local fast-path: this node is the curator (no network hop).
    if (await this.isContextGraphCuratorSelf(contextGraphId)) {
      const st = STATE.get(this);
      const grant = await this.getContextGraphModelGrant(contextGraphId);
      const selfKey = callerAgentAddress ?? this.getDefaultAgentAddress?.() ?? 'self';
      const promptChars = messages.reduce((n, m) => n + m.content.length, 0);
      const decision = decideSharedModelAuthorization({
        enabled: grant.enabled,
        providerConfigured: !!st && st.config.enabled,
        isMember: true,
        quotaOk: !!st && st.quota.allow(selfKey),
        promptOk: !!st && promptChars <= st.config.maxPromptChars,
      });
      if (!decision.ok) return { ok: false, denied: decision.denied };
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

    // Remote path: send to the curator's node over P2P.
    const peerId = await this.resolveCuratorPeerId(contextGraphId);
    if (!peerId) return { ok: false, denied: 'could not resolve curator peer for this context graph' };
    const reqBytes = encodeInvokeRequest({ contextGraphId, messages, maxTokens: opts.maxTokens, temperature: opts.temperature });
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

  private async isContextGraphCuratorSelf(this: DKGAgent, contextGraphId: string): Promise<boolean> {
    const owner = await this.getContextGraphOwner(contextGraphId);
    if (!owner) return false;
    const mine = new Set<string>();
    const addr = this.getDefaultAgentAddress?.();
    if (addr) mine.add(`did:dkg:agent:${addr}`.toLowerCase());
    if (this.peerId) mine.add(`did:dkg:agent:${this.peerId}`.toLowerCase());
    return mine.has(owner.toLowerCase());
  }

  /**
   * Membership for the remote path is verified against the set of APPROVED,
   * UNEXPIRED delegatee peers for the CG — exactly the set used by the sync
   * auth path. We reuse the canonical {@link getContextGraphAllowedDelegateePeers}
   * helper (WorkspaceCryptoMethods mixin) so the gate reads ONLY the
   * curator-approved `allowedDelegateePeer` bindings and never the
   * self-asserted, pre-approval `delegationDelegateePeer` value written at
   * join-request time. A pending, rejected, or removed peer is therefore
   * correctly denied (a removed peer's `did:dkg:agent-delegation:*` subject is
   * deleted by `removeAgentFromContextGraph`, so it drops out of this set).
   *
   * The libp2p `fromPeerId` is cryptographically authenticated by the
   * transport, so matching it against an approved delegatee peer authorises
   * the request without a separate signature.
   */
  private async isPeerContextGraphMember(this: DKGAgent, contextGraphId: string, peerId: string): Promise<boolean> {
    // Map<agentLower, peerId[]> — flatten to the union of all approved peers;
    // any approved delegatee node may invoke on the model the curator bills.
    const byAgent = await this.getContextGraphAllowedDelegateePeers(contextGraphId);
    for (const peers of byAgent.values()) {
      if (peers.includes(peerId)) return true;
    }
    return false;
  }
}
