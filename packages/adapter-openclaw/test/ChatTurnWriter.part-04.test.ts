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


    it("T380 - W4a strips leading Conversation info-only metadata", async () => {
      const event: AgentEndContext = {
        sessionId: "test",
        messages: [
          { role: "user", content: telegramWrappedUserText("hello", { sender: false }) },
          { role: "assistant", content: "reply" },
        ],
      };

      writer.onAgentEnd(event, { channelId: "telegram", sessionKey: "sk" });
      await flushMicrotasks();

      const [, persistedUser] = mockClient.storeChatTurn.mock.calls[0];
      expect(persistedUser).toBe("hello");
    });


    it("T380 - W4a leaves pure user text unchanged", async () => {
      const pureUserText = "  plain user text without channel metadata";
      const event: AgentEndContext = {
        sessionId: "test",
        messages: [
          { role: "user", content: pureUserText },
          { role: "assistant", content: "reply" },
        ],
      };

      writer.onAgentEnd(event, { channelId: "telegram", sessionKey: "sk" });
      await flushMicrotasks();

      const [, persistedUser] = mockClient.storeChatTurn.mock.calls[0];
      expect(persistedUser).toBe(pureUserText);
    });


    it("T380 - W4a preserves multi-line user text after leading metadata blocks", async () => {
      const actualUserText = "hello\nline two\n\nline four";
      const event: AgentEndContext = {
        sessionId: "test",
        messages: [
          { role: "user", content: telegramWrappedUserText(actualUserText) },
          { role: "assistant", content: "reply" },
        ],
      };

      writer.onAgentEnd(event, { channelId: "telegram", sessionKey: "sk" });
      await flushMicrotasks();

      const [, persistedUser] = mockClient.storeChatTurn.mock.calls[0];
      expect(persistedUser).toBe(actualUserText);
    });


    it("T380 - W4a preserves indentation on the first user line after metadata blocks", async () => {
      const actualUserText = "  const answer = 42;\n  return answer;";
      const event: AgentEndContext = {
        sessionId: "test",
        messages: [
          { role: "user", content: telegramWrappedUserText(actualUserText) },
          { role: "assistant", content: "reply" },
        ],
      };

      writer.onAgentEnd(event, { channelId: "telegram", sessionKey: "sk" });
      await flushMicrotasks();

      const [, persistedUser] = mockClient.storeChatTurn.mock.calls[0];
      expect(persistedUser).toBe(actualUserText);
    });


    it("T380 - W4a preserves metadata-shaped text pasted in the middle", async () => {
      const pastedMetadata = [
        "Please inspect this payload:",
        conversationInfoMetadataBlock,
        "The block above is part of my message.",
      ].join("\n");
      const event: AgentEndContext = {
        sessionId: "test",
        messages: [
          { role: "user", content: pastedMetadata },
          { role: "assistant", content: "reply" },
        ],
      };

      writer.onAgentEnd(event, { channelId: "telegram", sessionKey: "sk" });
      await flushMicrotasks();

      const [, persistedUser] = mockClient.storeChatTurn.mock.calls[0];
      expect(persistedUser).toBe(pastedMetadata);
      expect(persistedUser).toContain("Conversation info (untrusted metadata):");
    });


    it("T380 - W4a preserves leading metadata-shaped text outside Telegram context", async () => {
      const pastedMetadata = telegramWrappedUserText("This block is part of my message");
      const event: AgentEndContext = {
        sessionId: "test",
        messages: [
          { role: "user", content: pastedMetadata },
          { role: "assistant", content: "reply" },
        ],
      };

      writer.onAgentEnd(event, { channelId: "discord", sessionKey: "sk" });
      await flushMicrotasks();

      const [, persistedUser] = mockClient.storeChatTurn.mock.calls[0];
      expect(persistedUser).toBe(pastedMetadata);
      expect(persistedUser).toContain("Conversation info (untrusted metadata):");
    });


    it("T380 - W4a preserves direct-channel backfill text before marker lookup in Telegram context", async () => {
      const directUserText = telegramWrappedUserText("This metadata-shaped block belongs to DKG UI text");
      await writer.markExternalTurnPersistedDurable({
        sessionKey: "agent:main:main",
        turnId: "node-ui-corr-metadata-shaped",
        user: directUserText,
        assistant: "node ui answer",
      });
      mockClient.storeChatTurn.mockClear();

      writer.onAgentEnd({
        sessionId: "test",
        messages: [
          {
            role: "user",
            content: directUserText,
            context: { Provider: "dkg-ui", DkgTurnId: "node-ui-corr-metadata-shaped" },
          },
          { role: "assistant", content: "node ui answer" },
          { role: "user", content: telegramWrappedUserText("live telegram question") },
          { role: "assistant", content: "telegram answer" },
        ],
      }, { channelId: "telegram", sessionKey: "agent:main:main" });
      await flushMicrotasks();

      expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(1);
      const [, persistedUser] = mockClient.storeChatTurn.mock.calls[0];
      expect(persistedUser).toBe("live telegram question");
    });


    it("T380 - W4a preserves leading metadata-shaped user text after Telegram wrapper", async () => {
      const actualUserText = [conversationInfoMetadataBlock, "This block is part of my message"].join("\n");
      const event: AgentEndContext = {
        sessionId: "test",
        messages: [
          { role: "user", content: telegramWrappedUserText(actualUserText) },
          { role: "assistant", content: "reply" },
        ],
      };

      writer.onAgentEnd(event, { channelId: "telegram", sessionKey: "sk" });
      await flushMicrotasks();

      const [, persistedUser] = mockClient.storeChatTurn.mock.calls[0];
      expect(persistedUser).toBe(actualUserText);
      expect(persistedUser).toContain("Conversation info (untrusted metadata):");
    });


    it("T380 - W4a preserves pasted Sender block after Conversation-only Telegram wrapper", async () => {
      const actualUserText = [pastedSenderMetadataBlock, "This Sender block is part of my message"].join("\n\n");
      const event: AgentEndContext = {
        sessionId: "test",
        messages: [
          { role: "user", content: telegramWrappedUserText(actualUserText, { sender: false }) },
          { role: "assistant", content: "reply" },
        ],
      };

      writer.onAgentEnd(event, { channelId: "telegram", sessionKey: "sk" });
      await flushMicrotasks();

      const [, persistedUser] = mockClient.storeChatTurn.mock.calls[0];
      expect(persistedUser).toBe(actualUserText);
      expect(persistedUser).toContain("Sender (untrusted metadata):");
      expect(persistedUser).toContain("user-pasted-sender-999");
    });


    it("T380 - W4a preserves standalone leading Sender block as user text", async () => {
      const event: AgentEndContext = {
        sessionId: "test",
        messages: [
          { role: "user", content: pastedSenderMetadataBlock },
          { role: "assistant", content: "reply" },
        ],
      };

      writer.onAgentEnd(event, { channelId: "telegram", sessionKey: "sk" });
      await flushMicrotasks();

      const [, persistedUser] = mockClient.storeChatTurn.mock.calls[0];
      expect(persistedUser).toBe(pastedSenderMetadataBlock);
      expect(persistedUser).toContain("Sender (untrusted metadata):");
      expect(persistedUser).toContain("user-pasted-sender-999");
    });


    it("T380 - W4a preserves non-Telegram metadata labels after Telegram wrapper", async () => {
      const actualUserText = [channelContextMetadataBlock, "This block is part of my message"].join("\n");
      const event: AgentEndContext = {
        sessionId: "test",
        messages: [
          { role: "user", content: telegramWrappedUserText(actualUserText) },
          { role: "assistant", content: "reply" },
        ],
      };

      writer.onAgentEnd(event, { channelId: "telegram", sessionKey: "sk" });
      await flushMicrotasks();

      const [, persistedUser] = mockClient.storeChatTurn.mock.calls[0];
      expect(persistedUser).toBe(actualUserText);
      expect(persistedUser).toContain("Channel context (untrusted metadata):");
    });


    it("T380 - W4a turnId hashing uses stripped user text", async () => {
      const event: AgentEndContext = {
        sessionId: "test",
        messages: [
          { role: "user", content: telegramWrappedUserText("hello") },
          { role: "assistant", content: "reply" },
        ],
      };

      writer.onAgentEnd(event, { channelId: "telegram", sessionKey: "sk" });
      await flushMicrotasks();

      const call = mockClient.storeChatTurn.mock.calls[0];
      expect(call[1]).toBe("hello");
      expect(call[3]?.turnId).toBe(
        (writer as any).deterministicTurnId("openclaw:telegram:::sk", "hello", "reply", 0),
      );
      expect(call[3]?.turnId).not.toBe(
        (writer as any).deterministicTurnId("openclaw:telegram:::sk", telegramWrappedUserText("hello"), "reply", 0),
      );
    });


    it("stores user message on onMessageReceived", () => {
      writer.onMessageReceived({
        sessionKey: "session-123",
        direction: "inbound",
        text: "user input",
      });
      expect((writer as any).pendingUserMessages.size).toBeGreaterThan(0);
    });


    it("persists on onMessageSent pairing with prior onMessageReceived", async () => {
      writer.onMessageReceived({
        sessionKey: "key123",
        direction: "inbound",
        text: "hello",
      });
      writer.onMessageSent({
        sessionKey: "key123",
        direction: "outbound",
        text: "response",
      });
      await flushMicrotasks();
      expect(mockClient.storeChatTurn).toHaveBeenCalled();
    });


    it("T380 - W4b onMessageReceived strips leading OpenClaw metadata before persist", async () => {
      writer.onMessageReceived({
        sessionKey: "key123",
        direction: "inbound",
        text: telegramWrappedUserText("hello"),
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
      expect(persistedUser).toBe("hello");
      expect(persistedUser).not.toContain("chat_id");
      expect(persistedUser).not.toContain("username");
    });


    it("T380 - W4b persists canonical internal Telegram envelopes and logs success", async () => {
      writer.onMessageReceived({
        sessionKey: "key123",
        direction: "inbound",
        context: {
          channelId: "telegram",
          accountId: "bot",
          conversationId: "telegram:test-chat-001",
          content: telegramWrappedUserText("hello"),
          messageId: "in-test-message-1021",
        },
      } as any);

      await writer.onMessageSent({
        sessionKey: "key123",
        direction: "outbound",
        context: {
          channelId: "telegram",
          accountId: "bot",
          conversationId: "telegram:test-chat-001",
          content: "response",
          success: true,
          messageId: "out-test-message-1022",
        },
      } as any);
      await writer.flush();

      expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(1);
      const [sessionId, persistedUser, persistedAssistant] = mockClient.storeChatTurn.mock.calls[0];
      expect(sessionId).toBe("openclaw:telegram:bot:telegram%3Atest-chat-001:key123");
      expect(persistedUser).toBe("hello");
      expect(persistedAssistant).toBe("response");
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining("[ChatTurnWriter] Persisted turn"),
      );
    });


    it("T380 - W4b preserves leading metadata-shaped text outside Telegram context", async () => {
      const pastedMetadata = telegramWrappedUserText("This block is part of my message");
      writer.onMessageReceived({
        sessionKey: "key123",
        direction: "inbound",
        text: pastedMetadata,
        ...({ context: { channelId: "discord" } } as any),
      } as any);
      await writer.onMessageSent({
        sessionKey: "key123",
        direction: "outbound",
        text: "response",
        ...({ context: { success: true, channelId: "discord" } } as any),
      } as any);
      await flushMicrotasks();

      const [, persistedUser] = mockClient.storeChatTurn.mock.calls[0];
      expect(persistedUser).toBe(pastedMetadata);
      expect(persistedUser).toContain("Conversation info (untrusted metadata):");
    });


    it("T380 - W4b preserves leading metadata-shaped user text after Telegram wrapper", async () => {
      const actualUserText = [conversationInfoMetadataBlock, "This block is part of my message"].join("\n");
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
      expect(persistedUser).toContain("Conversation info (untrusted metadata):");
    });
});
