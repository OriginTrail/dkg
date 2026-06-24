import type { QueryEngine, QueryResult } from '@origintrail-official/dkg-query';
import { DKG_ONTOLOGY, escapeSparqlLiteral, assertSafeIri, sparqlIri } from '@origintrail-official/dkg-core';
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
  /**
   * Direct libp2p multiaddrs the agent has published via
   * `dkg:multiaddr` (PR feat/chain-agents-cg-phonebook). Empty
   * array when the profile pre-dates the phonebook schema or the
   * agent has nothing dialable to advertise.
   */
  multiaddrs?: string[];
  /**
   * ISO-8601 timestamp from the agent's `dkg:lastSeen` triple.
   * Undefined when the profile pre-dates the phonebook schema;
   * consumers should treat undefined as "unknown freshness" and
   * fall back to `relayAddress` only.
   */
  lastSeen?: string;
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

    const result = await this.engine.query(sparql, { contextGraphId: AGENT_REGISTRY_CONTEXT_GRAPH });

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

  /**
   * OT-RFC-55 §5.1 — the READ side of the "context-oracle" phonebook: which peers
   * advertise that they serve the (public) context graph `contextGraphId`. Reads
   * the `skill:contextGraphsServed` triples published by {@link buildAgentProfile}
   * into the agents registry CG. Only public, subscribed, non-system CGs are ever
   * advertised there (the publish side filters), so this never leaks private CGs.
   *
   * Strictly local (over this node's synced copy of the agents CG), so coverage is
   * bounded by agents-CG gossip freshness — same caveat as {@link findAgents}.
   */
  async findNodesServingCG(contextGraphId: string): Promise<string[]> {
    const sparql = `
      SELECT DISTINCT ?peerId WHERE {
        ?agent <${DKG}peerId> ?peerId ;
               <${SKILL}hostingProfile> ?hosting .
        ?hosting <${SKILL}contextGraphsServed> "${escapeSparqlLiteral(contextGraphId)}" .
      }
    `;
    const result = await this.engine.query(sparql, { contextGraphId: AGENT_REGISTRY_CONTEXT_GRAPH });
    const peers = result.bindings
      .map((row) => stripQuotes(row['peerId']))
      .filter((p): p is string => typeof p === 'string' && p.length > 0);
    return Array.from(new Set(peers));
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

    const result = await this.engine.query(sparql, { contextGraphId: AGENT_REGISTRY_CONTEXT_GRAPH });

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
    // Two-query path keeps the existing single-row SELECT semantics
    // for scalar columns (name, framework, nodeRole, relayAddress,
    // lastSeen) while a separate query gathers all `dkg:multiaddr`
    // rows. Pulling multiaddrs inline would force a GROUP_CONCAT
    // round-trip; that works but is harder to test deterministically
    // (engine-specific ordering / separator semantics). Two queries
    // keep each result simple.
    // `FILTER(isIRI(?agent))` constrains the first query at the engine
    // layer so blank-node subjects (`_:b1`) and other non-IRI bindings
    // never reach the JS code. The `assertSafeIri` / `sparqlIri` call
    // below is defense-in-depth — an IRI that survives `isIRI` but
    // contains a `>` / whitespace / control char would still break
    // the second query's `<${agentUri}>` interpolation. Codex review
    // of PR #700 round 3 caught the prior unguarded interpolation.
    const scalar = `
      SELECT ?agent ?name ?framework ?nodeRole ?relayAddress ?agentAddress ?lastSeen WHERE {
        ?agent a <${DKG}Agent> ;
               <${SCHEMA}name> ?name ;
               <${DKG}peerId> "${escapeSparqlLiteral(peerId)}" .
        FILTER(isIRI(?agent))
        OPTIONAL { ?agent <${SKILL}framework> ?framework }
        OPTIONAL { ?agent <${DKG}nodeRole> ?nodeRole }
        OPTIONAL { ?agent <${DKG}relayAddress> ?relayAddress }
        OPTIONAL { ?agent <${DKG}agentAddress> ?agentAddress }
        OPTIONAL { ?agent <${DKG}lastSeen> ?lastSeen }
      }
      LIMIT 1
    `;

    const scalarResult = await this.engine.query(scalar, { contextGraphId: AGENT_REGISTRY_CONTEXT_GRAPH });
    if (scalarResult.bindings.length === 0) return null;

    const row = scalarResult.bindings[0];
    const agentUri = row['agent'];

    // Defense-in-depth: even though `FILTER(isIRI(?agent))` above
    // already drops blank-node subjects at the engine layer, the IRI
    // could still contain a character that breaks SPARQL `<...>`
    // interpolation (`>`, whitespace, control chars). If that happens
    // we treat the whole entry as not-found rather than returning a
    // partial profile — letting a malformed `agentUri` propagate to
    // downstream consumers (who may re-interpolate it into their own
    // queries) would just relocate the bug. With the engine-side
    // FILTER in place this branch is "should never happen in
    // practice"; the guard is purely a hardening fence.
    let safeAgentIri: string;
    try {
      safeAgentIri = assertSafeIri(agentUri);
    } catch {
      return null;
    }

    const multiSparql = `
      SELECT ?multiaddr WHERE {
        ${sparqlIri(safeAgentIri)} <${DKG}multiaddr> ?multiaddr .
      }
    `;
    const multiResult = await this.engine.query(multiSparql, { contextGraphId: AGENT_REGISTRY_CONTEXT_GRAPH });
    const multiaddrs = multiResult.bindings
      .map((r) => (r['multiaddr'] ? stripQuotes(r['multiaddr']) : ''))
      .filter((s) => s.length > 0);

    return {
      agentUri: safeAgentIri,
      name: stripQuotes(row['name']),
      peerId,
      framework: row['framework'] ? stripQuotes(row['framework']) : undefined,
      nodeRole: row['nodeRole'] ? stripQuotes(row['nodeRole']) : undefined,
      relayAddress: row['relayAddress'] ? stripQuotes(row['relayAddress']) : undefined,
      // `agentAddress` is what `DKGAgent.drainPendingSenderKeyForPeer` keys
      // its pending-by-agent queue lookups against. Omitting it here makes
      // `drainPendingSenderKeyForPeer` an unconditional no-op in production
      // — the queue grows but never replays. Match `findAgents()`'s scalar
      // surface (`SELECT ... ?agentAddress`) so both discovery entry points
      // resolve the same identity for the same peer.
      agentAddress: row['agentAddress'] ? stripQuotes(row['agentAddress']) : undefined,
      multiaddrs: multiaddrs.length > 0 ? multiaddrs : undefined,
      lastSeen: row['lastSeen'] ? stripQuotes(row['lastSeen']) : undefined,
    };
  }
}

function stripQuotes(s: string): string {
  if (s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1);
  const match = s.match(/^"(.*)"(\^\^.*|@.*)?$/);
  if (match) return match[1];
  return s;
}
