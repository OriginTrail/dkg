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


    it("T359 - conversationless pending inbound does not promote into an unrelated concrete chat", async () => {
      const conversationlessSessionId = "openclaw:telegram:bot::real-sk";
      const concreteSessionId = "openclaw:telegram:bot:chat-concrete-B:real-sk";

      writer.onTypedMessageReceived(
        { from: "user-1", content: "chat A session-only q", metadata: { messageId: "session-only-in" } },
        { channelId: "telegram", accountId: "bot", sessionKey: "real-sk" },
      );
      writer.onAgentEnd({
        sessionId: "test",
        messages: [],
      }, { channelId: "telegram", accountId: "bot", conversationId: "chat-concrete-B", sessionKey: "real-sk" });
      await flushMicrotasks();
      await writer.onTypedMessageSent(
        { to: "user-1", content: "chat B reply must not use chat A user", success: true, metadata: { messageId: "chat-B-out" } },
        { channelId: "telegram", accountId: "bot", conversationId: "chat-concrete-B", sessionKey: "real-sk" },
      );
      await flushMicrotasks();

      expect(mockClient.storeChatTurn).not.toHaveBeenCalled();
      expect((writer as any).pendingUserMessages.get(conversationlessSessionId)).toEqual(["chat A session-only q"]);
      expect((writer as any).pendingUserMessages.has(concreteSessionId)).toBe(false);
    });


    it("T359 - typed endpoint-only events without session identity are dropped", async () => {
      writer.onTypedMessageReceived(
        { from: "user-1", content: "endpoint-only q" },
        { channelId: "telegram", accountId: "bot" },
      );
      await writer.onTypedMessageSent(
        { to: "user-1", content: "endpoint-only a", success: true },
        { channelId: "telegram", accountId: "bot" },
      );
      await flushMicrotasks();

      expect(mockClient.storeChatTurn).not.toHaveBeenCalled();
      expect((writer as any).pendingUserMessages.size).toBe(0);
    });


    it("T359 - conversationless marker does not suppress concrete W4a without conversation proof", async () => {
      writer.onTypedMessageReceived(
        { from: "user-1", content: "strong typed q", metadata: { messageId: "strong-in-1" } },
        { channelId: "telegram", accountId: "bot", sessionKey: "real-sk" },
      );
      await writer.onTypedMessageSent(
        { to: "user-1", content: "strong typed a", success: true },
        { channelId: "telegram", accountId: "bot", sessionKey: "real-sk" },
      );
      await flushMicrotasks();
      expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(1);

      const conversationlessSessionId = "openclaw:telegram:bot::real-sk";
      expect((writer as any).w4bSessionCounts.get(conversationlessSessionId)).toBe(1);

      const restarted = new ChatTurnWriter({ client: mockClient, logger: mockLogger, stateDir });
      mockClient.storeChatTurn.mockClear();
      restarted.onAgentEnd({
        sessionId: "test",
        messages: [
          { role: "user", content: "strong typed q", metadata: { messageId: "strong-in-1" } },
          { role: "assistant", content: "strong typed a" },
        ],
      }, { channelId: "telegram", accountId: "bot", conversationId: "chat-real", sessionKey: "real-sk" });
      await flushMicrotasks();

      const strongSessionId = "openclaw:telegram:bot:chat-real:real-sk";
      expect((restarted as any).w4bSessionCounts.has(strongSessionId)).toBe(false);
      expect((restarted as any).w4bSessionCounts.get(conversationlessSessionId)).toBe(1);
      expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(1);
      expect(mockClient.storeChatTurn.mock.calls[0][0]).toBe(strongSessionId);
      expect(mockClient.storeChatTurn.mock.calls[0][1]).toBe("strong typed q");
    });


    it("T359 - conversationless promotion does not move short TTL dedupe maps", async () => {
      const conversationlessSessionId = "openclaw:telegram:bot::real-sk";
      const strongSessionId = "openclaw:telegram:bot:chat-ttl:real-sk";
      const turnKey = "same-ttl-turn";
      const originKey = (writer as any).w4bOriginKey("ttl q", "ttl a");

      (writer as any).markTurnIdSeen(conversationlessSessionId, turnKey);
      (writer as any).markCrossPathStamp(conversationlessSessionId, originKey);
      (writer as any).markCrossPathInflight(conversationlessSessionId, originKey);

      writer.onAgentEnd({
        sessionId: "test",
        messages: [],
      }, { channelId: "telegram", accountId: "bot", conversationId: "chat-ttl", sessionKey: "real-sk" });
      await flushMicrotasks();

      expect((writer as any).peekTurnIdSeen(conversationlessSessionId, turnKey)).toBe(true);
      expect((writer as any).peekCrossPathStamp(conversationlessSessionId, originKey)).toBe(true);
      expect((writer as any).peekCrossPathInflight(conversationlessSessionId, originKey)).toBe(true);
      expect((writer as any).peekTurnIdSeen(strongSessionId, turnKey)).toBe(false);
      expect((writer as any).peekCrossPathStamp(strongSessionId, originKey)).toBe(false);
      expect((writer as any).peekCrossPathInflight(strongSessionId, originKey)).toBe(false);
    });


    it("T359 - repeated same-text typed replies without outbound messageIds do not dedupe distinct turns", async () => {
      writer.onTypedMessageReceived(
        { from: "user-1", content: "repeat q1", metadata: { messageId: "repeat-in-1" } },
        { channelId: "telegram", accountId: "bot", conversationId: "chat-repeat" },
      );
      await writer.onTypedMessageSent(
        { to: "user-1", content: "same answer", success: true },
        { channelId: "telegram", accountId: "bot", conversationId: "chat-repeat" },
      );
      writer.onTypedMessageReceived(
        { from: "user-1", content: "repeat q2", metadata: { messageId: "repeat-in-2" } },
        { channelId: "telegram", accountId: "bot", conversationId: "chat-repeat" },
      );
      await writer.onTypedMessageSent(
        { to: "user-1", content: "same answer", success: true },
        { channelId: "telegram", accountId: "bot", conversationId: "chat-repeat" },
      );
      await flushMicrotasks();

      expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(2);
      expect(mockClient.storeChatTurn.mock.calls[0][1]).toBe("repeat q1");
      expect(mockClient.storeChatTurn.mock.calls[1][1]).toBe("repeat q2");
      expect(mockClient.storeChatTurn.mock.calls[0][2]).toBe("same answer");
      expect(mockClient.storeChatTurn.mock.calls[1][2]).toBe("same answer");
    });


    it("T359 - repeated no-messageId typed user text persists as distinct turns", async () => {
      writer.onTypedMessageReceived(
        { from: "user-1", content: "ok" },
        { channelId: "telegram", accountId: "bot", conversationId: "chat-noid" },
      );
      await writer.onTypedMessageSent(
        { to: "user-1", content: "ack", success: true },
        { channelId: "telegram", accountId: "bot", conversationId: "chat-noid" },
      );
      writer.onTypedMessageReceived(
        { from: "user-1", content: "ok" },
        { channelId: "telegram", accountId: "bot", conversationId: "chat-noid" },
      );
      await writer.onTypedMessageSent(
        { to: "user-1", content: "ack", success: true },
        { channelId: "telegram", accountId: "bot", conversationId: "chat-noid" },
      );
      await flushMicrotasks();

      expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(2);
      expect(mockClient.storeChatTurn.mock.calls.map((call) => [call[1], call[2]])).toEqual([
        ["ok", "ack"],
        ["ok", "ack"],
      ]);
      expect(mockClient.storeChatTurn.mock.calls[0][3]?.turnId).not.toBe(
        mockClient.storeChatTurn.mock.calls[1][3]?.turnId,
      );
    });


    it("T359 - no-messageId duplicate inbound surfaces queue once", async () => {
      const ctx = { channelId: "telegram", accountId: "bot", conversationId: "chat-noid-dup" };
      writer.onTypedMessageReceived(
        { from: "user-1", content: "no id duplicate q" },
        ctx,
      );
      writer.onTypedMessageReceived(
        { from: "user-1", content: "no id duplicate q" },
        ctx,
      );
      await writer.onTypedMessageSent(
        { to: "user-1", content: "no id duplicate a", success: true },
        ctx,
      );
      await flushMicrotasks();

      expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(1);
      expect(mockClient.storeChatTurn.mock.calls[0][1]).toBe("no id duplicate q");
    });


    it("T359 - no-messageId repeated inbound text before reply is not collapsed", async () => {
      const ctx = { channelId: "telegram", accountId: "bot", conversationId: "chat-noid-repeat-before-reply" };
      writer.onTypedMessageReceived(
        { from: "user-1", content: "repeat before reply" },
        ctx,
      );
      await flushMicrotasks();
      writer.onTypedMessageReceived(
        { from: "user-1", content: "repeat before reply" },
        ctx,
      );
      await writer.onTypedMessageSent(
        { to: "user-1", content: "reply after repeats", success: true },
        ctx,
      );
      await flushMicrotasks();

      expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(1);
      expect(mockClient.storeChatTurn.mock.calls[0][1]).toBe("repeat before reply\nrepeat before reply");
    });


    it("T359 - late duplicate inbound messageId does not enqueue stale text after persist", async () => {
      const ctx = { channelId: "telegram", accountId: "bot", conversationId: "chat-late-dup", sessionKey: "sk" };
      writer.onTypedMessageReceived(
        { from: "user-1", content: "late duplicate q", metadata: { messageId: "late-dup-in" } },
        ctx,
      );
      await writer.onTypedMessageSent(
        { to: "user-1", content: "late duplicate a", success: true, metadata: { messageId: "late-dup-out" } },
        ctx,
      );
      await flushMicrotasks();

      writer.onTypedMessageReceived(
        { from: "user-1", content: "late duplicate q", metadata: { messageId: "late-dup-in" } },
        ctx,
      );
      await writer.onTypedMessageSent(
        { to: "user-1", content: "next outbound should not pair stale text", success: true, metadata: { messageId: "late-dup-out-2" } },
        ctx,
      );
      await flushMicrotasks();

      expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(1);
      expect(mockClient.storeChatTurn.mock.calls[0][1]).toBe("late duplicate q");
      expect(mockClient.storeChatTurn.mock.calls[0][2]).toBe("late duplicate a");
    });


    it("T359 - conversationless message-id dedupe is scoped by session key", async () => {
      writer.onTypedMessageReceived(
        { from: "user-1", content: "session A q", metadata: { messageId: "local-in-1" } },
        { channelId: "telegram", accountId: "bot", sessionKey: "sk-A" },
      );
      writer.onTypedMessageReceived(
        { from: "user-2", content: "session B q", metadata: { messageId: "local-in-1" } },
        { channelId: "telegram", accountId: "bot", sessionKey: "sk-B" },
      );
      await writer.onTypedMessageSent(
        { to: "user-1", content: "session A a", success: true },
        { channelId: "telegram", accountId: "bot", sessionKey: "sk-A" },
      );
      await writer.onTypedMessageSent(
        { to: "user-2", content: "session B a", success: true },
        { channelId: "telegram", accountId: "bot", sessionKey: "sk-B" },
      );
      await flushMicrotasks();

      expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(2);
      expect(mockClient.storeChatTurn.mock.calls.map((call) => call[0])).toEqual([
        "openclaw:telegram:bot::sk-A",
        "openclaw:telegram:bot::sk-B",
      ]);
      expect(mockClient.storeChatTurn.mock.calls.map((call) => call[1])).toEqual([
        "session A q",
        "session B q",
      ]);
    });


    it("T359 - outbound dedupe ignores session key once conversation identity is known", () => {
      const weakSession = (writer as any).weakSessionKey("telegram", "bot", "chat-dedup");
      const weakInboundKey = (writer as any).messageHookDedupKey(
        "outbound",
        {
          sessionKey: weakSession,
          context: {
            channelId: "telegram",
            accountId: "bot",
            conversationId: "chat-dedup",
            content: "dedup a",
          },
        },
        "dedup a",
        [{ messageId: "dedup-in" }],
        "dedup q",
      );
      const strongInboundKey = (writer as any).messageHookDedupKey(
        "outbound",
        {
          sessionKey: "real-sk",
          context: {
            channelId: "telegram",
            accountId: "bot",
            conversationId: "chat-dedup",
            content: "dedup a",
          },
        },
        "dedup a",
        [{ messageId: "dedup-in" }],
        "dedup q",
      );
      const weakArrivalKey = (writer as any).messageHookDedupKey(
        "outbound",
        {
          sessionKey: weakSession,
          context: {
            channelId: "telegram",
            accountId: "bot",
            conversationId: "chat-dedup",
            content: "dedup a",
          },
        },
        "dedup a",
        [{ arrivalId: "arrival::shared" }],
        "dedup q",
      );
      const strongArrivalKey = (writer as any).messageHookDedupKey(
        "outbound",
        {
          sessionKey: "real-sk",
          context: {
            channelId: "telegram",
            accountId: "bot",
            conversationId: "chat-dedup",
            content: "dedup a",
          },
        },
        "dedup a",
        [{ arrivalId: "arrival::shared" }],
        "dedup q",
      );

      expect(weakInboundKey).toBe(strongInboundKey);
      expect(weakArrivalKey).toBe(strongArrivalKey);
    });


    it("T359 - concrete reset clears synthetic weak typed session state", async () => {
      writer.onTypedMessageReceived(
        { from: "user-1", content: "stale weak q", metadata: { messageId: "stale-weak-in" } },
        { channelId: "telegram", accountId: "bot", conversationId: "chat-reset-weak" },
      );

      const weakSession = (writer as any).weakSessionKey("telegram", "bot", "chat-reset-weak");
      const weakSessionId = `openclaw:telegram:bot:chat-reset-weak:${weakSession}`;
      expect((writer as any).pendingUserMessages.get(weakSessionId)).toEqual(["stale weak q"]);

      await writer.onBeforeReset({}, {
        channelId: "telegram",
        accountId: "bot",
        conversationId: "chat-reset-weak",
        sessionKey: "real-sk",
      });

      expect((writer as any).pendingUserMessages.has(weakSessionId)).toBe(false);
      expect((writer as any).pendingUserMessageMeta.has(weakSessionId)).toBe(false);
    });


    it("T359 - reset clears only the affected session's message-hook dedupe", async () => {
      const eventA = {
        sessionKey: "sk-A",
        context: {
          channelId: "telegram",
          accountId: "bot",
          conversationId: "chat-A",
          content: "hello A",
          messageId: "in-A",
        },
      } as any;
      const eventB = {
        sessionKey: "sk-B",
        context: {
          channelId: "telegram",
          accountId: "bot",
          conversationId: "chat-B",
          content: "hello B",
          messageId: "in-B",
        },
      } as any;
      writer.onMessageReceived(eventA);
      writer.onMessageReceived(eventB);

      await writer.onBeforeReset({}, {
        channelId: "telegram",
        accountId: "bot",
        conversationId: "chat-B",
        sessionKey: "sk-B",
      });

      writer.onMessageReceived(eventA);
      writer.onMessageReceived(eventB);

      const pending = (writer as any).pendingUserMessages as Map<string, string[]>;
      expect(pending.get("openclaw:telegram:bot:chat-A:sk-A")).toEqual(["hello A"]);
      expect(pending.get("openclaw:telegram:bot:chat-B:sk-B")).toEqual(["hello B"]);
    });
});
