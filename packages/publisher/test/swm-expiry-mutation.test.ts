import { describe, expect, it, vi } from 'vitest';
import type { QueryResult, TripleStore } from '@origintrail-official/dkg-storage';
import {
  SharedMemoryExpiryMutationCoordinator,
  type SharedMemoryExpiredOperation,
  type SharedMemoryExpiryTarget,
} from '../src/swm-expiry-mutation.js';

const OPERATION = 'urn:dkg:swm-operation:expired';
const DATA_GRAPH = 'urn:dkg:swm:data';
const META_GRAPH = 'urn:dkg:swm:meta';
const ROOT_A = 'urn:dkg:entity:a';
const ROOT_B = 'urn:dkg:entity:b';
const KA_UAL = 'did:dkg:hardhat:31337/0x1111111111111111111111111111111111111111/7';
const ASSERTION_GRAPH = 'urn:dkg:assertion:7';
const SNAPSHOT_GRAPH = 'urn:dkg:snapshot:7';

const target: SharedMemoryExpiryTarget = {
  contextGraphId: 'test-cg',
  subGraphName: 'claims',
  dataGraph: DATA_GRAPH,
  metaGraph: META_GRAPH,
  ownershipKey: 'test-cg\0claims',
};

function makeStore(results: QueryResult[], graphs: string[] = []) {
  const query = vi.fn(async () => {
    const result = results.shift();
    if (!result) throw new Error('Unexpected query');
    return result;
  });
  const deleteByPattern = vi.fn(async () => 1);
  const deleteBySubjectPrefix = vi.fn(async () => 1);
  const dropGraph = vi.fn(async () => {});
  const listGraphsByPrefix = vi.fn(async () => graphs);
  const store = {
    query,
    deleteByPattern,
    deleteBySubjectPrefix,
    dropGraph,
    listGraphsByPrefix,
  } as unknown as TripleStore;
  return { store, query, deleteByPattern, deleteBySubjectPrefix, dropGraph, listGraphsByPrefix };
}

function coordinator(
  store: TripleStore,
  ownedEntities = new Map<string, Map<string, string>>(),
  writeLocks = new Map<string, Promise<void>>(),
) {
  return new SharedMemoryExpiryMutationCoordinator({ store, ownedEntities, writeLocks });
}

