// SPDX-License-Identifier: Apache-2.0

import type {
  ContextGraphAuthorityReadMode,
  RegisteredContextGraphAuthority,
  RegisteredContextGraphAuthorityUnavailable,
} from '../../registered-context-graph-authority.js';

/**
 * How SWM on one graph may travel. The sender's recipient selection and the
 * receiver's plaintext oracle both project their answer from this one
 * classification (#2827), so the two ends of the wire cannot disagree.
 *
 * - `plaintext`: public-readable SWM. The graph is registered public, or it is
 *   unregistered and its active accepted owner-signed policy is public.
 *   Approving a join writes an allowlist, but on a public graph that governs
 *   publish authority, not reads.
 * - `legacy-unregistered`: ordinary unregistered without such a policy. The
 *   local store roster decides, as it always has for local-only graphs.
 * - `approved-private-replica`: unregistered under the current participant
 *   proof. The local private roster still decides agents, while the proof's
 *   source-qualified peer allowlist restricts their recipient keys.
 * - `private-roster`: registered private, or an active accepted owner-signed
 *   unregistered private policy; encrypt to its current authoritative roster.
 * - `unavailable`: no authoritative answer, so fail closed.
 */
export type SwmTransportAuthority =
  | { readonly kind: 'plaintext' }
  | { readonly kind: 'legacy-unregistered' }
  | {
      readonly kind: 'approved-private-replica';
      readonly allowedPeers: readonly string[];
    }
  | { readonly kind: 'private-roster'; readonly participantAgents: readonly string[] }
  | {
      readonly kind: 'unavailable';
      readonly reason: 'rfc64-private-read-roster-unavailable';
      readonly detail?: string;
    }
  | RegisteredContextGraphAuthorityUnavailable;

const ACCEPTED_PRIVATE_ROSTER_UNAVAILABLE_DETAIL =
  'active accepted private RFC-64 authority has no current roster';

/** Exact authority needed by the member-recovery gate. */
export type SwmMemberRecoveryAuthority =
  | { readonly kind: 'private-roster'; readonly participantAgents: readonly string[] }
  | { readonly kind: 'legacy-unregistered' }
  | { readonly kind: 'denied' };

/** Registered-authority read options an SWM consumer chooses for itself. */
export interface SwmRegisteredAuthorityReadOptions {
  readonly signal?: AbortSignal;
  readonly authorityReadMode?: ContextGraphAuthorityReadMode;
  readonly requireLiveRosterForPrivate?: boolean;
}

/** What resolving SWM authority needs from the agent. */
export interface SwmAuthorityHost {
  /** The accepted owner-signed public policy, only while it governs transport. */
  hasActiveAcceptedRfc64PublicUnregisteredAuthorityV1(contextGraphId: string): boolean;
  /**
   * The accepted owner-signed private roster, only while it governs transport.
   * `undefined` means no such authority; `null` means applicable but unavailable.
   * Optional for compatibility with hosts that predate private RFC-64 policy.
   */
  resolveActiveAcceptedRfc64PrivateUnregisteredRosterV1?(
    contextGraphId: string,
  ): readonly string[] | null | undefined;
  resolveRegisteredContextGraphAuthority(
    contextGraphId: string,
    options: SwmRegisteredAuthorityReadOptions & {
      allowAcceptedRfc64FinalizedAbsence: boolean;
      allowApprovedPrivateReplicaFinalizedAbsence: boolean;
    },
  ): Promise<RegisteredContextGraphAuthority>;
}

/**
 * The single policy application every SWM consumer shares: one active-policy
 * check, used as the accepted-absence allowance of one registered-authority
 * read. The pair never leaves this module, so a result can never be combined
 * with a flag that did not authorize its read.
 */
