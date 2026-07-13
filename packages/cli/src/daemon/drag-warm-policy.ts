type ContextGraphAccessPolicy = 'public' | 'private' | null;

/** Minimal agent surface needed by the background dRAG index warmer. */
export interface DragWarmPolicyAgent {
  entityRetriever?: {
    warm?: (contextGraphId: string) => Promise<void>;
  };
  getExplicitAccessPolicy(contextGraphId: string): Promise<ContextGraphAccessPolicy>;
  isContextGraphPublicOnChain(contextGraphId: string): Promise<boolean>;
}

/**
 * Warm a context graph's semantic index only when model calls are allowed.
 *
 * Background memory-change events have no authenticated caller, so the default
 * must be stricter than request-time read routing: an absent/unknown policy or
 * a failed lookup is not proof that graph contents are public. Explicit local
 * public metadata and a live-proven public on-chain policy are the only public
 * cases. Operators can deliberately override this for private graphs with
 * `drag.allowPrivateModelCalls=true`.
 */
export async function warmDragIndexIfAllowed(
  agent: DragWarmPolicyAgent,
  contextGraphId: string,
  allowPrivateModelCalls = false,
): Promise<boolean> {
  const retriever = agent.entityRetriever;
  if (!retriever?.warm) return false;

  if (allowPrivateModelCalls !== true) {
    try {
      const policy = await agent.getExplicitAccessPolicy(contextGraphId);
      if (policy === 'private') return false;
      if (policy !== 'public' && !(await agent.isContextGraphPublicOnChain(contextGraphId))) {
        return false;
      }
    } catch {
      return false;
    }
  }

  try {
    await retriever.warm(contextGraphId);
    return true;
  } catch {
    // Warming is an optimization and must never reject an event-bus callback.
    return false;
  }
}
