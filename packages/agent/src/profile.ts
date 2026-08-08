import type { Quad } from '@origintrail-official/dkg-storage';
import {
  SYSTEM_CONTEXT_GRAPHS,
  isPublicLikeAddress,
} from '@origintrail-official/dkg-core';
import {
  AGENT_PROFILE_SCHEMA_TERMS_V1,
  agentProfileIdentityFactsV1,
  deriveAgentProfileOwnedSubjectV1,
  type AgentProfileIdentityFactsV1,
  type AgentProfileProjectionQuadV1,
} from '@origintrail-official/dkg-core/system-record-v1';

/**
 * Canonicalise the DID subject for an agent.
 *
 * A-12 review: the same wallet can be supplied with different casings
 * (e.g. `ethers.Wallet.address` returns checksum case, while config
 * files and JSON bodies often carry lowercase). Without normalisation
 * a profile publish would mint `did:dkg:agent:0xAb...` while an
 * endorsement from the same wallet would mint `did:dkg:agent:0xab...`,
 * splitting the entity into two RDF subjects that never converge.
 *
 * Rule: if the raw subject matches the EVM-address shape `0x<40hex>`,
 * fold it to lowercase. Any other shape (peer id, non-hex) is passed
 * through unchanged — callers upstream may have minted a legacy
 * peer-id subject and we must not silently rewrite it to look like an
 * address.
 */
export function canonicalAgentDidSubject(raw: string): string {
  if (/^0x[0-9a-fA-F]{40}$/.test(raw)) {
    return raw.toLowerCase();
  }
  return raw;
}

/**
 * Filter a node's live libp2p multiaddrs down to the set worth
 * publishing in the agent profile.
 *
 * Reuses the shared `isPublicLikeAddress` classifier from `dkg-core`
 * (the same one `share-project-modal.test.ts` and the daemon's
 * "node is remotely-dialable" check pin to). That classifier rejects:
 *   - loopback (127.0.0.0/8, ::1)
 *   - unspecified bind (0.0.0.0, ::)
 *   - link-local (169.254.0.0/16, fe80::/10)
 *   - RFC1918 (10/8, 172.16/12, 192.168/16)
 *   - CGNAT (100.64/10)
 *   - multicast / reserved (224.0.0.0+)
 *   - IPv6 ULA (fc00::/7) and multicast (ff00::/8)
 *   - `/dns4/` / `/dns6/` / `/dnsaddr/` hostnames that resolve to
 *     localhost-y / `.local` / etc.
 *
 * The classifier evaluates the LEADING address segment, which is
 * exactly what we want for `/p2p-circuit` entries — those are encoded
 * as `/ip4/<relay-ip>/.../p2p-circuit/p2p/<peer-id>` and only the
 * public-relay form should be advertised.
 *
 * Codex review of PR #700 round 2 flagged that the round-1 regex
 * filter still leaked RFC1918 / CGNAT / ULA into the agent profile, so
 * peers learnt self-referential or private multiaddrs from the
 * phonebook and wasted dial attempts before falling back to the relay.
 *
 * Exported separately so it can be unit-tested without standing up a
 * full agent.
 */
export function collectPublishableMultiaddrs(
  raw: readonly string[],
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const ma of raw) {
    if (!ma || seen.has(ma)) continue;
    if (!isPublicLikeAddress(ma)) continue;
    seen.add(ma);
    out.push(ma);
  }
  return out;
}

const T = AGENT_PROFILE_SCHEMA_TERMS_V1;

export const AGENT_REGISTRY_CONTEXT_GRAPH = SYSTEM_CONTEXT_GRAPHS.AGENTS;
export const AGENT_REGISTRY_GRAPH = `did:dkg:context-graph:${AGENT_REGISTRY_CONTEXT_GRAPH}`;

export interface SkillOfferingConfig {
  skillType: string;
  pricePerCall?: number;
  currency?: string;
  successRate?: number;
  pricingModel?: 'PerInvocation' | 'Subscription' | 'Free';
}

export interface AgentProfileEncryptionKey {
  encryptionKeyAlgorithm: string;
  publicEncryptionKey: string;
  encryptionKeyProof: string;
  encryptionKeyId: string;
  revokedAt?: string;
  revocationProof?: string;
}

