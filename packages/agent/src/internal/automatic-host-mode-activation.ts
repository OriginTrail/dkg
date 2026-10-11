// SPDX-License-Identifier: Apache-2.0
import { SUBSCRIPTION_SOURCES, SYSTEM_CONTEXT_GRAPHS, createOperationContext, type SubscriptionSource, type Logger } from '@origintrail-official/dkg-core';
import type { DKGAgent } from '../dkg-agent.js';
import type { ContextGraphSub } from '../dkg-agent-types.js';
import type { GossipSession } from '../gossip-session.js';
import { normalizeContextGraphNameHash } from '../context-graph-name-candidate.js';
import type { ContextGraphBindingSubscription } from '../context-graph-binding-state.js';
import type { SwmHostModeSubscriptionBinding } from '../swm/host-mode-store.js';

interface AutomaticHostModePorts {
  current(): boolean;
  admissionAllowed(id: string): boolean;
  restoreBinding(id: string, onChainId: string | undefined): boolean;
  reserved(id: string): boolean;
  legacyAllowed(id: string): boolean;
  unwire(id: string): void;
  member(id: string): boolean;
  source(id: string): SubscriptionSource | undefined;
  curated(id: string): boolean | undefined;
  captureCurrent(id: string): () => boolean;
  captureActivationCurrent(id: string): () => boolean;
  strip(): boolean;
  hostPublic(): boolean;
  probeCurated(id: string): Promise<boolean>;
  accessPolicy(id: string): number | undefined;
  confirmedPublic(id: string): Promise<boolean>;
  wire(id: string, source: SubscriptionSource, curated: boolean): boolean;
  classify(id: string, curated: boolean, bindingCurrent: () => boolean): void;
  persisted(id: string): Promise<void>;
  markRegistered(id: string, current: () => boolean): Promise<void>;
  declined(id: string): void;
  enabled(id: string): void;
  failed(id: string, strip: boolean, error: unknown): void;
}

type AdmissionIntent = 'discovered' | 'persisted-legacy';

/** Admission is distinct from activation; legacy persisted custody is explicit. */
async function admit(
  ports: AutomaticHostModePorts, id: string, intent: AdmissionIntent, current: () => boolean,
): Promise<{ curated: boolean; current: () => boolean } | null> {
  const bindingCurrent = ports.captureCurrent(id);
  const stillCurrent = () => current() && ports.admissionAllowed(id) && bindingCurrent();
  let curated: boolean;
  if (intent === 'persisted-legacy') {
    // Strip-off legacy markers retain custody even without a public proof.
    // A later ordinary reconcile retries that proof rather than freezing this fallback.
    curated = !(ports.hostPublic() && await ports.confirmedPublic(id));
  } else {
    // GH #1611: public plaintext hosting is opt-in and needs both chain policy
    // axes. Numeric policy, verified beacons or private metadata prove curation;
    // a name commitment alone does not prove an access policy.
    const probed = await ports.probeCurated(id);
    if (!stillCurrent()) return null;
    const policy = ports.accessPolicy(id);
    curated = policy === undefined ? probed : policy === 1;
    if (!curated && (!ports.hostPublic() || !await ports.confirmedPublic(id))) return null;
  }
  if (!stillCurrent()) return null;
  // OT-RFC-49 WS-A: with the strip ON, hosting follows access. Declining
  // curated custody starves both legacy .meta and LU-11 chunk ingest, for
  // every discovery path. Members backfill private data from their curator;
  // the explicit false kill-switch preserves legacy automatic custody.
  if (ports.strip() && curated) {
    if (ports.source(id) !== undefined) ports.classify(id, true, bindingCurrent);
    ports.declined(id);
    return null;
  }
  return { curated, current: stillCurrent };
}

