import { vi } from 'vitest';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import type { Logger } from '@origintrail-official/dkg-core';
import type { DKGPublisher } from '@origintrail-official/dkg-publisher';
import type { TripleStore } from '@origintrail-official/dkg-storage';
import { DKGAgent } from '../../src/index.js';
import type { SwmExpiryCleanupContext } from '../../src/swm-expiry-cleanup.js';
import type { SwmExpiryCleanupWorker } from '../../src/swm-expiry-cleanup-worker.js';

export const CG = 'expiry-batches';
export const WS = `did:dkg:context-graph:${CG}/_shared_memory`;
export const META = `${WS}_meta`;

export interface SwmExpiryTestInternals {
  swmExpiryCleanupWorker: SwmExpiryCleanupWorker;
  store: TripleStore;
  publisher: DKGPublisher;
  log: Logger;
  workspaceOwnedEntities: Map<string, Map<string, string>>;
  writeLocks: Map<string, Promise<void>>;
}

export interface SwmExpiryFixture {
  agent: DKGAgent;
  operations: Set<string>;
  stats: {
    largestBatch: number;
    familyLists: number;
    selections: number;
    active: number;
    maxActive: number;
  };
  warning: ReturnType<typeof vi.spyOn>;
  store: TripleStore;
}

const agents: DKGAgent[] = [];

export function trackSwmExpiryAgent(agent: DKGAgent): DKGAgent {
  agents.push(agent);
  return agent;
}

export async function stopTrackedSwmExpiryAgents(): Promise<void> {
  await Promise.all(agents.splice(0).map(agent => agent.stop()));
}

export function swmExpiryCleanupContext(
  agent: DKGAgent,
  overrides: Partial<Pick<SwmExpiryCleanupContext, 'writeLocks' | 'isClosed'>> = {},
): SwmExpiryCleanupContext {
  const { store, log, workspaceOwnedEntities, writeLocks } = agent as unknown as SwmExpiryTestInternals;
  return {
    store,
    log,
    workspaceOwnedEntities,
    writeLocks: overrides.writeLocks ?? writeLocks,
    isClosed: overrides.isClosed ?? (() => false),
  };
}

export async function createSwmExpiryFixture(
  count: number,
  noProgress = false,
  dataDeleted = 0,
): Promise<SwmExpiryFixture> {
  const agent = trackSwmExpiryAgent(await DKGAgent.create({
    name: 'expiry-batches',
    chainAdapter: new MockChainAdapter(),
    sharedMemoryTtlMs: 60_000,
  }));
  const { store, log } = agent as unknown as SwmExpiryTestInternals;
  const operations = new Set(Array.from({ length: count }, (_, i) => `urn:expiry:op:${i}`));
  const stats = { largestBatch: 0, familyLists: 0, selections: 0, active: 0, maxActive: 0 };
  const warning = vi.spyOn(log, 'warn').mockImplementation(() => {});
  vi.spyOn(log, 'info').mockImplementation(() => {});
  vi.spyOn(store, 'listGraphsByPrefix').mockImplementation(async prefix => {
    if (prefix === `${WS}/`) {
      stats.familyLists++;
      return Array.from({ length: 2 }, (_, i) => `${WS}/family-${i}`);
    }
    return [META];
  });
  vi.spyOn(store, 'hasGraph').mockResolvedValue(true);
  vi.spyOn(store, 'query').mockImplementation(async (sparql, options) => {
    if (options?.source === 'agent.swmCleanup.verifyOperationDeletion') {
      return { type: 'boolean', value: [...operations].some(op => sparql.includes(`<${op}>`)) };
    }
    if (options?.source === 'agent.swmCleanup.revalidateOperation') {
      const op = [...operations].find(candidate => sparql.includes(`<${candidate}>`));
      return { type: 'bindings', bindings: op ? [{ op, re: 'urn:expiry:root' }] : [] };
    }
    if (options?.source === 'agent.swmCleanup.expiredOperations') {
      stats.selections++;
      if (stats.selections > count + 4) throw new Error('fixture detected an unbounded no-progress loop');
      stats.active++;
      stats.maxActive = Math.max(stats.maxActive, stats.active);
      await Promise.resolve();
      const limit = /LIMIT\s+(\d+)/i.exec(sparql);
      const rows = [...operations].slice(0, limit ? Number(limit[1]) : undefined);
      stats.largestBatch = Math.max(stats.largestBatch, rows.length);
      stats.active--;
      return { type: 'bindings', bindings: rows.map(op => ({ op, re: 'urn:expiry:root' })) };
    }
    if (options?.source === 'agent.swmCleanup.operationRoots') {
      return { type: 'bindings', bindings: [{ re: 'urn:expiry:root' }] };
    }
    return { type: 'bindings', bindings: [] };
  });
  vi.spyOn(store, 'deleteByPattern').mockImplementation(async pattern => {
    if (pattern.graph === META && pattern.subject && operations.has(pattern.subject)) {
      if (noProgress) return 0;
      operations.delete(pattern.subject);
      return 3;
    }
    return pattern.graph === META ? 0 : dataDeleted;
  });
  vi.spyOn(store, 'deleteBySubjectPrefix').mockResolvedValue(0);
  return { agent, operations, stats, warning, store };
}
