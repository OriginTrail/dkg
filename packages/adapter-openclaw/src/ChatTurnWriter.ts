import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";

interface Logger {
  info?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
  debug?: (...args: unknown[]) => void;
}

export interface ChatTurnMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string | Array<{ type: string; text?: string }>;
}

export interface AgentEndContext {
  sessionId: string;
  messages: ChatTurnMessage[];
}

export interface InternalMessageEvent {
  sessionKey: string;
  direction: "inbound" | "outbound";
  text: string;
}

export class ChatTurnWriter {
  private client: any;
  private logger: Logger;
  private stateDir: string;
  private cachedWatermarks: Map<string, number> = new Map();
  private pendingUserMessages: Map<string, string> = new Map();
  private debounceTimers: Map<string, NodeJS.Timeout> = new Map();
  private watermarkFilePath: string;

  constructor(options: { client: any; logger: Logger; stateDir: string }) {
    this.client = options.client;
    this.logger = options.logger;
    this.stateDir = options.stateDir;
    this.watermarkFilePath = path.join(this.stateDir, "dkg-adapter", "chat-turn-watermarks.json");
    this.initFromFile();
  }

  private initFromFile(): void {
    try {
      const dir = path.dirname(this.watermarkFilePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      if (fs.existsSync(this.watermarkFilePath)) {
        const content = fs.readFileSync(this.watermarkFilePath, "utf-8");
        const data = JSON.parse(content);
        if (data && typeof data === "object") {
          for (const [key, val] of Object.entries(data)) {
            if (typeof val === "number") {
              this.cachedWatermarks.set(key, val);
            }
          }
        }
      }
    } catch (err) {
      this.logger.warn?.("[ChatTurnWriter] Failed to load watermarks, starting fresh", { err });
    }
  }

  onAgentEnd(event: AgentEndContext, ctx?: any): void {
    try {
      const sessionId = this.deriveSessionId(ctx);
      if (!sessionId) return;
      const { user, assistant } = this.computeDelta(event.messages, this.loadWatermark(sessionId));
      if (user || assistant) {
        const turnId = this.deterministicTurnId(sessionId, user, assistant);
        this.persistOne(sessionId, user, assistant, turnId).catch((err) => {
          this.logger.error?.("[ChatTurnWriter.onAgentEnd] Persist failed", { err });
        });
      }
    } catch (err) {
      this.logger.error?.("[ChatTurnWriter.onAgentEnd] Error", { err });
    }
  }

  onBeforeCompaction(event: any, ctx?: any): void {
    try { this.flushSync(); } catch (err) {
      this.logger.error?.("[ChatTurnWriter.onBeforeCompaction] Error", { err });
    }
  }

  onBeforeReset(event: any, ctx?: any): void {
    try { this.flushSync(); } catch (err) {
      this.logger.error?.("[ChatTurnWriter.onBeforeReset] Error", { err });
    }
  }

  onMessageReceived(ev: InternalMessageEvent): void {
    try {
      const conversationKey = this.conversationKeyFromInternalEvent(ev);
      if (!conversationKey) return;
      this.pendingUserMessages.set(conversationKey, ev.text);
    } catch (err) {
      this.logger.error?.("[ChatTurnWriter.onMessageReceived] Error", { err });
    }
  }

  onMessageSent(ev: InternalMessageEvent): void {
    try {
      const conversationKey = this.conversationKeyFromInternalEvent(ev);
      if (!conversationKey) return;
      const userText = this.pendingUserMessages.get(conversationKey) || "";
      const assistantText = ev.text;
      const sessionId = this.deriveSessionIdFromKey(conversationKey);
      if (userText || assistantText) {
        const turnId = this.deterministicTurnId(sessionId, userText, assistantText);
        this.persistOne(sessionId, userText, assistantText, turnId).catch((err) => {
          this.logger.error?.("[ChatTurnWriter.onMessageSent] Persist failed", { err });
        });
      }
      this.pendingUserMessages.delete(conversationKey);
    } catch (err) {
      this.logger.error?.("[ChatTurnWriter.onMessageSent] Error", { err });
    }
  }

  flushSync(): void {
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
  }

  private computeDelta(messages: ChatTurnMessage[], savedUpTo: number): { user: string; assistant: string } {
    let user = "";
    let assistant = "";
    for (let i = savedUpTo + 1; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.role === "user") {
        user = this.extractText(msg.content);
      } else if (msg.role === "assistant") {
        assistant = this.extractText(msg.content);
      }
    }
    return { user: this.stripRecalledMemory(user), assistant: this.stripRecalledMemory(assistant) };
  }

