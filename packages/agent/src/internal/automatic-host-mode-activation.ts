// SPDX-License-Identifier: Apache-2.0
import { SUBSCRIPTION_SOURCES, SYSTEM_CONTEXT_GRAPHS, createOperationContext, type SubscriptionSource, type Logger } from '@origintrail-official/dkg-core';
import type { DKGAgent } from '../dkg-agent.js';
import type { ContextGraphSub } from '../dkg-agent-types.js';
import type { GossipSession, SwmHostModeCustody } from '../gossip-session.js';
import { normalizeContextGraphNameHash } from '../context-graph-name-candidate.js';
import type { ContextGraphBindingSubscription } from '../context-graph-binding-state.js';
import type { SwmHostModeStore, SwmHostModeSubscriptionBinding } from '../swm/host-mode-store.js';
import { GraphManager, type TripleStore } from '@origintrail-official/dkg-storage';

type HostActivationMethods = Pick<DKGAgent,
  | 'automaticSwmHostModeAdmissionAllowed' | 'retireDormantSwmHostModeHandler' | 'restorePersistedHostModeBinding'
  | 'rfc64LegacySwmGossipAllowedForContextGraph' | 'unwireSwmHostModeHandler'
  | 'isMemberModeRegisteredForCg' | 'canonicalSwmHostModeKey' | 'swmHostModePublicPolicy'
  | 'swmHostModeStripCiphertext' | 'isCuratedForHostMode' | 'swmHostModeAccessPolicy'
  | 'isConfirmedPublicForHostMode' | 'wireSwmHostModeHandler' | 'awaitHostModePersistence'
  | 'maybeMarkRegisteredForHostMode' | 'setContextGraphSubscription'>;
// The factory receives the original agent receiver; its methods retain that receiver.
type HostActivationAgent = { [K in keyof HostActivationMethods]: OmitThisParameter<HostActivationMethods[K]> };

interface ActivationLifetime {
  session: GossipSession;
  current(): boolean;
  hostPublic(): boolean;
  log: Logger;
  subscriptions: ReadonlyMap<string, ContextGraphSub>;
}

type AdmissionIntent = 'discovered' | 'persisted-legacy';
type HostModeAdmission = Readonly<{ custody: SwmHostModeCustody; current(): boolean }>;

