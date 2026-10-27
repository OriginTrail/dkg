/**
 * OT-RFC-27 seller chat connectors: the upstream seam behind the
 * `chat-connector` executor. A connector turns one normalized wire request
 * into upstream text (and tool calls) or a classified, secret-redacted
 * failure; it never meters (the executor meters with the pinned engine) and
 * never throws for upstream faults (`complete` returns `ok:false`).
 */
import type {
  ChatMessage,
  ChatTool,
  ChatToolCall,
  ChatToolChoice,
  ModelProvenanceClass,
  ToolTransport,
} from '@origintrail-official/dkg-marketplace';

export type ChatConnectorKind = 'openai-compatible' | 'llamacpp' | 'codex-oauth';

export interface ConnectorChatRequest {
  upstreamModel: string;
  /** Normalized wire messages (string content). */
  messages: ChatMessage[];
  /** ≥ 1, already capped by the executor. */
  maxTokens: number;
  temperature?: number;
  topP?: number;
  seed?: number;
  stop?: string[];
  /** Native transport only. */
  tools?: ChatTool[];
  toolChoice?: ChatToolChoice;
  parallelToolCalls?: boolean;
}

export type ConnectorFailureCode =
  | 'UPSTREAM_RATE_LIMITED'
  | 'UPSTREAM_ERROR'
  | 'UPSTREAM_TIMEOUT'
  | 'UPSTREAM_AUTH'
  | 'CONTEXT_EXCEEDED';

export type ConnectorChatOutcome =
  | {
      ok: true;
      content: string;
      toolCalls?: ChatToolCall[];
      /** Raw upstream value; the executor normalizes it. */
      finishReason: string;
      providerUsage?: { promptTokens: number; completionTokens: number };
    }
  | {
      ok: false;
      code: ConnectorFailureCode;
      /** Upstream HTTP status, 0 for transport faults. */
      status: number;
      /** ≤ 240 chars, secret-redacted, never prompt/completion text. */
      detail: string;
    };

export interface ConnectorDescription {
  kind: ChatConnectorKind;
  toolTransport: ToolTransport;
  provenanceClass: ModelProvenanceClass;
  upstreamModel: string;
  /** `scheme://host[:port]` only — status surfaces, NEVER published. */
  upstreamOrigin: string;
  contextLength?: bigint;
  /** llamacpp: `sha256:` digest of the GGUF. */
  weightsDigest?: string;
  /** llamacpp: published verbatim. */
  servingSeed?: bigint;
  servingTemperature?: string;
  secretConfigured: boolean;
}

export interface ChatConnector {
  readonly description: ConnectorDescription;
  /** Never throws for upstream faults. */
  complete(request: ConnectorChatRequest): Promise<ConnectorChatOutcome>;
  health(): Promise<{ ok: boolean; latencyMs: number; detail?: string }>;
}

export type MarketplaceConnectorMountErrorCode =
  | 'CONNECTOR_CONFIG'
  | 'CONNECTOR_NOT_LOOPBACK'
  | 'CONNECTOR_SECRET_ABSENT'
  | 'CONNECTOR_SECRET_PERMS'
  | 'CONNECTOR_TOKENIZER'
  | 'CONNECTOR_GGUF_ABSENT'
  | 'CONNECTOR_UNHEALTHY'
  | 'CONNECTOR_AUTH_ABSENT'
  | 'CONNECTOR_SCOPE';

/** A connector (or connector offering) could not be mounted. Messages name files and keys, never content. */
export class MarketplaceConnectorMountError extends Error {
  constructor(
    readonly code: MarketplaceConnectorMountErrorCode,
    message: string,
    readonly offeringLocalId?: string,
  ) {
    super(message);
    this.name = 'MarketplaceConnectorMountError';
  }
}
