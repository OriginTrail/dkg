// chat-tools.test.ts
//
// Agent-to-agent debug-chat MCP tools (`dkg_send_message` + `dkg_check_inbox`).
//
// NO MOCKS. The retired version drove an in-memory FakeClient that
// REIMPLEMENTED the daemon's `getMessages` cursor filtering and let tests
// inject canned `chatDeliveryOverride` results — i.e. it tested the mock's
// reimplementation, not the real daemon. Replaced with:
//   • PURE tests (registration, schema description) — real client, parse.
//   • Real single-node send-error branches: an unknown recipient (real
//     404) and an unconnected peer (real transport timeout → daemon
//     enqueues → the QUEUED-for-retry branch).
//   • A real two-node encrypted round-trip that exercises inbox
//     formatting AND the persistent read-cursor semantics (advance past
//     surfaced rows, don't re-show, ad-hoc mode doesn't advance) on real
//     messages. The compound same-millisecond cursor tie-break (which real
//     timestamps can't force deterministically) is covered by the pure
//     math in `inbox-cursor.test.ts`.
//
// The ACL-rejection branch needs a node configured with a restrictive
// chat ACL; an open devnet can't produce `unauthorized` on demand, so that
// branch is exercised by the daemon's own ACL tests, not fabricated here.

import { describe, it, expect, beforeEach } from 'vitest';
import { registerChatTools } from '../src/tools/chat.js';
import type { InboxCursor } from '../src/inbox-cursor.js';
import { FakeServer } from './harness.js';
import { LIVE, API, API2, TOKEN, TOKEN2, CG, liveClient, liveConfig, sleep } from './live.js';

function inMemoryCursorStorage(initial: InboxCursor = { ts: 0, id: 0 }) {
  let state: InboxCursor = { ...initial };
  return {
    load: () => state,
    save: (c: InboxCursor) => {
      state = { ...c };
    },
    current: () => state,
  };
}

