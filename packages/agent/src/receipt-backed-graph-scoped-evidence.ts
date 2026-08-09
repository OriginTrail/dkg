import { assertSafeIri, contextGraphMetaUri } from '@origintrail-official/dkg-core';
import type { ChainAdapter } from '@origintrail-official/dkg-chain';
import type { Quad, TripleStore } from '@origintrail-official/dkg-storage';
import {
  readLocallyTrustedKnowledgeAssetControls,
  type KnowledgeAssetWorkspaceHead,
} from '@origintrail-official/dkg-publisher';
import { ethers } from 'ethers';
import {
  VerifiedGraphScopedFinalizationEvidenceCodec,
  type GraphScopedAccessPolicy,
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
  subGraphName?: string;
}

function stripRdfLiteral(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (!value.startsWith('"')) return value;
  const lexical = /^("(?:\\.|[^"\\])*")/.exec(value)?.[1];
  if (!lexical) return undefined;
  try {
    return JSON.parse(lexical) as string;
  } catch {
    return undefined;
  }
}

function uniqueControlValue(rows: readonly Quad[], predicate: string): string | undefined {
  const values = [...new Set(rows
    .filter((quad) => quad.predicate === predicate)
    .map((quad) => stripRdfLiteral(quad.object))
    .filter((value): value is string => value !== undefined && value.length > 0))];
  return values.length === 1 ? values[0] : undefined;
}

function trustedAccessEnvelope(rows: readonly Quad[]): {
  accessPolicy: GraphScopedAccessPolicy;
  allowedPeers: string[];
  publisherPeerId: string;
} | undefined {
  const accessPolicy = uniqueControlValue(rows, `${DKG_NS}accessPolicy`);
  const publisherPeerId = uniqueControlValue(rows, `${DKG_NS}publisherPeerId`);
  if (
    (accessPolicy !== 'public' && accessPolicy !== 'ownerOnly' && accessPolicy !== 'allowList')
    || !publisherPeerId
  ) return undefined;
  const allowedPeers = [...new Set(rows
    .filter((quad) => quad.predicate === `${DKG_NS}allowedPeer`)
    .map((quad) => stripRdfLiteral(quad.object))
    .filter((value): value is string => value !== undefined && value.length > 0))];
  if (
    (accessPolicy === 'allowList' && allowedPeers.length === 0)
    || (accessPolicy !== 'allowList' && allowedPeers.length > 0)
  ) return undefined;
  return { accessPolicy, allowedPeers, publisherPeerId };
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
 * Recover receipt provenance only when the mutable SWM controls were recorded
 * locally after authenticated envelope admission. The chain authenticates the
 * KA identity and root; the local sidecar authenticates policy and peer identity.
 */
export async function recoverReceiptBackedGraphScopedEvidence(
  input: RecoverReceiptBackedGraphScopedEvidenceInput,
): Promise<ReceiptBackedGraphScopedEvidenceRecovery> {
  const resolver = input.chain?.resolveCanonicalFinalizationReceipt;
  const rootCountReader = input.chain?.getMerkleRootCount;
  if (
    !input.chain
    || input.chain.chainId === 'none'
    || !resolver
    || !rootCountReader
    || input.scope.assertionVersion !== '1'
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
    `SELECT ?tx ?kind WHERE {
      GRAPH <${metaGraph}> {
        <${safeUal}> <${DKG_NS}transactionHash> ?tx ;
          <${DKG_NS}confirmationKind> ?kind .
      }
    } LIMIT 2`,
    { source: 'agent.finalization.recoverReceiptBackedEvidence' },
  );
  if (candidate.type !== 'bindings' || candidate.bindings.length !== 1) {
    return { status: 'unavailable', reason: 'exactly one receipt claim is required' };
  }
  const transactionHash = stripRdfLiteral(candidate.bindings[0]?.['tx']);
  const confirmationKind = stripRdfLiteral(candidate.bindings[0]?.['kind']);
  if (
    confirmationKind !== 'transaction'
    || !transactionHash
    || !ethers.isHexString(transactionHash, 32)
  ) return { status: 'unavailable', reason: 'stored receipt claim is invalid' };

  try {
    const [resolution, rootCount, trustedRows] = await Promise.all([
      resolver.call(input.chain, transactionHash),
      rootCountReader.call(input.chain, input.kaId),
      readLocallyTrustedKnowledgeAssetControls(
        input.store,
        metaGraph,
        input.scope.ual,
        anchorQuads(input),
        { source: 'agent.finalization.recoverReceiptBackedEvidence.controls' },
      ),
    ]);
    if (resolution.status !== 'confirmed' || rootCount !== 1n) {
      return { status: 'unavailable', reason: 'canonical receipt or unique root is unavailable' };
    }
    const controls = trustedAccessEnvelope(trustedRows);
    if (!controls) {
      return { status: 'unavailable', reason: 'authenticated local SWM controls are unavailable' };
    }
    const { receipt } = resolution;
    if (
      receipt.txHash.toLowerCase() !== transactionHash.toLowerCase()
      || receipt.kaId !== input.kaId
      || receipt.batchId !== input.kaId
      || receipt.startKAId !== input.kaId
      || receipt.endKAId !== input.kaId
      || !ethers.isHexString(receipt.blockHash, 32)
      || !ethers.isAddress(input.publisherAddress)
      || !ethers.isAddress(receipt.publisherAddress)
      || ethers.getAddress(receipt.publisherAddress) !== ethers.getAddress(input.publisherAddress)
      || !Number.isSafeInteger(receipt.blockNumber)
      || receipt.blockNumber < 0
      || !Number.isSafeInteger(receipt.txIndex)
      || receipt.txIndex < 0
      || ethers.hexlify(receipt.merkleRoot).toLowerCase()
        !== ethers.hexlify(input.merkleRoot).toLowerCase()
    ) return { status: 'unavailable', reason: 'canonical receipt does not match the target KA' };

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
