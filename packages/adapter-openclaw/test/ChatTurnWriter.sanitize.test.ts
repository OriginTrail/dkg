import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ChatTurnWriter } from "../src/ChatTurnWriter";

const flush = () => new Promise((r) => setTimeout(r, 20));

describe("ChatTurnWriter.sanitize (N6)", () => {
  let writer: ChatTurnWriter;
  let mockClient: { storeChatTurn: ReturnType<typeof vi.fn> };
  let mockLogger: { debug: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
  let stateDir: string;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "chatturn-sanitize-"));
    mockLogger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    mockClient = { storeChatTurn: vi.fn().mockResolvedValue(undefined) };
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

  it("strips null bytes from sessionId parts", async () => {
    const event = {
      sessionId: "test",
      messages: [
        { role: "user" as const, content: "a\x00b" },
        { role: "assistant" as const, content: "y" },
      ],
    };
    writer.onAgentEnd(event, { channelId: "c\x00h", sessionKey: "sk" });
    await flush();
    const call = mockClient.storeChatTurn.mock.calls[0];
    expect(call[0]).toBe("openclaw:ch:::sk");
  });

  it("strips control chars from sessionId parts", async () => {
    const event = {
      sessionId: "test",
      messages: [
        { role: "user" as const, content: "a" },
        { role: "assistant" as const, content: "y" },
      ],
    };
    writer.onAgentEnd(event, { channelId: "ch\x1fX", sessionKey: "sk" });
    await flush();
    const call = mockClient.storeChatTurn.mock.calls[0];
    expect(call[0]).toBe("openclaw:chX:::sk");
  });

  it("strips DEL byte from sessionId parts", async () => {
    const event = {
      sessionId: "test",
      messages: [
        { role: "user" as const, content: "a" },
        { role: "assistant" as const, content: "y" },
      ],
    };
    writer.onAgentEnd(event, { channelId: "c\x7fh", sessionKey: "sk" });
    await flush();
    const call = mockClient.storeChatTurn.mock.calls[0];
    expect(call[0]).toBe("openclaw:ch:::sk");
  });

  it("bounds sessionId parts to 96 chars and preserves distinguishing suffix via hash (R13.2)", async () => {
    // Two long values that share the first 80 chars but diverge in the
    // suffix. With the old 64-char truncation these collapsed to the
    // same composed sessionId — merging unrelated conversations'
    // watermarks. The hash-on-overflow design must produce DISTINCT
    // outputs for these two distinct inputs.
    const sharedPrefix = "a".repeat(80);
    const longA = sharedPrefix + "BBBBBBBBBBBBBBBBBBBB";
    const longB = sharedPrefix + "CCCCCCCCCCCCCCCCCCCC";

    const evA = {
      sessionId: "test",
      messages: [
        { role: "user" as const, content: "x" },
        { role: "assistant" as const, content: "y" },
      ],
    };
    writer.onAgentEnd(evA, { channelId: longA, sessionKey: "sk" });
    await flush();
    const evB = {
      sessionId: "test",
      messages: [
        { role: "user" as const, content: "x" },
        { role: "assistant" as const, content: "y" },
      ],
    };
    writer.onAgentEnd(evB, { channelId: longB, sessionKey: "sk" });
    await flush();

    const idA = mockClient.storeChatTurn.mock.calls[0][0] as string;
    const idB = mockClient.storeChatTurn.mock.calls[1][0] as string;
    const partA = idA.split(":")[1];
    const partB = idB.split(":")[1];
    expect(partA.length).toBeLessThanOrEqual(96);
    expect(partB.length).toBeLessThanOrEqual(96);
    expect(idA).not.toBe(idB);
  });

  it("passes short sessionId parts through without hashing (R13.2)", async () => {
    const event = {
      sessionId: "test",
      messages: [
        { role: "user" as const, content: "x" },
        { role: "assistant" as const, content: "y" },
      ],
    };
    writer.onAgentEnd(event, { channelId: "ch-short-readable", sessionKey: "sk" });
    await flush();
    const call = mockClient.storeChatTurn.mock.calls[0];
    expect(call[0]).toBe("openclaw:ch-short-readable:::sk");
  });

  it("passes clean sessionId parts unchanged", async () => {
    const event = {
      sessionId: "test",
      messages: [
        { role: "user" as const, content: "clean" },
        { role: "assistant" as const, content: "resp" },
      ],
    };
    writer.onAgentEnd(event, { channelId: "ch", sessionKey: "sk" });
    await flush();
    const call = mockClient.storeChatTurn.mock.calls[0];
    expect(call[0]).toBe("openclaw:ch:::sk");
  });

  it("handles mixed control + long strings without throwing", async () => {
    const mixed = "a\x00b\x1fc" + "d".repeat(100);
    const event = {
      sessionId: "test",
      messages: [
        { role: "user" as const, content: "x" },
        { role: "assistant" as const, content: "y" },
      ],
    };
    expect(() => writer.onAgentEnd(event, { channelId: mixed, sessionKey: "sk" })).not.toThrow();
    await flush();
    expect(mockClient.storeChatTurn).toHaveBeenCalled();
  });
});
