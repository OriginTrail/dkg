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


    it("T359 - same-message strong identity change moves the pending inbound queue", async () => {
      writer.onTypedMessageReceived(
        { from: "user-1", content: "strong move inbound", metadata: { messageId: "same-strong-in" } },
        { channelId: "telegram", accountId: "bot", conversationId: "chat-strong-move", sessionId: "typed-session" },
      );
      writer.onMessageReceived({
        sessionKey: "internal-session",
        context: {
          channelId: "telegram",
          accountId: "bot",
          conversationId: "chat-strong-move",
          content: "strong move inbound",
          messageId: "same-strong-in",
        },
      } as any);

      await writer.onMessageSent({
        sessionKey: "internal-session",
        context: {
          channelId: "telegram",
          accountId: "bot",
          conversationId: "chat-strong-move",
          content: "strong move outbound",
          success: true,
          messageId: "same-strong-out",
        },
      } as any);
      await flushMicrotasks();

      expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(1);
      expect(mockClient.storeChatTurn.mock.calls[0][0]).toBe("openclaw:telegram:bot:chat-strong-move:internal-session");
      expect(mockClient.storeChatTurn.mock.calls[0][1]).toBe("strong move inbound");
      expect(mockClient.storeChatTurn.mock.calls[0][2]).toBe("strong move outbound");
    });


    it("T359 - internal-first duplicate typed inbound still persists once when weak outbound arrives first", async () => {
      writer.onMessageReceived({
        sessionKey: "internal-sk",
        context: {
          channelId: "telegram",
          accountId: "bot",
          conversationId: "chat-1",
          content: "internal first",
          messageId: "same-in-2",
        },
      } as any);
      writer.onTypedMessageReceived(
        { from: "user-1", content: "internal first", metadata: { messageId: "same-in-2" } },
        { channelId: "telegram", accountId: "bot", conversationId: "chat-1" },
      );

      await writer.onTypedMessageSent(
        { to: "user-1", content: "typed duplicate outbound", success: true },
        { channelId: "telegram", accountId: "bot", conversationId: "chat-1" },
      );
      await writer.onMessageSent({
        sessionKey: "internal-sk",
        context: {
          channelId: "telegram",
          accountId: "bot",
          conversationId: "chat-1",
          content: "internal outbound",
          success: true,
          messageId: "same-out-2",
        },
      } as any);
      await flushMicrotasks();

      expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(1);
      expect(mockClient.storeChatTurn.mock.calls[0][0]).toContain("chat-1");
      expect(mockClient.storeChatTurn.mock.calls[0][1]).toBe("internal first");
      expect(mockClient.storeChatTurn.mock.calls[0][2]).toBe("typed duplicate outbound");
    });


    it("T359 - no-session typed Telegram identities stay isolated by conversation", async () => {
      writer.onTypedMessageReceived(
        { from: "user-A", content: "question A", metadata: { messageId: "typed-A-in" } },
        { channelId: "telegram", accountId: "bot", conversationId: "chat-A" },
      );
      await writer.onTypedMessageSent(
        { to: "user-A", content: "answer A", success: true },
        { channelId: "telegram", accountId: "bot", conversationId: "chat-A" },
      );
      writer.onTypedMessageReceived(
        { from: "user-B", content: "question B", metadata: { messageId: "typed-B-in" } },
        { channelId: "telegram", accountId: "bot", conversationId: "chat-B" },
      );
      await writer.onTypedMessageSent(
        { to: "user-B", content: "answer B", success: true },
        { channelId: "telegram", accountId: "bot", conversationId: "chat-B" },
      );
      await flushMicrotasks();

      expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(2);
      const weakSessionA = (writer as any).weakSessionKey("telegram", "bot", "chat-A");
      const weakSessionB = (writer as any).weakSessionKey("telegram", "bot", "chat-B");
      expect(mockClient.storeChatTurn.mock.calls.map((call) => call[0])).toEqual([
        `openclaw:telegram:bot:chat-A:${weakSessionA}`,
        `openclaw:telegram:bot:chat-B:${weakSessionB}`,
      ]);
    });


    it("T359 - weak typed session counts do not auto-promote to an unrelated real session", async () => {
      writer.onTypedMessageReceived(
        { from: "user-1", content: "weak typed q", metadata: { messageId: "weak-in-1" } },
        { channelId: "telegram", accountId: "bot", conversationId: "chat-weak" },
      );
      await writer.onTypedMessageSent(
        { to: "user-1", content: "weak typed a", success: true },
        { channelId: "telegram", accountId: "bot", conversationId: "chat-weak" },
      );
      await flushMicrotasks();
      expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(1);

      const weakSessionKey = (writer as any).weakSessionKey("telegram", "bot", "chat-weak");
      const weakSessionId = `openclaw:telegram:bot:chat-weak:${weakSessionKey}`;
      expect((writer as any).w4bSessionCounts.get(weakSessionId)).toBe(1);

      const restarted = new ChatTurnWriter({ client: mockClient, logger: mockLogger, stateDir });
      mockClient.storeChatTurn.mockClear();
      restarted.onAgentEnd({
        sessionId: "test",
        messages: [
          { role: "user", content: "fresh real-session q" },
          { role: "assistant", content: "fresh real-session a" },
        ],
      }, { channelId: "telegram", accountId: "bot", conversationId: "chat-weak", sessionKey: "agent:alternate:real" });
      await flushMicrotasks();

      const strongSessionId = "openclaw:telegram:bot:chat-weak:agent%3Aalternate%3Areal";
      expect((restarted as any).w4bSessionCounts.has(strongSessionId)).toBe(false);
      expect((restarted as any).w4bSessionCounts.get(weakSessionId)).toBe(1);
      expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(1);
      expect(mockClient.storeChatTurn.mock.calls[0][0]).toBe(strongSessionId);
      expect(mockClient.storeChatTurn.mock.calls[0][1]).toBe("fresh real-session q");
      restarted.flushSync();
    });


    it("T359 - weak typed persist marker suppresses later real-session W4a duplicate", async () => {
      writer.onTypedMessageReceived(
        { from: "user-1", content: "weak marker q", metadata: { messageId: "weak-marker-in" } },
        { channelId: "telegram", accountId: "bot", conversationId: "chat-weak-marker" },
      );
      await writer.onTypedMessageSent(
        { to: "user-1", content: "weak marker a", success: true },
        { channelId: "telegram", accountId: "bot", conversationId: "chat-weak-marker" },
      );
      await flushMicrotasks();
      expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(1);

      const weakSessionKey = (writer as any).weakSessionKey("telegram", "bot", "chat-weak-marker");
      const weakSessionId = `openclaw:telegram:bot:chat-weak-marker:${weakSessionKey}`;
      expect((writer as any).w4bSessionCounts.get(weakSessionId)).toBe(1);

      const restarted = new ChatTurnWriter({ client: mockClient, logger: mockLogger, stateDir });
      mockClient.storeChatTurn.mockClear();
      restarted.onAgentEnd({
        sessionId: "test",
        messages: [
          { role: "user", content: "weak marker q", metadata: { messageId: "weak-marker-in" } },
          { role: "assistant", content: "weak marker a" },
        ],
      }, { channelId: "telegram", accountId: "bot", conversationId: "chat-weak-marker", sessionKey: "agent:main:real" });
      await flushMicrotasks();

      const strongSessionId = "openclaw:telegram:bot:chat-weak-marker:agent%3Amain%3Areal";
      expect((restarted as any).w4bSessionCounts.has(strongSessionId)).toBe(false);
      expect((restarted as any).w4bSessionCounts.get(weakSessionId)).toBe(1);
      expect((restarted as any).cachedWatermarks.get(strongSessionId)).toBe(0);
      expect(mockClient.storeChatTurn).not.toHaveBeenCalled();
      restarted.flushSync();
    });


    it("T359 - strong typed W4b marker writes weak conversation cursor for session rotation", async () => {
      writer.onTypedMessageReceived(
        { from: "user-1", content: "rotated marker q", metadata: { messageId: "rotated-marker-in" } },
        { channelId: "telegram", accountId: "bot", conversationId: "chat-rotated-marker", sessionKey: "agent:a" },
      );
      await writer.onTypedMessageSent(
        { to: "user-1", content: "rotated marker a", success: true },
        { channelId: "telegram", accountId: "bot", conversationId: "chat-rotated-marker", sessionKey: "agent:a" },
      );
      await flushMicrotasks();
      expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(1);

      const restarted = new ChatTurnWriter({ client: mockClient, logger: mockLogger, stateDir });
      mockClient.storeChatTurn.mockClear();
      restarted.onAgentEnd({
        sessionId: "test",
        messages: [
          { role: "user", content: "rotated marker q", metadata: { messageId: "rotated-marker-in" } },
          { role: "assistant", content: "rotated marker a" },
        ],
      }, { channelId: "telegram", accountId: "bot", conversationId: "chat-rotated-marker", sessionKey: "agent:b" });
      await flushMicrotasks();

      expect(mockClient.storeChatTurn).not.toHaveBeenCalled();
      restarted.flushSync();
    });


    it("T359 - per-message weak marker skips only the matching repeated occurrence", async () => {
      writer.onTypedMessageReceived(
        { from: "user-1", content: "repeat marker q", metadata: { messageId: "repeat-target-in" } },
        { channelId: "telegram", accountId: "bot", conversationId: "chat-repeat-marker" },
      );
      await writer.onTypedMessageSent(
        { to: "user-1", content: "repeat marker a", success: true },
        { channelId: "telegram", accountId: "bot", conversationId: "chat-repeat-marker" },
      );
      await flushMicrotasks();
      expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(1);

      const restarted = new ChatTurnWriter({ client: mockClient, logger: mockLogger, stateDir });
      mockClient.storeChatTurn.mockClear();
      // T362 — Seed the restarted writer past cold-start; the clamp would
      // otherwise discard both historical pairs of identical content
      // before the marker check runs. This test specifically verifies
      // that markers distinguish two same-content pairs by messageId
      // (in-session marker behavior, not cold-start replay).
      restarted.onAgentEnd({
        sessionId: "seed",
        messages: [
          { role: "user", content: "__seed__" },
          { role: "assistant", content: "__seed__reply__" },
        ],
      }, { channelId: "telegram", accountId: "bot", conversationId: "chat-repeat-marker", sessionKey: "agent:main:real" });
      await flushMicrotasks();
      mockClient.storeChatTurn.mockClear();

      restarted.onAgentEnd({
        sessionId: "test",
        messages: [
          { role: "user", content: "__seed__" },              // saved
          { role: "assistant", content: "__seed__reply__" },
          { role: "user", content: "repeat marker q", metadata: { messageId: "repeat-older-in" } },
          { role: "assistant", content: "repeat marker a" },
          { role: "user", content: "repeat marker q", metadata: { messageId: "repeat-target-in" } },
          { role: "assistant", content: "repeat marker a" },
        ],
      }, { channelId: "telegram", accountId: "bot", conversationId: "chat-repeat-marker", sessionKey: "agent:main:real" });
      await flushMicrotasks();

      const strongSessionId = "openclaw:telegram:bot:chat-repeat-marker:agent%3Amain%3Areal";
      const olderTurnId = (restarted as any).deterministicTurnId(
        strongSessionId,
        "repeat marker q",
        "repeat marker a",
        1,
      );
      const targetTurnId = (restarted as any).deterministicTurnId(
        strongSessionId,
        "repeat marker q",
        "repeat marker a",
        2,
      );
      expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(1);
      expect(mockClient.storeChatTurn.mock.calls[0][3]?.turnId).toBe(olderTurnId);
      expect(mockClient.storeChatTurn.mock.calls[0][3]?.turnId).not.toBe(targetTurnId);
      expect((restarted as any).cachedWatermarks.get(strongSessionId)).toBe(2);
      restarted.flushSync();
    });


    it("T359 - same-message queue promotion preserves inbound arrival order", async () => {
      writer.onTypedMessageReceived(
        { from: "user-1", content: "older weak inbound", metadata: { messageId: "order-old" } },
        { channelId: "telegram", accountId: "bot", conversationId: "chat-order" },
      );
      writer.onMessageReceived({
        sessionKey: "real-sk",
        context: {
          channelId: "telegram",
          accountId: "bot",
          conversationId: "chat-order",
          content: "later strong inbound",
          messageId: "order-later",
        },
      } as any);
      writer.onMessageReceived({
        sessionKey: "real-sk",
        context: {
          channelId: "telegram",
          accountId: "bot",
          conversationId: "chat-order",
          content: "older weak inbound",
          messageId: "order-old",
        },
      } as any);

      await writer.onMessageSent({
        sessionKey: "real-sk",
        context: {
          channelId: "telegram",
          accountId: "bot",
          conversationId: "chat-order",
          content: "ordered answer",
          success: true,
          messageId: "order-out",
        },
      } as any);
      await flushMicrotasks();

      expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(1);
      expect(mockClient.storeChatTurn.mock.calls[0][0]).toBe("openclaw:telegram:bot:chat-order:real-sk");
      expect(mockClient.storeChatTurn.mock.calls[0][1]).toBe("older weak inbound\nlater strong inbound");
    });


    it("T359 - queue promotion rebinds all inbound dedupe keys for failed-send redelivery", async () => {
      writer.onTypedMessageReceived(
        { from: "user-1", content: "move all first", metadata: { messageId: "move-all-1" } },
        { channelId: "telegram", accountId: "bot", conversationId: "chat-move-all" },
      );
      writer.onTypedMessageReceived(
        { from: "user-1", content: "move all second", metadata: { messageId: "move-all-2" } },
        { channelId: "telegram", accountId: "bot", conversationId: "chat-move-all" },
      );
      writer.onMessageReceived({
        sessionKey: "real-sk",
        context: {
          channelId: "telegram",
          accountId: "bot",
          conversationId: "chat-move-all",
          content: "move all second",
          messageId: "move-all-2",
        },
      } as any);

      await writer.onMessageSent({
        sessionKey: "real-sk",
        context: {
          channelId: "telegram",
          accountId: "bot",
          conversationId: "chat-move-all",
          content: "failed move all",
          success: false,
          messageId: "move-all-failed",
        },
      } as any);
      await flushMicrotasks();

      writer.onMessageReceived({
        sessionKey: "real-sk",
        context: {
          channelId: "telegram",
          accountId: "bot",
          conversationId: "chat-move-all",
          content: "move all first",
          messageId: "move-all-1",
        },
      } as any);
      await writer.onMessageSent({
        sessionKey: "real-sk",
        context: {
          channelId: "telegram",
          accountId: "bot",
          conversationId: "chat-move-all",
          content: "redelivered move all",
          success: true,
          messageId: "move-all-out",
        },
      } as any);
      await flushMicrotasks();

      expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(1);
      expect(mockClient.storeChatTurn.mock.calls[0][1]).toBe("move all first");
      expect(mockClient.storeChatTurn.mock.calls[0][2]).toBe("redelivered move all");
    });
});
