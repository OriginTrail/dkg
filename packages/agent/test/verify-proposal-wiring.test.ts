/**
 * VERIFY between real agents. A node with a signing key answers proposals from
 * its peers: only a proposal whose context graph id is a valid id gets as far
 * as the batch-root lookup in the node's store, which names the graph as an
 * IRI, and an approval is a signature over the digest bound to the chain, the
 * deployment, the context graph and the batch. A proposer signs the same
 * digest for its own vote and checks approvals against that domain.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import {
  PROTOCOL_VERIFY_PROPOSAL,
  RELIABLE_ENVELOPE_VERSION,
  computeVerifyApprovalDigest,
  contextGraphMetaGraphUri,
  decodeVerifyApproval,
  encodeReliableEnvelope,
  encodeVerifyProposal,
} from '@origintrail-official/dkg-core';
import { VerifyCollector } from '@origintrail-official/dkg-publisher';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { DKGAgent } from '../src/dkg-agent.js';

const agents: DKGAgent[] = [];
const BATCH_ROOT_SOURCE = 'agent.verifyProposal.batchMerkleRoot';
const CONTEXT_GRAPH = 'verify-proposal-wiring';
const ON_CHAIN_ID = 42n;
const BATCH_ID = 1n;
const ROOT = new Uint8Array(32).fill(0xab);

async function startedNode(name: string, nodeRole: 'core' | 'edge', ackSignerKey?: string): Promise<DKGAgent> {
  const agent = await DKGAgent.create({
    name,
    nodeRole,
    listenHost: '127.0.0.1',
    listenPort: 0,
    chainAdapter: new MockChainAdapter('mock:31337'),
    store: new OxigraphStore(),
    randomSamplingUseWorkerThread: false,
    ...(ackSignerKey ? { ackSignerKey } : {}),
  });
  agents.push(agent);
  await agent.start();
  return agent;
}

/** A batch of the test's context graph, as the node's `_meta` records it, on chain as context graph 42. */
async function holdBatch(agent: DKGAgent): Promise<void> {
  const kc = 'urn:test:verify-proposal-wiring:kc';
  await agent.store.insert([
    { subject: kc, predicate: 'http://dkg.io/ontology/merkleRoot', object: `"${ethers.hexlify(ROOT)}"`, graph: contextGraphMetaGraphUri(CONTEXT_GRAPH) },
    { subject: kc, predicate: 'http://dkg.io/ontology/batchId', object: `"${BATCH_ID}"^^<http://www.w3.org/2001/XMLSchema#integer>`, graph: contextGraphMetaGraphUri(CONTEXT_GRAPH) },
  ]);
  vi.spyOn(agent, 'getContextGraphOnChainId').mockResolvedValue(String(ON_CHAIN_ID));
}

/** The digest an approval of the test's batch is a signature over, in `agent`'s chain domain. */
async function boundDigest(agent: DKGAgent): Promise<Uint8Array> {
  const chain = (agent as unknown as { chain: MockChainAdapter }).chain;
  return computeVerifyApprovalDigest(
    await chain.getEvmChainId(), await chain.getKnowledgeAssetsLifecycleAddress(), ON_CHAIN_ID, BATCH_ID, ROOT,
  );
}

const signerOver = (digest: Uint8Array, r: Uint8Array, vs: Uint8Array) =>
  ethers.verifyMessage(digest, ethers.Signature.from({ r: ethers.hexlify(r), yParityAndS: ethers.hexlify(vs) }));

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(agents.splice(0).map((agent) => agent.stop().catch(() => undefined)));
});

