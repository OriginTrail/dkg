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


    it("flushSync clears debounce timers", () => {
      writer.flushSync();
      expect((writer as any).debounceTimers.size).toBe(0);
    });


    it("R21.2 — onMessageSent with no pending user does NOT persist an orphan assistant turn", async () => {
      // Regression for R21.2: pre-fix, an outbound `message:sent` arriving
      // when the pending-user queue was empty (chunk 2+ of one logical
      // reply, or a proactive notification with no inbound) persisted as a
      // standalone assistant-only turn. That polluted chat memory/search
      // results and broke the one-turn-per-exchange invariant. The fix
      // bails when the queue is empty.
      await writer.onMessageSent({
        sessionKey: "sk",
        context: { channelId: "tg", content: "orphan reply", success: true, messageId: "out-orphan" },
      } as any);
      await flushMicrotasks();
      expect(mockClient.storeChatTurn).not.toHaveBeenCalled();

      // Confirm normal pairing still works after the bail-on-empty.
      writer.onMessageReceived({
        sessionKey: "sk",
        context: { channelId: "tg", content: "real q", messageId: "in-1" },
      } as any);
      await writer.onMessageSent({
        sessionKey: "sk",
        context: { channelId: "tg", content: "real reply", success: true, messageId: "out-1" },
      } as any);
      await flushMicrotasks();
      expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(1);
    });


    it("R20.1 — onMessageSent with success=true but empty content does NOT consume the pending user", async () => {
      // Regression for R20.1: pre-fix, the dequeue happened before the
      // `assistantText` check, so a `message:sent` carrying an empty
      // content (channel ack, attachment-only send, status broadcast)
      // would eat the user side and leave the next REAL textual reply
      // with no pending user — persisted as an assistant-only turn.
      writer.onMessageReceived({
        sessionKey: "sk",
        context: { channelId: "tg", content: "real user question", messageId: "in-1" },
      } as any);

      // Empty-content success-true outbound (channel ack / attachment-only).
      await writer.onMessageSent({
        sessionKey: "sk",
        context: { channelId: "tg", content: "", success: true, messageId: "out-ack" },
      } as any);
      await flushMicrotasks();
      expect(mockClient.storeChatTurn).not.toHaveBeenCalled();
      // The pending user must still be in the queue.
      const pending = (writer as any).pendingUserMessages;
      expect(pending.size).toBeGreaterThan(0);

      // The real reply now arrives — must pair with the original user.
      await writer.onMessageSent({
        sessionKey: "sk",
        context: { channelId: "tg", content: "real reply", success: true, messageId: "out-1" },
      } as any);
      await flushMicrotasks();
      expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(1);
      const call = mockClient.storeChatTurn.mock.calls[0];
      expect(call[1]).toBe("real user question");
      expect(call[2]).toBe("real reply");
    });


    it("T16 — W4b's peek-hit on w4aOrigin stamp consumes it so a future same-content turn within 5s does not false-dedup", async () => {
      // Regression for T16: pre-fix, the cross-path stamp lived for 5s
      // post-success and was peeked non-mutatively. If a turn 1 W4a
      // persisted same-content C1, then turn 2 with same content C1
      // arrived within 5s, W4b's peek would hit turn 1's stale stamp
      // and skip turn 2 — even though W4a never re-stamped (e.g., W4a
      // didn't fire for turn 2). Post-fix, the stamp is CONSUMED on
      // peek-hit so a future stale-hit can't trigger.
      const dkw = writer as any;
      const sessionId = "openclaw:tg:::sk";
      // Stamp w4aOrigin manually (simulating W4a's post-success stamp).
      dkw.markCrossPathStamp(sessionId, dkw.w4aOriginKey("hi", "there"));
      expect(dkw.peekCrossPathStamp(sessionId, dkw.w4aOriginKey("hi", "there"))).toBe(true);

      // W4b fires for the same content — peek hits, consumes stamp, returns.
      writer.onMessageReceived({
        sessionKey: "sk",
        context: { channelId: "tg", content: "hi", messageId: "in-1" },
      } as any);
      await writer.onMessageSent({
        sessionKey: "sk",
        context: { channelId: "tg", content: "there", success: true, messageId: "out-1" },
      } as any);
      await flushMicrotasks();
      expect(mockClient.storeChatTurn).not.toHaveBeenCalled(); // skipped per stamp

      // CRITICAL: stamp must now be GONE.
      expect(dkw.peekCrossPathStamp(sessionId, dkw.w4aOriginKey("hi", "there"))).toBe(false);
    });


    it("T16 — W4a's last-pair peek-hit on w4bOrigin stamp consumes it (symmetric)", async () => {
      // Symmetric regression: W4a's last-pair check must also consume
      // the stamp after a hit, so a later same-content backfill cycle
      // doesn't false-dedup against a stale W4b stamp.
      const dkw = writer as any;
      const sessionId = "openclaw:tg:::sk";
      dkw.markCrossPathStamp(sessionId, dkw.w4bOriginKey("ping", "pong"));
      expect(dkw.peekCrossPathStamp(sessionId, dkw.w4bOriginKey("ping", "pong"))).toBe(true);

      const ev: AgentEndContext = {
        sessionId: "test",
        messages: [
          { role: "user", content: "ping" },
          { role: "assistant", content: "pong" },
        ],
      };
      writer.onAgentEnd(ev, { channelId: "tg", sessionKey: "sk" });
      await flushMicrotasks();
      // Stamp consumed.
      expect(dkw.peekCrossPathStamp(sessionId, dkw.w4bOriginKey("ping", "pong"))).toBe(false);
    });


    it("T17 — w4bSessionCounts is persisted to disk and restored across writer restart", async () => {
      // Regression for T17: pre-fix, w4bSessionCounts was process-local
      // only. setup-runtime mode → W4b persists turns → process restart
      // → w4bCount resets to 0 while watermark file is still -1 → next
      // agent_end re-emits every W4b-persisted pair as backfill (daemon
      // duplicate writes). Post-fix, the count is persisted alongside
      // the watermark in the same file under `{ w, b }` shape.
      writer.onMessageReceived({
        sessionKey: "sk",
        context: { channelId: "tg", content: "u1", messageId: "in-1" },
      } as any);
      await writer.onMessageSent({
        sessionKey: "sk",
        context: { channelId: "tg", content: "r1", success: true, messageId: "out-1" },
      } as any);
      await flushMicrotasks();
      // First turn persisted; w4bCount should now be 1 in memory.
      expect((writer as any).w4bSessionCounts.get("openclaw:tg:::sk")).toBe(1);

      // Force the debounced flush to write to disk.
      writer.flushSync();
      // Wait an extra tick for the timer-driven write.
      await new Promise((r) => setTimeout(r, 100));

      // Simulate process restart by constructing a NEW writer with the
      // SAME stateDir. It MUST load w4bCount from disk, not start at 0.
      const newWriter = new ChatTurnWriter({ client: mockClient, logger: mockLogger, stateDir });
      expect((newWriter as any).w4bSessionCounts.get("openclaw:tg:::sk")).toBe(1);
      newWriter.flushSync();
    });


    it("T80 — W4b success durably writes the skip floor before the debounce window", async () => {
      writer.onMessageReceived({
        sessionKey: "sk",
        context: { channelId: "tg", content: "u1", messageId: "in-1" },
      } as any);
      await writer.onMessageSent({
        sessionKey: "sk",
        context: { channelId: "tg", content: "a1", success: true, messageId: "out-1" },
      } as any);
      await flushMicrotasks();

      const restarted = new ChatTurnWriter({ client: mockClient, logger: mockLogger, stateDir });
      expect((restarted as any).w4bSessionCounts.get("openclaw:tg:::sk")).toBe(1);

      mockClient.storeChatTurn.mockClear();
      restarted.onAgentEnd({
        sessionId: "test",
        messages: [
          { role: "user", content: "u1" },
          { role: "assistant", content: "a1" },
        ],
      }, { channelId: "tg", sessionKey: "sk" });
      await flushMicrotasks();

      expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(0);
      restarted.flushSync();
    });


    it("T359 - typed W4b restart durability prevents W4a duplicate backfill", async () => {
      writer.onTypedMessageReceived(
        { from: "user-1", content: "restart typed q", metadata: { messageId: "typed-restart-in" } },
        { channelId: "telegram", accountId: "bot", conversationId: "chat-restart", sessionKey: "sk" },
      );
      await writer.onTypedMessageSent(
        { to: "user-1", content: "restart typed a", success: true },
        { channelId: "telegram", accountId: "bot", conversationId: "chat-restart", sessionKey: "sk" },
      );
      await flushMicrotasks();

      const sessionId = "openclaw:telegram:bot:chat-restart:sk";
      expect((writer as any).w4bSessionCounts.get(sessionId)).toBe(1);

      const restarted = new ChatTurnWriter({ client: mockClient, logger: mockLogger, stateDir });
      expect((restarted as any).w4bSessionCounts.get(sessionId)).toBe(1);

      mockClient.storeChatTurn.mockClear();
      restarted.onAgentEnd({
        sessionId: "test",
        messages: [
          { role: "user", content: "restart typed q" },
          { role: "assistant", content: "restart typed a" },
        ],
      }, { channelId: "telegram", accountId: "bot", conversationId: "chat-restart", sessionKey: "sk" });
      await flushMicrotasks();

      expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(0);
      restarted.flushSync();
    });


    it("T359 - concrete typed W4b marker suppresses W4a replay after reset clears counts", async () => {
      writer.onTypedMessageReceived(
        { from: "user-1", content: "concrete marker q", metadata: { messageId: "concrete-marker-in" } },
        { channelId: "telegram", accountId: "bot", conversationId: "chat-concrete-marker", sessionKey: "sk" },
      );
      await writer.onTypedMessageSent(
        { to: "user-1", content: "concrete marker a", success: true },
        { channelId: "telegram", accountId: "bot", conversationId: "chat-concrete-marker", sessionKey: "sk" },
      );
      await flushMicrotasks();

      const sessionId = "openclaw:telegram:bot:chat-concrete-marker:sk";
      expect((writer as any).w4bSessionCounts.get(sessionId)).toBe(1);

      const restarted = new ChatTurnWriter({ client: mockClient, logger: mockLogger, stateDir });
      await restarted.onBeforeCompaction({}, {
        channelId: "telegram",
        accountId: "bot",
        conversationId: "chat-concrete-marker",
        sessionKey: "sk",
      });
      expect((restarted as any).w4bSessionCounts.has(sessionId)).toBe(false);

      mockClient.storeChatTurn.mockClear();
      restarted.onAgentEnd({
        sessionId: "test",
        messages: [
          { role: "user", content: "concrete marker q", metadata: { messageId: "concrete-marker-in" } },
          { role: "assistant", content: "concrete marker a" },
        ],
      }, { channelId: "telegram", accountId: "bot", conversationId: "chat-concrete-marker", sessionKey: "sk" });
      await flushMicrotasks();

      expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(0);
      expect((restarted as any).cachedWatermarks.get(sessionId)).toBe(0);

      await restarted.onBeforeCompaction({}, {
        channelId: "telegram",
        accountId: "bot",
        conversationId: "chat-concrete-marker",
        sessionKey: "sk",
      });
      mockClient.storeChatTurn.mockClear();
      restarted.onAgentEnd({
        sessionId: "test",
        messages: [
          { role: "user", content: "concrete marker q", metadata: { messageId: "concrete-marker-in" } },
          { role: "assistant", content: "concrete marker a" },
        ],
      }, { channelId: "telegram", accountId: "bot", conversationId: "chat-concrete-marker", sessionKey: "sk" });
      await flushMicrotasks();

      expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(0);
      expect((restarted as any).cachedWatermarks.get(sessionId)).toBe(0);
      restarted.flushSync();
    });


    it("T359 - outbound-only typed W4b marker suppresses W4a replay after reset", async () => {
      writer.onTypedMessageReceived(
        { from: "user-1", content: "outbound marker q" },
        { channelId: "telegram", accountId: "bot", conversationId: "chat-outbound-marker", sessionKey: "sk" },
      );
      await writer.onTypedMessageSent(
        { to: "user-1", content: "outbound marker a", success: true, metadata: { messageId: "outbound-marker-out" } },
        { channelId: "telegram", accountId: "bot", conversationId: "chat-outbound-marker", sessionKey: "sk" },
      );
      await flushMicrotasks();

      const sessionId = "openclaw:telegram:bot:chat-outbound-marker:sk";
      expect((writer as any).w4bSessionCounts.get(sessionId)).toBe(1);

      const restarted = new ChatTurnWriter({ client: mockClient, logger: mockLogger, stateDir });
      await restarted.onBeforeCompaction({}, {
        channelId: "telegram",
        accountId: "bot",
        conversationId: "chat-outbound-marker",
        sessionKey: "sk",
      });
      expect((restarted as any).w4bSessionCounts.has(sessionId)).toBe(false);

      mockClient.storeChatTurn.mockClear();
      restarted.onAgentEnd({
        sessionId: "test",
        messages: [
          { role: "user", content: "outbound marker q" },
          { role: "assistant", content: "outbound marker a", metadata: { messageId: "outbound-marker-out" } },
        ],
      }, { channelId: "telegram", accountId: "bot", conversationId: "chat-outbound-marker", sessionKey: "sk" });
      await flushMicrotasks();

      expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(0);
      expect((restarted as any).cachedWatermarks.get(sessionId)).toBe(0);
      restarted.flushSync();
    });


    it("T96 - W4b durable write failure retries state flush after daemon success", async () => {
      const writeSpy = vi.spyOn(writer as any, "writeWatermarkFile")
        .mockImplementationOnce(() => false);

      writer.onMessageReceived({
        sessionKey: "sk",
        context: { channelId: "tg", content: "retry q", messageId: "in-retry" },
      } as any);
      await writer.onMessageSent({
        sessionKey: "sk",
        context: { channelId: "tg", content: "retry a", success: true, messageId: "out-retry" },
      } as any);
      await new Promise((resolve) => setTimeout(resolve, 90));

      expect(writeSpy).toHaveBeenCalledTimes(2);
      const restarted = new ChatTurnWriter({ client: mockClient, logger: mockLogger, stateDir });
      expect((restarted as any).w4bSessionCounts.get("openclaw:tg:::sk")).toBe(1);
      writeSpy.mockRestore();
      restarted.flushSync();
    });


    it("T98 - W4b durable retry upgrades an existing normal debounce flush", async () => {
      const sessionId = "openclaw:tg:::sk";
      (writer as any).saveWatermark(sessionId, 0);
      const commitSpy = vi.spyOn(writer as any, "commitWatermarkStateSync")
        .mockReturnValue(false);
      const writeSpy = vi.spyOn(writer as any, "writeWatermarkFile")
        .mockImplementationOnce(() => false);

      writer.onMessageReceived({
        sessionKey: "sk",
        context: { channelId: "tg", content: "pending retry q", messageId: "in-retry-pending" },
      } as any);
      await writer.onMessageSent({
        sessionKey: "sk",
        context: { channelId: "tg", content: "pending retry a", success: true, messageId: "out-retry-pending" },
      } as any);
      await new Promise((resolve) => setTimeout(resolve, 130));

      expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(1);
      expect(writeSpy).toHaveBeenCalledTimes(2);
      const restarted = new ChatTurnWriter({ client: mockClient, logger: mockLogger, stateDir });
      expect((restarted as any).cachedWatermarks.get(sessionId)).toBe(0);
      expect((restarted as any).w4bSessionCounts.get(sessionId)).toBe(1);
      commitSpy.mockRestore();
      writeSpy.mockRestore();
      restarted.flushSync();
    });
});
