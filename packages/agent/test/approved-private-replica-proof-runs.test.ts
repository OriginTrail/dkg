// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  APPROVED_PRIVATE_REPLICA_PROOF_MAX_RUNS,
  resolveApprovedPrivateReplicaAuthorityWithinRuns,
  type ApprovedPrivateReplicaProofRerunCause,
} from '../src/approved-private-replica-proof-runs.js';
import { BoundedOperationTimeoutError } from '../src/bounded-operation.js';
import type { DKGAgent } from '../src/dkg-agent.js';

const CONTEXT_GRAPH_ID = 'members-only';
const MEMBER = `0x${'11'.repeat(20)}`;
const OWNER = `0x${'22'.repeat(20)}`;
const CURATOR_PEER = 'curator-peer';
const GENERATION = `0x${'12'.repeat(32)}`;
const NEXT_GENERATION = `0x${'34'.repeat(32)}`;
const TIME_LIMIT_MS = 1_000;

type Read = 'request' | 'meta' | 'registration' | 'proof';
type DuringRead = (signal: AbortSignal | undefined) => unknown;

const approvedRequest = (requestGeneration = GENERATION) => ({
  status: 'approved' as 'approved' | 'pending' | 'rejected',
  requestGeneration,
  curatorPeerId: CURATOR_PEER,
  curatorAgentAddress: OWNER,
  curatorAuthorityEra: '0',
});

/**
 * A replica whose local reads all prove the approved member, as a double of the
 * agent surface the proof reads. `during` holds, per kind of read, what happens
 * while the next read of that kind is in flight.
 */
function replica() {
  const state = {
    revision: 0,
    approved: true,
    request: approvedRequest() as ReturnType<typeof approvedRequest> | null,
    registration: 'unregistered' as 'registered' | 'unregistered' | 'pending' | null,
    accessPolicy: 'private',
    proofRows: [{}] as Array<Record<string, string>>,
  };
  const during: Record<Read, DuringRead[]> = { request: [], meta: [], registration: [], proof: [] };
  const reads: Record<Read, number> = { request: 0, meta: 0, registration: 0, proof: 0 };
  const read = async (kind: Read, signal?: AbortSignal) => {
    reads[kind] += 1;
    await during[kind].shift()?.(signal);
  };
  const agent = {
    peerId: 'local-peer',
    listLocalAgents: () => [{ agentAddress: MEMBER }],
    readRequesterJoinRequestState: async () => {
      await read('request');
      return state.request;
    },
    getOwnCgMetaFacts: async (_id: string, options: { signal?: AbortSignal }) => {
      await read('meta', options.signal);
      return {
        accessPolicy: state.accessPolicy,
        curators: [`did:dkg:agent:${OWNER}`],
        creators: [`did:dkg:agent:${CURATOR_PEER}`],
        allowedPeers: [],
      };
    },
    readLocalContextGraphRegistrationStatus: async () => {
      await read('registration');
      return state.registration;
    },
    store: {
      query: async (_sparql: string, options: { signal?: AbortSignal }) => {
        await read('proof', options.signal);
        return { type: 'bindings' as const, bindings: state.proofRows };
      },
    },
  } as unknown as DKGAgent;
  const reruns: Array<[ApprovedPrivateReplicaProofRerunCause, number]> = [];
  const resolve = (options: {
    signal?: AbortSignal;
    approvalStillHolds?: () => boolean;
    onRerun?: (cause: ApprovedPrivateReplicaProofRerunCause, run: number) => void;
  } = {}) => resolveApprovedPrivateReplicaAuthorityWithinRuns(agent, CONTEXT_GRAPH_ID, MEMBER, {
    approvalStillHolds: options.approvalStillHolds ?? (() => state.approved),
    readMetadataRevision: () => String(state.revision),
  }, {
    timeoutMs: TIME_LIMIT_MS,
    signal: options.signal,
    onRerun: (cause, run) => {
      reruns.push([cause, run]);
      options.onRerun?.(cause, run);
    },
  });
  /** An unrelated write to the graph's own metadata lands while the read is in flight. */
  const moveRevision = () => { state.revision += 1; };
  /** A store read that does not answer. */
  const hang = () => new Promise<never>(() => undefined);
  return { state, during, reads, reruns, resolve, moveRevision, hang };
}

const proved = {
  kind: 'proved',
  resolution: {
    kind: 'unregistered-private-replica',
    authority: { approvedAgentAddress: MEMBER, ownerAddress: OWNER, requestGeneration: GENERATION },
  },
};

afterEach(() => {
  vi.useRealTimers();
});

