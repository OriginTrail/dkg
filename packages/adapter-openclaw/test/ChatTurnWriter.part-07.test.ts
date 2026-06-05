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


    it("T359 - typed outbound pairs when only one side carries sessionId", async () => {
      writer.onTypedMessageReceived(
        { from: "user-1", content: "split strong inbound", metadata: { messageId: "split-strong-in" } },
        { channelId: "telegram", accountId: "bot", conversationId: "chat-split-strong", sessionId: "typed-session-a" },
      );
      await writer.onTypedMessageSent(
        { to: "user-1", content: "split weak outbound", success: true, metadata: { messageId: "split-weak-out" } },
        { channelId: "telegram", accountId: "bot", conversationId: "chat-split-strong" },
      );
      await flushMicrotasks();

      expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(1);
      expect(mockClient.storeChatTurn.mock.calls[0][1]).toBe("split strong inbound");
      expect(mockClient.storeChatTurn.mock.calls[0][2]).toBe("split weak outbound");

      mockClient.storeChatTurn.mockClear();
      writer.onTypedMessageReceived(
        { from: "user-1", content: "split weak inbound", metadata: { messageId: "split-weak-in" } },
        { channelId: "telegram", accountId: "bot", conversationId: "chat-split-weak" },
      );
      await writer.onTypedMessageSent(
        { to: "user-1", content: "split strong outbound", success: true, metadata: { messageId: "split-strong-out" } },
        { channelId: "telegram", accountId: "bot", conversationId: "chat-split-weak", sessionId: "typed-session-b" },
      );
      await flushMicrotasks();

      expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(1);
      expect(mockClient.storeChatTurn.mock.calls[0][1]).toBe("split weak inbound");
      expect(mockClient.storeChatTurn.mock.calls[0][2]).toBe("split strong outbound");
    });


    it("T359 - typed sessionId fallback inbound promotes to concrete outbound sessionKey", async () => {
      writer.onTypedMessageReceived(
        { from: "user-1", content: "fallback to concrete inbound", metadata: { messageId: "fallback-concrete-in" } },
        { channelId: "telegram", accountId: "bot", conversationId: "chat-fallback-concrete", sessionId: "typed-session-c" },
      );

      await writer.onMessageSent({
        sessionKey: "internal-sk",
        context: {
          channelId: "telegram",
          accountId: "bot",
          conversationId: "chat-fallback-concrete",
          content: "concrete outbound",
          success: true,
          messageId: "fallback-concrete-out",
        },
      } as any);
      await flushMicrotasks();

      expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(1);
      expect(mockClient.storeChatTurn.mock.calls[0][0]).toBe("openclaw:telegram:bot:chat-fallback-concrete:internal-sk");
      expect(mockClient.storeChatTurn.mock.calls[0][1]).toBe("fallback to concrete inbound");
      expect(mockClient.storeChatTurn.mock.calls[0][2]).toBe("concrete outbound");
    });


    it("T359 - weak inbound promotes to concrete outbound without session fallback marker", async () => {
      writer.onTypedMessageReceived(
        { from: "user-1", content: "weak only inbound", metadata: { messageId: "weak-only-in" } },
        { channelId: "telegram", accountId: "bot", conversationId: "chat-weak-concrete" },
      );

      await writer.onMessageSent({
        sessionKey: "internal-sk",
        context: {
          channelId: "telegram",
          accountId: "bot",
          conversationId: "chat-weak-concrete",
          content: "concrete answer",
          success: true,
          messageId: "weak-concrete-out",
        },
      } as any);
      await flushMicrotasks();

      expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(1);
      expect(mockClient.storeChatTurn.mock.calls[0][0]).toBe("openclaw:telegram:bot:chat-weak-concrete:internal-sk");
      expect(mockClient.storeChatTurn.mock.calls[0][1]).toBe("weak only inbound");
      expect(mockClient.storeChatTurn.mock.calls[0][2]).toBe("concrete answer");
    });


    it("T359 - concrete inbound promotes to weak outbound by conversation identity", async () => {
      writer.onMessageReceived({
        sessionKey: "internal-sk",
        context: {
          channelId: "telegram",
          accountId: "bot",
          conversationId: "chat-concrete-weak",
          content: "concrete only inbound",
          messageId: "concrete-weak-in",
        },
      } as any);

      await writer.onTypedMessageSent(
        { to: "user-1", content: "weak answer", success: true, metadata: { messageId: "concrete-weak-out" } },
        { channelId: "telegram", accountId: "bot", conversationId: "chat-concrete-weak" },
      );
      await flushMicrotasks();

      expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(1);
      expect(mockClient.storeChatTurn.mock.calls[0][0]).toContain("chat-concrete-weak");
      expect(mockClient.storeChatTurn.mock.calls[0][1]).toBe("concrete only inbound");
      expect(mockClient.storeChatTurn.mock.calls[0][2]).toBe("weak answer");
    });


    it("T359 - outbound promotion merges weak sibling into existing concrete queue", async () => {
      writer.onTypedMessageReceived(
        { from: "user-1", content: "older weak sibling", metadata: { messageId: "merge-weak-in" } },
        { channelId: "telegram", accountId: "bot", conversationId: "chat-merge-sibling" },
      );
      writer.onMessageReceived({
        sessionKey: "internal-sk",
        context: {
          channelId: "telegram",
          accountId: "bot",
          conversationId: "chat-merge-sibling",
          content: "newer concrete sibling",
          messageId: "merge-concrete-in",
        },
      } as any);

      await writer.onMessageSent({
        sessionKey: "internal-sk",
        context: {
          channelId: "telegram",
          accountId: "bot",
          conversationId: "chat-merge-sibling",
          content: "merged sibling answer",
          success: true,
          messageId: "merge-sibling-out",
        },
      } as any);
      await flushMicrotasks();

      expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(1);
      expect(mockClient.storeChatTurn.mock.calls[0][1]).toBe("older weak sibling\nnewer concrete sibling");
      expect(mockClient.storeChatTurn.mock.calls[0][2]).toBe("merged sibling answer");
    });


    it("T359 - queue promotion appends later weak duplicates after earlier strong messages", async () => {
      writer.onTypedMessageReceived(
        { from: "user-1", content: "first strong inbound", metadata: { messageId: "order-strong-first" } },
        { channelId: "telegram", accountId: "bot", conversationId: "chat-order-append", sessionKey: "real-sk" },
      );
      writer.onTypedMessageReceived(
        { from: "user-1", content: "later weak inbound", metadata: { messageId: "order-weak-later" } },
        { channelId: "telegram", accountId: "bot", conversationId: "chat-order-append" },
      );
      writer.onTypedMessageReceived(
        { from: "user-1", content: "later weak inbound", metadata: { messageId: "order-weak-later" } },
        { channelId: "telegram", accountId: "bot", conversationId: "chat-order-append", sessionKey: "real-sk" },
      );

      await writer.onTypedMessageSent(
        { to: "user-1", content: "ordered append answer", success: true, metadata: { messageId: "order-append-out" } },
        { channelId: "telegram", accountId: "bot", conversationId: "chat-order-append", sessionKey: "real-sk" },
      );
      await flushMicrotasks();

      expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(1);
      expect(mockClient.storeChatTurn.mock.calls[0][1]).toBe("first strong inbound\nlater weak inbound");
    });


    it("T359 - conversation-scoped in-flight markers do not suppress another chat with reused messageId", async () => {
      let releaseFirst: (() => void) | null = null;
      let storeCalls = 0;
      mockClient.storeChatTurn = vi.fn().mockImplementation(async () => {
        storeCalls++;
        if (storeCalls === 1) {
          await new Promise<void>((resolve) => { releaseFirst = resolve; });
        }
      });
      writer = new ChatTurnWriter({ client: mockClient, logger: mockLogger, stateDir });

      writer.onTypedMessageReceived(
        { from: "user-1", content: "same local text", metadata: { messageId: "local-1" } },
        { channelId: "telegram", accountId: "bot", conversationId: "chat-A" },
      );
      await writer.onTypedMessageSent(
        { to: "user-1", content: "same local reply", success: true },
        { channelId: "telegram", accountId: "bot", conversationId: "chat-A" },
      );
      await flushMicrotasks();
      expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(1);

      writer.onAgentEnd({
        sessionId: "test",
        messages: [
          { role: "user", content: "same local text", metadata: { messageId: "local-1" } },
          { role: "assistant", content: "same local reply" },
        ],
      }, { channelId: "telegram", accountId: "bot", conversationId: "chat-B", sessionKey: "real-sk" });
      await flushMicrotasks();

      expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(2);
      expect(mockClient.storeChatTurn.mock.calls[1][0]).toBe("openclaw:telegram:bot:chat-B:real-sk");

      releaseFirst!();
      await writer.flush();
    });


    it("T359 - in-flight conversationless W4b completion stays isolated from concrete W4a", async () => {
      let releaseStore: (() => void) | null = null;
      let storeCalls = 0;
      mockClient.storeChatTurn = vi.fn().mockImplementation(async () => {
        storeCalls++;
        if (storeCalls === 1) {
          await new Promise<void>((resolve) => { releaseStore = resolve; });
        }
      });
      writer = new ChatTurnWriter({ client: mockClient, logger: mockLogger, stateDir });

      writer.onTypedMessageReceived(
        { from: "user-1", content: "late weak q", metadata: { messageId: "late-weak-in" } },
        { channelId: "telegram", accountId: "bot", sessionKey: "real-sk" },
      );
      await writer.onTypedMessageSent(
        { to: "user-1", content: "late weak a", success: true },
        { channelId: "telegram", accountId: "bot", sessionKey: "real-sk" },
      );
      await flushMicrotasks();
      expect(storeCalls).toBe(1);

      const weakSessionId = "openclaw:telegram:bot::real-sk";
      const strongSessionId = "openclaw:telegram:bot:chat-late:real-sk";
      expect((writer as any).inFlightPersists.has(weakSessionId)).toBe(true);

      writer.onAgentEnd({
        sessionId: "test",
        messages: [
          { role: "user", content: "late weak q", metadata: { messageId: "late-weak-in" } },
          { role: "assistant", content: "late weak a" },
        ],
      }, { channelId: "telegram", accountId: "bot", conversationId: "chat-late", sessionKey: "real-sk" });
      await flushMicrotasks();

      expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(2);
      expect(mockClient.storeChatTurn.mock.calls[1][0]).toBe(strongSessionId);
      expect((writer as any).inFlightPersists.has(weakSessionId)).toBe(true);
      expect((writer as any).inFlightPersists.has(strongSessionId)).toBe(false);

      releaseStore!();
      await writer.flush();

      expect((writer as any).w4bSessionCounts.has(strongSessionId)).toBe(false);
      expect((writer as any).w4bSessionCounts.get(weakSessionId)).toBe(1);
      expect((writer as any).inFlightPersists.has(strongSessionId)).toBe(false);
      expect((writer as any).crossPathInflight.size).toBe(0);

      await writer.onBeforeReset({}, {
        channelId: "telegram",
        accountId: "bot",
        conversationId: "chat-late",
        sessionKey: "real-sk",
      });
      expect((writer as any).w4bSessionCounts.get(weakSessionId)).toBe(1);
    });


    it("T359 - weak conversation W4b in-flight suppresses real-session W4a duplicate", async () => {
      let releaseStore: (() => void) | null = null;
      let storeCalls = 0;
      mockClient.storeChatTurn = vi.fn().mockImplementation(async () => {
        storeCalls++;
        await new Promise<void>((resolve) => { releaseStore = resolve; });
      });
      writer = new ChatTurnWriter({ client: mockClient, logger: mockLogger, stateDir });

      writer.onTypedMessageReceived(
        { from: "user-1", content: "weak inflight q", metadata: { messageId: "weak-inflight-in" } },
        { channelId: "telegram", accountId: "bot", conversationId: "chat-weak-inflight" },
      );
      await writer.onTypedMessageSent(
        { to: "user-1", content: "weak inflight a", success: true },
        { channelId: "telegram", accountId: "bot", conversationId: "chat-weak-inflight" },
      );
      await flushMicrotasks();
      expect(storeCalls).toBe(1);

      writer.onAgentEnd({
        sessionId: "test",
        messages: [
          { role: "user", content: "weak inflight q" },
          { role: "assistant", content: "weak inflight a" },
        ],
      }, { channelId: "telegram", accountId: "bot", conversationId: "chat-weak-inflight", sessionKey: "real-sk" });
      await flushMicrotasks();

      expect(storeCalls).toBe(1);
      const weakSessionKey = (writer as any).weakSessionKey("telegram", "bot", "chat-weak-inflight");
      const weakSessionId = `openclaw:telegram:bot:chat-weak-inflight:${encodeURIComponent(weakSessionKey)}`;
      const strongSessionId = "openclaw:telegram:bot:chat-weak-inflight:real-sk";
      expect((writer as any).inFlightPersists.has(weakSessionId)).toBe(true);
      expect((writer as any).inFlightPersists.has(strongSessionId)).toBe(false);

      releaseStore!();
      await writer.flush();

      expect(storeCalls).toBe(1);
      expect((writer as any).w4bSessionCounts.get(weakSessionId)).toBe(1);
      expect((writer as any).w4bSessionCounts.has(strongSessionId)).toBe(false);
    });


    it("T359 - conversationless promotion does not become a standing alias", async () => {
      let releaseStore: (() => void) | null = null;
      let storeCalls = 0;
      mockClient.storeChatTurn = vi.fn().mockImplementation(async () => {
        storeCalls++;
        if (storeCalls === 1) {
          await new Promise<void>((resolve) => { releaseStore = resolve; });
        }
      });
      writer = new ChatTurnWriter({ client: mockClient, logger: mockLogger, stateDir });

      writer.onTypedMessageReceived(
        { from: "user-1", content: "alias first q", metadata: { messageId: "alias-first-in" } },
        { channelId: "telegram", accountId: "bot", sessionKey: "real-sk" },
      );
      await writer.onTypedMessageSent(
        { to: "user-1", content: "alias first a", success: true },
        { channelId: "telegram", accountId: "bot", sessionKey: "real-sk" },
      );
      await flushMicrotasks();

      const conversationlessSessionId = "openclaw:telegram:bot::real-sk";
      const strongSessionId = "openclaw:telegram:bot:chat-alias-A:real-sk";
      expect((writer as any).inFlightPersists.has(conversationlessSessionId)).toBe(true);

      writer.onAgentEnd({
        sessionId: "test",
        messages: [
          { role: "user", content: "alias first q", metadata: { messageId: "alias-first-in" } },
          { role: "assistant", content: "alias first a" },
        ],
      }, { channelId: "telegram", accountId: "bot", conversationId: "chat-alias-A", sessionKey: "real-sk" });
      await flushMicrotasks();
      expect((writer as any).inFlightPersists.has(conversationlessSessionId)).toBe(true);
      expect((writer as any).inFlightPersists.has(strongSessionId)).toBe(false);

      releaseStore!();
      await writer.flush();
      expect((writer as any).w4bSessionCounts.has(strongSessionId)).toBe(false);
      expect((writer as any).w4bSessionCounts.get(conversationlessSessionId)).toBe(1);

      mockClient.storeChatTurn.mockClear();
      writer.onTypedMessageReceived(
        { from: "user-1", content: "alias second q", metadata: { messageId: "alias-second-in" } },
        { channelId: "telegram", accountId: "bot", sessionKey: "real-sk" },
      );
      await writer.onTypedMessageSent(
        { to: "user-1", content: "alias second a", success: true },
        { channelId: "telegram", accountId: "bot", sessionKey: "real-sk" },
      );
      await writer.flush();

      expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(1);
      expect(mockClient.storeChatTurn.mock.calls[0][0]).toBe(conversationlessSessionId);
      expect((writer as any).w4bSessionCounts.get(conversationlessSessionId)).toBe(2);
      expect((writer as any).w4bSessionCounts.has(strongSessionId)).toBe(false);
    });
});