async function readWithActiveAcceptedPolicy(
  host: SwmAuthorityHost,
  contextGraphId: string,
  options: SwmRegisteredAuthorityReadOptions,
): Promise<{
  readonly registered: RegisteredContextGraphAuthority;
  readonly activeAcceptedPolicy:
    | { readonly kind: 'plaintext' }
    | { readonly kind: 'private-roster'; readonly participantAgents: readonly string[] }
    | null;
}> {
  const activeAcceptedPublicPolicy =
    host.hasActiveAcceptedRfc64PublicUnregisteredAuthorityV1(contextGraphId);
  const activeAcceptedPrivateRoster = activeAcceptedPublicPolicy
    ? undefined
    : host.resolveActiveAcceptedRfc64PrivateUnregisteredRosterV1?.(contextGraphId);
  const acceptsFinalizedAbsence = activeAcceptedPublicPolicy
    || activeAcceptedPrivateRoster !== undefined;
  const registered = await host.resolveRegisteredContextGraphAuthority(contextGraphId, {
    ...options,
    allowAcceptedRfc64FinalizedAbsence: acceptsFinalizedAbsence,
    allowApprovedPrivateReplicaFinalizedAbsence: true,
  });
  // An `unregistered` answer may rest on the accepted-absence allowance, which
  // holds only while the policy still governs transport. Catalog authority can
  // be killed, blocked or deactivated while the read awaits the index: then
  // read again without the allowance instead of acting on the stale fence. A
  // registered answer never depended on the allowance and stands as read.
  if (registered.kind === 'unregistered') {
    // Re-read the synchronous accepted-policy projection after the async
    // registration lookup. Besides closing deactivation, this makes a private
    // roster rotation during the lookup use the new exact roster rather than
    // the stale pre-await snapshot.
    const currentAcceptedPublicPolicy =
      host.hasActiveAcceptedRfc64PublicUnregisteredAuthorityV1(contextGraphId);
    if (currentAcceptedPublicPolicy) {
      return { registered, activeAcceptedPolicy: { kind: 'plaintext' } };
    }
    const currentAcceptedPrivateRoster =
      host.resolveActiveAcceptedRfc64PrivateUnregisteredRosterV1?.(contextGraphId);
    if (currentAcceptedPrivateRoster !== undefined) {
      if (currentAcceptedPrivateRoster === null) {
        return {
          registered: {
            kind: 'unavailable',
            reason: 'finalized-name-absence-unaccepted',
            detail: ACCEPTED_PRIVATE_ROSTER_UNAVAILABLE_DETAIL,
          },
          activeAcceptedPolicy: null,
        };
      }
      return {
        registered,
        activeAcceptedPolicy: {
          kind: 'private-roster',
          participantAgents: Object.freeze([...currentAcceptedPrivateRoster]),
        },
      };
    }

    if (acceptsFinalizedAbsence) {
      const registeredWithoutAcceptedAbsence =
        await host.resolveRegisteredContextGraphAuthority(contextGraphId, {
          ...options,
          allowAcceptedRfc64FinalizedAbsence: false,
          allowApprovedPrivateReplicaFinalizedAbsence: true,
        });
      // The accepted authority can reactivate or rotate while that fallback
      // read awaits the index. If another authority (local-first or approved
      // replica) independently proved unregistered, the newly current signed
      // policy still takes precedence over its metadata roster.
      if (registeredWithoutAcceptedAbsence.kind === 'unregistered') {
        const reacquiredAcceptedPublicPolicy =
          host.hasActiveAcceptedRfc64PublicUnregisteredAuthorityV1(contextGraphId);
        if (reacquiredAcceptedPublicPolicy) {
          return {
            registered: registeredWithoutAcceptedAbsence,
            activeAcceptedPolicy: { kind: 'plaintext' },
          };
        }
        const reacquiredAcceptedPrivateRoster =
          host.resolveActiveAcceptedRfc64PrivateUnregisteredRosterV1?.(contextGraphId);
        if (reacquiredAcceptedPrivateRoster !== undefined) {
          if (reacquiredAcceptedPrivateRoster === null) {
            return {
              registered: {
                kind: 'unavailable',
                reason: 'finalized-name-absence-unaccepted',
                detail: ACCEPTED_PRIVATE_ROSTER_UNAVAILABLE_DETAIL,
              },
              activeAcceptedPolicy: null,
            };
          }
          return {
            registered: registeredWithoutAcceptedAbsence,
            activeAcceptedPolicy: {
              kind: 'private-roster',
              participantAgents: Object.freeze([...reacquiredAcceptedPrivateRoster]),
            },
          };
        }
      }
      return {
        registered: registeredWithoutAcceptedAbsence,
        activeAcceptedPolicy: null,
      };
    }
  }
  return { registered, activeAcceptedPolicy: null };
}

