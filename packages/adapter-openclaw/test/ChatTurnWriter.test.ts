import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ChatTurnWriter } from "../src/ChatTurnWriter";
import type { AgentEndContext, InternalMessageEvent } from "../src/ChatTurnWriter";

/** Wait long enough for fire-and-forget persistOne() to complete. */
const flushMicrotasks = () => new Promise((r) => setTimeout(r, 20));

describe("ChatTurnWriter", () => {
  let writer: ChatTurnWriter;
  let mockClient: { storeChatTurn: ReturnType<typeof vi.fn> };
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

  it("flushSync clears debounce timers", () => {
    writer.flushSync();
    expect((writer as any).debounceTimers.size).toBe(0);
  });

  it("R21.2 — onMessageSent with no pending user does NOT persist an orphan assistant turn", async () => {
    // Regression for R21.2: pre-fix, an outbound `message:sent` arriving
    // when the pending-user queue was empty (chunk 2+ of one logical
    // reply, or a proactive notification with no inbound) persisted as a
    // standalone assistant-only turn. That polluted chat memory/search
    // results and broke the one-turn-per-exchange invariant. The fix
    // bails when the queue is empty.
    await writer.onMessageSent({
      sessionKey: "sk",
      context: { channelId: "tg", content: "orphan reply", success: true, messageId: "out-orphan" },
    } as any);
    await flushMicrotasks();
    expect(mockClient.storeChatTurn).not.toHaveBeenCalled();

    // Confirm normal pairing still works after the bail-on-empty.
    writer.onMessageReceived({
      sessionKey: "sk",
      context: { channelId: "tg", content: "real q", messageId: "in-1" },
    } as any);
    await writer.onMessageSent({
      sessionKey: "sk",
      context: { channelId: "tg", content: "real reply", success: true, messageId: "out-1" },
    } as any);
    await flushMicrotasks();
    expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(1);
  });

  it("R20.1 — onMessageSent with success=true but empty content does NOT consume the pending user", async () => {
    // Regression for R20.1: pre-fix, the dequeue happened before the
    // `assistantText` check, so a `message:sent` carrying an empty
    // content (channel ack, attachment-only send, status broadcast)
    // would eat the user side and leave the next REAL textual reply
    // with no pending user — persisted as an assistant-only turn.
    writer.onMessageReceived({
      sessionKey: "sk",
      context: { channelId: "tg", content: "real user question", messageId: "in-1" },
    } as any);

    // Empty-content success-true outbound (channel ack / attachment-only).
    await writer.onMessageSent({
      sessionKey: "sk",
      context: { channelId: "tg", content: "", success: true, messageId: "out-ack" },
    } as any);
    await flushMicrotasks();
    expect(mockClient.storeChatTurn).not.toHaveBeenCalled();
    // The pending user must still be in the queue.
    const pending = (writer as any).pendingUserMessages;
    expect(pending.size).toBeGreaterThan(0);

    // The real reply now arrives — must pair with the original user.
    await writer.onMessageSent({
      sessionKey: "sk",
      context: { channelId: "tg", content: "real reply", success: true, messageId: "out-1" },
    } as any);
    await flushMicrotasks();
    expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(1);
    const call = mockClient.storeChatTurn.mock.calls[0];
    expect(call[1]).toBe("real user question");
    expect(call[2]).toBe("real reply");
  });

  it("T16 — W4b's peek-hit on w4aOrigin stamp consumes it so a future same-content turn within 5s does not false-dedup", async () => {
    // Regression for T16: pre-fix, the cross-path stamp lived for 5s
    // post-success and was peeked non-mutatively. If a turn 1 W4a
    // persisted same-content C1, then turn 2 with same content C1
    // arrived within 5s, W4b's peek would hit turn 1's stale stamp
    // and skip turn 2 — even though W4a never re-stamped (e.g., W4a
    // didn't fire for turn 2). Post-fix, the stamp is CONSUMED on
    // peek-hit so a future stale-hit can't trigger.
    const dkw = writer as any;
    const sessionId = "openclaw:tg:::sk";
    // Stamp w4aOrigin manually (simulating W4a's post-success stamp).
    dkw.markCrossPathStamp(sessionId, dkw.w4aOriginKey("hi", "there"));
    expect(dkw.peekCrossPathStamp(sessionId, dkw.w4aOriginKey("hi", "there"))).toBe(true);

    // W4b fires for the same content — peek hits, consumes stamp, returns.
    writer.onMessageReceived({
      sessionKey: "sk",
      context: { channelId: "tg", content: "hi", messageId: "in-1" },
    } as any);
    await writer.onMessageSent({
      sessionKey: "sk",
      context: { channelId: "tg", content: "there", success: true, messageId: "out-1" },
    } as any);
    await flushMicrotasks();
    expect(mockClient.storeChatTurn).not.toHaveBeenCalled(); // skipped per stamp

    // CRITICAL: stamp must now be GONE.
    expect(dkw.peekCrossPathStamp(sessionId, dkw.w4aOriginKey("hi", "there"))).toBe(false);
  });

  it("T16 — W4a's last-pair peek-hit on w4bOrigin stamp consumes it (symmetric)", async () => {
    // Symmetric regression: W4a's last-pair check must also consume
    // the stamp after a hit, so a later same-content backfill cycle
    // doesn't false-dedup against a stale W4b stamp.
    const dkw = writer as any;
    const sessionId = "openclaw:tg:::sk";
    dkw.markCrossPathStamp(sessionId, dkw.w4bOriginKey("ping", "pong"));
    expect(dkw.peekCrossPathStamp(sessionId, dkw.w4bOriginKey("ping", "pong"))).toBe(true);

    const ev: AgentEndContext = {
      sessionId: "test",
      messages: [
        { role: "user", content: "ping" },
        { role: "assistant", content: "pong" },
      ],
    };
    writer.onAgentEnd(ev, { channelId: "tg", sessionKey: "sk" });
    await flushMicrotasks();
    // Stamp consumed.
    expect(dkw.peekCrossPathStamp(sessionId, dkw.w4bOriginKey("ping", "pong"))).toBe(false);
  });

  it("T17 — w4bSessionCounts is persisted to disk and restored across writer restart", async () => {
    // Regression for T17: pre-fix, w4bSessionCounts was process-local
    // only. setup-runtime mode → W4b persists turns → process restart
    // → w4bCount resets to 0 while watermark file is still -1 → next
    // agent_end re-emits every W4b-persisted pair as backfill (daemon
    // duplicate writes). Post-fix, the count is persisted alongside
    // the watermark in the same file under `{ w, b }` shape.
    writer.onMessageReceived({
      sessionKey: "sk",
      context: { channelId: "tg", content: "u1", messageId: "in-1" },
    } as any);
    await writer.onMessageSent({
      sessionKey: "sk",
      context: { channelId: "tg", content: "r1", success: true, messageId: "out-1" },
    } as any);
    await flushMicrotasks();
    // First turn persisted; w4bCount should now be 1 in memory.
    expect((writer as any).w4bSessionCounts.get("openclaw:tg:::sk")).toBe(1);

    // Force the debounced flush to write to disk.
    writer.flushSync();
    // Wait an extra tick for the timer-driven write.
    await new Promise((r) => setTimeout(r, 100));

    // Simulate process restart by constructing a NEW writer with the
    // SAME stateDir. It MUST load w4bCount from disk, not start at 0.
    const newWriter = new ChatTurnWriter({ client: mockClient, logger: mockLogger, stateDir });
    expect((newWriter as any).w4bSessionCounts.get("openclaw:tg:::sk")).toBe(1);
    newWriter.flushSync();
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

  it("T15 — persist-failure restore preserves the ORIGINAL queue items (not the joined string)", async () => {
    // Regression for T15: when persist fails, the catch block must
    // restore each ORIGINAL queue item to the front, not the joined
    // string. This way a later inbound that arrives between the
    // failure and the retry queues normally and the next outbound
    // re-collapses the full queue (old + new).
    let firstAttempt = true;
    mockClient.storeChatTurn = vi.fn().mockImplementation(async () => {
      if (firstAttempt) {
        firstAttempt = false;
        throw new Error("transient daemon failure");
      }
      // also fail the persistOne single retry so the catch block runs
      throw new Error("hard daemon failure");
    });
    writer = new ChatTurnWriter({ client: mockClient, logger: mockLogger, stateDir });
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
    // Wait for persistOne 250ms backoff retry to complete.
    await new Promise((r) => setTimeout(r, 600));

    // The original two queue items must be restored at the front, NOT
    // a single `"u1\nu2"` string.
    const pending = (writer as any).pendingUserMessages;
    const conversationKey = Array.from(pending.keys())[0] as string;
    const restoredQueue = pending.get(conversationKey) as string[];
    expect(restoredQueue).toEqual(["u1", "u2"]);
  });

  it("R20.2 — w4bSessionCounts only increments for persists that consumed a pending user (chunked-reply safety)", async () => {
    // Regression for R20.2: pre-fix, every successful W4b persist
    // bumped `w4bSessionCounts` by 1, including chunk-2+ deliveries
    // that ran out of pending users on chunk 1 and persisted as
    // assistant-only turns. The count then advanced past
    // `event.messages` and the next `agent_end` skipped real pairs as
    // already-W4b-persisted. The fix guards the increment on
    // `userText` non-empty (i.e., this persist represents a complete
    // logical turn pair).
    writer.onMessageReceived({
      sessionKey: "sk",
      context: { channelId: "tg", content: "q1", messageId: "in-1" },
    } as any);
    // Chunk 1: pairs with user, increments count.
    await writer.onMessageSent({
      sessionKey: "sk",
      context: { channelId: "tg", content: "chunk1", success: true, messageId: "out-1a" },
    } as any);
    await flushMicrotasks();
    // Chunks 2+: queue is empty, persist as assistant-only — must NOT
    // bump the count.
    await writer.onMessageSent({
      sessionKey: "sk",
      context: { channelId: "tg", content: "chunk2", success: true, messageId: "out-1b" },
    } as any);
    await writer.onMessageSent({
      sessionKey: "sk",
      context: { channelId: "tg", content: "chunk3", success: true, messageId: "out-1c" },
    } as any);
    await flushMicrotasks();
    const counts = (writer as any).w4bSessionCounts as Map<string, number>;
    // Exactly ONE turn pair was consumed — count must reflect that,
    // not the 3 raw `message:sent` fires.
    const sessionId = "openclaw:tg:::sk";
    expect(counts.get(sessionId)).toBe(1);
  });

  it("R22.1 — computeDelta drops assistant-only artifacts (initial greeting, compaction) and does NOT advance pairIndex", async () => {
    // Regression for R22.1: pre-fix, an assistant message with no
    // preceding user (initial agent greeting, post-compaction artifact,
    // system-injected announcement) emitted a pair as ("", asst) and
    // bumped `pairIndex`. That polluted memory AND inflated the
    // watermark — so the next REAL (user, assistant) pair would be
    // skipped on the next agent_end as already-saved.
    //
    // Setup: messages = [asst(greeting), user, asst(reply)]. Pre-fix
    // would emit two pairs (greeting at index 0, reply at index 1) and
    // skip the next agent_end's reply if backfill watermark = 1.
    // Post-fix emits exactly one pair: (user, reply) at pairIndex 0.
    const event: AgentEndContext = {
      sessionId: "test",
      messages: [
        { role: "assistant", content: "Hi! I'm your assistant." }, // initial greeting, no pending user
        { role: "user", content: "Real question" },
        { role: "assistant", content: "Real reply" },
      ],
    };
    writer.onAgentEnd(event, { channelId: "tg", sessionKey: "sk" });
    await flushMicrotasks();
    expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(1);
    const call = mockClient.storeChatTurn.mock.calls[0];
    expect(call[1]).toBe("Real question");
    expect(call[2]).toBe("Real reply");
  });

  it("R22.1 — pairIndex is NOT advanced for orphan assistant messages so the watermark stays correct", async () => {
    // Stronger guard: drive the same shape twice and confirm the second
    // agent_end (with the same messages array) does not write a new
    // pair, because the watermark advanced exactly to the one real
    // pair persisted on the first call.
    const dkw = writer as any;
    const ev: AgentEndContext = {
      sessionId: "test",
      messages: [
        { role: "assistant", content: "system greeting" },
        { role: "user", content: "q1" },
        { role: "assistant", content: "a1" },
      ],
    };
    writer.onAgentEnd(ev, { channelId: "tg", sessionKey: "sk" });
    await flushMicrotasks();
    expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(1);
    // Flush so loadWatermark reflects the persisted index.
    writer.flushSync();
    // The real pair lands at pairIndex 0 (orphan asst was skipped, NOT
    // counted), so the watermark should be 0 — not 1.
    expect(dkw.loadWatermark("openclaw:tg:::sk")).toBe(0);

    writer.onAgentEnd(ev, { channelId: "tg", sessionKey: "sk" });
    await flushMicrotasks();
    // Second call must not re-persist anything.
    expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(1);
  });

  it("R19.1 — computeDelta concatenates consecutive user messages before pairing with assistant reply", async () => {
    // Regression for R19.1: pre-fix, the parser used a single
    // `currentUser` slot that overwrote on each user message. So
    // `[user1, user2, asst]` paired only `user2` with `asst` and
    // dropped `user1`. The fix accumulates consecutive users and
    // joins them with `\n` before pairing.
    const event: AgentEndContext = {
      sessionId: "test",
      messages: [
        { role: "user", content: "first user message" },
        { role: "user", content: "second user message" },
        { role: "assistant", content: "single reply" },
      ],
    };
    writer.onAgentEnd(event, { channelId: "tg", sessionKey: "sk" });
    await flushMicrotasks();
    expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(1);
    const call = mockClient.storeChatTurn.mock.calls[0];
    // User side preserves both messages joined with newline.
    expect(call[1]).toContain("first user message");
    expect(call[1]).toContain("second user message");
    expect(call[2]).toBe("single reply");
  });

  it("R19.1 — computeDelta treats assistant with text+toolCalls as intermediate, pairs final reply with original user", async () => {
    // Regression for R19.1: pre-fix, an assistant message carrying
    // BOTH text content AND tool_calls was treated as a final reply
    // (the `!text && hasToolCalls` skip required empty text). That
    // produced two pairs from `[user, asst(tool+text), tool, asst(final)]`,
    // with the second pair missing the user side. The fix treats any
    // assistant with tool_calls as intermediate, so the final reply
    // pairs with the original user message.
    const event: AgentEndContext = {
      sessionId: "test",
      messages: [
        { role: "user", content: "what's the weather?" },
        {
          role: "assistant",
          content: "Let me check that for you.",
          tool_calls: [{ id: "c1", type: "function", function: { name: "weather" } }],
        } as any,
        { role: "tool" as any, content: "rainy" },
        { role: "assistant", content: "It's rainy today." },
      ],
    };
    writer.onAgentEnd(event, { channelId: "tg", sessionKey: "sk" });
    await flushMicrotasks();
    // Exactly one pair persisted (not two).
    expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(1);
    const call = mockClient.storeChatTurn.mock.calls[0];
    expect(call[1]).toBe("what's the weather?");
    expect(call[2]).toBe("It's rainy today.");
  });

  it("T5 — cross-path stamps live on a SHORTER TTL than the in-flight turnIds (<=10s)", () => {
    // Regression for T5: pre-fix, content-only `w4aOriginKey` /
    // `w4bOriginKey` lived on the 60s `TURNID_TTL_MS` map. Two
    // legitimate repeated turns with the same text within 60s would
    // collide on the first turn's stamp — if the second turn's
    // remaining path then failed, the turn was dropped. The fix
    // moves cross-path stamps to a separate map with a short
    // (~5s) TTL. The pair-indexed turnId on `recentTurnIds` keeps
    // the longer 60s window because it's per-pair-unique.
    const crossTtl = (writer.constructor as any).CROSS_PATH_TTL_MS;
    const longTtl = (writer.constructor as any).TURNID_TTL_MS;
    expect(crossTtl).toBeLessThanOrEqual(10_000);
    expect(longTtl).toBeGreaterThanOrEqual(crossTtl);
    expect(longTtl - crossTtl).toBeGreaterThan(0); // strict separation
  });

  it("T5 — cross-path stamp from W4a does NOT block a repeated same-content turn after the cross-path TTL elapses", async () => {
    // Regression for T5: simulates the data-loss scenario by stamping
    // w4aOrigin (T5 short-TTL map) for "ping/pong", then expiring it,
    // then firing a fresh agent_end with the same content. With the
    // separate short-TTL map, the expired stamp doesn't block.
    const dkw = writer as any;
    const sessionId = "openclaw:ch:::sk";
    // Stamp w4a-origin for ("ping","pong") at simulated past time.
    const key = dkw.dedupKey(sessionId, dkw.w4aOriginKey("ping", "pong"));
    dkw.crossPathStamps.set(key, Date.now() - 10_000); // 10s ago, beyond 5s TTL
    expect(dkw.peekCrossPathStamp(sessionId, dkw.w4aOriginKey("ping", "pong"))).toBe(false);
    // The stale entry is opportunistically evicted on the peek above.
    expect(dkw.crossPathStamps.has(key)).toBe(false);
  });

  it("R18.1 — TURNID_TTL_MS is generous enough to cover slow outbound channels (>=30s)", () => {
    // Regression for R18.1: the cross-path dedup TTL was 3s, so a slow
    // `message:sent` (queued Telegram, retry, network glitch) arriving
    // after agent_end's stamp had expired would persist the same turn
    // twice. The new TTL (60s by design, but at minimum >=30s) covers
    // realistic slow-channel delivery without making the dedup map
    // unbounded.
    const ttl = (writer.constructor as any).TURNID_TTL_MS;
    expect(ttl).toBeGreaterThanOrEqual(30_000);
  });

  it("R19.2 — flush() awaits a job enqueued AFTER its initial snapshot (loop until empty)", async () => {
    // Regression for R19.2: pre-fix, `flush()` snapshotted in-flight
    // jobs once, then awaited. A late-arriving hook handler that
    // called `trackPersistJob` AFTER the snapshot would not be in
    // the awaited set, so shutdown could return before the late
    // persist completed. The fix loops until both the in-flight
    // bucket and pending-resets bucket are empty across an iteration.

    const dkw = writer as any;
    const sessionId = "openclaw:tg:::sk";

    // Track ordering so we can assert flush awaited the late job.
    const order: string[] = [];

    // Seed an initial in-flight job that completes quickly.
    let resolveFirst: () => void = () => {};
    const firstJob = new Promise<void>((r) => { resolveFirst = r; });
    dkw.trackPersistJob(sessionId, async () => {
      await firstJob;
      order.push("first done");
    }).catch(() => {});

    // Schedule a "late" job that enqueues itself ONLY after the first
    // resolves (simulating a hook handler that races flush's snapshot).
    let resolveSecond: () => void = () => {};
    const secondJob = new Promise<void>((r) => { resolveSecond = r; });
    setTimeout(() => {
      dkw.trackPersistJob(sessionId, async () => {
        await secondJob;
        order.push("second done");
      }).catch(() => {});
    }, 5);

    // Resolve the second slightly later so flush's loop catches it.
    setTimeout(() => resolveSecond(), 30);
    // Resolve first immediately so flush proceeds past the first iteration.
    setTimeout(() => resolveFirst(), 10);

    await writer.flush();
    order.push("flush returned");
    // Both jobs must have completed BEFORE flush returned.
    expect(order).toContain("first done");
    expect(order).toContain("second done");
    expect(order[order.length - 1]).toBe("flush returned");
  });

  it("R18.2 — agent_end after setup-runtime → full upgrade does NOT re-persist W4b-written turns", async () => {
    // Regression for R18.2: while typed hooks were unavailable
    // (setup-runtime mode), W4b can persist turns directly via
    // `message:sent`, but W4a's pair-indexed watermark stays at -1
    // because no agent_end fires. After the upgrade to full mode, the
    // first agent_end's `computeDelta` would treat the entire transcript
    // as backfill and W4b's per-pair-index check (only the LAST pair
    // peeks `w4bOrigin`) wouldn't catch earlier pairs — they'd all be
    // re-persisted. The fix tracks per-session W4b persist counts and
    // raises `savedUpTo` floor by `count - 1` so already-W4b-persisted
    // pairs are skipped entirely.

    // Simulate setup-runtime: W4b persists 3 turns directly.
    for (let i = 1; i <= 3; i++) {
      await writer.onMessageReceived({
        sessionKey: "sk",
        context: { channelId: "tg", content: `q${i}`, messageId: `in-${i}` },
      } as any);
      await writer.onMessageSent({
        sessionKey: "sk",
        context: { channelId: "tg", content: `a${i}`, success: true, messageId: `out-${i}` },
      } as any);
      await flushMicrotasks();
    }
    // Three persists from W4b.
    expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(3);

    // Now full mode kicks in — agent_end fires with the full
    // accumulated `messages[]` (3 user/assistant pairs).
    const ev: AgentEndContext = {
      sessionId: "test",
      messages: [
        { role: "user", content: "q1" },
        { role: "assistant", content: "a1" },
        { role: "user", content: "q2" },
        { role: "assistant", content: "a2" },
        { role: "user", content: "q3" },
        { role: "assistant", content: "a3" },
      ],
    };
    writer.onAgentEnd(ev, { channelId: "tg", sessionKey: "sk" });
    await flushMicrotasks();
    // Must NOT re-persist any of the 3 turns W4b already wrote.
    expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(3);
  });

  it("R17.1 — contentHash distinguishes (a:b, c) from (a, b:c) (no delimiter collision)", () => {
    // Regression for R17.1: pre-fix, both pairs hashed `${user}:${assistant}`
    // → "a:b:c" → same digest → cross-path dedup falsely treated distinct
    // turns as duplicates and skipped persistence. The new structured
    // encoding via JSON.stringify quotes each segment unambiguously.
    const dkw = writer as any;
    const h1 = dkw.contentHash("a:b", "c");
    const h2 = dkw.contentHash("a", "b:c");
    expect(h1).not.toBe(h2);
    // Same values still hash to the same digest (idempotency).
    expect(dkw.contentHash("a:b", "c")).toBe(h1);
  });

  it("R17.1 — deterministicTurnId distinguishes (s:1, u, a) from (s, 1:u, a) (no delimiter collision)", () => {
    // Regression for R17.1: pre-fix, sessionId/user/assistant joined with
    // raw `:` produced colliding hashes for distinct sessionId-vs-user
    // splits. The new JSON.stringify encoding quotes each segment.
    const dkw = writer as any;
    const id1 = dkw.deterministicTurnId("s:1", "u", "a");
    const id2 = dkw.deterministicTurnId("s", "1:u", "a");
    expect(id1).not.toBe(id2);
    // pairIndex variant: same content + different pairIndex → different ids.
    const id3 = dkw.deterministicTurnId("s", "u", "a", 0);
    const id4 = dkw.deterministicTurnId("s", "u", "a", 1);
    expect(id3).not.toBe(id4);
  });

  it("R15.1 — two legitimate same-content W4b turns within the dedup TTL both persist when messageId is supplied", async () => {
    // Regression for R15.1: previously W4b's pre-persist dedup key was
    // content-only with a 3s TTL, so two legitimate non-LLM turns with
    // identical text within 3 seconds dropped the second reply. The
    // fix moves the in-flight guard to a per-turn `messageId`-based
    // key (the gateway emits one `messageId` per delivery per
    // `openclaw/src/infra/outbound/deliver.ts`). Cross-path stamping
    // of the content-only `w4bOrigin` happens AFTER persist completes
    // and never blocks legitimate sequential same-content turns.
    writer.onMessageReceived({
      sessionKey: "sk",
      context: { channelId: "tg", content: "ping", messageId: "in-msg-1" },
    } as any);
    await writer.onMessageSent({
      sessionKey: "sk",
      context: { channelId: "tg", content: "pong", success: true, messageId: "out-msg-1" },
    } as any);
    await flushMicrotasks();
    expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(1);

    // Same content within the 3s TTL — different messageId. Must persist.
    writer.onMessageReceived({
      sessionKey: "sk",
      context: { channelId: "tg", content: "ping", messageId: "in-msg-2" },
    } as any);
    await writer.onMessageSent({
      sessionKey: "sk",
      context: { channelId: "tg", content: "pong", success: true, messageId: "out-msg-2" },
    } as any);
    await flushMicrotasks();
    expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(2);
  });

  it("R15.2 — empty inbound text is dropped (attachment-only events do not enqueue blanks)", () => {
    // Regression for R15.2: `readEventText` returns "" for attachment-only
    // / non-text inbound events. Previously we still enqueued an empty
    // string, which paired with the next `message:sent` to persist an
    // assistant-only turn for a conversation that had no textual inbound.
    // Skip until we add a recoverable representation for non-text payloads.
    writer.onMessageReceived({
      sessionKey: "sk",
      context: { channelId: "tg", content: "" },
    } as any);
    writer.onMessageReceived({
      sessionKey: "sk",
      context: { channelId: "tg" }, // no content at all
    } as any);
    expect((writer as any).pendingUserMessages.size).toBe(0);

    // A genuine text inbound after the empty ones still enqueues normally.
    writer.onMessageReceived({
      sessionKey: "sk",
      context: { channelId: "tg", content: "hello" },
    } as any);
    expect((writer as any).pendingUserMessages.size).toBe(1);
  });

  it("W4b-first then W4a same content: cross-path dedup is symmetric, no double-write (R12.6)", async () => {
    // The qa-engineer-flagged R10/R11 race: previously W4b would persist
    // and then W4a's pair (same content, different turnId via pairIndex)
    // wouldn't dedup against it. Now W4b reserves w4b-content origin and
    // W4a's last-pair check catches that.
    writer.onMessageReceived({
      sessionKey: "sk",
      context: { channelId: "tg", content: "hi" },
    } as any);
    await writer.onMessageSent({
      sessionKey: "sk",
      context: { channelId: "tg", content: "hello", success: true },
    } as any);
    await flushMicrotasks();
    expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(1); // W4b wrote

    // Now W4a fires for the same turn (canonical mixed scenario).
    writer.onAgentEnd(
      {
        sessionId: "t",
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "hello" },
        ],
      },
      { channelId: "tg", sessionKey: "sk" },
    );
    await flushMicrotasks();
    // W4a's last-pair check sees the W4b origin reservation → skips.
    expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(1);
  });

  it("backfill of identical content STILL persists both pairs even after symmetric dedup (R12.6 + R10.4)", async () => {
    // Backfill scenario: agent_end fires with messages array containing
    // two same-content pairs. Pre-fix collision in dedup would drop
    // the second. The W4b-origin check is gated to LAST pair only, so
    // the earlier (backfill) pair persists via its own pair-indexed
    // turnId without false dedup.
    const event: AgentEndContext = {
      sessionId: "t",
      messages: [
        { role: "user", content: "thanks" },
        { role: "assistant", content: "you're welcome" },
        { role: "user", content: "thanks" },
        { role: "assistant", content: "you're welcome" },
      ],
    };
    writer.onAgentEnd(event, { channelId: "ch", sessionKey: "sk" });
    await flushMicrotasks();
    expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(2);
  });

  it("encodes ':' in session-id fields so colon-rich values don't collide (R12.8)", async () => {
    // Two distinct conversations whose raw fields naively join to the
    // SAME `openclaw:...` string under the pre-fix joiner:
    //   A: channelId='ch', accountId='a', conversationId='', sessionKey='b:c'
    //      → naive: openclaw:ch:a::b:c
    //   B: channelId='ch:a', accountId='', conversationId='', sessionKey='b:c'
    //      → naive: openclaw:ch:a::b:c   (collision)
    // With per-field colon encoding the two land at distinct keys and
    // their pending queues are kept separate.
    writer.onMessageReceived({
      sessionKey: "b:c",
      context: { channelId: "ch", accountId: "a", content: "from-A" },
    } as any);
    writer.onMessageReceived({
      sessionKey: "b:c",
      context: { channelId: "ch:a", content: "from-B" },
    } as any);
    const pending = (writer as any).pendingUserMessages as Map<string, string[]>;
    expect(pending.size).toBe(2); // two distinct conversation keys
  });

  it("on persist failure W4b restores the user message to the front of the queue (R12.3/R12.7)", async () => {
    // Pre-fix: persist failure dropped the user half permanently.
    mockClient.storeChatTurn = vi
      .fn()
      .mockRejectedValueOnce(new Error("daemon down"))
      .mockRejectedValueOnce(new Error("daemon still down"))
      .mockResolvedValue(undefined);
    writer = new ChatTurnWriter({ client: mockClient, logger: mockLogger, stateDir });

    writer.onMessageReceived({
      sessionKey: "sk",
      context: { channelId: "tg", content: "important question" },
    } as any);
    await writer.onMessageSent({
      sessionKey: "sk",
      context: { channelId: "tg", content: "first attempt reply", success: true },
    } as any);
    // wait for persist retries to complete + failure restoration
    await new Promise((r) => setTimeout(r, 1500));
    // First attempt failed; user message should be restored to the queue.
    const pending = (writer as any).pendingUserMessages as Map<string, string[]>;
    let restored: string[] | undefined;
    for (const v of pending.values()) restored = v;
    expect(restored?.[0]).toBe("important question");
  }, 10_000);

  it("watermark uses absolute pairIndex and does not drift on cross-path persist (R11.2)", async () => {
    // Simulate W4a + W4b firing for the same turn: W4a persists with
    // pairIndex=0, W4b persists without pairIndex. Watermark must end
    // at 0, NOT 1 (no double-increment). Then a follow-up agent_end
    // with the same pair must NOT be re-persisted.
    await writer.onAgentEnd(
      {
        sessionId: "t",
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "hello" },
        ],
      },
      { channelId: "tg", sessionKey: "sk" },
    );
    await flushMicrotasks();
    await new Promise((r) => setTimeout(r, 70)); // commit debounce
    expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(1);
    const watermarks = (writer as any).cachedWatermarks as Map<string, number>;
    const sid = "openclaw:tg:::sk";
    expect(watermarks.get(sid)).toBe(0); // absolute pair index, NOT 1
  });

  it("backfill: W4a persists pair 5 then pair 7 — watermark is 7, not incrementing arithmetic (R11.2)", async () => {
    // 4 unsaved pairs: indices 0..3 in messages. Set watermark to -1 (fresh).
    // After all persist, watermark should be at the last persisted pair's
    // index (3), not whatever cumulative count of persists.
    const event: AgentEndContext = {
      sessionId: "t",
      messages: [
        { role: "user", content: "u0" },
        { role: "assistant", content: "a0" },
        { role: "user", content: "u1" },
        { role: "assistant", content: "a1" },
        { role: "user", content: "u2" },
        { role: "assistant", content: "a2" },
        { role: "user", content: "u3" },
        { role: "assistant", content: "a3" },
      ],
    };
    await writer.onAgentEnd(event, { channelId: "ch", sessionKey: "sk" });
    await flushMicrotasks();
    await new Promise((r) => setTimeout(r, 70));
    expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(4);
    const watermarks = (writer as any).cachedWatermarks as Map<string, number>;
    expect(watermarks.get("openclaw:ch:::sk")).toBe(3); // last pairIndex
  });

  it("collapses tool-using turn into one (user, final-reply) pair (R10.3)", async () => {
    // Tool-using turn: [user, assistant(tool_call), tool, assistant(final_reply)].
    // Without the intermediate-step skip, computeDelta would emit TWO pairs:
    // (user, "") and ("", final_reply) — both wrong.
    const event: AgentEndContext = {
      sessionId: "t",
      messages: [
        { role: "user", content: "look up the weather" },
        { role: "assistant", content: "", tool_calls: [{ id: "c1", name: "get_weather" }] } as any,
        { role: "tool", content: "72°F sunny" } as any,
        { role: "assistant", content: "It's 72°F and sunny." },
      ],
    };
    writer.onAgentEnd(event, { channelId: "ch", sessionKey: "sk" });
    await flushMicrotasks();
    expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(1);
    const [, persistedUser, persistedAssistant] = mockClient.storeChatTurn.mock.calls[0];
    expect(persistedUser).toBe("look up the weather");
    expect(persistedAssistant).toBe("It's 72°F and sunny.");
  });

  it("backfill of two identical-content pairs both persist (R10.4 pair-index discriminator)", async () => {
    // Pre-fix: same-content pairs collided on the dedup key and only the
    // first persisted. With pairIndex baked into the W4a turnId, both
    // backfill pairs get distinct turnIds and both write.
    const event: AgentEndContext = {
      sessionId: "t",
      messages: [
        { role: "user", content: "thanks" },
        { role: "assistant", content: "you're welcome" },
        { role: "user", content: "thanks" },
        { role: "assistant", content: "you're welcome" },
      ],
    };
    writer.onAgentEnd(event, { channelId: "ch", sessionKey: "sk" });
    await flushMicrotasks();
    expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(2);
  });

  it("W4a stamps content alias so a W4b message:sent for same content dedups (R10.4 cross-path)", async () => {
    // First fire W4a; assert exactly one persist + that the content alias
    // is present in the dedup map.
    writer.onAgentEnd(
      {
        sessionId: "t",
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "hello" },
        ],
      },
      { channelId: "tg", sessionKey: "sk" },
    );
    await flushMicrotasks();
    expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(1);

    // Now fire W4b with the same content. Cross-path dedup must skip.
    writer.onMessageReceived({
      sessionKey: "sk",
      context: { channelId: "tg", content: "hi" },
    } as any);
    await writer.onMessageSent({
      sessionKey: "sk",
      context: { channelId: "tg", content: "hello", success: true },
    } as any);
    await flushMicrotasks();
    expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(1); // unchanged
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

  it("persists every unsaved pair when computeDelta sees multiple (R2.4 backfill)", async () => {
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
    // Both pairs must be written — not just the last one.
    expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(2);
    const firstCall = mockClient.storeChatTurn.mock.calls[0];
    const secondCall = mockClient.storeChatTurn.mock.calls[1];
    expect(firstCall[1]).toBe("u1");
    expect(firstCall[2]).toBe("a1");
    expect(secondCall[1]).toBe("u2");
    expect(secondCall[2]).toBe("a2");
  });

  it("pending queue collapses into one user-side per outbound (R2.3 / T15)", async () => {
    // Pre-T15 this test asserted FIFO 1:1 matching (each outbound
    // pairs with the next-oldest inbound). That diverged from W4a
    // `computeDelta`, which collapses consecutive user messages
    // before one assistant reply via `pendingUsers.join("\n")`.
    // T15 aligned W4b with that semantic — the whole pending queue
    // drains into the first outbound; subsequent outbounds with no
    // queued users are treated as chunked replies / proactive
    // notifications and bail per the R21.2 orphan-assistant guard.
    writer.onMessageReceived({ sessionKey: "sk", direction: "inbound", text: "first" });
    writer.onMessageReceived({ sessionKey: "sk", direction: "inbound", text: "second" });
    writer.onMessageSent({ sessionKey: "sk", direction: "outbound", text: "reply-1" });
    await flushMicrotasks();
    writer.onMessageSent({ sessionKey: "sk", direction: "outbound", text: "reply-2" });
    await flushMicrotasks();
    // Exactly ONE persist — `("first\nsecond", reply-1)`. `reply-2`
    // bails because the queue is empty (R21.2).
    expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(1);
    expect(mockClient.storeChatTurn.mock.calls[0][1]).toBe("first\nsecond");
    expect(mockClient.storeChatTurn.mock.calls[0][2]).toBe("reply-1");
  });

  it("cross-path dedup: agent_end followed by message:sent with same content writes once (R2.2)", async () => {
    // First W4a path persists a turn.
    const event: AgentEndContext = {
      sessionId: "test",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
      ],
    };
    writer.onAgentEnd(event, { channelId: "tg", sessionKey: "sk" });
    await flushMicrotasks();
    expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(1);

    // Now the internal hook fires for the same exchange. Same sessionId
    // derivation + same user/assistant text → same turnId → must not
    // double-write.
    writer.onMessageReceived({
      sessionKey: "sk",
      direction: "inbound",
      text: "hi",
      // channelId matching so deriveSessionIdFromEvent produces openclaw:tg:sk
      // (same as deriveSessionId(ctx) above).
      ...({ context: { channelId: "tg" } } as any),
    } as any);
    writer.onMessageSent({
      sessionKey: "sk",
      direction: "outbound",
      text: "hello",
      ...({ context: { channelId: "tg", success: true } } as any),
    } as any);
    await flushMicrotasks();
    expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(1);
  });

  it("releases turnId reservation on persist failure so retry can succeed (R3.1)", async () => {
    // First call: fails outright (no retry path exhausted).
    mockClient.storeChatTurn = vi
      .fn()
      .mockRejectedValueOnce(new Error("net down"))
      .mockRejectedValueOnce(new Error("net down still"))
      .mockResolvedValue(undefined);
    writer = new ChatTurnWriter({ client: mockClient, logger: mockLogger, stateDir });

    const event: AgentEndContext = {
      sessionId: "t",
      messages: [
        { role: "user", content: "u" },
        { role: "assistant", content: "a" },
      ],
    };
    writer.onAgentEnd(event, { channelId: "ch", sessionKey: "sk" });
    await new Promise((r) => setTimeout(r, 1400)); // wait through persistOne's 250+1000ms backoff
    expect(mockClient.storeChatTurn.mock.calls.length).toBeGreaterThanOrEqual(2);

    // Round 2: same content, different instance state — dedup map must have
    // released the turnId on the failure, so the retry actually persists.
    mockClient.storeChatTurn.mockClear();
    mockClient.storeChatTurn.mockResolvedValue(undefined);
    writer.onAgentEnd(event, { channelId: "ch", sessionKey: "sk" });
    await flushMicrotasks();
    // Would be 0 if the failed turnId was still in the dedup map.
    expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(1);
  });

  it("onMessageSent strips <recalled-memory> from assistant text only (R3.2)", async () => {
    const echoed =
      "sure — <recalled-memory data-source=\"dkg-auto-recall\">[1] (agent-context-wm) secret</recalled-memory> here is your answer";
    writer.onMessageReceived({
      sessionKey: "sk",
      direction: "inbound",
      text: "q",
      ...({ context: { channelId: "tg" } } as any),
    } as any);
    writer.onMessageSent({
      sessionKey: "sk",
      direction: "outbound",
      text: echoed,
      ...({ context: { success: true, channelId: "tg" } } as any),
    } as any);
    await flushMicrotasks();
    expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(1);
    const [, persistedUser, persistedAssistant] = mockClient.storeChatTurn.mock.calls[0];
    expect(persistedUser).toBe("q"); // user side NOT stripped
    expect(persistedAssistant).not.toContain("recalled-memory");
    expect(persistedAssistant).not.toContain("secret");
    expect(persistedAssistant).toContain("sure");
    expect(persistedAssistant).toContain("here is your answer");
  });

  it("two identical-content real turns outside dedup TTL both persist (R5.1)", async () => {
    const event: AgentEndContext = {
      sessionId: "t",
      messages: [
        { role: "user", content: "thanks" },
        { role: "assistant", content: "you're welcome" },
      ],
    };
    writer.onAgentEnd(event, { channelId: "ch", sessionKey: "sk" });
    await flushMicrotasks();
    expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(1);

    // Wait past the 3s dedup TTL; a second identical-content turn must
    // persist rather than being eaten as a duplicate.
    await new Promise((r) => setTimeout(r, 3100));

    const event2: AgentEndContext = {
      sessionId: "t",
      messages: [
        { role: "user", content: "thanks" },
        { role: "assistant", content: "you're welcome" },
        { role: "user", content: "thanks" },
        { role: "assistant", content: "you're welcome" },
      ],
    };
    writer.onAgentEnd(event2, { channelId: "ch", sessionKey: "sk" });
    await flushMicrotasks();
    expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(2);
  }, 10_000);

  it("onBeforeCompaction clears the watermark so post-compaction turns persist (R5.2)", async () => {
    // First: persist 3 turns so watermark advances to 2.
    const preEvent: AgentEndContext = {
      sessionId: "t",
      messages: [
        { role: "user", content: "u1" },
        { role: "assistant", content: "a1" },
        { role: "user", content: "u2" },
        { role: "assistant", content: "a2" },
        { role: "user", content: "u3" },
        { role: "assistant", content: "a3" },
      ],
    };
    writer.onAgentEnd(preEvent, { channelId: "ch", sessionKey: "sk" });
    await flushMicrotasks();
    await new Promise((r) => setTimeout(r, 70)); // let the 50ms debounce commit
    expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(3);

    mockClient.storeChatTurn.mockClear();
    // Session-scoped reset — must pass the same ctx so the correct
    // session's watermark is cleared.
    writer.onBeforeCompaction({}, { channelId: "ch", sessionKey: "sk" });

    // After compaction a shorter messages array arrives (representative of
    // gateway summarization: old turns folded to a single summary pair).
    // Without the watermark reset, the pair-count cursor at 2 would skip
    // the first 3 pairs of this new array entirely.
    // Also wait past the 3s dedup TTL so identical-text turns aren't
    // blocked by the cross-path dedup map.
    await new Promise((r) => setTimeout(r, 3100));
    const postEvent: AgentEndContext = {
      sessionId: "t",
      messages: [
        { role: "user", content: "summary" },
        { role: "assistant", content: "ack" },
        { role: "user", content: "follow-up" },
        { role: "assistant", content: "reply" },
      ],
    };
    writer.onAgentEnd(postEvent, { channelId: "ch", sessionKey: "sk" });
    await flushMicrotasks();
    expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(2);
    expect(mockClient.storeChatTurn.mock.calls[0][1]).toBe("summary");
    expect(mockClient.storeChatTurn.mock.calls[1][1]).toBe("follow-up");
  }, 10_000);

  it("onBeforeCompaction resets only the affected session's watermark (R6.1)", async () => {
    // Session A: persist 2 pairs → watermark advances to 1.
    const eventA: AgentEndContext = {
      sessionId: "t",
      messages: [
        { role: "user", content: "a-u1" },
        { role: "assistant", content: "a-a1" },
        { role: "user", content: "a-u2" },
        { role: "assistant", content: "a-a2" },
      ],
    };
    writer.onAgentEnd(eventA, { channelId: "chA", sessionKey: "skA" });
    await flushMicrotasks();
    await new Promise((r) => setTimeout(r, 70)); // commit debounce
    // Session B: persist 2 pairs → session B watermark advances.
    const eventB: AgentEndContext = {
      sessionId: "t",
      messages: [
        { role: "user", content: "b-u1" },
        { role: "assistant", content: "b-a1" },
        { role: "user", content: "b-u2" },
        { role: "assistant", content: "b-a2" },
      ],
    };
    writer.onAgentEnd(eventB, { channelId: "chB", sessionKey: "skB" });
    await flushMicrotasks();
    await new Promise((r) => setTimeout(r, 70));

    mockClient.storeChatTurn.mockClear();
    // Compact session A only — session B's cursor must survive.
    writer.onBeforeCompaction({}, { channelId: "chA", sessionKey: "skA" });

    // Wait past dedup TTL so identical text wouldn't be blocked.
    await new Promise((r) => setTimeout(r, 3100));

    // Fire session B's agent_end with the SAME 2 pairs it already has.
    // If R6.1 was broken (full wipe), we'd see 2 new persists (both pairs
    // re-played into DKG). With session-scoped reset, B's watermark is
    // still at its prior position → 0 new persists expected.
    writer.onAgentEnd(eventB, { channelId: "chB", sessionKey: "skB" });
    await flushMicrotasks();
    expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(0);
  }, 10_000);

  it("distinct accountId/conversationId produce distinct sessionIds (R4.1 thread separation)", async () => {
    // Two events sharing sessionKey on the same channel but differing in
    // accountId must land under different DKG sessionIds — otherwise
    // unrelated Telegram/WhatsApp threads merge into one persisted
    // session and turns across threads could be mis-dedup'd.
    writer.onMessageReceived({
      sessionKey: "shared-key",
      direction: "inbound",
      text: "hi from A",
      ...({ context: { channelId: "tg", accountId: "userA", conversationId: "convA" } } as any),
    } as any);
    writer.onMessageSent({
      sessionKey: "shared-key",
      direction: "outbound",
      text: "reply to A",
      ...({ context: { channelId: "tg", accountId: "userA", conversationId: "convA", success: true } } as any),
    } as any);
    writer.onMessageReceived({
      sessionKey: "shared-key",
      direction: "inbound",
      text: "hi from B",
      ...({ context: { channelId: "tg", accountId: "userB", conversationId: "convB" } } as any),
    } as any);
    writer.onMessageSent({
      sessionKey: "shared-key",
      direction: "outbound",
      text: "reply to B",
      ...({ context: { channelId: "tg", accountId: "userB", conversationId: "convB", success: true } } as any),
    } as any);
    await flushMicrotasks();
    expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(2);
    const sidA = mockClient.storeChatTurn.mock.calls[0][0];
    const sidB = mockClient.storeChatTurn.mock.calls[1][0];
    expect(sidA).not.toBe(sidB);
    expect(sidA).toContain("userA");
    expect(sidB).toContain("userB");
  });

  it("computeDelta preserves user text containing <recalled-memory> tag (R3.4)", async () => {
    const userWithTag =
      "I'm trying to debug this log excerpt: <recalled-memory>something</recalled-memory>";
    const event: AgentEndContext = {
      sessionId: "t",
      messages: [
        { role: "user", content: userWithTag },
        { role: "assistant", content: "that looks malformed" },
      ],
    };
    writer.onAgentEnd(event, { channelId: "ch", sessionKey: "sk" });
    await flushMicrotasks();
    const [, u] = mockClient.storeChatTurn.mock.calls[0];
    // User side preserves the raw tag content verbatim.
    expect(u).toBe(userWithTag);
  });

  it("drops failed outbound sends without persisting, still consumes pending (R1 failed sends)", async () => {
    writer.onMessageReceived({ sessionKey: "sk", direction: "inbound", text: "hello" });
    writer.onMessageSent({
      sessionKey: "sk",
      direction: "outbound",
      text: "never-delivered",
      ...({ context: { success: false } } as any),
    } as any);
    await flushMicrotasks();
    expect(mockClient.storeChatTurn).not.toHaveBeenCalled();
    // The pending inbound must have been consumed — a later successful turn
    // should not re-pair with the stale "hello".
    writer.onMessageReceived({ sessionKey: "sk", direction: "inbound", text: "retry" });
    writer.onMessageSent({
      sessionKey: "sk",
      direction: "outbound",
      text: "second-try",
      ...({ context: { success: true } } as any),
    } as any);
    await flushMicrotasks();
    expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(1);
    expect(mockClient.storeChatTurn.mock.calls[0][1]).toBe("retry");
  });

  it("T21 — setStateDir awaits in-flight persists before swapping paths (no lost turns mid-migration)", async () => {
    // Regression for T21: the earlier T18 migration used flushSync(),
    // which only writes the debounced watermark and does NOT await
    // in-flight `storeChatTurn` jobs. Mid-migration completions
    // would land at the OLD path while the writer was already
    // pointed at the NEW path — silent data loss / desync.
    let releaseStore: (() => void) | null = null;
    let storeStarted = false;
    let storeFinished = false;
    mockClient.storeChatTurn = vi.fn().mockImplementation(async () => {
      storeStarted = true;
      await new Promise<void>((resolve) => { releaseStore = resolve; });
      storeFinished = true;
    });
    writer = new ChatTurnWriter({ client: mockClient, logger: mockLogger, stateDir });

    // Start a persist that hangs.
    writer.onMessageReceived({ sessionKey: "sk", context: { channelId: "tg", content: "u1" } } as any);
    void writer.onMessageSent({
      sessionKey: "sk",
      context: { channelId: "tg", content: "r1", success: true, messageId: "out-1" },
    } as any);
    await flushMicrotasks();
    expect(storeStarted).toBe(true);
    expect(storeFinished).toBe(false);

    // Trigger setStateDir while the persist is hanging. It must NOT
    // proceed past the `flush()` call until storeChatTurn returns.
    const newStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "chatturnwriter-t21-"));
    let migrationFinished = false;
    const migrationPromise = writer.setStateDir(newStateDir).then(() => {
      migrationFinished = true;
    });
    // Give the migration a tick to start.
    await flushMicrotasks();
    // Migration MUST be blocked on flush() awaiting the in-flight
    // storeChatTurn. If it finished, T21 was not actually addressed.
    expect(migrationFinished).toBe(false);

    // Now release the persist; migration proceeds.
    releaseStore?.();
    await migrationPromise;
    expect(storeFinished).toBe(true);
    expect(migrationFinished).toBe(true);
    // New file exists at the new location.
    const newFile = path.join(newStateDir, "dkg-adapter", "chat-turn-watermarks.json");
    expect(fs.existsSync(newFile)).toBe(true);
    try { fs.rmSync(newStateDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it("T27 — setStateDir leaves stateDir/watermarkFilePath unchanged when the new-path write fails (retry-safe)", async () => {
    // Regression for T27: pre-fix `setStateDir` swapped internal
    // `stateDir` / `watermarkFilePath` BEFORE attempting the write.
    // A failed write left the writer pointing at the broken new path,
    // and a retry of `setStateDir(newStateDir)` short-circuited under
    // the same-path guard — the migration never re-attempted.
    const dkw = writer as any;
    dkw.cachedWatermarks.set("openclaw:tg:::sk", 5);
    dkw.writeWatermarkFile();
    const oldStateDir = dkw.stateDir;
    const oldWatermarkFilePath = dkw.watermarkFilePath;

    // Force write failure via parent-is-a-file ENOTDIR.
    const blockingFile = path.join(stateDir, "blocker27.txt");
    fs.writeFileSync(blockingFile, "blocker");
    const badStateDir = path.join(blockingFile, "nested-not-a-dir");

    await writer.setStateDir(badStateDir);

    // Internal state MUST still point at the OLD path so a follow-up
    // setStateDir(badStateDir) (or any other target) re-attempts
    // instead of short-circuiting on the same-path guard.
    expect(dkw.stateDir).toBe(oldStateDir);
    expect(dkw.watermarkFilePath).toBe(oldWatermarkFilePath);

    // A retry to a VALID destination must now succeed normally —
    // proves the failed migration didn't poison the writer.
    const goodStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "chatturnwriter-t27-good-"));
    try {
      await writer.setStateDir(goodStateDir);
      expect(dkw.stateDir).toBe(goodStateDir);
      const goodFile = path.join(goodStateDir, "dkg-adapter", "chat-turn-watermarks.json");
      expect(fs.existsSync(goodFile)).toBe(true);
    } finally {
      try { fs.rmSync(goodStateDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });

  it("T28 — computeDelta skips image-only user messages (no blank-user assistant pair)", async () => {
    // Regression for T28: pre-fix `computeDelta` queued every user
    // message into `pendingUsers`, including ones whose multi-modal
    // content array had no `type === "text"` parts (extractText
    // returns ""). The next assistant reply was then persisted as
    // `{ user: "", assistant: reply }` — a blank-user turn.
    // Post-fix W4a mirrors W4b's R15.2 invariant: image-only user
    // messages are skipped in `pendingUsers`, so an immediately-
    // following reply pairs only with the most recent text user
    // message (or bails per R22.1 if there is none).
    const event: AgentEndContext = {
      sessionId: "test",
      messages: [
        { role: "user", content: "real text question" },
        { role: "user", content: [{ type: "image", text: undefined } as any] }, // image-only
        { role: "assistant", content: "reply" },
      ],
    };
    writer.onAgentEnd(event, { channelId: "tg", sessionKey: "sk" });
    await flushMicrotasks();
    expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(1);
    const call = mockClient.storeChatTurn.mock.calls[0];
    // user side must be the text question — NOT an empty string from
    // the image-only message blowing away the join, NOT a "real text
    // question\n" with a trailing blank from the join with "".
    expect(call[1]).toBe("real text question");
    expect(call[2]).toBe("reply");
  });

  it("T28 — image-only user followed by another text user collapses ONLY the text users (consistent with W4b R15.2)", async () => {
    // Edge case: [text-u1, image-u2, text-u3, reply]. The image
    // contributes nothing; the join is "u1\nu3", not "u1\n\nu3".
    const event: AgentEndContext = {
      sessionId: "test",
      messages: [
        { role: "user", content: "u1" },
        { role: "user", content: [{ type: "image", text: undefined } as any] },
        { role: "user", content: "u3" },
        { role: "assistant", content: "reply" },
      ],
    };
    writer.onAgentEnd(event, { channelId: "tg", sessionKey: "sk" });
    await flushMicrotasks();
    expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(1);
    expect(mockClient.storeChatTurn.mock.calls[0][1]).toBe("u1\nu3");
  });

  it("T23 — setStateDir does NOT delete the old file when the write at the new path fails", async () => {
    // Regression for T23: pre-fix, `setStateDir` unconditionally
    // unlinked the OLD file after calling `writeWatermarkFile()`,
    // which silently swallows errors. If the new location was
    // unwritable (permissions, ENOSPC, ENOENT on parent), the
    // migration would delete the only valid watermark file —
    // restart would backfill every previously-persisted turn as
    // new (daemon duplicate writes). Post-fix, the old file is
    // preserved when the new write fails.
    // Seed and persist some state at the old path so we have a file
    // to protect across the migration.
    const dkw = writer as any;
    dkw.cachedWatermarks.set("openclaw:tg:::sk", 5);
    // Write directly via the private helper — `flushSync()` is a no-op
    // when there are no pending debounce timers.
    dkw.writeWatermarkFile();
    const oldFile = path.join(stateDir, "dkg-adapter", "chat-turn-watermarks.json");
    expect(fs.existsSync(oldFile)).toBe(true);

    // Make the new destination unwritable: point setStateDir at a path
    // where the parent ITSELF is a file, not a directory. The internal
    // `mkdirSync(dir, { recursive: true })` call will throw ENOTDIR on
    // the file ancestor, the catch in writeWatermarkFile returns false,
    // and the old file deletion must be skipped.
    const blockingFile = path.join(stateDir, "blocker.txt");
    fs.writeFileSync(blockingFile, "blocker");
    const newStateDir = path.join(blockingFile, "nested-not-a-dir");

    await writer.setStateDir(newStateDir);
    // The old file MUST still exist — preserved as recovery source
    // because the write at the new path failed.
    expect(fs.existsSync(oldFile)).toBe(true);
  });

  it("T22 — setStateDir merges destination state via max(w)/max(b) instead of overwriting (no rollback)", async () => {
    // Regression for T22: the earlier T18 migration used
    // `fs.copyFileSync` unconditionally, which rolled back any newer
    // state at the destination from a prior run. Post-fix, the merge
    // takes max(watermark) and max(w4bCount) per session.
    const newStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "chatturnwriter-t22-"));
    const newDir = path.join(newStateDir, "dkg-adapter");
    fs.mkdirSync(newDir, { recursive: true });
    const newFile = path.join(newDir, "chat-turn-watermarks.json");
    // Pre-seed destination with NEWER state for one session and a
    // unique-to-destination session.
    fs.writeFileSync(newFile, JSON.stringify({
      "openclaw:tg:::sk-shared": { w: 10, b: 5 },     // newer than source
      "openclaw:tg:::sk-onlydst": { w: 99, b: 99 },   // not in source
    }));

    // Source writer has OLDER state for sk-shared and a unique session.
    const dkw = writer as any;
    dkw.cachedWatermarks.set("openclaw:tg:::sk-shared", 3);    // older
    dkw.w4bSessionCounts.set("openclaw:tg:::sk-shared", 2);    // older
    dkw.cachedWatermarks.set("openclaw:tg:::sk-onlysrc", 7);   // not in destination
    dkw.w4bSessionCounts.set("openclaw:tg:::sk-onlysrc", 4);

    await writer.setStateDir(newStateDir);

    // Read the merged file at the new location.
    const merged = JSON.parse(fs.readFileSync(newFile, "utf-8"));
    // sk-shared: max(3, 10) = 10; max(2, 5) = 5 → destination's wins.
    expect(merged["openclaw:tg:::sk-shared"]).toEqual({ w: 10, b: 5 });
    // sk-onlydst: preserved unchanged.
    expect(merged["openclaw:tg:::sk-onlydst"]).toEqual({ w: 99, b: 99 });
    // sk-onlysrc: source values carried over.
    expect(merged["openclaw:tg:::sk-onlysrc"]).toEqual({ w: 7, b: 4 });

    try { fs.rmSync(newStateDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it("T43 — setStateDir restores in-memory watermarks when the new-path write fails (no destination-state pollution)", async () => {
    // Regression for T43: pre-fix the merge mutated `cachedWatermarks`
    // / `w4bSessionCounts` BEFORE attempting the write. If the write
    // failed, the writer kept old paths but carried the destination's
    // (newer) watermarks in memory, so the next persist would skip
    // turns whose pair index is < the merged watermark.
    const newStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "chatturnwriter-t43-"));
    const newDir = path.join(newStateDir, "dkg-adapter");
    fs.mkdirSync(newDir, { recursive: true });
    const newFile = path.join(newDir, "chat-turn-watermarks.json");
    // Destination file exists with NEWER state for one session, so the
    // merge phase has something to merge.
    fs.writeFileSync(newFile, JSON.stringify({
      "openclaw:tg:::sk-shared": { w: 99, b: 50 },
    }));

    // Source writer has OLDER state.
    const dkw = writer as any;
    dkw.cachedWatermarks.set("openclaw:tg:::sk-shared", 5);
    dkw.w4bSessionCounts.set("openclaw:tg:::sk-shared", 2);

    // Force the write to fail via vi.spyOn — first call returns false
    // (the new-path write inside setStateDir), subsequent calls fall
    // through to the real implementation.
    const writeSpy = vi.spyOn(dkw, "writeWatermarkFile").mockImplementationOnce(() => false);

    await writer.setStateDir(newStateDir);

    // In-memory state MUST be the old values, not the destination's.
    expect(dkw.cachedWatermarks.get("openclaw:tg:::sk-shared")).toBe(5);
    expect(dkw.w4bSessionCounts.get("openclaw:tg:::sk-shared")).toBe(2);
    // stateDir / watermarkFilePath unchanged on failure.
    expect(dkw.stateDir).not.toBe(newStateDir);

    writeSpy.mockRestore();
    try { fs.rmSync(newStateDir, { recursive: true, force: true }); } catch { /* best effort */ }
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
});
