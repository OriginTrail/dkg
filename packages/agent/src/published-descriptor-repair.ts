// SPDX-License-Identifier: Apache-2.0
import { ethers } from 'ethers';
import { createGraphKnowledgeAssetScope, resolveWithinAbort } from '@origintrail-official/dkg-core';
import type { ChainAdapter } from '@origintrail-official/dkg-chain';
import type { TripleStore } from '@origintrail-official/dkg-storage';
import { assertionLifecycleWriteLockKey, withKeyedLocks } from '@origintrail-official/dkg-publisher';
import type { PublishedNamedKaVmLifecycleWriter } from './named-ka-vm-lifecycle.js';
import { incompleteNamedKaLifecycleAuthor } from './incomplete-named-ka-lifecycle.js';
import { resolveConfirmedGraphScopedVm } from './confirmed-graph-scoped-vm-resolver.js';
import { recoverReceiptBackedGraphScopedEvidence } from './receipt-backed-graph-scoped-evidence.js';

export interface PublishedDescriptorRepairInput {
  contextGraphId: string;
  name: string;
  kaUal: string;
  subGraphName?: string;
  /** Verification only unless explicitly false. */
  dryRun?: boolean;
}
interface RepairHost {
  store: TripleStore;
  chain: ChainAdapter;
  writeLocks: Map<string, Promise<void>>;
  stampPublishedLifecycle: PublishedNamedKaVmLifecycleWriter;
  getContextGraphOnChainId(cg: string, options?: { signal?: AbortSignal }): Promise<string | null | undefined>;
}
const active = new WeakSet<object>();
const refuse = (message: string): never => {
  throw Object.assign(new Error(`Published descriptor repair refused: ${message}`), { code: 'KA_DESCRIPTOR_REPAIR_REFUSED' });
};

/** Explicit one-asset recovery after terminal jobs have been cleared. Never sends a transaction.
 * Completes the interrupted VM projection; surviving identity/content/provenance must verify.
 */
