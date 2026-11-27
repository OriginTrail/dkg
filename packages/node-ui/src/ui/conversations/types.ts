import type {
  ImportFileResult,
  LocalAgentChatAttachmentRef,
} from '../api.js';

/** A conversation's messages and queued files, shared by the conversation store and the agent panel. */
export interface LocalAgentMessage {
  id: string;
  uri?: string;
  turnId?: string;
  role: 'user' | 'assistant';
  content: string;
  /**
   * Human-readable, locale-formatted timestamp for display
   * (e.g. "May 14, 2026, 10:05 PM"). Produced by
   * `formatLocalTimestamp` at the three sites that create messages
   * (history-load, user-send, assistant-complete).
   */
  ts?: string;
  /**
   * ISO 8601 string for the same moment, kept alongside `ts` so the
   * render layer can wrap the timestamp in `<time dateTime={tsRaw}>`
   * for screen-reader / machine-parseable semantics, and so a future
   * "X minutes ago" relative-time treatment can read the raw moment
   * without round-tripping through a locale-formatted display string.
   */
  tsRaw?: string;
  streaming?: boolean;
  attachments?: LocalAgentChatAttachmentRef[];
  toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>;
  traceFile?: string;
  profile?: string;
  contextGraphId?: string;
  readOnly?: boolean;
  /**
   * UI-generated failed-turn notice rendered as literal text after any real
   * agent output. Kept separate from `content` so markdown can stay enabled
   * for partial agent text without parsing local error bodies.
   */
  failureNotice?: string;
  /**
   * True when `content` is locally synthesized by the UI (e.g. an
   * attachment summary fallback from `mapHistoryMessage`, or a local
   * error/cancel string), NOT real agent-authored markdown. The chat
   * bubble renderer treats these as literal text — synthesized strings
   * embed raw filenames / error details that may contain markdown
   * metacharacters or absolute URLs, so feeding them through
   * `MarkdownMessage` would let an attacker-controllable filename
   * synthesize a live external link in an assistant-styled bubble.
   * (Codex CGpe9.)
   */
  synthesized?: boolean;
}

export type LocalAgentAttachmentStatus = 'queued' | 'uploading' | 'completed' | 'skipped' | 'error';

export interface LocalAgentAttachmentDraft {
  id: string;
  file: File;
  contextGraphId: string;
  assertionName: string;
  status: LocalAgentAttachmentStatus;
  result?: ImportFileResult;
  error?: string;
}