describe('approved member proof runs', () => {
  it('proves on the first run without another one', async () => {
    const node = replica();

    await expect(node.resolve()).resolves.toMatchObject(proved);
    expect(node.reads.proof).toBe(1);
    expect(node.reruns).toEqual([]);
  });

  it('runs again when only the metadata revision moved under a complete proof', async () => {
    const node = replica();
    node.during.proof.push(node.moveRevision);

    await expect(node.resolve()).resolves.toMatchObject(proved);
    expect(node.reads.proof).toBe(2);
    expect(node.reruns).toEqual([['metadata-moved', 2]]);
  });

  it('stops after the last permitted run while the metadata keeps moving', async () => {
    const node = replica();
    node.during.proof.push(node.moveRevision, node.moveRevision, node.moveRevision, node.moveRevision);

    await expect(node.resolve()).resolves.toEqual({ kind: 'metadata-moved' });
    expect(node.reads.proof).toBe(APPROVED_PRIVATE_REPLICA_PROOF_MAX_RUNS);
    expect(node.reruns).toEqual([['metadata-moved', 2], ['metadata-moved', 3]]);
  });

  it('runs again after a run that outlasted its time limit', async () => {
    vi.useFakeTimers();
    const node = replica();
    node.during.proof.push(node.hang);

    const result = node.resolve();
    await vi.advanceTimersByTimeAsync(TIME_LIMIT_MS);

    await expect(result).resolves.toMatchObject(proved);
    expect(node.reads.proof).toBe(2);
    expect(node.reruns).toEqual([['timeout', 2]]);
  });

  it('gives each run its own time limit and rethrows the last one', async () => {
    vi.useFakeTimers();
    const node = replica();
    node.during.proof.push(node.hang, node.hang, node.hang, node.hang);

    const result = node.resolve();
    const refused = expect(result).rejects.toEqual(new BoundedOperationTimeoutError(
      `resolveApprovedPrivateReplicaAuthority(${CONTEXT_GRAPH_ID})`,
      TIME_LIMIT_MS,
    ));
    await vi.advanceTimersByTimeAsync(TIME_LIMIT_MS * 2);
    expect(node.reads.proof).toBe(3);
    await vi.advanceTimersByTimeAsync(TIME_LIMIT_MS);

    await refused;
    expect(node.reads.proof).toBe(APPROVED_PRIVATE_REPLICA_PROOF_MAX_RUNS);
    expect(node.reruns).toEqual([['timeout', 2], ['timeout', 3]]);
  });

  it('recovers across both causes within the permitted runs', async () => {
    vi.useFakeTimers();
    const node = replica();
    node.during.proof.push(node.hang, node.moveRevision);

    const result = node.resolve();
    await vi.advanceTimersByTimeAsync(TIME_LIMIT_MS);

    await expect(result).resolves.toMatchObject(proved);
    expect(node.reruns).toEqual([['timeout', 2], ['metadata-moved', 3]]);
  });

  it('is not disturbed by a timed-out run that answers late', async () => {
    vi.useFakeTimers();
    const node = replica();
    let answerLate!: () => void;
    node.during.proof.push(() => new Promise<void>((resolve) => { answerLate = resolve; }));

    const result = node.resolve();
    await vi.advanceTimersByTimeAsync(TIME_LIMIT_MS);
    await expect(result).resolves.toMatchObject(proved);

    // The abandoned run finishes its own reads against a revision that has
    // moved since: it reports to its own run only.
    node.moveRevision();
    answerLate();
    await vi.advanceTimersByTimeAsync(0);
    expect(node.reruns).toEqual([['timeout', 2]]);
  });
});

