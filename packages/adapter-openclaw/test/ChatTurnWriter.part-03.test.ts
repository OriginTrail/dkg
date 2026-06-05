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


    it("remerges a same-dir nested legacy watermark when its content changes", () => {
      const directStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "chatturnwriter-direct-legacy-"));
      const directFile = path.join(directStateDir, "chat-turn-watermarks.json");
      const nestedFile = path.join(directStateDir, "dkg-adapter", "chat-turn-watermarks.json");
      try {
        fs.mkdirSync(path.dirname(nestedFile), { recursive: true });
        fs.writeFileSync(nestedFile, JSON.stringify({
          "openclaw:tg:::nested-only": { w: 6, b: 2 },
        }));

        const migrated = new ChatTurnWriter({
          client: mockClient,
          logger: mockLogger,
          stateDir: directStateDir,
          stateLayout: "direct",
        });
        migrated.flushSync();

        let persisted = JSON.parse(fs.readFileSync(directFile, "utf-8"));
        expect(persisted["openclaw:tg:::nested-only"]).toEqual({ w: 6, b: 2 });

        fs.writeFileSync(directFile, JSON.stringify({
          "openclaw:tg:::nested-only": { w: 1, b: 1 },
        }));
        const restarted = new ChatTurnWriter({
          client: mockClient,
          logger: mockLogger,
          stateDir: directStateDir,
          stateLayout: "direct",
        });
        restarted.flushSync();

        persisted = JSON.parse(fs.readFileSync(directFile, "utf-8"));
        expect(persisted["openclaw:tg:::nested-only"]).toEqual({ w: 1, b: 1 });
        expect(fs.existsSync(nestedFile)).toBe(true);

        fs.writeFileSync(nestedFile, JSON.stringify({
          "openclaw:tg:::nested-only": { w: 9, b: 3 },
        }));
        const afterNestedAdvance = new ChatTurnWriter({
          client: mockClient,
          logger: mockLogger,
          stateDir: directStateDir,
          stateLayout: "direct",
        });
        afterNestedAdvance.flushSync();

        persisted = JSON.parse(fs.readFileSync(directFile, "utf-8"));
        expect(persisted["openclaw:tg:::nested-only"]).toEqual({ w: 9, b: 3 });
      } finally {
        fs.rmSync(directStateDir, { recursive: true, force: true });
      }
    });


    it("setStateDir remerges same-dir nested legacy watermarks when the direct destination file exists", async () => {
      const oldStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "chatturnwriter-setstate-old-"));
      const directStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "chatturnwriter-setstate-direct-"));
      const directFile = path.join(directStateDir, "chat-turn-watermarks.json");
      const nestedFile = path.join(directStateDir, "dkg-adapter", "chat-turn-watermarks.json");
      const localWriter = new ChatTurnWriter({
        client: mockClient,
        logger: mockLogger,
        stateDir: oldStateDir,
      });
      try {
        fs.mkdirSync(path.dirname(nestedFile), { recursive: true });
        fs.writeFileSync(directFile, JSON.stringify({
          "openclaw:tg:::shared": { w: 1, b: 1 },
        }));
        fs.writeFileSync(nestedFile, JSON.stringify({
          "openclaw:tg:::shared": { w: 9, b: 9 },
        }));

        await localWriter.setStateDir(directStateDir, { stateLayout: "direct" });
        localWriter.flushSync();

        const persisted = JSON.parse(fs.readFileSync(directFile, "utf-8"));
        expect(persisted["openclaw:tg:::shared"]).toEqual({ w: 9, b: 9 });
        expect(fs.existsSync(nestedFile)).toBe(true);
      } finally {
        localWriter.flushSync();
        fs.rmSync(oldStateDir, { recursive: true, force: true });
        fs.rmSync(directStateDir, { recursive: true, force: true });
      }
    });


    it("setStateDir remerges same-dir direct watermarks when switching to nested layout", async () => {
      const oldStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "chatturnwriter-setstate-old-"));
      const nestedStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "chatturnwriter-setstate-nested-"));
      const directFile = path.join(nestedStateDir, "chat-turn-watermarks.json");
      const nestedFile = path.join(nestedStateDir, "dkg-adapter", "chat-turn-watermarks.json");
      const localWriter = new ChatTurnWriter({
        client: mockClient,
        logger: mockLogger,
        stateDir: oldStateDir,
      });
      try {
        fs.mkdirSync(path.dirname(nestedFile), { recursive: true });
        fs.writeFileSync(directFile, JSON.stringify({
          "openclaw:tg:::direct-only": { w: 8, b: 2 },
          "openclaw:tg:::shared": { w: 9, b: 1 },
        }));
        fs.writeFileSync(nestedFile, JSON.stringify({
          "openclaw:tg:::nested-only": { w: 3, b: 4 },
          "openclaw:tg:::shared": { w: 4, b: 6 },
        }));
        (localWriter as any).cachedWatermarks.set("openclaw:tg:::source-only", 5);
        (localWriter as any).w4bSessionCounts.set("openclaw:tg:::source-only", 2);

        await localWriter.setStateDir(nestedStateDir, { stateLayout: "nested" });
        localWriter.flushSync();

        const persisted = JSON.parse(fs.readFileSync(nestedFile, "utf-8"));
        expect(persisted["openclaw:tg:::direct-only"]).toEqual({ w: 8, b: 2 });
        expect(persisted["openclaw:tg:::nested-only"]).toEqual({ w: 3, b: 4 });
        expect(persisted["openclaw:tg:::shared"]).toEqual({ w: 9, b: 6 });
        expect(persisted["openclaw:tg:::source-only"]).toEqual({ w: 5, b: 2 });
        expect(fs.existsSync(directFile)).toBe(true);
      } finally {
        localWriter.flushSync();
        fs.rmSync(oldStateDir, { recursive: true, force: true });
        fs.rmSync(nestedStateDir, { recursive: true, force: true });
      }
    });


    it("calls storeChatTurn on onAgentEnd with ctx", async () => {
      const event: AgentEndContext = {
        sessionId: "test-session",
        messages: [
          { role: "user", content: "test message" },
          { role: "assistant", content: "test response" },
        ],
      };
      writer.onAgentEnd(event, { channelId: "slack", sessionKey: "key123" });
      await flushMicrotasks();
      expect(mockClient.storeChatTurn).toHaveBeenCalled();
    });


    it("skips persist when ctx missing", async () => {
      const event: AgentEndContext = {
        sessionId: "test",
        messages: [{ role: "user", content: "test" }],
      };
      writer.onAgentEnd(event);
      await flushMicrotasks();
      expect(mockClient.storeChatTurn).not.toHaveBeenCalled();
    });


    it("skips persist when no messages", async () => {
      const event: AgentEndContext = { sessionId: "test", messages: [] };
      writer.onAgentEnd(event, { channelId: "ch1", sessionKey: "sk1" });
      await flushMicrotasks();
      expect(mockClient.storeChatTurn).not.toHaveBeenCalled();
    });


    it("extracts text from string content", async () => {
      const event: AgentEndContext = {
        sessionId: "test",
        messages: [
          { role: "user", content: "hello world" },
          { role: "assistant", content: "hi there" },
        ],
      };
      writer.onAgentEnd(event, { channelId: "ch", sessionKey: "sk" });
      await flushMicrotasks();
      // T29 / T33 — A deterministic, content+discriminator-derived `turnId`
      // is now passed to the daemon. W4a's id includes pairIndex; W4b's
      // includes messageId. The id is restart-durable: a crash mid-flush
      // followed by replay computes the same hash and writes to the same
      // RDF subject URI on the daemon (idempotent overwrite, not a
      // duplicate ChatTurn subject).
      expect(mockClient.storeChatTurn).toHaveBeenCalledWith(
        "openclaw:ch:::sk",
        "hello world",
        "hi there",
        expect.objectContaining({ turnId: expect.any(String) }),
      );
    });


    it("T29 — persistOne retries pass the SAME turnId so the daemon dedups", async () => {
      // Regression for T29: pre-fix `persistOne` passed no turnId, so a
      // transient daemon timeout after the first POST committed produced
      // a duplicate chat turn on the retry (the daemon minted a fresh
      // UUID per call). Post-fix retries within one persistOne invocation
      // share the same caller-supplied id.
      let callCount = 0;
      const turnIds: Array<string | undefined> = [];
      mockClient.storeChatTurn = vi.fn().mockImplementation(async (_sid, _u, _a, opts) => {
        callCount++;
        turnIds.push(opts?.turnId);
        if (callCount === 1) throw new Error("transient daemon timeout");
        // Second call (retry) succeeds.
      });
      writer = new ChatTurnWriter({ client: mockClient, logger: mockLogger, stateDir });
      const event: AgentEndContext = {
        sessionId: "test",
        messages: [
          { role: "user", content: "u1" },
          { role: "assistant", content: "a1" },
        ],
      };
      writer.onAgentEnd(event, { channelId: "ch", sessionKey: "sk" });
      // Wait for retry to settle (250ms backoff inside persistOne).
      await new Promise((r) => setTimeout(r, 600));
      expect(callCount).toBe(2);
      expect(turnIds[0]).toBeDefined();
      expect(turnIds[1]).toBe(turnIds[0]); // same id across retry
    });


    it("T33 — daemon turnId is deterministic across writer instances (restart-idempotent)", async () => {
      // Regression for T33: pre-fix the daemon-facing id was a fresh
      // randomUUID per persistOne invocation, which made retries
      // idempotent only WITHIN the current process. A crash after a
      // successful POST but before the watermark debounce flushed to
      // disk produced a NEW UUID on restart and therefore a duplicate
      // ChatTurn subject on the daemon. Post-fix the id is a hash of
      // the deterministic identity (sessionId + user + assistant +
      // pairIndex for W4a), so a fresh writer instance computing the
      // SAME inputs produces the SAME hash — the daemon receives the
      // POST under the same subject URI and overwrites idempotently.
      const seenIds: string[] = [];
      mockClient.storeChatTurn = vi.fn().mockImplementation(async (_sid, _u, _a, opts) => {
        seenIds.push(opts?.turnId);
      });
      const event: AgentEndContext = {
        sessionId: "test",
        messages: [
          { role: "user", content: "deterministic-user-1" },
          { role: "assistant", content: "deterministic-assistant-1" },
        ],
      };
      // First writer instance.
      writer = new ChatTurnWriter({ client: mockClient, logger: mockLogger, stateDir });
      writer.onAgentEnd(event, { channelId: "ch", sessionKey: "sk" });
      await flushMicrotasks();
      // Simulate process restart: fresh writer, same inputs.
      const stateDir2 = fs.mkdtempSync(path.join(os.tmpdir(), "chatturnwriter-t33-"));
      try {
        const writer2 = new ChatTurnWriter({ client: mockClient, logger: mockLogger, stateDir: stateDir2 });
        writer2.onAgentEnd(event, { channelId: "ch", sessionKey: "sk" });
        await flushMicrotasks();
        writer2.flushSync();
      } finally {
        try { fs.rmSync(stateDir2, { recursive: true, force: true }); } catch { /* best effort */ }
      }
      expect(seenIds.length).toBe(2);
      expect(seenIds[0]).toBe(seenIds[1]); // restart-idempotent
    });


    it("extracts text from array content", async () => {
      const event: AgentEndContext = {
        sessionId: "test",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "part1" },
              { type: "text", text: "part2" },
            ],
          },
          { role: "assistant", content: [{ type: "text", text: "resp" }] },
        ],
      };
      writer.onAgentEnd(event, { channelId: "ch", sessionKey: "sk" });
      await flushMicrotasks();
      expect(mockClient.storeChatTurn).toHaveBeenCalled();
    });


    it("strips well-formed <recalled-memory data-source=\"dkg-auto-recall\"> block from assistant text before persist (I1)", async () => {
      const event: AgentEndContext = {
        sessionId: "test",
        messages: [
          { role: "user", content: "query" },
          {
            role: "assistant",
            content: "prefix <recalled-memory data-source=\"dkg-auto-recall\">\n[1] (agent-context-wm) secret\n</recalled-memory> suffix",
          },
        ],
      };
      writer.onAgentEnd(event, { channelId: "ch", sessionKey: "sk" });
      await flushMicrotasks();
      const call = mockClient.storeChatTurn.mock.calls[0];
      expect(call[2]).not.toContain("recalled-memory");
      expect(call[2]).not.toContain("secret");
      expect(call[2]).toContain("prefix");
      expect(call[2]).toContain("suffix");
    });


    it("R23.3 — stripRecalledMemory matches sentinel with single-quoted attribute value", async () => {
      // Regression for R23.3: pre-fix, the sentinel regex required
      // double-quoted `data-source="dkg-auto-recall"`. A model echoing
      // the injected block as `data-source='dkg-auto-recall'` (single
      // quotes) survived the strip and boomeranged into chat memory.
      const event = {
        sessionId: "test",
        messages: [
          { role: "user" as const, content: "Recall something" },
          {
            role: "assistant" as const,
            content:
              "prefix <recalled-memory data-source='dkg-auto-recall'>\n[1] (agent-context-wm) secret\n</recalled-memory> suffix",
          },
        ],
      };
      writer.onAgentEnd(event, { channelId: "ch", sessionKey: "sk" });
      await flushMicrotasks();
      const call = mockClient.storeChatTurn.mock.calls[0];
      // Single-quoted sentinel must be stripped just like the double-quoted
      // form — no `recalled-memory` substring should survive in the persist.
      expect(call[2]).not.toContain("recalled-memory");
      expect(call[2]).not.toContain("secret");
      expect(call[2]).toContain("prefix");
    });


    it("R15.3 — preserves user-emitted plain <recalled-memory> literals (no sentinel) in assistant text", async () => {
      // Regression for R15.3: stripping must only target the auto-injected
      // block carrying `data-source=\"dkg-auto-recall\"`. Plain literals an
      // agent emits while answering questions about XML, debugging, or
      // documentation must survive verbatim in the persisted transcript.
      const event = {
        sessionId: "test",
        messages: [
          { role: "user" as const, content: "Show me an example XML element" },
          {
            role: "assistant" as const,
            content: 'Here is an example tag: <recalled-memory>verbatim user content</recalled-memory> done',
          },
        ],
      };
      writer.onAgentEnd(event, { channelId: "ch", sessionKey: "sk" });
      await flushMicrotasks();
      const call = mockClient.storeChatTurn.mock.calls[0];
      expect(call[2]).toContain("<recalled-memory>verbatim user content</recalled-memory>");
    });


    it("strips orphaned <recalled-memory> open tag when closing tag is missing (I1 truncation)", async () => {
      const event: AgentEndContext = {
        sessionId: "test",
        messages: [
          { role: "user", content: "query" },
          {
            role: "assistant",
            content: "answer text <recalled-memory data-source=\"dkg-auto-recall\">\n[1] (agent-context-wm) truncated",
          },
        ],
      };
      writer.onAgentEnd(event, { channelId: "ch", sessionKey: "sk" });
      await flushMicrotasks();
      const call = mockClient.storeChatTurn.mock.calls[0];
      expect(call[2]).toBe("answer text");
    });


    it("T380 - W4a strips leading Conversation info and Sender metadata from persisted user text", async () => {
      const event: AgentEndContext = {
        sessionId: "test",
        messages: [
          { role: "user", content: telegramWrappedUserText("hello") },
          { role: "assistant", content: "reply" },
        ],
      };

      writer.onAgentEnd(event, { channelId: "telegram", sessionKey: "sk" });
      await flushMicrotasks();

      const [, persistedUser] = mockClient.storeChatTurn.mock.calls[0];
      expect(persistedUser).toBe("hello");
      expect(persistedUser).not.toContain("Conversation info");
      expect(persistedUser).not.toContain("Sender");
      expect(persistedUser).not.toContain("chat_id");
      expect(persistedUser).not.toContain("sender_id");
      expect(persistedUser).not.toContain("username");
      expect(persistedUser).not.toContain("timestamp");
    });
});