export interface AgentProfileConfig {
  peerId: string;
  name: string;
  description?: string;
  framework?: string;
  skills: SkillOfferingConfig[];
  contextGraphsServed?: string[];
  nodeRole?: 'core' | 'edge';
  publicKey?: string;
  relayAddress?: string;
  agentAddress?: string;
  /**
   * Live libp2p multiaddrs other peers should use to dial this node.
   * Should be the publicly-reachable / circuit-relayed forms (filtered
   * to exclude loopback + link-local). Empty/undefined leaves the
   * `dkg:multiaddr` triples unset — older agents may publish profiles
   * without these and the discovery path falls back to
   * `dkg:relayAddress` alone.
   *
   * Caller is responsible for filtering; this function emits whatever
   * it receives. See `DKGAgent.publishProfile` for the production
   * filter (drops loopback / link-local / unspecified).
   */
  multiaddrs?: readonly string[];
  /**
   * ISO-8601 timestamp of when this profile was generated. Consumers
   * use this as a freshness signal: profiles older than the
   * application's staleness threshold (typically 24h) are skipped
   * during dial fallback so we don't try addresses from a node that
   * has been offline for days. Defaults to `new Date().toISOString()`
   * when omitted.
   */
  lastSeen?: string;
  /**
   * Every workspace encryption key registered to this agent, including retired
   * ones (so the registry can publish their wallet-signed revocations and
   * peers' resolvers can filter them out). When this is non-empty the legacy
   * `publicEncryptionKey` / `encryptionKeyAlgorithm` / `encryptionKeyProof`
   * fields below are ignored — callers should populate either the array OR the
   * singular fields, not both.
   */
  encryptionKeys?: readonly AgentProfileEncryptionKey[];
  /** @deprecated single-key shape kept for backward compatibility with older test fixtures. */
  encryptionKeyAlgorithm?: string;
  /** @deprecated */
  publicEncryptionKey?: string;
  /** @deprecated */
  encryptionKeyProof?: string;
}

export type AgentProfileAdvertisedIdentityV1 = Omit<AgentProfileIdentityFactsV1, 'rootSubject'> & {
  readonly rootEntity: string;
};

/** Canonical RDF identity terms shared by the profile builder and signed-record binder. */
export function agentProfileAdvertisedIdentityV1(
  config: Pick<AgentProfileConfig, 'peerId' | 'publicKey' | 'agentAddress'>,
): AgentProfileAdvertisedIdentityV1 {
  const rootEntity = `did:dkg:agent:${canonicalAgentDidSubject(config.agentAddress ?? config.peerId)}`;
  const identity = agentProfileIdentityFactsV1({
    rootSubject: rootEntity,
    peerId: config.peerId,
    publicKey: config.publicKey,
    agentAddress: config.agentAddress === undefined
      ? undefined
      : canonicalAgentDidSubject(config.agentAddress),
  });
  return Object.freeze({
    rootEntity,
    peerId: identity.peerId,
    ...(identity.publicKey === undefined ? {} : { publicKey: identity.publicKey }),
    ...(identity.agentAddress === undefined ? {} : { agentAddress: identity.agentAddress }),
  });
}

export interface PreparedAgentProfileV1 {
  /** Graphful quads consumed by the legacy VM publisher. */
  readonly publicationQuads: readonly Readonly<Quad>[];
  /** Graphless facts consumed by signed profile projection. */
  readonly projectionQuads: readonly Readonly<AgentProfileProjectionQuadV1>[];
  readonly rootEntity: string;
  /** Exact freshness value already embedded in both quad views. */
  readonly lastSeen: string;
}

/**
 * Snapshot all time-dependent profile input once, then expose distinct immutable
 * graphful publication and graphless signed-projection views.
 */
export function prepareAgentProfileV1(
  config: AgentProfileConfig,
  now: () => Date = () => new Date(),
): PreparedAgentProfileV1 {
  const lastSeen = config.lastSeen ?? now().toISOString();
  const built = buildAgentProfileModelV1({ ...config, lastSeen });
  const publicationQuads = renderAgentProfilePublicationV1(built)
    .map((quad) => Object.freeze(quad));
  const projectionQuads = renderAgentProfileProjectionV1(built)
    .map((quad) => Object.freeze(quad));
  return Object.freeze({
    publicationQuads: Object.freeze(publicationQuads),
    projectionQuads: Object.freeze(projectionQuads),
    rootEntity: built.rootEntity,
    lastSeen,
  });
}

