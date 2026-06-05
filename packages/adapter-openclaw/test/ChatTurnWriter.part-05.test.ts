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


    it("T380 - W4b preserves pasted Sender block after Conversation-only Telegram wrapper", async () => {
      const actualUserText = [pastedSenderMetadataBlock, "This Sender block is part of my message"].join("\n\n");
      writer.onMessageReceived({
        sessionKey: "key123",
        direction: "inbound",
        text: telegramWrappedUserText(actualUserText, { sender: false }),
        ...({ context: { channelId: "telegram" } } as any),
      } as any);
      await writer.onMessageSent({
        sessionKey: "key123",
        direction: "outbound",
        text: "response",
        ...({ context: { success: true, channelId: "telegram" } } as any),
      } as any);
      await flushMicrotasks();

      const [, persistedUser] = mockClient.storeChatTurn.mock.calls[0];
      expect(persistedUser).toBe(actualUserText);
      expect(persistedUser).toContain("Sender (untrusted metadata):");
      expect(persistedUser).toContain("user-pasted-sender-999");
    });


    it("T380 - W4b preserves standalone leading Sender block as user text", async () => {
      writer.onMessageReceived({
        sessionKey: "key123",
        direction: "inbound",
        text: pastedSenderMetadataBlock,
        ...({ context: { channelId: "telegram" } } as any),
      } as any);
      await writer.onMessageSent({
        sessionKey: "key123",
        direction: "outbound",
        text: "response",
        ...({ context: { success: true, channelId: "telegram" } } as any),
      } as any);
      await flushMicrotasks();

      const [, persistedUser] = mockClient.storeChatTurn.mock.calls[0];
      expect(persistedUser).toBe(pastedSenderMetadataBlock);
      expect(persistedUser).toContain("Sender (untrusted metadata):");
      expect(persistedUser).toContain("user-pasted-sender-999");
    });


    it("T380 - W4b preserves non-Telegram metadata labels after Telegram wrapper", async () => {
      const actualUserText = [channelContextMetadataBlock, "This block is part of my message"].join("\n");
      writer.onMessageReceived({
        sessionKey: "key123",
        direction: "inbound",
        text: telegramWrappedUserText(actualUserText),
        ...({ context: { channelId: "telegram" } } as any),
      } as any);
      await writer.onMessageSent({
        sessionKey: "key123",
        direction: "outbound",
        text: "response",
        ...({ context: { success: true, channelId: "telegram" } } as any),
      } as any);
      await flushMicrotasks();

      const [, persistedUser] = mockClient.storeChatTurn.mock.calls[0];
      expect(persistedUser).toBe(actualUserText);
      expect(persistedUser).toContain("Channel context (untrusted metadata):");
    });


    it("T380 - W4b strips each queued inbound before joining", async () => {
      writer.onMessageReceived({
        sessionKey: "key123",
        direction: "inbound",
        text: telegramWrappedUserText("first"),
        ...({ context: { channelId: "telegram", messageId: "in-1" } } as any),
      } as any);
      writer.onMessageReceived({
        sessionKey: "key123",
        direction: "inbound",
        text: telegramWrappedUserText("second"),
        ...({ context: { channelId: "telegram", messageId: "in-2" } } as any),
      } as any);
      await writer.onMessageSent({
        sessionKey: "key123",
        direction: "outbound",
        text: "response",
        ...({ context: { success: true, channelId: "telegram", messageId: "out-1" } } as any),
      } as any);
      await flushMicrotasks();

      const [, persistedUser] = mockClient.storeChatTurn.mock.calls[0];
      expect(persistedUser).toBe("first\nsecond");
    });


    it("T380 - typed Telegram W4b path strips leading metadata via normalization", async () => {
      writer.onTypedMessageReceived(
        {
          from: "user-1",
          content: telegramWrappedUserText("hello"),
          metadata: { chatId: "chat-1", messageId: "typed-in-1" },
        },
        { channelId: "telegram", accountId: "bot", conversationId: "chat-1" },
      );
      await writer.onTypedMessageSent(
        { to: "user-1", content: "typed response", success: true, metadata: { messageId: "typed-out-1" } },
        { channelId: "telegram", accountId: "bot", conversationId: "chat-1" },
      );

      const [, persistedUser] = mockClient.storeChatTurn.mock.calls[0];
      expect(persistedUser).toBe("hello");
    });


    it("T359 - typed message hooks persist one Telegram turn without internal sessionKey", async () => {
      writer.onTypedMessageReceived(
        { from: "user-1", content: "typed hello", metadata: { messageId: "typed-in-1" } },
        { channelId: "telegram", accountId: "bot", conversationId: "chat-1" },
      );
      await writer.onTypedMessageSent(
        { to: "user-1", content: "typed response", success: true },
        { channelId: "telegram", accountId: "bot", conversationId: "chat-1" },
      );
      await flushMicrotasks();

      expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(1);
      const weakSessionKey = (writer as any).weakSessionKey("telegram", "bot", "chat-1");
      expect(mockClient.storeChatTurn.mock.calls[0][0]).toBe(`openclaw:telegram:bot:chat-1:${weakSessionKey}`);
      expect(mockClient.storeChatTurn.mock.calls[0][1]).toBe("typed hello");
      expect(mockClient.storeChatTurn.mock.calls[0][2]).toBe("typed response");
    });


    it("T359 - empty typed outbound failure clears the pending inbound queue", async () => {
      writer.onTypedMessageReceived(
        { from: "user-1", content: "failed typed q", metadata: { messageId: "failed-typed-in" } },
        { channelId: "telegram", accountId: "bot", conversationId: "chat-failed-typed" },
      );
      await writer.onTypedMessageSent(
        { to: "user-1", success: false, metadata: { messageId: "failed-typed-out" } },
        { channelId: "telegram", accountId: "bot", conversationId: "chat-failed-typed" },
      );
      await flushMicrotasks();

      expect(mockClient.storeChatTurn).not.toHaveBeenCalled();
      expect((writer as any).pendingUserMessages.size).toBe(0);

      await writer.onTypedMessageSent(
        { to: "user-1", content: "later typed a", success: true, metadata: { messageId: "later-typed-out" } },
        { channelId: "telegram", accountId: "bot", conversationId: "chat-failed-typed" },
      );
      await flushMicrotasks();

      expect(mockClient.storeChatTurn).not.toHaveBeenCalled();
    });


    it("T359 - typed message hooks normalize numeric chat and thread ids", async () => {
      writer.onTypedMessageReceived(
        { from: "user-1", content: "numeric id hello", metadata: { chatId: 12345 } },
        { channelId: "telegram", accountId: "bot" },
      );
      await writer.onTypedMessageSent(
        { to: "user-1", content: "numeric id response", success: true, metadata: { threadId: 12345 } },
        { channelId: "telegram", accountId: "bot" },
      );
      await flushMicrotasks();

      expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(1);
      const weakSessionKey = (writer as any).weakSessionKey("telegram", "bot", "12345");
      expect(mockClient.storeChatTurn.mock.calls[0][0]).toBe(`openclaw:telegram:bot:12345:${weakSessionKey}`);
      expect(mockClient.storeChatTurn.mock.calls[0][1]).toBe("numeric id hello");
      expect(mockClient.storeChatTurn.mock.calls[0][2]).toBe("numeric id response");
    });


    it("T359 - Telegram topic fallback conversation includes chat and thread ids", async () => {
      writer.onTypedMessageReceived(
        { from: "user-1", content: "topic one q", metadata: { chatId: 12345, threadId: 111, messageId: "topic-1-in" } },
        { channelId: "telegram", accountId: "bot" },
      );
      writer.onTypedMessageReceived(
        { from: "user-2", content: "topic two q", metadata: { chatId: 12345, threadId: 222, messageId: "topic-2-in" } },
        { channelId: "telegram", accountId: "bot" },
      );
      await writer.onTypedMessageSent(
        { to: "user-1", content: "topic one a", success: true, metadata: { chatId: 12345, threadId: 111, messageId: "topic-1-out" } },
        { channelId: "telegram", accountId: "bot" },
      );
      await writer.onTypedMessageSent(
        { to: "user-2", content: "topic two a", success: true, metadata: { chatId: 12345, threadId: 222, messageId: "topic-2-out" } },
        { channelId: "telegram", accountId: "bot" },
      );
      await flushMicrotasks();

      expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(2);
      expect(mockClient.storeChatTurn.mock.calls.map((call) => [call[1], call[2]])).toEqual([
        ["topic one q", "topic one a"],
        ["topic two q", "topic two a"],
      ]);
      expect(mockClient.storeChatTurn.mock.calls[0][0]).toContain("12345%3A111");
      expect(mockClient.storeChatTurn.mock.calls[1][0]).toContain("12345%3A222");
    });


    it("T359 - Telegram topic fallback accepts snake_case chat and thread ids", async () => {
      writer.onTypedMessageReceived(
        { from: "user-1", content: "snake topic q", metadata: { chat_id: 12345, message_thread_id: 333, message_id: "snake-topic-in" } },
        { channelId: "telegram", accountId: "bot" },
      );
      await writer.onTypedMessageSent(
        { to: "user-1", content: "snake topic a", success: true, metadata: { chat_id: 12345, thread_id: 333, message_id: "snake-topic-out" } },
        { channelId: "telegram", accountId: "bot" },
      );
      await flushMicrotasks();

      expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(1);
      expect(mockClient.storeChatTurn.mock.calls[0][0]).toContain("12345%3A333");
      expect(mockClient.storeChatTurn.mock.calls[0][1]).toBe("snake topic q");
      expect(mockClient.storeChatTurn.mock.calls[0][2]).toBe("snake topic a");
    });


    it("T359 - typed message normalization accepts structured and ctx text content", async () => {
      writer.onTypedMessageReceived(
        { from: "user-1", content: [{ type: "text", text: "typed array hello" }] },
        { channelId: "telegram", accountId: "bot", conversationId: "chat-array", messageId: "array-in-1" },
      );
      await writer.onTypedMessageSent(
        { to: "user-1", success: true },
        { channelId: "telegram", accountId: "bot", conversationId: "chat-array", content: "typed ctx response" },
      );
      await flushMicrotasks();

      expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(1);
      expect(mockClient.storeChatTurn.mock.calls[0][1]).toBe("typed array hello");
      expect(mockClient.storeChatTurn.mock.calls[0][2]).toBe("typed ctx response");
    });


    it("T359 - typed message normalization preserves alternate provider id fields for replay markers", async () => {
      writer.onTypedMessageReceived(
        { from: "user-1", content: "alt id q", message_id: "alt-id-in" },
        { channelId: "telegram", accountId: "bot", conversationId: "chat-alt-id", sessionKey: "sk" },
      );
      await writer.onTypedMessageSent(
        { to: "user-1", content: "alt id a", success: true },
        { channelId: "telegram", accountId: "bot", conversationId: "chat-alt-id", sessionKey: "sk" },
      );
      await flushMicrotasks();

      const sessionId = "openclaw:telegram:bot:chat-alt-id:sk";
      expect((writer as any).w4bSessionCounts.get(sessionId)).toBe(1);

      const restarted = new ChatTurnWriter({ client: mockClient, logger: mockLogger, stateDir });
      await restarted.onBeforeCompaction({}, {
        channelId: "telegram",
        accountId: "bot",
        conversationId: "chat-alt-id",
        sessionKey: "sk",
      });

      mockClient.storeChatTurn.mockClear();
      restarted.onAgentEnd({
        sessionId: "test",
        messages: [
          { role: "user", content: "alt id q", metadata: { message_id: "alt-id-in" } },
          { role: "assistant", content: "alt id a" },
        ],
      }, { channelId: "telegram", accountId: "bot", conversationId: "chat-alt-id", sessionKey: "sk" });
      await flushMicrotasks();

      expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(0);
      expect((restarted as any).cachedWatermarks.get(sessionId)).toBe(0);
      restarted.flushSync();
    });


    it("T359 - typed hook bare id is not treated as a provider message id", async () => {
      const ctx = { channelId: "telegram", accountId: "bot", conversationId: "chat-bare-id", id: "chat-object-id" } as any;
      writer.onTypedMessageReceived(
        { from: "user-1", content: "bare id q1" },
        ctx,
      );
      writer.onTypedMessageReceived(
        { from: "user-1", content: "bare id q2" },
        ctx,
      );
      await writer.onTypedMessageSent(
        { to: "user-1", content: "bare id a", success: true },
        ctx,
      );
      await flushMicrotasks();

      expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(1);
      expect(mockClient.storeChatTurn.mock.calls[0][1]).toBe("bare id q1\nbare id q2");
    });


    it("T359 - transcript bare id does not consume typed W4b replay marker", async () => {
      writer.onTypedMessageReceived(
        { from: "user-1", content: "bare replay q", messageId: "bare-replay-in" },
        { channelId: "telegram", accountId: "bot", conversationId: "chat-bare-replay", sessionKey: "sk" },
      );
      await writer.onTypedMessageSent(
        { to: "user-1", content: "bare replay a", success: true },
        { channelId: "telegram", accountId: "bot", conversationId: "chat-bare-replay", sessionKey: "sk" },
      );
      await flushMicrotasks();

      const restarted = new ChatTurnWriter({ client: mockClient, logger: mockLogger, stateDir });
      await restarted.onBeforeCompaction({}, {
        channelId: "telegram",
        accountId: "bot",
        conversationId: "chat-bare-replay",
        sessionKey: "sk",
      });

      mockClient.storeChatTurn.mockClear();
      restarted.onAgentEnd({
        sessionId: "test",
        messages: [
          { role: "user", content: "bare replay q", id: "bare-replay-in" },
          { role: "assistant", content: "bare replay a" },
        ],
      }, { channelId: "telegram", accountId: "bot", conversationId: "chat-bare-replay", sessionKey: "sk" });
      await flushMicrotasks();

      expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(1);
      restarted.flushSync();
    });


    it("T359 - typed and internal W4b surfaces for the same Telegram message persist once", async () => {
      writer.onTypedMessageReceived(
        { from: "user-1", content: "same inbound", metadata: { messageId: "same-in-1" } },
        { channelId: "telegram", accountId: "bot", conversationId: "chat-1" },
      );
      writer.onMessageReceived({
        sessionKey: "internal-sk",
        context: {
          channelId: "telegram",
          accountId: "bot",
          conversationId: "chat-1",
          content: "same inbound",
          messageId: "same-in-1",
        },
      } as any);

      await writer.onTypedMessageSent(
        { to: "user-1", content: "same outbound", success: true },
        { channelId: "telegram", accountId: "bot", conversationId: "chat-1" },
      );
      await writer.onMessageSent({
        sessionKey: "internal-sk",
        context: {
          channelId: "telegram",
          accountId: "bot",
          conversationId: "chat-1",
          content: "same outbound",
          success: true,
          messageId: "same-out-1",
        },
      } as any);
      await flushMicrotasks();

      expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(1);
      expect(mockClient.storeChatTurn.mock.calls[0][1]).toBe("same inbound");
      expect((writer as any).pendingUserMessages.size).toBe(0);
    });
});
