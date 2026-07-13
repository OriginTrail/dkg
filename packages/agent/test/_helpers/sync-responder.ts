import type { OperationContext } from '@origintrail-official/dkg-core';
import type { TripleStore } from '@origintrail-official/dkg-storage';
import type { WorkspacePublicSnapshotStore } from '@origintrail-official/dkg-publisher';
import { registerSyncHandler } from '../../src/sync/responder/sync-handler.js';
import type { SyncResponderSnapshotBudgetOptions } from '../../src/sync/responder/snapshot-budget.js';
import type { SyncRequestEnvelope } from '../../src/sync/auth/request-build.js';

export const TEST_SYNC_PROTOCOL = '/origintrail/dkg/sync/1.0.0';
export const TEST_SYNC_DENIED = 'sync-denied';
export const TEST_REMOTE_PEER = '12D3KooWSyncResponderTestRemote';
export const DKG_NS = 'http://dkg.io/ontology/';
export const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
export const SCHEMA_NAME = 'http://schema.org/name';

export const noopLog = (_ctx: OperationContext, _msg: string) => {};

export interface CapturedSyncHandler {
  register: (
    proto: string,
    handler: (data: Uint8Array, peerId: string) => Promise<Uint8Array>,
  ) => void;
  invoke: (envelope: SyncRequestEnvelope, remotePeerId?: string) => Promise<string>;
}

export function captureSyncHandler(): CapturedSyncHandler {
  let captured: ((data: Uint8Array, peerId: string) => Promise<Uint8Array>) | null = null;
  return {
    register: (_proto, handler) => {
      captured = handler;
    },
    invoke: async (envelope, remotePeerId = TEST_REMOTE_PEER) => {
      if (!captured) throw new Error('handler not registered');
      const bytes = new TextEncoder().encode(JSON.stringify(envelope));
      const out = await captured(bytes, remotePeerId);
      return new TextDecoder().decode(out);
    },
  };
}

export function registerTestSyncHandler(
  store: TripleStore,
  options: {
    sharedMemoryTtlMs?: number;
    syncPageSize?: number;
    snapshotBudget?: SyncResponderSnapshotBudgetOptions;
    authorize?: (request: SyncRequestEnvelope, remotePeerId: string) => Promise<boolean>;
    logDebug?: (ctx: OperationContext, message: string) => void;
    publicSnapshotStore?: WorkspacePublicSnapshotStore;
  } = {},
): CapturedSyncHandler {
  const cap = captureSyncHandler();
  registerSyncHandler({
    register: cap.register,
    protocolSync: TEST_SYNC_PROTOCOL,
    syncDeniedResponse: TEST_SYNC_DENIED,
    syncPageSize: options.syncPageSize ?? 5000,
    sharedMemoryTtlMs: options.sharedMemoryTtlMs ?? 0,
    store,
    publicSnapshotStore: options.publicSnapshotStore,
    peerId: 'self-peer',
    parseSyncRequest: (data) => JSON.parse(new TextDecoder().decode(data)) as SyncRequestEnvelope,
    authorizeSyncRequest: options.authorize ?? (async () => true),
    logWarn: noopLog,
    logDebug: options.logDebug ?? noopLog,
    snapshotBudget: options.snapshotBudget,
  });
  return cap;
}

export function lineGraphsFromNquads(text: string): Set<string> {
  const graphs = new Set<string>();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const match = line.match(/<([^<>]+)>\s*\.\s*$/);
    if (match) graphs.add(match[1]);
  }
  return graphs;
}

export function linesFromNquads(text: string): string[] {
  return text.split('\n').map((line) => line.trim()).filter(Boolean);
}

export function workspaceOpQuads(
  cgId: string,
  opId: string,
  rootEntity: string,
  metaGraph: string,
  publishedAt: string,
) {
  const subject = `urn:dkg:share:${cgId}:${opId}`;
  return [
    { graph: metaGraph, subject, predicate: RDF_TYPE, object: `${DKG_NS}WorkspaceOperation` },
    { graph: metaGraph, subject, predicate: `${DKG_NS}publishedAt`, object: `"${publishedAt}"^^<http://www.w3.org/2001/XMLSchema#dateTime>` },
    { graph: metaGraph, subject, predicate: `${DKG_NS}rootEntity`, object: rootEntity },
    { graph: metaGraph, subject, predicate: `${DKG_NS}contextGraphId`, object: `"${cgId}"` },
    { graph: metaGraph, subject, predicate: `${DKG_NS}shareOperationId`, object: `"${opId}"` },
  ];
}
export function subGraphRegistrationQuads(cgId: string, subGraphName: string) {
  const cgMeta = `did:dkg:context-graph:${cgId}/_meta`;
  const sgUri = `did:dkg:context-graph:${cgId}/${subGraphName}`;
  return [
    { graph: cgMeta, subject: sgUri, predicate: RDF_TYPE, object: `${DKG_NS}SubGraph` },
    { graph: cgMeta, subject: sgUri, predicate: SCHEMA_NAME, object: `"${subGraphName}"` },
    { graph: cgMeta, subject: sgUri, predicate: `${DKG_NS}createdBy`, object: '"test-creator"' },
  ];
}
