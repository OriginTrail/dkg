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


    it("R14.1 — W4a advances the watermark when the last-pair peek hits W4b's reservation", async () => {
      // R14.1 regression: when W4b has already persisted a turn via
      // `message:sent` and the cross-path peek tells W4a to skip it, the
      // watermark must STILL advance to that pair's index. Without this,
      // a later `agent_end` (after the 3s TTL has expired and the W4b
      // reservation has been swept) would re-pair the same turn as
      // unsaved backfill and write a duplicate to the daemon.
      const sessionId = "openclaw:tg:::sk";
      const dkw = writer as any;
      // Simulate W4b having just persisted "ping/pong" by stamping the
      // w4b-origin key in the SHORT-TTL cross-path map (T5). This is what
      // `onMessageSent` does after a successful persist.
      dkw.markCrossPathStamp(sessionId, dkw.w4bOriginKey("ping", "pong"));

      const ev: AgentEndContext = {
        sessionId: "test",
        messages: [
          { role: "user", content: "ping" },
          { role: "assistant", content: "pong" },
        ],
      };
      writer.onAgentEnd(ev, { channelId: "tg", sessionKey: "sk" });
      await flushMicrotasks();
      // W4a must NOT have written — W4b owns this turn (cross-path peek).
      expect(mockClient.storeChatTurn).not.toHaveBeenCalled();
      // The bumpWatermark scheduled a debounced commit. Watermark in the
      // pending debounce slot must already reflect the persisted pair.
      const pending = dkw.debounceTimers.get(sessionId);
      expect(pending?.pendingIndex).toBe(0);
      // Commit the watermark to disk-backed cache so the next onAgentEnd
      // reads it via loadWatermark (mirrors the production debounce flush).
      writer.flushSync();
      expect(dkw.loadWatermark(sessionId)).toBe(0);

      // Simulate TTL sweep — the W4b reservation has expired and would no
      // longer trigger the cross-path peek. The watermark is the second
      // line of defense and must independently prevent replay.
      dkw.recentTurnIds.clear();
      dkw.crossPathStamps.clear();
      writer.onAgentEnd(ev, { channelId: "tg", sessionKey: "sk" });
      await flushMicrotasks();
      expect(mockClient.storeChatTurn).not.toHaveBeenCalled();
    });


    it("derives sessionId from context", async () => {
      const event: AgentEndContext = {
        sessionId: "test",
        messages: [
          { role: "user", content: "x" },
          { role: "assistant", content: "y" },
        ],
      };
      writer.onAgentEnd(event, { channelId: "telegram", sessionKey: "user-42" });
      await flushMicrotasks();
      const call = mockClient.storeChatTurn.mock.calls[0];
      expect(call[0]).toContain("openclaw:telegram:");
    });


    it("retries storeChatTurn with backoff on transient failure", async () => {
      mockClient.storeChatTurn = vi
        .fn()
        .mockRejectedValueOnce(new Error("Network error"))
        .mockResolvedValue(undefined);
      // Re-instantiate writer so it uses the newly-patched mock.
      writer = new ChatTurnWriter({ client: mockClient, logger: mockLogger, stateDir });

      const event: AgentEndContext = {
        sessionId: "test",
        messages: [
          { role: "user", content: "x" },
          { role: "assistant", content: "y" },
        ],
      };
      writer.onAgentEnd(event, { channelId: "ch", sessionKey: "sk" });
      await new Promise((r) => setTimeout(r, 500));
      expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(2);
    });


    it("onBeforeCompaction does not throw", () => {
      expect(() => writer.onBeforeCompaction({}, {})).not.toThrow();
    });


    it("onBeforeReset does not throw", () => {
      expect(() => writer.onBeforeReset({}, {})).not.toThrow();
    });


    it("onBeforeCompaction is awaitable; subsequent onAgentEnd waits for the reset (R9.2/R9.5)", async () => {
      let releasePersist: (() => void) | null = null;
      mockClient.storeChatTurn = vi.fn().mockImplementation(
        () => new Promise<void>((resolve) => { releasePersist = resolve; }),
      );
      writer = new ChatTurnWriter({ client: mockClient, logger: mockLogger, stateDir });

      const event: AgentEndContext = {
        sessionId: "t",
        messages: [
          { role: "user", content: "u1" },
          { role: "assistant", content: "a1" },
        ],
      };
      await writer.onAgentEnd(event, { channelId: "ch", sessionKey: "sk" });

      // Kick off compaction — returns a promise that should not resolve
      // until the in-flight persist is released.
      const compactionPromise = writer.onBeforeCompaction({}, { channelId: "ch", sessionKey: "sk" });
      let compactionDone = false;
      compactionPromise.then(() => { compactionDone = true; });

      // Now fire a follow-up agent_end DURING the reset. It must not
      // observe the stale watermark — it should `await` the pending reset.
      const followupEvent: AgentEndContext = {
        sessionId: "t",
        messages: [
          { role: "user", content: "u2" },
          { role: "assistant", content: "a2" },
        ],
      };
      const followupPromise = writer.onAgentEnd(followupEvent, { channelId: "ch", sessionKey: "sk" });
      await flushMicrotasks();
      expect(compactionDone).toBe(false);

      // Release the persist; reset finishes; the gated agent_end proceeds.
      releasePersist!();
      await compactionPromise;
      await followupPromise;
      expect(compactionDone).toBe(true);
    });


    it("onMessageSent persist is tracked in inFlightPersists so reset awaits it (R9.4)", async () => {
      let releasePersist: (() => void) | null = null;
      mockClient.storeChatTurn = vi.fn().mockImplementation(
        () => new Promise<void>((resolve) => { releasePersist = resolve; }),
      );
      writer = new ChatTurnWriter({ client: mockClient, logger: mockLogger, stateDir });

      writer.onMessageReceived({
        sessionKey: "sk",
        context: { channelId: "tg", content: "hello" },
      } as any);
      await writer.onMessageSent({
        sessionKey: "sk",
        context: { channelId: "tg", content: "reply", success: true },
      } as any);
      // Under the hood, onMessageSent should have registered the persist
      // job in inFlightPersists; reset must wait for it before clearing.
      const inFlight = (writer as any).inFlightPersists as Map<string, Set<Promise<void>>>;
      let totalJobs = 0;
      for (const bucket of inFlight.values()) totalJobs += bucket.size;
      expect(totalJobs).toBeGreaterThan(0);

      releasePersist!();
      // Drain to clear the in-flight bucket cleanly.
      await new Promise((r) => setTimeout(r, 50));
    });


    it("compacting one session does not clear another session whose sessionKey contains ':' (R9.3/R9.6 cross-session isolation)", async () => {
      // Two sessions with sessionKeys that overlap on suffix — pre-fix code
      // used `endsWith(':<sessionKey-suffix>')` and would have wiped the
      // wrong queue. Today's exact-key delete must keep them isolated.
      writer.onMessageReceived({
        sessionKey: "agent:a-1:background",
        context: { channelId: "ch", accountId: "acc", conversationId: "c1", content: "from-A" },
      } as any);
      writer.onMessageReceived({
        sessionKey: "background", // bare suffix that the old buggy matcher would also match
        context: { channelId: "ch", accountId: "acc", conversationId: "c2", content: "from-B" },
      } as any);

      const pending = (writer as any).pendingUserMessages as Map<string, string[]>;
      expect(pending.size).toBe(2);

      // Compact only session A.
      await writer.onBeforeCompaction({}, { channelId: "ch", accountId: "acc", conversationId: "c1", sessionKey: "agent:a-1:background" });

      // Session B's queue must survive — its content is still recoverable.
      expect(pending.size).toBe(1);
      const remainingKey = Array.from(pending.keys())[0];
      expect(remainingKey).toContain("c2");
      expect(pending.get(remainingKey)).toEqual(["from-B"]);
    });


    it("flush() drains in-flight persists before returning (R9.8)", async () => {
      let releasePersist: (() => void) | null = null;
      mockClient.storeChatTurn = vi.fn().mockImplementation(
        () => new Promise<void>((resolve) => { releasePersist = resolve; }),
      );
      writer = new ChatTurnWriter({ client: mockClient, logger: mockLogger, stateDir });

      await writer.onAgentEnd(
        {
          sessionId: "t",
          messages: [
            { role: "user", content: "u" },
            { role: "assistant", content: "a" },
          ],
        },
        { channelId: "ch", sessionKey: "sk" },
      );

      let flushDone = false;
      const flushP = writer.flush().then(() => { flushDone = true; });
      await flushMicrotasks();
      expect(flushDone).toBe(false); // persist still hanging
      releasePersist!();
      await flushP;
      expect(flushDone).toBe(true);
    });


    it("resetSessionState awaits in-flight persists before wiping watermark (R7.4)", async () => {
      // Slow client — first call resolves only after we've issued the reset,
      // so the post-completion saveWatermark would otherwise race past it.
      let releasePersist: (() => void) | null = null;
      mockClient.storeChatTurn = vi.fn().mockImplementation(
        () => new Promise<void>((resolve) => { releasePersist = resolve; }),
      );
      writer = new ChatTurnWriter({ client: mockClient, logger: mockLogger, stateDir });

      const event: AgentEndContext = {
        sessionId: "t",
        messages: [
          { role: "user", content: "u1" },
          { role: "assistant", content: "a1" },
        ],
      };
      writer.onAgentEnd(event, { channelId: "ch", sessionKey: "sk" });
      await flushMicrotasks();
      // Persist is still in flight at this point — confirm.
      expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(1);

      // Fire compaction; it MUST wait for the in-flight persist before
      // wiping watermark/dedup state. We assert by releasing the persist
      // AFTER kicking off the reset and checking the reset hasn't completed.
      let resetDone = false;
      const resetPromise = (writer as any)
        .resetSessionState("openclaw:ch:::sk")
        .then(() => { resetDone = true; });
      await flushMicrotasks();
      // Reset must NOT have completed yet — the persist is still hanging.
      expect(resetDone).toBe(false);

      // Release the persist; reset can now proceed.
      releasePersist!();
      await resetPromise;
      expect(resetDone).toBe(true);
    });


    it("reads message text from canonical event.context.content envelope (R7.3)", async () => {
      // Canonical InternalHookEvent shape from openclaw — text lives on
      // event.context.content, NOT event.text.
      writer.onMessageReceived({
        sessionKey: "sk",
        context: { channelId: "tg", content: "hello from canonical envelope" },
      } as any);
      writer.onMessageSent({
        sessionKey: "sk",
        context: { channelId: "tg", content: "reply via canonical envelope", success: true },
      } as any);
      await flushMicrotasks();
      expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(1);
      const [, persistedUser, persistedAssistant] = mockClient.storeChatTurn.mock.calls[0];
      expect(persistedUser).toBe("hello from canonical envelope");
      expect(persistedAssistant).toBe("reply via canonical envelope");
    });


    it("warns when onMessageReceived has no sessionKey", () => {
      writer.onMessageReceived({
        sessionKey: undefined as unknown as string,
        direction: "inbound",
        text: "msg",
      });
      expect(mockLogger.warn).toHaveBeenCalled();
    });


    it("T362 — cold-start clamp: only the latest pair persists when watermark is missing (R2.4-revised)", async () => {
      // Pre-T362, this test asserted that all unsaved pairs persist when
      // computeDelta sees multiple. Live smoke (PR #362) showed that
      // semantic turned every cold start into a full transcript replay:
      // OpenClaw retains the channel transcript (Telegram, etc.) across
      // sessions, while DKG state can be wiped independently. On the first
      // agent_end after a fresh DKG home, `messages[]` carries the entire
      // historical transcript; walking those pairs replays each one
      // (the daemon does not idempotently dedupe — every storeChatExchange
      // mints fresh userMsg/assistantMsg UUIDs even when turnId matches),
      // bloating chat-turns by ~20 triples per replayed pair.
      //
      // The cold-start clamp inside `runAgentEndPersist` discards
      // historical pairs when savedUpTo === -1 and emits only the latest.
      // Subsequent agent_end calls see a non-negative savedUpTo, the
      // clamp does NOT engage, and within-session backfill works as
      // before (covered by the next test).
      const event: AgentEndContext = {
        sessionId: "test",
        messages: [
          { role: "user", content: "u1" },
          { role: "assistant", content: "a1" },
          { role: "user", content: "u2" },
          { role: "assistant", content: "a2" },
        ],
      };
      writer.onAgentEnd(event, { channelId: "ch", sessionKey: "sk" });
      await flushMicrotasks();
      expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(1);
      const call = mockClient.storeChatTurn.mock.calls[0];
      expect(call[1]).toBe("u2");
      expect(call[2]).toBe("a2");
      // Watermark must advance to the latest pairIndex (1), implicitly
      // claiming index 0 as done. Without this advance, the next
      // agent_end would re-find the historical pair as unsaved.
      // loadWatermark consults the pending debounce, so no 50ms wait needed.
      expect((writer as any).loadWatermark("openclaw:ch:::sk")).toBe(1);
    });


    it("T362 — post-cold-start in-session backfill still emits each unsaved pair", async () => {
      // Once the cold-start clamp has run and advanced the watermark, a
      // subsequent agent_end with N new unsaved pairs MUST emit all N.
      // Within-session backfill is still desirable: e.g., a typed-hook
      // outage between turn 1 and turn 5 means turns 2..4 sit unsaved
      // in `messages[]` and need to land on the next agent_end fire.
      // The clamp only suppresses cold start (savedUpTo === -1), not
      // legitimate mid-session backfill (savedUpTo >= 0).
      const seedEvent: AgentEndContext = {
        sessionId: "test",
        messages: [
          { role: "user", content: "u1" },
          { role: "assistant", content: "a1" },
        ],
      };
      writer.onAgentEnd(seedEvent, { channelId: "ch", sessionKey: "sk" });
      await flushMicrotasks();
      // Cold start emitted exactly 1 (only pair). Watermark now at 0.
      expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(1);
      mockClient.storeChatTurn.mockClear();

      // Subsequent agent_end with 3 new pairs (u2..u4). savedUpTo = 0,
      // so pair index 0 is skipped and indices 1, 2, 3 all emit.
      const backfillEvent: AgentEndContext = {
        sessionId: "test",
        messages: [
          { role: "user", content: "u1" },     // pairIndex 0 — saved
          { role: "assistant", content: "a1" },
          { role: "user", content: "u2" },     // pairIndex 1 — emit
          { role: "assistant", content: "a2" },
          { role: "user", content: "u3" },     // pairIndex 2 — emit
          { role: "assistant", content: "a3" },
          { role: "user", content: "u4" },     // pairIndex 3 — emit
          { role: "assistant", content: "a4" },
        ],
      };
      writer.onAgentEnd(backfillEvent, { channelId: "ch", sessionKey: "sk" });
      await flushMicrotasks();

      expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(3);
      const persisted = mockClient.storeChatTurn.mock.calls.map((call) => [call[1], call[2]]);
      expect(persisted).toEqual([
        ["u2", "a2"],
        ["u3", "a3"],
        ["u4", "a4"],
      ]);
    });
});
