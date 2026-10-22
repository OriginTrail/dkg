// SPDX-License-Identifier: Apache-2.0
import {
  CONTEXT_GRAPH_AUTHORITY_RPC_SITES as CG_AUTH_RPC_SITES,
  withRpcUsageSite,
} from '@origintrail-official/dkg-chain';
import type { Logger, OperationContext } from '@origintrail-official/dkg-core';
import type { PublishOptions } from '@origintrail-official/dkg-publisher';
import type { DKGAgent } from './dkg-agent.js';

type PublishTargetCurationInput = Parameters<typeof resolvePublishTargetCuration>[3];

/**
 * Whether a publish into `contextGraphId` (or its explicit on-chain target)
 * is curated, from chain-confirmed access policy. Throws when the policy is
 * unknown, or when a remap's source and target policies differ, rather than
 * choosing plaintext. Reads policy only: no sender key, signing key or
 * member state is needed, so recording an existing mint can ask it too.
 */
export async function resolvePublishTargetCuration(
  agent: DKGAgent,
  log: Logger,
  ctx: OperationContext,
  { contextGraphId, explicitPolicyTargetContextGraphId, logPrefix }: {
    contextGraphId: string;
    explicitPolicyTargetContextGraphId: string | undefined;
    logPrefix: string;
  },
): Promise<boolean> {
  const targetCgId = explicitPolicyTargetContextGraphId ?? contextGraphId;
  const probeIsCurated = async (cgId: string, opts?: { rawOnChainSlot?: boolean }): Promise<boolean | null> => {
    // Consume the SHARED tri-state resolver (the same one behind the
    // SWM-gossip gate) so the publish-inline path can never DIVERGE from it,
    // and — critically (#884 review 🔴 GZh-c) — so a genuine UNKNOWN is
    // PRESERVED here instead of collapsing to "not public ⇒ plaintext". The
    // resolver already does the live-on-chain proof, identity binding, and
    // bounded reads; a thrown RPC rejection is caught below and also
    // fails closed.
    let policyState: 0 | 1 | 'unregistered' | 'unknown';
    try {
      policyState = await withRpcUsageSite(CG_AUTH_RPC_SITES.curatedProbe, async () => {
        if (opts?.rawOnChainSlot && /^\d+$/.test(cgId.trim())) {
          const policy = await agent.readLiveOnChainAccessPolicy(cgId.trim(), ctx);
          return policy === 0 || policy === 1 ? policy : 'unknown';
        }
        return agent.resolveOnChainAccessPolicyState(cgId, ctx);
      });
    } catch (err) {
      log.warn(ctx, `${logPrefix}: chain access-policy probe for ${cgId} failed — treating as UNKNOWN (fail-closed): ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
    // PUBLIC on-chain ⇒ never curated for SWM-encryption purposes, even with
    // an allowedAgent list (that governs publish authority). Decide this
    // BEFORE `isPrivateContextGraph`, whose allowlist-implies-private
    // heuristic would otherwise force encrypted inline payloads onto a public
    // CG and diverge from the plaintext SWM-gossip path.
    if (policyState === 0) return false;
    // PRIVATE on-chain ⇒ curated ⇒ encrypted inline payload.
    if (policyState === 1) return true;
    if (policyState === 'unknown') {
      // Resolvable on-chain but UNPROVABLE (not live / stale mapping / no
      // liveness probe / timeout). A positive LOCAL curated signal is a safe
      // downgrade-to-encrypted (never a leak), so honor it; otherwise keep
      // the UNKNOWN so the caller REFUSES (throws "publish access-policy is
      // unknown") rather than silently choosing plaintext for what may be a
      // private CG.
      try {
        if (await agent.isPrivateContextGraph(cgId)) return true;
      } catch { /* can't add a positive curated signal — stay unknown */ }
      return null;
    }
    // 'unregistered': no on-chain slot at all (a pure-local CG). Fall back to
    // the local allowlist-implies-private heuristic; absent that, keep the
    // long-standing plaintext-inline default for local-only workspaces.
    try {
      if (await agent.isPrivateContextGraph(cgId)) return true;
    } catch { /* fall through to the plaintext-inline default */ }
    return false;
  };
  const explicitRawTarget = explicitPolicyTargetContextGraphId !== undefined && /^\d+$/.test(targetCgId.trim());
  let sourceIsCurated: boolean | null;
  let targetIsCurated: boolean | null;
  if (targetCgId !== contextGraphId && explicitRawTarget) {
    targetIsCurated = await probeIsCurated(targetCgId, { rawOnChainSlot: true });
    sourceIsCurated = targetIsCurated == null ? null : await probeIsCurated(contextGraphId);
  } else {
    sourceIsCurated = await probeIsCurated(contextGraphId);
    targetIsCurated = targetCgId === contextGraphId
      ? sourceIsCurated
      : await probeIsCurated(targetCgId);
  }
  if (targetIsCurated == null || (targetCgId !== contextGraphId && sourceIsCurated == null && !targetIsCurated)) {
    throw new Error(
      `${logPrefix}: publish access-policy is unknown — ` +
      `source CG "${contextGraphId}" curated=${sourceIsCurated ?? 'unknown'}, ` +
      `target CG "${targetCgId}" curated=${targetIsCurated ?? 'unknown'}. ` +
      `Refusing to choose plaintext vs encrypted inline payload without chain-confirmed policy.`,
    );
  }
  if (targetCgId !== contextGraphId && sourceIsCurated == null && targetIsCurated) {
    log.warn(
      ctx,
      `${logPrefix}: source CG "${contextGraphId}" access-policy is unknown, but explicit target ` +
      `on-chain CG "${targetCgId}" is chain-confirmed curated; selecting encrypted direct publish payload.`,
    );
  }
  if (targetCgId !== contextGraphId && sourceIsCurated != null && sourceIsCurated !== targetIsCurated) {
    throw new Error(
      `${logPrefix}: remap publish source/target access-policy mismatch — ` +
      `source CG "${contextGraphId}" curated=${sourceIsCurated}, ` +
      `target CG "${targetCgId}" curated=${targetIsCurated}. ` +
      `Refusing to publish: encrypting against the wrong CG's policy ` +
      `would either leak plaintext (curated→public) or be rejected by ` +
      `cores (public→curated). Reconcile the source and target ` +
      `access policies before retrying.`,
    );
  }
  return targetIsCurated;
}

/** Stands in for the member-encryption hook of a publish that only records an existing mint. */
const refuseAdoptOnlyEncryption: NonNullable<PublishOptions['encryptInlinePayload']> = async () => {
  throw new Error('Recording an existing mint never encrypts or distributes member payloads');
};

/**
 * The inline hooks of a publish that records an existing mint. Curation comes
 * from the access policy alone. A curated publish gets a hook that refuses to
 * run, so its catalog is recorded as the minting publish recorded it, while
 * no sender key, signing key or member ciphertext is involved.
 */
export async function adoptOnlyInlineHooks(
  agent: DKGAgent,
  log: Logger,
  ctx: OperationContext,
  input: PublishTargetCurationInput,
): Promise<Pick<PublishOptions, 'encryptInlinePayload' | 'encryptInlineChunked'>> {
  return await resolvePublishTargetCuration(agent, log, ctx, input) ? { encryptInlinePayload: refuseAdoptOnlyEncryption } : {};
}
