import { assertSafeIri, contextGraphMetaUri } from '@origintrail-official/dkg-core';
import type { ChainAdapter } from '@origintrail-official/dkg-chain';
import type { Quad, TripleStore } from '@origintrail-official/dkg-storage';
import {
  readGraphKnowledgeAssetReceiptProvenanceV1,
  readLocallyTrustedKnowledgeAssetControlEnvelope,
  type KnowledgeAssetWorkspaceHead,
} from '@origintrail-official/dkg-publisher';
import { ethers } from 'ethers';
import {
  VerifiedGraphScopedFinalizationEvidenceCodec,
  type VerifiedGraphScopedFinalizationEvidence,
} from './finalization-graph-envelope.js';

const DKG_NS = 'http://dkg.io/ontology/';

export type ReceiptBackedGraphScopedEvidenceRecovery =
  | { status: 'recovered'; evidence: VerifiedGraphScopedFinalizationEvidence }
  | { status: 'unavailable'; reason: string };

export interface RecoverReceiptBackedGraphScopedEvidenceInput {
  store: TripleStore;
  chain?: ChainAdapter;
  contextGraphId: string;
  scope: { ual: string; assertionVersion: string };
  head: KnowledgeAssetWorkspaceHead;
  merkleRoot: Uint8Array;
  publisherAddress: string;
  kaId: bigint;
  onChainContextGraphId: bigint;
  subGraphName?: string;
}

function anchorQuads(input: RecoverReceiptBackedGraphScopedEvidenceInput): Quad[] {
  const graph = contextGraphMetaUri(input.contextGraphId);
  return [
    {
      subject: input.scope.ual,
      predicate: `${DKG_NS}assertionVersion`,
      object: `"${input.scope.assertionVersion}"^^<http://www.w3.org/2001/XMLSchema#integer>`,
      graph,
    },
    {
      subject: input.scope.ual,
      predicate: `${DKG_NS}merkleRoot`,
      object: `"${ethers.hexlify(input.merkleRoot).slice(2)}"`,
      graph,
    },
  ];
}

/**
 * Recover receipt provenance when the mutable SWM controls were recorded locally
 * after authenticated envelope admission. For a chain-confirmed public CG, the
 * on-chain access policy is also sufficient: public reads do not depend on a
 * publisher peer identity or allow-list. Private CGs continue to require the
 * authenticated local sidecar and fail closed when it is unavailable.
 */
