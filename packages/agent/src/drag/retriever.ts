/**
 * Semantic entry-point retrieval for dRAG (OT-RFC-55 Phase 1).
 *
 * An {@link EntityRetriever} turns a natural-language question into a ranked set
 * of ANCHOR entities — the "where in the graph do I start" step. It is the
 * neural half of neurosymbolic retrieval: an embedding model + ANN index over
 * the context graph's entities. The agent then graph-expands from each anchor
 * and produces verifiable citations (the symbolic + verification halves).
 *
 * The interface is deliberately tiny and dependency-free so it can live in the
 * agent (which holds the retriever) while the concrete vector-store-backed
 * implementation lives in the daemon (which owns the embedder + vector store).
 * When no retriever is attached, dRAG falls back to keyword retrieval.
 */
export interface RetrievedAnchor {
  /** The per-KA verifiable-memory graph this entity lives in (…/_verifiable_memory/{addr}/{number}). */
  sourceGraph: string;
  /** The matched entity URI (the anchor). */
  entityUri: string;
  /** Cosine similarity to the question (higher = more relevant). */
  score: number;
}

/** The result of one semantic-retrieval call. Never shared across requests. */
export interface EntityRetrievalResult {
  /** Ranked semantic entry points for this call. */
  anchors: RetrievedAnchor[];
  /** True when this call could not use the configured embedding model. */
  degraded: boolean;
}

export interface EntityRetriever {
  /** The embedding model id (e.g. `Xenova/all-MiniLM-L6-v2`, `hashing-v1`) — surfaced for honesty about which path ran. */
  readonly model: string;
  /**
   * Embed `question`, ANN-search the context graph's indexed verifiable-memory
   * entities, and return up to `limit` ranked anchors plus this call's degraded
   * status. Implementations index lazily (build-then-search on first use) and
   * keep the index fresh.
   */
  retrieve(question: string, contextGraphName: string, limit: number): Promise<EntityRetrievalResult>;
  /**
   * Optional: warm the index for a context graph ahead of any query (e.g. right
   * after a publish). Best-effort and must never throw; indexing is incremental
   * so it is cheap when nothing new has been published.
   */
  warm?(contextGraphName: string): Promise<void>;
}
