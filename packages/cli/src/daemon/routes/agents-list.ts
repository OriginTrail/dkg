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
 * DUPLICATE ROWS. `discovery.findAgents()` selects several OPTIONAL profile
 * properties in one SPARQL query, so an agent with N values for one property
 * comes back as N rows — the sibling `findAgentPeerIdsByAddress` documents
 * exactly this hazard. Pagination over a list with duplicates would repeat
 * agents across pages, so rows are deduplicated first. Dedupe is EXACT-ROW,
 * deliberately not by `agentUri` or `peerId`: the registry legitimately holds
 * one agent URI under several peer IDs (re-registration from a new peer) and
 * one peer serving several agents, and node-ui's peer grouping depends on
 * seeing those distinct rows. Only rows identical in every field are
 * multiplication artifacts; removing them loses nothing.
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

export interface AgentsListQuery {
  connectionStatus?: AgentConnectionStatus;
  local?: boolean;
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
  const query: AgentsListQuery = {
    filterFingerprint: filterFingerprint(searchParams),
  };

  const status = searchParams.get('connectionStatus');
  if (status !== null) {
    if (!(CONNECTION_STATUSES as readonly string[]).includes(status)) {
      return {
        ok: false,
        error: `"connectionStatus" must be one of ${CONNECTION_STATUSES.join(', ')}`,
      };
    }
    query.connectionStatus = status as AgentConnectionStatus;
  }

  const local = searchParams.get('local');
  if (local !== null) {
    if (local !== 'true' && local !== 'false') {
      return { ok: false, error: '"local" must be "true" or "false"' };
    }
    query.local = local === 'true';
  }

  const limit = searchParams.get('limit');
  if (limit !== null) {
    // Digits only — Number() would also admit '+5', '1e2' and '0x10', all
    // unambiguous but all outside the documented contract.
    if (!/^[0-9]+$/.test(limit) || Number(limit) <= 0 || !Number.isSafeInteger(Number(limit))) {
      return { ok: false, error: '"limit" must be a positive integer' };
    }
    query.limit = Number(limit);
  }

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
function filterFingerprint(searchParams: URLSearchParams): string {
  const parts = ['framework', 'skill_type', 'connectionStatus', 'local']
    .map((k) => `${k}=${searchParams.get(k) ?? ''}`)
    .join('&');
  return createHash('sha256').update(parts, 'utf8').digest('hex').slice(0, 16);
}

/**
 * Canonical serialization of a registry row: the key both dedupe and page
 * ordering share. Keys are sorted so two rows differing only in property
 * insertion order still collide, and `undefined` values are dropped the same
 * way JSON round-tripping would drop them.
 */
export function canonicalRowKey(row: object): string {
  const entries = Object.entries(row as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify(entries);
}

/** Remove exact-duplicate rows, preserving first-occurrence order. */
export function dedupeExactRows<T extends object>(rows: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const row of rows) {
    const key = canonicalRowKey(row);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
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