  private stripRecalledMemory(text: string): string {
    if (!text) return "";
    const orphanMarker = "<!--TRUNCATED_FROM_SAVED_MEMORY-->";
    if (text.includes(orphanMarker) && !text.includes("<!--END_SAVED_MEMORY-->")) {
      return text.split(orphanMarker)[0].trim();
    }
    return text;
  }

  private sanitize(part: string): string {
    return part.replace(/[\x00-\x1f\x7f]/g, "").substring(0, 64);
  }

  private deterministicTurnId(sessionId: string, user: string, assistant: string): string {
    const combined = `${sessionId}:${user}:${assistant}`;
    return createHash("sha256").update(combined).digest("hex").slice(0, 16);
  }

  private deriveSessionId(ctx?: any): string {
    if (!ctx || !ctx.channelId || !ctx.sessionKey) return "";
    return `openclaw:${this.sanitize(ctx.channelId)}:${this.sanitize(ctx.sessionKey)}`;
  }

  private deriveSessionIdFromKey(conversationKey: string): string {
    const parts = conversationKey.split(":");
    if (parts.length >= 3) {
      return parts.slice(0, 3).join(":");
    }
    return conversationKey;
  }

  private conversationKeyFromInternalEvent(ev: InternalMessageEvent): string {
    if (!ev.sessionKey) {
      this.logger.warn?.("[ChatTurnWriter] No sessionKey in internal event");
      return "";
    }
    return `openclaw:unknown:${this.sanitize(ev.sessionKey)}`;
  }

  private extractText(content: string | Array<{ type: string; text?: string }>): string {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .filter((part) => part.type === "text")
        .map((part) => part.text || "")
        .join(" ");
    }
    return "";
  }

  private loadWatermark(sessionId: string): number {
    return this.cachedWatermarks.get(sessionId) ?? -1;
  }

  private saveWatermark(sessionId: string, index: number): void {
    const timer = this.debounceTimers.get(sessionId);
    if (timer) clearTimeout(timer);
    const newTimer = setTimeout(() => {
      this.cachedWatermarks.set(sessionId, index);
      this.writeWatermarkFile();
    }, 50);
    this.debounceTimers.set(sessionId, newTimer);
  }

  private async persistOne(
    sessionId: string,
    user: string,
    assistant: string,
    turnId: string
  ): Promise<void> {
    let attempt = 0;
    while (attempt < 2) {
      try {
        await this.client.persistChatTurn({ sessionId, turnId, user, assistant });
        const currentIndex = this.loadWatermark(sessionId);
        this.saveWatermark(sessionId, currentIndex + 1);
        this.logger.debug?.("[ChatTurnWriter] Persisted turn", { sessionId, turnId });
        return;
      } catch (err) {
        attempt++;
        if (attempt < 2) {
          const backoff = attempt === 1 ? 250 : 1000;
          await new Promise((resolve) => setTimeout(resolve, backoff));
        } else {
          throw err;
        }
      }
    }
  }

  private writeWatermarkFile(): void {
    try {
      const data = Object.fromEntries(this.cachedWatermarks);
      const tmpPath = `${this.watermarkFilePath}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8");
      fs.renameSync(tmpPath, this.watermarkFilePath);
    } catch (err) {
      this.logger.error?.("[ChatTurnWriter] Failed to write watermark file", { err });
    }
  }
}
