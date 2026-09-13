// SPDX-License-Identifier: Apache-2.0

import { RpcEndpointsExhaustedError } from '@origintrail-official/dkg-chain';
import { describe, expect, it } from 'vitest';

import { DKGAgent } from '../src/dkg-agent.js';
import { Rfc64AuthorityReadCoordinatorV1 } from
  '../src/rfc64/authority-rpc-circuit-breaker-v1.js';

describe('DKGAgent RFC-64 authority RPC circuit status boundary', () => {
  it('projects the shared coordinator snapshot without provider or graph details', async () => {
    let now = 1_000;
    const coordinator = new Rfc64AuthorityReadCoordinatorV1({
      baseBackoffMs: 100,
      maxBackoffMs: 800,
      jitterRatio: 0,
      now: () => now,
    });
    const agent = Object.create(DKGAgent.prototype) as DKGAgent;
    Reflect.set(agent, 'rfc64PublicCatalogOwnerV1', { authorityReads: coordinator });

    expect(agent.readRfc64AuthorityRpcCircuitSnapshotV1()).toEqual({
      state: 'closed',
      consecutiveExhaustions: 0,
      retryAtMs: null,
    });

    await expect(coordinator.run(undefined, async () => {
      throw new RpcEndpointsExhaustedError('all authority RPC endpoints exhausted', {
        exhaustionKind: 'all-throttled',
      });
    })).rejects.toMatchObject({ code: 'RPC_ENDPOINTS_EXHAUSTED' });

    expect(agent.readRfc64AuthorityRpcCircuitSnapshotV1()).toEqual({
      state: 'open',
      consecutiveExhaustions: 1,
      retryAtMs: 1_100,
    });
    expect(Object.keys(agent.readRfc64AuthorityRpcCircuitSnapshotV1()).sort()).toEqual([
      'consecutiveExhaustions',
      'retryAtMs',
      'state',
    ]);

    now = 1_100;
    await expect(coordinator.run(undefined, async () => 'recovered')).resolves.toBe('recovered');
    expect(agent.readRfc64AuthorityRpcCircuitSnapshotV1()).toEqual({
      state: 'closed',
      consecutiveExhaustions: 0,
      retryAtMs: null,
    });
  });
});
