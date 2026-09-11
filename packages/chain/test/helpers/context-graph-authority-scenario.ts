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

interface AuthorityScenarioCurrentState {
  owner: string;
  participantAgents: readonly string[];
  metadataBatchId: bigint;
  active: boolean;
  createdAt: bigint;
  accessPolicy: bigint;
  publishPolicy: bigint;
  publishAuthority: string;
  publishAuthorityAccountId: bigint;
}

interface AuthorityScenarioEventBase {
  readonly blockNumber: number;
  readonly blockHash: string;
  readonly index: number;
}

type AuthorityScenarioEvent =
  | (AuthorityScenarioEventBase & Readonly<{
      name: 'ContextGraphCreated';
      contextGraphId: bigint;
      owner: string;
      nameHash: string;
      participantAgents: readonly string[];
      accessPolicy: bigint;
      publishPolicy: bigint;
      publishAuthority: string;
      publishAuthorityAccountId: bigint;
    }>)
  | (AuthorityScenarioEventBase & Readonly<{
      name: 'ContextGraphDeactivated';
      contextGraphId: bigint;
    }>)
  | (AuthorityScenarioEventBase & Readonly<{
      name: 'Transfer';
      from: string;
      to: string;
      tokenId: bigint;
    }>)
  | (AuthorityScenarioEventBase & Readonly<{
      name: 'PublishPolicyUpdated';
      contextGraphId: bigint;
      publishPolicy: bigint;
      publishAuthority: string;
      publishAuthorityAccountId: bigint;
    }>)
  | (AuthorityScenarioEventBase & Readonly<{
      name: 'PublishAuthorityUpdated';
      contextGraphId: bigint;
      newAuthority: string;
      newAuthorityAccountId: bigint;
    }>)
  | (AuthorityScenarioEventBase & Readonly<{
      name: 'AgentParticipantAdded' | 'AgentParticipantRemoved';
      contextGraphId: bigint;
      agent: string;
    }>);

function renderCurrentState(
  state: AuthorityScenarioCurrentState,
  publishAuthorityAccountId: unknown = state.publishAuthorityAccountId,
) {
  return Object.assign([
    state.owner,
    [...state.participantAgents],
    state.metadataBatchId,
    state.active,
    state.createdAt,
    state.accessPolicy,
    state.publishPolicy,
    state.publishAuthority,
    publishAuthorityAccountId,
  ], {
    owner: state.owner,
    participantAgents: [...state.participantAgents],
    metadataBatchId: state.metadataBatchId,
    active: state.active,
    createdAt: state.createdAt,
    accessPolicy: state.accessPolicy,
    publishPolicy: state.publishPolicy,
    publishAuthority: state.publishAuthority,
    publishAuthorityAccountId,
  });
}