export async function recoverReceiptBackedGraphScopedEvidence(
  input: RecoverReceiptBackedGraphScopedEvidenceInput,
): Promise<ReceiptBackedGraphScopedEvidenceRecovery> {
  let assertionVersion: bigint;
  try {
    assertionVersion = BigInt(input.scope.assertionVersion);
    if (assertionVersion <= 0n) throw new Error('non-positive assertion version');
  } catch {
    return { status: 'unavailable', reason: 'target assertion version is invalid' };
  }
  const publishResolver = input.chain?.resolveCanonicalFinalizationReceipt;
  const updateVerifier = input.chain?.verifyKAUpdate;
  const rootCountReader = input.chain?.getMerkleRootCount;
  if (
    !input.chain
    || input.chain.chainId === 'none'
    || !rootCountReader
    || (assertionVersion === 1n ? !publishResolver : !updateVerifier)
  ) return { status: 'unavailable', reason: 'canonical receipt recovery is unsupported' };

  if (
    input.head.kaUal !== input.scope.ual
    || input.head.assertionVersion !== input.scope.assertionVersion
  ) return { status: 'unavailable', reason: 'workspace head does not match the target assertion' };

  let metaGraph: string;
  let safeUal: string;
  try {
    metaGraph = assertSafeIri(contextGraphMetaUri(input.contextGraphId));
    safeUal = assertSafeIri(input.scope.ual);
  } catch {
    return { status: 'unavailable', reason: 'context graph or UAL is not a safe IRI' };
  }
  const candidate = await input.store.query(
    `SELECT ?predicate ?object WHERE {
      GRAPH <${metaGraph}> { <${safeUal}> ?predicate ?object }
    }`,
    { source: 'agent.finalization.recoverReceiptBackedEvidence' },
  );
  if (
    candidate.type !== 'bindings'
    || candidate.bindings.some((row) => (
      row['predicate'] === undefined || row['object'] === undefined
    ))
  ) {
    return { status: 'unavailable', reason: 'stored receipt metadata is incomplete' };
  }
  const receiptProvenance = readGraphKnowledgeAssetReceiptProvenanceV1(
    candidate.bindings.map((row) => ({
      predicate: row['predicate']!,
      object: row['object']!,
    })),
  );
  if (!receiptProvenance) {
    return { status: 'unavailable', reason: 'stored receipt claim is invalid' };
  }
  const { transactionHash } = receiptProvenance;

  try {
    const [receiptAuthority, rootCount, trustedControls] = await Promise.all([
      assertionVersion === 1n
        ? publishResolver!.call(input.chain, transactionHash)
        : updateVerifier!.call(
            input.chain,
            transactionHash,
            input.kaId,
            input.publisherAddress,
          ),
      rootCountReader.call(input.chain, input.kaId),
      readLocallyTrustedKnowledgeAssetControlEnvelope(
        input.store,
        metaGraph,
        input.scope.ual,
        anchorQuads(input),
        { source: 'agent.finalization.recoverReceiptBackedEvidence.controls' },
      ),
    ]);
    if (rootCount !== assertionVersion) {
      return { status: 'unavailable', reason: 'canonical receipt or target assertion root is unavailable' };
    }
    let controls = trustedControls;
    if (!controls) {
      const getAccessPolicy = input.chain.getContextGraphAccessPolicy;
      const isActiveOnChain = input.chain.isContextGraphActiveOnChain;
      if (
        input.onChainContextGraphId <= 0n
        || !isActiveOnChain
        || !getAccessPolicy
      ) {
        return {
          status: 'unavailable',
          reason: 'authenticated local SWM controls and active on-chain public policy are unavailable',
        };
      }
      const activeOnChain = await isActiveOnChain.call(
        input.chain,
        input.onChainContextGraphId,
      );
      if (!activeOnChain) {
        return {
          status: 'unavailable',
          reason: 'on-chain context graph is not active',
        };
      }
      const onChainAccessPolicy = Number(await getAccessPolicy.call(
        input.chain,
        input.onChainContextGraphId,
      ));
      if (onChainAccessPolicy !== 0) {
        return {
          status: 'unavailable',
          reason: 'authenticated local SWM controls are required for a non-public context graph',
        };
      }
      controls = {
        accessPolicy: 'public',
        allowedPeers: [],
        // Public access does not authorize through this value. Preserve an
        // explicit non-empty sentinel rather than trusting peer-supplied SWM.
        publisherPeerId: 'unknown',
      };
    }
    let receipt: {
      txHash: string;
      blockNumber: number;
      blockHash: string;
      txIndex: number;
      merkleRoot: Uint8Array;
      publisherAddress: string;
      authorAddress?: string;
    };
    if (assertionVersion === 1n) {
      if (!('status' in receiptAuthority) || receiptAuthority.status !== 'confirmed') {
        return { status: 'unavailable', reason: 'canonical publish receipt is unavailable' };
      }
      const canonical = receiptAuthority.receipt;
      if (
        canonical.txHash.toLowerCase() !== transactionHash.toLowerCase()
        || canonical.kaId !== input.kaId
        || canonical.batchId !== input.kaId
        || canonical.startKAId !== input.kaId
        || canonical.endKAId !== input.kaId
      ) return { status: 'unavailable', reason: 'canonical publish receipt does not match the target KA' };
      receipt = canonical;
    } else {
      if (
        !('verified' in receiptAuthority)
        || !receiptAuthority.verified
        || receiptAuthority.onChainMerkleRoot === undefined
        || receiptAuthority.merkleRootCount !== assertionVersion
        || receiptAuthority.blockNumber === undefined
        || receiptAuthority.blockHash === undefined
        || receiptAuthority.txIndex === undefined
      ) return { status: 'unavailable', reason: 'canonical update receipt does not match the target assertion' };
      receipt = {
        txHash: transactionHash,
        blockNumber: receiptAuthority.blockNumber,
        blockHash: receiptAuthority.blockHash,
        txIndex: receiptAuthority.txIndex,
        merkleRoot: receiptAuthority.onChainMerkleRoot,
        publisherAddress: input.publisherAddress,
      };
    }
    if (
      !ethers.isHexString(receipt.blockHash, 32)
      || !ethers.isAddress(input.publisherAddress)
      || !ethers.isAddress(receipt.publisherAddress)
      || ethers.getAddress(receipt.publisherAddress) !== ethers.getAddress(input.publisherAddress)
      || !Number.isSafeInteger(receipt.blockNumber)
      || receipt.blockNumber < 0
      || !Number.isSafeInteger(receipt.txIndex)
      || receipt.txIndex < 0
      || ethers.hexlify(receipt.merkleRoot).toLowerCase()
        !== ethers.hexlify(input.merkleRoot).toLowerCase()
    ) return { status: 'unavailable', reason: 'canonical receipt does not match the target assertion' };

    const evidence = VerifiedGraphScopedFinalizationEvidenceCodec.parse({
      assertionVersion: input.scope.assertionVersion,
      publicQuadsDigest: input.head.publicQuadsDigest,
      publicTripleCount: input.head.publicTripleCount,
      ...(input.head.privateMerkleRoot
        ? { privateMerkleRoot: input.head.privateMerkleRoot }
        : {}),
      privateTripleCount: input.head.privateTripleCount,
      publisherPeerId: controls.publisherPeerId,
      publisherAddress: receipt.publisherAddress,
      transactionHash: receipt.txHash,
      blockNumber: receipt.blockNumber,
      blockHash: receipt.blockHash,
      txIndex: receipt.txIndex,
      ...(receipt.authorAddress ? { authorAddress: receipt.authorAddress } : {}),
      accessPolicy: controls.accessPolicy,
      allowedPeers: controls.allowedPeers,
      ...(input.subGraphName ? { subGraphName: input.subGraphName } : {}),
    });
    return { status: 'recovered', evidence };
  } catch (error) {
    return {
      status: 'unavailable',
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
