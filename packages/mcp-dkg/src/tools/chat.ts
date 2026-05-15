/**
 * Agent-to-agent debug-chat MCP tools (Phase 1 of the agent debug chat RFC).
 *
 * Two tools, both thin wrappers over existing daemon endpoints:
 *
 *   - `dkg_send_message` → `POST /api/chat`. Sends one encrypted libp2p
 *     chat to another agent on the network. Optionally includes a
 *     `contextGraphId` so a receiver running a scoped ACL can validate
 *     the sender is talking on behalf of a CG both sides recognise.
 *
 *   - `dkg_check_inbox` → `GET /api/messages`. Reads the local SQLite
 *     `chat_messages` history and formats unread peer messages as a
 *     compact markdown block the model can act on. Resolves friendly
 *     peer names via `GET /api/agents` so the operator sees
 *     "alice-node" rather than `12D3KooW…`.
 *
 * Phase 1 deliberately does NOT touch the shared context graph — the
 * point of this channel is to keep working even when the SWM/CG publish
 * stack is broken (which is when we most need it). Promotion to the CG
 * as institutional memory is a Phase 2 layer on top.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { DkgClient } from '../client.js';
import type { DkgConfig } from '../config.js';
import {
  advanceCursor,
  loadInboxCursor,
  saveInboxCursor,
  type DaemonIdentityInput,
  type InboxCursor,
} from '../inbox-cursor.js';

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

const ok = (text: string): ToolResult => ({ content: [{ type: 'text', text }] });
const errResult = (text: string): ToolResult => ({
  content: [{ type: 'text', text }],
  isError: true,
});

const formatError = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

/**
 * Best-effort name resolver. Maps `12D3KooW…` peerIds to human-friendly
 * node names by querying `GET /api/agents`. Failures are non-fatal —
 * the inbox falls back to short peerIds.
 */
async function buildPeerNameMap(client: DkgClient): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  try {
    const agents = await client.listAgents();
    for (const raw of agents) {
      if (raw && typeof raw === 'object') {
        const peerId = (raw as Record<string, unknown>).peerId;
        const name = (raw as Record<string, unknown>).name;
        if (typeof peerId === 'string' && typeof name === 'string') {
          out.set(peerId, name);
        }
      }
    }
  } catch {
    // Best-effort: a failing listAgents shouldn't kill the inbox tool.
  }
  return out;
}

function shortPeer(peerId: string): string {
  // Mirror the daemon's `shortId` (last 8 chars) for visual consistency.
  return peerId.length > 8 ? `…${peerId.slice(-8)}` : peerId;
}

function formatPeer(peerId: string, names: Map<string, string>): string {
  const name = names.get(peerId);
  return name ? `${name} (${shortPeer(peerId)})` : shortPeer(peerId);
}

function formatTs(ts: number): string {
  try {
    return new Date(ts).toISOString().replace('T', ' ').slice(0, 19);
  } catch {
    return String(ts);
  }
}

export interface RegisterChatToolsOptions {
  /**
   * Override the on-disk cursor with an in-memory one. Used by tests to
   * avoid touching `~/.cache/dkg-mcp/` (and to assert on advancement).
   * In production callers omit this and the tool reads/writes the
   * shared `~/.cache/dkg-mcp/inbox-cursor-<hash>.json` file (same path
   * as `hooks/inject-inbox.mjs`).
   */
  cursorStorage?: {
    load(): InboxCursor;
    save(cursor: InboxCursor): void;
  };
}

