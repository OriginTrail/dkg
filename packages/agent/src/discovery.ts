import type { QueryEngine, QueryResult } from '@dkg/query';
import { AGENT_REGISTRY_PARANET } from './profile.js';

const SKILL = 'https://dkg.origintrail.io/skill#';

export interface DiscoveredAgent {
  agentUri: string;
  name: string;
  peerId: string;
  framework?: string;
}

export interface DiscoveredOffering {
  agentUri: string;
  agentName: string;
  offeringUri: string;
  skillType: string;
  pricePerCall?: number;
  successRate?: number;
  currency?: string;
}

export interface SkillSearchOptions {
  skillType?: string;
  maxPrice?: number;
  minSuccessRate?: number;
  framework?: string;
  limit?: number;
}

/**
 * Discovers agents and skill offerings by querying the local Agent Registry
 * paranet. All queries are strictly local (Spec §1.6 Store Isolation).
 */
export class DiscoveryClient {
  private readonly engine: QueryEngine;

  constructor(engine: QueryEngine) {
    this.engine = engine;
  }

  async findAgents(options: { framework?: string; limit?: number } = {}): Promise<DiscoveredAgent[]> {
    let filter = '';
    if (options.framework) {
      filter += `\n      ?agent <${SKILL}framework> "${options.framework}" .`;
    }

    const limitClause = options.limit ? `LIMIT ${options.limit}` : '';

    const sparql = `
      SELECT ?agent ?name ?peerId ?framework WHERE {
        ?agent a <${SKILL}Agent> ;
               <http://schema.org/name> ?name ;
               <http://dkg.io/ontology/peerId> ?peerId .${filter}
        OPTIONAL { ?agent <${SKILL}framework> ?framework }
      }
      ${limitClause}
    `;

    const result = await this.engine.query(sparql, { paranetId: AGENT_REGISTRY_PARANET });

    return result.bindings.map((row) => ({
      agentUri: row['agent'],
      name: stripQuotes(row['name']),
      peerId: stripQuotes(row['peerId']),
      framework: row['framework'] ? stripQuotes(row['framework']) : undefined,
    }));
  }

  async findSkillOfferings(options: SkillSearchOptions = {}): Promise<DiscoveredOffering[]> {
    const filters: string[] = [];

    let skillMatch = `?offering <${SKILL}skill> ?skillType .`;
    if (options.skillType) {
      skillMatch = `?offering <${SKILL}skill> <${SKILL}${options.skillType}> .
        BIND(<${SKILL}${options.skillType}> AS ?skillType)`;
    }

    if (options.maxPrice !== undefined) {
      filters.push(`FILTER(xsd:decimal(?price) <= ${options.maxPrice})`);
    }
    if (options.minSuccessRate !== undefined) {
      filters.push(`FILTER(xsd:float(?successRate) >= ${options.minSuccessRate})`);
    }
    if (options.framework) {
      filters.push(`?agent <${SKILL}framework> "${options.framework}" .`);
    }

    const limitClause = options.limit ? `LIMIT ${options.limit}` : '';
    const filterBlock = filters.join('\n        ');

    const sparql = `
      PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
      SELECT ?agent ?agentName ?offering ?skillType ?price ?successRate ?currency WHERE {
        ?agent a <${SKILL}Agent> ;
               <http://schema.org/name> ?agentName ;
               <${SKILL}offersSkill> ?offering .
        ${skillMatch}
        OPTIONAL { ?offering <${SKILL}pricePerCall> ?price }
        OPTIONAL { ?offering <${SKILL}successRate> ?successRate }
        OPTIONAL { ?offering <${SKILL}currency> ?currency }
        ${filterBlock}
      }
      ${limitClause}
    `;

    const result = await this.engine.query(sparql, { paranetId: AGENT_REGISTRY_PARANET });

    return result.bindings.map((row) => ({
      agentUri: row['agent'],
      agentName: stripQuotes(row['agentName']),
      offeringUri: row['offering'],
      skillType: row['skillType']?.replace(SKILL, '') ?? 'Unknown',
      pricePerCall: row['price'] ? parseFloat(stripQuotes(row['price'])) : undefined,
      successRate: row['successRate'] ? parseFloat(stripQuotes(row['successRate'])) : undefined,
      currency: row['currency'] ? stripQuotes(row['currency']) : undefined,
    }));
  }

  async findAgentByPeerId(peerId: string): Promise<DiscoveredAgent | null> {
    const sparql = `
      SELECT ?agent ?name ?framework WHERE {
        ?agent a <${SKILL}Agent> ;
               <http://schema.org/name> ?name .
        OPTIONAL { ?agent <${SKILL}framework> ?framework }
      }
      LIMIT 10
    `;

    const result = await this.engine.query(sparql, { paranetId: AGENT_REGISTRY_PARANET });
    for (const row of result.bindings) {
      const uri = row['agent'];
      if (uri.endsWith(`:${peerId}`) || uri.includes(`agent:${peerId}`)) {
        return {
          agentUri: uri,
          name: stripQuotes(row['name']),
          peerId,
          framework: row['framework'] ? stripQuotes(row['framework']) : undefined,
        };
      }
    }
    return null;
  }
}

function stripQuotes(s: string): string {
  if (s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1);
  const match = s.match(/^"(.*)"(\^\^.*|@.*)?$/);
  if (match) return match[1];
  return s;
}
