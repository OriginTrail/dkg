import type { QueryEngine, QueryResult } from '@origintrail-official/dkg-query';
import {
  DKG_ONTOLOGY,
  escapeSparqlLiteral,
  assertSafeIri,
  normalizeAgentDid,
  sparqlIri,
} from '@origintrail-official/dkg-core';
import { AGENT_REGISTRY_CONTEXT_GRAPH } from './profile.js';
import {
  MAX_AGENT_PEER_PAGE_SIZE,
  validateAgentPeerPage,
  validateAgentPeerPageRequest,
  type AgentPeerDiscovery,
  type AgentPeerPage,
  type AgentPeerPageRequest,
} from './agent-peer-discovery.js';

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

function defineDiscoveredAgentRowFields<
  const Fields extends readonly (keyof DiscoveredAgent)[],
>(
  fields: Fields,
  ..._missing: [Exclude<keyof DiscoveredAgent, Fields[number]>] extends [never]
    ? []
    : ['Missing DiscoveredAgent row fields', Exclude<keyof DiscoveredAgent, Fields[number]>]
): Fields {
  return fields;
}

/**
 * The one ordered projection used by exact-row deduplication and pagination.
 * Adding a public DiscoveredAgent field makes this declaration fail to compile until the field is
 * included, so the serialized key cannot silently lag behind the model.
 */
const DISCOVERED_AGENT_ROW_FIELDS = defineDiscoveredAgentRowFields([
  'agentUri',
  'name',
  'peerId',
  'framework',
  'nodeRole',
  'relayAddress',
  'agentAddress',
  'multiaddrs',
  'lastSeen',
] as const);

function normalizeDiscoveredAgentRow(agent: DiscoveredAgent): DiscoveredAgent {
  return {
    ...agent,
    agentUri: discoveredAgentIdentityKey(agent),
    ...(agent.multiaddrs ? { multiaddrs: [...agent.multiaddrs].sort() } : {}),
  };
}

