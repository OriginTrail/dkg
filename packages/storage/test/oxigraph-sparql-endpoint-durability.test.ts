// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { createManagedOxigraphSparqlStoreV1 } from '../src/index.js';
import { startOxigraphSparqlEndpoint } from './helpers/oxigraph-sparql-endpoint.js';

const quad = (value: string) => ({ subject: `urn:ack:${value}`, predicate: 'urn:value', object: JSON.stringify(value), graph: 'urn:ack:test' });

describe('test endpoint persistence acknowledgement contract', () => {
  it('does not certify the default memory-only endpoint', async () => {
    const endpoint = await startOxigraphSparqlEndpoint();
    try { expect(endpoint.writesDurableOnAcknowledgement).toBe(false); }
    finally { await endpoint.close(); }
  });

  it('holds the HTTP acknowledgement and later mutations until the persistence barrier resolves', async () => {
    let entered!: () => void, release!: () => void;
    const reached = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const snapshots: string[] = [];
    let callbacks = 0;
    const endpoint = await startOxigraphSparqlEndpoint({ persistBeforeAcknowledgement: async store => {
      callbacks += 1;
      entered();
      await held;
      snapshots.push(store.dump({ format: 'application/n-quads' }));
    } });
    const remote = createManagedOxigraphSparqlStoreV1({ queryEndpoint: endpoint.queryEndpoint,
      updateEndpoint: endpoint.updateEndpoint, writesDurableOnAcknowledgement: endpoint.writesDurableOnAcknowledgement });
    let acknowledged = false;
    const first = remote.insert([quad('first')]).then(() => { acknowledged = true; });
    await reached;
    const second = remote.insert([quad('second')]);
    try {
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(acknowledged).toBe(false);
      expect(callbacks).toBe(1);
      expect(endpoint.store.query('ASK { GRAPH <urn:ack:test> { <urn:ack:second> ?p ?o } }')).toBe(false);
    } finally {
      release();
      await Promise.all([first, second]);
      await remote.close();
      await endpoint.close();
    }
    expect(snapshots).toHaveLength(2);
    expect(snapshots[0]).toContain('<urn:ack:first>');
    expect(snapshots[0]).not.toContain('<urn:ack:second>');
    expect(snapshots[1]).toContain('<urn:ack:second>');
  });

  it('does not acknowledge a write when its persistence barrier fails', async () => {
    const endpoint = await startOxigraphSparqlEndpoint({ persistBeforeAcknowledgement: async () => { throw new Error('snapshot fsync failed'); } });
    const remote = createManagedOxigraphSparqlStoreV1({ queryEndpoint: endpoint.queryEndpoint,
      updateEndpoint: endpoint.updateEndpoint, writesDurableOnAcknowledgement: endpoint.writesDurableOnAcknowledgement });
    try { await expect(remote.insert([quad('failure')])).rejects.toMatchObject({ status: 400 }); }
    finally { await remote.close(); await endpoint.close(); }
  });
});
