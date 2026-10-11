// SPDX-License-Identifier: Apache-2.0

import { normalizeContextGraphNameHash } from '../context-graph-name-candidate.js';
import type { ContextGraphBindingState, ContextGraphBindingSubscription } from '../context-graph-binding-state.js';

interface HostPolicyIdentityPorts {
  readonly subscriptions: ReadonlyMap<string, ContextGraphBindingSubscription & { onChainHash?: string }>;
  readonly bindings: ContextGraphBindingState;
  readonly wireOwners: ReadonlyMap<string, string>;
  localId(contextGraphId: string): string;
  hostKey(contextGraphId: string): string;
}

/** Policy evidence belongs to one local identity and authoritative/reverse generation. */
export function captureHostPolicyIdentityCurrent(ports: HostPolicyIdentityPorts, contextGraphId: string): () => boolean {
  const localId = ports.localId(contextGraphId);
  const hostKey = ports.hostKey(contextGraphId);
  const subscription = ports.subscriptions.get(localId);
  const onChainId = subscription?.onChainId;
  const onChainHash = subscription?.onChainHash;
  const target = ports.bindings.captureTarget(localId, subscription);
  const wireOwner = ports.wireOwners.get(hostKey);
  return () => {
    return ports.localId(contextGraphId) === localId && ports.hostKey(contextGraphId) === hostKey
      && ports.subscriptions.get(localId) === subscription
      && subscription?.onChainId === onChainId && subscription?.onChainHash === onChainHash
      && ports.bindings.targetStillCurrent(localId, ports.subscriptions.get(localId), target)
      && ports.wireOwners.get(hostKey) === wireOwner;
  };
}

interface CatchupPolicyPorts {
  hostKey(contextGraphId: string): string;
  classification(hostKey: string): boolean | undefined;
  publicReaderEnabled(hostKey: string): boolean;
  confirmedPublic(contextGraphId: string): Promise<boolean>;
  captureCurrent(contextGraphId: string): () => boolean;
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
): Promise<{ mayServeUnderStrip: boolean; mayAdmitPublicReader: boolean }> {
  const denied = { mayServeUnderStrip: false, mayAdmitPublicReader: false };
  const hostKey = ports.hostKey(contextGraphId);
  if (ports.classification(hostKey) !== false
    || (purpose === 'public-reader' && !ports.publicReaderEnabled(hostKey))) return denied;
  const current = ports.captureCurrent(contextGraphId);
  try {
    if (!await ports.confirmedPublic(contextGraphId) || !current()
      || ports.classification(hostKey) !== false) return denied;
  } catch { return denied; }
  return { mayServeUnderStrip: true, mayAdmitPublicReader: ports.publicReaderEnabled(hostKey) };
}

/** Bind graph identity and catch-up policy to the caller's active gossip lifetime. */
export function createHostModePublicPolicy(ports: HostPolicyIdentityPorts & Omit<CatchupPolicyPorts, 'captureCurrent'> & {
  current(): boolean;
}) {
  const captureCurrent = (id: string): (() => boolean) => {
    const bindingCurrent = captureHostPolicyIdentityCurrent(ports, id);
    return () => ports.current() && bindingCurrent();
  };
  return {
    captureCurrent,
    evaluate: (id: string, purpose: 'serving' | 'public-reader') =>
      evaluateHostCatchupPolicy({ ...ports, captureCurrent }, id, purpose),
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
