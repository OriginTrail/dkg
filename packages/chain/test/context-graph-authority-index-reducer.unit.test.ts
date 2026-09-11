// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';

import {
  ContextGraphAuthorityHistoryCache,
  resolveContextGraphAuthorityHistory,
} from '../src/context-graph-authority-history.js';
import {
  createContextGraphAuthorityIndexCheckpoint,
  normalizeContextGraphAuthorityIndexCheckpoint,
  type ContextGraphAuthorityIndexStore,
} from '../src/context-graph-authority-index-checkpoint.js';
import {
  reduceContextGraphAuthorityIndexPage,
  type ContextGraphAuthorityIndexEvent,
} from '../src/context-graph-authority-index-reducer.js';
import {
  applyContextGraphAuthorityStateEvent,
  normalizeContextGraphAuthorityPublishReference,
  type ContextGraphAuthorityIndexState,
} from '../src/context-graph-authority-state.js';

const ZERO = `0x${'0'.repeat(40)}`;
const OWNER = `0x${'11'.repeat(20)}`;
const NEXT_OWNER = `0x${'22'.repeat(20)}`;
const AUTHORITY = `0x${'33'.repeat(20)}`;
const NAME_9 = `0x${'99'.repeat(32)}`;
const NAME_10 = `0x${'aa'.repeat(32)}`;

const blockHash = (block: number): string => `0x${block.toString(16).padStart(64, '0')}`;

function event(
  name: ContextGraphAuthorityIndexEvent['name'],
  contextGraphId: bigint,
  blockNumber: number,
  index: number,
  extra: Record<string, unknown> = {},
): ContextGraphAuthorityIndexEvent {
  const defaults: Record<string, unknown> = (() => {
    switch (name) {
      case 'PublishPolicyUpdated':
        return {
          publishPolicy: 0,
          publishAuthority: NEXT_OWNER,
          publishAuthorityAccountId: 0n,
        };
      case 'PublishAuthorityUpdated':
        return { publishAuthority: NEXT_OWNER, publishAuthorityAccountId: 0n };
      case 'AgentParticipantAdded':
        return { agent: NEXT_OWNER };
      case 'AgentParticipantRemoved':
        return { agent: OWNER };
      default:
        return {};
    }
  })();
  return {
    name,
    contextGraphId,
    blockNumber,
    blockHash: blockHash(blockNumber),
    index,
    ...defaults,
    ...extra,
  } as ContextGraphAuthorityIndexEvent;
}

function creation(
  contextGraphId: bigint,
  blockNumber: number,
  index: number,
  nameHash: string,
): ContextGraphAuthorityIndexEvent {
  return event('ContextGraphCreated', contextGraphId, blockNumber, index, {
    owner: OWNER,
    nameHash,
    participantAgents: [OWNER],
    accessPolicy: 1,
    publishPolicy: 0,
    publishAuthority: AUTHORITY,
    publishAuthorityAccountId: 7n,
  });
}

const validCursor = Object.freeze({
  deploymentBlockNumber: 10,
  throughBlockNumber: 20,
  throughBlockHash: blockHash(20),
});

const validState = Object.freeze({
  contextGraphId: '9',
  owner: OWNER,
  active: true,
  accessPolicy: 1 as const,
  publishPolicy: 0 as const,
  publishAuthority: AUTHORITY,
  publishAuthorityAccountId: '7',
  participantAgents: Object.freeze([OWNER]),
  nameHash: NAME_9,
  ownershipEra: 0,
  policyVersion: 0,
  rosterVersion: 0,
  sourceBlockNumber: 10,
  sourceBlockHash: blockHash(10),
});

