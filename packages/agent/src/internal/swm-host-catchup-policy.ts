// SPDX-License-Identifier: Apache-2.0

import { createOperationContext, type Logger } from '@origintrail-official/dkg-core';
import { CONTEXT_GRAPH_AUTHORITY_RPC_SITES as CG_AUTH_RPC_SITES, withRpcUsageSite, type ChainAdapter } from '@origintrail-official/dkg-chain';
import { verifySignedCatchupRequest, type CatchupReplayGuard } from '../swm/host-catchup-sign.js';
import type { decodeSwmHostCatchupRequest } from '../swm/host-catchup-wire.js';
import { normalizeContextGraphNameHash } from '../context-graph-name-candidate.js';
import { localContextGraphIdMatchesCommittedNameHash, type ContextGraphBindingState, type ContextGraphBindingSubscription } from '../context-graph-binding-state.js';

interface HostPolicyIdentityPorts {
  readonly subscriptions: ReadonlyMap<string, ContextGraphBindingSubscription & { onChainHash?: string }>;
  readonly bindings: ContextGraphBindingState;
  readonly wireOwners: ReadonlyMap<string, string>;
  localId(contextGraphId: string): string;
  hostKey(contextGraphId: string): string;
}

/** Policy evidence belongs to one local identity and authoritative/reverse generation. */
function captureHostPolicyIdentity(ports: HostPolicyIdentityPorts, contextGraphId: string) {
  const localId = ports.localId(contextGraphId);
  const hostKey = ports.hostKey(contextGraphId);
  const subscription = ports.subscriptions.get(localId);
  const onChainId = subscription?.onChainId;
  const onChainHash = subscription?.onChainHash;
  const target = ports.bindings.captureTarget(localId, subscription);
  const wireOwner = ports.wireOwners.get(hostKey);
  const current = () => {
    return ports.localId(contextGraphId) === localId && ports.hostKey(contextGraphId) === hostKey
      && ports.subscriptions.get(localId)?.onChainId === onChainId
      && ports.subscriptions.get(localId)?.onChainHash === onChainHash
      && ports.bindings.targetStillCurrent(localId, ports.subscriptions.get(localId), target)
      && ports.wireOwners.get(hostKey) === wireOwner;
  };
  return { current, onChainId: target.bindingKind === 'unbound' ? undefined : target.onChainId };
}

export function captureHostPolicyIdentityCurrent(ports: HostPolicyIdentityPorts, contextGraphId: string): () => boolean {
  return captureHostPolicyIdentity(ports, contextGraphId).current;
}

interface CatchupPolicyPorts {
  hostKey(contextGraphId: string): string;
  classification(hostKey: string): boolean | undefined;
  publicReaderEnabled(hostKey: string): boolean;
  confirmedPublic(contextGraphId: string): Promise<boolean>;
  capture(contextGraphId: string): { current(): boolean; onChainId?: string };
}

/**
 * One owner for the shared classification/public proof and its two uses.
 * Serving under the strip requires a locally non-curated classification and
 * a chain-confirmed accessPolicy=0/publishPolicy=1 (short TTL, fail closed).
 * Ordinary-reader admission additionally requires hostPublic and a live host
 * subscription. Signature/freshness/replay checks remain at the caller, which
 * explicitly re-evaluates this policy after authentication.
 *
 * The local gate bounds RPCs to classified graphs. Unknown/curated graphs do
 * not probe; resolver errors are structured denial rather than transport failure.
 */
export async function evaluateHostCatchupPolicy(
  ports: CatchupPolicyPorts,
  contextGraphId: string,
  purpose: 'serving' | 'public-reader',
): Promise<
  | { mayServeUnderStrip: false; mayAdmitPublicReader: false }
  | { mayServeUnderStrip: true; mayAdmitPublicReader: boolean; current(): boolean; onChainId?: string }
> {
  const denied = { mayServeUnderStrip: false, mayAdmitPublicReader: false } as const;
  const hostKey = ports.hostKey(contextGraphId);
  if (ports.classification(hostKey) !== false
    || (purpose === 'public-reader' && !ports.publicReaderEnabled(hostKey))) return denied;
  const captured = ports.capture(contextGraphId);
  const current = () => captured.current() && ports.classification(hostKey) === false
    && (purpose !== 'public-reader' || ports.publicReaderEnabled(hostKey));
  try {
    if (!await ports.confirmedPublic(contextGraphId) || !current()
      || ports.classification(hostKey) !== false) return denied;
  } catch { return denied; }
  return { mayServeUnderStrip: true, mayAdmitPublicReader: ports.publicReaderEnabled(hostKey) && captured.onChainId !== undefined,
    current, onChainId: captured.onChainId };
}

