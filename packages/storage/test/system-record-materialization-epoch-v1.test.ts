import { beforeEach, describe, expect, it } from 'vitest';

import { OwnedManagedHttpClient } from '../src/adapters/managed-http-client.js';
import {
  createManagedOxigraphOwnershipControllerV1,
  type ManagedOxigraphOwnershipControllerV1,
} from '../src/managed-oxigraph-ownership-v1-internal.js';
import { rotateSystemRecordMaterializationEpochV1 } from '../src/system-record-materialization-epoch-v1-internal.js';

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
