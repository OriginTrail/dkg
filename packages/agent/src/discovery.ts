import type { QueryEngine, QueryResult } from '@origintrail-official/dkg-query';
import {
  DKG_ONTOLOGY,
  escapeSparqlLiteral,
  assertSafeIri,
  normalizeAgentDid,
  sparqlIri,
} from '@origintrail-official/dkg-core';
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

/**
 * Stable identity used by keyset pagination and identity-level conflict handling.
 *
 * Only the canonical agent URI participates. Mutable profile fields are deliberately excluded,
 * so changing a name, peer binding, framework, or future optional field cannot move an agent
 * across an in-progress page walk. EVM-address DIDs are case-normalized to the same canonical
 * shape emitted by the profile writer.
 */
export function discoveredAgentIdentityKey(
  agent: Pick<DiscoveredAgent, 'agentUri'>,
): string {
  return normalizeAgentDid(agent.agentUri);
}

/** Explicit exact-row key for the current public DiscoveredAgent model. */
const DISCOVERED_AGENT_ROW_FIELDS = {
  agentUri: true,
  name: true,
  peerId: true,
  framework: true,
  nodeRole: true,
  relayAddress: true,
  agentAddress: true,
  multiaddrs: true,
  lastSeen: true,
} satisfies Record<keyof DiscoveredAgent, true>;

function discoveredAgentRowKey(agent: DiscoveredAgent): string {
  void DISCOVERED_AGENT_ROW_FIELDS;
  return JSON.stringify([
    discoveredAgentIdentityKey(agent),
    agent.name,
    agent.peerId,
    agent.framework ?? null,
    agent.nodeRole ?? null,
    agent.relayAddress ?? null,
    agent.agentAddress ?? null,
    agent.multiaddrs ? [...agent.multiaddrs].sort() : null,
    agent.lastSeen ?? null,
  ]);
}

export interface DiscoveredAgentIdentityRows {
  identity: string;
  rows: DiscoveredAgent[];
}

/**
 * Group exact-distinct public bindings behind their stable canonical identity.
 *
 * The registry does not currently expose provenance that can prove which of two peer bindings is
 * authoritative. Discarding either binding would therefore invent a winner. Keep every distinct
 * binding together; consumers can page identities without splitting or repeating the group.
 */
