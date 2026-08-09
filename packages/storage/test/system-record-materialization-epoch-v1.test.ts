import { beforeEach, describe, expect, it } from 'vitest';

import { OwnedManagedHttpClient } from '../src/adapters/managed-http-client.js';
import {
  createManagedOxigraphOwnershipControllerV1,
  type ManagedOxigraphOwnershipControllerV1,
} from '../src/internal/managed-oxigraph-ownership-v1.js';
import { rotateSystemRecordMaterializationEpochV1 } from '../src/system-record-materialization-epoch-v1-internal.js';
import { snapshotSystemRecordMaterializationEpochRotationV1 } from '../src/system-record-materialization-epoch-guard-v1-internal.js';
import type { SystemRecordMaterializationEpochRotationV1 } from '../src/system-record-materialization-epoch-contract-v1.js';

const QUERY_ENDPOINT = 'http://127.0.0.1:7878/query';
const UPDATE_ENDPOINT = 'http://127.0.0.1:7878/update';

const select = (values: readonly unknown[]): string => JSON.stringify({
  head: { vars: ['epoch'] },
  results: {
    bindings: values.map((value) => ({
      epoch: typeof value === 'object' ? value : { type: 'literal', value },
    })),
  },
});

class FakeOwnedClient {
  readonly childGeneration = '1';
  readonly calls: Array<{ url: string; contentType: string; body: string }> = [];
  values: unknown[] = [];
  updateMode: 'commit' | 'no-commit' | 'throw-after-commit' | 'cas-miss' = 'commit';
  afterUpdate?: () => void;
  malformedResponse: string | null = null;

  async post(url: string, contentType: string, body: string): Promise<{ status: number; body: string }> {
    this.calls.push({ url, contentType, body });
    if (url === QUERY_ENDPOINT) {
      const response = this.malformedResponse ?? select(this.values);
      this.malformedResponse = null;
      return { status: 200, body: response };
    }

    const inserted = /INSERT[\s\S]*?materialization-epoch> "([0-9]+)"/u.exec(body)?.[1];
    if (inserted === undefined) throw new Error('test update did not contain an inserted epoch');
    if (this.updateMode === 'commit' || this.updateMode === 'throw-after-commit') {
      this.values = [inserted];
    } else if (this.updateMode === 'cas-miss') {
      this.values = ['99'];
    }
    this.afterUpdate?.();
    if (this.updateMode === 'throw-after-commit') throw new Error('response lost');
    return { status: 204, body: '' };
  }
}

