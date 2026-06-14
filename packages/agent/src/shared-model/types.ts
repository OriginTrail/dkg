/**
 * Shared curator AI-model access for context graphs (MVP).
 *
 * A context-graph (CG) curator can, in the SAME flow as inviting an agent to
 * the CG's shared working memory, optionally let members invoke the AI model
 * the curator already configures for their node (`config.llm`). The curator's
 * API key NEVER leaves the curator's node — members send prompts over the
 * `/dkg/10.0.2/shared-model-invoke` P2P protocol and receive completions back,
 * gated by CG membership + a per-member daily quota.
 */

export type SharedModelRole = 'system' | 'user' | 'assistant';

export interface SharedModelMessage {
  role: SharedModelRole;
  content: string;
}

/** Provider credentials/config — lives only on the curator's node. */
export interface SharedModelProviderConfig {
  /** 'mock' needs no network/key and is used for local testing. */
  provider: 'mock' | 'openai-compatible';
  model: string;
  baseUrl?: string;
  apiKey?: string;
}

/** Runtime config attached to a DKGAgent via configureSharedModel(). */
export interface SharedModelRuntimeConfig extends SharedModelProviderConfig {
  /** Master switch — does this node offer model sharing at all. */
  enabled: boolean;
  /** Per-member daily request cap (abuse bound). */
  dailyRequestQuotaPerAgent: number;
  /** Hard cap on total prompt size accepted from a member (chars). */
  maxPromptChars: number;
  /**
   * Member-side transport budget (ms) for the WHOLE remote invoke round
   * trip (`sendReliable`). Must comfortably exceed real LLM latency, which
   * the router default ({@link DEFAULT_SEND_TIMEOUT_MS}, 20s) does not.
   */
  invokeTimeoutMs: number;
  /**
   * Curator-side provider deadline (ms) applied to the upstream LLM
   * `fetch`. Kept slightly TIGHTER than `invokeTimeoutMs` so the curator
   * returns a structured `{ok:false}` error before the member's transport
   * aborts the round trip.
   */
  providerTimeoutMs: number;
}

export interface SharedModelInvokeRequest {
  contextGraphId: string;
  messages: SharedModelMessage[];
  maxTokens?: number;
  temperature?: number;
}

export interface SharedModelInvokeResponse {
  ok: boolean;
  denied?: string;
  content?: string;
  model?: string;
}

/** Per-CG grant state, stored in the CG `_meta` subgraph. */
export interface SharedModelGrant {
  enabled: boolean;
  /** Advertised model id (NOT the API key). */
  modelId?: string;
}

/**
 * Predicates are intentionally defined LOCALLY (not added to the genesis
 * `DKG_ONTOLOGY`) so this MVP does not alter the genesis-hash / networkId.
 */
export const SHARED_MODEL_PREDICATES = {
  ENABLED: 'https://dkg.network/ontology#sharedModelEnabled',
  MODEL_ID: 'https://dkg.network/ontology#sharedModelId',
} as const;

const SAFE_MODEL_ID = /^[A-Za-z0-9._:/-]{1,128}$/;

/** Reject anything that is not a plain, safe model identifier. */
export function sanitizeModelId(id: string | undefined): string | undefined {
  if (!id) return undefined;
  return SAFE_MODEL_ID.test(id) ? id : undefined;
}
