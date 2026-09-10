// SPDX-License-Identifier: Apache-2.0

import { ethers } from 'ethers';
import { describe, expect, it } from 'vitest';

import { loadAbi } from '../src/evm-adapter-abi.js';
import {
  CONTEXT_GRAPH_AUTHORITY_EVENT_NAMES,
  contextGraphAuthorityEventTopics,
  normalizeContextGraphAuthorityIndexLog,
} from '../src/evm-context-graph-authority-source.js';

const OWNER = `0x${'11'.repeat(20)}`;
const NEXT_OWNER = `0x${'22'.repeat(20)}`;
const AUTHORITY = `0x${'33'.repeat(20)}`;
const AGENT = `0x${'44'.repeat(20)}`;
const NAME_HASH = `0x${'55'.repeat(32)}`;
const BLOCK_HASH = `0x${'66'.repeat(32)}`;
const STORAGE = new ethers.Interface(loadAbi('ContextGraphStorage'));

function encodedLog(name: string, values: readonly unknown[], index: number): ethers.Log {
  const fragment = STORAGE.getEvent(name);
  if (fragment === null) throw new Error(`ContextGraphStorage ABI is missing ${name}`);
  const encoded = STORAGE.encodeEventLog(fragment, values);
  return {
    address: `0x${'77'.repeat(20)}`,
    blockHash: BLOCK_HASH,
    blockNumber: 123,
    data: encoded.data,
    index,
    removed: false,
    topics: encoded.topics,
    transactionHash: `0x${'88'.repeat(32)}`,
    transactionIndex: 0,
  } as ethers.Log;
}

describe('ContextGraphStorage authority ABI source', () => {
  it('derives the complete combined topic set from the shipped ABI', () => {
    expect(contextGraphAuthorityEventTopics(STORAGE)).toEqual(
      CONTEXT_GRAPH_AUTHORITY_EVENT_NAMES.map((name) => STORAGE.getEvent(name)!.topicHash),
    );
  });

  it.each([
    ['ContextGraphCreated', [
      9n, OWNER, NAME_HASH, [AGENT], 0n, 1, 0, AUTHORITY, 7n,
    ], {
      name: 'ContextGraphCreated', contextGraphId: 9n, nameHash: NAME_HASH,
    }],
    ['Transfer', [OWNER, NEXT_OWNER, 9n], {
      name: 'Transfer', contextGraphId: 9n, from: OWNER, to: NEXT_OWNER,
    }],
    ['PublishPolicyUpdated', [9n, 1, ethers.ZeroAddress, 0n], {
      name: 'PublishPolicyUpdated', contextGraphId: 9n,
    }],
    ['PublishAuthorityUpdated', [9n, AUTHORITY, 7n], {
      name: 'PublishAuthorityUpdated', contextGraphId: 9n,
    }],
    ['AgentParticipantAdded', [9n, AGENT], {
      name: 'AgentParticipantAdded', contextGraphId: 9n,
    }],
    ['AgentParticipantRemoved', [9n, AGENT], {
      name: 'AgentParticipantRemoved', contextGraphId: 9n,
    }],
  ] as const)('decodes a real %s log into the closed index event', (
    name,
    values,
    expected,
  ) => {
    expect(normalizeContextGraphAuthorityIndexLog(
      STORAGE,
      encodedLog(name, values, 4),
    )).toEqual({
      blockNumber: 123,
      blockHash: BLOCK_HASH,
      index: 4,
      ...expected,
    });
  });
});
