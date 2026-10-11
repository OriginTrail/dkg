// SPDX-License-Identifier: Apache-2.0

import { ethers } from 'ethers';
import {
  encryptV10PublishPayload, encryptChunked, buildCiphertextChunksRoot, computeGossipSigningPayloadV2,
  GOSSIP_TYPE_WORKSPACE_PUBLISH_CHUNKED, GOSSIP_ENVELOPE_VERSION, encodeGossipEnvelope,
  ciphertextChunkStoreGraph, ciphertextChunkStoreSubject, CIPHERTEXT_CHUNK_PREDICATE,
  contextGraphWorkspaceTopic, createOperationContext, type Logger,
} from '@origintrail-official/dkg-core';
import type { TripleStore } from '@origintrail-official/dkg-storage';
import { sliceIntoCiphertextChunks } from '../dkg-agent-helpers.js';

/** What both hooks of one publish attempt encrypt with: one sender-key epoch and the id its AEAD binds to. */
export interface CuratedInlineContext {
  readonly chainKey: Uint8Array;
  readonly aeadCgId: string;
}

/** What the chunked emitter uses of the agent that owns it. */
export interface CuratedChunkEmitterHost {
  readonly store: Pick<TripleStore, 'insert'>;
  readonly gossip: { publish(topic: string, data: Uint8Array): Promise<unknown> };
  gossipWireIdFor(contextGraphId: string): string;
  canonicalChunkStoreCgIdOrNull(contextGraphId: string): string | null;
  resolveWorkspaceGossipSigningAgent(contextGraphId: string): Promise<{ agentAddress: string; privateKey: string } | null | undefined>;
}

export function buildInlinePayload(resolved: CuratedInlineContext | undefined) {
  if (!resolved) return undefined;
  const { chainKey, aeadCgId } = resolved;
  return async (plaintext: Uint8Array): Promise<Uint8Array> => encryptV10PublishPayload({
    chainKey, contextGraphId: aeadCgId, plaintext,
  });
}

export async function buildInlineChunked(
  host: CuratedChunkEmitterHost, contextGraphId: string, resolved: CuratedInlineContext | undefined, log: Pick<Logger, 'warn' | 'info'>,
) {
  if (!resolved) return undefined;
  const { chainKey, aeadCgId } = resolved;
  const wireCgId = host.gossipWireIdFor(contextGraphId);
  const topic = contextGraphWorkspaceTopic(wireCgId);
  const signer = await host.resolveWorkspaceGossipSigningAgent(contextGraphId);
  if (!signer) {
    throw new Error(
      `LU-11: curated CG ${contextGraphId}: cannot resolve a workspace-gossip signing agent — ` +
      `cores reject unsigned chunked envelopes. Add a local custodial signing key for an ` +
      `allowed agent before publishing.`,
    );
  }
  const signerWallet = new ethers.Wallet(signer.privateKey);
  const signerAgentAddress = signer.agentAddress;
  const ctx = createOperationContext('publish');
  const gossip = host.gossip;

  return async (input: { plaintextNquads: Uint8Array; batchId: Uint8Array; publishOperationId: string }): Promise<{
    ciphertextChunksRoot: Uint8Array;
    ciphertextChunkCount: number;
    totalCiphertextBytes: number;
    ciphertextChunks: Uint8Array[];
  }> => {
    if (input.batchId.length !== 32) {
      throw new Error(
        `LU-11: chunked emit requires a 32-byte batchId (V10 KC merkleRoot); got ${input.batchId.length}`,
      );
    }
    if (input.publishOperationId.length === 0) {
      throw new Error('LU-11: chunked emit requires a non-empty publishOperationId');
    }
    const plaintextChunks = sliceIntoCiphertextChunks(input.plaintextNquads);
    const { ciphertextChunks } = encryptChunked({
      chainKey,
      contextGraphId: aeadCgId,
      plaintextChunks,
      publishOperationId: input.publishOperationId,
    });
    const { root, leafCount } = buildCiphertextChunksRoot(ciphertextChunks);
    const batchIdHex = ethers.hexlify(input.batchId);
    let totalCiphertextBytes = 0;
    for (let i = 0; i < ciphertextChunks.length; i++) {
      const ct = ciphertextChunks[i];
      totalCiphertextBytes += ct.length;
      const payload = new Uint8Array(input.batchId.length + ct.length);
      payload.set(input.batchId, 0);
      payload.set(ct, input.batchId.length);
      const persistCanonical = host.canonicalChunkStoreCgIdOrNull(contextGraphId);
      const chunksGraph = ciphertextChunkStoreGraph(persistCanonical ?? contextGraphId);
      const subject = ciphertextChunkStoreSubject(input.batchId, i);
      const literal = `"${Buffer.from(ct).toString('base64')}"`;
      try {
        await host.store.insert([{
          subject,
          predicate: CIPHERTEXT_CHUNK_PREDICATE,
          object: literal,
          graph: chunksGraph,
        }]);
      } catch (err) {
        log.warn(
          ctx,
          `LU-11: failed to persist local ciphertext chunk cgId=${contextGraphId} ` +
          `batchId=${batchIdHex.slice(0, 18)}... op=${input.publishOperationId} chunkIndex=${i}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        throw err;
      }
      const timestamp = new Date().toISOString();
      const signingPayload = computeGossipSigningPayloadV2(
        GOSSIP_TYPE_WORKSPACE_PUBLISH_CHUNKED,
        contextGraphId,
        timestamp,
        payload,
        i,
      );
      const signature = await signerWallet.signMessage(signingPayload);
      const envelope = encodeGossipEnvelope({
        version: GOSSIP_ENVELOPE_VERSION,
        type: GOSSIP_TYPE_WORKSPACE_PUBLISH_CHUNKED,
        contextGraphId,
        agentAddress: signerAgentAddress,
        timestamp,
        signature: ethers.getBytes(signature),
        payload,
        swmMessageIndex: i,
      });
      try {
        await gossip.publish(topic, envelope);
      } catch (err) {
        log.warn(
          ctx,
          `LU-11: chunked gossip publish failed for cgId=${contextGraphId} ` +
          `batchId=${batchIdHex.slice(0, 18)}... op=${input.publishOperationId} chunkIndex=${i}: ${
            err instanceof Error ? err.message : String(err)
          } — cores without this chunk will DECLINE the V2 ACK; ` +
          `late-join sync can backfill once the catchup verb lands.`,
        );
      }
    }
    log.info(
      ctx,
      `LU-11: emitted ${ciphertextChunks.length} ciphertext chunks ` +
      `(${totalCiphertextBytes} bytes total) for curated CG ${contextGraphId} ` +
      `batchId=${batchIdHex.slice(0, 18)}... op=${input.publishOperationId} on topic ${topic}`,
    );
    return {
      ciphertextChunksRoot: root,
      ciphertextChunkCount: leafCount,
      totalCiphertextBytes,
      ciphertextChunks,
    };
  };
}
