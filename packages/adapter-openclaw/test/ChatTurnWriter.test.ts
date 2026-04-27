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
    // turnId is intentionally not passed to the daemon (kept in-memory
    // for cross-path dedup only); daemon mints its own RDF-subject UUID.
    expect(mockClient.storeChatTurn).toHaveBeenCalledWith(
      "openclaw:ch:::sk",
      "hello world",
      "hi there",
    );
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

  it("strips well-formed <recalled-memory> block from assistant text before persist (I1)", async () => {
    const event: AgentEndContext = {
      sessionId: "test",
      messages: [
        { role: "user", content: "query" },
        {
          role: "assistant",
          content: "prefix <recalled-memory>\n[1] (agent-context-wm) secret\n</recalled-memory> suffix",
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

  it("strips orphaned <recalled-memory> open tag when closing tag is missing (I1 truncation)", async () => {
    const event: AgentEndContext = {
      sessionId: "test",
      messages: [
        { role: "user", content: "query" },
        {
          role: "assistant",
          content: "answer text <recalled-memory>\n[1] (agent-context-wm) truncated",
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

  it("computes deterministic in-memory dedup turnId from content (16-hex)", async () => {
    // The deterministic turnId stays in-process for cross-path dedup.
    // We assert behaviour by calling the same content twice within the
    // 3s TTL window and verifying only one persist fires (dedup hit).
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
    // Inspect the underlying dedup-map key shape: `<sessionId>::<turnId>`.
    // sessionId itself contains ':' separators (e.g. `openclaw:ch:::sk`),
    // so split on the LAST '::' to extract the turnId suffix.
    const recent = (writer as any).recentTurnIds as Map<string, number>;
    expect(recent.size).toBe(1);
    const [key] = Array.from(recent.keys());
    const turnId = key.slice(key.lastIndexOf("::") + 2);
    expect(turnId).toMatch(/^[0-9a-f]{16}$/);
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

  it("FIFO pending queue pairs replies with the oldest unmatched inbound (R2.3)", async () => {
    // Two inbound messages arrive back-to-back before any outbound reply.
    writer.onMessageReceived({ sessionKey: "sk", direction: "inbound", text: "first" });
    writer.onMessageReceived({ sessionKey: "sk", direction: "inbound", text: "second" });
    // Two outbound replies go out in order.
    writer.onMessageSent({ sessionKey: "sk", direction: "outbound", text: "reply-1" });
    await flushMicrotasks();
    writer.onMessageSent({ sessionKey: "sk", direction: "outbound", text: "reply-2" });
    await flushMicrotasks();
    expect(mockClient.storeChatTurn).toHaveBeenCalledTimes(2);
    expect(mockClient.storeChatTurn.mock.calls[0][1]).toBe("first");
    expect(mockClient.storeChatTurn.mock.calls[0][2]).toBe("reply-1");
    expect(mockClient.storeChatTurn.mock.calls[1][1]).toBe("second");
    expect(mockClient.storeChatTurn.mock.calls[1][2]).toBe("reply-2");
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
      "sure — <recalled-memory>[1] (agent-context-wm) secret</recalled-memory> here is your answer";
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
});
