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

  it("caps sessionId parts at 64 chars", async () => {
    const longStr = "a".repeat(100);
    const event = {
      sessionId: "test",
      messages: [
        { role: "user" as const, content: "x" },
        { role: "assistant" as const, content: "y" },
      ],
    };
    writer.onAgentEnd(event, { channelId: longStr, sessionKey: "sk" });
    await flush();
    const call = mockClient.storeChatTurn.mock.calls[0];
    const sessionId = call[0] as string;
    const channelPart = sessionId.split(":")[1];
    expect(channelPart.length).toBeLessThanOrEqual(64);
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
