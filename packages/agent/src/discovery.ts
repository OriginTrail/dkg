import type { QueryEngine, QueryResult } from '@origintrail-official/dkg-query';
import { DKG_ONTOLOGY, escapeSparqlLiteral, assertSafeIri } from '@origintrail-official/dkg-core';
import { AGENT_REGISTRY_CONTEXT_GRAPH } from './profile.js';

const SKILL = 'https://dkg.origintrail.io/skill#';
const DKG = 'https://dkg.network/ontology#';
const SCHEMA = 'https://schema.org/';

export interface DiscoveredAgent {
  agentUri: string;
  name: string;
  peerId: string;
  framework?: string;
  nodeRole?: string;
  relayAddress?: string;
  agentAddress?: string;
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
 * context graph. All queries are strictly local (Spec §1.6 Store Isolation).
 */
export class DiscoveryClient {
  private readonly engine: QueryEngine;

  constructor(engine: QueryEngine) {
    this.engine = engine;
  }

  async findAgents(options: { framework?: string; limit?: number } = {}): Promise<DiscoveredAgent[]> {
    let filter = '';
    if (options.framework) {
      filter += `\n      ?agent <${SKILL}framework> "${escapeSparqlLiteral(options.framework)}" .`;
    }

    const limitClause = options.limit ? `LIMIT ${options.limit}` : '';

    const sparql = `
      SELECT ?agent ?name ?peerId ?framework ?nodeRole ?relayAddress ?agentAddress WHERE {
        ?agent a <${DKG}Agent> ;
               <${SCHEMA}name> ?name ;
               <${DKG}peerId> ?peerId .${filter}
        OPTIONAL { ?agent <${SKILL}framework> ?framework }
        OPTIONAL { ?agent <${DKG}nodeRole> ?nodeRole }
        OPTIONAL { ?agent <${DKG}relayAddress> ?relayAddress }
        OPTIONAL { ?agent <${DKG}agentAddress> ?agentAddress }
      }
      ${limitClause}
    `;

    const result = await this.engine.query(sparql, { paranetId: AGENT_REGISTRY_CONTEXT_GRAPH });

    return result.bindings.map((row) => ({
      agentUri: row['agent'],
      name: stripQuotes(row['name']),
      peerId: stripQuotes(row['peerId']),
      framework: row['framework'] ? stripQuotes(row['framework']) : undefined,
      nodeRole: row['nodeRole'] ? stripQuotes(row['nodeRole']) : undefined,
      relayAddress: row['relayAddress'] ? stripQuotes(row['relayAddress']) : undefined,
      agentAddress: row['agentAddress'] ? stripQuotes(row['agentAddress']) : undefined,
    }));
  }

  async findSkillOfferings(options: SkillSearchOptions = {}): Promise<DiscoveredOffering[]> {
    const filters: string[] = [];

    let skillMatch = `?offering <${SKILL}skill> ?skillType .`;
    if (options.skillType) {
      const skillUri = assertSafeIri(`${SKILL}${options.skillType}`);
      skillMatch = `?offering <${SKILL}skill> <${skillUri}> .
        BIND(<${skillUri}> AS ?skillType)`;
    }

    if (options.maxPrice !== undefined) {
      filters.push(`FILTER(xsd:decimal(?price) <= ${options.maxPrice})`);
    }
    if (options.minSuccessRate !== undefined) {
      filters.push(`FILTER(xsd:float(?successRate) >= ${options.minSuccessRate})`);
    }
    if (options.framework) {
      filters.push(`?agent <${SKILL}framework> "${escapeSparqlLiteral(options.framework)}" .`);
    }

    const limitClause = options.limit ? `LIMIT ${options.limit}` : '';
    const filterBlock = filters.join('\n        ');

    const sparql = `
      PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
      SELECT ?agent ?agentName ?offering ?skillType ?price ?successRate ?currency WHERE {
        ?agent a <${DKG}Agent> ;
               <${SCHEMA}name> ?agentName ;
               <${SKILL}offersSkill> ?offering .
        ${skillMatch}
        OPTIONAL { ?offering <${SKILL}pricePerCall> ?price }
        OPTIONAL { ?offering <${SKILL}successRate> ?successRate }
        OPTIONAL { ?offering <${SKILL}currency> ?currency }
        ${filterBlock}
      }
      ${limitClause}
    `;

    const result = await this.engine.query(sparql, { paranetId: AGENT_REGISTRY_CONTEXT_GRAPH });

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
      SELECT ?agent ?name ?framework ?nodeRole ?relayAddress WHERE {
        ?agent a <${DKG}Agent> ;
               <${SCHEMA}name> ?name ;
               <${DKG}peerId> "${escapeSparqlLiteral(peerId)}" .
        OPTIONAL { ?agent <${SKILL}framework> ?framework }
        OPTIONAL { ?agent <${DKG}nodeRole> ?nodeRole }
        OPTIONAL { ?agent <${DKG}relayAddress> ?relayAddress }
      }
      LIMIT 1
    `;

    const result = await this.engine.query(sparql, { paranetId: AGENT_REGISTRY_CONTEXT_GRAPH });
    if (result.bindings.length === 0) return null;

    const row = result.bindings[0];
    return {
      agentUri: row['agent'],
      name: stripQuotes(row['name']),
      peerId,
      framework: row['framework'] ? stripQuotes(row['framework']) : undefined,
      nodeRole: row['nodeRole'] ? stripQuotes(row['nodeRole']) : undefined,
      relayAddress: row['relayAddress'] ? stripQuotes(row['relayAddress']) : undefined,
    };
  }
}

function stripQuotes(s: string): string {
  if (s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1);
  const match = s.match(/^"(.*)"(\^\^.*|@.*)?$/);
  if (match) return match[1];
  return s;
}
