// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';

import {
  normalizeContextGraphAuthorityIndexCheckpoint,
  reduceContextGraphAuthorityIndexPage,
  type ContextGraphAuthorityIndexCheckpoint,
  type ContextGraphAuthorityIndexEvent,
} from '../src/context-graph-authority-index.js';

const ZERO = `0x${'0'.repeat(40)}`;
const OWNER = `0x${'11'.repeat(20)}`;
const NEXT_OWNER = `0x${'22'.repeat(20)}`;
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
  return {
    name,
    contextGraphId,
    blockNumber,
    blockHash: blockHash(blockNumber),
    index,
    ...extra,
  } as ContextGraphAuthorityIndexEvent;
}

function creation(
  contextGraphId: bigint,
  blockNumber: number,
  index: number,
  nameHash: string,
): ContextGraphAuthorityIndexEvent {
  return event('ContextGraphCreated', contextGraphId, blockNumber, index, { nameHash });
}

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
      stateCount: 2,
    });
    expect(result.checkpoint.states).toEqual([
      {
        contextGraphId: '9',
        nameHash: NAME_9,
        ownershipEra: 1,
        policyVersion: 2,
        rosterVersion: 3,
        sourceBlockNumber: 12,
        sourceBlockHash: blockHash(12),
      },
      {
        contextGraphId: '10',
        nameHash: NAME_10,
        ownershipEra: 0,
        policyVersion: 0,
        rosterVersion: 0,
        sourceBlockNumber: 11,
        sourceBlockHash: blockHash(11),
      },
    ]);
    expect(result.changedStates).toEqual(result.checkpoint.states);
    expect(Object.isFrozen(result.checkpoint)).toBe(true);
    expect(Object.isFrozen(result.checkpoint.states)).toBe(true);
    expect(result.checkpoint.states.every(Object.isFrozen)).toBe(true);
  });

  it('reduces an exactly contiguous suffix and emits only changed replacement rows', () => {
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
    expect(suffix.changedStates).toEqual([expect.objectContaining({
      contextGraphId: '10',
      policyVersion: 1,
      sourceBlockNumber: 22,
    })]);
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
    expect(emptySuffix.changedStates).toEqual([]);
    expect(emptySuffix.checkpoint.cursor.stateCount).toBe(2);
  });

  it('ignores mint, burn, and self-transfer logs', () => {
    const result = reduceContextGraphAuthorityIndexPage({
      deploymentBlockNumber: 10,
      throughBlockNumber: 15,
      throughBlockHash: blockHash(15),
      events: [
        event('Transfer', 9n, 10, 0, { from: ZERO, to: OWNER }),
        creation(9n, 10, 1, NAME_9),
        event('Transfer', 9n, 11, 0, { from: OWNER, to: OWNER }),
        event('Transfer', 9n, 12, 0, { from: OWNER, to: ZERO }),
      ],
    });
    expect(result.checkpoint.states[0]).toMatchObject({
      ownershipEra: 0,
      policyVersion: 0,
      rosterVersion: 0,
      sourceBlockNumber: 10,
    });
  });

  it('fails closed on gaps, overlaps, deployment changes, and malformed prior state', () => {
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
    expect(() => reduceContextGraphAuthorityIndexPage({
      deploymentBlockNumber: 10,
      throughBlockNumber: 25,
      throughBlockHash: blockHash(25),
      previous: {
        ...first.checkpoint,
        cursor: { ...first.checkpoint.cursor, stateCount: 2 },
      },
      events: [],
    })).toThrow('previous checkpoint is malformed');
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

  it('normalizes durable checkpoints and rejects count, id, hash, and source corruption', () => {
    const valid = reduceContextGraphAuthorityIndexPage({
      deploymentBlockNumber: 10,
      throughBlockNumber: 20,
      throughBlockHash: blockHash(20).toUpperCase().replace('0X', '0x'),
      events: [creation(9n, 10, 1, NAME_9.toUpperCase().replace('0X', '0x'))],
    }).checkpoint;
    expect(normalizeContextGraphAuthorityIndexCheckpoint(valid)).toEqual(valid);
    expect(normalizeContextGraphAuthorityIndexCheckpoint({
      ...valid,
      cursor: { ...valid.cursor, stateCount: 2 },
    })).toBeUndefined();
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
  });

  it('rejects counter overflow before a checkpoint can be emitted', () => {
    const previous: ContextGraphAuthorityIndexCheckpoint = {
      cursor: {
        deploymentBlockNumber: 10,
        throughBlockNumber: 20,
        throughBlockHash: blockHash(20),
        stateCount: 1,
      },
      states: [{
        contextGraphId: '9',
        nameHash: NAME_9,
        ownershipEra: 0,
        policyVersion: Number.MAX_SAFE_INTEGER,
        rosterVersion: 0,
        sourceBlockNumber: 10,
        sourceBlockHash: blockHash(10),
      }],
    };
    expect(() => reduceContextGraphAuthorityIndexPage({
      deploymentBlockNumber: 10,
      throughBlockNumber: 25,
      throughBlockHash: blockHash(25),
      previous,
      events: [event('PublishPolicyUpdated', 9n, 22, 0)],
    })).toThrow('safe integer range');
  });
});