export function registerChatTools(
  server: McpServer,
  client: DkgClient,
  config: DkgConfig,
  options: RegisterChatToolsOptions = {},
): void {
  // Daemon identity for the read-cursor — shared with the inject-inbox
  // hook so the hook's notice and the tool's listing stay consistent.
  const cursorId: DaemonIdentityInput = {
    api: config.api,
    sourcePath: config.sourcePath ?? null,
  };
  const cursorStorage = options.cursorStorage ?? {
    load: () => loadInboxCursor(cursorId),
    save: (c: InboxCursor) => saveInboxCursor(cursorId, c),
  };
  // ── dkg_send_message ─────────────────────────────────────────────
  server.registerTool(
    'dkg_send_message',
    {
      title: 'Send Agent-to-Agent Message',
      description:
        'Send an encrypted libp2p chat to another agent on the DKG ' +
        'network. Use when the operator says "ask <name>", "tell ' +
        '<name>", or otherwise asks to communicate with an agent on a ' +
        'different node. `to` accepts either a friendly node name ' +
        '(registered in the agent registry) or a raw peerId. The ' +
        "message is signed with this node's Ed25519 key and encrypted " +
        "with XChaCha20-Poly1305 against the recipient's libp2p key — " +
        'the daemon handles all of that. If the receiver has a scoped ' +
        'chat ACL the call fails fast with ' +
        '`unauthorized: …` — surface that to the operator so they can ' +
        'ask the recipient to whitelist this node.',
      inputSchema: {
        to: z
          .string()
          .min(1)
          .describe(
            'Recipient agent. Friendly node name (preferred — e.g. ' +
              '"alice-node") or a raw libp2p peerId.',
          ),
        text: z.string().min(1).describe('The message body. Plain text.'),
        contextGraphId: z
          .string()
          .optional()
          .describe(
            'Optional context graph the sender is talking on behalf ' +
              'of. Embedded in the encrypted payload so a scoped ' +
              'receiver can validate the claim against its ACL. ' +
              'Must be supplied explicitly — the daemon does NOT ' +
              "auto-fill from the local node's ACL config, since " +
              'inbound ACL policy and outbound wire claim are ' +
              "distinct concerns (the local node's chosen scope " +
              'should not silently appear on every outgoing chat).',
          ),
      },
    },
    async ({ to, text, contextGraphId }): Promise<ToolResult> => {
      try {
        const result = await client.sendChat({
          to,
          text,
          ...(contextGraphId ? { contextGraphId } : {}),
        });
        if (result.delivered) {
          return ok(`Delivered to ${to}.`);
        }
        const reason = result.error ?? 'unknown error';
        // ACL rejections are NOT queued (the daemon returns delivered=false
        // without enqueuing because no retry will ever succeed against an
        // intentional rejection). Surface the actionable guidance so the
        // operator can fix the ACL on the recipient side.
        if (reason.includes('unauthorized')) {
          return errResult(
            `Message to ${to} was NOT delivered: ${reason}.\n\n` +
              'The receiver rejected this message via its chat ACL. ' +
              'Ask the operator on the other node to either:\n' +
              '  - add this node to their `chat.acl.peerAllowlist`, or\n' +
              '  - add this node as a member of the shared context graph they have scoped to, or\n' +
              '  - relax their ACL mode if they were testing.',
          );
        }
        // Transport failure → daemon enqueued for retry. Surface the
        // queued state to the model so it can tell the operator
        // "queued, will retry" instead of presenting it as a hard
        // failure that needs immediate re-send. The retry runs
        // asynchronously in the daemon (periodic tick + opportunistic
        // flush on the recipient's next reconnect); the operator
        // doesn't need to do anything unless the recipient is offline
        // for >24h (default outbox max age). MessageOutbox PR.
        if (result.queued) {
          const nextAttempt = result.nextAttemptAtMs
            ? formatTs(result.nextAttemptAtMs)
            : 'unknown';
          const attempts = result.attempts ?? 1;
          return ok(
            `Message to ${to} is QUEUED for retry (attempt #${attempts} just failed: ${reason}).\n\n` +
              `The daemon will retry automatically — next attempt at ${nextAttempt}, ` +
              `or sooner if the recipient peer reconnects in the meantime. ` +
              `No action needed unless ${to} is offline for >24h. ` +
              `Operator can check pending state with \`dkg_status\` (or just wait — ` +
              `delivery happens in the background and the recipient will see the message ` +
              `as soon as the transport recovers).`,
          );
        }
        // delivered=false AND not queued — fall through to legacy error
        // shape so old behavior is preserved if a future daemon version
        // returns this shape (shouldn't happen in v10.0.0+).
        return errResult(
          `Message to ${to} was NOT delivered: ${reason}.\n\n` +
            'Retry after a few seconds; if it persists, ask the operator to verify the peer is online (`dkg_status`).',
        );
      } catch (e) {
        return errResult(`Failed to send message to ${to}: ${formatError(e)}`);
      }
    },
  );

  // ── dkg_check_inbox ──────────────────────────────────────────────
  server.registerTool(
    'dkg_check_inbox',
    {
      title: 'Check Agent Inbox',
      description:
        'Read UNREAD inbound chat messages from other agents. With no ' +
        'arguments, returns every peer message that has not yet been ' +
        'surfaced by a previous `dkg_check_inbox` call, and advances ' +
        'the persistent read-cursor past them. Call this at the start ' +
        "of every session and any time the operator asks 'any " +
        "messages?' / 'inbox?'. Surface any non-empty digest to the " +
        'operator BEFORE doing anything else — those peers are waiting ' +
        'for a reply. Supplying any of `peer`, `since`, or a non-default ' +
        '`directionFilter` switches to AD-HOC mode: the supplied filters ' +
        'are honoured and the cursor is NOT advanced (use this for ' +
        'browsing history without losing track of genuinely-unread rows).',
      inputSchema: {
        peer: z
          .string()
          .optional()
          .describe(
            'Filter to messages from a single peer (name or peerId). ' +
              'Switches the tool to ad-hoc mode (cursor not advanced).',
          ),
        since: z
          .number()
          .int()
          .optional()
          .describe(
            'Unix epoch milliseconds. Only return messages with ts > ' +
              'since. Switches the tool to ad-hoc mode (cursor not ' +
              'advanced). Omit for the normal "unread since last call" ' +
              'view.',
          ),
        limit: z
          .number()
          .int()
          .positive()
          .max(200)
          .optional()
          .describe('Cap on rows returned (default 100, max 200).'),
        directionFilter: z
          .enum(['in', 'out', 'both'])
          .optional()
          .describe(
            'Default "in" — only show inbound peer messages (the typical ' +
              'inbox view). Set "both" to also see outbound replies (useful ' +
              'when reconstructing a thread). Set "out" for outbound-only. ' +
              'Any non-default value switches to ad-hoc mode.',
          ),
      },
    },
    async ({ peer, since, limit, directionFilter }): Promise<ToolResult> => {
      try {
        const dir = directionFilter ?? 'in';
        // "Unread mode" = the default `dkg_check_inbox()` call with
        // no filters. We use the persisted read-cursor as the floor
        // and advance it past every row we surface so subsequent
        // calls don't replay the same messages (Codex PR #510 round
        // 2 flagged the missing watermark — agents previously saw
        // the same N rows on every call).
        //
        // Any caller-supplied filter (`peer`, explicit `since`, or
        // `directionFilter` other than the default `in`) opts into
        // ad-hoc lookup mode: we honour the supplied filters and
        // DON'T touch the cursor. This keeps the cursor a clean
        // "what the agent has been shown in unread reads" record.
        const isAdHoc =
          peer != null ||
          typeof since === 'number' ||
          (directionFilter != null && directionFilter !== 'in');

        // Push the direction filter to the daemon so the LIMIT cap
        // doesn't push older inbound rows off the bottom of the page
        // when the newest entries are outbound replies. `both` is the
        // only mode where the daemon should return mixed rows.
        const serverDirection: 'in' | 'out' | undefined =
          dir === 'both' ? undefined : dir;

        const cursor = isAdHoc ? null : cursorStorage.load();
        const effectiveSince = isAdHoc ? since : cursor!.ts || undefined;
        const effectiveSinceId =
          isAdHoc || !cursor || !cursor.ts ? undefined : cursor.id;
        // Forward pagination order for unread reads — the daemon
        // returns the OLDEST unread rows first so the cursor only
        // ever advances past rows we have actually surfaced.
        const order: 'asc' | 'desc' | undefined = isAdHoc ? undefined : 'asc';

        const [{ messages }, names] = await Promise.all([
          client.getMessages({
            peer,
            since: effectiveSince,
            ...(typeof effectiveSinceId === 'number' ? { sinceId: effectiveSinceId } : {}),
            limit,
            ...(serverDirection ? { direction: serverDirection } : {}),
            ...(order ? { order } : {}),
          }),
          buildPeerNameMap(client),
        ]);
        // Defence in depth: the daemon should already have filtered,
        // but if a future caller wires an older daemon we still won't
        // surface the wrong direction.
        const filtered = messages.filter((m) => {
          if (dir === 'both') return true;
          return m.direction === dir;
        });
        if (filtered.length === 0) {
          const scope = peer ? ` from ${peer}` : '';
          const sinceLabel = since ? ` since ${formatTs(since)}` : '';
          return ok(
            dir === 'in'
              ? `No unread peer messages${scope}${sinceLabel}.`
              : `No messages${scope}${sinceLabel} (direction=${dir}).`,
          );
        }

        // Advance the cursor past the newest row we are about to
        // surface. Only in unread mode — ad-hoc reads must not
        // affect the watermark or the operator would lose track of
        // genuinely-unread messages by browsing history.
        if (!isAdHoc && cursor) {
          let advanced = cursor;
          for (const m of filtered) {
            if (m.direction !== 'in') continue;
            advanced = advanceCursor(advanced, { ts: m.ts, id: m.id });
          }
          if (advanced !== cursor) {
            cursorStorage.save(advanced);
          }
        }

        const lines = filtered.map((m) => {
          const arrow = m.direction === 'in' ? '←' : '→';
          const who = formatPeer(m.peer, names);
          const undeliveredTag =
            m.direction === 'out' && m.delivered === false ? ' [UNDELIVERED]' : '';
          return `- ${arrow} ${who} · ${formatTs(m.ts)}${undeliveredTag}\n    ${m.text.replace(/\n/g, '\n    ')}`;
        });
        const header =
          dir === 'in'
            ? `${filtered.length} unread peer message${filtered.length === 1 ? '' : 's'}:`
            : `${filtered.length} message${filtered.length === 1 ? '' : 's'} (direction=${dir}):`;
        const hint =
          dir === 'in'
            ? '\n\nReply via `dkg_send_message({ to, text })`.'
            : '';
        return ok(`${header}\n\n${lines.join('\n')}${hint}`);
      } catch (e) {
        return errResult(`Failed to read inbox: ${formatError(e)}`);
      }
    },
  );
}
