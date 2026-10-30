import { ContextGraphReadAuthorityUnavailableError, type ContextGraphReadAuthorityDecision } from './context-graph-read-authority.js';
import type { ContextGraphMetadataConfirmation } from './context-graph-meta-confirmation.js';
type AdmissionDecision = { outcome: 'allowed' | 'denied' };
export type PrivateRootLegacyLaneAdmission = AdmissionDecision | {
  outcome: 'unavailable'; source: 'legacy-membership'; error: unknown;
};
/** Shared admission facts; each failure has one explicitly discriminated shape. */
export type SwmReadAdmission = PrivateRootLegacyLaneAdmission | {
  outcome: 'unavailable'; source: 'confirmed-metadata';
  confirmation: Extract<ContextGraphMetadataConfirmation, { outcome: 'unavailable' }>;
} | { outcome: 'unavailable'; source: 'read-authority';
  decision: Extract<ContextGraphReadAuthorityDecision, { outcome: 'unavailable' }>;
};

async function captureLegacyAdmission(
  check: () => Promise<boolean>, signal?: AbortSignal): Promise<PrivateRootLegacyLaneAdmission> {
  signal?.throwIfAborted();
  try {
    const allowed = await check();
    signal?.throwIfAborted();
    return { outcome: allowed ? 'allowed' : 'denied' };
  } catch (error) {
    signal?.throwIfAborted();
    return { outcome: 'unavailable', source: 'legacy-membership', error };
  }
}

export function resolvePrivateRootLegacyLaneAdmission(reads: {
  authorityId(): string | null;
  mergedMembership(id: string): Promise<boolean>;
  ownMembership(id: string): Promise<boolean>;
  signal?: AbortSignal;
}): Promise<PrivateRootLegacyLaneAdmission> {
  return captureLegacyAdmission(async () => {
    const id = reads.authorityId();
    if (id === null || !await reads.mergedMembership(id) || !await reads.ownMembership(id)) return false;
    // Authority can change while metadata is read; fence against its fresh state.
    return reads.authorityId() === id;
  }, reads.signal);
}

export async function resolveSharedMemoryAdmission(reads: {
  readonly acceptedAuthority: boolean | undefined;
  legacyLane(): Promise<PrivateRootLegacyLaneAdmission>;
  confirmedMetadata(): Promise<ContextGraphMetadataConfirmation>;
  readAuthority(): Promise<ContextGraphReadAuthorityDecision>;
  signal?: AbortSignal;
}): Promise<SwmReadAdmission> {
  reads.signal?.throwIfAborted();
  try {
    const accepted = reads.acceptedAuthority;
    if (accepted === true) return { outcome: 'allowed' };
    if (accepted === false) {
      const legacy = await reads.legacyLane();
      reads.signal?.throwIfAborted();
      if (legacy.outcome !== 'allowed') return legacy;
    }
    const confirmation = await reads.confirmedMetadata();
    reads.signal?.throwIfAborted();
    if (confirmation.outcome === 'unavailable') return { outcome: 'unavailable', source: 'confirmed-metadata', confirmation };
    if (confirmation.outcome === 'unconfirmed') return { outcome: 'denied' };
    const decision = await reads.readAuthority();
    return decision.outcome === 'unavailable'
      ? { outcome: 'unavailable', source: 'read-authority', decision }
      : { outcome: decision.outcome };
  } finally { reads.signal?.throwIfAborted(); }
}

/** Legacy callers fail closed for these facts; strict reads still expose outages. */
export function sharedMemoryAdmissionFailsClosed(admission: SwmReadAdmission): boolean {
  return admission.outcome === 'unavailable' && (admission.source === 'legacy-membership'
    || (admission.source === 'confirmed-metadata' && admission.confirmation.source === 'chain-proof'));
}

/** Boolean/query adapters choose error presentation without discarding the evidence. */
export function sharedMemoryAdmissionError(contextGraphId: string,
  admission: Extract<SwmReadAdmission, { outcome: 'unavailable' }>,
): unknown {
  switch (admission.source) {
    case 'legacy-membership': return admission.error;
    case 'read-authority': return new ContextGraphReadAuthorityUnavailableError(contextGraphId, admission.decision);
    case 'confirmed-metadata': return new Error('Context Graph metadata chain proof unavailable', { cause: admission.confirmation.proof });
  }
}
