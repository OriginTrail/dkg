import type { Quad } from '@dkg/storage';

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const SCHEMA = 'http://schema.org/';
const DKG = 'http://dkg.io/ontology/';
const SKILL = 'https://dkg.origintrail.io/skill#';

export const AGENT_REGISTRY_PARANET = 'agent-registry';
export const AGENT_REGISTRY_GRAPH = `did:dkg:paranet:${AGENT_REGISTRY_PARANET}`;

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
  paranetsServed?: string[];
}

/**
 * Builds RDF quads for an agent profile KA.
 * The agent's rootEntity is `did:dkg:agent:{peerId}`.
 * Skill offerings are skolemized under the agent's rootEntity.
 */
export function buildAgentProfile(config: AgentProfileConfig): {
  quads: Quad[];
  rootEntity: string;
} {
  const entity = `did:dkg:agent:${config.peerId}`;
  const quads: Quad[] = [];

  const q = (s: string, p: string, o: string) =>
    quads.push({ subject: s, predicate: p, object: o, graph: AGENT_REGISTRY_GRAPH });

  q(entity, RDF_TYPE, `${SKILL}Agent`);
  q(entity, `${SCHEMA}name`, `"${config.name}"`);
  q(entity, `${DKG}peerId`, `"${config.peerId}"`);

  if (config.description) {
    q(entity, `${SCHEMA}description`, `"${config.description}"`);
  }
  if (config.framework) {
    q(entity, `${SKILL}framework`, `"${config.framework}"`);
  }

  for (let i = 0; i < config.skills.length; i++) {
    const skill = config.skills[i];
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

  if (config.paranetsServed?.length) {
    const hostingUri = `${entity}/.well-known/genid/hosting`;
    q(entity, `${SKILL}hostingProfile`, hostingUri);
    q(hostingUri, RDF_TYPE, `${SKILL}HostingProfile`);
    q(hostingUri, `${SKILL}paranetsServed`, `"${config.paranetsServed.join(',')}"`);
  }

  return { quads, rootEntity: entity };
}
