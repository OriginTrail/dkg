import type { Quad } from '@origintrail-official/dkg-storage';
import { DKG_ONTOLOGY, SYSTEM_CONTEXT_GRAPHS } from '@origintrail-official/dkg-core';

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

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const SCHEMA = 'https://schema.org/';
const DKG = 'https://dkg.network/ontology#';
const ERC8004 = 'https://eips.ethereum.org/erc-8004#';
const PROV = 'http://www.w3.org/ns/prov#';
const SKILL = 'https://dkg.origintrail.io/skill#';

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
  // A-12: normalise the DID subject so profile + endorsement subjects
  // converge for the same wallet regardless of the source casing. See
  // `canonicalAgentDidSubject` for rationale.
  const didSubject = canonicalAgentDidSubject(config.agentAddress ?? config.peerId);
  const entity = `did:dkg:agent:${didSubject}`;
  const quads: Quad[] = [];
  const role = config.nodeRole ?? 'edge';

  const q = (s: string, p: string, o: string) =>
    quads.push({ subject: s, predicate: p, object: o, graph: AGENT_REGISTRY_GRAPH });

  // Type: dkg:Agent + role-specific subclass
  q(entity, RDF_TYPE, `${DKG}Agent`);
  q(entity, RDF_TYPE, role === 'core' ? `${DKG}CoreNode` : `${DKG}EdgeNode`);

  // schema.org metadata
  q(entity, `${SCHEMA}name`, `"${config.name}"`);
  if (config.description) {
    q(entity, `${SCHEMA}description`, `"${config.description}"`);
  }

  // DKG P2P properties
  q(entity, `${DKG}peerId`, `"${config.peerId}"`);
  q(entity, `${DKG}nodeRole`, `"${role}"`);

  if (config.publicKey) {
    q(entity, `${DKG}publicKey`, `"${config.publicKey}"`);
  }
  if (config.relayAddress) {
    q(entity, `${DKG}relayAddress`, `"${config.relayAddress}"`);
  }
  if (config.agentAddress) {
    q(entity, `${DKG}agentAddress`, `"${canonicalAgentDidSubject(config.agentAddress)}"`);
  }
  // Encryption keys: prefer the multi-key array; fall back to the deprecated
  // singular fields only when the array isn't supplied (legacy callers /
  // test fixtures). Retired keys still get published so peers learn their
  // wallet-signed revocations and the resolver can prune them.
  if (config.encryptionKeys && config.encryptionKeys.length > 0) {
    for (const key of config.encryptionKeys) {
      q(entity, `${DKG}publicEncryptionKey`, `"${key.publicEncryptionKey}"`);
      q(entity, `${DKG}encryptionKeyAlgorithm`, `"${key.encryptionKeyAlgorithm}"`);
      q(entity, `${DKG}encryptionKeyProof`, `"${key.encryptionKeyProof}"`);
      if (key.revokedAt && key.revocationProof) {
        q(key.encryptionKeyId, `${DKG}revokedAt`, `"${key.revokedAt}"`);
        q(key.encryptionKeyId, `${DKG}revokedBy`, entity);
        q(key.encryptionKeyId, `${DKG}encryptionKeyRevocationProof`, `"${key.revocationProof}"`);
      }
    }
  } else if (config.publicEncryptionKey && config.encryptionKeyAlgorithm && config.encryptionKeyProof) {
    q(entity, `${DKG}publicEncryptionKey`, `"${config.publicEncryptionKey}"`);
    q(entity, `${DKG}encryptionKeyAlgorithm`, `"${config.encryptionKeyAlgorithm}"`);
    q(entity, `${DKG}encryptionKeyProof`, `"${config.encryptionKeyProof}"`);
  }
  if (config.framework) {
    q(entity, `${SKILL}framework`, `"${config.framework}"`);
  }

  // ERC-8004 capabilities (skills as capabilities)
  for (let i = 0; i < config.skills.length; i++) {
    const skill = config.skills[i];
    const capUri = `${entity}/.well-known/genid/cap${i + 1}`;

    q(entity, `${ERC8004}capabilities`, capUri);
    q(capUri, RDF_TYPE, `${ERC8004}Capability`);
    q(capUri, `${SCHEMA}name`, `"${skill.skillType}"`);

    // Keep backward-compatible skill offering triples
    const offeringUri = `${entity}/.well-known/genid/offering${i + 1}`;
    q(entity, `${SKILL}offersSkill`, offeringUri);
    q(offeringUri, RDF_TYPE, `${SKILL}SkillOffering`);
    q(offeringUri, `${SKILL}skill`, `${SKILL}${skill.skillType}`);

    if (skill.pricePerCall !== undefined) {
      q(offeringUri, `${SKILL}pricePerCall`, `"${skill.pricePerCall}"`);
    }
    if (skill.currency) {
      q(offeringUri, `${SKILL}currency`, `"${skill.currency}"`);
    }
    if (skill.successRate !== undefined) {
      q(offeringUri, `${SKILL}successRate`, `"${skill.successRate}"`);
    }
    if (skill.pricingModel) {
      q(offeringUri, `${SKILL}pricing`, `${SKILL}${skill.pricingModel}`);
    }
  }

  // PROV provenance
  const activityUri = `${entity}/.well-known/genid/registration`;
  q(entity, `${PROV}wasGeneratedBy`, activityUri);
  q(activityUri, RDF_TYPE, `${PROV}Activity`);
  q(activityUri, `${PROV}atTime`, `"${new Date().toISOString()}"`);

  const served = config.contextGraphsServed ?? config.contextGraphsServed;
  if (served?.length) {
    const hostingUri = `${entity}/.well-known/genid/hosting`;
    q(entity, `${SKILL}hostingProfile`, hostingUri);
    q(hostingUri, RDF_TYPE, `${SKILL}HostingProfile`);
    const val = `"${served.join(',')}"`;
    q(hostingUri, `${SKILL}contextGraphsServed`, val);
    q(hostingUri, `${SKILL}contextGraphsServed`, val);
  }

  return { quads, rootEntity: entity };
}
