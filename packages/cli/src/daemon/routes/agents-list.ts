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
 * CURSOR STABILITY. Pages are ordered first by a digest of the canonical agent
 * URI, then by a digest of the exhaustive row projection. The cursor names the
 * last row returned. Mutable profile fields cannot move an identity across the
 * walk; their row digest only disambiguates conflicting bindings within that
 * identity. Keyset (strictly-after) semantics mean deleting a row cannot wedge
 * the walk.
 *
 * The cursor is a DIGEST, not the row itself, for two reasons. Size: row
 * fields are other agents' self-published profile literals, so a row-embedding
 * cursor hands any network agent that publishes a multi-KB name the power to
 * push every client's next-page URL past proxy header limits and wedge the
 * walk at its row. And filter binding: the cursor also carries a fingerprint
 * of the filters it was issued under, so continuing a walk with different
 * filters is a 400 instead of a plausible-looking wrong continuation.
 */
import {
  discoveredAgentIdentityKey,
  discoveredAgentRowKey,
  groupDiscoveredAgentIdentityRows,
  type DiscoveredAgent,
} from '@origintrail-official/dkg-agent';
import { toAgentDid } from '@origintrail-official/dkg-core';
import { createHash } from 'node:crypto';
import { jsonResponse } from '../http-utils.js';
import type { RequestContext } from './context.js';

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

interface AgentsListCursor {
  readonly identityDigest: string;
  readonly rowDigest?: string;
}

export interface AgentsListQuery extends AgentsListFilters {
  limit?: number;
  /** Decoded only by request parsing and already proven to belong to these filters. */
  cursor?: AgentsListCursor;
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

  const query: AgentsListQuery = { ...filters };
  if (limit !== undefined) query.limit = limit;