describe('chat tools — pure surface (no node)', () => {
  let server: FakeServer;

  beforeEach(() => {
    server = new FakeServer();
    registerChatTools(server.asMcpServer(), liveClient(), liveConfig(), {
      cursorStorage: inMemoryCursorStorage(),
    });
  });

  it('registers both chat tools', () => {
    expect(server.tools.has('dkg_send_message')).toBe(true);
    expect(server.tools.has('dkg_check_inbox')).toBe(true);
  });

  it('dkg_send_message schema describes contextGraphId as caller-supplied (NO auto-fill from ACL config)', () => {
    const tool = server.get('dkg_send_message');
    const cgField = (tool.config.inputSchema as Record<string, unknown>).contextGraphId;
    const description = String((cgField as { _def?: { description?: string } })._def?.description ?? '');
    expect(description).toMatch(/[Mm]ust be supplied explicitly/);
    expect(description).toMatch(/does NOT auto-fill from the local node's ACL config/);
    expect(description).not.toMatch(/Defaults to .*chat\.acl\.contextGraphId/i);
  });
});

describe.skipIf(!LIVE)('chat tools — real single-node send errors + inbox', () => {
  let server: FakeServer;

  beforeEach(() => {
    server = new FakeServer();
    registerChatTools(server.asMcpServer(), liveClient(), liveConfig(), {
      cursorStorage: inMemoryCursorStorage(),
    });
  });

  it('surfaces an unknown recipient as a hard error (real 404)', async () => {
    const result = await server.call('dkg_send_message', {
      to: 'definitely-not-a-real-node-xyz',
      text: 'hello?',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Failed to send message/);
    expect(result.content[0].text).toMatch(/not found/i);
  });

  it(
    'returns a NON-error QUEUED result when the daemon enqueues a transport-failed send',
    async () => {
      // A syntactically valid but unconnected peer: the daemon can't dial
      // it, so it enqueues for retry and returns queued=true. (~20s for
      // the real dial timeout.)
      const result = await server.call('dkg_send_message', {
        to: '12D3KooWFq5KMnSMyYr8Z8t8a6Vh1Y6N6KkF5UZjLpCqUkBJsAaa',
        text: 'are you there?',
      });
      expect(result.isError).toBeFalsy();
      const body = result.content[0].text;
      expect(body).toMatch(/QUEUED for retry/);
      expect(body).toMatch(/attempt #\d/);
      expect(body).toMatch(/recipient peer reconnects/);
    },
    60_000,
  );

  it('reports a friendly empty-state for an ad-hoc peer filter with no messages', async () => {
    const result = await server.call('dkg_check_inbox', { peer: 'nonexistent-peer-zzz' });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toMatch(/No unread peer messages from nonexistent-peer-zzz/);
  });
});

describe.skipIf(!LIVE || !API2)('chat tools — real two-node round-trip + cursor semantics', () => {
  let recvServer: FakeServer;
  let cursor: ReturnType<typeof inMemoryCursorStorage>;
  let node1PeerId = '';
  let node2Name = '';

  async function buildContext() {
    // node1 (receiver) peerId — node2 sends TO this.
    const node1 = liveClient();
    node1PeerId = (await node1.getAgentIdentity()).peerId ?? '';
    // node2's registry name as seen from node1 (for friendly-name render).
    const res = await fetch(`${API}/api/agents`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    const body = (await res.json()) as { agents?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>;
    const agents = Array.isArray(body) ? body : body.agents ?? [];
    const node2 = liveClient({ api: API2, token: TOKEN2 });
    const node2PeerId = (await node2.getAgentIdentity()).peerId ?? '';
    const hit = agents.find((a) => a.peerId === node2PeerId);
    node2Name = (hit?.name as string) ?? '';
  }

  function senderServer(): FakeServer {
    const s = new FakeServer();
    registerChatTools(s.asMcpServer(), liveClient({ api: API2, token: TOKEN2 }), liveConfig({ api: API2, token: TOKEN2 }), {
      cursorStorage: inMemoryCursorStorage(),
    });
    return s;
  }

  beforeEach(async () => {
    await buildContext();
    // Receiver inbox with a cursor floored at "now" so only THIS test's
    // freshly-sent messages count as unread.
    cursor = inMemoryCursorStorage({ ts: Date.now() - 1, id: 0 });
    recvServer = new FakeServer();
    registerChatTools(recvServer.asMcpServer(), liveClient(), liveConfig(), { cursorStorage: cursor });
  });

  async function pollInboxForMarker(marker: string): Promise<string> {
    for (let i = 0; i < 40; i++) {
      const r = await recvServer.call('dkg_check_inbox', { directionFilter: 'both', limit: 50 });
      const t = r.content?.[0]?.text ?? '';
      if (t.includes(marker)) return t;
      await sleep(1000);
    }
    return '';
  }

  it('round-trips an encrypted message and advances the cursor past surfaced rows', async () => {
    expect(node1PeerId, 'could not resolve node1 peerId').toBeTruthy();
    const sender = senderServer();
    const marker = `chattest-${Date.now().toString(36)}`;

    const sent = await sender.call('dkg_send_message', { to: node1PeerId, text: marker });
    expect(sent.isError, `send errored: ${sent.content?.[0]?.text}`).not.toBe(true);

    // Wait for the encrypted message to land (polls with directionFilter
    // 'both' which is AD-HOC → does NOT advance the cursor).
    const seen = await pollInboxForMarker(marker);
    expect(seen, `marker ${marker} never arrived at node1 inbox`).toBeTruthy();
    if (node2Name) expect(seen).toContain(node2Name);
    expect(seen).toContain('←'); // inbound arrow

    // Cursor still at the floor (ad-hoc poll didn't move it).
    expect(cursor.current().ts).toBeLessThan(Date.now());

    // Now an UNREAD read (default mode) surfaces it AND advances the cursor.
    const unread = await recvServer.call('dkg_check_inbox', {});
    expect(unread.content[0].text).toContain(marker);
    expect(cursor.current().ts).toBeGreaterThan(0);

    // A second unread read must NOT re-show the same message.
    const second = await recvServer.call('dkg_check_inbox', {});
    expect(second.content[0].text).not.toContain(marker);
    expect(second.content[0].text).toMatch(/No unread peer messages/);
  });

  it('directionFilter=out surfaces the sender\'s outbound message (real)', async () => {
    const sender = senderServer();
    const marker = `chatout-${Date.now().toString(36)}`;
    const sent = await sender.call('dkg_send_message', { to: node1PeerId, text: marker });
    expect(sent.isError).not.toBe(true);

    // Give the daemon a moment to persist the outbound row, then read it
    // from the SENDER's history (direction=out is ad-hoc).
    let outText = '';
    for (let i = 0; i < 20; i++) {
      const out = await sender.call('dkg_check_inbox', { directionFilter: 'out', limit: 50 });
      outText = out.content?.[0]?.text ?? '';
      if (outText.includes(marker)) break;
      await sleep(500);
    }
    expect(outText).toContain(marker);
    expect(outText).toMatch(/direction=out/);
  });
});
