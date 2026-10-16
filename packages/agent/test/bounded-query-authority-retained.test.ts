import { describe, expect, it, vi } from 'vitest';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { DKGAgent } from '../src/index.js';
import { keccak256, toUtf8Bytes } from 'ethers';
import type {
  ContextGraphAuthorityReadOptions,
  ContextGraphAuthoritySnapshot,
} from '@origintrail-official/dkg-chain';
import {
  resolveFinalizedOnChainAccessPolicyState,
  type FinalizedOnChainAccessPolicyDependencies,
} from '../src/internal/context-graph-authority/finalized-context-graph-access-policy.js';

const NAME = `0x${'ab'.repeat(32)}`;
const snapshot = (patch: Partial<ContextGraphAuthoritySnapshot> = {}): ContextGraphAuthoritySnapshot => ({
  chainId: '8453', governanceContract: `0x${'11'.repeat(20)}`,
  contextGraphId: '7', owner: `0x${'22'.repeat(20)}`,
  active: true, accessPolicy: 0, publishPolicy: 0,
  publishAuthority: `0x${'22'.repeat(20)}`, publishAuthorityAccountId: '1',
  participantAgents: [], nameHash: NAME, ownershipEra: '1',
  policyVersion: '1', rosterVersion: '1', sourceBlockNumber: '100',
  sourceBlockHash: `0x${'33'.repeat(32)}`, ...patch,
});

function fixture(value: ContextGraphAuthoritySnapshot | null | undefined = snapshot()) {
  const peek = vi.fn(async (_names: readonly string[], options?: ContextGraphAuthorityReadOptions) => {
    options?.signal?.throwIfAborted();
    options?.onContextGraphAuthorityProjectionServed?.({ source: 'log', ageMs: 10 });
    return value === undefined ? undefined : new Map(value === null ? [] : [[NAME, value]]);
  });
  const readSnapshot = vi.fn(async () => ({ kind: 'snapshot' as const, snapshot: snapshot() }));
  const runForeground: FinalizedOnChainAccessPolicyDependencies['authorityReads']['runForeground'] =
    vi.fn(async (signal, read) => read(signal, {
      chainReadOptions: (readSignal: AbortSignal) => ({ signal: readSignal }),
    } as never));
  const dependencies: FinalizedOnChainAccessPolicyDependencies = {
    indexReader: {
      peekFinalizedContextGraphAuthoritySnapshotsByNameHashes: peek,
      readContextGraphAuthorityIndexSnapshots: vi.fn(async () => new Map()),
      readContextGraphAuthorityIndexRevisions: vi.fn(async () => new Map()),
      whenIdle: async () => {},
    },
    authorityReads: { runForeground }, readSnapshot, requestTimeoutMs: 2_000,
    expectedNameHash: () => NAME,
  };
  return { dependencies, peek, readSnapshot, runForeground };
}