describe('VERIFY proposals from a peer', () => {
  it('reach the batch-root lookup only with a valid context graph id, and are approved over the bound digest', async () => {
    const signer = ethers.Wallet.createRandom();
    const core = await startedNode('VerifyProposalWiringCore', 'core', signer.privateKey);
    const edge = await startedNode('VerifyProposalWiringEdge', 'edge');
    await edge.connectTo(core.multiaddrs.find((address) => address.includes('/tcp/') && !address.includes('/p2p-circuit'))!);
    expect(core.node.libp2p.getProtocols()).toContain(PROTOCOL_VERIFY_PROPOSAL);
    const query = vi.spyOn(core.store, 'query');
    const batchRootQueries = () => query.mock.calls
      .filter(([, options]) => (options as { source?: string } | undefined)?.source === BATCH_ROOT_SOURCE)
      .map(([sparql]) => sparql);
    let sequence = 0;
    const propose = (contextGraphId: string) => edge.router.send(core.peerId, PROTOCOL_VERIFY_PROPOSAL, encodeReliableEnvelope({
      messageId: `verify-proposal-wiring-${sequence++}`,
      version: RELIABLE_ENVELOPE_VERSION,
      tsMs: Date.now(),
      payload: encodeVerifyProposal({
        proposalId: new Uint8Array(16).fill(sequence),
        contextGraphId,
        verifiableMemoryId: 1,
        batchId: Number(BATCH_ID),
        merkleRoot: ROOT,
        entities: [],
        agentSignatureR: new Uint8Array(32),
        agentSignatureVS: new Uint8Array(32),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    }), 10_000);

    for (const invalid of ['verify proposal wiring', 'verify-proposal-wiring>', 'verify-proposal-wiring{}', 'a/../b']) {
      await expect(propose(invalid)).rejects.toThrow();
    }
    expect(batchRootQueries()).toEqual([]);

    // A valid id is looked up, with the graph as an IRI; it has no batch yet.
    await expect(propose(CONTEXT_GRAPH)).rejects.toThrow();
    const lookups = batchRootQueries();
    expect(lookups.length).toBeGreaterThan(0);
    for (const sparql of lookups) {
      expect(sparql).toContain(`GRAPH <did:dkg:context-graph:${CONTEXT_GRAPH}/_meta>`);
    }

    // Once the node holds the batch, it approves it over the digest bound to its chain and deployment.
    await holdBatch(core);
    const approval = decodeVerifyApproval(await propose(CONTEXT_GRAPH));
    expect(approval.approverAddress).toBe(signer.address);
    expect(signerOver(await boundDigest(core), approval.agentSignatureR, approval.agentSignatureVS)).toBe(signer.address);
  }, 60_000);
});

describe('a VERIFY proposer', () => {
  it('signs its own vote over the bound digest and collects approvals in its chain domain', async () => {
    const signer = ethers.Wallet.createRandom();
    const proposer = await startedNode('VerifyProposerDomain', 'core', signer.privateKey);
    await holdBatch(proposer);
    const collect = vi.spyOn(VerifyCollector.prototype, 'collect').mockResolvedValue({
      approvals: [], merkleRoot: ROOT, contextGraphId: CONTEXT_GRAPH, verifiableMemoryId: 1n,
      requiredRemoteApprovals: 1, quorumReached: false,
    });

    await proposer.verify({ contextGraphId: CONTEXT_GRAPH, verifiableMemoryId: '1', batchId: BATCH_ID, requiredSignatures: 2, timeoutMs: 1_000 });

    expect(collect).toHaveBeenCalledTimes(1);
    const [params] = collect.mock.calls[0]!;
    const chain = (proposer as unknown as { chain: MockChainAdapter }).chain;
    expect(params.signingDomain).toEqual({
      chainId: await chain.getEvmChainId(), contractAddress: await chain.getKnowledgeAssetsLifecycleAddress(),
    });
    expect(params).toMatchObject({ contextGraphIdOnChain: ON_CHAIN_ID, batchId: BATCH_ID });
    expect(signerOver(await boundDigest(proposer), params.proposerSignature.r, params.proposerSignature.vs)).toBe(signer.address);
  }, 60_000);
});
