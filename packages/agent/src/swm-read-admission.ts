import { ContextGraphReadAuthorityUnavailableError, type ContextGraphReadAuthorityDecision } from './context-graph-read-authority.js';
/** Shared admission facts; presentation belongs to each caller. */
export type SwmReadAdmission = { outcome: 'allowed' | 'denied' } | { outcome: 'unavailable'; error: unknown };

async function captureAdmission(check: () => Promise<boolean | SwmReadAdmission>): Promise<SwmReadAdmission> {
  try {
    const result = await check();
    return typeof result === 'boolean' ? { outcome: result ? 'allowed' : 'denied' } : result;
  } catch (error) { return { outcome: 'unavailable', error }; }
}

export function resolvePrivateRootLegacyLaneAdmission(reads: {
  authorityId(): string | null;
  mergedMembership(id: string): Promise<boolean>;
  ownMembership(id: string): Promise<boolean>;
}): Promise<SwmReadAdmission> {
  return captureAdmission(async () => {
    const id = reads.authorityId();
    if (id === null || !await reads.mergedMembership(id) || !await reads.ownMembership(id)) return false;
    // Authority can change while metadata is read; fence against its fresh state.
    return reads.authorityId() === id;
  });
}

export function resolveSharedMemoryAdmission(reads: {
  acceptedAuthority(): boolean | undefined;
  legacyLane(): Promise<SwmReadAdmission>;
  confirmedMetadata(): Promise<boolean>;
  canRead(): Promise<boolean>;
}): Promise<SwmReadAdmission> {
  return captureAdmission(async () => {
    const accepted = reads.acceptedAuthority();
    if (accepted === true) return true;
    if (accepted === false) {
      const legacy = await reads.legacyLane();
      if (legacy.outcome !== 'allowed') return legacy;
    }
    return await reads.confirmedMetadata() && await reads.canRead();
  });
}

export function admittedSharedMemoryAuthority(contextGraphId: string, decision: ContextGraphReadAuthorityDecision): boolean {
  if (decision.outcome === 'unavailable') throw new ContextGraphReadAuthorityUnavailableError(contextGraphId, decision);
  return decision.outcome === 'allowed';
}
