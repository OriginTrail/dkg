import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ChatTurnWriter } from "../src/ChatTurnWriter";
import type { AgentEndContext, InternalMessageEvent } from "../src/ChatTurnWriter";

/** Wait long enough for fire-and-forget persistOne() to complete. */
const flushMicrotasks = () => new Promise((r) => setTimeout(r, 20));

const conversationInfoMetadataBlock = [
  "Conversation info (untrusted metadata):",
  "```json",
  "{",
  " \"chat_id\": \"telegram:test-chat-001\",",
  " \"message_id\": \"test-message-1021\",",
  " \"sender_id\": \"test-sender-001\",",
  " \"sender\": \"Test Sender\",",
  " \"timestamp\": \"Mon 2026-05-04 13:08 GMT+2\"",
  "}",
  "```",
].join("\n");

const senderMetadataBlock = [
  "Sender (untrusted metadata):",
  "```json",
  "{",
  " \"label\": \"Test Sender (test-sender-001)\",",
  " \"id\": \"test-sender-001\",",
  " \"name\": \"Test Sender\",",
  " \"username\": \"test_sender_001\"",
  "}",
  "```",
].join("\n");

const pastedSenderMetadataBlock = [
  "Sender (untrusted metadata):",
  "```json",
  "{",
  " \"label\": \"Pasted Sender (user-pasted-sender-999)\",",
  " \"id\": \"user-pasted-sender-999\",",
  " \"name\": \"Pasted Sender\",",
  " \"username\": \"pasted_sender_999\"",
  "}",
  "```",
].join("\n");

const channelContextMetadataBlock = [
  "Channel context (untrusted metadata):",
  "```json",
  "{",
  " \"example\": \"user-pasted channel context\"",
  "}",
  "```",
].join("\n");

function telegramWrappedUserText(userText: string, opts: { sender?: boolean } = {}): string {
  const blocks = [conversationInfoMetadataBlock];
  if (opts.sender !== false) blocks.push(senderMetadataBlock);
  return [...blocks, userText].join("\n\n");
}