describe('bounded scoped query authority', () => {
  it('uses a locally fenced snapshot without starting the detached index refresh', async () => {
    const f = fixture();
    const signal = new AbortController().signal;
    await expect(resolveFinalizedOnChainAccessPolicyState(f.dependencies, 7n, {
      readMode: 'finalized-index', signal,
    })).resolves.toEqual({ kind: 'available', accessPolicy: 0 });
    expect(f.peek).toHaveBeenCalledWith([NAME], expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(f.readSnapshot).not.toHaveBeenCalled();
    expect(f.runForeground).not.toHaveBeenCalled();
  });

  it.each(['miss', 'absent', 'no-name'] as const)(
    'leaves time for the existing current-state fallback on %s', async (kind) => {
      const f = fixture(kind === 'absent' ? null : snapshot());
      if (kind === 'miss') f.peek.mockResolvedValue(undefined);
      if (kind === 'no-name') f.dependencies.expectedNameHash = () => undefined;
      await expect(resolveFinalizedOnChainAccessPolicyState(f.dependencies, 7n, {
        readMode: 'finalized-index',
      })).resolves.toBeUndefined();
      expect(f.readSnapshot).not.toHaveBeenCalled();
      expect(f.runForeground).not.toHaveBeenCalled();
    },
  );

  it.each([
    { active: false },
    { contextGraphId: '8' },
    { nameHash: `0x${'cd'.repeat(32)}` },
    { accessPolicy: 9 as 0 },
  ])('fails closed on retained invalid evidence %j', async (patch) => {
    const f = fixture(snapshot(patch));
    await expect(resolveFinalizedOnChainAccessPolicyState(f.dependencies, 7n, {
      readMode: 'finalized-index',
    })).resolves.toMatchObject({ kind: 'unavailable' });
    expect(f.readSnapshot).not.toHaveBeenCalled();
  });

  it('retains the private roster and live-roster requirement', async () => {
    const participantAgents = [`0x${'44'.repeat(20)}`];
    const f = fixture(snapshot({ accessPolicy: 1, participantAgents }));
    await expect(resolveFinalizedOnChainAccessPolicyState(f.dependencies, 7n, {
      readMode: 'finalized-index',
    })).resolves.toEqual({ kind: 'available', accessPolicy: 1, participantAgents });
    await expect(resolveFinalizedOnChainAccessPolicyState(f.dependencies, 7n, {
      readMode: 'finalized-index', requireLiveRosterForPrivate: true,
    })).resolves.toBeUndefined();
  });

  it('does not use a private roster without fresh provenance', async () => {
    const f = fixture();
    f.peek.mockImplementation(async () => new Map([[NAME, snapshot({ accessPolicy: 1 })]]));
    await expect(resolveFinalizedOnChainAccessPolicyState(f.dependencies, 7n, {
      readMode: 'finalized-index',
    })).resolves.toBeUndefined();
  });

  it('does not serve a result after cancellation during the local proof', async () => {
    const f = fixture();
    const abort = new AbortController();
    f.peek.mockImplementation(async () => {
      abort.abort();
      return new Map([[NAME, snapshot()]]);
    });
    await expect(resolveFinalizedOnChainAccessPolicyState(f.dependencies, 7n, {
      readMode: 'finalized-index', signal: abort.signal,
    })).resolves.toBeUndefined();
    expect(f.readSnapshot).not.toHaveBeenCalled();
  });

  it('preserves the detached read for host and sync consumers', async () => {
    const f = fixture();
    await expect(resolveFinalizedOnChainAccessPolicyState(f.dependencies, 7n, {
      readMode: 'finalized-index-or-live',
    })).resolves.toEqual({ kind: 'available', accessPolicy: 0 });
    expect(f.readSnapshot).toHaveBeenCalledOnce();
    expect(f.peek).not.toHaveBeenCalled();
  });

  it('keeps legacy adapters without the retained capability on their existing path', async () => {
    const f = fixture();
    delete f.dependencies.indexReader!.peekFinalizedContextGraphAuthoritySnapshotsByNameHashes;
    await expect(resolveFinalizedOnChainAccessPolicyState(f.dependencies, 7n, {
      readMode: 'finalized-index',
    })).resolves.toEqual({ kind: 'available', accessPolicy: 0 });
    expect(f.readSnapshot).toHaveBeenCalledOnce();
  });
});


it('authorizes a named public query from the same atomic name-and-authority read', async () => {
  const cg = 'public-sampling-query';
  const chain = new MockChainAdapter();
  const readNumeric = vi.fn(async () => new Map([['7', snapshot({ nameHash: keccak256(toUtf8Bytes(cg)) })]]));
  const readNames = vi.fn(async (_names: readonly string[], options?: ContextGraphAuthorityReadOptions) => {
    options?.onContextGraphAuthorityProjectionServed?.({ source: 'scan', ageMs: 0 });
    return new Map([[keccak256(toUtf8Bytes(cg)), snapshot({ nameHash: keccak256(toUtf8Bytes(cg)) })]]);
  });
  Reflect.set(chain, 'contextGraphAuthorityIndexRevisionReader', {
    resolveFinalizedContextGraphAuthoritySnapshotsByNameHashes: readNames,
    readContextGraphAuthorityIndexSnapshots: readNumeric,
    readContextGraphAuthorityIndexRevisions: async () => new Map(),
    whenIdle: async () => {},
  });
  const agent = await DKGAgent.create({ name: 'BoundedNamedQuery', chainAdapter: chain });
  vi.spyOn(agent, 'peerId', 'get').mockReturnValue('bounded-query-test-peer');
  try {
    const result = await agent.query('SELECT ?s WHERE { ?s ?p ?o } LIMIT 1', {
      contextGraphId: cg, accessDenied: 'error', includeSharedMemory: false,
    });
    expect(result.bindings).toEqual([]);
    expect(readNames).toHaveBeenCalledOnce();
    expect(readNumeric).not.toHaveBeenCalled();
    readNames.mockResolvedValue(new Map([[keccak256(toUtf8Bytes(cg)),
      snapshot({ nameHash: keccak256(toUtf8Bytes(cg)), active: false })]]));
    await expect(agent.query('SELECT ?s WHERE { ?s ?p ?o } LIMIT 1', {
      contextGraphId: cg, accessDenied: 'error', includeSharedMemory: false,
    })).rejects.toThrow();
    expect(readNames).toHaveBeenCalledTimes(2);
    expect(readNumeric).not.toHaveBeenCalled();
  } finally {
    await agent.stop();
  }
});