/** Capture the active agent session and only its current listener custody. */
export function createAutomaticHostModeActivation(agent: HostActivationAgent, lifetime: ActivationLifetime) {
  const session = lifetime.session;
  const registration = (id: string) => session.hostModeRegistrations.get(agent.canonicalSwmHostModeKey(id));
  const captureActivationCurrent = (id: string) => {
    const key = agent.canonicalSwmHostModeKey(id);
    const handler = session.hostModeRegistrations.get(key)?.handler;
    return () => session.hostModeRegistrations.get(key)?.handler === handler;
  };
  /** Admission is distinct from activation; legacy persisted custody is explicit. */
  const admit = async (id: string, intent: AdmissionIntent, evidenceCurrent: () => boolean,
    expectedListenerCurrent: () => boolean): Promise<HostModeAdmission | null> => {
    const bindingCurrent = agent.swmHostModePublicPolicy().captureCurrent(id);
    // Evidence belongs to this binding and lifetime, independently of listener installation.
    const stillCurrent = () => evidenceCurrent() && agent.automaticSwmHostModeAdmissionAllowed(id) && bindingCurrent();
    const pendingCurrent = () => expectedListenerCurrent() && stillCurrent();
    let curated: boolean;
    if (intent === 'persisted-legacy') {
      // Strip-off legacy markers retain custody even without a public proof.
      // A later ordinary reconcile retries that proof rather than freezing this fallback.
      curated = !(lifetime.hostPublic() && await agent.isConfirmedPublicForHostMode(id));
    } else {
      // GH #1611: public plaintext hosting is opt-in and needs both chain policy
      // axes. Numeric policy, verified beacons or private metadata prove curation;
      // a name commitment alone does not prove an access policy.
      const probed = await agent.isCuratedForHostMode(id);
      if (!pendingCurrent()) return null;
      const policy = agent.swmHostModeAccessPolicy(id);
      curated = policy === undefined ? probed : policy === 1;
      if (!curated && (!lifetime.hostPublic() || !await agent.isConfirmedPublicForHostMode(id))) return null;
    }
    if (!pendingCurrent()) return null;
    // OT-RFC-49 WS-A: with the strip ON, hosting follows access. Declining
    // curated custody starves both legacy .meta and LU-11 chunk ingest, for
    // every discovery path. Members backfill private data from their curator;
    // the explicit false kill-switch preserves legacy automatic custody.
    if (agent.swmHostModeStripCiphertext() && curated) {
      if (registration(id) !== undefined) agent.wireSwmHostModeHandler(id, registration(id)!.source, { kind: 'curated' });
      lifetime.log.info(createOperationContext('system'),
        `SWM host-mode subscription DECLINED for "${id}": private-ciphertext strip is ON ` +
        `(OT-RFC-49 WS-A — cores custody zero private SWM ciphertext for curated CGs; members backfill from the curator)`);
      return null;
    }
    return Object.freeze({ custody: curated ? { kind: 'curated' } : { kind: 'automatic-public', current: stillCurrent }, current: stillCurrent });
  };

  /** One fenced activation flow for discovery, retry and persisted restoration. */
  const activate = async (id: string, source: SubscriptionSource, intent: AdmissionIntent,
    ownerCurrent: () => boolean): Promise<void> => {
    const expectedListenerCurrent = captureActivationCurrent(id);
    const evidenceCurrent = () => lifetime.current() && ownerCurrent();
    const current = () => evidenceCurrent() && expectedListenerCurrent();
    const canActivate = (listenerCurrent: () => boolean = expectedListenerCurrent) => {
      if (!evidenceCurrent() || !listenerCurrent()) return false;
      if (agent.automaticSwmHostModeAdmissionAllowed(id)) return true;
      agent.retireDormantSwmHostModeHandler(id); return false;
    };
    if (!canActivate() || (Object.values(SYSTEM_CONTEXT_GRAPHS) as string[]).includes(id)) return;
    if (!agent.rfc64LegacySwmGossipAllowedForContextGraph(id)) {
      // Catalog authority removes an already-wired host as well as refusing
      // another independent path into the legacy SWM topic.
      agent.unwireSwmHostModeHandler(id); return;
    }
    // Member apply already covers consumption. The adapter's shape-agnostic
    // probe sees cleartext and wire-hash registration; wiring also refuses it.
    if (agent.isMemberModeRegisteredForCg(id)) return;
    if (registration(id)?.source === SUBSCRIPTION_SOURCES.MANUAL) {
      // Automatic discovery never takes over the operator's handler or provenance.
      if (agent.swmHostModeStripCiphertext() && registration(id)?.custody.kind !== 'curated'
        && await agent.isCuratedForHostMode(id)) {
        if (!canActivate() || agent.swmHostModeAccessPolicy(id) === 0) return;
        agent.wireSwmHostModeHandler(id, SUBSCRIPTION_SOURCES.MANUAL, { kind: 'curated' });
      }
      if (!canActivate()) return;
      await agent.maybeMarkRegisteredForHostMode(id, current);
      canActivate();
      return;
    }
    // Idempotent periodic re-entry still re-probes registration: a CG created
    // offline must not remain on the 6h/1MiB pre-registration retention limits.
    // Canonical host keys make cleartext and wire-hash entry paths equivalent.
    const retainedLegacy = registration(id) !== undefined && !agent.swmHostModeStripCiphertext();
    const admission = await admit(id, retainedLegacy ? 'persisted-legacy' : intent, evidenceCurrent, expectedListenerCurrent);
    if (admission === null) { canActivate(); return; }
    if (!agent.wireSwmHostModeHandler(id, source, admission.custody)) return;
    const installedListenerCurrent = captureActivationCurrent(id);
    const admissionCurrent = () => canActivate(installedListenerCurrent) && admission.current();
    // Discovery awaits its new designation. Legacy restart preserves its historical
    // nonblocking marker enqueue before the registration probe.
    if (intent === 'discovered') await agent.awaitHostModePersistence(id);
    if (!admissionCurrent()) return;
    await agent.maybeMarkRegisteredForHostMode(id, admissionCurrent);
    if (!admissionCurrent()) return;
    if (intent === 'discovered') lifetime.log.info(createOperationContext('system'),
      `SWM host-mode subscription enabled for "${id}" (role=core)`);
  };

  return {
    reconcile: (id: string, source: SubscriptionSource, current: () => boolean) =>
      activate(id, source, 'discovered', current),
    restore: async (entry: SwmHostModeSubscriptionBinding, strip: boolean, current: () => boolean): Promise<void> => {
      const id = entry.contextGraphId;
      if (!lifetime.current() || !current()) return;
      if (!agent.automaticSwmHostModeAdmissionAllowed(id)) { agent.retireDormantSwmHostModeHandler(id); return; }
      try {
        if (!agent.restorePersistedHostModeBinding(id, entry.onChainId)) return;
        await activate(id, SUBSCRIPTION_SOURCES.RECONCILER, strip ? 'discovered' : 'persisted-legacy', current);
      } catch (error) {
        lifetime.log.warn(createOperationContext('system'), strip
          ? `Failed to re-evaluate persisted host-mode subscription for "${id}": ${error instanceof Error ? error.message : String(error)}`
          : `Failed to restore host-mode subscription for "${id}": ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    refreshCanonicalHandoff: async (id: string, source: SubscriptionSource,
      ownerCurrent: () => boolean, handoffCurrent: () => boolean): Promise<void> => {
      const current = () => ownerCurrent() && handoffCurrent();
      if (source === SUBSCRIPTION_SOURCES.MANUAL || !lifetime.current() || !current()) return;
      await activate(id, source, 'discovered', current);
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
      const source = session.hostModeRegistrations.get(wireId)?.source;
      if (source === undefined || source === SUBSCRIPTION_SOURCES.MANUAL) return;
      // The old callback stays fenced. Future callbacks receive a fresh
      // exemption only from the ordinary policy-aware activation flow.
      await activate(id, source, 'discovered', ownerCurrent);
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

/** Enumerate intent once; the rotating slice bounds policy work for cold and populated graphs. */
export async function reconcileKnownHostModeSubscriptions(ports: {
  store: TripleStore;
  markers: Pick<SwmHostModeStore, 'listHostModeSubscriptions'>;
  current(): boolean;
  batchSize(): number;
  cursor(): number;
  advanceCursor(cursor: number): void;
  reconcile(id: string): Promise<void>;
}): Promise<void> {
  const [localIds, markers] = await Promise.all([
    new GraphManager(ports.store).listContextGraphs({ source: 'agent.swmHostMode.listContextGraphs' }),
    ports.markers.listHostModeSubscriptions(),
  ]);
  if (!ports.current()) return;
  const knownCgs = [...new Set([...localIds, ...markers.map(entry => entry.contextGraphId)])].sort();
  if (knownCgs.length === 0) { ports.advanceCursor(0); return; }
  const start = ports.cursor() % knownCgs.length;
  const count = Math.min(ports.batchSize(), knownCgs.length);
  for (let i = 0; i < count; i++) {
    if (!ports.current()) return;
    const index = (start + i) % knownCgs.length;
    try {
      await ports.reconcile(knownCgs[index]);
    } finally {
      ports.advanceCursor((index + 1) % knownCgs.length);
    }
  }
}
