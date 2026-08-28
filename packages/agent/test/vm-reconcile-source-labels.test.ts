import { describe, expect, it, vi } from 'vitest';
import type { TripleStore } from '@origintrail-official/dkg-storage';
import { SwmHostModeMethods } from '../src/dkg-agent-swm-host.js';

describe('VM reconcile caller-provided store labels', () => {
  it('labels each SWM fingerprint read by its bounded operation class', async () => {
    const query = vi.fn<TripleStore['query']>(async () => ({
      type: 'bindings',
      bindings: [],
    }));
    const store = { query } as unknown as TripleStore;

    await expect(
      SwmHostModeMethods.prototype.readVmReconcileSwmGen.call(
        { store } as never,
        [{
          metaGraph: 'did:dkg:context-graph:test/_shared_memory_meta',
          dataGraph: 'did:dkg:context-graph:test/_shared_memory',
        }],
      ),
    ).resolves.toContain('ops:0;');

    expect(query.mock.calls.map(([, options]) => options?.source)).toEqual([
      'agent.vmReconcile.swmFingerprint.operations',
      'agent.vmReconcile.swmFingerprint.data',
      'agent.vmReconcile.swmFingerprint.privateRoots',
    ]);
  });

  it('fails open on repeated fingerprint reads during one unstable revision', async () => {
    let revision = { generation: 1, stable: false };
    const query = vi.fn<TripleStore['query']>(async () => ({
      type: 'bindings',
      bindings: [],
    }));
    const store = {
      query,
      getWriteRevision: () => revision,
    } as unknown as TripleStore;
    const agent = { store } as never;
    const namespaces = [{
      metaGraph: 'did:dkg:context-graph:test/_shared_memory_meta',
      dataGraph: 'did:dkg:context-graph:test/_shared_memory',
    }];

    await expect(
      SwmHostModeMethods.prototype.readVmReconcileSwmGen.call(agent, namespaces),
    ).resolves.toBeNull();
    await expect(
      SwmHostModeMethods.prototype.readVmReconcileSwmGen.call(agent, namespaces),
    ).resolves.toBeNull();
    expect(query).toHaveBeenCalledTimes(6);

    revision = { generation: 2, stable: true };
    await expect(
      SwmHostModeMethods.prototype.readVmReconcileSwmGen.call(agent, namespaces),
    ).resolves.toContain('writeGen:2');
  });
});
