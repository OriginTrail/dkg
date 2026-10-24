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
export const LATE_NAME_HASH = `0x${'8a'.repeat(32)}`;

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
  /** Operator depth; the anchor resolves to `finalizedNumber - this + 1`. */
  readonly finalityConfirmations?: number;
  readonly secondContextGraph?: boolean;
  readonly extraContextGraph?: Readonly<{ contextGraphId: bigint; nameHash: string }>;
  readonly zeroHashContextGraphs?: number;
  readonly lateContextGraphNameHash?: string;
  readonly finalizedNumber?: number;
  /**
   * The head block's own hash. Needed when the head carries events: the page
   * reducer requires an event AT the page anchor to match the anchor's hash.
   */
  readonly finalizedHash?: string;
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
  let finalizedNumber = options.finalizedNumber ?? 30;
  let finalizedHash = options.finalizedHash ?? FINALIZED_HASH;
  let cachedAnchorReplaced = false;
  const finalityConfirmations = options.finalityConfirmations ?? 1;
  /** The height the reader's anchor resolves to, for THIS scenario's depth. */
  const anchorNumber = () => finalizedNumber - finalityConfirmations + 1;
  /**
   * The reader derives its anchor from the HEAD block and
   * `chain.finalityConfirmations`. The head is read as `getBlock('latest')`, so
   * at the default depth the anchor read is structurally distinct from every
   * numbered read and no bookkeeping is needed. Below the default depth the
   * anchor IS a numbered read at `anchorNumber()`, and the stabilization fence
   * re-reads that same height — so one flag, armed by the head read and
   * disarmed by the first numbered read AT THE ANCHOR HEIGHT, separates them.
   *
   * Keying on `anchorNumber()` rather than on the head is what makes this hold
   * at every depth: keyed on the head it never disarms below depth 1, which
   * silently turned `holdBlockRead` into a no-op and dropped the `reorg`
   * injection on the floor.
   */
  let anchorReadArmed = false;
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
  let headReadGate: Readonly<{
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
      ...(options.secondContextGraph ? [{
        name: 'ContextGraphCreated' as const,
        blockNumber: 18,
        blockHash: `0x${'67'.repeat(32)}`,
        index: 1,
        contextGraphId: 10n,
        owner: MEMBER,
        nameHash: `0x${'89'.repeat(32)}`,
        participantAgents: [MEMBER],
        accessPolicy: 1n,
        publishPolicy: 0n,
        publishAuthority: SECOND_AUTHORITY,
        publishAuthorityAccountId: 8n,
      }, {
        name: 'Transfer' as const,
        blockNumber: 18,
        blockHash: `0x${'67'.repeat(32)}`,
        index: 0,
        from: ethers.ZeroAddress,
        to: MEMBER,
        tokenId: 10n,
      }] : []),
      ...(options.extraContextGraph === undefined ? [] : [{
        name: 'ContextGraphCreated' as const,
        blockNumber: 19,
        blockHash: `0x${'68'.repeat(32)}`,
        index: 1,
        contextGraphId: options.extraContextGraph.contextGraphId,
        owner: MEMBER,
        nameHash: options.extraContextGraph.nameHash,
        participantAgents: [MEMBER],
        accessPolicy: 1n,
        publishPolicy: 0n,
        publishAuthority: SECOND_AUTHORITY,
        publishAuthorityAccountId: 8n,
      }, {
        name: 'Transfer' as const,
        blockNumber: 19,
        blockHash: `0x${'68'.repeat(32)}`,
        index: 0,
        from: ethers.ZeroAddress,
        to: MEMBER,
        tokenId: options.extraContextGraph.contextGraphId,
      }]),
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
      ...Array.from({ length: options.zeroHashContextGraphs ?? 0 }, (_, index) => ({
        name: 'ContextGraphCreated' as const,
        blockNumber: 25,
        blockHash: `0x${'bd'.repeat(32)}`,
        index,
        contextGraphId: 20n + BigInt(index),
        owner: MEMBER,
        nameHash: ethers.ZeroHash,
        participantAgents: [MEMBER],
        accessPolicy: 1n,
        publishPolicy: 0n,
        publishAuthority: SECOND_AUTHORITY,
        publishAuthorityAccountId: 0n,
      })),
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
      ...(options.lateContextGraphNameHash === undefined ? [] : [{
        name: 'ContextGraphCreated' as const,
        blockNumber: 33,
        blockHash: NEXT_POLICY_HASH,
        index: 1,
        contextGraphId: 11n,
        owner: MEMBER,
        nameHash: options.lateContextGraphNameHash,
        participantAgents: [MEMBER],
        accessPolicy: 1n,
        publishPolicy: 0n,
        publishAuthority: SECOND_AUTHORITY,
        publishAuthorityAccountId: 8n,
      }]),
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
    /**
     * The chain head. The reader derives its anchor from this height and
     * `chain.finalityConfirmations` — it must never ask for the `finalized` tag.
     */
    async getBlockNumber() {
      return finalizedNumber;
    },
    async getBlock(tag: string | number) {
      if (typeof tag === 'string') {
        if (tag !== 'latest') {
          // The endpoint's `finalized`/`safe` markers are NOT this node's
          // definition of finality — that is `chain.finalityConfirmations`
          // applied to the head. A reader reaching for one has reintroduced the
          // second notion of finality this scenario exists to keep out, so the
          // fixture refuses rather than quietly answering with the head.
          throw new Error(
            `Context Graph authority reads must not use the '${tag}' block tag`,
          );
        }
        // The HEAD read. Gated by `holdHeadRead()`, and at the default depth it
        // is also the anchor read, so it must carry the anchor's hash.
        const gate = headReadGate;
        if (gate !== undefined) {
          headReadGate = undefined;
          gate.entered.resolve();
          await gate.release.promise;
        }
        // Arm ONLY when the depth actually puts the anchor below the head. At
        // depth 1 this read IS the anchor, so a later numbered read at this
        // height is unambiguously the stabilization fence.
        anchorReadArmed = anchorNumber() !== finalizedNumber;
        return { number: finalizedNumber, hash: finalizedHash };
      }
      // A numbered read: the deeper anchor resolution below depth 1, or the
      // stabilization fence / historical hash read.
      const anchorResolution = anchorReadArmed && tag === anchorNumber();
      if (anchorResolution) anchorReadArmed = false;
      const gate = blockReadGate;
      if (gate?.tag === tag && !anchorResolution) {
        blockReadGate = undefined;
        gate.entered.resolve();
        await gate.release.promise;
      }
      const historicalHash = tag === 30 && cachedAnchorReplaced
        ? REPLACEMENT_FINALIZED_HASH
        : tag === 30
          ? FINALIZED_HASH
          : finalizedHash;
      return {
        number: Number(tag),
        hash: options.reorg && tag === anchorNumber() && !anchorResolution
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
    /** Gate the head read that opens every anchor resolution. */
    holdHeadRead(): AuthorityScenarioGate {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      headReadGate = { entered, release };
      return { entered: entered.promise, release: release.resolve };
    },
    setPublishAuthorityAccountId(value: unknown): void {
      malformedPublishAuthorityAccountId = value;
    },
  };
}
