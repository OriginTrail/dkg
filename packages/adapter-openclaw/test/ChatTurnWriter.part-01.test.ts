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


    it("initializes with empty watermarks when state dir is fresh", () => {
      expect((writer as any).cachedWatermarks.size).toBe(0);
    });


    it("writes direct layout watermarks without the legacy dkg-adapter subdirectory", async () => {
      const directStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "chatturnwriter-direct-"));
      const directWriter = new ChatTurnWriter({
        client: mockClient,
        logger: mockLogger,
        stateDir: directStateDir,
        stateLayout: "direct",
      });
      try {
        directWriter.onAgentEnd({
          sessionId: "test-direct",
          messages: [
            { role: "user", content: "direct layout user" },
            { role: "assistant", content: "direct layout assistant" },
          ],
        }, { channelId: "ch", sessionKey: "direct" });
        await new Promise((resolve) => setTimeout(resolve, 150));
        directWriter.flushSync();

        expect(fs.existsSync(path.join(directStateDir, "chat-turn-watermarks.json"))).toBe(true);
        expect(fs.existsSync(path.join(directStateDir, "dkg-adapter", "chat-turn-watermarks.json"))).toBe(false);
      } finally {
        directWriter.flushSync();
        fs.rmSync(directStateDir, { recursive: true, force: true });
      }
    });


    it("validates a loaded stale watermark against empty daemon chat-turn WM before W4a skips", async () => {
      const directStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "chatturnwriter-stale-direct-"));
      const sessionId = "openclaw:tg:acct:conv:sk-stale";
      const directFile = path.join(directStateDir, "chat-turn-watermarks.json");
      const localClient = {
        storeChatTurn: vi.fn().mockResolvedValue(undefined),
        getChatTurnStoreStatus: vi.fn().mockResolvedValue({
          hasAnyChatTurnData: false,
          existingSessionIds: [],
        }),
      };
      const directWriter = new ChatTurnWriter({
        client: localClient,
        logger: mockLogger,
        stateDir: directStateDir,
        stateLayout: "direct",
      });
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
              { role: "user", content: "fresh telegram user" },
              { role: "assistant", content: "fresh telegram reply" },
            ],
          },
          { channelId: "tg", accountId: "acct", conversationId: "conv", sessionKey: "sk-stale" },
        );
        await restarted.flush();

        expect(localClient.getChatTurnStoreStatus).toHaveBeenCalledWith(expect.arrayContaining([sessionId]));
        expect(localClient.storeChatTurn).toHaveBeenCalledTimes(1);
        expect(localClient.storeChatTurn.mock.calls[0][0]).toBe(sessionId);
        expect(localClient.storeChatTurn.mock.calls[0][1]).toBe("fresh telegram user");
        expect(localClient.storeChatTurn.mock.calls[0][2]).toBe("fresh telegram reply");
        const persisted = JSON.parse(fs.readFileSync(directFile, "utf-8"));
        expect(persisted[sessionId]).toEqual({ w: 0, b: 0 });
        restarted.flushSync();
      } finally {
        directWriter.flushSync();
        fs.rmSync(directStateDir, { recursive: true, force: true });
      }
    });


    it("validates migrated legacy stale watermarks against empty daemon chat-turn WM", async () => {
      const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "chatturnwriter-stale-legacy-"));
      const legacyStateDir = path.join(workspace, ".openclaw");
      const newStateDir = path.join(workspace, ".dkg-adapter");
      const legacyFile = path.join(legacyStateDir, "dkg-adapter", "chat-turn-watermarks.json");
      const newFile = path.join(newStateDir, "chat-turn-watermarks.json");
      const sessionId = "openclaw:tg:acct:conv:sk-legacy-stale";
      const localClient = {
        storeChatTurn: vi.fn().mockResolvedValue(undefined),
        getChatTurnStoreStatus: vi.fn().mockResolvedValue({
          hasAnyChatTurnData: false,
          existingSessionIds: [],
        }),
      };
      try {
        fs.mkdirSync(path.dirname(legacyFile), { recursive: true });
        fs.writeFileSync(legacyFile, JSON.stringify({ [sessionId]: { w: 42, b: 0 } }));
        const migrated = new ChatTurnWriter({
          client: localClient,
          logger: mockLogger,
          stateDir: newStateDir,
          stateLayout: "direct",
          legacyStateDirs: [legacyStateDir],
        });
        await migrated.onAgentEnd(
          {
            sessionId,
            messages: [
              { role: "user", content: "after wm recreation" },
              { role: "assistant", content: "stored again" },
            ],
          },
          { channelId: "tg", accountId: "acct", conversationId: "conv", sessionKey: "sk-legacy-stale" },
        );
        await migrated.flush();

        expect(localClient.storeChatTurn).toHaveBeenCalledTimes(1);
        expect(localClient.storeChatTurn.mock.calls[0][0]).toBe(sessionId);
        const persisted = JSON.parse(fs.readFileSync(newFile, "utf-8"));
        expect(persisted[sessionId]).toEqual({ w: 0, b: 0 });
        migrated.flushSync();
      } finally {
        fs.rmSync(workspace, { recursive: true, force: true });
      }
    });


    it("keeps a loaded high watermark when daemon confirms the session exists", async () => {
      const directStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "chatturnwriter-stale-positive-"));
      const sessionId = "openclaw:tg:acct:conv:sk-present";
      const directFile = path.join(directStateDir, "chat-turn-watermarks.json");
      const localClient = {
        storeChatTurn: vi.fn().mockResolvedValue(undefined),
        getChatTurnStoreStatus: vi.fn().mockResolvedValue({
          hasAnyChatTurnData: true,
          existingSessionIds: [sessionId],
        }),
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
              { role: "user", content: "already saved" },
              { role: "assistant", content: "already saved reply" },
            ],
          },
          { channelId: "tg", accountId: "acct", conversationId: "conv", sessionKey: "sk-present" },
        );
        await restarted.flush();

        expect(localClient.getChatTurnStoreStatus).toHaveBeenCalledWith(expect.arrayContaining([sessionId]));
        expect(localClient.storeChatTurn).not.toHaveBeenCalled();
        restarted.flushSync();
      } finally {
        fs.rmSync(directStateDir, { recursive: true, force: true });
      }
    });


    it("preserves loaded direct-channel markers when daemon has chat data but the Telegram session is absent", async () => {
      const directStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "chatturnwriter-stale-external-marker-"));
      const sessionId = "openclaw:tg:acct:conv:shared-sk";
      const externalCursorKey = "openclaw:transcript:shared-sk";
      const directFile = path.join(directStateDir, "chat-turn-watermarks.json");
      const localClient = {
        storeChatTurn: vi.fn().mockResolvedValue(undefined),
        getChatTurnStoreStatus: vi.fn().mockResolvedValue({
          hasAnyChatTurnData: true,
          existingSessionIds: [],
        }),
      };
      try {
        const seeder = new ChatTurnWriter({
          client: localClient,
          logger: mockLogger,
          stateDir: directStateDir,
          stateLayout: "direct",
        });
        await seeder.markExternalTurnPersistedDurable({
          sessionKey: "shared-sk",
          turnId: "ui-turn",
          user: "ui user",
          assistant: "ui assistant",
        });
        seeder.flushSync();
        localClient.storeChatTurn.mockClear();
        localClient.getChatTurnStoreStatus.mockClear();

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
              { role: "user", content: "ui user", context: { channelId: "dkg-ui", turnId: "ui-turn" } },
              { role: "assistant", content: "ui assistant" },
            ],
          },
          { channelId: "tg", accountId: "acct", conversationId: "conv", sessionKey: "shared-sk" },
        );
        await restarted.flush();

        expect(localClient.getChatTurnStoreStatus).toHaveBeenCalledWith(expect.arrayContaining([sessionId]));
        expect(localClient.storeChatTurn).not.toHaveBeenCalled();
        const persisted = JSON.parse(fs.readFileSync(directFile, "utf-8"));
        expect(persisted[sessionId]).toEqual({ w: 0, b: 0 });
        expect(Object.keys(persisted[externalCursorKey]?.m ?? {})).toHaveLength(3);
        restarted.flushSync();
      } finally {
        fs.rmSync(directStateDir, { recursive: true, force: true });
      }
    });


    it("validates daemon WM once then trusts the external cursor key on the hot path", async () => {
      // Regression: an earlier draft kept external cursor keys perpetually
      // marked untrusted while the daemon had any chat-turn data, so every
      // subsequent onAgentEnd re-issued the 2-query getChatTurnStoreStatus
      // round trip even after the first validation already proved the keys
      // were non-stale. Validation is a one-shot operation per
      // untrusted-marked key; lifecycle events (load, migrate, setClient)
      // re-mark it untrusted at the right time.
      const directStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "chatturnwriter-trust-once-"));
      const sessionId = "openclaw:tg:acct:conv:trust-sk";
      const directFile = path.join(directStateDir, "chat-turn-watermarks.json");
      const localClient = {
        storeChatTurn: vi.fn().mockResolvedValue(undefined),
        getChatTurnStoreStatus: vi.fn().mockResolvedValue({
          hasAnyChatTurnData: true,
          existingSessionIds: [sessionId],
        }),
      };
      try {
        const seeder = new ChatTurnWriter({
          client: localClient,
          logger: mockLogger,
          stateDir: directStateDir,
          stateLayout: "direct",
        });
        await seeder.markExternalTurnPersistedDurable({
          sessionKey: "trust-sk",
          turnId: "ui-turn",
          user: "ui user",
          assistant: "ui assistant",
        });
        seeder.flushSync();
        localClient.storeChatTurn.mockClear();
        localClient.getChatTurnStoreStatus.mockClear();

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
              { role: "user", content: "tg user 1" },
              { role: "assistant", content: "tg assistant 1" },
            ],
          },
          { channelId: "tg", accountId: "acct", conversationId: "conv", sessionKey: "trust-sk" },
        );
        await restarted.flush();
        expect(localClient.getChatTurnStoreStatus).toHaveBeenCalledTimes(1);

        await restarted.onAgentEnd(
          {
            sessionId,
            messages: [
              { role: "user", content: "tg user 1" },
              { role: "assistant", content: "tg assistant 1" },
              { role: "user", content: "tg user 2" },
              { role: "assistant", content: "tg assistant 2" },
            ],
          },
          { channelId: "tg", accountId: "acct", conversationId: "conv", sessionKey: "trust-sk" },
        );
        await restarted.flush();
        expect(localClient.getChatTurnStoreStatus).toHaveBeenCalledTimes(1);
        const persistedDoc = JSON.parse(fs.readFileSync(directFile, "utf-8"));
        expect(persistedDoc["openclaw:transcript:trust-sk"]?.m).toBeDefined();
        restarted.flushSync();
      } finally {
        fs.rmSync(directStateDir, { recursive: true, force: true });
      }
    });


    it("does not clear fresh direct-channel markers written while stale daemon validation is in flight", async () => {
      const directStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "chatturnwriter-stale-marker-race-"));
      const sessionId = "openclaw:tg:acct:conv:race-sk";
      const externalCursorKey = "openclaw:transcript:race-sk";
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
        const seeder = new ChatTurnWriter({
          client: localClient,
          logger: mockLogger,
          stateDir: directStateDir,
          stateLayout: "direct",
        });
        await seeder.markExternalTurnPersistedDurable({
          sessionKey: "race-sk",
          turnId: "old-ui-turn",
          user: "old ui user",
          assistant: "old ui assistant",
        });
        seeder.flushSync();
        localClient.storeChatTurn.mockClear();
        localClient.getChatTurnStoreStatus.mockClear();

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
              { role: "user", content: "old ui user", context: { channelId: "dkg-ui", turnId: "old-ui-turn" } },
              { role: "assistant", content: "old ui assistant" },
            ],
          },
          { channelId: "tg", accountId: "acct", conversationId: "conv", sessionKey: "race-sk" },
        );
        for (let i = 0; i < 10 && localClient.getChatTurnStoreStatus.mock.calls.length === 0; i++) {
          await flushMicrotasks();
        }
        expect(localClient.getChatTurnStoreStatus).toHaveBeenCalled();

        await restarted.markExternalTurnPersistedDurable({
          sessionKey: "race-sk",
          turnId: "fresh-ui-turn",
          user: "fresh ui user",
          assistant: "fresh ui assistant",
        });
        resolveStatus({ hasAnyChatTurnData: false, existingSessionIds: [] });
        await restarted.flush();

        expect(localClient.storeChatTurn).not.toHaveBeenCalled();
        const persisted = JSON.parse(fs.readFileSync(directFile, "utf-8"));
        expect(Object.keys(persisted[externalCursorKey]?.m ?? {})).toHaveLength(5);
        restarted.flushSync();
      } finally {
        fs.rmSync(directStateDir, { recursive: true, force: true });
      }
    });
});