/**
 * Builds RDF quads for an agent profile KA using the ERC-8004 aligned ontology.
 *
 * Spec §03_AGENTS.md / §22_AGENT_ONBOARDING.md require the agent DID to be
 * the Ethereum-address form `did:dkg:agent:0x<40hex>`. When an
 * `agentAddress` is supplied (which is always the case at runtime — the
 * node auto-registers a default agent and passes its address through
 * `DKGAgent.publishProfile`) the root entity uses that spec form. We
 * keep the legacy `did:dkg:agent:<peerId>` fallback only for test
 * harnesses that still construct profiles without an agent address;
 * the A-12 drift-scan test enforces that no production fixtures rely
 * on it.
 *
 * Uses three vocabulary layers: erc8004: (identity), prov: (provenance),
 * dkg: (P2P).
 */
export function buildAgentProfile(config: AgentProfileConfig): {
  quads: Quad[];
  rootEntity: string;
} {
  const built = buildAgentProfileModelV1(config);
  return {
    quads: renderAgentProfilePublicationV1(built),
    rootEntity: built.rootEntity,
  };
}

interface AgentProfileFactV1 {
  readonly subject: string;
  readonly predicate: string;
  readonly object: string;
}

interface AgentProfileModelV1 {
  readonly facts: readonly AgentProfileFactV1[];
  readonly rootEntity: string;
}

/**
 * Canonical signed-profile facts governed by schema V1. Future legacy-only
 * output belongs explicitly in the publication renderer, not in this model.
 */
