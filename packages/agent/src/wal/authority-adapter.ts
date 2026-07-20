import type {
  DkgEpochSnapshotValidation,
  DkgMembershipValidation,
  DkgOpenAuthorValidation,
  DkgPrivateDisclosureValidation,
  DkgWalAuthorityAdapter,
} from '@origintrail-official/dkg-wal/authority';
import { verifyAgentDelegation, type SignedAgentDelegation } from '../auth/agent-delegation.js';

type Decision<Input> = (input: Input) => boolean | Promise<boolean>;

export interface CurrentDkgWalAuthorityChecks {
  /** Existing curator/membership projection remains authoritative. */
  validateMembership: Decision<DkgMembershipValidation>;
  /** Existing chain adapter remains authoritative for OPEN author admission. */
  validateOpenAuthor: Decision<DkgOpenAuthorValidation>;
  /** Existing snapshot/verified-memory logic remains authoritative. */
  validateEpochSnapshot: Decision<DkgEpochSnapshotValidation>;
  /** Existing admitted-object index remains authoritative for RDF policy objects. */
  isWalObjectAdmitted: Decision<Uint8Array>;
  /** Resolve the existing DKG delegation scope for this exact private view. */
  privateDisclosureScope: (input: DkgPrivateDisclosureValidation) => string;
  /** Decode canonical libp2p peer bytes using the active transport implementation. */
  transportPeerIdFromBytes: (value: Uint8Array) => string;
  /** Fresh current DKG membership/revocation check; false and errors fail closed. */
  authorizeCurrentPrivateMember: Decision<DkgPrivateDisclosureValidation>;
}

function address(value: Uint8Array): string {
  return `0x${Buffer.from(value).toString('hex')}`;
}

function signedDelegation(value: unknown): SignedAgentDelegation | null {
  if (value === null || typeof value !== 'object') return null;
  const candidate = value as Partial<SignedAgentDelegation>;
  if (
    typeof candidate.agentAddress !== 'string'
    || typeof candidate.scope !== 'string'
    || typeof candidate.issuedAtMs !== 'number'
    || typeof candidate.signature !== 'string'
  ) return null;
  return candidate as SignedAgentDelegation;
}

/**
 * Thin bridge from generic WAL authority decisions to the current DKG
 * membership, delegation, chain, verified-memory, and admission surfaces.
 * It intentionally owns no membership cache and mints no new authority.
 */
export class CurrentDkgWalAuthorityAdapter implements DkgWalAuthorityAdapter {
  constructor(private readonly checks: CurrentDkgWalAuthorityChecks) {}

  validateMembership(input: DkgMembershipValidation): boolean | Promise<boolean> {
    return this.checks.validateMembership(input);
  }

  validateOpenAuthor(input: DkgOpenAuthorValidation): boolean | Promise<boolean> {
    return this.checks.validateOpenAuthor(input);
  }

  validateEpochSnapshot(input: DkgEpochSnapshotValidation): boolean | Promise<boolean> {
    return this.checks.validateEpochSnapshot(input);
  }

  isWalObjectAdmitted(objectId: Uint8Array): boolean | Promise<boolean> {
    return this.checks.isWalObjectAdmitted(objectId);
  }

  async authorizePrivateDisclosure(input: DkgPrivateDisclosureValidation): Promise<boolean> {
    try {
      const delegation = signedDelegation(input.delegation);
      if (delegation === null) return false;
      const expectedAgent = address(input.memberAgentAddress).toLowerCase();
      const peerId = this.checks.transportPeerIdFromBytes(input.transportPeerId);
      if (peerId.length === 0) return false;
      const verified = verifyAgentDelegation(delegation, {
        expectedScope: this.checks.privateDisclosureScope(input),
        nowMs: input.nowMs,
      });
      if (verified.agentAddress.toLowerCase() !== expectedAgent) return false;
      // WAL-007 has an authenticated transport peer but no carrier op-key in
      // this call shape, so an op-key-only delegation cannot authorize it.
      if (verified.delegateePeerId !== peerId) return false;
      return await this.checks.authorizeCurrentPrivateMember(input);
    } catch {
      return false;
    }
  }
}

export function createCurrentDkgWalAuthorityAdapter(
  checks: CurrentDkgWalAuthorityChecks,
): DkgWalAuthorityAdapter {
  return new CurrentDkgWalAuthorityAdapter(checks);
}