/**
 * Registered-chain authority for SWM consumers that need the raw roster (the
 * agent gate and member recovery). An active accepted owner-signed policy lets
 * exact finalized name absence count as unregistered, as on the read path; a
 * registration the index shows always wins, and the creator's own graph stays
 * local-first in the registry until its registration commits. Consumers that
 * need the accepted private roster itself use the transport/recovery decision,
 * which preserves it alongside this registration result.
 */
export async function resolveSwmRegisteredAuthorityDecision(
  host: SwmAuthorityHost,
  contextGraphId: string,
  options: SwmRegisteredAuthorityReadOptions = {},
): Promise<RegisteredContextGraphAuthority> {
  return (await readWithActiveAcceptedPolicy(host, contextGraphId, options)).registered;
}

/**
 * Resolve member-recovery authority without dropping the accepted private
 * roster that licensed finalized absence. Keeping the roster and registration
 * result in one decision also closes a deactivation/rotation race before a
 * caller could fall back to stale local metadata.
 */
export async function resolveSwmMemberRecoveryAuthorityDecision(
  host: SwmAuthorityHost,
  contextGraphId: string,
  options: SwmRegisteredAuthorityReadOptions = {},
): Promise<SwmMemberRecoveryAuthority> {
  const { registered, activeAcceptedPolicy } =
    await readWithActiveAcceptedPolicy(host, contextGraphId, options);
  switch (registered.kind) {
    case 'private':
      return { kind: 'private-roster', participantAgents: registered.participantAgents };
    case 'unregistered':
      return activeAcceptedPolicy?.kind === 'private-roster'
        ? activeAcceptedPolicy
        : { kind: 'legacy-unregistered' };
    case 'public':
    case 'unavailable':
      return { kind: 'denied' };
  }
}

/** How SWM on this graph may travel, for both ends of the wire. */
export async function resolveSwmTransportAuthorityDecision(
  host: SwmAuthorityHost,
  contextGraphId: string,
  options: SwmRegisteredAuthorityReadOptions = {},
): Promise<SwmTransportAuthority> {
  const { registered, activeAcceptedPolicy } =
    await readWithActiveAcceptedPolicy(host, contextGraphId, options);
  switch (registered.kind) {
    case 'public':
      return { kind: 'plaintext' };
    case 'unregistered':
      // An active accepted owner policy is authoritative over both the stale
      // local metadata roster and participant-only replica approval.
      if (activeAcceptedPolicy !== null) return activeAcceptedPolicy;
      if (registered.approvedPrivateReplicaAuthority === undefined) {
        return { kind: 'legacy-unregistered' };
      }
      const allowedPeers: unknown =
        registered.approvedPrivateReplicaAuthority.allowedPeers;
      if (
        !Array.isArray(allowedPeers)
        || !allowedPeers.every(
          (peerId): peerId is string => typeof peerId === 'string' && peerId.length > 0,
        )
      ) {
        return {
          kind: 'unavailable',
          reason: 'finalized-name-absence-unaccepted',
          detail: 'approved private replica authority is missing a valid source-qualified peer gate',
        };
      }
      return {
        kind: 'approved-private-replica',
        allowedPeers: Object.freeze([...allowedPeers]),
      };
    case 'private':
      return { kind: 'private-roster', participantAgents: registered.participantAgents };
    case 'unavailable':
      if (
        registered.reason === 'finalized-name-absence-unaccepted'
        && registered.detail === ACCEPTED_PRIVATE_ROSTER_UNAVAILABLE_DETAIL
      ) {
        return {
          kind: 'unavailable',
          reason: 'rfc64-private-read-roster-unavailable',
          detail: registered.detail,
        };
      }
      return registered;
  }
}