/** Bind graph identity and catch-up policy to the caller's active gossip lifetime. */
export function createHostModePublicPolicy(ports: HostPolicyIdentityPorts & Omit<CatchupPolicyPorts, 'capture'> & {
  current(): boolean;
  isWireIdKeyedSubscription(localId: string): boolean;
}) {
  const capture = (id: string) => {
    const evidence = captureHostPolicyIdentity(ports, id);
    return { ...evidence, current: () => ports.current() && evidence.current() };
  };
  const captureCurrent = (id: string) => capture(id).current;
  return {
    captureCurrent,
    captureCanonicalHandoff: (id: string): (() => boolean) => {
      const wireId = normalizeContextGraphNameHash(id);
      const localId = ports.localId(id);
      const original = ports.subscriptions.get(localId);
      const target = ports.bindings.captureTarget(localId, original);
      return () => {
        if (!ports.current() || wireId === null || localId !== wireId || target.bindingKind === 'unbound') return false;
        const nextLocalId = ports.localId(id);
        const next = ports.subscriptions.get(nextLocalId);
        return nextLocalId !== localId && localContextGraphIdMatchesCommittedNameHash(nextLocalId, wireId, ports.isWireIdKeyedSubscription)
          && next?.onChainHash === wireId && ports.wireOwners.get(wireId) === nextLocalId
          && ports.bindings.currentBindingFor(nextLocalId, next)?.onChainId === target.onChainId;
      };
    },
    evaluate: (id: string, purpose: 'serving' | 'public-reader') =>
      evaluateHostCatchupPolicy({ ...ports, capture }, id, purpose),
  };
}

/** Exact local identity wins; absent raw wire requests use native routing. */
export function resolveAutomaticHostModeLocalId(contextGraphId: string, ports: {
  subscriptions: ReadonlyMap<string, unknown>;
  dormant: ReadonlyMap<string, unknown>;
  resolveAlias(id: string): string | null;
}): string {
  if (ports.subscriptions.has(contextGraphId) || ports.dormant.has(contextGraphId)) return contextGraphId;
  const wireId = normalizeContextGraphNameHash(contextGraphId);
  if (wireId === null) return contextGraphId;
  if (ports.subscriptions.has(wireId) || ports.dormant.has(wireId)) return wireId;
  return ports.resolveAlias(wireId) ?? wireId;
}

interface HostCatchupAuthorizationPorts {
  readonly publicPolicy: ReturnType<typeof createHostModePublicPolicy>;
  readonly replay: Pick<CatchupReplayGuard, 'recordIfFresh'>;
  readonly chain: Pick<ChainAdapter, 'getIdentityIdForAddress'>;
  readonly log: Pick<Logger, 'debug'>;
  participants(id: string): Promise<string[] | null>;
  beaconCurator(id: string): Promise<string | null | undefined>;
  agentGate(id: string): Promise<string[] | null>;
  allowedPeers(id: string): Promise<string[] | null>;
}

