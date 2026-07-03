/**
 * Resolve the effective register-time publishPolicy for POST
 * /api/context-graph/register. Route-owned (deliberately not on the agent
 * facade): an explicit body value wins; an omitted policy rehydrates the
 * create-time policy from `getStoredContextGraphRegistrationOptions`, read
 * LAZILY (no read when the body already decided it). Best-effort at this
 * boundary — a store-read failure must not fail the registration, so it warns
 * and falls back to the request/default policy. (The publish auto-register path
 * reads the same store reader directly and stays fail-loud — it must never
 * register under the wrong on-chain policy.) The stored PCA id is not consulted
 * here: pcaAccountId is explicit-only for /register.
 */
export async function resolveRegisterPublishPolicy(
  agent: { getStoredContextGraphRegistrationOptions(contextGraphId: string): Promise<{ publishPolicy?: number }> },
  contextGraphId: string,
  explicitPublishPolicy: number | undefined,
): Promise<number | undefined> {
  if (explicitPublishPolicy !== undefined) return explicitPublishPolicy; // body wins — no read
  try {
    return (await agent.getStoredContextGraphRegistrationOptions(contextGraphId)).publishPolicy;
  } catch (err) {
    console.warn(
      `[DKG-Daemon] WARN [register] stored registration-options read failed for contextGraph=${contextGraphId}; proceeding with request/default policy: ${(err as Error)?.message ?? String(err)}`,
    );
    return explicitPublishPolicy;
  }
}