/** One fenced activation flow for discovery, retry and persisted restoration. */
function automaticHostModeActivation(ports: AutomaticHostModePorts) {
  const activate = async (id: string, source: SubscriptionSource, intent: AdmissionIntent,
    ownerCurrent: () => boolean): Promise<void> => {
    let activationCurrent = ports.captureActivationCurrent(id);
    const current = () => ports.current() && ownerCurrent() && activationCurrent();
    if (!current() || !ports.admissionAllowed(id) || ports.reserved(id)) return;
    if (!ports.legacyAllowed(id)) {
      // Catalog authority removes an already-wired host as well as refusing
      // another independent path into the legacy SWM topic.
      ports.unwire(id); return;
    }
    // Member apply already covers consumption. The adapter's shape-agnostic
    // probe sees cleartext and wire-hash registration; wiring also refuses it.
    if (ports.member(id)) return;
    if (ports.source(id) === SUBSCRIPTION_SOURCES.MANUAL) {
      // Automatic discovery never takes over the operator's handler or provenance.
      if (ports.strip() && ports.curated(id) === false && await ports.probeCurated(id)) {
        if (!current() || !ports.admissionAllowed(id) || ports.accessPolicy(id) === 0) return;
        ports.classify(id, true, ports.captureCurrent(id));
      }
      if (!current() || !ports.admissionAllowed(id)) return;
      await ports.markRegistered(id, current);
      if (current()) ports.admissionAllowed(id);
      return;
    }
    // Idempotent periodic re-entry still re-probes registration: a CG created
    // offline must not remain on the 6h/1MiB pre-registration retention limits.
    // Canonical host keys make cleartext and wire-hash entry paths equivalent.
    const retainedLegacy = ports.source(id) !== undefined && !ports.strip();
    const admission = await admit(ports, id, retainedLegacy ? 'persisted-legacy' : intent, current);
    if (admission === null || !ports.wire(id, source, admission.curated)) return;
    activationCurrent = ports.captureActivationCurrent(id);
    ports.classify(id, admission.curated, admission.current);
    // Discovery awaits its new designation. Legacy restart preserves its historical
    // nonblocking marker enqueue before the registration probe.
    if (intent === 'discovered') await ports.persisted(id);
    if (!admission.current()) return;
    await ports.markRegistered(id, admission.current);
    if (!admission.current()) return;
    if (intent === 'discovered') ports.enabled(id);
  };
  return {
    reconcile: (id: string, source: SubscriptionSource, current: () => boolean) =>
      activate(id, source, 'discovered', current),
    restore: async (entry: SwmHostModeSubscriptionBinding, strip: boolean, current: () => boolean): Promise<void> => {
      const id = entry.contextGraphId;
      if (!ports.current() || !current() || !ports.admissionAllowed(id)) return;
      try {
        if (!ports.restoreBinding(id, entry.onChainId)) return;
        await activate(id, SUBSCRIPTION_SOURCES.RECONCILER, strip ? 'discovered' : 'persisted-legacy', current);
      } catch (error) { ports.failed(id, strip, error); }
    },
  };
}

interface ActivationLifetimePorts {
  session: GossipSession;
  current(): boolean;
  hostPublic(): boolean;
  log: Logger;
  subscriptions: ReadonlyMap<string, ContextGraphSub>;
}

