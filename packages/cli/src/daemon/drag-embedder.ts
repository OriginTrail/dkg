// daemon/drag-embedder.ts
//
// Build dRAG embedding providers from config (OT-RFC-55 Phase 1). Centralises
// the provider selection so the node default (lifecycle) and the per-request
// `retrieval:"semantic"` path (route) agree.

import {
  OpenAIEmbeddingProvider,
  HashingEmbeddingProvider,
  LocalEmbeddingProvider,
} from './embedding-providers.js';
import type { EmbeddingProvider } from '../vector-store.js';
import type { DkgConfig } from '../config.js';

export type EmbedderKind = 'keyword' | 'hashing' | 'local' | 'openai';

/** Build an embedder of a named kind, pulling model/baseURL/apiKey from config.drag → llm. */
export function buildEmbedder(kind: EmbedderKind, config: DkgConfig): EmbeddingProvider | null {
  switch (kind) {
    case 'keyword':
      return null;
    case 'hashing':
      return new HashingEmbeddingProvider();
    case 'local':
      return new LocalEmbeddingProvider({ model: config.drag?.embedderModel });
    case 'openai': {
      const apiKey = config.drag?.embedderApiKey ?? config.llm?.apiKey;
      const baseURL = config.drag?.embedderBaseURL ?? config.llm?.baseURL;
      // Need at least a key (hosted OpenAI) or a baseURL (e.g. local Ollama).
      if (!apiKey && !baseURL) return null;
      return new OpenAIEmbeddingProvider({ apiKey: apiKey ?? 'not-needed', baseURL, model: config.drag?.embedderModel });
    }
    default:
      return null;
  }
}

/**
 * The node's DEFAULT dRAG embedder. `DKG_DRAG_EMBEDDER` env overrides config;
 * null ⇒ keyword (the default — semantic is opt-in via config/env, since lexical
 * `hashing` can rank wrong and a model is not always present).
 */
export function defaultDragEmbedder(config: DkgConfig): EmbeddingProvider | null {
  const kind = (process.env.DKG_DRAG_EMBEDDER as EmbedderKind | undefined) ?? config.drag?.embedder;
  if (!kind || kind === 'keyword') return null;
  return buildEmbedder(kind, config);
}

/**
 * Resolve a SEMANTIC embedder for an explicit `retrieval:"semantic"` request —
 * tries hard so an agent that asks for semantic gets it: the configured model if
 * it is semantic, else an OpenAI-compatible provider if credentials exist, else
 * the offline local model (which fails gracefully — surfaces `degraded` — if its
 * optional dependency is not installed). Always returns a provider; never null.
 */
export function resolveSemanticEmbedder(config: DkgConfig): EmbeddingProvider {
  // 'local' always builds (never null). For 'openai' (or unset) try the configured
  // provider, but fall through to the offline local model when it returns null
  // (e.g. embedder:'openai' set with no credentials) so an explicit semantic
  // request still lands on a model — and surfaces degraded if that too is absent.
  const local = () => new LocalEmbeddingProvider({ model: config.drag?.embedderModel });
  if (config.drag?.embedder === 'local') return local();
  return buildEmbedder('openai', config) ?? local();
}
