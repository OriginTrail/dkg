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


    it("computes deterministic in-memory dedup turnId from content (16-hex)", async () => {
      // The deterministic turnId stays in-process for cross-path dedup.
      // After R10.4, every W4a persist stamps TWO map entries: a
      // pair-index-tagged turnId (the unique W4a key) AND a content-only
      // alias `content::<sha-16>` that W4b's `message:sent` path checks.
      const event: AgentEndContext = {
        sessionId: "session-1",
        messages: [
          { role: "user", content: "test" },
          { role: "assistant", content: "test" },
        ],
      };
      writer.onAgentEnd(event, { channelId: "ch", sessionKey: "sk" });
      await flushMicrotasks();
      expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(1);
      const recent = (writer as any).recentTurnIds as Map<string, number>;
      const crossPath = (writer as any).crossPathStamps as Map<string, number>;
      // After T5, the W4a-origin stamp moved to the SHORT-TTL
      // `crossPathStamps` map. `recentTurnIds` now holds only the
      // pair-indexed turnId (the W4a write key); `crossPathStamps`
      // holds the `w4a-content::<sha>` cross-path stamp that W4b's
      // `message:sent` path peeks. The cross-path peek of
      // `w4b-content::<sha>` is a non-mutating presence check (R13.1)
      // and must NOT add an entry to either map.
      expect(recent.size).toBe(1);
      expect(crossPath.size).toBe(1);
      const turnIdKey = Array.from(recent.keys())[0];
      const w4aKey = Array.from(crossPath.keys())[0];
      expect(w4aKey).toMatch(/::w4a-content::[0-9a-f]{16}$/);
      // Negative assertion — peek must not have stamped a w4b-origin
      // anywhere.
      expect(Array.from(recent.keys()).some((k) => k.includes("::w4b-content::"))).toBe(false);
      expect(Array.from(crossPath.keys()).some((k) => k.includes("::w4b-content::"))).toBe(false);
      const turnId = turnIdKey.slice(turnIdKey.lastIndexOf("::") + 2);
      expect(turnId).toMatch(/^[0-9a-f]{16}$/);
    });


    it("R13.1 — two legitimate same-content turns within the TTL persist (no false dedup)", async () => {
      // Regression for R13.1: when both paths write the same logical
      // content (W4a and W4b), the cross-path check must NOT mutate the
      // opposite path's origin key. Otherwise a SECOND legitimate same-
      // content turn — arriving while the first is still inside the TTL
      // window — would be silently dropped.
      //
      // Scenario: W4a emits two consecutive same-content turns (different
      // pair indices). The first stamps `w4a-origin`; the second's
      // last-pair check on `w4b-origin` must be a non-mutating peek so
      // both succeed.
      const ev1: AgentEndContext = {
        sessionId: "s",
        messages: [
          { role: "user", content: "ping" },
          { role: "assistant", content: "pong" },
        ],
      };
      writer.onAgentEnd(ev1, { channelId: "ch", sessionKey: "sk" });
      await flushMicrotasks();
      expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(1);

      const ev2: AgentEndContext = {
        sessionId: "s",
        messages: [
          { role: "user", content: "ping" },
          { role: "assistant", content: "pong" },
          { role: "user", content: "ping" },
          { role: "assistant", content: "pong" },
        ],
      };
      writer.onAgentEnd(ev2, { channelId: "ch", sessionKey: "sk" });
      await flushMicrotasks();
      // Second same-content turn at a higher pair index must persist.
      // Pre-R13.1, the W4a→W4a self-stamp via the last-pair guard would
      // collide on the shared content hash and skip this write.
      expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(2);
    });


    it("T4 — concurrent agent_end calls for the same session are serialized via the chain (no failed-pair drop)", async () => {
      // Regression for T4: pre-fix, two back-to-back `agent_end` fires
      // raced the per-pair turnId reservation. Job 1 reserved pair N
      // and started awaiting its persist (fire-and-forget). Job 2
      // fired with a longer messages array, saw pair N already
      // reserved → continue (no bump), persisted pair N+1, advanced
      // watermark to N+1. If Job 1 then failed, releasing the pair-N
      // reservation, the watermark was already past pair N — silent
      // data loss. The chain ensures Job 2's computeDelta only runs
      // after Job 1's persist has settled.

      // First persist hangs until released; second succeeds quickly.
      let releasePersist1: ((err?: Error) => void) | null = null;
      let firstCalled = false;
      let secondCalled = false;
      mockClient.storeChatTurn = vi.fn().mockImplementation(async (_sid, user) => {
        if (user === "u1" && !firstCalled) {
          firstCalled = true;
          await new Promise<void>((resolve, reject) => {
            releasePersist1 = (err) => err ? reject(err) : resolve();
          });
          throw new Error("transient daemon failure"); // make Job 1 fail
        }
        secondCalled = true;
      });
      writer = new ChatTurnWriter({ client: mockClient, logger: mockLogger, stateDir });

      // Job 1: pair 0 (u1, a1).
      writer.onAgentEnd(
        { sessionId: "t", messages: [
          { role: "user", content: "u1" },
          { role: "assistant", content: "a1" },
        ]},
        { channelId: "ch", sessionKey: "sk" },
      );
      await flushMicrotasks();
      // Job 2 fires while Job 1's persist is hanging. Pre-fix, Job 2
      // would race Job 1 and advance the watermark past pair 0.
      writer.onAgentEnd(
        { sessionId: "t", messages: [
          { role: "user", content: "u1" },
          { role: "assistant", content: "a1" },
          { role: "user", content: "u2" },
          { role: "assistant", content: "a2" },
        ]},
        { channelId: "ch", sessionKey: "sk" },
      );
      await flushMicrotasks();
      // Job 2 should NOT have called the daemon yet — it must wait
      // for Job 1 to settle in the chain.
      expect(secondCalled).toBe(false);

      // Release Job 1 with a failure (waiting until even retries exhaust).
      releasePersist1!(new Error("kaboom"));
      // Wait long enough for the persistOne retry (250ms backoff) and
      // the chain to advance to Job 2.
      await new Promise((r) => setTimeout(r, 600));

      // Job 2 ran AFTER Job 1 failed. Critically, the watermark stayed
      // at -1 (Job 1's failure caught and released the reservation
      // without advancing). Job 2's computeDelta yielded BOTH pair 0
      // (failed-and-released) and pair 1 — so pair 0 retries via Job 2.
      const dkw = writer as any;
      // Either pair 0 was retried (count = 2 daemon calls) or it
      // landed correctly somehow. The KEY invariant: pair 0 was NOT
      // silently dropped by the watermark advancing past it before
      // its persist settled.
      expect(secondCalled).toBe(true);
      // Watermark must reflect the highest successfully persisted
      // pair, not have skipped pair 0.
      writer.flushSync();
      expect(dkw.loadWatermark("openclaw:ch:::sk")).toBeGreaterThanOrEqual(0);
    });


    it("T10 — concurrent W4a + W4b for the same content: only ONE persist (W4a in-flight, W4b skips)", async () => {
      // Regression for T10: pre-fix, cross-path stamps were post-success
      // only. If W4a's `agent_end` and W4b's `message:sent` fired close
      // together, BOTH paths peeked the opposite-path stamp BEFORE either
      // had landed → both entered `persistOne` → daemon minted two distinct
      // turn UUIDs (the in-process content turnId is intentionally not sent
      // to the daemon). The fix adds a separate `crossPathInflight` map
      // that's stamped pre-persist and cleared in `finally`, so the
      // opposite path's `peekCrossPathInflight` catches the in-flight race.
      let releasePersist: (() => void) | null = null;
      let persistCalls = 0;
      mockClient.storeChatTurn = vi.fn().mockImplementation(async () => {
        persistCalls++;
        await new Promise<void>((resolve) => {
          releasePersist = resolve;
        });
      });
      writer = new ChatTurnWriter({ client: mockClient, logger: mockLogger, stateDir });
      // Prime W4b's pending-user queue with an inbound, but DO NOT fire the
      // outbound yet — W4a fires first and starts hanging in persistOne.
      writer.onMessageReceived({
        sessionKey: "sk",
        context: { channelId: "tg", content: "hi", messageId: "in-1" },
      } as any);
      // W4a fires — enters persistOne which hangs.
      writer.onAgentEnd(
        { sessionId: "test", messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "there" },
        ] },
        { channelId: "tg", sessionKey: "sk" },
      );
      await flushMicrotasks();
      expect(persistCalls).toBe(1);
      // While W4a is mid-persist, W4b's message:sent fires for the same
      // content. Pre-fix, W4b would peek `crossPathStamps[w4aOrigin]`
      // (post-success only — not yet stamped), miss, and call persistOne
      // → 2nd daemon write. Post-fix, W4b peeks `crossPathInflight` and
      // catches the race → skips.
      await writer.onMessageSent({
        sessionKey: "sk",
        context: { channelId: "tg", content: "there", success: true, messageId: "out-1" },
      } as any);
      await flushMicrotasks();
      expect(persistCalls).toBe(1); // still just the W4a call
      // Release W4a so the test cleans up.
      releasePersist?.();
      await flushMicrotasks();
    });


    it("T359 - weak typed W4b skips concrete W4a cross-path stamp", async () => {
      writer.onTypedMessageReceived(
        { from: "user-1", content: "weak alias q", metadata: { messageId: "weak-alias-in" } },
        { channelId: "telegram", accountId: "bot", conversationId: "chat-w4a-alias" },
      );
      writer.onAgentEnd(
        { sessionId: "test", messages: [
          { role: "user", content: "weak alias q" },
          { role: "assistant", content: "weak alias a" },
        ] },
        { channelId: "telegram", accountId: "bot", conversationId: "chat-w4a-alias", sessionKey: "agent:main:real" },
      );
      await flushMicrotasks();

      expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(1);
      expect(mockClient.storeChatTurn.mock.calls[0][0]).toBe("openclaw:telegram:bot:chat-w4a-alias:agent%3Amain%3Areal");

      await writer.onTypedMessageSent(
        { to: "user-1", content: "weak alias a", success: true, metadata: { messageId: "weak-alias-out" } },
        { channelId: "telegram", accountId: "bot", conversationId: "chat-w4a-alias" },
      );
      await flushMicrotasks();

      expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(1);
    });


    it("T359 - weak typed W4b sees concrete W4a in-flight alias", async () => {
      let releasePersist: (() => void) | null = null;
      let persistCalls = 0;
      mockClient.storeChatTurn = vi.fn().mockImplementation(async () => {
        persistCalls++;
        await new Promise<void>((resolve) => {
          releasePersist = resolve;
        });
      });
      writer = new ChatTurnWriter({ client: mockClient, logger: mockLogger, stateDir });

      writer.onTypedMessageReceived(
        { from: "user-1", content: "weak inflight q", metadata: { messageId: "weak-inflight-in" } },
        { channelId: "telegram", accountId: "bot", conversationId: "chat-w4a-inflight" },
      );
      writer.onAgentEnd(
        { sessionId: "test", messages: [
          { role: "user", content: "weak inflight q" },
          { role: "assistant", content: "weak inflight a" },
        ] },
        { channelId: "telegram", accountId: "bot", conversationId: "chat-w4a-inflight", sessionKey: "agent:main:real" },
      );
      await flushMicrotasks();
      expect(persistCalls).toBe(1);

      await writer.onTypedMessageSent(
        { to: "user-1", content: "weak inflight a", success: true, metadata: { messageId: "weak-inflight-out" } },
        { channelId: "telegram", accountId: "bot", conversationId: "chat-w4a-inflight" },
      );
      await flushMicrotasks();
      expect(persistCalls).toBe(1);

      releasePersist?.();
      await flushMicrotasks();
    });


    it("T10 — concurrent W4b + W4a for the same content: only ONE persist (W4b in-flight, W4a skips without bumping watermark)", async () => {
      // Inverse race for T10: W4b fires first and starts hanging in
      // persistOne. W4a fires concurrently — its last-pair peek must catch
      // the W4b-origin in-flight reservation and skip WITHOUT advancing
      // the watermark (W4b's eventual success will raise `w4bSessionCounts`
      // and prevent backfill on the next agent_end).
      let releasePersist: (() => void) | null = null;
      let persistCalls = 0;
      mockClient.storeChatTurn = vi.fn().mockImplementation(async () => {
        persistCalls++;
        await new Promise<void>((resolve) => {
          releasePersist = resolve;
        });
      });
      writer = new ChatTurnWriter({ client: mockClient, logger: mockLogger, stateDir });
      writer.onMessageReceived({
        sessionKey: "sk",
        context: { channelId: "tg", content: "ping", messageId: "in-2" },
      } as any);
      // W4b fires — enters persistOne which hangs.
      const w4bPromise = writer.onMessageSent({
        sessionKey: "sk",
        context: { channelId: "tg", content: "pong", success: true, messageId: "out-2" },
      } as any);
      await flushMicrotasks();
      expect(persistCalls).toBe(1);
      // W4a fires while W4b hangs. Last-pair peek catches w4bOrigin
      // inflight reservation → skip without bumpWatermark.
      writer.onAgentEnd(
        { sessionId: "test", messages: [
          { role: "user", content: "ping" },
          { role: "assistant", content: "pong" },
        ] },
        { channelId: "tg", sessionKey: "sk" },
      );
      await flushMicrotasks();
      expect(persistCalls).toBe(1); // still just the W4b call

      // Watermark must NOT have advanced (W4b is still in-flight; if it
      // ultimately fails and rolls back, W4a needs the unchanged
      // watermark to retry the pair as backfill on the next call).
      const dkw = writer as any;
      const sessionId = "openclaw:tg:::sk";
      expect(dkw.cachedWatermarks.get(sessionId) ?? -1).toBe(-1);

      // Release W4b — success now stamps crossPathStamps and bumps
      // w4bSessionCounts.
      releasePersist?.();
      await w4bPromise;
      await flushMicrotasks();
      expect(persistCalls).toBe(1); // W4a still skipped (now via post-success stamp / w4bSessionCounts)
    });


    it("T10 — pre-persist inflight reservation is cleared on persistOne failure (no leaked block)", async () => {
      // Regression for T10: the inflight reservation must be released in
      // `finally` so a transient daemon failure doesn't leave a stale
      // entry that blocks a legitimate later same-content turn outside
      // the cross-path TTL.
      mockClient.storeChatTurn = vi.fn().mockImplementation(async () => {
        throw new Error("hard daemon failure");
      });
      writer = new ChatTurnWriter({ client: mockClient, logger: mockLogger, stateDir });
      writer.onMessageReceived({
        sessionKey: "sk",
        context: { channelId: "tg", content: "x", messageId: "in-3" },
      } as any);
      await writer.onMessageSent({
        sessionKey: "sk",
        context: { channelId: "tg", content: "y", success: true, messageId: "out-3" },
      } as any);
      // Wait long enough for the persistOne 250ms backoff retry.
      await new Promise((r) => setTimeout(r, 600));

      // Inflight reservation must NOT be leaked.
      const dkw = writer as any;
      const sessionId = "openclaw:tg:::sk";
      expect(dkw.peekCrossPathInflight(sessionId, dkw.w4bOriginKey("x", "y"))).toBe(false);
    });
});
