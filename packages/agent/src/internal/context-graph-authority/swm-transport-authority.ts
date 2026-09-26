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
 * - `legacy-unregistered`: unregistered without such a policy. The local store
 *   roster decides, as it always has for local-only graphs.
 * - `private-roster`: registered private; encrypt to its current roster.
 * - `unavailable`: no authoritative answer, so fail closed.
 */
export type SwmTransportAuthority =
  | { readonly kind: 'plaintext' }
  | { readonly kind: 'legacy-unregistered' }
  | { readonly kind: 'private-roster'; readonly participantAgents: readonly string[] }
  | RegisteredContextGraphAuthorityUnavailable;

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
  resolveRegisteredContextGraphAuthority(
    contextGraphId: string,
    options: SwmRegisteredAuthorityReadOptions & { allowAcceptedRfc64FinalizedAbsence: boolean },
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
  readonly activeAcceptedPublicPolicy: boolean;
}> {
  const activeAcceptedPublicPolicy =
    host.hasActiveAcceptedRfc64PublicUnregisteredAuthorityV1(contextGraphId);
  const registered = await host.resolveRegisteredContextGraphAuthority(contextGraphId, {
    ...options,
    allowAcceptedRfc64FinalizedAbsence: activeAcceptedPublicPolicy,
  });
  return { registered, activeAcceptedPublicPolicy };
}

/**
 * Registered-chain authority for SWM consumers that need the raw roster (the
 * agent gate and member recovery). An active accepted owner-signed PUBLIC
 * policy lets exact finalized name absence count as unregistered, as on the
 * read path; a registration the index shows always wins, and the creator's own
 * graph stays local-first in the registry until its registration commits.
 */
export async function resolveSwmRegisteredAuthorityDecision(
  host: SwmAuthorityHost,
  contextGraphId: string,
  options: SwmRegisteredAuthorityReadOptions = {},
): Promise<RegisteredContextGraphAuthority> {
  return (await readWithActiveAcceptedPolicy(host, contextGraphId, options)).registered;
}

/** How SWM on this graph may travel, for both ends of the wire. */
export async function resolveSwmTransportAuthorityDecision(
  host: SwmAuthorityHost,
  contextGraphId: string,
  options: SwmRegisteredAuthorityReadOptions = {},
): Promise<SwmTransportAuthority> {
  const { registered, activeAcceptedPublicPolicy } =
    await readWithActiveAcceptedPolicy(host, contextGraphId, options);
  switch (registered.kind) {
    case 'public':
      return { kind: 'plaintext' };
    case 'unregistered':
      // Exact finalized absence under the active public policy, or the
      // registry's local-first answer for a graph this node created.
      return activeAcceptedPublicPolicy ? { kind: 'plaintext' } : { kind: 'legacy-unregistered' };
    case 'private':
      return { kind: 'private-roster', participantAgents: registered.participantAgents };
    case 'unavailable':
      return registered;
  }
}
