// SPDX-License-Identifier: Apache-2.0

import { ethers } from 'ethers';

export const OWNER = '0x1111111111111111111111111111111111111111';
export const MEMBER = '0x2222222222222222222222222222222222222222';
export const AUTHORITY = '0x3333333333333333333333333333333333333333';
export const GOVERNANCE = '0x4444444444444444444444444444444444444444';
export const SECOND_MEMBER = '0x5555555555555555555555555555555555555555';
export const SECOND_AUTHORITY = '0x6666666666666666666666666666666666666666';
export const FINALIZED_HASH = `0x${'55'.repeat(32)}`;
export const NEXT_FINALIZED_HASH = `0x${'56'.repeat(32)}`;
export const REPLACEMENT_FINALIZED_HASH = `0x${'cc'.repeat(32)}`;
export const CREATION_HASH = `0x${'66'.repeat(32)}`;
export const POLICY_HASH = `0x${'77'.repeat(32)}`;
export const NEXT_POLICY_HASH = `0x${'78'.repeat(32)}`;
export const NAME_HASH = `0x${'88'.repeat(32)}`;

interface AuthorityScenarioEvent {
  readonly name: string;
  readonly blockNumber: number;
  readonly blockHash: string;
  readonly index: number;
  readonly positionalArgs: readonly unknown[];
  readonly namedArgs: Readonly<Record<string, unknown>>;
}

export interface AuthorityScenarioOptions {
  readonly deactivated?: boolean;
  readonly reorg?: boolean;
}

export interface AuthorityScenarioGate {
  readonly entered: Promise<void>;
  release(): void;
}

/**
 * Canonical protocol scenario shared by the legacy and indexed readers.
 * Renderers below deliberately differ only at their RPC boundary shape.
 */