describe('approved member proof runs end as a single run does', () => {
  it('ends when the approval is removed while a run reads', async () => {
    const node = replica();
    node.during.proof.push(() => {
      node.state.approved = false;
      node.moveRevision();
    });

    await expect(node.resolve()).resolves.toEqual({ kind: 'absent' });
    expect(node.reads.proof).toBe(1);
    expect(node.reruns).toEqual([]);
  });

  it('does not run again once the approval is gone', async () => {
    const node = replica();
    node.during.proof.push(node.moveRevision);
    // The run's own final check still sees the approval; the check before the
    // next run does not.
    const approvalStillHolds = vi.fn<() => boolean>()
      .mockReturnValueOnce(true)
      .mockReturnValue(false);

    await expect(node.resolve({ approvalStillHolds })).resolves.toEqual({ kind: 'metadata-moved' });
    expect(approvalStillHolds).toHaveBeenCalledTimes(2);
    expect(node.reads.proof).toBe(1);
    expect(node.reruns).toEqual([]);
  });

  it('rethrows a time limit instead of running again once the approval is gone', async () => {
    vi.useFakeTimers();
    const node = replica();
    node.during.proof.push(() => {
      node.state.approved = false;
      return node.hang();
    });

    const result = node.resolve();
    const refused = expect(result).rejects.toBeInstanceOf(BoundedOperationTimeoutError);
    await vi.advanceTimersByTimeAsync(TIME_LIMIT_MS);

    await refused;
    expect(node.reads.proof).toBe(1);
    expect(node.reruns).toEqual([]);
  });

  it('ends when the request generation is replaced while a run reads', async () => {
    const node = replica();
    node.during.proof.push(() => {
      node.state.request = approvedRequest(NEXT_GENERATION);
      node.moveRevision();
    });

    await expect(node.resolve()).resolves.toEqual({ kind: 'absent' });
    expect(node.reads.proof).toBe(1);
    expect(node.reruns).toEqual([]);
  });

  it('holds a further run to the generation the first one read', async () => {
    const node = replica();
    node.during.proof.push(node.moveRevision);

    // A request of another generation is approved between the two runs. On its
    // own it would prove; this decision started from the earlier one.
    await expect(node.resolve({
      onRerun: () => { node.state.request = approvedRequest(NEXT_GENERATION); },
    })).resolves.toEqual({ kind: 'absent' });
    expect(node.reruns).toEqual([['metadata-moved', 2]]);
    // The second run ended at its first read.
    expect(node.reads).toMatchObject({ meta: 1, proof: 1 });
  });

  it('holds a run after a time limit to the generation the timed-out run read', async () => {
    vi.useFakeTimers();
    const node = replica();
    node.during.proof.push(node.hang);

    const result = node.resolve({
      onRerun: () => { node.state.request = approvedRequest(NEXT_GENERATION); },
    });
    await vi.advanceTimersByTimeAsync(TIME_LIMIT_MS);

    await expect(result).resolves.toEqual({ kind: 'absent' });
    expect(node.reruns).toEqual([['timeout', 2]]);
    expect(node.reads).toMatchObject({ meta: 1, proof: 1 });
  });

  it.each([
    {
      refusal: 'the registration is pending',
      arrange: (node: ReturnType<typeof replica>) => {
        node.state.registration = 'pending';
        node.during.meta.push(node.moveRevision);
      },
    },
    {
      refusal: 'a registration starts while the run reads',
      arrange: (node: ReturnType<typeof replica>) => {
        node.during.proof.push(() => {
          node.state.registration = 'pending';
          node.moveRevision();
        });
      },
    },
    {
      refusal: 'the graph does not declare itself private',
      arrange: (node: ReturnType<typeof replica>) => {
        node.state.accessPolicy = 'public';
        node.during.meta.push(node.moveRevision);
      },
    },
    {
      refusal: 'the member proof has no row',
      arrange: (node: ReturnType<typeof replica>) => {
        node.state.proofRows = [];
        node.during.proof.push(node.moveRevision);
      },
    },
    {
      refusal: 'the request is rejected while the run reads',
      arrange: (node: ReturnType<typeof replica>) => {
        node.during.proof.push(() => {
          node.state.request = { ...approvedRequest(), status: 'rejected' };
          node.moveRevision();
        });
      },
    },
    {
      refusal: 'there is no request state',
      arrange: (node: ReturnType<typeof replica>) => {
        node.state.request = null;
        node.during.request.push(node.moveRevision);
      },
    },
  ])('does not run again when $refusal, although the revision moved', async ({ arrange }) => {
    const node = replica();
    arrange(node);

    await expect(node.resolve()).resolves.toEqual({ kind: 'absent' });
    expect(node.reads.proof).toBeLessThanOrEqual(1);
    expect(node.reruns).toEqual([]);
  });

  it('does not run again after a read that failed', async () => {
    const node = replica();
    const failure = new Error('store read failed');
    node.during.proof.push(() => {
      node.moveRevision();
      throw failure;
    });

    await expect(node.resolve()).rejects.toBe(failure);
    expect(node.reads.proof).toBe(1);
    expect(node.reruns).toEqual([]);
  });
});

describe('approved member proof runs under the caller signal', () => {
  it('does not start when the caller is already aborted', async () => {
    const node = replica();
    const controller = new AbortController();
    controller.abort(new Error('caller stopped'));

    await expect(node.resolve({ signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError', message: 'caller stopped' });
    expect(node.reads.request).toBe(0);
  });

  it('ends with the abort when the caller stops during a run', async () => {
    const node = replica();
    const controller = new AbortController();
    node.during.proof.push(() => {
      controller.abort(new Error('caller stopped'));
      return node.hang();
    });

    await expect(node.resolve({ signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError', message: 'caller stopped' });
    expect(node.reads.proof).toBe(1);
    expect(node.reruns).toEqual([]);
  });

  it('starts no further run once the caller has stopped', async () => {
    const node = replica();
    const controller = new AbortController();
    node.during.proof.push(node.moveRevision);

    // The caller's deadline passes between two runs.
    await expect(node.resolve({
      signal: controller.signal,
      onRerun: () => controller.abort(new Error('caller deadline')),
    })).rejects.toMatchObject({ name: 'AbortError', message: 'caller deadline' });
    expect(node.reads.proof).toBe(1);
    expect(node.reads.request).toBe(2);
  });
});
