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


    it("T19 — failed outbound consumes the FULL pending queue (matches success-path collapse)", async () => {
      // Regression for T19: pre-fix, the success === false branch shifted
      // only the OLDEST pending inbound, but T15 changed the success path
      // to drain the WHOLE queue. The asymmetry meant siblings stayed
      // queued on failure and got mis-paired with the next unrelated
      // reply. Post-fix, failure deletes the whole queue.
      writer.onMessageReceived({
        sessionKey: "sk",
        context: { channelId: "tg", content: "u1", messageId: "in-1" },
      } as any);
      writer.onMessageReceived({
        sessionKey: "sk",
        context: { channelId: "tg", content: "u2", messageId: "in-2" },
      } as any);
      // Failure event: must consume BOTH pending inbounds, not just u1.
      await writer.onMessageSent({
        sessionKey: "sk",
        context: { channelId: "tg", content: "failed-reply", success: false, messageId: "out-1" },
      } as any);
      await flushMicrotasks();
      expect(mockClient.storeChatTurn).not.toHaveBeenCalled();

      // Pending queue MUST be empty. Pre-fix u2 lingered.
      const pending = (writer as any).pendingUserMessages;
      expect(pending.size).toBe(0);

      // A later unrelated exchange must pair with NEW inbounds, not stale u2.
      writer.onMessageReceived({
        sessionKey: "sk",
        context: { channelId: "tg", content: "u3", messageId: "in-3" },
      } as any);
      await writer.onMessageSent({
        sessionKey: "sk",
        context: { channelId: "tg", content: "ok", success: true, messageId: "out-2" },
      } as any);
      await flushMicrotasks();
      expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(1);
      expect(mockClient.storeChatTurn.mock.calls[0][1]).toBe("u3"); // NOT "u2", not "u2\nu3"
      expect(mockClient.storeChatTurn.mock.calls[0][2]).toBe("ok");
    });


    it("T359 - failed outbound clears inbound messageId dedupe for redelivery", async () => {
      writer.onMessageReceived({
        sessionKey: "sk",
        context: { channelId: "tg", content: "retry after failed send", messageId: "in-redeliver" },
      } as any);
      await writer.onMessageSent({
        sessionKey: "sk",
        context: { channelId: "tg", content: "not delivered", success: false, messageId: "out-failed" },
      } as any);
      await flushMicrotasks();

      expect(mockClient.storeChatTurn).not.toHaveBeenCalled();
      expect((writer as any).pendingUserMessages.size).toBe(0);

      writer.onMessageReceived({
        sessionKey: "sk",
        context: { channelId: "tg", content: "retry after failed send", messageId: "in-redeliver" },
      } as any);
      await writer.onMessageSent({
        sessionKey: "sk",
        context: { channelId: "tg", content: "delivered on retry", success: true, messageId: "out-redeliver" },
      } as any);
      await flushMicrotasks();

      expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(1);
      expect(mockClient.storeChatTurn.mock.calls[0][1]).toBe("retry after failed send");
      expect(mockClient.storeChatTurn.mock.calls[0][2]).toBe("delivered on retry");
    });
});
