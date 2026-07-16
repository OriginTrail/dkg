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


    it("clears stale W4a watermark but preserves fresh W4b state written during daemon validation", async () => {
      const directStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "chatturnwriter-stale-w4b-race-"));
      const sessionId = "openclaw:tg:acct:conv:race-sk";
      const directFile = path.join(directStateDir, "chat-turn-watermarks.json");
      let resolveStatus!: (value: { hasAnyChatTurnData: boolean; existingSessionIds: string[] }) => void;
      const statusPromise = new Promise<{ hasAnyChatTurnData: boolean; existingSessionIds: string[] }>((resolve) => {
        resolveStatus = resolve;
      });
      const localClient = {
        storeChatTurn: vi.fn().mockResolvedValue(undefined),
        getChatTurnStoreStatus: vi.fn().mockReturnValue(statusPromise),
      };
      try {
        fs.writeFileSync(directFile, JSON.stringify({ [sessionId]: { w: 99, b: 0 } }));
        const restarted = new ChatTurnWriter({
          client: localClient,
          logger: mockLogger,
          stateDir: directStateDir,
          stateLayout: "direct",
        });
        await restarted.onAgentEnd(
          {
            sessionId,
            messages: [
              { role: "user", content: "race user" },
              { role: "assistant", content: "race assistant" },
            ],
          },
          { channelId: "tg", accountId: "acct", conversationId: "conv", sessionKey: "race-sk" },
        );
        for (let i = 0; i < 10 && localClient.getChatTurnStoreStatus.mock.calls.length === 0; i++) {
          await flushMicrotasks();
        }
        expect(localClient.getChatTurnStoreStatus).toHaveBeenCalled();

        restarted.onMessageReceived({
          sessionKey: "race-sk",
          context: {
            content: "race user",
            channelId: "tg",
            accountId: "acct",
            conversationId: "conv",
            messageId: "in-race",
          },
        });
        await restarted.onMessageSent({
          sessionKey: "race-sk",
          context: {
            content: "race assistant",
            channelId: "tg",
            accountId: "acct",
            conversationId: "conv",
            messageId: "out-race",
            success: true,
          },
        });

        resolveStatus({ hasAnyChatTurnData: false, existingSessionIds: [] });
        await restarted.flush();

        expect(localClient.storeChatTurn).toHaveBeenCalledTimes(1);
        const persisted = JSON.parse(fs.readFileSync(directFile, "utf-8"));
        expect(persisted[sessionId]?.w).toBe(-1);
        expect(persisted[sessionId]?.b).toBe(1);
        expect((restarted as any).peekCrossPathStamp(
          sessionId,
          (restarted as any).w4bOriginKey("race user", "race assistant"),
        )).toBe(true);
        restarted.flushSync();
      } finally {
        fs.rmSync(directStateDir, { recursive: true, force: true });
      }
    });


    it("clears stale pending watermarks that roll into cached state during daemon validation", async () => {
      const directStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "chatturnwriter-stale-pending-rollover-"));
      const sessionId = "openclaw:tg:acct:conv:pending-sk";
      let resolveStatus!: (value: { hasAnyChatTurnData: boolean; existingSessionIds: string[] }) => void;
      const statusPromise = new Promise<{ hasAnyChatTurnData: boolean; existingSessionIds: string[] }>((resolve) => {
        resolveStatus = resolve;
      });
      const localClient = {
        storeChatTurn: vi.fn().mockResolvedValue(undefined),
        getChatTurnStoreStatus: vi.fn().mockReturnValue(statusPromise),
      };
      try {
        const restarted = new ChatTurnWriter({
          client: localClient,
          logger: mockLogger,
          stateDir: directStateDir,
          stateLayout: "direct",
        });
        (restarted as any).saveWatermark(sessionId, 99);
        restarted.setClient(localClient);
        await restarted.onAgentEnd(
          {
            sessionId,
            messages: [
              { role: "user", content: "pending user" },
              { role: "assistant", content: "pending assistant" },
            ],
          },
          { channelId: "tg", accountId: "acct", conversationId: "conv", sessionKey: "pending-sk" },
        );
        for (let i = 0; i < 10 && localClient.getChatTurnStoreStatus.mock.calls.length === 0; i++) {
          await flushMicrotasks();
        }
        expect(localClient.getChatTurnStoreStatus).toHaveBeenCalled();
        await new Promise((resolve) => setTimeout(resolve, 70));
        expect((restarted as any).cachedWatermarks.get(sessionId)).toBe(99);

        resolveStatus({ hasAnyChatTurnData: false, existingSessionIds: [] });
        await restarted.flush();

        expect(localClient.storeChatTurn).toHaveBeenCalledTimes(1);
        expect(localClient.storeChatTurn.mock.calls[0][1]).toBe("pending user");
        expect(localClient.storeChatTurn.mock.calls[0][2]).toBe("pending assistant");
        restarted.flushSync();
      } finally {
        fs.rmSync(directStateDir, { recursive: true, force: true });
      }
    });


    it("clears stale cursor state then cold-start clamps a longer transcript to the latest pair", async () => {
      const directStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "chatturnwriter-stale-clamp-"));
      const sessionId = "openclaw:tg:acct:conv:sk-clamp";
      const directFile = path.join(directStateDir, "chat-turn-watermarks.json");
      const localClient = {
        storeChatTurn: vi.fn().mockResolvedValue(undefined),
        getChatTurnStoreStatus: vi.fn().mockResolvedValue({
          hasAnyChatTurnData: false,
          existingSessionIds: [],
        }),
      };
      try {
        fs.writeFileSync(directFile, JSON.stringify({ [sessionId]: { w: 0, b: 0 } }));
        const restarted = new ChatTurnWriter({
          client: localClient,
          logger: mockLogger,
          stateDir: directStateDir,
          stateLayout: "direct",
        });
        await restarted.onAgentEnd(
          {
            sessionId,
            messages: [
              { role: "user", content: "old u1" },
              { role: "assistant", content: "old a1" },
              { role: "user", content: "old u2" },
              { role: "assistant", content: "old a2" },
              { role: "user", content: "current u3" },
              { role: "assistant", content: "current a3" },
            ],
          },
          { channelId: "tg", accountId: "acct", conversationId: "conv", sessionKey: "sk-clamp" },
        );
        await restarted.flush();

        expect(localClient.storeChatTurn).toHaveBeenCalledTimes(1);
        expect(localClient.storeChatTurn.mock.calls[0][1]).toBe("current u3");
        expect(localClient.storeChatTurn.mock.calls[0][2]).toBe("current a3");
        const persisted = JSON.parse(fs.readFileSync(directFile, "utf-8"));
        expect(persisted[sessionId]).toEqual({ w: 2, b: 0 });
        restarted.flushSync();
      } finally {
        fs.rmSync(directStateDir, { recursive: true, force: true });
      }
    });


    it("preserves local cursor state when daemon status validation fails", async () => {
      const directStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "chatturnwriter-stale-validation-failure-"));
      const sessionId = "openclaw:tg:acct:conv:sk-validation-failure";
      const directFile = path.join(directStateDir, "chat-turn-watermarks.json");
      const localClient = {
        storeChatTurn: vi.fn().mockResolvedValue(undefined),
        getChatTurnStoreStatus: vi.fn().mockRejectedValue(new Error("network unavailable")),
      };
      try {
        fs.writeFileSync(directFile, JSON.stringify({ [sessionId]: { w: 99, b: 0 } }));
        const restarted = new ChatTurnWriter({
          client: localClient,
          logger: mockLogger,
          stateDir: directStateDir,
          stateLayout: "direct",
        });
        await restarted.onAgentEnd(
          {
            sessionId,
            messages: [
              { role: "user", content: "should remain skipped" },
              { role: "assistant", content: "validation failed" },
            ],
          },
          { channelId: "tg", accountId: "acct", conversationId: "conv", sessionKey: "sk-validation-failure" },
        );
        await restarted.flush();

        expect(localClient.storeChatTurn).not.toHaveBeenCalled();
        expect(mockLogger.warn).toHaveBeenCalledWith(
          expect.stringContaining("Failed to validate chat-turn cursor state"),
          expect.objectContaining({ sessionId }),
        );
        const persisted = JSON.parse(fs.readFileSync(directFile, "utf-8"));
        expect(persisted[sessionId]).toEqual({ w: 99, b: 0 });
        restarted.flushSync();
      } finally {
        fs.rmSync(directStateDir, { recursive: true, force: true });
      }
    });


    it("migrates legacy workspace default watermarks into the direct layout by max values", () => {
      const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "chatturnwriter-legacy-workspace-"));
      const legacyStateDir = path.join(workspace, ".openclaw");
      const newStateDir = path.join(workspace, ".dkg-adapter");
      const legacyFile = path.join(legacyStateDir, "dkg-adapter", "chat-turn-watermarks.json");
      const newFile = path.join(newStateDir, "chat-turn-watermarks.json");
      const newNestedFile = path.join(newStateDir, "dkg-adapter", "chat-turn-watermarks.json");
      try {
        fs.mkdirSync(path.dirname(legacyFile), { recursive: true });
        fs.mkdirSync(newStateDir, { recursive: true });
        fs.mkdirSync(path.dirname(newNestedFile), { recursive: true });
        fs.writeFileSync(legacyFile, JSON.stringify({
          "openclaw:tg:::legacy-only": { w: 2, b: 1 },
          "openclaw:tg:::shared": { w: 3, b: 9 },
        }));
        fs.writeFileSync(newNestedFile, JSON.stringify({
          "openclaw:tg:::nested-only": { w: 6, b: 2 },
          "openclaw:tg:::shared": { w: 8, b: 0 },
        }));
        fs.writeFileSync(newFile, JSON.stringify({
          "openclaw:tg:::new-only": { w: 11, b: 4 },
          "openclaw:tg:::shared": { w: 7, b: 1 },
        }));

        const migrated = new ChatTurnWriter({
          client: mockClient,
          logger: mockLogger,
          stateDir: newStateDir,
          stateLayout: "direct",
          legacyStateDirs: [legacyStateDir],
        });
        migrated.flushSync();

        let persisted = JSON.parse(fs.readFileSync(newFile, "utf-8"));
        expect(persisted["openclaw:tg:::legacy-only"]).toEqual({ w: 2, b: 1 });
        expect(persisted["openclaw:tg:::nested-only"]).toEqual({ w: 6, b: 2 });
        expect(persisted["openclaw:tg:::new-only"]).toEqual({ w: 11, b: 4 });
        expect(persisted["openclaw:tg:::shared"]).toEqual({ w: 8, b: 9 });
        expect(fs.existsSync(legacyFile)).toBe(true);
        expect(fs.existsSync(newNestedFile)).toBe(true);

        fs.writeFileSync(newFile, JSON.stringify({
          "openclaw:tg:::shared": { w: 1, b: 1 },
        }));
        const restarted = new ChatTurnWriter({
          client: mockClient,
          logger: mockLogger,
          stateDir: newStateDir,
          stateLayout: "direct",
          legacyStateDirs: [legacyStateDir],
        });
        restarted.flushSync();

        persisted = JSON.parse(fs.readFileSync(newFile, "utf-8"));
        expect(persisted["openclaw:tg:::legacy-only"]).toBeUndefined();
        expect(persisted["openclaw:tg:::shared"]).toEqual({ w: 1, b: 1 });

        fs.writeFileSync(legacyFile, JSON.stringify({
          "openclaw:tg:::legacy-only": { w: 4, b: 4 },
          "openclaw:tg:::shared": { w: 5, b: 5 },
        }));
        const afterLegacyAdvance = new ChatTurnWriter({
          client: mockClient,
          logger: mockLogger,
          stateDir: newStateDir,
          stateLayout: "direct",
          legacyStateDirs: [legacyStateDir],
        });
        afterLegacyAdvance.flushSync();

        persisted = JSON.parse(fs.readFileSync(newFile, "utf-8"));
        expect(persisted["openclaw:tg:::legacy-only"]).toEqual({ w: 4, b: 4 });
        expect(persisted["openclaw:tg:::shared"]).toEqual({ w: 5, b: 5 });
      } finally {
        fs.rmSync(workspace, { recursive: true, force: true });
      }
    });


    it("ignores legacy migration markers when the direct watermark file is missing or corrupt", () => {
      const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "chatturnwriter-legacy-recovery-"));
      const legacyStateDir = path.join(workspace, ".openclaw");
      const newStateDir = path.join(workspace, ".dkg-adapter");
      const legacyFile = path.join(legacyStateDir, "dkg-adapter", "chat-turn-watermarks.json");
      const newFile = path.join(newStateDir, "chat-turn-watermarks.json");
      const sameDirNestedFile = path.join(newStateDir, "dkg-adapter", "chat-turn-watermarks.json");
      try {
        fs.mkdirSync(path.dirname(legacyFile), { recursive: true });
        fs.writeFileSync(legacyFile, JSON.stringify({
          "openclaw:tg:::legacy-recovery": { w: 6, b: 2 },
        }));
        new ChatTurnWriter({
          client: mockClient,
          logger: mockLogger,
          stateDir: newStateDir,
          stateLayout: "direct",
          legacyStateDirs: [legacyStateDir],
        }).flushSync();
        expect(fs.existsSync(`${newFile}.legacy-migrated.json`)).toBe(true);

        fs.unlinkSync(newFile);
        new ChatTurnWriter({
          client: mockClient,
          logger: mockLogger,
          stateDir: newStateDir,
          stateLayout: "direct",
          legacyStateDirs: [legacyStateDir],
        }).flushSync();
        let persisted = JSON.parse(fs.readFileSync(newFile, "utf-8"));
        expect(persisted["openclaw:tg:::legacy-recovery"]).toEqual({ w: 6, b: 2 });

        fs.writeFileSync(newFile, "{not-json");
        fs.mkdirSync(path.dirname(sameDirNestedFile), { recursive: true });
        fs.writeFileSync(sameDirNestedFile, JSON.stringify({
          "openclaw:tg:::same-dir-recovery": { w: 3, b: 1 },
        }));
        new ChatTurnWriter({
          client: mockClient,
          logger: mockLogger,
          stateDir: newStateDir,
          stateLayout: "direct",
          legacyStateDirs: [legacyStateDir],
        }).flushSync();
        persisted = JSON.parse(fs.readFileSync(newFile, "utf-8"));
        expect(persisted["openclaw:tg:::legacy-recovery"]).toEqual({ w: 6, b: 2 });
        expect(persisted["openclaw:tg:::same-dir-recovery"]).toEqual({ w: 3, b: 1 });
      } finally {
        fs.rmSync(workspace, { recursive: true, force: true });
      }
    });
});
