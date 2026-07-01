/**
 * CLI publisher V10 ACK-provider construction — an intentionally-internal module
 * boundary (#1404).
 *
 * Extracted from `publisher-runner.ts` so the ACK-provider wiring has a STABLE,
 * deliberately-importable contract: production construction routes through the
 * centralized `createProductionACKCollector` factory (which owns the core-peer
 * readiness gate), and `test/publisher-runner-ack-readiness.test.ts` can pin that
 * routing by importing from HERE rather than forcing the runner module to export
 * a private helper purely for tests. Not re-exported from the package entry point
 * — this is an internal wiring seam, not a product surface.
 */
import {
  createProductionACKCollector,
  wrapAsRpcPreconditionIfApplicable,
  type DKGPublisher,
  type PublishOptions,
} from '@origintrail-official/dkg-publisher';

/**
 * The node-side transport surface the ACK provider needs: gossip + direct-P2P
 * send, the connected-core-peer snapshot the readiness gate polls, and an
 * optional log sink. Supplied by the running daemon via `ackTransportFactory`.
 */
export interface ACKTransportFactory {
  publisherPeerId: string;
  gossipPublish: (topic: string, data: Uint8Array) => Promise<void>;
  sendP2P: (peerId: string, protocol: string, data: Uint8Array) => Promise<Uint8Array>;
  getConnectedCorePeers: () => string[];
  log?: (message: string) => void;
}

export function createV10ACKProviderForPublisher(
  publisher: DKGPublisher,
  transport?: ACKTransportFactory,
): PublishOptions['v10ACKProvider'] | undefined {
  if (!transport) return undefined;
  const chain = (publisher as unknown as {
    chain?: {
      isV10Ready?: () => boolean;
      verifyACKIdentity?: (recoveredAddress: string, claimedIdentityId: bigint) => Promise<boolean>;
      verifyACKIdentityDetailed?: (
        recoveredAddress: string,
        claimedIdentityId: bigint,
      ) => Promise<{ valid: boolean; reason?: 'key-not-registered' | 'not-in-sharding-table' | 'rpc-error' }>;
      getMinimumRequiredSignatures?: () => Promise<number>;
      getEvmChainId?: () => Promise<bigint>;
      getKnowledgeAssetsLifecycleAddress?: () => Promise<string>;
    };
  }).chain;
  // `isV10Ready()` is the authoritative capability gate — rejects
  // NoChainAdapter (returns false) and unresolved EVM adapters.
  if (!chain?.isV10Ready?.()) return undefined;
  if (typeof chain.verifyACKIdentity !== 'function') return undefined;
  // The H5 prefix requires both a numeric chain id AND the deployed KAV10
  // address. Without them the collector cannot build a digest that matches
  // what core-node handlers sign, so refuse to hand back a provider at all.
  if (typeof chain.getEvmChainId !== 'function') return undefined;
  if (typeof chain.getKnowledgeAssetsLifecycleAddress !== 'function') return undefined;

  const collector = createProductionACKCollector({
    gossipPublish: transport.gossipPublish,
    sendP2P: transport.sendP2P,
    getConnectedCorePeers: transport.getConnectedCorePeers,
    verifyIdentity: async (recoveredAddress: string, claimedIdentityId: bigint) => chain.verifyACKIdentity!(recoveredAddress, claimedIdentityId),
    // Prefer the structured verifier when the chain adapter exposes it
    // so the rejection log can report the specific failing gate.
    ...(typeof chain.verifyACKIdentityDetailed === 'function' ? {
      verifyIdentityDetailed: async (recoveredAddress: string, claimedIdentityId: bigint) =>
        chain.verifyACKIdentityDetailed!(recoveredAddress, claimedIdentityId),
    } : {}),
    log: transport.log,
  });

  return async (
    merkleRoot,
    contextGraphId,
    kaCount,
    rootEntities,
    publicByteSize,
    stagingQuads,
    epochs,
    tokenAmount,
    swmGraphId,
    subGraphName,
    merkleLeafCount,
    isEncryptedPayload,
    catalogCommitment,
  ) => {
    // Fail loud on non-numeric or non-positive CG ids. V10 publish requires
    // a real on-chain context graph; `ZeroContextGraphId` at
    // `KnowledgeAssetsV10.sol:379` rejects cgId 0 on chain. Reject `<= 0n`
    // rather than `=== 0n` so `BigInt("-1") === -1n` is caught here instead
    // of dying in ethers' uint256 encoder inside the evm-adapter.
    // `contextGraphId` here is the TARGET on-chain numeric id; `swmGraphId`
    // (optional) is the source SWM graph name and is NOT required to be
    // numeric.
    let cgIdBigInt: bigint;
    try {
      cgIdBigInt = BigInt(contextGraphId);
    } catch {
      throw new Error(
        `Async V10 publish requires a numeric on-chain context graph id; ` +
        `got '${contextGraphId}'. Register the CG on-chain via ContextGraphs.createContextGraph first.`,
      );
    }
    if (cgIdBigInt <= 0n) {
      throw new Error(
        `Async V10 publish requires a positive on-chain context graph id; got ${cgIdBigInt}. ` +
        `Register the CG on-chain via ContextGraphs.createContextGraph first.`,
      );
    }
    if (!Number.isInteger(merkleLeafCount) || merkleLeafCount < 1) {
      throw new Error(
        `Async V10 publish requires a positive integer merkleLeafCount; got ${merkleLeafCount}. ` +
        'Publishers must pass the V10 flat-KC leaf count computed by V10MerkleTree.',
      );
    }
    // PR3 / RC11: wrap each chain pre-flight read in its own try/catch
    // so a failure is promoted to the typed `RpcPreconditionError`
    // (rather than the opaque "V10 ACK collection failed" string).
    // Mirrors the agent-side V10 ACK provider in
    // `dkg-agent.ts:createV10ACKProvider` so the daemon log surfaces
    // the same shape regardless of which entry point produced the
    // publish. `wrapAsRpcPreconditionIfApplicable` is a no-op when
    // the error is already typed.
    let requiredACKs: number | undefined;
    if (typeof chain.getMinimumRequiredSignatures === 'function') {
      try {
        requiredACKs = await chain.getMinimumRequiredSignatures();
      } catch (err) {
        throw wrapAsRpcPreconditionIfApplicable(err, 'getMinimumRequiredSignatures');
      }
    }
    let chainIdBig: bigint;
    try {
      chainIdBig = await chain.getEvmChainId!();
    } catch (err) {
      throw wrapAsRpcPreconditionIfApplicable(err, 'getEvmChainId');
    }
    let kav10Address: string;
    try {
      kav10Address = await chain.getKnowledgeAssetsLifecycleAddress!();
    } catch (err) {
      throw wrapAsRpcPreconditionIfApplicable(err, 'getKnowledgeAssetsLifecycleAddress');
    }
    const result = await collector.collect({
      merkleRoot,
      contextGraphId: cgIdBigInt,
      contextGraphIdStr: contextGraphId,
      publisherPeerId: transport.publisherPeerId,
      publicByteSize,
      isPrivate: isEncryptedPayload === true,
      kaCount,
      rootEntities,
      chainId: chainIdBig,
      kav10Address,
      requiredACKs,
      stagingQuads,
      epochs,
      tokenAmount,
      swmGraphId,
      subGraphName,
      merkleLeafCount,
      isEncryptedPayload,
      catalogCommitment,
    });
    return result.acks;
  };
}