describe("ChatTurnWriter", () => {

    let writer: ChatTurnWriter;

    let mockClient: {
      storeChatTurn: ReturnType<typeof vi.fn>;
      getChatTurnStoreStatus?: ReturnType<typeof vi.fn>;
    };

    let mockLogger: {
      debug: ReturnType<typeof vi.fn>;
      info: ReturnType<typeof vi.fn>;
      warn: ReturnType<typeof vi.fn>;
      error: ReturnType<typeof vi.fn>;
    };

    let stateDir: string;


    beforeEach(() => {
      stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "chatturnwriter-test-"));
      mockLogger = {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      };
      mockClient = {
        storeChatTurn: vi.fn().mockResolvedValue(undefined),
      };
      writer = new ChatTurnWriter({ client: mockClient, logger: mockLogger, stateDir });
    });


    afterEach(() => {
      writer.flushSync();
      try {
        fs.rmSync(stateDir, { recursive: true, force: true });
      } catch {
        // best effort
      }
      vi.clearAllMocks();
    });


    it("T15 — persist-failure restore preserves the ORIGINAL queue items (not the joined string)", async () => {
      // Regression for T15: when persist fails, the catch block must
      // restore each ORIGINAL queue item to the front, not the joined
      // string. This way a later inbound that arrives between the
      // failure and the retry queues normally and the next outbound
      // re-collapses the full queue (old + new).
      let firstAttempt = true;
      mockClient.storeChatTurn = vi.fn().mockImplementation(async () => {
        if (firstAttempt) {
          firstAttempt = false;
          throw new Error("transient daemon failure");
        }
        // also fail the persistOne single retry so the catch block runs
        throw new Error("hard daemon failure");
      });
      writer = new ChatTurnWriter({ client: mockClient, logger: mockLogger, stateDir });
      writer.onMessageReceived({
        sessionKey: "sk",
        context: { channelId: "tg", content: "u1", messageId: "in-1" },
      } as any);
      writer.onMessageReceived({
        sessionKey: "sk",
        context: { channelId: "tg", content: "u2", messageId: "in-2" },
      } as any);
      await writer.onMessageSent({
        sessionKey: "sk",
        context: { channelId: "tg", content: "reply", success: true, messageId: "out-1" },
      } as any);
      // Wait for persistOne 250ms backoff retry to complete.
      await new Promise((r) => setTimeout(r, 600));

      // The original two queue items must be restored at the front, NOT
      // a single `"u1\nu2"` string.
      const pending = (writer as any).pendingUserMessages;
      const conversationKey = Array.from(pending.keys())[0] as string;
      const restoredQueue = pending.get(conversationKey) as string[];
      expect(restoredQueue).toEqual(["u1", "u2"]);
    });


    it("R20.2 — w4bSessionCounts only increments for persists that consumed a pending user (chunked-reply safety)", async () => {
      // Regression for R20.2: pre-fix, every successful W4b persist
      // bumped `w4bSessionCounts` by 1, including chunk-2+ deliveries
      // that ran out of pending users on chunk 1 and persisted as
      // assistant-only turns. The count then advanced past
      // `event.messages` and the next `agent_end` skipped real pairs as
      // already-W4b-persisted. The fix guards the increment on
      // `userText` non-empty (i.e., this persist represents a complete
      // logical turn pair).
      writer.onMessageReceived({
        sessionKey: "sk",
        context: { channelId: "tg", content: "q1", messageId: "in-1" },
      } as any);
      // Chunk 1: pairs with user, increments count.
      await writer.onMessageSent({
        sessionKey: "sk",
        context: { channelId: "tg", content: "chunk1", success: true, messageId: "out-1a" },
      } as any);
      await flushMicrotasks();
      // Chunks 2+: queue is empty, persist as assistant-only — must NOT
      // bump the count.
      await writer.onMessageSent({
        sessionKey: "sk",
        context: { channelId: "tg", content: "chunk2", success: true, messageId: "out-1b" },
      } as any);
      await writer.onMessageSent({
        sessionKey: "sk",
        context: { channelId: "tg", content: "chunk3", success: true, messageId: "out-1c" },
      } as any);
      await flushMicrotasks();
      const counts = (writer as any).w4bSessionCounts as Map<string, number>;
      // Exactly ONE turn pair was consumed — count must reflect that,
      // not the 3 raw `message:sent` fires.
      const sessionId = "openclaw:tg:::sk";
      expect(counts.get(sessionId)).toBe(1);
    });


    it("R22.1 — computeDelta drops assistant-only artifacts (initial greeting, compaction) and does NOT advance pairIndex", async () => {
      // Regression for R22.1: pre-fix, an assistant message with no
      // preceding user (initial agent greeting, post-compaction artifact,
      // system-injected announcement) emitted a pair as ("", asst) and
      // bumped `pairIndex`. That polluted memory AND inflated the
      // watermark — so the next REAL (user, assistant) pair would be
      // skipped on the next agent_end as already-saved.
      //
      // Setup: messages = [asst(greeting), user, asst(reply)]. Pre-fix
      // would emit two pairs (greeting at index 0, reply at index 1) and
      // skip the next agent_end's reply if backfill watermark = 1.
      // Post-fix emits exactly one pair: (user, reply) at pairIndex 0.
      const event: AgentEndContext = {
        sessionId: "test",
        messages: [
          { role: "assistant", content: "Hi! I'm your assistant." }, // initial greeting, no pending user
          { role: "user", content: "Real question" },
          { role: "assistant", content: "Real reply" },
        ],
      };
      writer.onAgentEnd(event, { channelId: "tg", sessionKey: "sk" });
      await flushMicrotasks();
      expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(1);
      const call = mockClient.storeChatTurn.mock.calls[0];
      expect(call[1]).toBe("Real question");
      expect(call[2]).toBe("Real reply");
    });


    it("R22.1 — pairIndex is NOT advanced for orphan assistant messages so the watermark stays correct", async () => {
      // Stronger guard: drive the same shape twice and confirm the second
      // agent_end (with the same messages array) does not write a new
      // pair, because the watermark advanced exactly to the one real
      // pair persisted on the first call.
      const dkw = writer as any;
      const ev: AgentEndContext = {
        sessionId: "test",
        messages: [
          { role: "assistant", content: "system greeting" },
          { role: "user", content: "q1" },
          { role: "assistant", content: "a1" },
        ],
      };
      writer.onAgentEnd(ev, { channelId: "tg", sessionKey: "sk" });
      await flushMicrotasks();
      expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(1);
      // Flush so loadWatermark reflects the persisted index.
      writer.flushSync();
      // The real pair lands at pairIndex 0 (orphan asst was skipped, NOT
      // counted), so the watermark should be 0 — not 1.
      expect(dkw.loadWatermark("openclaw:tg:::sk")).toBe(0);

      writer.onAgentEnd(ev, { channelId: "tg", sessionKey: "sk" });
      await flushMicrotasks();
      // Second call must not re-persist anything.
      expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(1);
    });


    it("R19.1 — computeDelta concatenates consecutive user messages before pairing with assistant reply", async () => {
      // Regression for R19.1: pre-fix, the parser used a single
      // `currentUser` slot that overwrote on each user message. So
      // `[user1, user2, asst]` paired only `user2` with `asst` and
      // dropped `user1`. The fix accumulates consecutive users and
      // joins them with `\n` before pairing.
      const event: AgentEndContext = {
        sessionId: "test",
        messages: [
          { role: "user", content: "first user message" },
          { role: "user", content: "second user message" },
          { role: "assistant", content: "single reply" },
        ],
      };
      writer.onAgentEnd(event, { channelId: "tg", sessionKey: "sk" });
      await flushMicrotasks();
      expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(1);
      const call = mockClient.storeChatTurn.mock.calls[0];
      // User side preserves both messages joined with newline.
      expect(call[1]).toContain("first user message");
      expect(call[1]).toContain("second user message");
      expect(call[2]).toBe("single reply");
    });


    it("R19.1 — computeDelta treats assistant with text+toolCalls as intermediate, pairs final reply with original user", async () => {
      // Regression for R19.1: pre-fix, an assistant message carrying
      // BOTH text content AND tool_calls was treated as a final reply
      // (the `!text && hasToolCalls` skip required empty text). That
      // produced two pairs from `[user, asst(tool+text), tool, asst(final)]`,
      // with the second pair missing the user side. The fix treats any
      // assistant with tool_calls as intermediate, so the final reply
      // pairs with the original user message.
      const event: AgentEndContext = {
        sessionId: "test",
        messages: [
          { role: "user", content: "what's the weather?" },
          {
            role: "assistant",
            content: "Let me check that for you.",
            tool_calls: [{ id: "c1", type: "function", function: { name: "weather" } }],
          } as any,
          { role: "tool" as any, content: "rainy" },
          { role: "assistant", content: "It's rainy today." },
        ],
      };
      writer.onAgentEnd(event, { channelId: "tg", sessionKey: "sk" });
      await flushMicrotasks();
      // Exactly one pair persisted (not two).
      expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(1);
      const call = mockClient.storeChatTurn.mock.calls[0];
      expect(call[1]).toBe("what's the weather?");
      expect(call[2]).toBe("It's rainy today.");
    });


    it("T359 - cold-start W4a persists only the final user-visible reply from tool scaffolding", async () => {
      const event: AgentEndContext = {
        sessionId: "test",
        messages: [
          { role: "assistant", content: "startup greeting" },
          { role: "user", content: "What do we know about OriginTrail?" },
          { role: "assistant", content: "I'll inspect memory first." },
          { role: "user", content: "memory_search raw_hits=0", tool_call_id: "call-memory-1" } as any,
          { role: "assistant", content: "No memory hits; I'll query the graph." },
          { role: "function" as any, name: "dkg_query", content: "query result rows" },
          { role: "assistant", content: "OriginTrail is a decentralized knowledge graph project." },
        ],
      };
      writer.onAgentEnd(event, { channelId: "telegram", sessionKey: "sk" });
      await flushMicrotasks();

      expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(1);
      const call = mockClient.storeChatTurn.mock.calls[0];
      expect(call[1]).toBe("What do we know about OriginTrail?");
      expect(call[2]).toBe("OriginTrail is a decentralized knowledge graph project.");
    });


    it("T362 — delayed W4a flushing on cold start clamps to the latest pair (revised T359)", async () => {
      // Pre-T362, this test exercised the same cold-start replay assumption
      // as the R2.4 backfill test — feed 2 pairs to a fresh writer and
      // expect both to persist. With the cold-start clamp in place
      // (savedUpTo === -1 → discard historical pairs, emit only the
      // latest), only the most-recent pair lands. Steady-state in-session
      // backfill is exercised separately by the T362 in-session test.
      const event: AgentEndContext = {
        sessionId: "test",
        messages: [
          { role: "user", content: "q1" },
          { role: "assistant", content: "a1" },
          { role: "user", content: "q2" },
          { role: "assistant", content: "a2" },
        ],
      };
      writer.onAgentEnd(event, { channelId: "telegram", sessionKey: "sk" });
      await flushMicrotasks();

      expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(1);
      const call = mockClient.storeChatTurn.mock.calls[0];
      expect(call[1]).toBe("q2");
      expect(call[2]).toBe("a2");
    });


    it("T5 — cross-path stamps live on a SHORTER TTL than the in-flight turnIds (<=10s)", () => {
      // Regression for T5: pre-fix, content-only `w4aOriginKey` /
      // `w4bOriginKey` lived on the 60s `TURNID_TTL_MS` map. Two
      // legitimate repeated turns with the same text within 60s would
      // collide on the first turn's stamp — if the second turn's
      // remaining path then failed, the turn was dropped. The fix
      // moves cross-path stamps to a separate map with a short
      // (~5s) TTL. The pair-indexed turnId on `recentTurnIds` keeps
      // the longer 60s window because it's per-pair-unique.
      const crossTtl = (writer.constructor as any).CROSS_PATH_TTL_MS;
      const longTtl = (writer.constructor as any).TURNID_TTL_MS;
      expect(crossTtl).toBeLessThanOrEqual(10_000);
      expect(longTtl).toBeGreaterThanOrEqual(crossTtl);
      expect(longTtl - crossTtl).toBeGreaterThan(0); // strict separation
    });


    it("T5 — cross-path stamp from W4a does NOT block a repeated same-content turn after the cross-path TTL elapses", async () => {
      // Regression for T5: simulates the data-loss scenario by stamping
      // w4aOrigin (T5 short-TTL map) for "ping/pong", then expiring it,
      // then firing a fresh agent_end with the same content. With the
      // separate short-TTL map, the expired stamp doesn't block.
      const dkw = writer as any;
      const sessionId = "openclaw:ch:::sk";
      // Stamp w4a-origin for ("ping","pong") at simulated past time.
      const key = dkw.dedupKey(sessionId, dkw.w4aOriginKey("ping", "pong"));
      dkw.crossPathStamps.set(key, Date.now() - 10_000); // 10s ago, beyond 5s TTL
      expect(dkw.peekCrossPathStamp(sessionId, dkw.w4aOriginKey("ping", "pong"))).toBe(false);
      // The stale entry is opportunistically evicted on the peek above.
      expect(dkw.crossPathStamps.has(key)).toBe(false);
    });


    it("R18.1 — TURNID_TTL_MS is generous enough to cover slow outbound channels (>=30s)", () => {
      // Regression for R18.1: the cross-path dedup TTL was 3s, so a slow
      // `message:sent` (queued Telegram, retry, network glitch) arriving
      // after agent_end's stamp had expired would persist the same turn
      // twice. The new TTL (60s by design, but at minimum >=30s) covers
      // realistic slow-channel delivery without making the dedup map
      // unbounded.
      const ttl = (writer.constructor as any).TURNID_TTL_MS;
      expect(ttl).toBeGreaterThanOrEqual(30_000);
    });


    it("R19.2 — flush() awaits a job enqueued AFTER its initial snapshot (loop until empty)", async () => {
      // Regression for R19.2: pre-fix, `flush()` snapshotted in-flight
      // jobs once, then awaited. A late-arriving hook handler that
      // called `trackPersistJob` AFTER the snapshot would not be in
      // the awaited set, so shutdown could return before the late
      // persist completed. The fix loops until both the in-flight
      // bucket and pending-resets bucket are empty across an iteration.

      const dkw = writer as any;
      const sessionId = "openclaw:tg:::sk";

      // Track ordering so we can assert flush awaited the late job.
      const order: string[] = [];

      // Seed an initial in-flight job that completes quickly.
      let resolveFirst: () => void = () => {};
      const firstJob = new Promise<void>((r) => { resolveFirst = r; });
      dkw.trackPersistJob(sessionId, async () => {
        await firstJob;
        order.push("first done");
      }).catch(() => {});

      // Schedule a "late" job that enqueues itself ONLY after the first
      // resolves (simulating a hook handler that races flush's snapshot).
      let resolveSecond: () => void = () => {};
      const secondJob = new Promise<void>((r) => { resolveSecond = r; });
      setTimeout(() => {
        dkw.trackPersistJob(sessionId, async () => {
          await secondJob;
          order.push("second done");
        }).catch(() => {});
      }, 5);

      // Resolve the second slightly later so flush's loop catches it.
      setTimeout(() => resolveSecond(), 30);
      // Resolve first immediately so flush proceeds past the first iteration.
      setTimeout(() => resolveFirst(), 10);

      await writer.flush();
      order.push("flush returned");
      // Both jobs must have completed BEFORE flush returned.
      expect(order).toContain("first done");
      expect(order).toContain("second done");
      expect(order[order.length - 1]).toBe("flush returned");
    });


    it("R18.2 — agent_end after setup-runtime → full upgrade does NOT re-persist W4b-written turns", async () => {
      // Regression for R18.2: while typed hooks were unavailable
      // (setup-runtime mode), W4b can persist turns directly via
      // `message:sent`, but W4a's pair-indexed watermark stays at -1
      // because no agent_end fires. After the upgrade to full mode, the
      // first agent_end's `computeDelta` would treat the entire transcript
      // as backfill and W4b's per-pair-index check (only the LAST pair
      // peeks `w4bOrigin`) wouldn't catch earlier pairs — they'd all be
      // re-persisted. The fix tracks per-session W4b persist counts and
      // raises `savedUpTo` floor by `count - 1` so already-W4b-persisted
      // pairs are skipped entirely.

      // Simulate setup-runtime: W4b persists 3 turns directly.
      for (let i = 1; i <= 3; i++) {
        await writer.onMessageReceived({
          sessionKey: "sk",
          context: { channelId: "tg", content: `q${i}`, messageId: `in-${i}` },
        } as any);
        await writer.onMessageSent({
          sessionKey: "sk",
          context: { channelId: "tg", content: `a${i}`, success: true, messageId: `out-${i}` },
        } as any);
        await flushMicrotasks();
      }
      // Three persists from W4b.
      expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(3);

      // Now full mode kicks in — agent_end fires with the full
      // accumulated `messages[]` (3 user/assistant pairs).
      const ev: AgentEndContext = {
        sessionId: "test",
        messages: [
          { role: "user", content: "q1" },
          { role: "assistant", content: "a1" },
          { role: "user", content: "q2" },
          { role: "assistant", content: "a2" },
          { role: "user", content: "q3" },
          { role: "assistant", content: "a3" },
        ],
      };
      writer.onAgentEnd(ev, { channelId: "tg", sessionKey: "sk" });
      await flushMicrotasks();
      // Must NOT re-persist any of the 3 turns W4b already wrote.
      expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(3);
    });
});
