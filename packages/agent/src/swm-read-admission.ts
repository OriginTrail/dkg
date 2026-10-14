import { ContextGraphReadAuthorityUnavailableError, type ContextGraphReadAuthorityDecision } from './context-graph-read-authority.js';
/** Shared admission facts; presentation belongs to each caller. */
export type SwmReadAdmission = { outcome: 'allowed' | 'denied' } | {
  outcome: 'unavailable'; source: 'legacy-membership' | 'confirmed-metadata' | 'read-authority'; error: unknown;
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
  confirmedMetadata(): Promise<boolean>;
  canRead(): Promise<boolean>;
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
  const confirmed = await captureAdmission('confirmed-metadata', reads.confirmedMetadata, reads.signal);
  if (confirmed.outcome !== 'allowed') return confirmed;
  return captureAdmission('read-authority', reads.canRead, reads.signal);
}

export function admittedSharedMemoryAuthority(contextGraphId: string, decision: ContextGraphReadAuthorityDecision): boolean {
  if (decision.outcome === 'unavailable') throw new ContextGraphReadAuthorityUnavailableError(contextGraphId, decision);
  return decision.outcome === 'allowed';
}