  const cursor = searchParams.get('cursor');
  if (cursor !== null) {
    const decodedCursor = decodeCursor(cursor);
    if (decodedCursor === undefined) {
      return { ok: false, error: '"cursor" is not a cursor from a previous response' };
    }
    if (decodedCursor.fingerprint !== filterFingerprint(filters)) {
      return {
        ok: false,
        error: '"cursor" was issued under different filter parameters; ' +
          'repeat the exact framework/skill_type/connectionStatus/local values from the first page',
      };
    }
    query.cursor = {
      identityDigest: decodedCursor.identityDigest,
      ...(decodedCursor.rowDigest === undefined ? {} : { rowDigest: decodedCursor.rowDigest }),
    };
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

export interface AgentsPage {
  rows: DiscoveredAgent[];
  /** Present only when a `limit` was given and rows remain past this page. */
  nextCursor?: string;
}

/**
 * Keyset pagination over stable discovered-agent identity.
 *
 * No `limit` and no `cursor` returns the rows untouched, in their original
 * order — the compatibility contract for parameterless callers. Paginated
 * requests retain every exact-distinct binding and order rows by canonical
 * identity digest, then exact-row digest. `limit` is a hard bound on the flat
 * response, so a large conflict group continues across pages instead of
 * producing an oversized response.
 */
export function paginateAgentRows(
  rows: DiscoveredAgent[],
  query: AgentsListQuery,
): AgentsPage {
  if (query.limit === undefined && query.cursor === undefined) {
    return { rows };
  }

  const fingerprint = filterFingerprint(query);
  const cursorPosition = query.cursor;

  const keyed = groupDiscoveredAgentIdentityRows(rows)
    .flatMap((group) => {
      const identityDigest = createHash('sha256')
        .update(group.identity, 'utf8')
        .digest('hex');
      return group.rows.map((row) => ({
        row,
        identityDigest,
        rowDigest: createHash('sha256')
          .update(discoveredAgentRowKey(row), 'utf8')
          .digest('hex'),
      }));
    })
    .sort((left, right) => (
      left.identityDigest < right.identityDigest
        ? -1
        : left.identityDigest > right.identityDigest
          ? 1
          : left.rowDigest < right.rowDigest
            ? -1
            : left.rowDigest > right.rowDigest
              ? 1
              : 0
    ));
  // Strictly-after: the cursor names a position, not a row, so a row deleted
  // between requests cannot wedge the walk.
  const after = cursorPosition === undefined
    ? keyed
    : keyed.filter((entry) => (
      entry.identityDigest > cursorPosition.identityDigest
      || (
        cursorPosition.rowDigest !== undefined
        && entry.identityDigest === cursorPosition.identityDigest
        && entry.rowDigest > cursorPosition.rowDigest
      )
    ));
  if (query.limit === undefined || after.length <= query.limit) {
    return { rows: after.map((entry) => entry.row) };
  }
  const page = after.slice(0, query.limit);
  const last = page[page.length - 1]!;
  const identityComplete = !keyed.some((entry) => (
    entry.identityDigest === last.identityDigest
    && entry.rowDigest > last.rowDigest
  ));
  return {
    rows: page.map((entry) => entry.row),
    nextCursor: encodeCursor(
      fingerprint,
      last.identityDigest,
      identityComplete ? undefined : last.rowDigest,
    ),
  };
}

/**
 * Cursors are opaque to callers but versioned here, so a future layout change
 * can reject old cursors with a clear 400 instead of returning wrong pages.
 * Layout: `v2:<16-hex filter fingerprint>:<64-hex identity digest>:<row digest|end>` —
 * fixed size by construction, whatever the registry rows contain. `end` records that the page
 * exhausted its final identity, so later profile mutations cannot make that identity reappear.
 */
const CURSOR_PREFIX = 'v2:';
const CURSOR_BODY_RE = /^([0-9a-f]{16}):([0-9a-f]{64}):(end|[0-9a-f]{64})$/;

function encodeCursor(
  fingerprint: string,
  identityDigest: string,
  rowDigest: string | undefined,
): string {
  return Buffer.from(
    `${CURSOR_PREFIX}${fingerprint}:${identityDigest}:${rowDigest ?? 'end'}`,
    'utf8',
  ).toString('base64url');
}

function decodeCursor(cursor: string): {
  fingerprint: string;
  identityDigest: string;
  rowDigest?: string;
} | undefined {
  // Buffer.from() does not throw on malformed base64url — it decodes what it
  // can. The prefix + shape check is the validation: garbage will not fit it.
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  if (!decoded.startsWith(CURSOR_PREFIX)) return undefined;
  const m = CURSOR_BODY_RE.exec(decoded.slice(CURSOR_PREFIX.length));
  if (!m) return undefined;
  return {
    fingerprint: m[1]!,
    identityDigest: m[2]!,
    ...(m[3] === 'end' ? {} : { rowDigest: m[3]! }),
  };
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
  } = parsedQuery.query;
  const [agents, offerings] = await Promise.all([
    agent.findAgents(framework ? { framework } : undefined),
    skillType ? agent.findSkills({ skillType }) : Promise.resolve(undefined),
  ]);
  let filteredAgents = agents;
  if (offerings) {
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

  // The registry is network-published data, so a wallet-address match alone is
  // not provenance. The daemon publishes exactly its default profile; require
  // its canonical DID and current peer binding together. A stale/co-registered
  // remote row reusing any local wallet therefore cannot become `self`.
  const defaultAgentAddress = agent.getDefaultAgentAddress();
  const defaultAgentAddressLower = defaultAgentAddress?.toLowerCase();
  const defaultAgentUri = defaultAgentAddress
    ? toAgentDid(defaultAgentAddress)
    : undefined;
  const isLocalAgent = (candidate: typeof filteredAgents[number]): boolean =>
    defaultAgentAddressLower !== undefined
    && defaultAgentUri !== undefined
    && candidate.peerId === agent.peerId
    && candidate.agentAddress?.toLowerCase() === defaultAgentAddressLower
    && discoveredAgentIdentityKey(candidate) === defaultAgentUri;
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

  const page = paginateAgentRows(filteredAgents, parsedQuery.query);
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
