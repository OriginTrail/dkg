// SPDX-License-Identifier: Apache-2.0

import type { ChainAdapter, TxResult } from '@origintrail-official/dkg-chain';
import { ethers } from 'ethers';
import type { RegisteredContextGraphAuthority } from
  './registered-context-graph-authority.js';

export type RegisteredParticipantMutationOperation = 'add' | 'remove';

interface PreparedRegisteredParticipantMutationBase {
  operation: RegisteredParticipantMutationOperation;
  contextGraphId: string;
}

export type PreparedRegisteredParticipantMutation =
  | (PreparedRegisteredParticipantMutationBase & {
      kind: 'local-only';
      agentAddresses: readonly [];
    })
  | (PreparedRegisteredParticipantMutationBase & {
      kind: 'registered-private';
      onChainId: bigint;
      agentAddresses: string[];
      mutate(onChainId: bigint, agentAddress: string): Promise<TxResult>;
    });

type RegisteredParticipantMutationCapability = (
  onChainId: bigint,
  agentAddress: string,
) => Promise<TxResult>;

function normalizeUniqueAddresses(agentAddresses: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of agentAddresses) {
    const address = ethers.getAddress(value);
    const key = address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(address);
  }
  return result;
}

function resolveMutationCapability(
  chain: ChainAdapter,
  operation: RegisteredParticipantMutationOperation,
  contextGraphId: string,
): RegisteredParticipantMutationCapability {
  const mutate = operation === 'add'
    ? chain.addContextGraphParticipantAgent
    : chain.removeContextGraphParticipantAgent;
  if (typeof mutate !== 'function') {
    throw new Error(
      `Registered context graph "${contextGraphId}" requires chain participant-governance support`,
    );
  }
  return (onChainId, agentAddress) => mutate.call(chain, onChainId, agentAddress);
}

/**
 * Prepare an idempotent registered-private participant-roster mutation.
 * Public and unregistered graphs deliberately retain their local-only
 * publisher/participant metadata behavior.
 *
 * THE ROSTER HERE DECIDES WHETHER A TRANSACTION IS SENT AT ALL, which is what
 * separates it from every other consumer of the same read. Everywhere else a
 * roster that is behind the chain delays a decision until the next read
 * corrects it. Here the filter below is the idempotence check — an `add` is
 * skipped when the agent already appears, a `remove` is skipped when it does
 * not — so a roster that has not yet caught up does not delay the mutation, it
 * CANCELS it:
 *
 *  - remove an agent whose `AgentParticipantAdded` is not yet visible: the
 *    filter drops the candidate, no transaction is sent, and the agent stays on
 *    the CHAIN roster indefinitely while local state records a removal;
 *  - add an agent whose `AgentParticipantRemoved` is not yet visible: the
 *    filter drops the candidate and the re-add silently does nothing.
 *
 * Neither self-corrects. Nothing re-runs this. So {@link
 * PrepareRegisteredParticipantMutationInput.rosterFreshness} is required and
 * accepts only `'live'`: it is a declaration by the caller that the authority
 * its `resolveAuthority` returns came from the chain and not from a projection,
 * a fold or a cache. Widening that type is not a refactor — it re-opens both
 * failure modes above, and it must not be done to make a call site compile.
 */
export interface PrepareRegisteredParticipantMutationInput {
  operation: RegisteredParticipantMutationOperation;
  contextGraphId: string;
  agentAddresses: readonly string[];
  chain: ChainAdapter;
  /**
   * Caller's declaration that `resolveAuthority` reads the chain LIVE.
   *
   * Deliberately a single-member literal rather than a boolean: a boolean can
   * be passed `false` by an inattentive caller, whereas widening this type
   * forces the edit to happen in this file, under the reasoning above.
   */
  rosterFreshness: 'live';
  resolveAuthority(): Promise<RegisteredContextGraphAuthority>;
}

export async function prepareRegisteredParticipantMutation(
  input: PrepareRegisteredParticipantMutationInput,
): Promise<PreparedRegisteredParticipantMutation> {
  const {
    operation,
    contextGraphId,
    chain,
    resolveAuthority,
  } = input;
  const authority = await resolveAuthority();
  if (authority.kind === 'unavailable') {
    throw new Error(
      `Registered context graph "${contextGraphId}" authority is unavailable (${authority.reason})`,
    );
  }
  if (authority.kind !== 'private') {
    return { kind: 'local-only', operation, contextGraphId, agentAddresses: [] };
  }

  const mutate = resolveMutationCapability(chain, operation, contextGraphId);
  const roster = new Set(
    authority.participantAgents.map((address) => address.toLowerCase()),
  );
  const candidates = normalizeUniqueAddresses(input.agentAddresses);
  const agentAddresses = candidates.filter((address) => {
    const present = roster.has(address.toLowerCase());
    return operation === 'add' ? !present : present;
  });
  return {
    kind: 'registered-private',
    operation,
    contextGraphId,
    onChainId: authority.onChainId,
    agentAddresses,
    mutate,
  };
}

/** Execute a prepared chain mutation and invalidate its authoritative roster. */
export async function commitRegisteredParticipantMutation(input: {
  prepared: PreparedRegisteredParticipantMutation;
  invalidateRoster(onChainId: bigint): void;
}): Promise<void> {
  const { prepared, invalidateRoster } = input;
  if (prepared.kind === 'local-only') return;
  const {
    operation,
    contextGraphId,
    onChainId,
    agentAddresses,
    mutate,
  } = prepared;

  try {
    for (const address of agentAddresses) {
      const result = await mutate(onChainId, address);
      if (!result.success) {
        throw new Error(
          `Failed to ${operation} ${address} ${operation === 'add' ? 'to' : 'from'} `
          + `registered context graph "${contextGraphId}" on chain`,
        );
      }
    }
  } finally {
    // A thrown adapter call can still have submitted a transaction, and a
    // multi-address add can fail after an earlier address succeeded. Never
    // retain a roster snapshot once the mutation boundary has been crossed.
    invalidateRoster(onChainId);
  }
}
