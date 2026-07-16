import type {
  ImportFileResult,
  LocalAgentChatAttachmentRef,
} from '../../../api.js';

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

export interface AgentInfo {
  agentUri: string;
  name: string;
  peerId: string;
  framework?: string;
  nodeRole?: string;
  connectionStatus?: string;
  connectionTransport?: string;
  connectionDirection?: string;
  lastSeen?: number;
  latencyMs?: number;
}

// One row from `/api/connections.connections` — a single libp2p
// connection. A peer can appear multiple times when reachable via both
// a direct and a relay transport simultaneously; `buildPeers` collapses
// those to one card per peerId.
export interface ConnectionRow {
  peerId: string;
  remoteAddr?: string;
  transport: 'direct' | 'relayed';
  direction?: string;
  openedAt?: number | null;
  durationMs?: number | null;
}

// Peer-axis model for the Network tab. One per libp2p peerId. Agents
// hosted by the peer (0..N) attach as a list and surface inside the
// card as chips. `name` is the peer's (node's) name — same value across
// every agent on this peer — sampled from any one of them since the
// `/api/connections` endpoint doesn't expose it.
export interface PeerInfo {
  peerId: string;
  name?: string;
  transport: 'direct' | 'relayed';
  hasDirect: boolean;
  hasRelay: boolean;
  openedAt: number | null;
  connected: boolean;
  lastSeen?: number;
  agents: AgentInfo[];
}

export interface LocalAgentSessionSummary {
  sessionId: string;
  integrationId: string;
  integrationName: string;
  preview: string;
  messageCount: number;
  lastTs?: string;
}
