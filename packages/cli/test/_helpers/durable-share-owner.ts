import { randomUUID } from 'node:crypto';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { TripleStoreAsyncPromoteQueue } from '@origintrail-official/dkg-publisher';
import { daemonState } from '../../src/daemon/state.js';

/** A real queue around a route fixture's promote callback; caller closes stores. */
export function withDurableShareOwner<T extends { assertion?: any }>(agent: T, stores: OxigraphStore[]): T {
  if (typeof agent.assertion?.promote !== 'function') return agent;
  const store = new OxigraphStore();
  stores.push(store);
  daemonState.promoteWorkerAvailable = true;
  agent.assertion.prepareDurableShare = async (_cg: string, _name: string, opts: any) => ({
    agentAddress: opts?.agentAddress ?? `0x${'11'.repeat(20)}`,
    recoveryBinding: { version: 1, sealDigest: `0x${'11'.repeat(32)}`, inventoryRequired: false,
      intent: { version: 1, operationId: randomUUID(), timestampMs: Date.now(),
        confirmationRequired: false, accessPolicy: 'public', allowedPeers: [] } },
  });
  return Object.assign(agent, { promoteQueue: new TripleStoreAsyncPromoteQueue(store) });
}
