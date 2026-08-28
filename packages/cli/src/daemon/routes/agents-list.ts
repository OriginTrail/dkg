/**
 * Query handling for `GET /api/agents` (GH#310).
 *
 * The endpoint returns the full network agent registry — ~750 agents /
 * ~150 KB on a typical node — with no way to ask for less. Integrations whose
 * only need is "what's my own agent address" pay for the whole registry on
 * every call. This module adds `connectionStatus=`, `local=true` and
 * `limit`/`cursor` pagination, while keeping the no-parameter response
 * byte-shape identical for existing consumers (node-ui's `fetchAgents()`
 * takes no arguments; the MCP `dkg_find_agents` tool passes none either).
 *
 * DUPLICATE ROWS. `DiscoveryClient.findAgents()` owns the invariant that
 * registry rows are duplicate-free. Keeping that guarantee at the discovery
 * boundary means pagination and every other discovery consumer see the same
 * typed rows instead of each repairing query-engine artifacts independently.
 *
 * CURSOR STABILITY. Pages are ordered by a digest of the canonical REGISTRY
 * row, and the cursor names the digest of the last row returned. Live
 * connection fields (latency, last-seen, connected-since) are excluded from
 * that key on purpose — they change between requests, and a cursor keyed on
 * them would drift or skip. Keyset (strictly-after) semantics mean a row
 * inserted or removed between pages shifts nothing else.
 *
 * The cursor is a DIGEST, not the row itself, for two reasons. Size: row
 * fields are other agents' self-published profile literals, so a row-embedding
 * cursor hands any network agent that publishes a multi-KB name the power to
 * push every client's next-page URL past proxy header limits and wedge the
 * walk at its row. And filter binding: the cursor also carries a fingerprint
 * of the filters it was issued under, so continuing a walk with different
 * filters is a 400 instead of a plausible-looking wrong continuation.
 */
import { createHash } from 'node:crypto';
import { jsonResponse } from '../http-utils.js';
import type { RequestContext } from './context.js';

/**
 * A raw registry row as returned by `discovery.findAgents()`. The generic
 * helpers below constrain to `object` rather than this alias so callers can
 * pass their own row interfaces (e.g. `DiscoveredAgent`, which has no index
 * signature) without widening casts.
 */
export type AgentRegistryRow = Record<string, unknown>;

export type AgentConnectionStatus = 'self' | 'connected' | 'disconnected';

const CONNECTION_STATUSES: readonly AgentConnectionStatus[] = [
  'self',
  'connected',
  'disconnected',
];

export interface AgentsListFilters {
  framework?: string;
  skillType?: string;
  connectionStatus?: AgentConnectionStatus;
  local?: boolean;
}

export interface AgentsListQuery extends AgentsListFilters {
  limit?: number;
  /** Digest of the last row of the previous page (decoded, validated). */
  cursor?: string;
  /** Fingerprint of every filter parameter, bound into issued cursors. */
  filterFingerprint: string;
}

/**
 * Every query key this endpoint understands. An unrecognized key is a 400:
 * `?limt=20` silently returning the full 150 KB registry would be exactly the
 * failure mode strict value validation exists to prevent, and the daemon's
 * clients are programs, for which a loud contract beats a lenient one.
 */
const KNOWN_QUERY_KEYS = new Set([
  'framework',
  'skill_type',
  'connectionStatus',
  'local',
  'limit',
  'cursor',
]);

export type AgentsListQueryResult =
  | { ok: true; query: AgentsListQuery }
  | { ok: false; error: string };

/**
 * Parse and validate the GH#310 query parameters. Unknown values are a 400,
 * not a silent no-op — `?local=ture` returning 750 agents would be worse than
 * an error.
 */