describe('system-record materialization epoch V1', () => {
  let ownership: ManagedOxigraphOwnershipControllerV1;
  let client: FakeOwnedClient;

  const rotate = (networkId = 'testnet') => rotateSystemRecordMaterializationEpochV1({
    networkId,
    lease: ownership.lease,
    client: client as unknown as OwnedManagedHttpClient,
    queryEndpoint: QUERY_ENDPOINT,
    updateEndpoint: UPDATE_ENDPOINT,
  });

  beforeEach(() => {
    ownership = createManagedOxigraphOwnershipControllerV1(QUERY_ENDPOINT, UPDATE_ENDPOINT);
    ownership.bindReadyGeneration();
    client = new FakeOwnedClient();
  });

  it('creates epoch 1 with an exact LIMIT 2 read and one conditional Modify', async () => {
    await expect(rotate()).resolves.toEqual({ epoch: '1', childGeneration: '1' });
    expect(client.calls).toHaveLength(3);
    expect(client.calls[0]?.body).toMatch(/SELECT \?epoch[\s\S]*LIMIT 2$/);
    expect(client.calls[1]?.body).toMatch(/^INSERT \{/);
    expect(client.calls[1]?.body).toContain('FILTER NOT EXISTS');
    expect(client.calls[1]?.body).not.toContain(';');
    expect(client.calls[2]?.body).toBe(client.calls[0]?.body);
  });

  it('increments an existing singleton with one exact conditional DELETE/INSERT/WHERE', async () => {
    client.values = ['41'];
    await expect(rotate()).resolves.toEqual({ epoch: '42', childGeneration: '1' });
    const update = client.calls[1]?.body ?? '';
    expect(update.match(/DELETE/g)).toHaveLength(1);
    expect(update.match(/INSERT/g)).toHaveLength(1);
    expect(update).toContain('"41"');
    expect(update).toContain('"42"');
    expect(update).not.toContain(';');
  });

  it('resolves a lost update response from the bounded post-read', async () => {
    client.values = ['8'];
    client.updateMode = 'throw-after-commit';
    await expect(rotate()).resolves.toEqual({ epoch: '9', childGeneration: '1' });
    expect(client.calls).toHaveLength(3);
  });

  it('fails closed when the conditional update leaves the epoch unchanged', async () => {
    client.values = ['8'];
    client.updateMode = 'no-commit';
    await expect(rotate()).rejects.toThrow(/did not commit the expected value 9/);
  });

  it('fails closed on a competing value after a CAS miss', async () => {
    client.values = ['8'];
    client.updateMode = 'cas-miss';
    await expect(rotate()).rejects.toThrow(/did not commit the expected value 9/);
  });

  it.each([
    [['1', '1'], /multiple persisted values/],
    [['01'], /canonical decimal u64/],
    [[{ type: 'uri', value: '1' }], /plain literal/],
    [['18446744073709551616'], /exceeds u64/],
  ] as const)('rejects malformed or extra persisted epoch state', async (values, error) => {
    client.values = [...values];
    await expect(rotate()).rejects.toThrow(error);
    expect(client.calls).toHaveLength(1);
  });

  it('refuses to rotate past max-u64 before issuing an update', async () => {
    client.values = ['18446744073709551615'];
    await expect(rotate()).rejects.toThrow(/cannot advance beyond u64/);
    expect(client.calls).toHaveLength(1);
  });

  it('rejects a malformed SELECT envelope', async () => {
    client.malformedResponse = JSON.stringify({ head: { vars: ['epoch'] }, results: { bindings: [] }, extra: true });
    await expect(rotate()).rejects.toThrow(/unknown or missing fields/);
  });

  it('rechecks generation ownership before recovery and never reads a replacement child', async () => {
    client.afterUpdate = () => {
      ownership.invalidate('child-exit');
      ownership.bindReadyGeneration();
    };
    await expect(rotate()).rejects.toThrow(/ownership changed/);
    expect(client.calls).toHaveLength(2);
  });

  it('requires exact supervisor-proven endpoints before sending any bytes', async () => {
    await expect(rotateSystemRecordMaterializationEpochV1({
      networkId: 'testnet',
      lease: ownership.lease,
      client: client as unknown as OwnedManagedHttpClient,
      queryEndpoint: 'http://127.0.0.1:7879/query',
      updateEndpoint: UPDATE_ENDPOINT,
    })).rejects.toThrow(/ownership changed/);
    expect(client.calls).toHaveLength(0);
  });

  it('derives distinct exact epoch subjects for distinct networks', async () => {
    await rotate('testnet');
    const testnetQuery = client.calls[0]?.body;
    client.calls.length = 0;
    client.values = [];
    await rotate('mainnet-gnosis');
    expect(client.calls[0]?.body).not.toBe(testnetQuery);
  });
});

describe('epoch rotation snapshot guard honours the structural contract', () => {
  // The exported interface is structural, so anything satisfying it is accepted
  // on its own terms -- including a class instance and extra metadata. What is
  // refused is narrower and specific: shapes that can answer the boundary one
  // way and a later reader another. Own DATA descriptors cannot do that, which
  // is why they are the unit this guard reads.
  const VALID = { epoch: '7', childGeneration: '3' } as const;
  const rotation = (value: typeof VALID) => ({ kind: 'rotation', value });

  it('models absence as its own state, distinct from malformed', () => {
    // The distinction the caller needs: legacy absence is tolerated, a present
    // but unusable binding fails managed mutations closed. Collapsing these two
    // into one falsy answer is what makes that call site guess.
    expect(snapshotSystemRecordMaterializationEpochRotationV1(undefined))
      .toEqual({ kind: 'absent' });
    expect(snapshotSystemRecordMaterializationEpochRotationV1(null))
      .toEqual({ kind: 'malformed' });
  });

  it('accepts a plain literal and carries exactly the two contract fields', () => {
    expect(snapshotSystemRecordMaterializationEpochRotationV1({ ...VALID }))
      .toEqual(rotation(VALID));
  });

  it('accepts extra own fields and discards them', () => {
    // toEqual is exact on the carried value, so a leaked extra key fails here.
    expect(snapshotSystemRecordMaterializationEpochRotationV1({
      ...VALID,
      provenance: 'extra metadata a conforming producer may carry',
    })).toEqual(rotation(VALID));
  });

  it('accepts a null-prototype object', () => {
    expect(snapshotSystemRecordMaterializationEpochRotationV1(
      Object.assign(Object.create(null), VALID),
    )).toEqual(rotation(VALID));
  });

  it('accepts a class instance that satisfies the interface', () => {
    // The contract is structural, so this must work. It is safe for the same
    // reason the accessor below is not: these are own data descriptors, which
    // cannot return a different value on a later read.
    class Rotation {
      constructor(readonly epoch: string, readonly childGeneration: string) {}
    }
    const instance: SystemRecordMaterializationEpochRotationV1 = new Rotation('7', '3');
    expect(snapshotSystemRecordMaterializationEpochRotationV1(instance))
      .toEqual(rotation(VALID));
  });

  it('REJECTS an accessor-backed object without ever invoking the accessor', () => {
    // The substitution the guard exists to stop: this getter answers differently
    // on a second read, so validating it and later dereferencing it would bind a
    // generation nobody checked.
    //
    // `reads` is the load-bearing assertion. Rejection alone proves less than it
    // looks -- an accessor's descriptor has no `value`, so this shape is refused
    // by the descriptor check whether or not the getter is ever run. What only
    // holds while the guard stays descriptor-based is that it is NOT run.
    // Rewrite it to read `value.childGeneration` directly and `reads` becomes 1,
    // while the rejection above still passes.
    let reads = 0;
    const shifty: SystemRecordMaterializationEpochRotationV1 = {
      epoch: '7',
      get childGeneration() {
        reads += 1;
        return reads === 1 ? '3' : 'a-generation-nobody-validated';
      },
    };
    expect(snapshotSystemRecordMaterializationEpochRotationV1(shifty))
      .toEqual({ kind: 'malformed' });
    expect(reads).toBe(0);
  });

  it('REJECTS a Proxy wrapping an otherwise valid rotation', () => {
    // Rejected on identity, before any trap runs: a get trap is an accessor the
    // descriptor read cannot see, so it could pass validation and then answer
    // differently.
    const proxied: SystemRecordMaterializationEpochRotationV1 = new Proxy(
      { ...VALID },
      { get: (target, key) => Reflect.get(target, key) },
    );
    expect(snapshotSystemRecordMaterializationEpochRotationV1(proxied))
      .toEqual({ kind: 'malformed' });
  });

  it('reports wrong field types and non-objects as malformed', () => {
    for (const malformed of [
      { epoch: 7, childGeneration: '3' },
      { epoch: '7' },
      0,
      'rotation',
      ['7', '3'],
    ]) {
      expect(snapshotSystemRecordMaterializationEpochRotationV1(malformed))
        .toEqual({ kind: 'malformed' });
    }
  });
});
