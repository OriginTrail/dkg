import { type OperationContext } from '@origintrail-official/dkg-core';
import { type Quad } from '@origintrail-official/dkg-storage';
import { toSyncTransportFailureError } from '../../src/sync/error-tags.js';
import { type SyncPageResult } from '../../src/sync/requester/page-fetch.js';

export const ctx = { operationId: 'test', operationName: 'sync' } satisfies OperationContext;

export const noop = () => {};

export function pageResult(
  contextGraphId: string,
  phase: string,
  overrides: Partial<SyncPageResult> = {},
): SyncPageResult {
  const result = {
    quads: [],
    bytesReceived: 0,
    resumedFromOffset: 0,
    responderSessionStartedFresh: true,
    nextOffset: 0,
    checkpointKey: `${contextGraphId}:${phase}`,
    completed: true,
    timedOut: false,
    ...overrides,
  };
  if (result.localYield === true) {
    if (result.completed || result.timedOut) {
      throw new Error('A locally yielded fixture page cannot be completed or timed out');
    }
    return { ...result, completed: false, timedOut: false, localYield: true };
  }
  if (result.timedOut === true) {
    if (result.completed) throw new Error('A timed-out fixture page cannot be completed');
    return { ...result, completed: false, timedOut: true, localYield: undefined };
  }
  if (result.completed === true) {
    return { ...result, completed: true, timedOut: false, localYield: undefined };
  }
  return { ...result, completed: false, timedOut: false, localYield: undefined };
}

export function transportError(message: string): Error {
  const err = new Error(message);
  return toSyncTransportFailureError(err);
}

export function quad(subject: string): Quad {
  return {
    subject,
    predicate: 'http://example.com/p',
    object: 'http://example.com/o',
    graph: 'http://example.com/g',
  } satisfies Quad;
}

export function sharedMemoryProcessResult() {
  return {
    verifiedData: [] as Quad[],
    verifiedMeta: [] as Quad[],
    totalFetchedDataQuads: 0,
    totalFetchedMetaQuads: 0,
    droppedDataTriples: 0,
    emptyResponses: 1,
    entityCreators: [],
  };
}
