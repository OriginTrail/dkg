import { type OperationContext } from '@origintrail-official/dkg-core';
import { type Quad } from '@origintrail-official/dkg-storage';
import { type SyncPageResult } from '../src/sync/requester/page-fetch.js';
import { toSyncTransportFailureError } from '../src/sync/error-tags.js';

export const ctx = { operationId: 'test', operationName: 'sync' } satisfies OperationContext;

export const noop = () => {};

export function pageResult(
  contextGraphId: string,
  phase: string,
  overrides: Partial<SyncPageResult> = {},
): SyncPageResult {
  return {
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