/** Capture the active agent session and only its current listener custody. */
export function createAutomaticHostModeActivation(agent: DKGAgent, lifetime: ActivationLifetimePorts) {
  const session = lifetime.session;
  const activation = automaticHostModeActivation({
    current: lifetime.current,
    admissionAllowed: id => agent.automaticSwmHostModeAdmissionAllowed(id),
    restoreBinding: (id, onChainId) => agent.restorePersistedHostModeBinding(id, onChainId),
    reserved: id => (Object.values(SYSTEM_CONTEXT_GRAPHS) as string[]).includes(id),
    legacyAllowed: id => agent.rfc64LegacySwmGossipAllowedForContextGraph(id),
    unwire: id => agent.unwireSwmHostModeHandler(id),
    member: id => agent.isMemberModeRegisteredForCg(id),
    source: id => session.swmHostModeSubscribed.get(agent.canonicalSwmHostModeKey(id)),
    curated: id => session.swmHostModeCurated.get(agent.canonicalSwmHostModeKey(id)),
    captureCurrent: id => agent.swmHostModePublicPolicy().captureCurrent(id),
    captureActivationCurrent: id => {
      const key = agent.canonicalSwmHostModeKey(id);
      const handler = session.swmHostModeHandlers.get(key);
      return () => session.swmHostModeHandlers.get(key) === handler;
    },
    strip: () => agent.swmHostModeStripCiphertext(),
    hostPublic: lifetime.hostPublic,
    probeCurated: id => agent.isCuratedForHostMode(id),
    accessPolicy: id => agent.swmHostModeAccessPolicy(id),
    confirmedPublic: id => agent.isConfirmedPublicForHostMode(id),
    wire: (id, source, curated) => agent.wireSwmHostModeHandler(id, source, curated),
    classify: (id, curated, current) => {
      const key = agent.canonicalSwmHostModeKey(id);
      session.swmHostModeCurated.set(key, curated);
      if (curated) session.swmHostModePublicBindingCurrent.delete(key);
      else session.swmHostModePublicBindingCurrent.set(key, current);
    },
    persisted: id => agent.awaitHostModePersistence(id),
    markRegistered: (id, current) => agent.maybeMarkRegisteredForHostMode(id, current),
    declined: id => lifetime.log.info(createOperationContext('system'),
      `SWM host-mode subscription DECLINED for "${id}": private-ciphertext strip is ON ` +
      `(OT-RFC-49 WS-A — cores custody zero private SWM ciphertext for curated CGs; members backfill from the curator)`),
    enabled: id => lifetime.log.info(createOperationContext('system'),
      `SWM host-mode subscription enabled for "${id}" (role=core)`),
    failed: (id, strip, error) => lifetime.log.warn(createOperationContext('system'), strip
      ? `Failed to re-evaluate persisted host-mode subscription for "${id}": ${error instanceof Error ? error.message : String(error)}`
      : `Failed to restore host-mode subscription for "${id}": ${error instanceof Error ? error.message : String(error)}`),
  });
  return { ...activation,
    refreshCanonicalHandoff: async (id: string, source: SubscriptionSource,
      ownerCurrent: () => boolean, handoffCurrent: () => boolean): Promise<void> => {
      const current = () => ownerCurrent() && handoffCurrent();
      if (source === SUBSCRIPTION_SOURCES.MANUAL || !lifetime.current() || !current()) return;
      await activation.reconcile(id, source, current);
    },
    adoptAuthenticatedEnvelopeIdentity: async (id: string, wireId: string, mayAdopt: () => boolean,
      ownerCurrent: () => boolean): Promise<void> => {
      if (!lifetime.current() || !ownerCurrent()) return;
      // Keep the wire-id → cleartext reverse index in sync so the
      // chain-fallback resolver and the catchup-request path can
      // translate either direction without an extra RPC. Adoption follows
      // verified retention, so it cannot invalidate that envelope's capture.
      const subscription = lifetime.subscriptions.get(id);
      if (mayAdopt() && subscription?.onChainHash !== wireId) {
        agent.setContextGraphSubscription(id, { ...(subscription ?? {
          syncMode: 'always-on', subscribed: false, synced: false, pendingMeta: true,
        }), onChainHash: wireId }, { persist: false });
      }
      if (!lifetime.current() || !ownerCurrent()
        || lifetime.subscriptions.get(id)?.onChainHash !== wireId) return;
      const source = session.swmHostModeSubscribed.get(wireId);
      if (source === undefined || source === SUBSCRIPTION_SOURCES.MANUAL) return;
      // The old callback stays fenced. Future callbacks receive a fresh
      // exemption only from the ordinary policy-aware activation flow.
      await activation.reconcile(id, source, ownerCurrent);
    },
  };
}

/** Numeric policy is authoritative over metadata and same-hash beacon hints. */
export function readSwmHostModeAccessPolicy(contextGraphId: string, ports: {
  localId(id: string): string;
  hostKey(id: string): string;
  subscriptions: ReadonlyMap<string, ContextGraphBindingSubscription>;
  wireOwners: ReadonlyMap<string, string>;
  accessPolicies: ReadonlyMap<string, number>;
}): number | undefined {
  let sub = ports.subscriptions.get(ports.localId(contextGraphId));
  if (!sub?.onChainId && normalizeContextGraphNameHash(contextGraphId) !== null) {
    const owner = ports.wireOwners.get(ports.hostKey(contextGraphId));
    sub = owner === undefined ? undefined : ports.subscriptions.get(owner);
  }
  return sub?.onChainId ? ports.accessPolicies.get(sub.onChainId) : undefined;
}