export async function repairPublishedDescriptor(host: RepairHost, input: PublishedDescriptorRepairInput) {
  if (active.has(host.store)) throw Object.assign(new Error('Another descriptor repair is active'), { code: 'KA_DESCRIPTOR_REPAIR_BUSY' });
  active.add(host.store);
  let abandonedRead: Promise<unknown> | undefined;
  let writeEntered = false;
  try {
    const scope = createGraphKnowledgeAssetScope(input.kaUal, '1');
    if (scope.chainId !== host.chain.chainId) return refuse('UAL belongs to another chain');
    const kaId = (BigInt(scope.agentAddress) << 96n) | BigInt(scope.kaNumber);
    const signal = AbortSignal.timeout(30_000);
    const work = withKeyedLocks(host.writeLocks, [assertionLifecycleWriteLockKey(
      input.contextGraphId, input.name, scope.agentAddress, input.subGraphName,
    )], async () => {
      signal.throwIfAborted();
      const verified = await (async () => {
        const snapshot = await host.chain.readKnowledgeAssetVersionSnapshot?.(kaId, { signal });
        if (!snapshot || snapshot.rootCount <= 0n || snapshot.latestAuthor.toLowerCase() !== scope.agentAddress.toLowerCase()) {
          return refuse('current chain version or author is unavailable');
        }
        const [cg, boundCg] = await Promise.all([
          host.getContextGraphOnChainId(input.contextGraphId, { signal }),
          host.chain.getKAContextGraphId?.(kaId, { signal }),
        ]);
        if (!cg || boundCg === undefined || BigInt(cg) !== boundCg) return refuse('context graph binding does not match');
        const vm = await resolveConfirmedGraphScopedVm(host.store, {
          contextGraphId: input.contextGraphId, ual: scope.ual, assertionVersion: snapshot.rootCount,
          merkleRoot: ethers.getBytes(snapshot.latestRoot), kaId, batchId: kaId, subGraphName: input.subGraphName,
        });
        if (vm.status !== 'verified') return refuse('exact confirmed VM content or metadata does not match');
        const receipt = await recoverReceiptBackedGraphScopedEvidence({
          store: host.store, chain: host.chain, contextGraphId: input.contextGraphId, scope: vm.scope,
          head: { kaUal: scope.ual, assertionVersion: vm.scope.assertionVersion,
            publicQuadsDigest: vm.publicQuadsDigest, publicTripleCount: vm.envelope.publicTripleCount,
            privateTripleCount: vm.envelope.privateTripleCount,
            privateMerkleRoot: vm.envelope.privateMerkleRoot ? ethers.hexlify(vm.envelope.privateMerkleRoot) : undefined },
          merkleRoot: vm.envelope.merkleRoot, publisherAddress: snapshot.latestPublisher,
          kaId, batchId: kaId, onChainContextGraphId: boundCg, subGraphName: input.subGraphName,
        });
        if (receipt.status !== 'recovered') return refuse(receipt.reason);
        const e = receipt.evidence;
        if (!await host.chain.isReceiptBlockFinalAndCanonical?.({
          txHash: e.transactionHash as `0x${string}`, blockNumber: e.blockNumber, blockHash: e.blockHash as `0x${string}`,
        }, { signal })) return refuse('receipt is not final and canonical');
        const author = await incompleteNamedKaLifecycleAuthor(host.store, {
          ...input, kaNumber: scope.kaNumber, assertionVersion: vm.scope.assertionVersion,
          sealMerkleRoot: snapshot.latestRoot,
        }, scope.agentAddress, { allowPublishedState: true });
        // A new confirmed block is normal during verification. Re-read the asset,
        // rather than requiring the earlier snapshot's header lease to remain current.
        const current = await host.chain.readKnowledgeAssetVersionSnapshot?.(kaId, { signal });
        if (!current || current.blockNumber < snapshot.blockNumber
          || (current.blockNumber === snapshot.blockNumber && current.blockHash !== snapshot.blockHash)
          || current.rootCount !== snapshot.rootCount
          || current.latestRoot.toLowerCase() !== snapshot.latestRoot.toLowerCase()
          || current.latestAuthor.toLowerCase() !== snapshot.latestAuthor.toLowerCase()
          || current.latestPublisher.toLowerCase() !== snapshot.latestPublisher.toLowerCase()
          || current.knowledgeAssetStorageAddress !== snapshot.knowledgeAssetStorageAddress
          || current.knowledgeAssetStorageGeneration !== snapshot.knowledgeAssetStorageGeneration) {
          return refuse('chain version or storage binding changed during verification');
        }
        return { author, root: snapshot.latestRoot, assertionVersion: vm.scope.assertionVersion,
          transactionHash: e.transactionHash };
      })();
      signal.throwIfAborted();
      if (input.dryRun === false) {
        // Once the existing writer is entered, never abandon its mutation on timeout.
        writeEntered = true;
        await host.stampPublishedLifecycle({ contextGraphId: input.contextGraphId, name: input.name,
          agentAddress: verified.author, subGraphName: input.subGraphName,
          publishedUal: scope.ual, merkleRoot: verified.root, packedKaId: kaId, preserveVerifiedVmProof: true });
      }
      return { status: input.dryRun === false ? 'repaired' as const : 'verified' as const,
        ...verified, kaUal: scope.ual };
    });
    const result = await resolveWithinAbort(() => work, signal);
    if (result) return result;
    if (writeEntered) return await work;
    // The queued callback checks cancellation before reading or writing. Keep its gate
    // and store-wide backpressure until a stalled predecessor/read actually settles.
    abandonedRead = work;
    return refuse('verification deadline exceeded');
  } finally {
    // A timed-out read cannot mutate. Keep backpressure until even its underlying reads settle.
    if (abandonedRead) void abandonedRead.then(() => active.delete(host.store), () => active.delete(host.store));
    else active.delete(host.store);
  }
}
