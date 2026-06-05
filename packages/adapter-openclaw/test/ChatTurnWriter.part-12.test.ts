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


    it("T92 — ID-less direct pair is not skipped without an exact external ID", async () => {
      await writer.markExternalTurnPersistedDurable({
        sessionKey: "agent:main:main",
        turnId: "node-ui-corr-ambiguous-content",
        user: "ambiguous direct text",
        assistant: "ambiguous direct answer",
      });
      const restarted = new ChatTurnWriter({ client: mockClient, logger: mockLogger, stateDir });
      mockClient.storeChatTurn.mockClear();
      // T362 — Seed past cold-start; the clamp would otherwise discard
      // the first ambiguous pair and only emit the latest, defeating
      // this test's verification that BOTH ambiguous pairs persist when
      // the marker can't bind to an exact ID.
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
          { role: "user", content: "ambiguous direct text", context: { Provider: "dkg-ui", DkgTurnId: "node-ui-corr-new-id" } },
          { role: "assistant", content: "ambiguous direct answer" },
          { role: "user", content: "ambiguous direct text", context: { Provider: "dkg-ui" } },
          { role: "assistant", content: "ambiguous direct answer" },
        ],
      }, { channelId: "telegram", sessionKey: "agent:main:main" });
      await flushMicrotasks();

      expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(2);
      expect(mockClient.storeChatTurn.mock.calls.map((call) => call[1])).toEqual([
        "ambiguous direct text",
        "ambiguous direct text",
      ]);
      restarted.flushSync();
    });


    it("T93 - exact external marker does not skip later ID-less windows", async () => {
      await writer.markExternalTurnPersistedDurable({
        sessionKey: "agent:main:main",
        turnId: "node-ui-corr-retired-content",
        user: "retired direct text",
        assistant: "retired direct answer",
      });
      const restarted = new ChatTurnWriter({ client: mockClient, logger: mockLogger, stateDir });
      restarted.onAgentEnd({
        sessionId: "test",
        messages: [
          { role: "user", content: "retired direct text", context: { Provider: "dkg-ui", DkgTurnId: "node-ui-corr-new-id" } },
          { role: "assistant", content: "retired direct answer" },
        ],
      }, { channelId: "telegram", sessionKey: "agent:main:main" });
      await flushMicrotasks();
      expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(1);

      mockClient.storeChatTurn.mockClear();
      restarted.onAgentEnd({
        sessionId: "test",
        messages: [
          { role: "user", content: "retired direct text", context: { Provider: "dkg-ui", DkgTurnId: "node-ui-corr-new-id" } },
          { role: "assistant", content: "retired direct answer" },
          { role: "user", content: "retired direct text", context: { Provider: "dkg-ui" } },
          { role: "assistant", content: "retired direct answer" },
        ],
      }, { channelId: "telegram", sessionKey: "agent:main:main" });
      await flushMicrotasks();

      expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(1);
      expect(mockClient.storeChatTurn.mock.calls[0][1]).toBe("retired direct text");
      restarted.flushSync();
    });


    it("T87 — ID marker does not skip a mixed direct and non-direct joined user side", async () => {
      await writer.markExternalTurnPersistedDurable({
        sessionKey: "agent:main:main",
        turnId: "node-ui-corr-mixed",
        user: "ui part",
        assistant: "combined answer",
      });

      const restarted = new ChatTurnWriter({ client: mockClient, logger: mockLogger, stateDir });
      mockClient.storeChatTurn.mockClear();
      restarted.onAgentEnd({
        sessionId: "test",
        messages: [
          { role: "user", content: "ui part", context: { Provider: "dkg-ui", DkgTurnId: "node-ui-corr-mixed" } },
          { role: "user", content: "telegram part" },
          { role: "assistant", content: "combined answer" },
        ],
      }, { channelId: "telegram", sessionKey: "agent:main:main" });
      await flushMicrotasks();

      expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(1);
      expect(mockClient.storeChatTurn.mock.calls[0][1]).toBe("ui part\ntelegram part");
      restarted.flushSync();
    });


    it("T88 — one direct marker does not skip multiple collapsed direct users", async () => {
      await writer.markExternalTurnPersistedDurable({
        sessionKey: "agent:main:main",
        turnId: "node-ui-corr-direct-collapse",
        user: "first ui",
        assistant: "shared ui answer",
      });

      const restarted = new ChatTurnWriter({ client: mockClient, logger: mockLogger, stateDir });
      mockClient.storeChatTurn.mockClear();
      restarted.onAgentEnd({
        sessionId: "test",
        messages: [
          { role: "user", content: "first ui", context: { Provider: "dkg-ui", DkgTurnId: "node-ui-corr-direct-collapse" } },
          { role: "user", content: "second ui", context: { Provider: "dkg-ui" } },
          { role: "assistant", content: "shared ui answer" },
        ],
      }, { channelId: "telegram", sessionKey: "agent:main:main" });
      await flushMicrotasks();

      expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(1);
      expect(mockClient.storeChatTurn.mock.calls[0][1]).toBe("first ui\nsecond ui");
      restarted.flushSync();
    });


    it("T89 — reset gate replays W4b inbound that arrives while pre-reset W4a work drains", async () => {
      let releaseFirstPersist!: () => void;
      let firstPersist = true;
      mockClient.storeChatTurn.mockImplementation(async () => {
        if (firstPersist) {
          firstPersist = false;
          await new Promise<void>((resolve) => { releaseFirstPersist = resolve; });
        }
        return undefined;
      });

      writer.onAgentEnd({
        sessionId: "test",
        messages: [
          { role: "user", content: "before reset" },
          { role: "assistant", content: "old reply" },
        ],
      }, { channelId: "tg", sessionKey: "sk" });
      await flushMicrotasks();

      const resetPromise = writer.onBeforeReset({ channelId: "tg", sessionKey: "sk" });
      await flushMicrotasks();
      writer.onMessageReceived({
        sessionKey: "sk",
        context: { channelId: "tg", content: "after reset", messageId: "in-after" },
      } as any);

      releaseFirstPersist();
      await resetPromise;
      await flushMicrotasks();

      mockClient.storeChatTurn.mockClear();
      await writer.onMessageSent({
        sessionKey: "sk",
        context: { channelId: "tg", content: "new reply", success: true, messageId: "out-after" },
      } as any);
      await flushMicrotasks();

      expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(1);
      expect(mockClient.storeChatTurn.mock.calls[0][1]).toBe("after reset");
    });


    it("T90 — setStateDir preserves destination external markers", async () => {
      const destinationStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "chatturnwriter-dest-"));
      try {
        const destination = new ChatTurnWriter({ client: mockClient, logger: mockLogger, stateDir: destinationStateDir });
        await destination.markExternalTurnPersistedDurable({
          sessionKey: "agent:main:main",
          turnId: "node-ui-corr-migrate",
          user: "migrated ui question",
          assistant: "migrated ui answer",
        });
        destination.flushSync();

        await writer.setStateDir(destinationStateDir);
        const restarted = new ChatTurnWriter({ client: mockClient, logger: mockLogger, stateDir: destinationStateDir });
        mockClient.storeChatTurn.mockClear();
        restarted.onAgentEnd({
          sessionId: "test",
          messages: [
            { role: "user", content: "migrated ui question", context: { Provider: "dkg-ui", DkgTurnId: "node-ui-corr-migrate" } },
            { role: "assistant", content: "migrated ui answer" },
          ],
        }, { channelId: "telegram", sessionKey: "agent:main:main" });
        await flushMicrotasks();

        expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(0);
        restarted.flushSync();
      } finally {
        fs.rmSync(destinationStateDir, { recursive: true, force: true });
      }
    });


    it("T97 - setStateDir deduplicates exact external markers", async () => {
      const destinationStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "chatturnwriter-dest-counts-"));
      try {
        const externalCursorKey = (writer as any).externalCursorKeyFromSessionKey("agent:main:main");
        const marker = (writer as any).externalTurnMarkerId(
          "node-ui-corr-counted",
          "counted question",
          "counted answer",
        );
        (writer as any).restoreExternalTurnMarker(externalCursorKey, marker);
        (writer as any).writeWatermarkFile();

        const destination = new ChatTurnWriter({ client: mockClient, logger: mockLogger, stateDir: destinationStateDir });
        (destination as any).restoreExternalTurnMarker(externalCursorKey, marker);
        (destination as any).writeWatermarkFile();

        await writer.setStateDir(destinationStateDir);

        const bucket: Map<string, number> | undefined = (writer as any).externalTurnMarkers.get(externalCursorKey);
        expect(bucket?.get(marker)).toBe(1);
        const persisted = JSON.parse(fs.readFileSync(
          path.join(destinationStateDir, "dkg-adapter", "chat-turn-watermarks.json"),
          "utf-8",
        ));
        expect(persisted[externalCursorKey].m[marker]).toBe(1);
      } finally {
        fs.rmSync(destinationStateDir, { recursive: true, force: true });
      }
    });


    it("T102 - setStateDir final rewrite preserves concurrent external markers", async () => {
      const destinationStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "chatturnwriter-dest-marker-race-"));
      try {
        const newDir = path.join(destinationStateDir, "dkg-adapter");
        fs.mkdirSync(newDir, { recursive: true });
        const newFile = path.join(newDir, "chat-turn-watermarks.json");
        fs.writeFileSync(newFile, JSON.stringify({}));

        const dkw = writer as any;
        const externalCursorKey = dkw.externalCursorKeyFromSessionKey("agent:main:main");
        const marker = dkw.externalTurnMarkerId(
          "node-ui-corr-marker-race",
          "migrated ui question",
          "migrated ui answer",
        );
        const realWrite = dkw.writeWatermarkFile.bind(dkw);
        const writeSpy = vi.spyOn(dkw, "writeWatermarkFile").mockImplementationOnce((target: string, override: any) => {
          dkw.restoreExternalTurnMarker(externalCursorKey, marker);
          return realWrite(target, override);
        });

        await writer.setStateDir(destinationStateDir);

        const persisted = JSON.parse(fs.readFileSync(newFile, "utf-8"));
        expect(persisted[externalCursorKey].m[marker]).toBe(1);
        const restarted = new ChatTurnWriter({ client: mockClient, logger: mockLogger, stateDir: destinationStateDir });
        mockClient.storeChatTurn.mockClear();
        restarted.onAgentEnd({
          sessionId: "test",
          messages: [
            { role: "user", content: "migrated ui question", context: { Provider: "dkg-ui", DkgTurnId: "node-ui-corr-marker-race" } },
            { role: "assistant", content: "migrated ui answer" },
          ],
        }, { channelId: "telegram", sessionKey: "agent:main:main" });
        await flushMicrotasks();

        expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(0);
        writeSpy.mockRestore();
        restarted.flushSync();
      } finally {
        fs.rmSync(destinationStateDir, { recursive: true, force: true });
      }
    });


    it("T103 - setStateDir does not swap to a stale file when final marker rewrite fails", async () => {
      const destinationStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "chatturnwriter-dest-marker-fail-"));
      try {
        const newDir = path.join(destinationStateDir, "dkg-adapter");
        fs.mkdirSync(newDir, { recursive: true });
        fs.writeFileSync(path.join(newDir, "chat-turn-watermarks.json"), JSON.stringify({}));

        const dkw = writer as any;
        const originalStateDir = dkw.stateDir;
        const originalWatermarkFilePath = dkw.watermarkFilePath;
        const externalCursorKey = dkw.externalCursorKeyFromSessionKey("agent:main:main");
        const marker = dkw.externalTurnMarkerId(
          "node-ui-corr-marker-final-fail",
          "final fail question",
          "final fail answer",
        );
        fs.writeFileSync(path.join(newDir, "chat-turn-watermarks.json"), JSON.stringify({
          [externalCursorKey]: { m: { [marker]: 1 } },
        }));
        const realWrite = dkw.writeWatermarkFile.bind(dkw);
        const writeSpy = vi.spyOn(dkw, "writeWatermarkFile")
          .mockImplementationOnce((target: string, override: any) => {
            dkw.restoreExternalTurnMarker(externalCursorKey, marker);
            return realWrite(target, override);
          })
          .mockImplementationOnce(() => false);

        await writer.setStateDir(destinationStateDir);

        expect(dkw.stateDir).toBe(originalStateDir);
        expect(dkw.watermarkFilePath).toBe(originalWatermarkFilePath);
        expect(dkw.externalTurnMarkers.get(externalCursorKey)?.get(marker)).toBe(1);
        expect(writeSpy).toHaveBeenCalledTimes(4);
        const persistedOldPath = JSON.parse(fs.readFileSync(originalWatermarkFilePath, "utf-8"));
        expect(persistedOldPath[externalCursorKey].m[marker]).toBe(1);
        writeSpy.mockRestore();

        await writer.setStateDir(destinationStateDir);
        expect(dkw.stateDir).toBe(destinationStateDir);
        expect(dkw.watermarkFilePath).toBe(path.join(newDir, "chat-turn-watermarks.json"));
        const persistedNewPath = JSON.parse(fs.readFileSync(dkw.watermarkFilePath, "utf-8"));
        expect(persistedNewPath[externalCursorKey].m[marker]).toBe(1);
      } finally {
        fs.rmSync(destinationStateDir, { recursive: true, force: true });
      }
    });


    it("T17 — disk file accepts the legacy number format for backward compat", async () => {
      // The pre-fix file contained `{ "sid": <number> }` (watermark only).
      // Existing on-disk files MUST still load correctly to avoid losing
      // watermark progress on the upgrade.
      const filePath = path.join(stateDir, "dkg-adapter", "chat-turn-watermarks.json");
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify({ "openclaw:legacy:::sk": 7 }));

      const w = new ChatTurnWriter({ client: mockClient, logger: mockLogger, stateDir });
      expect((w as any).cachedWatermarks.get("openclaw:legacy:::sk")).toBe(7);
      expect((w as any).w4bSessionCounts.get("openclaw:legacy:::sk")).toBeUndefined();
      w.flushSync();
    });


    it("T15 — onMessageSent collapses the FULL pending queue into one user-side (matches computeDelta)", async () => {
      // Regression for T15: pre-fix, W4b shifted only the OLDEST pending
      // user message and left any others queued. `computeDelta` (W4a)
      // collapses consecutive user messages before one assistant reply
      // into a single logical pair via `pendingUsers.join("\n")`. The
      // mismatch caused two failures:
      //   1. Setup-runtime / typed-hook-miss scenarios where ONLY W4b
      //      runs: u2 stayed queued forever and got mis-paired with the
      //      NEXT assistant reply.
      //   2. Cross-path dedup broke when both paths fire — W4a stamped
      //      `crossPathStamps[w4aOrigin("u1\nu2", reply)]` while W4b
      //      peeked `w4aOrigin("u1", reply)` (different content keys),
      //      so W4b proceeded to write a duplicate `(u1, reply)` turn.
      writer.onMessageReceived({
        sessionKey: "sk",
        context: { channelId: "tg", content: "u1", messageId: "in-1" },
      } as any);
      writer.onMessageReceived({
        sessionKey: "sk",
        context: { channelId: "tg", content: "u2", messageId: "in-2" },
      } as any);
      await writer.onMessageSent({
        sessionKey: "sk",
        context: { channelId: "tg", content: "reply", success: true, messageId: "out-1" },
      } as any);
      await flushMicrotasks();
      // Persist must have been called ONCE with the JOINED user-side.
      expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(1);
      const call = mockClient.storeChatTurn.mock.calls[0];
      expect(call[1]).toBe("u1\nu2"); // joined, matches computeDelta
      expect(call[2]).toBe("reply");
      // Pending queue must be empty (no leftover u2).
      const pending = (writer as any).pendingUserMessages;
      expect(pending.size).toBe(0);
    });
});
