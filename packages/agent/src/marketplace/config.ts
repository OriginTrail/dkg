/**
 * OT-RFC-27 marketplace configuration types for `DKGAgentConfig.marketplace`
 * (own module: `dkg-agent-types.ts` sits at its ratcheted file-size budget).
 */
import type {
  MarketplaceServiceType,
  MarketplaceUnit,
  RecountPolicy,
  TokenizerKind,
} from '@origintrail-official/dkg-marketplace';

/**
 * A seller chat connector (an upstream that serves `openai-chat/v1` calls).
 * Upstream credentials are NEVER held here: config carries only file PATHS
 * (`secretEnvFile`, `authFile`), read at call time. Base URLs and paths are
 * node-admin config and are never published on offers.
 */
export type MarketplaceConnectorConfig =
  | {
      kind: 'openai-compatible';
      /** e.g. `https://api.openai.com/v1`; http allowed (admin-configured). */
      baseUrl: string;
      upstreamModel: string;
      /** ABSOLUTE path of a `KEY=value` file; omitted → no Authorization header. */
      secretEnvFile?: string;
      /** Default `OPENAI_API_KEY`. */
      secretEnvKey?: string;
      /** Default `native`. */
      toolTransport?: 'native' | 'prompt' | 'none';
      /** Default `max_tokens`; OpenAI reasoning models reject it. */
      maxTokensField?: 'max_tokens' | 'max_completion_tokens';
      contextLength?: bigint;
      /** Default 120_000, range 1_000..600_000. */
      timeoutMs?: number;
    }
  | {
      kind: 'llamacpp';
      /** Loopback only. */
      baseUrl: string;
      /** ABSOLUTE path of the served GGUF (hashed and published as `mkt:weightsDigest`). */
      ggufPath: string;
      /** Pinned serving settings, published verbatim; `temperature` is a decimal string. */
      settings: { seed: number; temperature: string; ctx: number };
      /** Default 120_000. */
      timeoutMs?: number;
    }
  | {
      kind: 'codex-oauth';
      upstreamModel: string;
      /** Default `defaultCodexAuthFile(dataDir)`. */
      authFile?: string;
      /** Default `CODEX_DEFAULT_BASE`. */
      baseUrl?: string;
      /** Default `low`. */
      reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high';
      /** REQUIRED literal true: reselling a personal subscription to third parties breaches upstream terms. */
      acknowledgeSubscriptionScope: true;
      /** Default 180_000. */
      timeoutMs?: number;
    };

/**
 * One seller offering (OT-RFC-27 marketplace). `askPerUnitWei` is wei per
 * unit as bigint (uint96 — the CLI config layer parses operator strings).
 * `executor` selects the serving implementation; omitted it defaults to
 * `chat-connector` when a `connector` is present, else by service type
 * ('query' → 'local-query' against this node's SPARQL entry point,
 * everything else → the deterministic 'stub-inference' echo).
 */
export interface MarketplaceOfferingConfig {
  offeringLocalId: string;
  serviceType: MarketplaceServiceType;
  modelId?: string;
  unit: MarketplaceUnit;
  askPerUnitWei: bigint;
  capacityUnitsPerMin?: bigint;
  /** Unix seconds after which the published offer is stale. */
  expiresAt?: number;
  executor?: 'stub-inference' | 'local-query' | 'chat-connector';
  /** Present ⇔ executor `chat-connector`. */
  connector?: MarketplaceConnectorConfig;
  /** The pinned count engine; `path` is required unless `stub-words-v1`. Absent → provider-reported (openai-compatible only). */
  metering?: { tokenizer?: { kind: TokenizerKind; path?: string } };
  /** EVM addresses; non-empty ⇒ the offer publishes `mkt:access "restricted"` and other buyers are refused. */
  allowedBuyers?: string[];
  /** Published model facts. */
  model?: { displayName?: string; family?: string; contextLength?: bigint; quantization?: string };
}

/**
 * OT-RFC-27 marketplace runtime switch + role configuration. The runtime is
 * wired at start only when `enabled` AND the chain adapter supports
 * marketplace settlement; configured offerings are served immediately
 * (connector offerings once their connector mounted) but published as offer
 * KAs only through `marketplacePublishOfferings()` (the daemon's offerings
 * route calls it).
 */
export interface DKGAgentMarketplaceConfig {
  enabled: boolean;
  seller?: {
    offerings?: MarketplaceOfferingConfig[];
    /** Receipt-batch flush timer cadence (ms). Default 5000. */
    flushIntervalMs?: number;
    batching?: {
      maxBatchSize?: number;
      maxDelayMs?: number;
      maxBuyerExposureWei?: bigint;
    };
    /** `local-query` execution guards; default `DEFAULT_QUERY_GUARDS`. */
    queryGuards?: { timeoutMs?: number; maxRows?: number };
  };
  buyer?: {
    /** Authorization validity window (s). Default 600. */
    authTtlSeconds?: number;
    quoteTimeoutMs?: number;
    serveTimeoutMs?: number;
    /** Per-request cap on live quote probes. Default 8. */
    maxQuoteProbes?: number;
    /**
     * Serve timeout for chat calls. Default 200_000 — above every default
     * connector timeout; a seller connector `timeoutMs` above ~190 s risks
     * buyer-side `DELIVERY_UNKNOWN`.
     */
    chatServeTimeoutMs?: number;
    /** Tokenizer files the buyer recounts with; loaded lazily, digest-indexed. */
    tokenizers?: Array<{ kind: TokenizerKind; path: string }>;
    recountPolicy?: Partial<RecountPolicy>;
  };
}
