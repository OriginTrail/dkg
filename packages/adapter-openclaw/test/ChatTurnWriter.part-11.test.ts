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


    it("T460 — markExternalTurnPersistedDurable replay does not double the ordered-marker count", async () => {
      // Marker-only retry idempotency. PR #457 review round (Codex
      // comment on `incrementOrderedExternalTurnMarker`): a marker-write
      // retry with identical opts left content-bound markers idempotent
      // via Math.max but still incremented the ordered ticket count.
      // After N retries, N - 1 leftover tickets could be consumed by a
      // later W4a pass against unrelated metadata-stripped pairs (e.g.,
      // a stale non-latest Telegram pair). After the fix, a replay
      // detects the existing content markers and skips the ordered
      // increment.
      await writer.markExternalTurnPersistedDurable({
        sessionKey: "agent:main:main",
        turnId: "node-ui-corr-retry",
        user: "ui question",
        assistant: "ui answer",
      });
      await writer.markExternalTurnPersistedDurable({
        sessionKey: "agent:main:main",
        turnId: "node-ui-corr-retry",
        user: "ui question",
        assistant: "ui answer",
      });

      const externalCursorKey = (writer as any).externalCursorKeyFromSessionKey("agent:main:main");
      const bucket = (writer as any).externalTurnMarkers.get(externalCursorKey) as Map<string, number>;
      const orderedKey = (writer as any).constructor.EXTERNAL_ORDERED_TURN_MARKER as string;
      expect(bucket?.get(orderedKey) ?? 0).toBe(1);
      writer.flushSync();
    });


    it("T359 - typed Telegram W4b and Node-UI external markers both suppress W4a duplicates after restart", async () => {
      await writer.markExternalTurnPersistedDurable({
        sessionKey: "agent:main:main",
        turnId: "node-ui-corr-mixed",
        user: "node ui question",
        assistant: "node ui answer",
      });
      writer.onTypedMessageReceived(
        { from: "user-1", content: "telegram question", metadata: { messageId: "mixed-telegram-in" } },
        {
          channelId: "telegram",
          accountId: "bot",
          conversationId: "mixed-chat",
          sessionKey: "agent:main:main",
        },
      );
      await writer.onTypedMessageSent(
        { to: "user-1", content: "telegram answer", success: true },
        {
          channelId: "telegram",
          accountId: "bot",
          conversationId: "mixed-chat",
          sessionKey: "agent:main:main",
        },
      );
      await flushMicrotasks();
      expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(1);
      expect(mockClient.storeChatTurn.mock.calls[0][1]).toBe("telegram question");

      const restarted = new ChatTurnWriter({ client: mockClient, logger: mockLogger, stateDir });
      mockClient.storeChatTurn.mockClear();
      restarted.onAgentEnd({
        sessionId: "test",
        messages: [
          { role: "user", content: "telegram question" },
          { role: "assistant", content: "telegram answer" },
          { role: "user", content: "node ui question", context: { Provider: "dkg-ui", DkgTurnId: "node-ui-corr-mixed" } },
          { role: "assistant", content: "node ui answer" },
        ],
      }, {
        channelId: "telegram",
        accountId: "bot",
        conversationId: "mixed-chat",
        sessionKey: "agent:main:main",
      });
      await flushMicrotasks();

      expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(0);
      restarted.flushSync();
    });


    it("T104 - reused direct-channel turnId with different content does not skip W4a", async () => {
      await writer.markExternalTurnPersistedDurable({
        sessionKey: "agent:main:main",
        turnId: "node-ui-corr-reused",
        user: "first ui question",
        assistant: "first ui answer",
      });

      const restarted = new ChatTurnWriter({ client: mockClient, logger: mockLogger, stateDir });
      mockClient.storeChatTurn.mockClear();
      restarted.onAgentEnd({
        sessionId: "test",
        messages: [
          { role: "user", content: "second ui question", context: { Provider: "dkg-ui", DkgTurnId: "node-ui-corr-reused" } },
          { role: "assistant", content: "second ui answer" },
        ],
      }, { channelId: "telegram", sessionKey: "agent:main:main" });
      await flushMicrotasks();

      expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(1);
      expect(mockClient.storeChatTurn.mock.calls[0][1]).toBe("second ui question");
      expect(mockClient.storeChatTurn.mock.calls[0][2]).toBe("second ui answer");
      restarted.flushSync();
    });


    for (const hookName of ["onBeforeReset", "onBeforeCompaction"] as const) {
      it(`T99 - ${hookName} preserves durable external markers for replay dedupe`, async () => {
        const turnId = `node-ui-corr-${hookName}`;
        await writer.markExternalTurnPersistedDurable({
          sessionKey: "agent:main:main",
          turnId,
          user: "reset ui question",
          assistant: "reset ui answer",
        });
        await writer[hookName]({ channelId: "telegram", sessionKey: "agent:main:main" });

        const externalCursorKey = (writer as any).externalCursorKeyFromSessionKey("agent:main:main");
        const marker = (writer as any).externalTurnMarkerId(turnId, "reset ui question", "reset ui answer");
        const persisted = JSON.parse(fs.readFileSync(
          path.join(stateDir, "dkg-adapter", "chat-turn-watermarks.json"),
          "utf-8",
        ));
        expect(persisted[externalCursorKey].m[marker]).toBe(1);

        const restarted = new ChatTurnWriter({ client: mockClient, logger: mockLogger, stateDir });
        mockClient.storeChatTurn.mockClear();
        restarted.onAgentEnd({
          sessionId: "test",
          messages: [
            { role: "user", content: "reset ui question", context: { Provider: "dkg-ui", DkgTurnId: turnId } },
            { role: "assistant", content: "reset ui answer" },
          ],
        }, { channelId: "telegram", sessionKey: "agent:main:main" });
        await flushMicrotasks();

        expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(0);
        await restarted[hookName]({ channelId: "telegram", sessionKey: "agent:main:main" });
        mockClient.storeChatTurn.mockClear();
        restarted.onAgentEnd({
          sessionId: "test",
          messages: [
            { role: "user", content: "reset ui question", context: { Provider: "dkg-ui", DkgTurnId: turnId } },
            { role: "assistant", content: "reset ui answer" },
          ],
        }, { channelId: "telegram", sessionKey: "agent:main:main" });
        await flushMicrotasks();

        expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(0);
        restarted.flushSync();
      });
    }


    it("T83 — external marker write failure rolls back counts before retry", async () => {
      const writeSpy = vi.spyOn(writer as any, "writeWatermarkFile")
        .mockReturnValueOnce(false)
        .mockReturnValueOnce(true);

      await expect(writer.markExternalTurnPersistedDurable({
        sessionKey: "agent:main:main",
        turnId: "node-ui-corr-rollback",
        user: "rollback question",
        assistant: "rollback answer",
      })).rejects.toThrow("Failed to write external chat-turn marker");

      await writer.markExternalTurnPersistedDurable({
        sessionKey: "agent:main:main",
        turnId: "node-ui-corr-rollback",
        user: "rollback question",
        assistant: "rollback answer",
      });

      const externalCursorKey = (writer as any).externalCursorKeyFromSessionKey("agent:main:main");
      const bucket: Map<string, number> | undefined = (writer as any).externalTurnMarkers.get(externalCursorKey);
      expect(Array.from(bucket?.values() ?? [])).toEqual([1, 1, 1]);
      writeSpy.mockRestore();
    });


    it("T105 - external marker write failure preserves a pre-existing exact marker", async () => {
      await writer.markExternalTurnPersistedDurable({
        sessionKey: "agent:main:main",
        turnId: "node-ui-corr-preexisting",
        user: "preexisting question",
        assistant: "preexisting answer",
      });

      const externalCursorKey = (writer as any).externalCursorKeyFromSessionKey("agent:main:main");
      const marker = (writer as any).externalTurnMarkerId(
        "node-ui-corr-preexisting",
        "preexisting question",
        "preexisting answer",
      );
      expect((writer as any).externalTurnMarkers.get(externalCursorKey)?.get(marker)).toBe(1);

      const writeSpy = vi.spyOn(writer as any, "writeWatermarkFile").mockReturnValueOnce(false);
      await expect(writer.markExternalTurnPersistedDurable({
        sessionKey: "agent:main:main",
        turnId: "node-ui-corr-preexisting",
        user: "preexisting question",
        assistant: "preexisting answer",
      })).rejects.toThrow("Failed to write external chat-turn marker");

      expect((writer as any).externalTurnMarkers.get(externalCursorKey)?.get(marker)).toBe(1);
      writeSpy.mockRestore();
    });


    it("T94 — external marker write failure preserves unrelated debounce timers", async () => {
      writer.onAgentEnd({
        sessionId: "test",
        messages: [
          { role: "user", content: "pending question" },
          { role: "assistant", content: "pending answer" },
        ],
      }, { channelId: "tg", sessionKey: "sk" });
      await flushMicrotasks();

      const sessionId = (writer as any).deriveSessionId({ channelId: "tg", sessionKey: "sk" });
      expect((writer as any).debounceTimers.has(sessionId)).toBe(true);

      const writeSpy = vi.spyOn(writer as any, "writeWatermarkFile").mockReturnValueOnce(false);
      await expect(writer.markExternalTurnPersistedDurable({
        sessionKey: "agent:main:main",
        turnId: "node-ui-corr-debounce",
        user: "external question",
        assistant: "external answer",
      })).rejects.toThrow("Failed to write external chat-turn marker");

      expect((writer as any).debounceTimers.has(sessionId)).toBe(true);
      writeSpy.mockRestore();
    });


    it("T84 — external markers are correlation-bound, not content-only", async () => {
      await writer.markExternalTurnPersistedDurable({
        sessionKey: "agent:main:main",
        turnId: "node-ui-corr-2",
        user: "same question",
        assistant: "same answer",
      });

      const restarted = new ChatTurnWriter({ client: mockClient, logger: mockLogger, stateDir });
      mockClient.storeChatTurn.mockClear();
      // T362 — Seed past cold-start so the in-session marker check runs
      // for both same-content pairs (cold-start clamp would otherwise
      // discard the first pair entirely, defeating this test's
      // verification that markers are correlation-bound, not content-only).
      restarted.onAgentEnd({
        sessionId: "seed",
        messages: [
          { role: "user", content: "__seed__" },
          { role: "assistant", content: "__seed__reply__" },
        ],
      }, { channelId: "telegram", sessionKey: "agent:main:main" });
      await flushMicrotasks();
      mockClient.storeChatTurn.mockClear();

      restarted.onAgentEnd({
        sessionId: "test",
        messages: [
          { role: "user", content: "__seed__" },              // saved
          { role: "assistant", content: "__seed__reply__" },
          { role: "user", content: "same question" },                                                   // pairIndex 1 — emit
          { role: "assistant", content: "same answer" },
          { role: "user", content: "same question", context: { Provider: "dkg-ui", DkgTurnId: "node-ui-corr-2" } },  // pairIndex 2 — marker hit, skip
          { role: "assistant", content: "same answer" },
        ],
      }, { channelId: "telegram", sessionKey: "agent:main:main" });
      await flushMicrotasks();

      expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(1);
      expect(mockClient.storeChatTurn.mock.calls[0][1]).toBe("same question");
      const expectedFirstPairTurnId = (restarted as any).deterministicTurnId(
        (restarted as any).deriveSessionId({ channelId: "telegram", sessionKey: "agent:main:main" }),
        "same question",
        "same answer",
        1,
      );
      const skippedSecondPairTurnId = (restarted as any).deterministicTurnId(
        (restarted as any).deriveSessionId({ channelId: "telegram", sessionKey: "agent:main:main" }),
        "same question",
        "same answer",
        2,
      );
      expect(mockClient.storeChatTurn.mock.calls[0][3]).toEqual({ turnId: expectedFirstPairTurnId });
      expect(mockClient.storeChatTurn.mock.calls[0][3]).not.toEqual({ turnId: skippedSecondPairTurnId });
      restarted.flushSync();
    });


    it("T85 - ordered direct marker skips an ID-less historical direct pair before the live pair", async () => {
      await writer.markExternalTurnPersistedDurable({
        sessionKey: "agent:main:main",
        turnId: "node-ui-corr-unique-content",
        user: "unique ui question",
        assistant: "unique ui answer",
      });
      const restarted = new ChatTurnWriter({ client: mockClient, logger: mockLogger, stateDir });
      mockClient.storeChatTurn.mockClear();
      // T362 — Seed past cold-start; the clamp would otherwise discard
      // the historical UI pair and only emit the latest Telegram pair.
      // T457 — The historical direct-channel pair has lost its exact
      // DkgTurnId by the time Telegram W4a scans the shared transcript,
      // so the ordered direct marker skips exactly that non-latest pair.
      restarted.onAgentEnd({
        sessionId: "seed",
        messages: [
          { role: "user", content: "__seed__" },
          { role: "assistant", content: "__seed__reply__" },
        ],
      }, { channelId: "telegram", sessionKey: "agent:main:main" });
      await flushMicrotasks();
      mockClient.storeChatTurn.mockClear();

      restarted.onAgentEnd({
        sessionId: "test",
        messages: [
          { role: "user", content: "__seed__" },              // saved
          { role: "assistant", content: "__seed__reply__" },
          { role: "user", content: "unique ui question", context: { Provider: "dkg-ui" } },  // emit
          { role: "assistant", content: "unique ui answer" },
          { role: "user", content: "telegram question" },                                     // emit
          { role: "assistant", content: "telegram answer" },
        ],
      }, { channelId: "telegram", sessionKey: "agent:main:main" });
      await flushMicrotasks();

      expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(1);
      expect(mockClient.storeChatTurn.mock.calls.map((call) => call[1])).toEqual([
        "telegram question",
      ]);
      restarted.flushSync();
    });


    it("T86 — ID-less non-direct channel pair is not skipped by an external marker", async () => {
      await writer.markExternalTurnPersistedDurable({
        sessionKey: "agent:main:main",
        turnId: "node-ui-corr-stale-content",
        user: "shared text",
        assistant: "shared answer",
      });

      const restarted = new ChatTurnWriter({ client: mockClient, logger: mockLogger, stateDir });
      mockClient.storeChatTurn.mockClear();
      restarted.onAgentEnd({
        sessionId: "test",
        messages: [
          { role: "user", content: "shared text" },
          { role: "assistant", content: "shared answer" },
        ],
      }, { channelId: "telegram", sessionKey: "agent:main:main" });
      await flushMicrotasks();

      expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(1);
      expect(mockClient.storeChatTurn.mock.calls[0][1]).toBe("shared text");
      restarted.flushSync();
    });


    it("T91 — exact external marker does not skip a direct pair with a mismatched explicit ID", async () => {
      await writer.markExternalTurnPersistedDurable({
        sessionKey: "agent:main:main",
        turnId: "node-ui-corr-stale-id",
        user: "same direct text",
        assistant: "same direct answer",
      });
      const restarted = new ChatTurnWriter({ client: mockClient, logger: mockLogger, stateDir });
      mockClient.storeChatTurn.mockClear();
      restarted.onAgentEnd({
        sessionId: "test",
        messages: [
          { role: "user", content: "same direct text", context: { Provider: "dkg-ui", DkgTurnId: "node-ui-corr-new-id" } },
          { role: "assistant", content: "same direct answer" },
        ],
      }, { channelId: "telegram", sessionKey: "agent:main:main" });
      await flushMicrotasks();

      expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(1);
      expect(mockClient.storeChatTurn.mock.calls[0][1]).toBe("same direct text");
      restarted.flushSync();
    });
});