describe('contract-wide Context Graph authority index reducer', () => {
  it('groups unsorted logs by graph and preserves the authority generation semantics', () => {
    const result = reduceContextGraphAuthorityIndexPage({
      deploymentBlockNumber: 10,
      throughBlockNumber: 20,
      throughBlockHash: blockHash(20),
      events: [
        event('AgentParticipantRemoved', 9n, 13, 0),
        creation(10n, 11, 1, NAME_10),
        event('PublishAuthorityUpdated', 9n, 12, 2),
        event('Transfer', 9n, 10, 0, { from: ZERO, to: OWNER }),
        event('AgentParticipantAdded', 9n, 11, 2),
        creation(9n, 10, 1, NAME_9),
        event('Transfer', 9n, 12, 1, { from: OWNER, to: NEXT_OWNER }),
      ],
    });

    expect(result.checkpoint.cursor).toEqual({
      deploymentBlockNumber: 10,
      throughBlockNumber: 20,
      throughBlockHash: blockHash(20),
    });
    expect(result.checkpoint.states).toEqual([
      {
        contextGraphId: '9',
        owner: NEXT_OWNER,
        active: true,
        accessPolicy: 1,
        publishPolicy: 0,
        publishAuthority: NEXT_OWNER,
        publishAuthorityAccountId: '0',
        participantAgents: [NEXT_OWNER],
        nameHash: NAME_9,
        ownershipEra: 1,
        policyVersion: 2,
        rosterVersion: 3,
        sourceBlockNumber: 12,
        sourceBlockHash: blockHash(12),
      },
      {
        contextGraphId: '10',
        owner: OWNER,
        active: true,
        accessPolicy: 1,
        publishPolicy: 0,
        publishAuthority: AUTHORITY,
        publishAuthorityAccountId: '7',
        participantAgents: [OWNER],
        nameHash: NAME_10,
        ownershipEra: 0,
        policyVersion: 0,
        rosterVersion: 0,
        sourceBlockNumber: 11,
        sourceBlockHash: blockHash(11),
      },
    ]);
    expect(Object.isFrozen(result.checkpoint)).toBe(true);
    expect(Object.isFrozen(result.checkpoint.states)).toBe(true);
    expect(result.checkpoint.states.every(Object.isFrozen)).toBe(true);
  });

  it('matches the legacy per-graph reducer for the same event history', async () => {
    const index = reduceContextGraphAuthorityIndexPage({
      deploymentBlockNumber: 10,
      throughBlockNumber: 20,
      throughBlockHash: blockHash(20),
      events: [
        event('AgentParticipantRemoved', 9n, 13, 0),
        event('PublishAuthorityUpdated', 9n, 12, 2),
        event('AgentParticipantAdded', 9n, 11, 2),
        creation(9n, 10, 1, NAME_9),
        event('Transfer', 9n, 12, 1, { from: OWNER, to: NEXT_OWNER }),
      ],
    }).checkpoint.states[0]!;
    const history = await resolveContextGraphAuthorityHistory({
      cache: new ContextGraphAuthorityHistoryCache(),
      cacheKey: 'parity:9',
      readScope: {},
      contextGraphId: 9n,
      finalized: { number: 20, hash: blockHash(20) },
      pageSize: 100,
      loadColdFromBlock: async () => 10,
      readBlockHash: async (blockNumber) => blockHash(blockNumber),
      readCreationEvents: async () => [{
        blockNumber: 10,
        blockHash: blockHash(10),
        index: 1,
        nameHash: NAME_9,
      }],
      readEvents: async ({ name }) => ({
        Transfer: [{ blockNumber: 12, blockHash: blockHash(12), index: 1 }],
        PublishAuthorityUpdated: [{
          blockNumber: 12, blockHash: blockHash(12), index: 2,
        }],
        AgentParticipantAdded: [{ blockNumber: 11, blockHash: blockHash(11), index: 2 }],
        AgentParticipantRemoved: [{ blockNumber: 13, blockHash: blockHash(13), index: 0 }],
        PublishPolicyUpdated: [],
      })[name],
    });
    const {
      contextGraphId: _,
      owner: _owner,
      active: _active,
      accessPolicy: _accessPolicy,
      publishPolicy: _publishPolicy,
      publishAuthority: _publishAuthority,
      publishAuthorityAccountId: _publishAuthorityAccountId,
      participantAgents: _participantAgents,
      ...indexGeneration
    } = index;
    const { throughBlockNumber: _number, throughBlockHash: _hash, ...legacyGeneration } =
      history.state;
    expect(indexGeneration).toEqual(legacyGeneration);
  });

  it('reduces an exactly contiguous suffix without mutating the prior checkpoint', () => {
    const first = reduceContextGraphAuthorityIndexPage({
      deploymentBlockNumber: 10,
      throughBlockNumber: 20,
      throughBlockHash: blockHash(20),
      events: [creation(9n, 10, 1, NAME_9), creation(10n, 11, 1, NAME_10)],
    });
    const suffix = reduceContextGraphAuthorityIndexPage({
      deploymentBlockNumber: 10,
      throughBlockNumber: 25,
      throughBlockHash: blockHash(25),
      previous: first.checkpoint,
      events: [event('PublishPolicyUpdated', 10n, 22, 4)],
    });

    expect(suffix.checkpoint.states).toHaveLength(2);
    expect(suffix.checkpoint.states[1]).toMatchObject({
      contextGraphId: '10',
      policyVersion: 1,
      sourceBlockNumber: 22,
    });
    expect(first.checkpoint.states[1]).toMatchObject({
      contextGraphId: '10',
      policyVersion: 0,
    });

    const emptySuffix = reduceContextGraphAuthorityIndexPage({
      deploymentBlockNumber: 10,
      throughBlockNumber: 30,
      throughBlockHash: blockHash(30),
      previous: suffix.checkpoint,
      events: [],
    });
    expect(emptySuffix.checkpoint.states).toHaveLength(2);
  });

  it('materializes every mutable authority field from ordered contract events', () => {
    const result = reduceContextGraphAuthorityIndexPage({
      deploymentBlockNumber: 10,
      throughBlockNumber: 20,
      throughBlockHash: blockHash(20),
      events: [
        creation(9n, 10, 1, NAME_9),
        event('Transfer', 9n, 11, 0, { from: OWNER, to: NEXT_OWNER }),
        event('PublishPolicyUpdated', 9n, 12, 0, {
          publishPolicy: 1,
          publishAuthority: ZERO,
          publishAuthorityAccountId: 0n,
        }),
        event('AgentParticipantRemoved', 9n, 13, 0, { agent: OWNER }),
        event('AgentParticipantAdded', 9n, 14, 0, { agent: AUTHORITY }),
        event('ContextGraphDeactivated', 9n, 15, 0),
      ],
    });

    expect(result.checkpoint.states[0]).toEqual({
      contextGraphId: '9',
      owner: NEXT_OWNER,
      active: false,
      accessPolicy: 1,
      publishPolicy: 1,
      publishAuthority: null,
      publishAuthorityAccountId: '0',
      participantAgents: [AUTHORITY],
      nameHash: NAME_9,
      ownershipEra: 1,
      policyVersion: 2,
      rosterVersion: 3,
      sourceBlockNumber: 12,
      sourceBlockHash: blockHash(12),
    });
    expect(Object.isFrozen(result.checkpoint.states[0]!.participantAgents)).toBe(true);
  });

  it('ignores mint and self-transfer logs but fails closed on an unexpected burn', () => {
    const result = reduceContextGraphAuthorityIndexPage({
      deploymentBlockNumber: 10,
      throughBlockNumber: 15,
      throughBlockHash: blockHash(15),
      events: [
        event('Transfer', 9n, 10, 0, { from: ZERO, to: OWNER }),
        creation(9n, 10, 1, NAME_9),
        event('Transfer', 9n, 11, 0, { from: OWNER, to: OWNER }),
      ],
    });
    expect(result.checkpoint.states[0]).toMatchObject({
      ownershipEra: 0,
      policyVersion: 0,
      rosterVersion: 0,
      sourceBlockNumber: 10,
    });
    expect(() => reduceContextGraphAuthorityIndexPage({
      deploymentBlockNumber: 10,
      throughBlockNumber: 15,
      throughBlockHash: blockHash(15),
      events: [
        creation(9n, 10, 1, NAME_9),
        event('Transfer', 9n, 12, 0, { from: OWNER, to: ZERO }),
      ],
    })).toThrow('cannot materialize a burned token');
  });

  it('fails closed on gaps, overlaps, and deployment changes', () => {
    const first = reduceContextGraphAuthorityIndexPage({
      deploymentBlockNumber: 10,
      throughBlockNumber: 20,
      throughBlockHash: blockHash(20),
      events: [creation(9n, 10, 1, NAME_9)],
    });
    expect(() => reduceContextGraphAuthorityIndexPage({
      deploymentBlockNumber: 10,
      throughBlockNumber: 20,
      throughBlockHash: blockHash(20),
      previous: first.checkpoint,
      events: [],
    })).toThrow('empty, overlapping, or non-contiguous');
    expect(() => reduceContextGraphAuthorityIndexPage({
      deploymentBlockNumber: 11,
      throughBlockNumber: 25,
      throughBlockHash: blockHash(25),
      previous: first.checkpoint,
      events: [],
    })).toThrow('deployment block changed');
  });

  it('fails closed on duplicate positions, duplicate creation, and pre-creation changes', () => {
    expect(() => reduceContextGraphAuthorityIndexPage({
      deploymentBlockNumber: 10,
      throughBlockNumber: 20,
      throughBlockHash: blockHash(20),
      events: [
        creation(9n, 10, 1, NAME_9),
        event('AgentParticipantAdded', 9n, 10, 1),
      ],
    })).toThrow('duplicate log position');

    const first = reduceContextGraphAuthorityIndexPage({
      deploymentBlockNumber: 10,
      throughBlockNumber: 20,
      throughBlockHash: blockHash(20),
      events: [creation(9n, 10, 1, NAME_9)],
    });
    expect(() => reduceContextGraphAuthorityIndexPage({
      deploymentBlockNumber: 10,
      throughBlockNumber: 25,
      throughBlockHash: blockHash(25),
      previous: first.checkpoint,
      events: [creation(9n, 22, 1, NAME_9)],
    })).toThrow('more than one creation event');

    expect(() => reduceContextGraphAuthorityIndexPage({
      deploymentBlockNumber: 10,
      throughBlockNumber: 20,
      throughBlockHash: blockHash(20),
      events: [event('PublishPolicyUpdated', 9n, 12, 0)],
    })).toThrow('precedes creation');
  });

  it('validates page events and the terminal page anchor', () => {
    expect(() => reduceContextGraphAuthorityIndexPage({
      deploymentBlockNumber: 10,
      throughBlockNumber: 20,
      throughBlockHash: blockHash(20),
      events: [creation(9n, 21, 0, NAME_9)],
    })).toThrow('outside its page or is malformed');
    expect(() => reduceContextGraphAuthorityIndexPage({
      deploymentBlockNumber: 10,
      throughBlockNumber: 20,
      throughBlockHash: blockHash(20),
      events: [{
        ...creation(9n, 20, 0, NAME_9),
        blockHash: blockHash(19),
      }],
    })).toThrow('disagrees with the page anchor');
    expect(() => reduceContextGraphAuthorityIndexPage({
      deploymentBlockNumber: 10,
      throughBlockNumber: 20,
      throughBlockHash: blockHash(20),
      events: [event('Transfer', 9n, 12, 0, { from: 'bad', to: OWNER })],
    })).toThrow('invalid address');
  });

  it('normalizes durable checkpoints and rejects id, hash, and source corruption', () => {
    const valid = reduceContextGraphAuthorityIndexPage({
      deploymentBlockNumber: 10,
      throughBlockNumber: 20,
      throughBlockHash: blockHash(20).toUpperCase().replace('0X', '0x'),
      events: [creation(9n, 10, 1, NAME_9.toUpperCase().replace('0X', '0x'))],
    }).checkpoint;
    expect(normalizeContextGraphAuthorityIndexCheckpoint(valid)).toEqual(valid);
    expect(normalizeContextGraphAuthorityIndexCheckpoint({ ...valid, version: 1 }))
      .toBeUndefined();
    expect(normalizeContextGraphAuthorityIndexCheckpoint({
      ...valid,
      states: [{ ...valid.states[0], contextGraphId: '09' }],
    })).toBeUndefined();
    expect(normalizeContextGraphAuthorityIndexCheckpoint({
      ...valid,
      states: [{ ...valid.states[0], sourceBlockNumber: 21 }],
    })).toBeUndefined();
    expect(normalizeContextGraphAuthorityIndexCheckpoint({
      ...valid,
      cursor: { ...valid.cursor, throughBlockHash: 'bad' },
    })).toBeUndefined();
    expect(normalizeContextGraphAuthorityIndexCheckpoint({
      ...valid,
      states: [{
        ...valid.states[0],
        ownershipEra: 1,
        policyVersion: 0,
        rosterVersion: 0,
      }],
    })).toBeUndefined();
    expect(normalizeContextGraphAuthorityIndexCheckpoint({
      ...valid,
      states: [{ ...valid.states[0], contextGraphId: (1n << 256n).toString(10) }],
    })).toBeUndefined();

    const integrityMutations: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
      ['owner', { owner: NEXT_OWNER }],
      ['active', { active: false }],
      ['access policy', { accessPolicy: 0 }],
      ['publish policy', {
        publishPolicy: 1,
        publishAuthority: null,
        publishAuthorityAccountId: '0',
      }],
      ['publish authority', { publishAuthority: NEXT_OWNER }],
      ['publish authority account id', { publishAuthorityAccountId: '8' }],
      ['participant roster', { participantAgents: [OWNER, NEXT_OWNER] }],
    ];
    for (const [label, mutation] of integrityMutations) {
      expect(normalizeContextGraphAuthorityIndexCheckpoint({
        ...valid,
        states: [{ ...valid.states[0], ...mutation }],
      }), `${label} mutation must invalidate the unchanged integrity seal`).toBeUndefined();
    }
  });

  it.each([
    ['source above cursor', (state: typeof validState) => [{
      ...state, sourceBlockNumber: 21,
    }]],
    ['source below deployment', (state: typeof validState) => [{
      ...state, sourceBlockNumber: 9,
    }]],
    ['policy before ownership', (state: typeof validState) => [{
      ...state, ownershipEra: 1, policyVersion: 0, rosterVersion: 1,
    }]],
    ['roster before ownership', (state: typeof validState) => [{
      ...state, ownershipEra: 1, policyVersion: 1, rosterVersion: 0,
    }]],
    ['leading-zero id', (state: typeof validState) => [{
      ...state, contextGraphId: '09',
    }]],
    ['out-of-range id', (state: typeof validState) => [{
      ...state, contextGraphId: (1n << 256n).toString(10),
    }]],
    ['duplicate id', (state: typeof validState) => [state, { ...state }]],
  ] as const)('rejects self-consistent malformed checkpoint: %s', (_label, mutate) => {
    const malformed = createContextGraphAuthorityIndexCheckpoint(
      validCursor,
      mutate(validState),
    );
    expect(normalizeContextGraphAuthorityIndexCheckpoint(malformed)).toBeUndefined();
  });

  it.each([
    ['zero owner', { owner: ZERO }],
    ['malformed owner', { owner: 'bad' }],
    ['unsupported access policy', { accessPolicy: 2 }],
    ['unsupported publish policy', { publishPolicy: 2 }],
    ['curated domain without authority', {
      publishPolicy: 0, publishAuthority: null, publishAuthorityAccountId: '0',
    }],
    ['open domain with authority', {
      publishPolicy: 1, publishAuthority: AUTHORITY, publishAuthorityAccountId: '0',
    }],
    ['duplicate participants', { participantAgents: [OWNER, OWNER] }],
    ['zero participant', { participantAgents: [ZERO] }],
    ['malformed participant', { participantAgents: ['bad'] }],
    ['over-limit participants', {
      participantAgents: Array.from(
        { length: 257 },
        (_entry, index) => `0x${(index + 1).toString(16).padStart(40, '0')}`,
      ),
    }],
  ] as const)('rejects sealed malformed materialized state: %s', (_label, mutation) => {
    const malformed = createContextGraphAuthorityIndexCheckpoint(validCursor, [{
      ...validState,
      ...mutation,
    } as ContextGraphAuthorityIndexState]);
    expect(normalizeContextGraphAuthorityIndexCheckpoint(malformed)).toBeUndefined();
  });

  it.each([
    ['canonical authority', AUTHORITY, 7n, {
      publishAuthority: AUTHORITY, publishAuthorityAccountId: '7',
    }],
    ['null sentinel', null, '7', {
      publishAuthority: null, publishAuthorityAccountId: '7',
    }],
    ['zero-address sentinel', ZERO, 7n, {
      publishAuthority: null, publishAuthorityAccountId: '7',
    }],
    ['malformed authority', 'bad', 7n, undefined],
    ['u256 overflow', AUTHORITY, 1n << 256n, undefined],
  ] as const)('normalizes publish reference scalars: %s', (
    _label,
    authority,
    accountId,
    expected,
  ) => {
    expect(normalizeContextGraphAuthorityPublishReference(authority, accountId))
      .toEqual(expected);
  });

  it('decodes opaque durable reads only at the chain-owned boundary', async () => {
    const store: ContextGraphAuthorityIndexStore = {
      load: async () => ({ token: 1, value: { cursor: 'not-a-cursor', states: [] } }),
      compareAndSwap: async () => 2,
      invalidate: async () => 2,
    };
    expect(normalizeContextGraphAuthorityIndexCheckpoint((await store.load('scope'))?.value))
      .toBeUndefined();
  });

  it.each([
    ['ownership', 'ownershipEra', event('Transfer', 9n, 22, 0, {
      from: OWNER, to: NEXT_OWNER,
    })],
    ['policy', 'policyVersion', event('PublishAuthorityUpdated', 9n, 22, 0)],
    ['roster', 'rosterVersion', event('AgentParticipantAdded', 9n, 22, 0)],
  ] as const)('rejects %s counter overflow in the production state transition', (
    _label,
    field,
    transition,
  ) => {
    const initial = reduceContextGraphAuthorityIndexPage({
      deploymentBlockNumber: 10,
      throughBlockNumber: 10,
      throughBlockHash: blockHash(10),
      events: [creation(9n, 10, 1, NAME_9)],
    }).checkpoint.states[0]!;
    const overflowing = {
      ...initial,
      [field]: Number.MAX_SAFE_INTEGER,
    } as ContextGraphAuthorityIndexState;

    expect(() => applyContextGraphAuthorityStateEvent(overflowing, transition))
      .toThrow('safe integer range');
  });
});
