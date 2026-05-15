/**
 * Shared inbox read-cursor helpers for the agent-to-agent debug chat.
 *
 * Two pieces of code need to know "what is the newest inbound chat
 * message this operator has already seen":
 *
 *   - `dkg_check_inbox` MCP tool (this package, `src/tools/chat.ts`)
 *   - `inject-inbox.mjs` prompt-prefix hook (this package, `hooks/`)
 *
 * They share a single on-disk file at
 * `~/.cache/dkg-mcp/inbox-cursor-<daemon-hash>.json` so the hook's
 * "you have N unread" notice and the tool's "here are the unread
 * messages" listing stay consistent. The HOOK reads the cursor but
 * never writes — every prompt shows the same notice until the tool
 * actually surfaces the rows to the agent. The TOOL reads the cursor
 * to find the unread window and then writes the advanced compound
 * cursor back. (Codex PR #510 round 2 flagged that the tool had no
 * persisted cursor and would replay the same messages on every call.)
 *
 * STATE SHAPE
 * ───────────
 *   { "ts": <ms>, "id": <sqlite rowid> }
 *
 * Both fields together form a **compound cursor** because rows can
 * share a `Date.now()` value. The predicate used by callers is:
 *
 *   ts > cursor.ts  OR  (ts = cursor.ts AND id > cursor.id)
 *
 * which matches `DashboardDB.getChatMessages({ since, sinceId })`.
 * Legacy single-`lastSeen` files written by the first version of
 * `inject-inbox.mjs` are read back as `{ ts: lastSeen, id: 0 }`,
 * which means we may briefly re-surface the message that exactly
 * matched that timestamp — acceptable for a one-shot upgrade.
 *
 * DAEMON IDENTITY HASH
 * ────────────────────
 * Keyed by `sha1(api ⊕ sourcePath ⊕ DKG_HOME).slice(0,12)`. The mjs
 * hook computes the identical hash from the same three ingredients,
 * so the two surfaces use the SAME file. Two daemons on the same OS
 * account get distinct state files (the two-laptop-on-one-box debug
 * scenario this PR enables).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export interface InboxCursor {
  /** Highest `ts` we have already surfaced. */
  ts: number;
  /**
   * Highest `id` at that `ts`. Combined with `ts` this is the compound
   * cursor used for lossless pagination across same-millisecond rows.
   * `0` for legacy state files that only have `lastSeen`.
   */
  id: number;
}

export interface DaemonIdentityInput {
  /** Daemon HTTP API base URL — the canonical "who am I talking to". */
  api: string;
  /** `.dkg/config.yaml` (or `DKG_HOME/config.json`) path. */
  sourcePath: string | null;
}

/**
 * Computed lazily because `os.homedir()` reads `HOME` (POSIX) /
 * `USERPROFILE` (win) at call time, and we want unit tests to be
 * able to redirect this to a sandbox by overriding `HOME` before
 * calling load/save. (Caching at module load would baking in the
 * operator's real cache dir.)
 */
function stateDir(): string {
  return path.join(os.homedir(), '.cache', 'dkg-mcp');
}

/**
 * Stable short hash identifying one daemon (API + config source +
 * DKG_HOME). Must agree byte-for-byte with the same computation in
 * `hooks/inject-inbox.mjs` so both surfaces read/write the same
 * state file.
 */
export function daemonIdentityHash(input: DaemonIdentityInput): string {
  const ingredients = [
    input.api ?? '',
    input.sourcePath ?? '',
    process.env.DKG_HOME ?? '',
  ].join('\0');
  return crypto.createHash('sha1').update(ingredients).digest('hex').slice(0, 12);
}

export function inboxCursorPath(input: DaemonIdentityInput): string {
  return path.join(stateDir(), `inbox-cursor-${daemonIdentityHash(input)}.json`);
}

/**
 * Load the cursor for `input`. Returns `{ ts: 0, id: 0 }` when no
 * file exists (fresh install — every inbound message is unread).
 * Migrates legacy `{ lastSeen }` state silently.
 */
export function loadInboxCursor(input: DaemonIdentityInput): InboxCursor {
  try {
    const raw = fs.readFileSync(inboxCursorPath(input), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<InboxCursor> & {
      lastSeen?: number;
    };
    if (typeof parsed.ts === 'number') {
      return {
        ts: parsed.ts,
        id: typeof parsed.id === 'number' ? parsed.id : 0,
      };
    }
    if (typeof parsed.lastSeen === 'number') {
      return { ts: parsed.lastSeen, id: 0 };
    }
    return { ts: 0, id: 0 };
  } catch {
    return { ts: 0, id: 0 };
  }
}

/**
 * Persist `cursor` for `input`. Failure is non-fatal — callers should
 * still surface the messages they read; a write error just means
 * we'll show them again next time, which is the correct fail-open
 * behaviour for an inbox.
 */
export function saveInboxCursor(input: DaemonIdentityInput, cursor: InboxCursor): void {
  try {
    fs.mkdirSync(stateDir(), { recursive: true });
    fs.writeFileSync(inboxCursorPath(input), JSON.stringify(cursor, null, 2));
  } catch {
    /* see jsdoc — non-fatal */
  }
}

/**
 * Advance `prev` past `row` if `row` is newer. Used by the tool after
 * surfacing a row to push the cursor forward without going backwards
 * when an out-of-order row sneaks in (e.g. the operator passed an
 * explicit `since` for an ad-hoc lookup that returned older rows).
 */
export function advanceCursor(
  prev: InboxCursor,
  row: { ts: number; id: number },
): InboxCursor {
  if (row.ts > prev.ts) return { ts: row.ts, id: row.id };
  if (row.ts === prev.ts && row.id > prev.id) return { ts: row.ts, id: row.id };
  return prev;
}
