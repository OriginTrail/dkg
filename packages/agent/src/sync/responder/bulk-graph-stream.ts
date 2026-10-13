// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { BULK_GRAPH_KIND as K, BULK_GRAPH_CHUNK_BYTES, BULK_GRAPH_FRAME_BYTES,
  createOperationContext, registerBulkGraphResponder, type ProtocolRouter, type BulkGraphSession } from '@origintrail-official/dkg-core';
import { BULK_STAGING_BYTES, BULK_STAGING_ASSETS, bulkChunkHash, bulkJson, readBulkJson, encodeBulkRefusal, encodeBulkChunkEnd,
  validateBulkGraphRequest, type BulkGraphRequest } from '../bulk-graph-contract.js';
import type { PublicAssetResponderOptions } from './public-asset-responder.js';

import { observeExactBatch as observe } from '../exact-batch-observation.js';
const EMPTY = new Uint8Array();
/** Public-only, shares the existing responder admission and verified prepared-content cache. */
export function registerPublicBulkGraph(router: ProtocolRouter, options: PublicAssetResponderOptions): void {
  registerBulkGraphResponder(router, async (bytes, peer, signal) => {
    const request = validateBulkGraphRequest(readBulkJson(bytes));
    return options.admission.withPreAuthorizationAdmission(peer, signal, async () => {
      // The ordinary public graph authorizer is still mandatory. It authorizes graph
      // access, not the caller's snapshot claims (which never establish authority).
      const envelope = { contextGraphId: request.contextGraphId, includeSharedMemory: false,
        phase: 'data' as const, offset: 0, limit: 1, assetUals: [request.assetUals[0]!] };
      if (options.servingWithheld?.(request.contextGraphId)
        || !await options.authorizeSyncRequest(envelope, peer, { signal })
        || !await options.isPublicContextGraph(request.contextGraphId, signal)) throw new Error('Bulk graph authorization denied');
      signal.throwIfAborted(); return request;
    });
  }, (request, session, peer) => options.admission.withAuthorizedResponseAdmission(peer, request.contextGraphId,
    session.signal, () => servePublicBulkChunk(request, session, options)));
}

export async function servePublicBulkChunk(request: BulkGraphRequest, session: BulkGraphSession, options: PublicAssetResponderOptions): Promise<void> {
  const context = createOperationContext('sync');
  const hash = bulkChunkHash(request);
  // Encoded prefix offsets are the single ledger for sent, credited and durable progress.
  const offsets = [0];
  let credited = 0, committed = 0;
  const lengthAt = (index: number) => offsets[index + 1]! - offsets[index]!;
  const readControl = async () => {
    const frame = await session.next();
    if (frame.kind === K.CREDIT) {
      if (frame.index !== credited || credited >= offsets.length - 1 || frame.sequence !== lengthAt(credited)) throw new Error('Invalid bulk receipt credit');
      credited++;
    } else if (frame.kind === K.COMMIT) {
      if (frame.index !== committed || committed >= credited || frame.sequence !== lengthAt(committed)) throw new Error('Invalid bulk durable acknowledgement');
      committed++;
    } else throw new Error('Unexpected bulk receiver control');
  };
  for (const [index, assetUal] of request.assetUals.entries()) {
    session.signal.throwIfAborted();
    if (options.servingWithheld?.(request.contextGraphId)
      || !await options.isPublicContextGraph(request.contextGraphId, session.signal)) throw new Error('Bulk graph public authority changed');
    const started = performance.now();
    const lease = await options.exportCache.acquireEncoded({ contextGraphId: request.contextGraphId, assetUal,
      signal: session.signal, authorizeMissingAccessPolicy: () => options.isPublicContextGraph(request.contextGraphId, session.signal),
      onStage: (stage, ms) => observe(() => options.onStage?.(stage, index, ms, context)),
      onFallback: (reason, budgetReason) => observe(() => options.onFallback?.(reason, index, context, budgetReason)) });
    if (!lease) {
      await session.send({ kind: K.REFUSE, index, sequence: 0, payload: encodeBulkRefusal({ code: 'RESOURCE_LIMIT' }) });
      return;
    }
    try {
      const bytes = offsets[index]!;
      if (lease.body.length > BULK_GRAPH_CHUNK_BYTES - bytes) break;
      while (bytes - offsets[credited]! + lease.body.length > BULK_STAGING_BYTES
        || index - credited >= BULK_STAGING_ASSETS) await readControl();
      // Credit backpressure can outlive the earlier policy read; recheck before
      // disclosing the next body, as the exact transport does after its ACK wait.
      if (options.servingWithheld?.(request.contextGraphId)
        || !await options.isPublicContextGraph(request.contextGraphId, session.signal)) throw new Error('Bulk graph public authority changed');
      // Asset access may change independently of public graph status while
      // waiting for CREDIT. Revalidate the retained lease before disclosure.
      await lease.assertCurrent();
      session.signal.throwIfAborted();
      const directory = bulkJson({ encodedBytes: lease.body.length, plainBytes: lease.plainBytes, offset: bytes,
        digest: createHash('sha256').update(lease.body).digest('hex'), metadata: Buffer.from(lease.metadata).toString('base64') });
      hash.update(directory).update(lease.body);
      offsets.push(bytes + lease.body.length);
      await session.send({ kind: K.META, index, sequence: 0, payload: directory });
      let sequence = 0;
      for (let offset = 0; offset < lease.body.length; offset += BULK_GRAPH_FRAME_BYTES)
        await session.send({ kind: K.DATA, index, sequence: sequence++, payload: lease.body.subarray(offset, offset + BULK_GRAPH_FRAME_BYTES) });
      await lease.assertCurrent();
      session.signal.throwIfAborted();
      await session.send({ kind: K.ASSET_END, index, sequence, payload: EMPTY });
      if (lease.wholePayloadExports !== undefined) observe(() => options.onExport?.(index, lease.wholePayloadExports!, context));
      observe(() => options.onPayload?.(index, lease.plainBytes, lease.body.length, context));
      observe(() => options.onStage?.('export', index, performance.now() - started, context));
    } finally { lease.release(); }
  }
  const assets = offsets.length - 1, bytes = offsets[assets]!;
  if (!assets) throw new Error('Bulk graph chunk made no progress');
  await session.send({ kind: K.CHUNK_END, index: assets, sequence: bytes,
    payload: encodeBulkChunkEnd({ digest: hash.digest('hex'), assets, encodedBytes: bytes }) });
  while (committed < assets) await readControl();
}
