import type { Quad } from '@origintrail-official/dkg-storage';
import { DKG_ONTOLOGY, SYSTEM_PARANETS } from '@origintrail-official/dkg-core';

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const SCHEMA = 'https://schema.org/';
const DKG = 'https://dkg.network/ontology#';
const ERC8004 = 'https://eips.ethereum.org/erc-8004#';
const PROV = 'http://www.w3.org/ns/prov#';
const SKILL = 'https://dkg.origintrail.io/skill#';

export const AGENT_REGISTRY_CONTEXT_GRAPH = SYSTEM_PARANETS.AGENTS;
export const AGENT_REGISTRY_GRAPH = `did:dkg:context-graph:${AGENT_REGISTRY_CONTEXT_GRAPH}`;

/** @deprecated Use AGENT_REGISTRY_CONTEXT_GRAPH */
export const AGENT_REGISTRY_PARANET = AGENT_REGISTRY_CONTEXT_GRAPH;

export interface SkillOfferingConfig {
  skillType: string;
  pricePerCall?: number;
  currency?: string;
  successRate?: number;
  pricingModel?: 'PerInvocation' | 'Subscription' | 'Free';
}

export interface AgentProfileConfig {
  peerId: string;
  name: string;
  description?: string;
  framework?: string;
  skills: SkillOfferingConfig[];
  contextGraphsServed?: string[];
  /** @deprecated Use contextGraphsServed */
  paranetsServed?: string[];
  nodeRole?: 'core' | 'edge';
  publicKey?: string;
  relayAddress?: string;
  agentAddress?: string;
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
  const didSubject = config.agentAddress ?? config.peerId;
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
    q(entity, `${DKG}agentAddress`, `"${config.agentAddress}"`);
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

  const served = config.contextGraphsServed ?? config.paranetsServed;
  if (served?.length) {
    const hostingUri = `${entity}/.well-known/genid/hosting`;
    q(entity, `${SKILL}hostingProfile`, hostingUri);
    q(hostingUri, RDF_TYPE, `${SKILL}HostingProfile`);
    const val = `"${served.join(',')}"`;
    q(hostingUri, `${SKILL}contextGraphsServed`, val);
    q(hostingUri, `${SKILL}paranetsServed`, val);
  }

  return { quads, rootEntity: entity };
}