export function parseAgentsListQuery(searchParams: URLSearchParams): AgentsListQueryResult {
  for (const key of searchParams.keys()) {
    if (!KNOWN_QUERY_KEYS.has(key)) {
      return {
        ok: false,
        error: `Unknown query parameter "${key}"; supported: ${[...KNOWN_QUERY_KEYS].join(', ')}`,
      };
    }
  }
  const filters: AgentsListFilters = {};

  // Empty values retain the pre-GH#310 behavior: they mean "no filter".
  const framework = searchParams.get('framework');
  if (framework) filters.framework = framework;
  const skillType = searchParams.get('skill_type');
  if (skillType) filters.skillType = skillType;

  const status = searchParams.get('connectionStatus');
  if (status !== null) {
    if (!(CONNECTION_STATUSES as readonly string[]).includes(status)) {
      return {
        ok: false,
        error: `"connectionStatus" must be one of ${CONNECTION_STATUSES.join(', ')}`,
      };
    }
    filters.connectionStatus = status as AgentConnectionStatus;
  }

  const local = searchParams.get('local');
  if (local !== null) {
    if (local !== 'true' && local !== 'false') {
      return { ok: false, error: '"local" must be "true" or "false"' };
    }
    filters.local = local === 'true';
  }

  const rawLimit = searchParams.get('limit');
  let limit: number | undefined;
  if (rawLimit !== null) {
    // Digits only — Number() would also admit '+5', '1e2' and '0x10', all
    // unambiguous but all outside the documented contract.
    if (!/^[0-9]+$/.test(rawLimit) || Number(rawLimit) <= 0 || !Number.isSafeInteger(Number(rawLimit))) {
      return { ok: false, error: '"limit" must be a positive integer' };
    }
    limit = Number(rawLimit);
  }

  const query: AgentsListQuery = {
    ...filters,
    filterFingerprint: filterFingerprint(filters),
  };
  if (limit !== undefined) query.limit = limit;

  const cursor = searchParams.get('cursor');
  if (cursor !== null) {
    const decoded = decodeCursor(cursor);
    if (decoded === undefined) {
      return { ok: false, error: '"cursor" is not a cursor from a previous response' };
    }
    if (decoded.fingerprint !== query.filterFingerprint) {
      // Continuing under different filters would be a coherent-looking wrong
      // continuation — refuse rather than guess.
      return {
        ok: false,
        error: '"cursor" was issued under different filter parameters; ' +
          'repeat the exact framework/skill_type/connectionStatus/local values from the first page',
      };
    }
    query.cursor = decoded.digest;
  }

  return { ok: true, query };
}

/**
 * Order-independent fingerprint of every filter parameter, including the two
 * pre-#310 ones — a page walked under `framework=eliza` must not continue
 * without it.
 */
function filterFingerprint(filters: AgentsListFilters): string {
  // An ordered JSON tuple preserves field boundaries even when a valid value
  // contains query-string delimiters such as `&skill_type=`. It is also
  // independent of the order in which parameters appeared in the URL.
  const serialized = JSON.stringify([
    filters.framework ?? null,
    filters.skillType ?? null,
    filters.connectionStatus ?? null,
    filters.local ?? null,
  ]);
  return createHash('sha256').update(serialized, 'utf8').digest('hex').slice(0, 16);
}

/**
 * Canonical serialization of a registry row: the key both dedupe and page
 * ordering share. Keys are sorted so two rows differing only in property
 * insertion order still collide, and `undefined` values are dropped the same
 * way JSON round-tripping would drop them.
 */
