import { ContextGraphReadAuthorityUnavailableError, type ContextGraphReadAuthorityDecision } from './context-graph-read-authority.js';
import type { ContextGraphMetadataConfirmation } from './context-graph-meta-confirmation.js';
/** Shared admission facts; presentation belongs to each caller. */
export type SwmReadAdmission = { outcome: 'allowed' | 'denied' } | {
  outcome: 'unavailable'; source: 'legacy-membership' | 'confirmed-metadata' | 'read-authority'; error: unknown;
} | { outcome: 'unavailable'; source: 'confirmed-metadata';
  confirmation: Extract<ContextGraphMetadataConfirmation, { outcome: 'unavailable' }>;
} | { outcome: 'unavailable'; source: 'read-authority';
  decision: Extract<ContextGraphReadAuthorityDecision, { outcome: 'unavailable' }>;
};

async function captureAdmission(source: Extract<SwmReadAdmission, { outcome: 'unavailable' }>['source'],
  check: () => Promise<boolean>, signal?: AbortSignal): Promise<SwmReadAdmission> {
  signal?.throwIfAborted();
  try {
    const allowed = await check();
    signal?.throwIfAborted();
    return { outcome: allowed ? 'allowed' : 'denied' };
  } catch (error) {
    signal?.throwIfAborted();
    return { outcome: 'unavailable', source, error };
  }
}

export function resolvePrivateRootLegacyLaneAdmission(reads: {
  authorityId(): string | null;
  mergedMembership(id: string): Promise<boolean>;
  ownMembership(id: string): Promise<boolean>;
  signal?: AbortSignal;
}): Promise<SwmReadAdmission> {
  return captureAdmission('legacy-membership', async () => {
    const id = reads.authorityId();
    if (id === null || !await reads.mergedMembership(id) || !await reads.ownMembership(id)) return false;
    // Authority can change while metadata is read; fence against its fresh state.
    return reads.authorityId() === id;
  }, reads.signal);
}

export async function resolveSharedMemoryAdmission(reads: {
  acceptedAuthority(): boolean | undefined;
  legacyLane(): Promise<SwmReadAdmission>;
  confirmedMetadata(): Promise<ContextGraphMetadataConfirmation>;
  readAuthority(): Promise<ContextGraphReadAuthorityDecision>;
  signal?: AbortSignal;
}): Promise<SwmReadAdmission> {
  reads.signal?.throwIfAborted();
  let accepted: boolean | undefined;
  try { accepted = reads.acceptedAuthority(); }
  catch (error) {
    reads.signal?.throwIfAborted();
    return { outcome: 'unavailable', source: 'read-authority', error };
  }
  if (accepted === true) return { outcome: 'allowed' };
  if (accepted === false) {
    const legacy = await reads.legacyLane();
    reads.signal?.throwIfAborted();
    if (legacy.outcome !== 'allowed') return legacy;
  }
  try {
    const confirmation = await reads.confirmedMetadata();
    reads.signal?.throwIfAborted();
    if (confirmation.outcome === 'unavailable') return { outcome: 'unavailable', source: 'confirmed-metadata', confirmation };
    if (confirmation.outcome === 'unconfirmed') return { outcome: 'denied' };
  } catch (error) {
    reads.signal?.throwIfAborted();
    return { outcome: 'unavailable', source: 'confirmed-metadata', error };
  }
  try {
    const decision = await reads.readAuthority();
    reads.signal?.throwIfAborted();
    return decision.outcome === 'unavailable'
      ? { outcome: 'unavailable', source: 'read-authority', decision }
      : { outcome: decision.outcome };
  } catch (error) {
    reads.signal?.throwIfAborted();
    return { outcome: 'unavailable', source: 'read-authority', error };
  }
}

/** Boolean/query adapters choose error presentation without discarding the evidence. */
export function sharedMemoryAdmissionError(contextGraphId: string,
  admission: Extract<SwmReadAdmission, { outcome: 'unavailable' }>,
): unknown {
  if ('error' in admission) return admission.error;
  if ('decision' in admission) return new ContextGraphReadAuthorityUnavailableError(contextGraphId, admission.decision);
  return admission.confirmation.source === 'dependency' ? admission.confirmation.error
    : new Error('Context Graph metadata chain proof unavailable', { cause: admission.confirmation.proof });
}
