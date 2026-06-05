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


    it("R17.1 — contentHash distinguishes (a:b, c) from (a, b:c) (no delimiter collision)", () => {
      // Regression for R17.1: pre-fix, both pairs hashed `${user}:${assistant}`
      // → "a:b:c" → same digest → cross-path dedup falsely treated distinct
      // turns as duplicates and skipped persistence. The new structured
      // encoding via JSON.stringify quotes each segment unambiguously.
      const dkw = writer as any;
      const h1 = dkw.contentHash("a:b", "c");
      const h2 = dkw.contentHash("a", "b:c");
      expect(h1).not.toBe(h2);
      // Same values still hash to the same digest (idempotency).
      expect(dkw.contentHash("a:b", "c")).toBe(h1);
    });


    it("R17.1 — deterministicTurnId distinguishes (s:1, u, a) from (s, 1:u, a) (no delimiter collision)", () => {
      // Regression for R17.1: pre-fix, sessionId/user/assistant joined with
      // raw `:` produced colliding hashes for distinct sessionId-vs-user
      // splits. The new JSON.stringify encoding quotes each segment.
      const dkw = writer as any;
      const id1 = dkw.deterministicTurnId("s:1", "u", "a");
      const id2 = dkw.deterministicTurnId("s", "1:u", "a");
      expect(id1).not.toBe(id2);
      // pairIndex variant: same content + different pairIndex → different ids.
      const id3 = dkw.deterministicTurnId("s", "u", "a", 0);
      const id4 = dkw.deterministicTurnId("s", "u", "a", 1);
      expect(id3).not.toBe(id4);
    });


    it("R15.1 — two legitimate same-content W4b turns within the dedup TTL both persist when messageId is supplied", async () => {
      // Regression for R15.1: previously W4b's pre-persist dedup key was
      // content-only with a 3s TTL, so two legitimate non-LLM turns with
      // identical text within 3 seconds dropped the second reply. The
      // fix moves the in-flight guard to a per-turn `messageId`-based
      // key (the gateway emits one `messageId` per delivery per
      // `openclaw/src/infra/outbound/deliver.ts`). Cross-path stamping
      // of the content-only `w4bOrigin` happens AFTER persist completes
      // and never blocks legitimate sequential same-content turns.
      writer.onMessageReceived({
        sessionKey: "sk",
        context: { channelId: "tg", content: "ping", messageId: "in-msg-1" },
      } as any);
      await writer.onMessageSent({
        sessionKey: "sk",
        context: { channelId: "tg", content: "pong", success: true, messageId: "out-msg-1" },
      } as any);
      await flushMicrotasks();
      expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(1);

      // Same content within the 3s TTL — different messageId. Must persist.
      writer.onMessageReceived({
        sessionKey: "sk",
        context: { channelId: "tg", content: "ping", messageId: "in-msg-2" },
      } as any);
      await writer.onMessageSent({
        sessionKey: "sk",
        context: { channelId: "tg", content: "pong", success: true, messageId: "out-msg-2" },
      } as any);
      await flushMicrotasks();
      expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(2);
    });


    it("R15.2 — empty inbound text is dropped (attachment-only events do not enqueue blanks)", () => {
      // Regression for R15.2: `readEventText` returns "" for attachment-only
      // / non-text inbound events. Previously we still enqueued an empty
      // string, which paired with the next `message:sent` to persist an
      // assistant-only turn for a conversation that had no textual inbound.
      // Skip until we add a recoverable representation for non-text payloads.
      writer.onMessageReceived({
        sessionKey: "sk",
        context: { channelId: "tg", content: "" },
      } as any);
      writer.onMessageReceived({
        sessionKey: "sk",
        context: { channelId: "tg" }, // no content at all
      } as any);
      expect((writer as any).pendingUserMessages.size).toBe(0);

      // A genuine text inbound after the empty ones still enqueues normally.
      writer.onMessageReceived({
        sessionKey: "sk",
        context: { channelId: "tg", content: "hello" },
      } as any);
      expect((writer as any).pendingUserMessages.size).toBe(1);
    });


    it("W4b-first then W4a same content: cross-path dedup is symmetric, no double-write (R12.6)", async () => {
      // The qa-engineer-flagged R10/R11 race: previously W4b would persist
      // and then W4a's pair (same content, different turnId via pairIndex)
      // wouldn't dedup against it. Now W4b reserves w4b-content origin and
      // W4a's last-pair check catches that.
      writer.onMessageReceived({
        sessionKey: "sk",
        context: { channelId: "tg", content: "hi" },
      } as any);
      await writer.onMessageSent({
        sessionKey: "sk",
        context: { channelId: "tg", content: "hello", success: true },
      } as any);
      await flushMicrotasks();
      expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(1); // W4b wrote

      // Now W4a fires for the same turn (canonical mixed scenario).
      writer.onAgentEnd(
        {
          sessionId: "t",
          messages: [
            { role: "user", content: "hi" },
            { role: "assistant", content: "hello" },
          ],
        },
        { channelId: "tg", sessionKey: "sk" },
      );
      await flushMicrotasks();
      // W4a's last-pair check sees the W4b origin reservation → skips.
      expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(1);
    });


    it("backfill of identical content STILL persists both pairs even after symmetric dedup (R12.6 + R10.4)", async () => {
      // Backfill scenario: in-session agent_end fires with messages array
      // containing two same-content pairs. Pre-fix collision in dedup
      // would drop the second. The W4b-origin check is gated to LAST
      // pair only, so the earlier (backfill) pair persists via its own
      // pair-indexed turnId without false dedup.
      //
      // T362 — Seed the writer past cold-start first; the cold-start
      // clamp would otherwise discard historical pairs and emit only
      // the latest. This test specifically exercises in-session
      // backfill (the post-cold-start regime), so we seed and clear.
      writer.onAgentEnd(
        { sessionId: "t", messages: [
          { role: "user", content: "__seed__" },
          { role: "assistant", content: "__seed__reply__" },
        ]},
        { channelId: "ch", sessionKey: "sk" },
      );
      await flushMicrotasks();
      mockClient.storeChatTurn.mockClear();

      const event: AgentEndContext = {
        sessionId: "t",
        messages: [
          { role: "user", content: "__seed__" },              // pairIndex 0 — savedUpTo
          { role: "assistant", content: "__seed__reply__" },
          { role: "user", content: "thanks" },                // pairIndex 1 — emit
          { role: "assistant", content: "you're welcome" },
          { role: "user", content: "thanks" },                // pairIndex 2 — emit
          { role: "assistant", content: "you're welcome" },
        ],
      };
      writer.onAgentEnd(event, { channelId: "ch", sessionKey: "sk" });
      await flushMicrotasks();
      expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(2);
    });


    it("encodes ':' in session-id fields so colon-rich values don't collide (R12.8)", async () => {
      // Two distinct conversations whose raw fields naively join to the
      // SAME `openclaw:...` string under the pre-fix joiner:
      //   A: channelId='ch', accountId='a', conversationId='', sessionKey='b:c'
      //      → naive: openclaw:ch:a::b:c
      //   B: channelId='ch:a', accountId='', conversationId='', sessionKey='b:c'
      //      → naive: openclaw:ch:a::b:c   (collision)
      // With per-field colon encoding the two land at distinct keys and
      // their pending queues are kept separate.
      writer.onMessageReceived({
        sessionKey: "b:c",
        context: { channelId: "ch", accountId: "a", content: "from-A" },
      } as any);
      writer.onMessageReceived({
        sessionKey: "b:c",
        context: { channelId: "ch:a", content: "from-B" },
      } as any);
      const pending = (writer as any).pendingUserMessages as Map<string, string[]>;
      expect(pending.size).toBe(2); // two distinct conversation keys
    });


    it("on persist failure W4b restores the user message to the front of the queue (R12.3/R12.7)", async () => {
      // Pre-fix: persist failure dropped the user half permanently.
      mockClient.storeChatTurn = vi
        .fn()
        .mockRejectedValueOnce(new Error("daemon down"))
        .mockRejectedValueOnce(new Error("daemon still down"))
        .mockResolvedValue(undefined);
      writer = new ChatTurnWriter({ client: mockClient, logger: mockLogger, stateDir });

      writer.onMessageReceived({
        sessionKey: "sk",
        context: { channelId: "tg", content: "important question" },
      } as any);
      await writer.onMessageSent({
        sessionKey: "sk",
        context: { channelId: "tg", content: "first attempt reply", success: true },
      } as any);
      // wait for persist retries to complete + failure restoration
      await new Promise((r) => setTimeout(r, 1500));
      // First attempt failed; user message should be restored to the queue.
      const pending = (writer as any).pendingUserMessages as Map<string, string[]>;
      let restored: string[] | undefined;
      for (const v of pending.values()) restored = v;
      expect(restored?.[0]).toBe("important question");
    }, 10_000);


    it("watermark uses absolute pairIndex and does not drift on cross-path persist (R11.2)", async () => {
      // Simulate W4a + W4b firing for the same turn: W4a persists with
      // pairIndex=0, W4b persists without pairIndex. Watermark must end
      // at 0, NOT 1 (no double-increment). Then a follow-up agent_end
      // with the same pair must NOT be re-persisted.
      await writer.onAgentEnd(
        {
          sessionId: "t",
          messages: [
            { role: "user", content: "hi" },
            { role: "assistant", content: "hello" },
          ],
        },
        { channelId: "tg", sessionKey: "sk" },
      );
      await flushMicrotasks();
      await new Promise((r) => setTimeout(r, 70)); // commit debounce
      expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(1);
      const watermarks = (writer as any).cachedWatermarks as Map<string, number>;
      const sid = "openclaw:tg:::sk";
      expect(watermarks.get(sid)).toBe(0); // absolute pair index, NOT 1
    });


    it("backfill: W4a persists pair 5 then pair 7 — watermark is 7, not incrementing arithmetic (R11.2)", async () => {
      // 4 unsaved in-session pairs (indices 1..4). After all persist,
      // watermark should be at the last persisted pair's index (4), not
      // cumulative count of persists.
      //
      // T362 — Seed past cold-start first; the clamp engages on
      // savedUpTo === -1 and would otherwise discard the historical
      // pairs. This test specifically asserts the absolute-pairIndex
      // watermark advance, which is in-session backfill behavior.
      writer.onAgentEnd(
        { sessionId: "t", messages: [
          { role: "user", content: "__seed__" },
          { role: "assistant", content: "__seed__reply__" },
        ]},
        { channelId: "ch", sessionKey: "sk" },
      );
      await flushMicrotasks();
      mockClient.storeChatTurn.mockClear();

      const event: AgentEndContext = {
        sessionId: "t",
        messages: [
          { role: "user", content: "__seed__" },              // pairIndex 0 — saved
          { role: "assistant", content: "__seed__reply__" },
          { role: "user", content: "u0" },                    // pairIndex 1 — emit
          { role: "assistant", content: "a0" },
          { role: "user", content: "u1" },                    // pairIndex 2 — emit
          { role: "assistant", content: "a1" },
          { role: "user", content: "u2" },                    // pairIndex 3 — emit
          { role: "assistant", content: "a2" },
          { role: "user", content: "u3" },                    // pairIndex 4 — emit
          { role: "assistant", content: "a3" },
        ],
      };
      await writer.onAgentEnd(event, { channelId: "ch", sessionKey: "sk" });
      await flushMicrotasks();
      await new Promise((r) => setTimeout(r, 70));
      expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(4);
      const watermarks = (writer as any).cachedWatermarks as Map<string, number>;
      expect(watermarks.get("openclaw:ch:::sk")).toBe(4); // last pairIndex
    });


    it("collapses tool-using turn into one (user, final-reply) pair (R10.3)", async () => {
      // Tool-using turn: [user, assistant(tool_call), tool, assistant(final_reply)].
      // Without the intermediate-step skip, computeDelta would emit TWO pairs:
      // (user, "") and ("", final_reply) — both wrong.
      const event: AgentEndContext = {
        sessionId: "t",
        messages: [
          { role: "user", content: "look up the weather" },
          { role: "assistant", content: "", tool_calls: [{ id: "c1", name: "get_weather" }] } as any,
          { role: "tool", content: "72°F sunny" } as any,
          { role: "assistant", content: "It's 72°F and sunny." },
        ],
      };
      writer.onAgentEnd(event, { channelId: "ch", sessionKey: "sk" });
      await flushMicrotasks();
      expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(1);
      const [, persistedUser, persistedAssistant] = mockClient.storeChatTurn.mock.calls[0];
      expect(persistedUser).toBe("look up the weather");
      expect(persistedAssistant).toBe("It's 72°F and sunny.");
    });


    it("backfill of two identical-content pairs both persist (R10.4 pair-index discriminator)", async () => {
      // Pre-fix: same-content pairs collided on the dedup key and only the
      // first persisted. With pairIndex baked into the W4a turnId, both
      // backfill pairs get distinct turnIds and both write.
      //
      // T362 — In-session backfill regime; seed first to bypass the
      // cold-start clamp (which would discard historical pairs and emit
      // only the latest, defeating this test's purpose of verifying that
      // two unsaved same-content pairs both persist).
      writer.onAgentEnd(
        { sessionId: "t", messages: [
          { role: "user", content: "__seed__" },
          { role: "assistant", content: "__seed__reply__" },
        ]},
        { channelId: "ch", sessionKey: "sk" },
      );
      await flushMicrotasks();
      mockClient.storeChatTurn.mockClear();

      const event: AgentEndContext = {
        sessionId: "t",
        messages: [
          { role: "user", content: "__seed__" },              // saved
          { role: "assistant", content: "__seed__reply__" },
          { role: "user", content: "thanks" },                // emit (pairIndex 1)
          { role: "assistant", content: "you're welcome" },
          { role: "user", content: "thanks" },                // emit (pairIndex 2)
          { role: "assistant", content: "you're welcome" },
        ],
      };
      writer.onAgentEnd(event, { channelId: "ch", sessionKey: "sk" });
      await flushMicrotasks();
      expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(2);
    });


    it("W4a stamps content alias so a W4b message:sent for same content dedups (R10.4 cross-path)", async () => {
      // First fire W4a; assert exactly one persist + that the content alias
      // is present in the dedup map.
      writer.onAgentEnd(
        {
          sessionId: "t",
          messages: [
            { role: "user", content: "hi" },
            { role: "assistant", content: "hello" },
          ],
        },
        { channelId: "tg", sessionKey: "sk" },
      );
      await flushMicrotasks();
      expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(1);

      // Now fire W4b with the same content. Cross-path dedup must skip.
      writer.onMessageReceived({
        sessionKey: "sk",
        context: { channelId: "tg", content: "hi" },
      } as any);
      await writer.onMessageSent({
        sessionKey: "sk",
        context: { channelId: "tg", content: "hello", success: true },
      } as any);
      await flushMicrotasks();
      expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(1); // unchanged
    });
});
