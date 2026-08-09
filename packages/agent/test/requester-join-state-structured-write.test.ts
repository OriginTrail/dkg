import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import type { Quad, TripleStore } from '@origintrail-official/dkg-storage';
import {
  JoinRequestMethods,
  type RequesterJoinRequestState,
} from '../src/dkg-agent-join.js';

const GRAPH = 'urn:dkg:local:requester-join-state';
const STATUS = 'urn:dkg:local:requester-join-state:status';
const GENERATION = 'urn:dkg:local:requester-join-state:generation';
const CURATOR = 'urn:dkg:local:requester-join-state:curator-peer-id';

describe('requester join-state structured persistence', () => {
  it('uses the atomic subject capability without reaching raw update()', async () => {
    const replaceSubject = vi.fn(async () => undefined);
    const update = vi.fn(async () => {
      throw new Error('raw update channel reached');
    });
    const flush = vi.fn(async () => undefined);
    const store = {
      replaceSubject,
      update,
      flush,
    } as unknown as TripleStore;
    const cache = new Map<string, RequesterJoinRequestState>();
    const contextGraphId = 'private/structured-state';
    const agentAddress = '0x1234567890123456789012345678901234567890';
    const state: RequesterJoinRequestState = {
      status: 'pending',
      requestGeneration: `0x${'ab'.repeat(32)}`,
      curatorPeerId: '12D3KooWCurator"Quoted',
    };

    await JoinRequestMethods.prototype.writeRequesterJoinRequestState.call(
      {
        store,
        requesterJoinStateCache: () => cache,
      } as never,
      contextGraphId,
      agentAddress,
      state,
    );

    const subject = `urn:dkg:local:requester-join-state:${createHash('sha256')
      .update(`${contextGraphId}\0${agentAddress.toLowerCase()}`)
      .digest('hex')}`;
    const expected: Quad[] = [{
      graph: GRAPH,
      subject,
      predicate: STATUS,
      object: '"pending"',
    }, {
      graph: GRAPH,
      subject,
      predicate: GENERATION,
      object: `"${state.requestGeneration}"`,
    }, {
      graph: GRAPH,
      subject,
      predicate: CURATOR,
      object: '"12D3KooWCurator\\"Quoted"',
    }];

    expect(replaceSubject).toHaveBeenCalledWith(GRAPH, subject, expected, {});
    expect(update).not.toHaveBeenCalled();
    expect(flush).toHaveBeenCalledTimes(1);
    expect(cache.get(`${contextGraphId}\0${agentAddress.toLowerCase()}`)).toBe(state);
  });
});