function renderEventArgs(event: AuthorityScenarioEvent) {
  switch (event.name) {
    case 'ContextGraphCreated':
      return Object.assign([
        event.contextGraphId,
        event.owner,
        event.nameHash,
        [...event.participantAgents],
        0n,
        event.accessPolicy,
        event.publishPolicy,
        event.publishAuthority,
        event.publishAuthorityAccountId,
      ], {
        contextGraphId: event.contextGraphId,
        owner: event.owner,
        nameHash: event.nameHash,
        participantAgents: [...event.participantAgents],
        accessPolicy: event.accessPolicy,
        publishPolicy: event.publishPolicy,
        publishAuthority: event.publishAuthority,
        publishAuthorityAccountId: event.publishAuthorityAccountId,
      });
    case 'ContextGraphDeactivated':
      return Object.assign([event.contextGraphId], {
        contextGraphId: event.contextGraphId,
      });
    case 'Transfer':
      return Object.assign([event.from, event.to, event.tokenId], {
        from: event.from,
        to: event.to,
        tokenId: event.tokenId,
      });
    case 'PublishPolicyUpdated':
      return Object.assign([
        event.contextGraphId,
        event.publishPolicy,
        event.publishAuthority,
        event.publishAuthorityAccountId,
      ], {
        contextGraphId: event.contextGraphId,
        publishPolicy: event.publishPolicy,
        publishAuthority: event.publishAuthority,
        publishAuthorityAccountId: event.publishAuthorityAccountId,
      });
    case 'PublishAuthorityUpdated':
      return Object.assign([
        event.contextGraphId,
        event.newAuthority,
        event.newAuthorityAccountId,
      ], {
        contextGraphId: event.contextGraphId,
        newAuthority: event.newAuthority,
        newAuthorityAccountId: event.newAuthorityAccountId,
      });
    case 'AgentParticipantAdded':
    case 'AgentParticipantRemoved':
      return Object.assign([event.contextGraphId, event.agent], {
        contextGraphId: event.contextGraphId,
        agent: event.agent,
      });
  }
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

  const current: AuthorityScenarioCurrentState = {
    owner: OWNER,
    participantAgents: [MEMBER, OWNER],
    metadataBatchId: 0n,
    active: !options.deactivated,
    createdAt: 0n,
    accessPolicy: 1n,
    publishPolicy: 0n,
    publishAuthority: AUTHORITY,
    publishAuthorityAccountId: 7n,
  };
  let malformedPublishAuthorityAccountId: unknown | undefined;

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
        contextGraphId: 9n,
        owner: forkOwner,
        nameHash: NAME_HASH,
        participantAgents: forkParticipants,
        accessPolicy: 1n,
        publishPolicy: 0n,
        publishAuthority: AUTHORITY,
        publishAuthorityAccountId: 7n,
      },
      {
        name: 'Transfer',
        blockNumber: 10,
        blockHash: CREATION_HASH,
        index: 0,
        from: ethers.ZeroAddress,
        to: forkOwner,
        tokenId: 9n,
      },
      {
        name: 'Transfer',
        blockNumber: 15,
        blockHash: `0x${'99'.repeat(32)}`,
        index: 0,
        from: SECOND_MEMBER,
        to: OWNER,
        tokenId: 9n,
      },
      {
        name: 'PublishPolicyUpdated',
        blockNumber: 20,
        blockHash: POLICY_HASH,
        index: 0,
        contextGraphId: 9n,
        publishPolicy: 0n,
        publishAuthority: SECOND_AUTHORITY,
        publishAuthorityAccountId: 9n,
      },
      {
        name: 'PublishAuthorityUpdated',
        blockNumber: 21,
        blockHash: POLICY_HASH,
        index: 0,
        contextGraphId: 9n,
        newAuthority: AUTHORITY,
        newAuthorityAccountId: 7n,
      },
      {
        name: 'AgentParticipantAdded',
        blockNumber: 22,
        blockHash: `0x${'aa'.repeat(32)}`,
        index: 0,
        contextGraphId: 9n,
        agent: OWNER,
      },
      {
        name: 'AgentParticipantRemoved',
        blockNumber: 23,
        blockHash: `0x${'bb'.repeat(32)}`,
        index: 0,
        contextGraphId: 9n,
        agent: SECOND_MEMBER,
      },
      ...(options.deactivated ? [{
        name: 'ContextGraphDeactivated',
        blockNumber: 24,
        blockHash: `0x${'bc'.repeat(32)}`,
        index: 0,
        contextGraphId: 9n,
      }] : []),
      {
        name: 'PublishPolicyUpdated',
        blockNumber: 33,
        blockHash: NEXT_POLICY_HASH,
        index: 0,
        contextGraphId: 9n,
        publishPolicy: 1n,
        publishAuthority: ethers.ZeroAddress,
        publishAuthorityAccountId: 0n,
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
          args: renderEventArgs(row),
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
            args: renderEventArgs(row),
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
      return renderCurrentState(current, malformedPublishAuthorityAccountId);
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
      current.publishAuthority = ethers.ZeroAddress;
      current.publishAuthorityAccountId = 0n;
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
      malformedPublishAuthorityAccountId = value;
    },
  };
}
