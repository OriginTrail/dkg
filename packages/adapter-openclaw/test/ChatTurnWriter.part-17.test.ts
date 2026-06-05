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


    it("pending queue collapses into one user-side per outbound (R2.3 / T15)", async () => {
      // Pre-T15 this test asserted FIFO 1:1 matching (each outbound
      // pairs with the next-oldest inbound). That diverged from W4a
      // `computeDelta`, which collapses consecutive user messages
      // before one assistant reply via `pendingUsers.join("\n")`.
      // T15 aligned W4b with that semantic — the whole pending queue
      // drains into the first outbound; subsequent outbounds with no
      // queued users are treated as chunked replies / proactive
      // notifications and bail per the R21.2 orphan-assistant guard.
      writer.onMessageReceived({ sessionKey: "sk", direction: "inbound", text: "first" });
      writer.onMessageReceived({ sessionKey: "sk", direction: "inbound", text: "second" });
      writer.onMessageSent({ sessionKey: "sk", direction: "outbound", text: "reply-1" });
      await flushMicrotasks();
      writer.onMessageSent({ sessionKey: "sk", direction: "outbound", text: "reply-2" });
      await flushMicrotasks();
      // Exactly ONE persist — `("first\nsecond", reply-1)`. `reply-2`
      // bails because the queue is empty (R21.2).
      expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(1);
      expect(mockClient.storeChatTurn.mock.calls[0][1]).toBe("first\nsecond");
      expect(mockClient.storeChatTurn.mock.calls[0][2]).toBe("reply-1");
    });


    it("cross-path dedup: agent_end followed by message:sent with same content writes once (R2.2)", async () => {
      // First W4a path persists a turn.
      const event: AgentEndContext = {
        sessionId: "test",
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "hello" },
        ],
      };
      writer.onAgentEnd(event, { channelId: "tg", sessionKey: "sk" });
      await flushMicrotasks();
      expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(1);

      // Now the internal hook fires for the same exchange. Same sessionId
      // derivation + same user/assistant text → same turnId → must not
      // double-write.
      writer.onMessageReceived({
        sessionKey: "sk",
        direction: "inbound",
        text: "hi",
        // channelId matching so deriveSessionIdFromEvent produces openclaw:tg:sk
        // (same as deriveSessionId(ctx) above).
        ...({ context: { channelId: "tg" } } as any),
      } as any);
      writer.onMessageSent({
        sessionKey: "sk",
        direction: "outbound",
        text: "hello",
        ...({ context: { channelId: "tg", success: true } } as any),
      } as any);
      await flushMicrotasks();
      expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(1);
    });


    it("releases turnId reservation on persist failure so retry can succeed (R3.1)", async () => {
      // First call: fails outright (no retry path exhausted).
      mockClient.storeChatTurn = vi
        .fn()
        .mockRejectedValueOnce(new Error("net down"))
        .mockRejectedValueOnce(new Error("net down still"))
        .mockResolvedValue(undefined);
      writer = new ChatTurnWriter({ client: mockClient, logger: mockLogger, stateDir });

      const event: AgentEndContext = {
        sessionId: "t",
        messages: [
          { role: "user", content: "u" },
          { role: "assistant", content: "a" },
        ],
      };
      writer.onAgentEnd(event, { channelId: "ch", sessionKey: "sk" });
      await new Promise((r) => setTimeout(r, 1400)); // wait through persistOne's 250+1000ms backoff
      expect(mockClient.storeChatTurn.mock.calls.length).toBeGreaterThanOrEqual(2);

      // Round 2: same content, different instance state — dedup map must have
      // released the turnId on the failure, so the retry actually persists.
      mockClient.storeChatTurn.mockClear();
      mockClient.storeChatTurn.mockResolvedValue(undefined);
      writer.onAgentEnd(event, { channelId: "ch", sessionKey: "sk" });
      await flushMicrotasks();
      // Would be 0 if the failed turnId was still in the dedup map.
      expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(1);
    });


    it("onMessageSent strips <recalled-memory> from assistant text only (R3.2)", async () => {
      const echoed =
        "sure — <recalled-memory data-source=\"dkg-auto-recall\">[1] (agent-context-wm) secret</recalled-memory> here is your answer";
      writer.onMessageReceived({
        sessionKey: "sk",
        direction: "inbound",
        text: "q",
        ...({ context: { channelId: "tg" } } as any),
      } as any);
      writer.onMessageSent({
        sessionKey: "sk",
        direction: "outbound",
        text: echoed,
        ...({ context: { success: true, channelId: "tg" } } as any),
      } as any);
      await flushMicrotasks();
      expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(1);
      const [, persistedUser, persistedAssistant] = mockClient.storeChatTurn.mock.calls[0];
      expect(persistedUser).toBe("q"); // user side NOT stripped
      expect(persistedAssistant).not.toContain("recalled-memory");
      expect(persistedAssistant).not.toContain("secret");
      expect(persistedAssistant).toContain("sure");
      expect(persistedAssistant).toContain("here is your answer");
    });


    it("two identical-content real turns outside dedup TTL both persist (R5.1)", async () => {
      const event: AgentEndContext = {
        sessionId: "t",
        messages: [
          { role: "user", content: "thanks" },
          { role: "assistant", content: "you're welcome" },
        ],
      };
      writer.onAgentEnd(event, { channelId: "ch", sessionKey: "sk" });
      await flushMicrotasks();
      expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(1);

      // Wait past the 3s dedup TTL; a second identical-content turn must
      // persist rather than being eaten as a duplicate.
      await new Promise((r) => setTimeout(r, 3100));

      const event2: AgentEndContext = {
        sessionId: "t",
        messages: [
          { role: "user", content: "thanks" },
          { role: "assistant", content: "you're welcome" },
          { role: "user", content: "thanks" },
          { role: "assistant", content: "you're welcome" },
        ],
      };
      writer.onAgentEnd(event2, { channelId: "ch", sessionKey: "sk" });
      await flushMicrotasks();
      expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(2);
    }, 10_000);


    it("onBeforeCompaction clears the watermark so post-compaction turns persist (R5.2)", async () => {
      // Pre-compaction setup: seed past cold-start (1 persist), then
      // an in-session backfill of 2 pairs (post-clamp, in-session
      // backfill emits all unsaved pairs). Watermark advances to 2.
      writer.onAgentEnd(
        { sessionId: "t", messages: [
          { role: "user", content: "__seed__" },
          { role: "assistant", content: "__seed__reply__" },
        ]},
        { channelId: "ch", sessionKey: "sk" },
      );
      await flushMicrotasks();
      mockClient.storeChatTurn.mockClear();

      const preEvent: AgentEndContext = {
        sessionId: "t",
        messages: [
          { role: "user", content: "__seed__" },              // saved
          { role: "assistant", content: "__seed__reply__" },
          { role: "user", content: "u1" },                    // emit
          { role: "assistant", content: "a1" },
          { role: "user", content: "u2" },                    // emit
          { role: "assistant", content: "a2" },
        ],
      };
      writer.onAgentEnd(preEvent, { channelId: "ch", sessionKey: "sk" });
      await flushMicrotasks();
      await new Promise((r) => setTimeout(r, 70)); // let the 50ms debounce commit
      expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(2);

      mockClient.storeChatTurn.mockClear();
      // Session-scoped reset — must pass the same ctx so the correct
      // session's watermark is cleared. After this, savedUpTo returns
      // to -1; the next agent_end is again "cold start" for this
      // session.
      writer.onBeforeCompaction({}, { channelId: "ch", sessionKey: "sk" });

      // After compaction a shorter messages array arrives (representative
      // of gateway summarization: old turns folded to a single summary
      // pair). Without the watermark reset, the pair-count cursor at 2
      // would skip the first pairs of this new array.
      // T362 — Post-compaction the cold-start clamp re-engages: only the
      // latest pair persists, matching the "fresh start" mental model.
      // Pre-T362 this test asserted 2 post-compaction persists; with the
      // clamp, the assertion is 1 (the latest pair). Compaction's job
      // here is verified: the watermark was cleared and a NEW pair lands
      // (it would NOT land if the watermark had not been cleared, since
      // the new content's pairIndex 0 would be ≤ the old watermark of 2).
      // Also wait past the 3s dedup TTL so identical-text turns aren't
      // blocked by the cross-path dedup map.
      await new Promise((r) => setTimeout(r, 3100));
      const postEvent: AgentEndContext = {
        sessionId: "t",
        messages: [
          { role: "user", content: "summary" },
          { role: "assistant", content: "ack" },
          { role: "user", content: "follow-up" },
          { role: "assistant", content: "reply" },
        ],
      };
      writer.onAgentEnd(postEvent, { channelId: "ch", sessionKey: "sk" });
      await flushMicrotasks();
      expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(1);
      expect(mockClient.storeChatTurn.mock.calls[0][1]).toBe("follow-up");
      expect(mockClient.storeChatTurn.mock.calls[0][2]).toBe("reply");
    }, 10_000);


    it("onBeforeCompaction resets only the affected session's watermark (R6.1)", async () => {
      // Session A: persist 2 pairs → watermark advances to 1.
      const eventA: AgentEndContext = {
        sessionId: "t",
        messages: [
          { role: "user", content: "a-u1" },
          { role: "assistant", content: "a-a1" },
          { role: "user", content: "a-u2" },
          { role: "assistant", content: "a-a2" },
        ],
      };
      writer.onAgentEnd(eventA, { channelId: "chA", sessionKey: "skA" });
      await flushMicrotasks();
      await new Promise((r) => setTimeout(r, 70)); // commit debounce
      // Session B: persist 2 pairs → session B watermark advances.
      const eventB: AgentEndContext = {
        sessionId: "t",
        messages: [
          { role: "user", content: "b-u1" },
          { role: "assistant", content: "b-a1" },
          { role: "user", content: "b-u2" },
          { role: "assistant", content: "b-a2" },
        ],
      };
      writer.onAgentEnd(eventB, { channelId: "chB", sessionKey: "skB" });
      await flushMicrotasks();
      await new Promise((r) => setTimeout(r, 70));

      mockClient.storeChatTurn.mockClear();
      // Compact session A only — session B's cursor must survive.
      writer.onBeforeCompaction({}, { channelId: "chA", sessionKey: "skA" });

      // Wait past dedup TTL so identical text wouldn't be blocked.
      await new Promise((r) => setTimeout(r, 3100));

      // Fire session B's agent_end with the SAME 2 pairs it already has.
      // If R6.1 was broken (full wipe), we'd see 2 new persists (both pairs
      // re-played into DKG). With session-scoped reset, B's watermark is
      // still at its prior position → 0 new persists expected.
      writer.onAgentEnd(eventB, { channelId: "chB", sessionKey: "skB" });
      await flushMicrotasks();
      expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(0);
    }, 10_000);


    it("distinct accountId/conversationId produce distinct sessionIds (R4.1 thread separation)", async () => {
      // Two events sharing sessionKey on the same channel but differing in
      // accountId must land under different DKG sessionIds — otherwise
      // unrelated Telegram/WhatsApp threads merge into one persisted
      // session and turns across threads could be mis-dedup'd.
      writer.onMessageReceived({
        sessionKey: "shared-key",
        direction: "inbound",
        text: "hi from A",
        ...({ context: { channelId: "tg", accountId: "userA", conversationId: "convA" } } as any),
      } as any);
      writer.onMessageSent({
        sessionKey: "shared-key",
        direction: "outbound",
        text: "reply to A",
        ...({ context: { channelId: "tg", accountId: "userA", conversationId: "convA", success: true } } as any),
      } as any);
      writer.onMessageReceived({
        sessionKey: "shared-key",
        direction: "inbound",
        text: "hi from B",
        ...({ context: { channelId: "tg", accountId: "userB", conversationId: "convB" } } as any),
      } as any);
      writer.onMessageSent({
        sessionKey: "shared-key",
        direction: "outbound",
        text: "reply to B",
        ...({ context: { channelId: "tg", accountId: "userB", conversationId: "convB", success: true } } as any),
      } as any);
      await flushMicrotasks();
      expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(2);
      const sidA = mockClient.storeChatTurn.mock.calls[0][0];
      const sidB = mockClient.storeChatTurn.mock.calls[1][0];
      expect(sidA).not.toBe(sidB);
      expect(sidA).toContain("userA");
      expect(sidB).toContain("userB");
    });


    it("computeDelta preserves user text containing <recalled-memory> tag (R3.4)", async () => {
      const userWithTag =
        "I'm trying to debug this log excerpt: <recalled-memory>something</recalled-memory>";
      const event: AgentEndContext = {
        sessionId: "t",
        messages: [
          { role: "user", content: userWithTag },
          { role: "assistant", content: "that looks malformed" },
        ],
      };
      writer.onAgentEnd(event, { channelId: "ch", sessionKey: "sk" });
      await flushMicrotasks();
      const [, u] = mockClient.storeChatTurn.mock.calls[0];
      // User side preserves the raw tag content verbatim.
      expect(u).toBe(userWithTag);
    });


    it("drops failed outbound sends without persisting, still consumes pending (R1 failed sends)", async () => {
      writer.onMessageReceived({ sessionKey: "sk", direction: "inbound", text: "hello" });
      writer.onMessageSent({
        sessionKey: "sk",
        direction: "outbound",
        text: "never-delivered",
        ...({ context: { success: false } } as any),
      } as any);
      await flushMicrotasks();
      expect(mockClient.storeChatTurn).not.toHaveBeenCalled();
      // The pending inbound must have been consumed — a later successful turn
      // should not re-pair with the stale "hello".
      writer.onMessageReceived({ sessionKey: "sk", direction: "inbound", text: "retry" });
      writer.onMessageSent({
        sessionKey: "sk",
        direction: "outbound",
        text: "second-try",
        ...({ context: { success: true } } as any),
      } as any);
      await flushMicrotasks();
      expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(1);
      expect(mockClient.storeChatTurn.mock.calls[0][1]).toBe("retry");
    });


    it("T21 — setStateDir awaits in-flight persists before swapping paths (no lost turns mid-migration)", async () => {
      // Regression for T21: the earlier T18 migration used flushSync(),
      // which only writes the debounced watermark and does NOT await
      // in-flight `storeChatTurn` jobs. Mid-migration completions
      // would land at the OLD path while the writer was already
      // pointed at the NEW path — silent data loss / desync.
      let releaseStore: (() => void) | null = null;
      let storeStarted = false;
      let storeFinished = false;
      mockClient.storeChatTurn = vi.fn().mockImplementation(async () => {
        storeStarted = true;
        await new Promise<void>((resolve) => { releaseStore = resolve; });
        storeFinished = true;
      });
      writer = new ChatTurnWriter({ client: mockClient, logger: mockLogger, stateDir });

      // Start a persist that hangs.
      writer.onMessageReceived({ sessionKey: "sk", context: { channelId: "tg", content: "u1" } } as any);
      void writer.onMessageSent({
        sessionKey: "sk",
        context: { channelId: "tg", content: "r1", success: true, messageId: "out-1" },
      } as any);
      await flushMicrotasks();
      expect(storeStarted).toBe(true);
      expect(storeFinished).toBe(false);

      // Trigger setStateDir while the persist is hanging. It must NOT
      // proceed past the `flush()` call until storeChatTurn returns.
      const newStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "chatturnwriter-t21-"));
      let migrationFinished = false;
      const migrationPromise = writer.setStateDir(newStateDir).then(() => {
        migrationFinished = true;
      });
      // Give the migration a tick to start.
      await flushMicrotasks();
      // Migration MUST be blocked on flush() awaiting the in-flight
      // storeChatTurn. If it finished, T21 was not actually addressed.
      expect(migrationFinished).toBe(false);

      // Now release the persist; migration proceeds.
      releaseStore?.();
      await migrationPromise;
      expect(storeFinished).toBe(true);
      expect(migrationFinished).toBe(true);
      // New file exists at the new location.
      const newFile = path.join(newStateDir, "dkg-adapter", "chat-turn-watermarks.json");
      expect(fs.existsSync(newFile)).toBe(true);
      try { fs.rmSync(newStateDir, { recursive: true, force: true }); } catch { /* best effort */ }
    });
});