export function groupDiscoveredAgentIdentityRows(
  agents: readonly DiscoveredAgent[],
): DiscoveredAgentIdentityRows[] {
  const rowsByIdentity = new Map<string, Map<string, DiscoveredAgent>>();
  for (const agent of agents) {
    const identity = discoveredAgentIdentityKey(agent);
    const normalized: DiscoveredAgent = {
      ...agent,
      agentUri: identity,
      ...(agent.multiaddrs ? { multiaddrs: [...agent.multiaddrs].sort() } : {}),
    };
    let rows = rowsByIdentity.get(identity);
    if (!rows) {
      rows = new Map<string, DiscoveredAgent>();
      rowsByIdentity.set(identity, rows);
    }
    rows.set(discoveredAgentRowKey(normalized), normalized);
  }
  return [...rowsByIdentity].map(([identity, rows]) => ({
    identity,
    rows: [...rows]
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([, row]) => row),
  }));
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

  async findAgents(options: {
    framework?: string;
    agentAddress?: string;
    limit?: number;
    signal?: AbortSignal;
  } = {}): Promise<DiscoveredAgent[]> {
    let filter = '';
    if (options.framework) {
      filter += `\n      ?agent <${SKILL}framework> "${escapeSparqlLiteral(options.framework)}" .`;
    }
    if (options.agentAddress) {
      filter += `\n      ?agent <${DKG}agentAddress> "${escapeSparqlLiteral(options.agentAddress)}" .`;
    }

    const sparql = `
      SELECT DISTINCT ?agent ?name ?peerId ?framework ?nodeRole ?relayAddress ?agentAddress WHERE {
        ?agent a <${DKG}Agent> ;
               <${SCHEMA}name> ?name ;
               <${DKG}peerId> ?peerId .${filter}
        OPTIONAL { ?agent <${SKILL}framework> ?framework }
        OPTIONAL { ?agent <${DKG}nodeRole> ?nodeRole }
        OPTIONAL { ?agent <${DKG}relayAddress> ?relayAddress }
        OPTIONAL { ?agent <${DKG}agentAddress> ?agentAddress }
      }
    `;

    const result = await this.engine.query(sparql, {
      contextGraphId: AGENT_REGISTRY_CONTEXT_GRAPH,
      signal: options.signal,
    });

    const discovered = result.bindings.map((row) => ({
      agentUri: row['agent'],
      name: stripQuotes(row['name']),
      peerId: stripQuotes(row['peerId']),
      framework: row['framework'] ? stripQuotes(row['framework']) : undefined,
      nodeRole: row['nodeRole'] ? stripQuotes(row['nodeRole']) : undefined,
      relayAddress: row['relayAddress'] ? stripQuotes(row['relayAddress']) : undefined,
      agentAddress: row['agentAddress'] ? stripQuotes(row['agentAddress']) : undefined,
    }));

    // DISTINCT is the primary query-boundary guarantee. Keep an explicit
    // typed-row fence as well because different RDF term encodings can
    // normalize to the same public string values after `stripQuotes`.
    const seen = new Set<string>();
    const unique = discovered.filter((agent) => {
      const key = discoveredAgentRowKey(agent);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    // RDF-distinct bindings may normalize to one public row. Applying LIMIT in SPARQL would let
    // those encodings consume the caller-visible slots and hide later unique agents permanently.
    return options.limit === undefined ? unique : unique.slice(0, options.limit);
  }

  /**
   * Deterministic, duplicate-free wallet-to-peer lookup for bounded recovery.
   * Rich profile rows are deliberately not selected here: OPTIONAL profile
   * properties can multiply rows before LIMIT and permanently hide a peer.
   */
  async findAgentPeerIdsByAddress(
    agentAddress: string,
    options: { afterPeerId?: string; limit?: number; signal?: AbortSignal } = {},
  ): Promise<string[]> {
    const isEvmAddress = /^0x[0-9a-fA-F]{40}$/.test(agentAddress);
    const addressMatch = isEvmAddress
      ? `?agent <${DKG}agentAddress> ?storedAgentAddress .
        FILTER(LCASE(STR(?storedAgentAddress)) = "${escapeSparqlLiteral(agentAddress.toLowerCase())}")`
      : `?agent <${DKG}agentAddress> "${escapeSparqlLiteral(agentAddress)}" .`;
    const limit = options.limit === undefined
      ? undefined
      : Math.max(1, Math.floor(options.limit));
    const afterFilter = options.afterPeerId
      ? `FILTER(STR(?peerId) > "${escapeSparqlLiteral(options.afterPeerId)}")`
      : '';
    const result = await this.engine.query(`
      SELECT DISTINCT ?peerId WHERE {
        ?agent a <${DKG}Agent> ;
               <${DKG}peerId> ?peerId .
        ${addressMatch}
        ${afterFilter}
      }
      ORDER BY ASC(STR(?peerId))
      ${limit === undefined ? '' : `LIMIT ${limit}`}
    `, {
      contextGraphId: AGENT_REGISTRY_CONTEXT_GRAPH,
      signal: options.signal,
    });

    return result.bindings
      .map((row) => stripQuotes(row['peerId'] ?? ''))
      .filter((peerId) => peerId.length > 0);
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

  async findAgentByPeerId(
    peerId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<DiscoveredAgent | null> {
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

    const scalarResult = await this.engine.query(scalar, {
      contextGraphId: AGENT_REGISTRY_CONTEXT_GRAPH,
      signal: options.signal,
    });
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
    const multiResult = await this.engine.query(multiSparql, {
      contextGraphId: AGENT_REGISTRY_CONTEXT_GRAPH,
      signal: options.signal,
    });
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
