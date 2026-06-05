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


    it("T100 - sync watermark writes include unrelated pending debounce snapshots", async () => {
      const pendingSession = "openclaw:tg:::pending";
      const syncSession = "openclaw:tg:::sync";
      (writer as any).saveWatermark(pendingSession, 4);
      (writer as any).saveWatermark(syncSession, 2);
      (writer as any).w4bSessionCounts.set(syncSession, 1);

      expect((writer as any).debounceTimers.has(pendingSession)).toBe(true);
      expect((writer as any).debounceTimers.has(syncSession)).toBe(true);
      expect((writer as any).cachedWatermarks.has(pendingSession)).toBe(false);
      expect((writer as any).commitWatermarkStateSync(syncSession)).toBe(true);

      const persisted = JSON.parse(fs.readFileSync(
        path.join(stateDir, "dkg-adapter", "chat-turn-watermarks.json"),
        "utf-8",
      ));
      expect(persisted[pendingSession].w).toBe(4);
      expect(persisted[syncSession].w).toBe(2);
      expect(persisted[syncSession].b).toBe(1);
      expect((writer as any).debounceTimers.has(pendingSession)).toBe(true);
      expect((writer as any).debounceTimers.has(syncSession)).toBe(false);
      expect((writer as any).cachedWatermarks.has(pendingSession)).toBe(false);
      expect((writer as any).cachedWatermarks.get(syncSession)).toBe(2);

      const restarted = new ChatTurnWriter({ client: mockClient, logger: mockLogger, stateDir });
      expect((restarted as any).cachedWatermarks.get(pendingSession)).toBe(4);
      expect((restarted as any).cachedWatermarks.get(syncSession)).toBe(2);
      expect((restarted as any).w4bSessionCounts.get(syncSession)).toBe(1);
      restarted.flushSync();
    });


    it("T81 — before_reset can use event payload identity and clears stale W4b state", async () => {
      writer.onMessageReceived({
        sessionKey: "sk",
        context: { channelId: "tg", content: "before reset", messageId: "in-1" },
      } as any);
      await writer.onMessageSent({
        sessionKey: "sk",
        context: { channelId: "tg", content: "old reply", success: true, messageId: "out-1" },
      } as any);
      await flushMicrotasks();
      expect((writer as any).w4bSessionCounts.get("openclaw:tg:::sk")).toBe(1);

      mockClient.storeChatTurn.mockClear();
      await writer.onBeforeReset({ channelId: "tg", sessionKey: "sk" });
      expect((writer as any).w4bSessionCounts.get("openclaw:tg:::sk")).toBeUndefined();

      writer.onAgentEnd({
        sessionId: "test",
        messages: [
          { role: "user", content: "after reset" },
          { role: "assistant", content: "new reply" },
        ],
      }, { channelId: "tg", sessionKey: "sk" });
      await flushMicrotasks();

      expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(1);
      expect(mockClient.storeChatTurn.mock.calls[0][1]).toBe("after reset");
    });


    it("T101 - reset awaits only pre-gate W4a chains", async () => {
      const sessionId = "openclaw:tg:::sk";
      const chains = (writer as any).w4aSessionChains as Map<string, Promise<void>>;
      const originalGet = chains.get.bind(chains);
      let lookedUpPostGateChain = false;
      (chains as any).get = (key: string) => {
        if (key === sessionId && (writer as any).pendingResets.has(sessionId)) {
          lookedUpPostGateChain = true;
          const reset = (writer as any).pendingResets.get(sessionId) as Promise<void>;
          const postGateChain = reset.then(() => undefined);
          chains.set(sessionId, postGateChain);
          return postGateChain;
        }
        return originalGet(key);
      };

      try {
        const result = await Promise.race([
          (writer as any).runReset({ sessionId }).then(() => "done"),
          new Promise((resolve) => setTimeout(() => resolve("timeout"), 80)),
        ]);

        expect(result).toBe("done");
        expect(lookedUpPostGateChain).toBe(false);
      } finally {
        delete (chains as any).get;
      }
    });


    it("T95 — partial reset identity does not clear sibling thread state", async () => {
      writer.onMessageReceived({
        sessionKey: "sk",
        context: {
          channelId: "tg",
          accountId: "acct",
          conversationId: "thread-2",
          content: "sibling question",
          messageId: "sibling-in",
        },
      } as any);

      await writer.onBeforeReset({ channelId: "tg", sessionKey: "sk" });
      await writer.onMessageSent({
        sessionKey: "sk",
        context: {
          channelId: "tg",
          accountId: "acct",
          conversationId: "thread-2",
          content: "sibling answer",
          success: true,
          messageId: "sibling-out",
        },
      } as any);
      await flushMicrotasks();

      expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(1);
      expect(mockClient.storeChatTurn.mock.calls[0][1]).toBe("sibling question");
    });


    it("T82 — durable external direct-channel marker prevents restart backfill by W4a", async () => {
      await writer.markExternalTurnPersistedDurable({
        sessionKey: "agent:main:main",
        turnId: "node-ui-corr-1",
        user: "node ui question",
        assistant: "node ui answer",
      });

      const restarted = new ChatTurnWriter({ client: mockClient, logger: mockLogger, stateDir });
      mockClient.storeChatTurn.mockClear();
      restarted.onAgentEnd({
        sessionId: "test",
        messages: [
          { role: "user", content: "node ui question", context: { Provider: "dkg-ui", DkgTurnId: "node-ui-corr-1" } },
          { role: "assistant", content: "node ui answer" },
          { role: "user", content: "telegram question" },
          { role: "assistant", content: "telegram answer" },
        ],
      }, { channelId: "telegram", sessionKey: "agent:main:main" });
      await flushMicrotasks();

      expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(1);
      expect(mockClient.storeChatTurn.mock.calls[0][1]).toBe("telegram question");
      restarted.flushSync();
    });


    it("T457 — direct-channel marker aliases skip formatted OpenClaw transcript bodies with assistant render drift", async () => {
      await writer.onAgentEnd({
        sessionId: "seed",
        messages: [
          { role: "user", content: "previous telegram question" },
          { role: "assistant", content: "previous telegram answer" },
        ],
      }, { channelId: "telegram", sessionKey: "agent:main:main" });
      await flushMicrotasks();
      mockClient.storeChatTurn.mockClear();

      await writer.markExternalTurnPersistedDurable({
        sessionKey: "agent:main:main",
        turnId: "node-ui-corr-formatted",
        user: "raw ui question",
        userAliases: ["[DKG UI Owner] raw ui question"],
        assistant: "node ui answer",
      });

      await writer.onAgentEnd({
        sessionId: "test",
        messages: [
          { role: "user", content: "previous telegram question" },
          { role: "assistant", content: "previous telegram answer" },
          {
            role: "user",
            content: "[DKG UI Owner] raw ui question",
            context: { Provider: "dkg-ui", DkgTurnId: "node-ui-corr-formatted" },
          },
          { role: "assistant", content: "[DKG UI delivered] node ui answer" },
          { role: "user", content: "next telegram question" },
          { role: "assistant", content: "next telegram answer" },
        ],
      }, { channelId: "telegram", sessionKey: "agent:main:main" });
      await flushMicrotasks();

      expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(1);
      expect(mockClient.storeChatTurn.mock.calls[0][1]).toBe("next telegram question");
      writer.flushSync();
    });


    it("T457 — ordered direct-channel marker skips metadata-stripped UI backfill before live Telegram pair", async () => {
      await writer.onAgentEnd({
        sessionId: "seed",
        messages: [
          { role: "user", content: "previous telegram question" },
          { role: "assistant", content: "previous telegram answer" },
        ],
      }, { channelId: "telegram", sessionKey: "agent:main:main" });
      await flushMicrotasks();
      mockClient.storeChatTurn.mockClear();

      await writer.markExternalTurnPersistedDurable({
        sessionKey: "agent:main:main",
        turnId: "node-ui-corr-stripped",
        user: "raw ui question",
        assistant: "node ui answer",
      });

      await writer.onAgentEnd({
        sessionId: "test",
        messages: [
          { role: "user", content: "previous telegram question" },
          { role: "assistant", content: "previous telegram answer" },
          { role: "user", content: "raw ui question" },
          { role: "assistant", content: "[DKG UI delivered] rendered transcript answer" },
          { role: "user", content: "next telegram question" },
          { role: "assistant", content: "next telegram answer" },
        ],
      }, { channelId: "telegram", sessionKey: "agent:main:main" });
      await flushMicrotasks();

      expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(1);
      expect(mockClient.storeChatTurn.mock.calls[0][1]).toBe("next telegram question");
      writer.flushSync();
    });


    it("T457 — ordered direct-channel marker does not skip the live pair when no historical pair is present", async () => {
      await writer.markExternalTurnPersistedDurable({
        sessionKey: "agent:main:main",
        turnId: "node-ui-corr-missing",
        user: "ui question not in transcript",
        assistant: "ui answer not in transcript",
      });

      await writer.onAgentEnd({
        sessionId: "test",
        messages: [
          { role: "user", content: "telegram only question" },
          { role: "assistant", content: "telegram only answer" },
        ],
      }, { channelId: "telegram", sessionKey: "agent:main:main" });
      await flushMicrotasks();

      expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(1);
      expect(mockClient.storeChatTurn.mock.calls[0][1]).toBe("telegram only question");
      writer.flushSync();
    });


    it("T458 — N direct persists accumulate ordered tickets for N metadata-stripped UI backfill pairs", async () => {
      // Seed prior Telegram persistence so savedUpTo > -1 and the
      // cold-start clamp does not pre-drop historical UI pairs. This
      // mirrors the live UI -> first Telegram regression: by the time
      // the first Telegram agent_end fires after multiple direct UI
      // persists, the OpenClaw transcript already carries every UI pair
      // but their direct-channel metadata has been stripped, so only
      // the ordered marker fallback can dedupe them.
      await writer.onAgentEnd({
        sessionId: "seed",
        messages: [
          { role: "user", content: "previous telegram question" },
          { role: "assistant", content: "previous telegram answer" },
        ],
      }, { channelId: "telegram", sessionKey: "agent:main:main" });
      await flushMicrotasks();
      mockClient.storeChatTurn.mockClear();

      await writer.markExternalTurnPersistedDurable({
        sessionKey: "agent:main:main",
        turnId: "node-ui-corr-1",
        user: "raw ui question 1",
        assistant: "node ui answer 1",
      });
      await writer.markExternalTurnPersistedDurable({
        sessionKey: "agent:main:main",
        turnId: "node-ui-corr-2",
        user: "raw ui question 2",
        assistant: "node ui answer 2",
      });
      await writer.markExternalTurnPersistedDurable({
        sessionKey: "agent:main:main",
        turnId: "node-ui-corr-3",
        user: "raw ui question 3",
        assistant: "node ui answer 3",
      });

      await writer.onAgentEnd({
        sessionId: "test",
        messages: [
          { role: "user", content: "previous telegram question" },
          { role: "assistant", content: "previous telegram answer" },
          { role: "user", content: "raw ui question 1" },
          { role: "assistant", content: "[DKG UI delivered] rendered transcript answer 1" },
          { role: "user", content: "raw ui question 2" },
          { role: "assistant", content: "[DKG UI delivered] rendered transcript answer 2" },
          { role: "user", content: "raw ui question 3" },
          { role: "assistant", content: "[DKG UI delivered] rendered transcript answer 3" },
          { role: "user", content: "next telegram question" },
          { role: "assistant", content: "next telegram answer" },
        ],
      }, { channelId: "telegram", sessionKey: "agent:main:main" });
      await flushMicrotasks();

      expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(1);
      expect(mockClient.storeChatTurn.mock.calls[0][1]).toBe("next telegram question");
      writer.flushSync();
    });


    it("T459 — ordered fallback runs for an earlier metadata-stripped UI pair even when a later pair carries an exact marker for a DIFFERENT direct turn", async () => {
      // Mixed-metadata regression from PR #457 review round (Codex review
      // comment on `laterExactExternalMarker`). Transcript shape: an
      // earlier UI pair has lost its DkgTurnId, a later UI pair still
      // carries DkgTurnId, then live Telegram. The pre-fix gating
      // disabled ordered fallback for the earlier pair because SOME
      // later exact marker existed in the bucket — even though that
      // marker's content didn't match the earlier pair. After the fix,
      // ordered fallback is only blocked when the later exact marker's
      // `(turnId, user, assistant)` actually matches THIS pair's
      // content; otherwise the earlier stripped pair is correctly
      // ordered-skipped.
      await writer.onAgentEnd({
        sessionId: "seed",
        messages: [
          { role: "user", content: "previous telegram question" },
          { role: "assistant", content: "previous telegram answer" },
        ],
      }, { channelId: "telegram", sessionKey: "agent:main:main" });
      await flushMicrotasks();
      mockClient.storeChatTurn.mockClear();

      await writer.markExternalTurnPersistedDurable({
        sessionKey: "agent:main:main",
        turnId: "node-ui-corr-older-stripped",
        user: "older ui question",
        assistant: "older ui answer",
      });
      await writer.markExternalTurnPersistedDurable({
        sessionKey: "agent:main:main",
        turnId: "node-ui-corr-newer-with-id",
        user: "newer ui question",
        assistant: "newer ui answer",
      });

      await writer.onAgentEnd({
        sessionId: "test",
        messages: [
          { role: "user", content: "previous telegram question" },
          { role: "assistant", content: "previous telegram answer" },
          { role: "user", content: "older ui question" },
          { role: "assistant", content: "older ui answer" },
          {
            role: "user",
            content: "newer ui question",
            context: { Provider: "dkg-ui", DkgTurnId: "node-ui-corr-newer-with-id" },
          },
          { role: "assistant", content: "newer ui answer" },
          { role: "user", content: "next telegram question" },
          { role: "assistant", content: "next telegram answer" },
        ],
      }, { channelId: "telegram", sessionKey: "agent:main:main" });
      await flushMicrotasks();

      expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(1);
      expect(mockClient.storeChatTurn.mock.calls[0][1]).toBe("next telegram question");
      writer.flushSync();
    });
});