/** Authenticated requests retain their authority/lifetime capture through the asynchronous read. */
export async function authorizeHostCatchupRequest(
  ports: HostCatchupAuthorizationPorts,
  req: ReturnType<typeof decodeSwmHostCatchupRequest>, fromPeerId: string, nowMs: number,
): Promise<{ ok: true; recoveredSigner: string; current(): boolean; publicOnChainId?: string } | { ok: false; reason: string }> {
    // 1. signature + freshness. `verifySignedCatchupRequest` re-runs
    //    `computeCatchupRequestDigest` over the same numerical fields
    //    the client signed; pass defined defaults for the optional
    //    `maxEntries`/`maxBytes` so the encoded uint256 layout matches.
    const verify = verifySignedCatchupRequest(
      {
        version: req.version,
        contextGraphId: req.contextGraphId,
        sinceSeqno: req.sinceSeqno,
        maxEntries: req.maxEntries ?? 0,
        maxBytes: req.maxBytes ?? 0,
        requesterEoa: req.requesterEoa,
        issuedAtMs: req.issuedAtMs,
        nonce: req.nonce,
        sig: req.sig,
      },
      nowMs,
    );
    if (!verify.ok || !verify.recoveredSigner) {
      return { ok: false, reason: verify.reason ?? 'signature verification failed' };
    }
    const requesterEoa = verify.recoveredSigner;
    const current = ports.publicPolicy.captureCurrent(req.contextGraphId);

    // 2. replay-defence
    if (!ports.replay.recordIfFresh(requesterEoa, req.nonce, req.issuedAtMs, nowMs)) {
      return { ok: false, reason: 'replayed catchup nonce' };
    }

    // Public host custody is explicitly enabled and re-confirmed locally.
    // Authentication and replay defence above apply equally to ordinary readers.
    const publicPolicy = await ports.publicPolicy.evaluate(req.contextGraphId, 'public-reader');
    if (publicPolicy.mayAdmitPublicReader && publicPolicy.onChainId !== undefined) {
      return { ok: true, recoveredSigner: requesterEoa, current: publicPolicy.current, publicOnChainId: publicPolicy.onChainId };
    }

    // The authority sources below use UNION semantics: any source
    // that recognises the requester EOA (or, as transport-layer
    // fallback, the peer-id) is sufficient to accept. Codex PR #618
    // R2 caught a fail-closed bug in the prior implementation where
    // `chainParticipants` was treated as authoritative — if the
    // chain returned a set that didn't include a legitimate
    // delegatee or allowed-agent, we'd hard-deny without checking
    // the locally-persisted allowlist. The current logic accepts
    // on the first match across:
    //   3a. on-chain participant agents
    //   3b. beacon-pinned curator (pre-registration)
    //   3c. locally-persisted agent-gate set (allowedAgent UNION
    //       participantAgent from _meta + subscription cache)
    //   3d. transport-layer allowedPeers (libp2p peer-id allowlist)
    //   3e. registered node-operator EOA for ciphertext-only host catchup
    // Only if none accept do we deny.
    const requesterLower = requesterEoa.toLowerCase();
    let anyAuthoritySourceFound = false;

    try {
      const chainParticipants = await withRpcUsageSite(
        CG_AUTH_RPC_SITES.hostCatchUp,
        () => ports.participants(req.contextGraphId),
      );
      if (chainParticipants !== null) {
        anyAuthoritySourceFound = true;
        if (chainParticipants.some((a) => a.toLowerCase() === requesterLower)) {
          return { ok: true, recoveredSigner: requesterEoa, current };
        }
      }
    } catch {
      // Adapter probe failure is non-fatal; fall through to other sources.
    }

    try {
      const beaconCurator = await ports.beaconCurator(req.contextGraphId);
      if (beaconCurator) {
        anyAuthoritySourceFound = true;
        if (beaconCurator.toLowerCase() === requesterLower) {
          return { ok: true, recoveredSigner: requesterEoa, current };
        }
      }
    } catch {
      // Beacon cache miss is non-fatal.
    }

    // Locally-persisted agent gate: `getContextGraphAgentGateAddresses`
    // unions `dkg:allowedAgent` + `dkg:participantAgent` from the CG's
    // `_meta` graph and the in-memory subscription cache. On a member-
    // side host this is the canonical allowlist + delegatee set;
    // chain-derived sets often miss recently-approved delegatees that
    // haven't been mirrored on chain yet.
    try {
      const agentGate = await withRpcUsageSite(
        CG_AUTH_RPC_SITES.hostCatchUp,
        () => ports.agentGate(req.contextGraphId),
      );
      if (agentGate !== null) {
        anyAuthoritySourceFound = true;
        if (agentGate.some((a) => a.toLowerCase() === requesterLower)) {
          return { ok: true, recoveredSigner: requesterEoa, current };
        }
      }
    } catch {
      // Local-meta probe failure is non-fatal.
    }

    // Transport-layer ACL (libp2p peer-id allowlist). Only meaningful
    // on nodes that have persisted the CG's `allowedPeers`; host-only
    // cores never see it.
    try {
      const allowedPeers = await ports.allowedPeers(
        req.contextGraphId,
      );
      if (allowedPeers !== null) {
        anyAuthoritySourceFound = true;
        if (allowedPeers.includes(fromPeerId)) {
          return { ok: true, recoveredSigner: requesterEoa, current };
        }
      }
    } catch {
      // local-meta probe failure is non-fatal; the deny below still applies.
    }

    // Ciphertext host-catchup parity with LU-11 chunk-catchup: the responder
    // serves opaque SWM envelopes, not decrypted triples. A requester that can
    // prove control of a registered node-operator EOA is allowed to fetch these
    // bytes so host-only cores and member daemons whose operational wallet is
    // distinct from their DKG agent address can recover missed ciphertext.
    if (typeof ports.chain.getIdentityIdForAddress === 'function') {
      try {
        const reqIdentityId = await ports.chain.getIdentityIdForAddress(requesterEoa);
        if (reqIdentityId > 0n) {
          anyAuthoritySourceFound = true;
          ports.log.debug(
            createOperationContext('share'),
            `host-catchup admitted via node-operator authority cg=${req.contextGraphId} requesterEoa=${requesterEoa} identityId=${reqIdentityId.toString()}`,
          );
          return { ok: true, recoveredSigner: requesterEoa, current };
        }
      } catch (err) {
        ports.log.debug(
          createOperationContext('share'),
          `host-catchup node-operator probe failed cg=${req.contextGraphId} requesterEoa=${requesterEoa}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    const reason = anyAuthoritySourceFound
      ? 'requester EOA not in any of: on-chain participants, beacon curator, local agent-gate, allowedPeers, node-operator-registry'
      : 'no authority source available for context graph';
    return { ok: false, reason };
}