function buildAgentProfileModelV1(config: AgentProfileConfig): AgentProfileModelV1 {
  // A-12: normalise the DID subject so profile + endorsement subjects
  // converge for the same wallet regardless of the source casing. See
  // `canonicalAgentDidSubject` for rationale.
  const identity = agentProfileAdvertisedIdentityV1(config);
  const entity = identity.rootEntity;
  const facts: AgentProfileFactV1[] = [];
  const role = config.nodeRole ?? 'edge';
  const profileTimestamp = config.lastSeen ?? new Date().toISOString();

  const q = (s: string, p: string, o: string) =>
    facts.push({ subject: s, predicate: p, object: o });

  // Type: dkg:Agent + role-specific subclass
  q(entity, T.rdfType, T.dkgAgent);
  q(entity, T.rdfType, role === 'core' ? T.dkgCoreNode : T.dkgEdgeNode);

  // schema.org metadata
  q(entity, T.schemaName, `"${config.name}"`);
  if (config.description) {
    q(entity, T.schemaDescription, `"${config.description}"`);
  }

  // DKG P2P properties
  q(entity, identity.peerId.predicate, identity.peerId.object);
  q(entity, T.dkgNodeRole, `"${role}"`);

  if (identity.publicKey !== undefined) {
    q(entity, identity.publicKey.predicate, identity.publicKey.object);
  }
  if (config.relayAddress) {
    q(entity, T.dkgRelayAddress, `"${config.relayAddress}"`);
  }
  if (identity.agentAddress !== undefined) {
    q(entity, identity.agentAddress.predicate, identity.agentAddress.object);
  }
  // Distributed phonebook (PR feat/chain-agents-cg-phonebook).
  // Note: properties `dkg:multiaddr` and `dkg:lastSeen` are emitted on
  // the agent entity without a matching genesis ontology declaration.
  // Adding them to genesis would change the hashed `networkId`
  // (`computeNetworkId` hashes all genesis quads), breaking any node
  // still on rc.11. RDF doesn't require properties to be declared —
  // they're usable as-is. Ontology declarations can land in a
  // coordinated genesis bump later.
  if (config.multiaddrs && config.multiaddrs.length > 0) {
    for (const ma of config.multiaddrs) {
      // Defensive: skip entries containing a `"` which would break
      // the N-Quad literal encoding. Real libp2p multiaddrs never
      // contain quote characters; this guard is purely against
      // malformed callers.
      if (!ma || ma.includes('"')) continue;
      q(entity, T.dkgMultiaddr, `"${ma}"`);
    }
  }
  q(entity, T.dkgLastSeen, `"${profileTimestamp}"`);
  // Encryption keys: prefer the multi-key array; fall back to the deprecated
  // singular fields only when the array isn't supplied (legacy callers /
  // test fixtures). Retired keys still get published so peers learn their
  // wallet-signed revocations and the resolver can prune them.
  if (config.encryptionKeys && config.encryptionKeys.length > 0) {
    for (const key of config.encryptionKeys) {
      q(entity, T.dkgPublicEncryptionKey, `"${key.publicEncryptionKey}"`);
      q(entity, T.dkgEncryptionKeyAlgorithm, `"${key.encryptionKeyAlgorithm}"`);
      q(entity, T.dkgEncryptionKeyProof, `"${key.encryptionKeyProof}"`);
      if (key.revokedAt && key.revocationProof) {
        q(key.encryptionKeyId, T.dkgRevokedAt, `"${key.revokedAt}"`);
        q(key.encryptionKeyId, T.dkgRevokedBy, entity);
        q(key.encryptionKeyId, T.dkgEncryptionKeyRevocationProof, `"${key.revocationProof}"`);
      }
    }
  } else if (config.publicEncryptionKey && config.encryptionKeyAlgorithm && config.encryptionKeyProof) {
    q(entity, T.dkgPublicEncryptionKey, `"${config.publicEncryptionKey}"`);
    q(entity, T.dkgEncryptionKeyAlgorithm, `"${config.encryptionKeyAlgorithm}"`);
    q(entity, T.dkgEncryptionKeyProof, `"${config.encryptionKeyProof}"`);
  }
  if (config.framework) {
    q(entity, T.skillFramework, `"${config.framework}"`);
  }

  // ERC-8004 capabilities (skills as capabilities)
  for (let i = 0; i < config.skills.length; i++) {
    const skill = config.skills[i];
    const capUri = deriveAgentProfileOwnedSubjectV1(entity, 'capability', i + 1);

    q(entity, T.erc8004Capabilities, capUri);
    q(capUri, T.rdfType, T.erc8004Capability);
    q(capUri, T.schemaName, `"${skill.skillType}"`);

    // Keep backward-compatible skill offering triples
    const offeringUri = deriveAgentProfileOwnedSubjectV1(entity, 'offering', i + 1);
    q(entity, T.skillOffersSkill, offeringUri);
    q(offeringUri, T.rdfType, T.skillSkillOffering);
    q(offeringUri, T.skillSkill, `${T.skillNamespace}${skill.skillType}`);

    if (skill.pricePerCall !== undefined) {
      q(offeringUri, T.skillPricePerCall, `"${skill.pricePerCall}"`);
    }
    if (skill.currency) {
      q(offeringUri, T.skillCurrency, `"${skill.currency}"`);
    }
    if (skill.successRate !== undefined) {
      q(offeringUri, T.skillSuccessRate, `"${skill.successRate}"`);
    }
    if (skill.pricingModel) {
      q(offeringUri, T.skillPricing, `${T.skillNamespace}${skill.pricingModel}`);
    }
  }

  // PROV provenance
  const activityUri = deriveAgentProfileOwnedSubjectV1(entity, 'registration');
  q(entity, T.provWasGeneratedBy, activityUri);
  q(activityUri, T.rdfType, T.provActivity);
  q(activityUri, T.provAtTime, `"${profileTimestamp}"`);

  const served = config.contextGraphsServed;
  if (served?.length) {
    const hostingUri = deriveAgentProfileOwnedSubjectV1(entity, 'hosting');
    q(entity, T.skillHostingProfile, hostingUri);
    q(hostingUri, T.rdfType, T.skillHostingProfileType);
    for (const cg of served) {
      q(hostingUri, T.skillContextGraphsServed, `"${cg}"`);
    }
  }

  return { facts, rootEntity: entity };
}

function renderAgentProfilePublicationV1(
  model: AgentProfileModelV1,
): Quad[] {
  return model.facts.map((fact) => ({ ...fact, graph: AGENT_REGISTRY_GRAPH }));
}

function renderAgentProfileProjectionV1(
  model: AgentProfileModelV1,
): AgentProfileProjectionQuadV1[] {
  return model.facts.map((fact) => ({ ...fact, graph: '' }));
}