describe('SharedMemoryExpiryMutationCoordinator', () => {
  it('rejects closed and unsafe candidates before touching the store or lock map', async () => {
    const harness = makeStore([]);
    const writeLocks = new Map<string, Promise<void>>();
    const expiry = coordinator(harness.store, new Map(), writeLocks);
    const legacy: SharedMemoryExpiredOperation = {
      uri: OPERATION,
      roots: [ROOT_A],
      scope: { kind: 'legacy' },
    };

    await expect(expiry.expire({ target, candidate: legacy, cutoff: '2026-01-01T00:00:00.000Z', isClosed: () => true }))
      .resolves.toBeUndefined();
    await expect(expiry.expire({
      target,
      candidate: { ...legacy, uri: 'urn:dkg:unsafe iri' },
      cutoff: '2026-01-01T00:00:00.000Z',
      isClosed: () => false,
    })).resolves.toBeUndefined();

    expect(harness.query).not.toHaveBeenCalled();
    expect(writeLocks.size).toBe(0);
  });

  it('revalidates the operation under its write locks and ignores a stale candidate', async () => {
    const harness = makeStore([{
      type: 'bindings',
      bindings: [{ op: OPERATION, re: ROOT_B }],
    }]);
    const writeLocks = new Map<string, Promise<void>>();
    const expiry = coordinator(harness.store, new Map(), writeLocks);

    await expect(expiry.expire({
      target,
      candidate: { uri: OPERATION, roots: [ROOT_A], scope: { kind: 'legacy' } },
      cutoff: '2026-01-01T00:00:00.000Z',
      isClosed: () => false,
    })).resolves.toBeUndefined();

    expect(harness.query).toHaveBeenCalledOnce();
    expect(harness.query.mock.calls[0]?.[0]).toContain(`VALUES ?op { <${OPERATION}> }`);
    expect(harness.deleteByPattern).not.toHaveBeenCalled();
    expect(writeLocks.size).toBe(0);
  });

  it('ignores a candidate when revalidation no longer returns a binding result', async () => {
    const harness = makeStore([{ type: 'boolean', value: false }]);
    const expiry = coordinator(harness.store);

    await expect(expiry.expire({
      target,
      candidate: { uri: OPERATION, roots: [], scope: { kind: 'legacy' } },
      cutoff: '2026-01-01T00:00:00.000Z',
      isClosed: () => false,
    })).resolves.toBeUndefined();
    expect(harness.listGraphsByPrefix).not.toHaveBeenCalled();
  });

  it('stops after revalidation when shutdown closes the mutation boundary', async () => {
    const harness = makeStore([{
      type: 'bindings',
      bindings: [{ op: OPERATION, re: ROOT_A }],
    }]);
    const isClosed = vi.fn()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);

    await expect(coordinator(harness.store).expire({
      target,
      candidate: { uri: OPERATION, roots: [ROOT_A], scope: { kind: 'legacy' } },
      cutoff: '2026-01-01T00:00:00.000Z',
      isClosed,
    })).resolves.toBeUndefined();
    expect(harness.listGraphsByPrefix).not.toHaveBeenCalled();
    expect(harness.deleteByPattern).not.toHaveBeenCalled();
  });

  it('deletes legacy roots from the complete graph family and evicts ownership cache entries', async () => {
    const harness = makeStore([
      {
        type: 'bindings',
        bindings: [
          { op: OPERATION, re: ROOT_A },
          { op: OPERATION, re: ROOT_A },
          { op: OPERATION, re: ROOT_B },
          { re: 'urn:dkg:ignored-without-operation' },
        ],
      },
      { type: 'boolean', value: false },
    ], [
      `${DATA_GRAPH}/child`,
      `${DATA_GRAPH}/staging/incomplete`,
    ]);
    const owned = new Map([[target.ownershipKey, new Map([
      [ROOT_A, OPERATION],
      [ROOT_B, OPERATION],
      ['urn:dkg:entity:retained', 'urn:dkg:other-operation'],
    ])]]);
    const writeLocks = new Map<string, Promise<void>>();

    await expect(coordinator(harness.store, owned, writeLocks).expire({
      target,
      candidate: { uri: OPERATION, roots: [ROOT_B, ROOT_A], scope: { kind: 'legacy' } },
      cutoff: '2026-01-01T00:00:00.000Z',
      isClosed: () => false,
    })).resolves.toEqual({ triplesDeleted: 11, operationRemoved: true });

    expect(harness.listGraphsByPrefix).toHaveBeenCalledWith(`${DATA_GRAPH}/`, undefined);
    expect(harness.deleteByPattern).toHaveBeenCalledWith({ graph: DATA_GRAPH, subject: ROOT_A });
    expect(harness.deleteByPattern).toHaveBeenCalledWith({ graph: `${DATA_GRAPH}/child`, subject: ROOT_B });
    expect(harness.deleteBySubjectPrefix).toHaveBeenCalledWith(
      DATA_GRAPH,
      `${ROOT_A}/.well-known/genid/`,
    );
    expect(harness.deleteByPattern).toHaveBeenCalledWith({ graph: META_GRAPH, subject: OPERATION });
    expect(harness.query.mock.calls[1]?.[0]).toContain(`ASK { GRAPH <${META_GRAPH}>`);
    expect(owned.get(target.ownershipKey)?.has(ROOT_A)).toBe(false);
    expect(owned.get(target.ownershipKey)?.has(ROOT_B)).toBe(false);
    expect(owned.get(target.ownershipKey)?.has('urn:dkg:entity:retained')).toBe(true);
    expect(writeLocks.size).toBe(0);
  });

  it('deletes graph-scoped assertion, head, and snapshot graphs only for the current head owner', async () => {
    const harness = makeStore([
      {
        type: 'bindings',
        bindings: [{
          op: OPERATION,
          re: ROOT_A,
          scopeVersion: '"2"^^<http://www.w3.org/2001/XMLSchema#integer>',
          kaUal: KA_UAL,
          snapshotGraph: SNAPSHOT_GRAPH,
        }],
      },
      { type: 'bindings', bindings: [{ assertionGraph: ASSERTION_GRAPH }] },
      { type: 'boolean', value: false },
    ]);
    const owned = new Map([[target.ownershipKey, new Map([[ROOT_A, OPERATION]])]]);
    const candidate: SharedMemoryExpiredOperation = {
      uri: OPERATION,
      roots: [ROOT_A],
      scope: { kind: 'graph-v2', kaUal: KA_UAL, snapshotGraph: SNAPSHOT_GRAPH },
    };

    await expect(coordinator(harness.store, owned).expire({
      target,
      candidate,
      cutoff: '2026-01-01T00:00:00.000Z',
      isClosed: () => false,
    })).resolves.toEqual({ triplesDeleted: 7, operationRemoved: true });

    const head = `${KA_UAL}#dkg-swm-head`;
    expect(harness.query.mock.calls[1]?.[0]).toContain(`<${head}>`);
    expect(harness.deleteByPattern).toHaveBeenCalledWith({ graph: ASSERTION_GRAPH });
    expect(harness.deleteByPattern).toHaveBeenCalledWith({ graph: META_GRAPH, subject: head });
    expect(harness.deleteByPattern).toHaveBeenCalledWith({ graph: SNAPSHOT_GRAPH });
    expect(harness.dropGraph).toHaveBeenNthCalledWith(1, ASSERTION_GRAPH);
    expect(harness.dropGraph).toHaveBeenNthCalledWith(2, SNAPSHOT_GRAPH);
    expect(owned.get(target.ownershipKey)?.has(ROOT_A)).toBe(false);
  });

  it('keeps a graph-scoped live head when another operation owns it', async () => {
    const harness = makeStore([
      {
        type: 'bindings',
        bindings: [{
          op: OPERATION,
          scopeVersion: '"2"',
          kaUal: KA_UAL,
          snapshotGraph: 'urn:dkg:unsafe snapshot graph',
        }],
      },
      { type: 'bindings', bindings: [] },
      { type: 'boolean', value: true },
    ]);

    await expect(coordinator(harness.store).expire({
      target,
      candidate: {
        uri: OPERATION,
        roots: [],
        scope: {
          kind: 'graph-v2',
          kaUal: KA_UAL,
          snapshotGraph: 'urn:dkg:unsafe snapshot graph',
        },
      },
      cutoff: '2026-01-01T00:00:00.000Z',
      isClosed: () => false,
    })).resolves.toEqual({ triplesDeleted: 1, operationRemoved: false });

    expect(harness.dropGraph).not.toHaveBeenCalled();
    expect(harness.deleteByPattern).toHaveBeenCalledTimes(1);
    expect(harness.deleteByPattern).toHaveBeenCalledWith({ graph: META_GRAPH, subject: OPERATION });
  });
});
