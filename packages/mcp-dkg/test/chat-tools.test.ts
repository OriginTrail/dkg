// chat-tools.test.ts
//
// Unit tests for the Phase 1 agent-to-agent debug-chat MCP tools
// (`dkg_send_message` + `dkg_check_inbox`). Verifies tool wiring,
// happy-path behaviour, ACL-error surfacing, inbox formatting,
// the compound-cursor read state (Codex PR #510 round 2), and the
// unread-vs-ad-hoc-mode split. Uses the in-memory FakeClient /
// FakeServer harness.

import { describe, it, expect, beforeEach } from 'vitest';
import { registerChatTools } from '../src/tools/chat.js';
import type { InboxCursor } from '../src/inbox-cursor.js';
import { FakeServer, FakeClient, makeConfig } from './harness.js';

/**
 * In-memory storage for the read cursor. Bypasses
 * `~/.cache/dkg-mcp/inbox-cursor-<hash>.json` so tests don't
 * cross-contaminate or depend on the operator's actual cache.
 */
function inMemoryCursorStorage() {
  let state: InboxCursor = { ts: 0, id: 0 };
  return {
    load: () => state,
    save: (c: InboxCursor) => {
      state = { ...c };
    },
    current: () => state,
  };
}

describe('chat tools — dkg_send_message + dkg_check_inbox', () => {
  let server: FakeServer;
  let client: FakeClient;
  let cursorStorage: ReturnType<typeof inMemoryCursorStorage>;

  beforeEach(() => {
    server = new FakeServer();
    client = new FakeClient();
    cursorStorage = inMemoryCursorStorage();
    registerChatTools(server.asMcpServer(), client.asDkgClient(), makeConfig(), {
      cursorStorage,
    });
  });

  it('registers both chat tools', () => {
    expect(server.tools.has('dkg_send_message')).toBe(true);
    expect(server.tools.has('dkg_check_inbox')).toBe(true);
  });

  // Codex PR #510 round 4 — the schema description used to say the
  // daemon defaults `contextGraphId` from `config.chat.acl.contextGraphId`.
  // After round 3 the daemon no longer auto-fills (ACL config is for
  // inbound, outbound CG claim is a separate concern). Pinning the
  // description here so it can't drift back without an explicit test
  // update.
  it("dkg_send_message schema describes contextGraphId as caller-supplied (NO auto-fill from ACL config)", () => {
    const tool = server.get('dkg_send_message');
    const cgField = (tool.config.inputSchema as Record<string, unknown>)
      .contextGraphId;
    // zod field's `.describe()` text is on the internal `_def.description`.
    const description = String(
      (cgField as { _def?: { description?: string } })._def?.description ?? '',
    );
    expect(description).toMatch(/[Mm]ust be supplied explicitly/);
    expect(description).toMatch(/does NOT auto-fill from the local node's ACL config/);
    expect(description).not.toMatch(/Defaults to .*chat\.acl\.contextGraphId/i);
  });

  describe('dkg_send_message', () => {
    it('forwards to / text / contextGraphId to the client', async () => {
      const result = await server.call('dkg_send_message', {
        to: 'alice-node',
        text: 'hey, can you see the test failure on your end?',
        contextGraphId: 'cg-dkg-debug',
      });
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toMatch(/Delivered to alice-node/);
      expect(client.sendChatCalls).toHaveLength(1);
      expect(client.sendChatCalls[0]).toEqual({
        to: 'alice-node',
        text: 'hey, can you see the test failure on your end?',
        contextGraphId: 'cg-dkg-debug',
      });
    });

    it('omits contextGraphId on the wire when not provided', async () => {
      await server.call('dkg_send_message', { to: 'bob', text: 'hello' });
      expect(client.sendChatCalls[0]).toEqual({ to: 'bob', text: 'hello' });
    });

    it('surfaces ACL-rejection with actionable guidance', async () => {
      client.chatDeliveryOverride = {
        delivered: false,
        error: 'unauthorized: sender is not an active member of cg-debug',
      };
      const result = await server.call('dkg_send_message', {
        to: 'alice',
        text: 'ping',
      });
      expect(result.isError).toBe(true);
      const body = result.content[0].text;
      expect(body).toMatch(/unauthorized/);
      expect(body).toMatch(/peerAllowlist|context graph|ACL/i);
    });

    it('surfaces transport/timeout errors verbatim when daemon did NOT queue', async () => {
      client.chatDeliveryOverride = {
        delivered: false,
        error: 'PEER_NOT_FOUND',
      };
      const result = await server.call('dkg_send_message', {
        to: 'unknown',
        text: 'hi',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/PEER_NOT_FOUND/);
    });

    // MessageOutbox PR — daemon now queues transport-failed sends and
    // returns `queued + attempts + nextAttemptAtMs` so the tool can
    // surface "queued for retry" instead of presenting it as a hard
    // failure. Original failure mode: operator typed message → cold
    // dial returned `'no valid addresses for peer'` → tool surfaced
    // hard error → operator re-typed and re-sent. New flow: daemon
    // enqueues, tool says "queued, retrying", operator does nothing.
    describe('queued state surfacing (MessageOutbox PR)', () => {
      it('returns a NON-error result when daemon enqueued for retry', async () => {
        client.chatDeliveryOverride = {
          delivered: false,
          queued: true,
          messageId: 'd17f8b6e-c0d4-4a8c-9c4f-1234567890ab',
          attempts: 1,
          nextAttemptAtMs: 1715670005000,
          error: 'The dial request has no valid addresses for peer',
        };
        const result = await server.call('dkg_send_message', {
          to: 'lex-node',
          text: 'are you there?',
        });
        expect(result.isError).toBeFalsy();
        const body = result.content[0].text;
        expect(body).toMatch(/QUEUED for retry/);
        expect(body).toMatch(/attempt #1/);
        expect(body).toMatch(/no valid addresses for peer/);
        expect(body).toMatch(/next attempt at/);
        expect(body).toMatch(/recipient peer reconnects/);
      });

      it('falls back to "next attempt at unknown" when nextAttemptAtMs missing', async () => {
        client.chatDeliveryOverride = {
          delivered: false,
          queued: true,
          attempts: 2,
          error: 'Remote closed connection during opening',
        };
        const result = await server.call('dkg_send_message', {
          to: 'lex-node',
          text: 'follow-up',
        });
        expect(result.isError).toBeFalsy();
        expect(result.content[0].text).toMatch(/QUEUED/);
        expect(result.content[0].text).toMatch(/attempt #2/);
        expect(result.content[0].text).toMatch(/next attempt at unknown/);
      });

      it('still surfaces ACL rejection as a hard error even with queued=undefined', async () => {
        // ACL rejections are intentional — the daemon must NOT queue
        // them (no retry will ever succeed). This test pins that
        // behavior so a future change to the daemon's queueing logic
        // can't accidentally start enqueuing ACL rejects and silently
        // hide them from the operator.
        client.chatDeliveryOverride = {
          delivered: false,
          error: 'unauthorized: sender is not an active member of cg-debug',
        };
        const result = await server.call('dkg_send_message', {
          to: 'alice',
          text: 'ping',
        });
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toMatch(/peerAllowlist|ACL/);
      });
    });
  });

  describe('dkg_check_inbox — unread (default) mode', () => {
    it('returns a friendly empty-state when no messages exist', async () => {
      const result = await server.call('dkg_check_inbox', {});
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toMatch(/No unread peer messages/);
    });

    it('formats inbound messages with friendly names + timestamps', async () => {
      client.agents = [{ peerId: '12D3KooWAliceXYZ', name: 'alice-node' }];
      client.pushChatMessage({ ts: 1715670000000, direction: 'in', peer: '12D3KooWAliceXYZ', text: 'msg-one' });
      client.pushChatMessage({ ts: 1715680000000, direction: 'in', peer: '12D3KooWBobABC', text: 'msg-two' });
      const result = await server.call('dkg_check_inbox', {});
      expect(result.isError).toBeFalsy();
      const body = result.content[0].text;
      expect(body).toMatch(/2 unread peer messages/);
      expect(body).toMatch(/alice-node \(…AliceXYZ\)/);
      expect(body).toMatch(/…oWBobABC/);
      expect(body).toContain('msg-one');
      expect(body).toContain('msg-two');
      expect(body).toMatch(/dkg_send_message/);
    });

    it('filters out outbound messages by default via server-side direction=in', async () => {
      client.pushChatMessage({ ts: 1, direction: 'out', peer: 'peer', text: 'sent', delivered: true });
      client.pushChatMessage({ ts: 2, direction: 'in', peer: 'peer', text: 'received' });
      const result = await server.call('dkg_check_inbox', {});
      expect(result.content[0].text).toMatch(/1 unread peer message/);
      expect(result.content[0].text).toContain('received');
      expect(result.content[0].text).not.toContain('sent');
      // direction=in pushed to daemon AND order=asc for forward pagination
      expect(client.getMessagesCalls).toHaveLength(1);
      expect(client.getMessagesCalls[0]).toMatchObject({
        direction: 'in',
        order: 'asc',
      });
    });

    // Codex PR #510 round 2 — unread mode must persist a watermark.
    it('advances the cursor past the newest surfaced message', async () => {
      client.pushChatMessage({ ts: 1000, direction: 'in', peer: 'p', text: 'a' });
      const newestId = client.pushChatMessage({ ts: 2000, direction: 'in', peer: 'p', text: 'b' });

      expect(cursorStorage.current()).toEqual({ ts: 0, id: 0 });
      await server.call('dkg_check_inbox', {});
      expect(cursorStorage.current()).toEqual({ ts: 2000, id: newestId });
    });

    it('returns no rows on a second call after the cursor has advanced', async () => {
      client.pushChatMessage({ ts: 1000, direction: 'in', peer: 'p', text: 'a' });
      client.pushChatMessage({ ts: 2000, direction: 'in', peer: 'p', text: 'b' });

      const first = await server.call('dkg_check_inbox', {});
      expect(first.content[0].text).toMatch(/2 unread peer messages/);

      const second = await server.call('dkg_check_inbox', {});
      expect(second.content[0].text).toMatch(/No unread peer messages/);
    });

    it('uses the compound cursor (ts + sinceId) on subsequent reads', async () => {
      // Same-millisecond burst — ts is shared, only the auto-incremented
      // id distinguishes the rows. After surfacing one, the cursor
      // must include sinceId so the OTHER same-ts row isn't skipped or
      // re-shown.
      const idA = client.pushChatMessage({ ts: 5000, direction: 'in', peer: 'p', text: 'a' });
      const idB = client.pushChatMessage({ ts: 5000, direction: 'in', peer: 'p', text: 'b' });

      // First call: should return BOTH a and b, advance cursor to
      // (5000, max(idA, idB)).
      const first = await server.call('dkg_check_inbox', {});
      expect(first.content[0].text).toContain('a');
      expect(first.content[0].text).toContain('b');
      expect(cursorStorage.current()).toEqual({ ts: 5000, id: Math.max(idA, idB) });

      // Push a third row at the same ts — must still appear next call.
      const idC = client.pushChatMessage({ ts: 5000, direction: 'in', peer: 'p', text: 'c' });
      const second = await server.call('dkg_check_inbox', {});
      expect(second.content[0].text).toContain('c');
      expect(second.content[0].text).not.toContain('msg "a"');
      expect(cursorStorage.current()).toEqual({ ts: 5000, id: idC });
      // The query MUST have used the compound (since, sinceId) cursor.
      const lastCall = client.getMessagesCalls[client.getMessagesCalls.length - 1];
      expect(lastCall).toMatchObject({
        since: 5000,
        sinceId: Math.max(idA, idB),
        direction: 'in',
        order: 'asc',
      });
    });
  });

  describe('dkg_check_inbox — ad-hoc mode (caller-supplied filters)', () => {
    it('peer= switches to ad-hoc mode: cursor not advanced and no `order` sent', async () => {
      client.pushChatMessage({ ts: 1, direction: 'in', peer: 'alice', text: 'from-alice' });
      client.pushChatMessage({ ts: 2, direction: 'in', peer: 'bob', text: 'from-bob' });

      const result = await server.call('dkg_check_inbox', { peer: 'alice' });
      const body = result.content[0].text;
      expect(body).toContain('from-alice');
      expect(body).not.toContain('from-bob');
      // Cursor must NOT advance — browsing history shouldn't shadow
      // genuinely-unread rows from a later default call.
      expect(cursorStorage.current()).toEqual({ ts: 0, id: 0 });
      // Ad-hoc mode uses the daemon's default order, not the unread
      // mode's forward pagination.
      expect(client.getMessagesCalls[0].order).toBeUndefined();
    });

    it('since= switches to ad-hoc mode', async () => {
      client.pushChatMessage({ ts: 1000, direction: 'in', peer: 'peer', text: 'old' });
      client.pushChatMessage({ ts: 5000, direction: 'in', peer: 'peer', text: 'new' });
      const result = await server.call('dkg_check_inbox', { since: 2000 });
      expect(result.content[0].text).toContain('new');
      expect(result.content[0].text).not.toContain('old');
      expect(cursorStorage.current()).toEqual({ ts: 0, id: 0 });
    });

    it('directionFilter=both → ad-hoc, no `direction` and no `order` on the daemon query', async () => {
      client.pushChatMessage({ ts: 1, direction: 'out', peer: 'peer', text: 'outbound-text', delivered: true });
      client.pushChatMessage({ ts: 2, direction: 'in', peer: 'peer', text: 'inbound-text' });
      const result = await server.call('dkg_check_inbox', { directionFilter: 'both' });
      const body = result.content[0].text;
      expect(body).toContain('outbound-text');
      expect(body).toContain('inbound-text');
      expect(body).toMatch(/direction=both/);
      expect(client.getMessagesCalls[0].direction).toBeUndefined();
      expect(client.getMessagesCalls[0].order).toBeUndefined();
      expect(cursorStorage.current()).toEqual({ ts: 0, id: 0 });
    });

    it('directionFilter=out → ad-hoc, pushes direction=out', async () => {
      client.pushChatMessage({ ts: 1, direction: 'out', peer: 'peer', text: 'sent', delivered: true });
      client.pushChatMessage({ ts: 2, direction: 'in', peer: 'peer', text: 'received' });
      const result = await server.call('dkg_check_inbox', { directionFilter: 'out' });
      expect(client.getMessagesCalls[0]).toMatchObject({ direction: 'out' });
      expect(client.getMessagesCalls[0].order).toBeUndefined();
      expect(result.content[0].text).toContain('sent');
      expect(result.content[0].text).not.toContain('received');
      expect(cursorStorage.current()).toEqual({ ts: 0, id: 0 });
    });

    it('flags undelivered outbound messages when directionFilter shows out', async () => {
      client.pushChatMessage({ ts: 1, direction: 'out', peer: 'peer', text: 'failed-message', delivered: false });
      const result = await server.call('dkg_check_inbox', { directionFilter: 'out' });
      expect(result.content[0].text).toMatch(/UNDELIVERED/);
    });

    it('caps results by limit in unread mode and STILL advances the cursor only over surfaced rows', async () => {
      for (let i = 0; i < 10; i++) {
        client.pushChatMessage({ ts: 1000 + i, direction: 'in', peer: 'peer', text: `m${i}` });
      }
      const result = await server.call('dkg_check_inbox', { limit: 3 });
      const body = result.content[0].text;
      expect(body).toMatch(/3 unread peer messages/);
      // Forward (asc) pagination returns the OLDEST 3 — m0, m1, m2 —
      // and the cursor advances to ts=1002 (m2). The next call should
      // pick up m3..m9.
      expect(body).toContain('m0');
      expect(body).toContain('m2');
      expect(body).not.toContain('m3');
      expect(cursorStorage.current().ts).toBe(1002);

      const next = await server.call('dkg_check_inbox', { limit: 3 });
      expect(next.content[0].text).toContain('m3');
      expect(next.content[0].text).not.toContain('m2');
    });
  });
});