function canonicalRowKey(row: object): string {
  const entries = Object.entries(row as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify(entries);
}

export interface AgentsPage<T> {
  rows: T[];
  /** Present only when a `limit` was given and rows remain past this page. */
  nextCursor?: string;
}

/** Bounded, deterministic sort key: the digest of the canonical row. */
export function rowDigest(row: object): string {
  return createHash('sha256').update(canonicalRowKey(row), 'utf8').digest('hex');
}

/**
 * Keyset pagination over deduplicated rows.
 *
 * No `limit` and no `cursor` returns the rows untouched, in their original
 * order — the compatibility contract for parameterless callers. Any use of
 * pagination switches to digest order: arbitrary but deterministic, which is
 * the property that makes the cursor mean the same thing on the next request.
 */
export function paginateAgentRows<T extends object>(
  rows: T[],
  query: Pick<AgentsListQuery, 'limit' | 'cursor' | 'filterFingerprint'>,
): AgentsPage<T> {
  if (query.limit === undefined && query.cursor === undefined) {
    return { rows };
  }
  const keyed = rows
    .map((row) => ({ row, digest: rowDigest(row) }))
    .sort((a, b) => (a.digest < b.digest ? -1 : a.digest > b.digest ? 1 : 0));
  // Strictly-after: the cursor names a position, not a row, so a row deleted
  // between requests cannot wedge the walk.
  const after = query.cursor === undefined
    ? keyed
    : keyed.filter((k) => k.digest > query.cursor!);
  if (query.limit === undefined || after.length <= query.limit) {
    return { rows: after.map((k) => k.row) };
  }
  const page = after.slice(0, query.limit);
  return {
    rows: page.map((k) => k.row),
    nextCursor: encodeCursor(query.filterFingerprint, page[page.length - 1]!.digest),
  };
}

/**
 * Cursors are opaque to callers but versioned here, so a future layout change
 * can reject old cursors with a clear 400 instead of returning wrong pages.
 * Layout: `v1:<16-hex filter fingerprint>:<64-hex row digest>` — fixed size
 * by construction, whatever the registry rows contain.
 */
const CURSOR_PREFIX = 'v1:';
const CURSOR_BODY_RE = /^([0-9a-f]{16}):([0-9a-f]{64})$/;

function encodeCursor(fingerprint: string, digest: string): string {
  return Buffer.from(`${CURSOR_PREFIX}${fingerprint}:${digest}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): { fingerprint: string; digest: string } | undefined {
  // Buffer.from() does not throw on malformed base64url — it decodes what it
  // can. The prefix + shape check is the validation: garbage will not fit it.
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  if (!decoded.startsWith(CURSOR_PREFIX)) return undefined;
  const m = CURSOR_BODY_RE.exec(decoded.slice(CURSOR_PREFIX.length));
  if (!m) return undefined;
  return { fingerprint: m[1]!, digest: m[2]! };
}

/**
 * Complete `GET /api/agents` workflow. The parent route module only dispatches
 * here; parsing, discovery, filtering, enrichment, pagination and response
 * ownership stay together at this endpoint boundary.
 */
export async function handleAgentsListRoute(ctx: RequestContext): Promise<void> {
  const { res, agent, url } = ctx;
  const parsedQuery = parseAgentsListQuery(url.searchParams);
  if (!parsedQuery.ok) {
    jsonResponse(res, 400, { error: parsedQuery.error });
    return;
  }

  const {
    framework,
    skillType,
    connectionStatus,
    local,
    limit,
    cursor,
    filterFingerprint,
  } = parsedQuery.query;
  const agents = await agent.findAgents(framework ? { framework } : undefined);
  let filteredAgents = agents;
  if (skillType) {
    const offerings = await agent.findSkills({ skillType });
    const agentUris = new Set(offerings.map((offering) => offering.agentUri));
    filteredAgents = agents.filter((candidate) => agentUris.has(candidate.agentUri));
  }

  const allConnections = agent.node.libp2p.getConnections();
  const connectionByPeer = new Map<
    string,
    { transport: string; direction: string; sinceMs: number }
  >();
  for (const connection of allConnections) {
    const peerId = connection.remotePeer.toString();
    if (!connectionByPeer.has(peerId)) {
      connectionByPeer.set(peerId, {
        transport: connection.remoteAddr?.toString().includes('/p2p-circuit')
          ? 'relayed'
          : 'direct',
        direction: connection.direction,
        sinceMs: connection.timeline?.open ? Date.now() - connection.timeline.open : 0,
      });
    }
  }

  // The registry is network-published data. Only the daemon's local identity
  // store proves ownership; a foreign row cannot become `self` by copying this
  // node's peer ID. Unpublished local identities are intentionally not
  // synthesized—the endpoint remains a view of discovered registry rows.
  const localAgentAddresses = new Set(
    agent.listLocalAgents().map((localAgent) => localAgent.agentAddress.toLowerCase()),
  );
  const isLocalAgent = (candidate: typeof filteredAgents[number]): boolean =>
    typeof candidate.agentAddress === 'string'
    && localAgentAddresses.has(candidate.agentAddress.toLowerCase());
  const statusOf = (candidate: typeof filteredAgents[number]): AgentConnectionStatus =>
    isLocalAgent(candidate)
      ? 'self'
      : connectionByPeer.has(candidate.peerId)
        ? 'connected'
        : 'disconnected';

  if (local !== undefined) {
    filteredAgents = filteredAgents.filter(
      (candidate) => isLocalAgent(candidate) === local,
    );
  }
  if (connectionStatus !== undefined) {
    filteredAgents = filteredAgents.filter(
      (candidate) => statusOf(candidate) === connectionStatus,
    );
  }

  const page = paginateAgentRows(filteredAgents, { limit, cursor, filterFingerprint });
  const healthByPeer = agent.getPeerHealth();
  const enriched = page.rows.map((candidate) => {
    const connection = connectionByPeer.get(candidate.peerId);
    const health = healthByPeer.get(candidate.peerId);
    return {
      ...candidate,
      connectionStatus: statusOf(candidate),
      connectionTransport: connection?.transport ?? null,
      connectionDirection: connection?.direction ?? null,
      connectedSinceMs: connection?.sinceMs ?? null,
      lastSeen: isLocalAgent(candidate) ? Date.now() : (health?.lastSeen ?? null),
      latencyMs: health?.latencyMs ?? null,
    };
  });

  jsonResponse(
    res,
    200,
    page.nextCursor === undefined
      ? { agents: enriched }
      : { agents: enriched, nextCursor: page.nextCursor },
  );
}