export function createAuthorityScenario(options: AuthorityScenarioOptions = {}) {
  let finalizedNumber = 30;
  let finalizedHash = FINALIZED_HASH;
  let cachedAnchorReplaced = false;
  let replacementAuthorityFork = false;
  let currentReadGate: Readonly<{
    entered: PromiseWithResolvers<void>;
    release: PromiseWithResolvers<void>;
  }> | undefined;
  let blockReadGate: Readonly<{
    tag: string | number;
    entered: PromiseWithResolvers<void>;
    release: PromiseWithResolvers<void>;
  }> | undefined;

  const current = Object.assign(
    [OWNER, [MEMBER, OWNER], 0n, !options.deactivated, 0n, 1n, 0n, AUTHORITY, 7n],
    {
      owner: OWNER,
      participantAgents: [MEMBER, OWNER],
      active: !options.deactivated,
      accessPolicy: 1n,
      publishPolicy: 0n,
      publishAuthority: AUTHORITY,
      publishAuthorityAccountId: 7n as unknown,
    },
  );

  const events = (): AuthorityScenarioEvent[] => {
    const forkOwner = replacementAuthorityFork ? MEMBER : SECOND_MEMBER;
    const forkParticipants = replacementAuthorityFork
      ? [MEMBER]
      : [MEMBER, SECOND_MEMBER];
    const rows: AuthorityScenarioEvent[] = [
      {
        name: 'ContextGraphCreated',
        blockNumber: 10,
        blockHash: CREATION_HASH,
        index: 1,
        positionalArgs: [
          9n,
          forkOwner,
          NAME_HASH,
          forkParticipants,
          0n,
          1n,
          0n,
          AUTHORITY,
          7n,
        ],
        namedArgs: {
          contextGraphId: 9n,
          owner: forkOwner,
          nameHash: NAME_HASH,
          participantAgents: forkParticipants,
          accessPolicy: 1n,
          publishPolicy: 0n,
          publishAuthority: AUTHORITY,
          publishAuthorityAccountId: 7n,
        },
      },
      {
        name: 'Transfer',
        blockNumber: 10,
        blockHash: CREATION_HASH,
        index: 0,
        positionalArgs: [ethers.ZeroAddress, forkOwner, 9n],
        namedArgs: { from: ethers.ZeroAddress, to: forkOwner, tokenId: 9n },
      },
      {
        name: 'Transfer',
        blockNumber: 15,
        blockHash: `0x${'99'.repeat(32)}`,
        index: 0,
        positionalArgs: [SECOND_MEMBER, OWNER, 9n],
        namedArgs: { from: SECOND_MEMBER, to: OWNER, tokenId: 9n },
      },
      {
        name: 'PublishPolicyUpdated',
        blockNumber: 20,
        blockHash: POLICY_HASH,
        index: 0,
        positionalArgs: [9n, 0n, SECOND_AUTHORITY, 9n],
        namedArgs: {
          contextGraphId: 9n,
          publishPolicy: 0n,
          publishAuthority: SECOND_AUTHORITY,
          publishAuthorityAccountId: 9n,
        },
      },
      {
        name: 'PublishAuthorityUpdated',
        blockNumber: 21,
        blockHash: POLICY_HASH,
        index: 0,
        positionalArgs: [9n, AUTHORITY, 7n],
        namedArgs: {
          contextGraphId: 9n,
          newAuthority: AUTHORITY,
          newAuthorityAccountId: 7n,
        },
      },
      {
        name: 'AgentParticipantAdded',
        blockNumber: 22,
        blockHash: `0x${'aa'.repeat(32)}`,
        index: 0,
        positionalArgs: [9n, OWNER],
        namedArgs: { contextGraphId: 9n, agent: OWNER },
      },
      {
        name: 'AgentParticipantRemoved',
        blockNumber: 23,
        blockHash: `0x${'bb'.repeat(32)}`,
        index: 0,
        positionalArgs: [9n, SECOND_MEMBER],
        namedArgs: { contextGraphId: 9n, agent: SECOND_MEMBER },
      },
      ...(options.deactivated ? [{
        name: 'ContextGraphDeactivated',
        blockNumber: 24,
        blockHash: `0x${'bc'.repeat(32)}`,
        index: 0,
        positionalArgs: [9n],
        namedArgs: { contextGraphId: 9n },
      }] : []),
      {
        name: 'PublishPolicyUpdated',
        blockNumber: 33,
        blockHash: NEXT_POLICY_HASH,
        index: 0,
        positionalArgs: [9n, 1n, ethers.ZeroAddress, 0n],
        namedArgs: {
          contextGraphId: 9n,
          publishPolicy: 1n,
          publishAuthority: ethers.ZeroAddress,
          publishAuthorityAccountId: 0n,
        },
      },
    ];
    if (!replacementAuthorityFork) return rows;
    return rows.filter((row) => (
      row.name === 'ContextGraphCreated'
      || (row.name === 'Transfer' && row.blockNumber === 10)
    ));
  };

  return {
    get finalizedNumber() { return finalizedNumber; },
    renderQueryFilter(name: string, fromBlock: number, toBlock: number) {
      return events()
        .filter((row) => (
          row.name === name
          && row.blockNumber >= fromBlock
          && row.blockNumber <= toBlock
        ))
        .map((row) => ({
          blockNumber: row.blockNumber,
          blockHash: row.blockHash,
          index: row.index,
          args: [...row.positionalArgs],
        }));
    },
    renderParsedLogs(fromBlock: number, toBlock: number) {
      return events()
        .filter((row) => row.blockNumber >= fromBlock && row.blockNumber <= toBlock)
        .map((row) => ({
          blockNumber: row.blockNumber,
          blockHash: row.blockHash,
          index: row.index,
          parsed: {
            name: row.name,
            args: Object.assign([...row.positionalArgs], row.namedArgs),
          },
        }));
    },
    async readCurrentState() {
      const gate = currentReadGate;
      if (gate !== undefined) {
        currentReadGate = undefined;
        gate.entered.resolve();
        await gate.release.promise;
      }
      return current;
    },
    async getBlock(tag: string | number) {
      const gate = blockReadGate;
      if (gate?.tag === tag) {
        blockReadGate = undefined;
        gate.entered.resolve();
        await gate.release.promise;
      }
      if (tag === 'finalized') return { number: finalizedNumber, hash: finalizedHash };
      const historicalHash = tag === 30 && cachedAnchorReplaced
        ? REPLACEMENT_FINALIZED_HASH
        : tag === 30
          ? FINALIZED_HASH
          : finalizedHash;
      return {
        number: Number(tag),
        hash: options.reorg && tag === finalizedNumber
          ? REPLACEMENT_FINALIZED_HASH
          : historicalHash,
      };
    },
    advanceAuthorityHead(): void {
      finalizedNumber = 35;
      finalizedHash = NEXT_FINALIZED_HASH;
      current.publishPolicy = 1n;
      current[6] = 1n;
      current.publishAuthority = ethers.ZeroAddress;
      current[7] = ethers.ZeroAddress;
      current.publishAuthorityAccountId = 0n;
      current[8] = 0n;
    },
    replaceCachedAnchor(): void {
      cachedAnchorReplaced = true;
    },
    replaceFinalizedHead(): void {
      finalizedHash = REPLACEMENT_FINALIZED_HASH;
      cachedAnchorReplaced = true;
    },
    replaceAuthorityFork(): void {
      finalizedHash = REPLACEMENT_FINALIZED_HASH;
      cachedAnchorReplaced = true;
      replacementAuthorityFork = true;
    },
    holdCurrentStateRead(): AuthorityScenarioGate {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      currentReadGate = { entered, release };
      return { entered: entered.promise, release: release.resolve };
    },
    holdBlockRead(tag: string | number): AuthorityScenarioGate {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      blockReadGate = { tag, entered, release };
      return { entered: entered.promise, release: release.resolve };
    },
    setPublishAuthorityAccountId(value: unknown): void {
      current.publishAuthorityAccountId = value;
      current[8] = value;
    },
  };
}
