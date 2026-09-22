// SPDX-License-Identifier: Apache-2.0

/**
 * The on-chain ShardingTable membership gate shared by warm-core pinning and
 * authority-index core discovery, so the two never drift on what an absent
 * identity, an unbound chain read or a failed RPC means.
 */

/** The two optional chain reads behind membership; mocks and legacy chains lack them. */
export interface ShardingTableGateReads {
  readonly getIdentityIdForAddress?: (address: string) => Promise<bigint>;
  readonly isShardingTableMember?: (identityId: bigint) => Promise<boolean>;
}

export type ShardingTableGateOutcome =
  /** The chain vouches: the address maps to an identity in the table. */
  | 'member'
  /** The chain answered: no identity for the address, or one outside the table. */
  | 'non-member'
  /** Nothing to ask: no chain reads are bound, or the profile carries no address. */
  | 'unavailable'
  /** A read threw; there is no verdict this time and the next probe asks again. */
  | 'failed';

/** One chain probe; only `member` and `non-member` are verdicts worth remembering. */
export async function probeShardingTableGate(
  reads: ShardingTableGateReads,
  agentAddress: string | undefined,
): Promise<ShardingTableGateOutcome> {
  const { getIdentityIdForAddress, isShardingTableMember } = reads;
  if (getIdentityIdForAddress === undefined || isShardingTableMember === undefined) return 'unavailable';
  // A legacy/mixed-version profile may not carry an operational wallet.
  if (!agentAddress) return 'unavailable';
  try {
    const identityId = await getIdentityIdForAddress(agentAddress);
    if (identityId === 0n) return 'non-member';
    return (await isShardingTableMember(identityId)) ? 'member' : 'non-member';
  } catch {
    return 'failed';
  }
}

export interface ShardingTableGateOptions extends ShardingTableGateReads {
  readonly agentAddress: string | undefined;
  /**
   * What an unavailable gate decides. `allow` lets the phonebook role stand on
   * its own (warm-core pinning); `deny` treats an unverifiable core as untrusted
   * (authority snapshot providers). A failed read denies under both policies.
   */
  readonly unavailable: 'allow' | 'deny';
}

/** Boolean gate over {@link probeShardingTableGate}: a chain verdict is final. */
export async function evaluateShardingTableGate(options: ShardingTableGateOptions): Promise<boolean> {
  const outcome = await probeShardingTableGate(options, options.agentAddress);
  return outcome === 'member' || (outcome === 'unavailable' && options.unavailable === 'allow');
}
