// SPDX-License-Identifier: Apache-2.0

import type { ChainAdapter } from '@origintrail-official/dkg-chain';
import { ethers } from 'ethers';
import type { RegisteredContextGraphAuthority } from './dkg-agent-cg-resolve.js';

export type RegisteredParticipantMutationOperation = 'add' | 'remove';

export interface PreparedRegisteredParticipantMutation {
  operation: RegisteredParticipantMutationOperation;
  contextGraphId: string;
  onChainId?: bigint;
  agentAddresses: string[];
}

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

function assertMutationCapability(
  chain: ChainAdapter,
  operation: RegisteredParticipantMutationOperation,
  contextGraphId: string,
): void {
  const mutate = operation === 'add'
    ? chain.addContextGraphParticipantAgent
    : chain.removeContextGraphParticipantAgent;
  if (typeof mutate !== 'function') {
    throw new Error(
      `Registered context graph "${contextGraphId}" requires chain participant-governance support`,
    );
  }
}

/**
 * Prepare an idempotent registered-private participant-roster mutation.
 * Public and unregistered graphs deliberately retain their local-only
 * publisher/participant metadata behavior.
 */
export async function prepareRegisteredParticipantMutation(input: {
  operation: RegisteredParticipantMutationOperation;
  contextGraphId: string;
  agentAddresses: readonly string[];
  chain: ChainAdapter;
  resolveAuthority(): Promise<RegisteredContextGraphAuthority>;
}): Promise<PreparedRegisteredParticipantMutation> {
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
    return { operation, contextGraphId, agentAddresses: [] };
  }

  assertMutationCapability(chain, operation, contextGraphId);
  const roster = new Set(
    authority.participantAgents.map((address) => address.toLowerCase()),
  );
  const candidates = normalizeUniqueAddresses(input.agentAddresses);
  const agentAddresses = candidates.filter((address) => {
    const present = roster.has(address.toLowerCase());
    return operation === 'add' ? !present : present;
  });
  return {
    operation,
    contextGraphId,
    onChainId: authority.onChainId,
    agentAddresses,
  };
}

/** Execute a prepared chain mutation and invalidate its authoritative roster. */
export async function commitRegisteredParticipantMutation(input: {
  prepared: PreparedRegisteredParticipantMutation;
  chain: ChainAdapter;
  invalidateRoster(onChainId: bigint): void;
}): Promise<void> {
  const { prepared, chain, invalidateRoster } = input;
  const { operation, contextGraphId, onChainId, agentAddresses } = prepared;
  if (onChainId === undefined) return;

  assertMutationCapability(chain, operation, contextGraphId);
  try {
    for (const address of agentAddresses) {
      const result = operation === 'add'
        ? await chain.addContextGraphParticipantAgent!(onChainId, address)
        : await chain.removeContextGraphParticipantAgent!(onChainId, address);
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
