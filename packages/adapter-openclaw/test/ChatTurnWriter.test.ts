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
    // After R13.1, a single W4a persist stamps exactly TWO map
    // entries — the writer never reserves a key it does not own:
    //   1. The pair-indexed turnId (the W4a write key)
    //   2. The W4a-origin key (`w4a-content::<sha>`) so future W4b
    //      fires dedup against this write
    // The cross-path peek of `w4b-content::<sha>` is a non-mutating
    // presence check (R13.1) and must NOT add a third entry.
    expect(recent.size).toBe(2);
    const keys = Array.from(recent.keys());
    const w4aKey = keys.find((k) => k.includes("::w4a-content::"));
    const turnIdKey = keys.find((k) => k !== w4aKey)!;
    expect(w4aKey).toMatch(/::w4a-content::[0-9a-f]{16}$/);
    // Negative assertion — peek must not have stamped a w4b-origin.
    expect(keys.some((k) => k.includes("::w4b-content::"))).toBe(false);
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
    // w4b-origin key directly in the dedup map. This is what
    // `onMessageSent` does after a successful persist.
    dkw.markTurnIdSeen(sessionId, dkw.w4bOriginKey("ping", "pong"));

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
});