export function discoveredAgentRowKey(agent: DiscoveredAgent): string {
  const normalized = normalizeDiscoveredAgentRow(agent);
  return JSON.stringify(
    DISCOVERED_AGENT_ROW_FIELDS.map((field) => normalized[field] ?? null),
  );
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
 * binding together in one deterministic group; consumers can retain every conflicting row instead
 * of inventing an authoritative winner.
 */
export function groupDiscoveredAgentIdentityRows(
  agents: readonly DiscoveredAgent[],
): DiscoveredAgentIdentityRows[] {
  const rowsByIdentity = new Map<string, Map<string, DiscoveredAgent>>();
  for (const agent of agents) {
    const identity = discoveredAgentIdentityKey(agent);
    const normalized = normalizeDiscoveredAgentRow(agent);
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

/** Upper bound of one {@link DiscoveryClient.findCoreAgentPeerHintPage} page. */
export const MAX_CORE_AGENT_PEER_HINT_PAGE_SIZE = 1024;

/**
 * One core-role phonebook binding. UNSIGNED: anyone can publish a profile that
 * names any peer id next to any wallet, so it only ever ranks dial candidates.
 */
export interface CoreAgentPeerHint {
  peerId: string;
  /** The profile's `dkg:agentAddress`, a well-formed wallet literal; validated again by the consumer. */
  agentAddress: string;
  lastSeen?: string;
}

/** Keyset cursor: the last row of the previous page, by the fixed order of the read. */
export interface CoreAgentPeerHintCursor {
  readonly agentAddress: string;
  readonly peerId: string;
}

export interface CoreAgentPeerHintPage {
  readonly hints: CoreAgentPeerHint[];
  /** Cursor of the next page; null when no further core row exists. */
  readonly next: CoreAgentPeerHintCursor | null;
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
export class DiscoveryClient implements AgentPeerDiscovery {
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
   * @deprecated Use findAgentPeerPageByAddress for bounded page consumption.
   * Preserves the existing optional-limit array API for explicit legacy callers;
   * bounded recovery never calls this facade or accumulates this full result.
   */
  async findAgentPeerIdsByAddress(
    agentAddress: string,
    options: { afterPeerId?: string; limit?: number; signal?: AbortSignal } = {},
  ): Promise<string[]> {
    const requestedLimit = options.limit === undefined ? undefined : Math.max(1, Math.floor(options.limit));
    if (requestedLimit !== undefined && !Number.isSafeInteger(requestedLimit)) {
      throw new RangeError('Peer lookup limit must be finite');
    }
    const signal = options.signal;
    let afterPeerId = options.afterPeerId || undefined;
    const peerIds: string[] = [];
    do {
      const page = await this.findAgentPeerPageByAddress(agentAddress, {
        limit: Math.min(MAX_AGENT_PEER_PAGE_SIZE, requestedLimit === undefined ? MAX_AGENT_PEER_PAGE_SIZE : requestedLimit - peerIds.length),
        afterPeerId,
        signal,
      });
      peerIds.push(...page.peerIds);
      afterPeerId = page.nextAfterPeerId ?? undefined;
    } while (afterPeerId !== undefined && (requestedLimit === undefined || peerIds.length < requestedLimit));
    return peerIds;
  }

  /**
   * Deterministic, duplicate-free wallet-to-peer lookup for bounded recovery.
   * Rich profile rows are deliberately not selected here: OPTIONAL profile
   * properties can multiply rows before LIMIT and permanently hide a peer.
   */
  async findAgentPeerPageByAddress(
    agentAddress: string,
    options: AgentPeerPageRequest,
  ): Promise<AgentPeerPage> {
    options = Object.freeze({ ...options });
    validateAgentPeerPageRequest(options);
    // A profile can carry the empty literal as its `dkg:agentAddress`. It binds
    // no wallet, so no lookup may match it: an empty wallet resolves to nobody.
    if (agentAddress.trim().length === 0) return { peerIds: [], nextAfterPeerId: null };
    const isEvmAddress = /^0x[0-9a-fA-F]{40}$/.test(agentAddress);
    const addressMatch = isEvmAddress
      ? `?agent <${DKG}agentAddress> ?storedAgentAddress .
        FILTER(LCASE(STR(?storedAgentAddress)) = "${escapeSparqlLiteral(agentAddress.toLowerCase())}")`
      : `?agent <${DKG}agentAddress> "${escapeSparqlLiteral(agentAddress)}" .`;
    const afterFilter = options.afterPeerId
      ? `FILTER(STR(?storedPeerId) > "${escapeSparqlLiteral(options.afterPeerId)}")`
      : '';
    const result = await this.engine.query(`
      SELECT DISTINCT (STR(?storedPeerId) AS ?peerId) WHERE {
        ?agent a <${DKG}Agent> ;
               <${DKG}peerId> ?storedPeerId .
        ${addressMatch}
        FILTER(STRLEN(STR(?storedPeerId)) > 0)
        ${afterFilter}
      }
      ORDER BY ASC(STR(?peerId))
      LIMIT ${options.limit + 1}
    `, {
      contextGraphId: AGENT_REGISTRY_CONTEXT_GRAPH,
      signal: options.signal,
    });

    options.signal?.throwIfAborted();
    if (result.bindings.length > options.limit + 1) {
      throw new Error('Peer registry query exceeded its row limit');
    }
    const peerIds = result.bindings.slice(0, options.limit)
      .map((row) => stripQuotes(row['peerId'] ?? ''));
    return validateAgentPeerPage({
      peerIds,
      nextAfterPeerId: result.bindings.length > options.limit ? peerIds[peerIds.length - 1] : null,
    }, options);
  }

  /**
   * One page of core-role phonebook rows for the VM holder tier: one row per
   * distinct (agentAddress, peerId) binding, in ascending (agentAddress,
   * peerId) order, at most `limit`, starting strictly after `after`.
   *
   * Every value is an UNSIGNED profile claim. The order is the binding's own
   * key, not its `lastSeen` (which only travels along, newest per binding), so
   * a publisher chooses where its rows sort but cannot move one ahead by
   * freshness; and the walk is keyset-paged so a consumer can continue past
   * junk at a rate of its own choosing (a page costs time that grows with the phonebook, so how
   * fast it gets through a flood is the consumer's bound to state). The
   * `nodeRole`, wallet-shape and peer-id-shape filters are cost bounds (an
   * Edge with the phonebook holds ~1,900 profiles on Base mainnet, about 60 of
   * them Core), never trust signals: a row whose `agentAddress` is not a
   * 20-byte hex wallet cannot bind anything, and a peer id is base58 or base32
   * text (also what keeps the cursor exact), so neither occupies a slot, and the
   * consumer must still bind each address to a ShardingTable identity on chain.
   */
  async findCoreAgentPeerHintPage(options: {
    limit: number;
    after?: CoreAgentPeerHintCursor;
    signal?: AbortSignal;
  }): Promise<CoreAgentPeerHintPage> {
    const { limit, after } = options;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_CORE_AGENT_PEER_HINT_PAGE_SIZE) {
      throw new RangeError(`Core peer hint page size must be an integer from 1 to ${MAX_CORE_AGENT_PEER_HINT_PAGE_SIZE}`);
    }
    if (
      after !== undefined
      && (typeof after.agentAddress !== 'string' || after.agentAddress.length === 0
        || typeof after.peerId !== 'string' || after.peerId.length === 0)
    ) {
      throw new TypeError('Core peer hint cursor must name a wallet and a peer id');
    }
    options.signal?.throwIfAborted();
    const afterFilter = after === undefined
      ? ''
      : `FILTER(STR(?agentAddress) > "${escapeSparqlLiteral(after.agentAddress)}"
               || (STR(?agentAddress) = "${escapeSparqlLiteral(after.agentAddress)}"
                   && STR(?peerId) > "${escapeSparqlLiteral(after.peerId)}"))`;
    // Grouping keeps a profile with several `lastSeen` rows (a re-published
    // heartbeat) from multiplying rows ahead of LIMIT and hiding another Core.
    const result = await this.engine.query(`
      SELECT ?peerId ?agentAddress (MAX(?seen) AS ?lastSeen) WHERE {
        ?agent a <${DKG}Agent> ;
               <${DKG}peerId> ?peerId ;
               <${DKG}agentAddress> ?agentAddress ;
               <${DKG}nodeRole> ?nodeRole .
        FILTER(STR(?nodeRole) = "core")
        FILTER(REGEX(STR(?agentAddress), "^0x[0-9a-fA-F]{40}$"))
        FILTER(REGEX(STR(?peerId), "^[A-Za-z0-9]{1,128}$"))
        ${afterFilter}
        OPTIONAL { ?agent <${DKG}lastSeen> ?seen }
      }
      GROUP BY ?peerId ?agentAddress
      ORDER BY ASC(STR(?agentAddress)) ASC(STR(?peerId))
      LIMIT ${limit + 1}
    `, {
      contextGraphId: AGENT_REGISTRY_CONTEXT_GRAPH,
      signal: options.signal,
    });
    options.signal?.throwIfAborted();
    if (result.bindings.length > limit + 1) {
      throw new Error('Core peer hint query exceeded its row limit');
    }
    const hints = result.bindings.slice(0, limit).flatMap((row) => {
      const peerId = stripQuotes(row['peerId'] ?? '');
      const agentAddress = stripQuotes(row['agentAddress'] ?? '');
      if (peerId.length === 0 || agentAddress.length === 0) return [];
      const lastSeen = row['lastSeen'] ? stripQuotes(row['lastSeen']) : undefined;
      return [{
        peerId,
        agentAddress,
        ...(lastSeen ? { lastSeen } : {}),
      }];
    });
    const last = result.bindings.length > limit
      ? result.bindings[limit - 1]
      : undefined;
    return {
      hints,
      next: last === undefined
        ? null
        : { agentAddress: stripQuotes(last['agentAddress'] ?? ''), peerId: stripQuotes(last['peerId'] ?? '') },
    };
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
