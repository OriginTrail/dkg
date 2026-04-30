import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ChatTurnWriter } from "../src/ChatTurnWriter";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

describe("ChatTurnWriter crash recovery (Task #12)", () => {
  let stateDir: string;
  let mockClient: { storeChatTurn: ReturnType<typeof vi.fn> };
  let mockLogger: { debug: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "chatturn-recovery-"));
    mockLogger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    mockClient = { storeChatTurn: vi.fn().mockResolvedValue(undefined) };
  });

  afterEach(() => {
    try {
      fs.rmSync(stateDir, { recursive: true, force: true });
    } catch {
      // best effort
    }
    vi.clearAllMocks();
  });

  it("survives missing watermark file on init", () => {
    // Fresh stateDir, no watermark file
    new ChatTurnWriter({ client: mockClient, logger: mockLogger, stateDir });
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it("tolerates malformed JSON in watermark file", () => {
    const wmPath = path.join(stateDir, "dkg-adapter", "chat-turn-watermarks.json");
    fs.mkdirSync(path.dirname(wmPath), { recursive: true });
    fs.writeFileSync(wmPath, "{invalid json", "utf-8");
    new ChatTurnWriter({ client: mockClient, logger: mockLogger, stateDir });
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  it("writes watermark file via atomic tmp+rename after debounce", async () => {
    const writer = new ChatTurnWriter({ client: mockClient, logger: mockLogger, stateDir });
    const event = {
      sessionId: "test",
      messages: [
        { role: "user" as const, content: "x" },
        { role: "assistant" as const, content: "y" },
      ],
    };
    writer.onAgentEnd(event, { channelId: "ch", sessionKey: "sk" });
    await new Promise((r) => setTimeout(r, 150));
    const wmPath = path.join(stateDir, "dkg-adapter", "chat-turn-watermarks.json");
    expect(fs.existsSync(wmPath)).toBe(true);
    const content = JSON.parse(fs.readFileSync(wmPath, "utf-8"));
    expect(typeof content).toBe("object");
    writer.flushSync();
  });

  it("flushSync during pending debounce does not throw", async () => {
    const writer = new ChatTurnWriter({ client: mockClient, logger: mockLogger, stateDir });
    const event = {
      sessionId: "test",
      messages: [
        { role: "user" as const, content: "x" },
        { role: "assistant" as const, content: "y" },
      ],
    };
    writer.onAgentEnd(event, { channelId: "ch", sessionKey: "sk" });
    expect(() => writer.flushSync()).not.toThrow();
    await new Promise((r) => setTimeout(r, 50));
    expect(mockLogger.error).not.toHaveBeenCalled();
  });
});
