// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AUTHOR_CATALOG_DIRECTORY_NODE_OBJECT_TYPE_V1,
  MemoryLayer,
  contextGraphLayerUri,
  contextGraphMetaUri,
  contextGraphWorkspaceMetaGraphUri,
} from '@origintrail-official/dkg-core';
import { verifyControlEnvelopeIssuerSignatureV1 } from '@origintrail-official/dkg-chain';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { ethers } from 'ethers';
import { produceEmptyAuthorCatalogGenesisV1 } from
  '../../src/rfc64/author-catalog-producer.ts';
import { mintRfc64CatalogNativeScopedReadCapabilityV1 } from
  '../../src/rfc64/catalog-native-scoped-read-capability-v1-internal.ts';
import {
  RFC64_PUBLIC_CATALOG_OBJECT_FETCH_KIND_V1,
  Rfc64PublicCatalogNativeTransportV1,
} from '../../src/rfc64/public-catalog-native-transport-v1.ts';
import {
  composeRfc64FinalizedCatalogAuthorityV1,
  parseRfc64AuthoritySnapshotV1,
} from '../../src/rfc64/release-native-catalog-authority-v1.ts';
import { Rfc64CatalogAccessPolicyRegistryV1 } from
  '../../src/rfc64/catalog-access-policy-v1.ts';
import {
  Rfc64PrivateDevnetChainAdapter,
  startRfc64PrivateDevnetFinalizedRpc,
} from './finalized-chain-fixture.mjs';
import {
  CONTEXT_GRAPH_STORAGE,
  CONTEXT_GRAPH_ID,
  NETWORK_ID,
  ON_CHAIN_CONTEXT_GRAPH_ID,
  ASSET_NUMBERS,
  PRIVATE_CATALOG_MEMORY_EXPECTATION,
  PROJECTION_EVIDENCE,
  PROJECTION_QUADS,
  UPDATED_PROJECTION_EVIDENCE,
  UPDATED_PROJECTION_QUADS,
  createFinalizedChainFixture,
  createPrivatePolicyAndRoster,
  createReceiverRevokedPolicyAndRoster,
  ownerWallet,
  privateCatalogSwmShareOperationId,
  roleAgentAddress,
} from './fixture.mjs';
import {
  AgentChild,
  EXPECTED_MEMORY_CONTENTS,
  hasExactMemoryContents,
  hasExactSourceSwmContents,
} from './run.mjs';
import {
  RFC64_PRIVATE_GATE_RPC_BUDGET_V1,
  isWithinRpcBudgetV1,
  isWithinRpcCeilingV1,
  rpcEvidenceV1,
} from './rpc-evidence.mjs';
import {
  createGateCommandFailureV1,
  sanitizeGateFailureV1,
} from './gate-artifact.mjs';
import {
  bindGraphlessProjectionToGraph,
  parsePrivateCatalogLiteralEvidenceV1,
  readPrivateCatalogGraphCountEvidence,
} from './memory-evidence.mjs';

class MemoryProtocolRouter {
  handlers = new Map();
  remote = null;

  constructor(peerId) {
    this.peerId = peerId;
  }

  register(protocol, handler) {
    this.handlers.set(protocol, handler);
  }

  unregister(protocol) {
    this.handlers.delete(protocol);
  }

  async send(_remotePeerId, protocol, data) {
    const handler = this.remote?.handlers.get(protocol);
    if (handler === undefined) throw new Error(`missing in-memory handler for ${protocol}`);
    return handler(data, { toString: () => this.peerId });
  }
}

function memoryRouterPair() {
  const provider = new MemoryProtocolRouter('provider-peer');
  const receiver = new MemoryProtocolRouter('receiver-peer');
  provider.remote = receiver;
  receiver.remote = provider;
  return [provider, receiver];
}

async function seedExpectedPrivateMemory(store) {
  const authorAddress = roleAgentAddress('owner');
  for (const kaNumber of ASSET_NUMBERS) {
    const kaUal = `did:dkg:${NETWORK_ID}/${authorAddress}/${kaNumber}`;
    const swmGraph = contextGraphLayerUri(
      CONTEXT_GRAPH_ID,
      MemoryLayer.SharedWorkingMemory,
      authorAddress,
      kaNumber,
    );
    const vmGraph = contextGraphLayerUri(
      CONTEXT_GRAPH_ID,
      MemoryLayer.VerifiableMemory,
      authorAddress,
      kaNumber,
    );
    await store.insert([
      ...bindGraphlessProjectionToGraph(UPDATED_PROJECTION_QUADS, swmGraph),
      ...bindGraphlessProjectionToGraph(PROJECTION_QUADS, vmGraph),
      {
        subject: `${kaUal}#dkg-swm-head`,
        predicate: 'http://dkg.io/ontology/assertionVersion',
        object: '"2"',
        graph: contextGraphWorkspaceMetaGraphUri(CONTEXT_GRAPH_ID),
      },
      {
        subject: `${kaUal}#dkg-swm-head`,
        predicate: 'http://dkg.io/ontology/assertionGraph',
        object: swmGraph,
        graph: contextGraphWorkspaceMetaGraphUri(CONTEXT_GRAPH_ID),
      },
      {
        subject: `${kaUal}#dkg-swm-head`,
        predicate: 'http://dkg.io/ontology/shareOperationId',
        object: `"${privateCatalogSwmShareOperationId(kaNumber)}"`,
        graph: contextGraphWorkspaceMetaGraphUri(CONTEXT_GRAPH_ID),
      },
      {
        subject: kaUal,
        predicate: 'http://dkg.io/ontology/assertionVersion',
        object: '"1"',
        graph: contextGraphMetaUri(CONTEXT_GRAPH_ID),
      },
      {
        subject: kaUal,
        predicate: 'http://dkg.io/ontology/assertionGraph',
        object: vmGraph,
        graph: contextGraphMetaUri(CONTEXT_GRAPH_ID),
      },
    ]);
  }
}

function privateMemoryEvidence(store) {
  return readPrivateCatalogGraphCountEvidence(store, {
    assetNumbers: ASSET_NUMBERS,
    authorAddress: roleAgentAddress('owner'),
    contextGraphId: CONTEXT_GRAPH_ID,
    networkId: NETWORK_ID,
  });
}

test('memory evidence distinguishes finalized VM v1 from newer SWM v2', async () => {
  const graphCounts = ASSET_NUMBERS.map((kaNumber) => ({
    kaNumber,
    swm: UPDATED_PROJECTION_EVIDENCE.count,
    swmDigest: UPDATED_PROJECTION_EVIDENCE.digest,
    swmGraph: `swm:${kaNumber}`,
    swmHead: {
      assertionVersion: '2',
      assertionGraph: `swm:${kaNumber}`,
      shareOperationId: privateCatalogSwmShareOperationId(kaNumber),
    },
    vm: PROJECTION_EVIDENCE.count,
    vmDigest: PROJECTION_EVIDENCE.digest,
    vmGraph: `vm:${kaNumber}`,
    vmHead: {
      assertionVersion: '1',
      assertionGraph: `vm:${kaNumber}`,
    },
  }));
  assert.equal(EXPECTED_MEMORY_CONTENTS.swm.assertionVersion, '2');
  assert.equal(EXPECTED_MEMORY_CONTENTS.vm.assertionVersion, '1');
  assert.equal(EXPECTED_MEMORY_CONTENTS, PRIVATE_CATALOG_MEMORY_EXPECTATION);
  assert.equal(hasExactSourceSwmContents({ graphCounts }), true);
  assert.equal(hasExactMemoryContents({ graphCounts }), true);
  const corruptions = [
    (evidence) => ({
      ...evidence,
      swmHead: { ...evidence.swmHead, assertionVersion: '1' },
    }),
    (evidence) => ({
      ...evidence,
      vmHead: { ...evidence.vmHead, assertionVersion: '2' },
    }),
    (evidence) => ({
      ...evidence,
      swmHead: { ...evidence.swmHead, assertionGraph: 'urn:wrong:swm' },
    }),
    (evidence) => ({
      ...evidence,
      vmHead: { ...evidence.vmHead, assertionGraph: 'urn:wrong:vm' },
    }),
    (evidence) => ({
      ...evidence,
      swmHead: { ...evidence.swmHead, shareOperationId: 'wrong-operation' },
    }),
    (evidence) => ({
      ...evidence,
      swmDigest: PROJECTION_EVIDENCE.digest,
    }),
  ];
  for (const corrupt of corruptions) {
    assert.equal(hasExactMemoryContents({
      graphCounts: graphCounts.map((evidence, index) => (
        index === 0 ? corrupt(evidence) : evidence
      )),
    }), false);
  }

  assert.equal(
    parsePrivateCatalogLiteralEvidenceV1('"line\\nvalue"'),
    'line\nvalue',
  );
  assert.equal(parsePrivateCatalogLiteralEvidenceV1('"unterminated'), null);
  assert.equal(parsePrivateCatalogLiteralEvidenceV1('urn:not-a-literal'), null);

  const store = new OxigraphStore();
  const authorAddress = roleAgentAddress('owner');
  try {
    await seedExpectedPrivateMemory(store);
    const storeEvidence = await privateMemoryEvidence(store);
    assert.equal(hasExactMemoryContents({ graphCounts: storeEvidence }), true);
    await assert.rejects(
      readPrivateCatalogGraphCountEvidence(store, {
        assetNumbers: ASSET_NUMBERS,
        authorAddress,
        contextGraphId: CONTEXT_GRAPH_ID,
      }),
      /networkId is required/u,
    );
  } finally {
    await store.close();
  }
});

test('real catalog pull is denied after roster revocation without changing committed memory', async () => {
  const configured = createPrivatePolicyAndRoster();
  const wallet = ownerWallet();
  const produced = await produceEmptyAuthorCatalogGenesisV1({
    scope: {
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      governanceChainId: null,
      governanceContractAddress: null,
      ownershipTransitionDigest: null,
      subGraphName: 'private-release-gate',
      authorAddress: wallet.address.toLowerCase(),
      era: '0',
      bucketCount: '1',
    },
    catalogIssuerDelegationDigest: `0x${'74'.repeat(32)}`,
    issuedAt: '1773900000000',
    signer: {
      issuer: wallet.address.toLowerCase(),
      signDigest: async (digest) => wallet.signMessage(digest),
    },
  });
  const catalogObjects = new Map(
    produced.stagedObjects.map((envelope) => [envelope.objectDigest, envelope]),
  );
  const scope = Object.freeze({
    networkId: produced.head.payload.networkId,
    contextGraphId: produced.head.payload.contextGraphId,
    subGraphName: produced.head.payload.subGraphName,
    authorAddress: produced.head.payload.authorAddress,
    catalogEra: produced.head.payload.era,
    catalogVersion: produced.head.payload.version,
    policyDigest: configured.policyDigest,
    catalogHeadObjectDigest: produced.head.objectDigest,
  });
  const providerRegistry = new Rfc64CatalogAccessPolicyRegistryV1({
    localAgentAddress: roleAgentAddress('provider2'),
    resolveRemoteAgentAddress: async () => roleAgentAddress('receiver'),
  });
  const receiverRegistry = new Rfc64CatalogAccessPolicyRegistryV1({
    localAgentAddress: roleAgentAddress('receiver'),
    resolveRemoteAgentAddress: async () => roleAgentAddress('provider2'),
  });
  for (const registry of [providerRegistry, receiverRegistry]) {
    registry.acceptCurrent({
      policy: configured.policy,
      policyDigest: configured.policyDigest,
      roster: configured.roster,
    });
  }

  const [providerRouter, receiverRouter] = memoryRouterPair();
  let catalogReads = 0;
  const provider = new Rfc64PublicCatalogNativeTransportV1(providerRouter, {
    resolveScopedReadCapability: async (requestedScope) => (
      mintRfc64CatalogNativeScopedReadCapabilityV1({
        scope: requestedScope,
        readCatalogObjectByDigest: async (digest) => {
          catalogReads += 1;
          return catalogObjects.get(digest) ?? null;
        },
        readKaBundleByDigest: async () => null,
      })
    ),
    authorizeCatalogOperation: providerRegistry.authorize,
    verifyIssuerSignature: verifyControlEnvelopeIssuerSignatureV1,
  });
  const receiver = new Rfc64PublicCatalogNativeTransportV1(receiverRouter, {
    readCatalogObjectByDigest: async () => null,
    readKaBundleByDigest: async () => null,
    authorizeCatalogOperation: receiverRegistry.authorize,
    verifyIssuerSignature: verifyControlEnvelopeIssuerSignatureV1,
  });
  const store = new OxigraphStore();
  provider.start();
  receiver.start();
  try {
    await seedExpectedPrivateMemory(store);
    const memoryBeforeRevocation = await privateMemoryEvidence(store);
    const root = produced.directoryPath[0];
    const request = {
      ...scope,
      kind: RFC64_PUBLIC_CATALOG_OBJECT_FETCH_KIND_V1,
      targetObjectType: AUTHOR_CATALOG_DIRECTORY_NODE_OBJECT_TYPE_V1,
      targetObjectDigest: root.objectDigest,
    };
    const fetched = await receiver.fetchCatalogObject(providerRouter.peerId, request);
    assert.equal(fetched.envelope.objectDigest, root.objectDigest);
    assert.equal(catalogReads, 1);

    const revoked = createReceiverRevokedPolicyAndRoster();
    providerRegistry.acceptAuthoritativeCurrent({
      policy: revoked.policy,
      policyDigest: revoked.policyDigest,
      roster: revoked.roster,
    });
    await assert.rejects(
      receiver.fetchCatalogObject(providerRouter.peerId, request),
      (error) => error?.code === 'catalog-native-policy-denied',
    );
    assert.equal(catalogReads, 1);
    const memoryAfterRevocation = await privateMemoryEvidence(store);
    assert.deepEqual(memoryAfterRevocation, memoryBeforeRevocation);
    assert.equal(hasExactMemoryContents({ graphCounts: memoryAfterRevocation }), true);
  } finally {
    receiver.stop();
    provider.stop();
    await store.close();
  }
});

test('the deterministic chain snapshot exactly matches bootstrap authority and advances revocation', async () => {
  const fixture = createFinalizedChainFixture();
  const adapter = new Rfc64PrivateDevnetChainAdapter(fixture);
  const contextGraphId = BigInt(ON_CHAIN_CONTEXT_GRAPH_ID);
  await adapter.createOnChainContextGraph({
    accessPolicy: fixture.accessPolicy,
    publishPolicy: fixture.publishPolicy,
    publishAuthority: fixture.publishAuthority,
    publishAuthorityAccountId: BigInt(fixture.publishAuthorityAccountId),
    participantAgents: fixture.participantAgents,
    nameHash: fixture.nameHash,
  });
  const rpc = await startRfc64PrivateDevnetFinalizedRpc(fixture, {
    readAuthoritySnapshot: () => adapter.getContextGraphAuthoritySnapshot(contextGraphId),
  });
  const contextGraphInterface = new ethers.Interface([
    'function getContextGraph(uint256 contextGraphId) view returns (address owner, address[] participantAgents, uint256 metadataBatchId, bool active, uint256 createdAt, uint8 accessPolicy, uint8 publishPolicy, address publishAuthority, uint256 publishAuthorityAccountId)',
  ]);
  const assertAuthorityParity = async () => {
    const adapterParticipants = (await adapter.getContextGraphParticipantAgents(contextGraphId))
      .map((address) => address.toLowerCase())
      .sort();
    const snapshot = await adapter.getContextGraphAuthoritySnapshot(contextGraphId);
    const rpcResponse = await fetch(rpc.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_call',
        params: [{
          to: CONTEXT_GRAPH_STORAGE,
          data: contextGraphInterface.encodeFunctionData('getContextGraph', [contextGraphId]),
        }, 'latest'],
      }),
    });
    const body = await rpcResponse.json();
    const [, rpcParticipants] = contextGraphInterface.decodeFunctionResult(
      'getContextGraph',
      body.result,
    );
    assert.deepEqual([...snapshot.participantAgents], adapterParticipants);
    assert.deepEqual(
      [...rpcParticipants].map((address) => address.toLowerCase()).sort(),
      adapterParticipants,
    );
  };

  try {
    await assertAuthorityParity();
    const initial = composeRfc64FinalizedCatalogAuthorityV1({
      networkId: fixture.networkId,
      contextGraphId: CONTEXT_GRAPH_ID,
      snapshot: parseRfc64AuthoritySnapshotV1(
        await adapter.getContextGraphAuthoritySnapshot(contextGraphId),
        contextGraphId,
      ),
    });
    const configured = createPrivatePolicyAndRoster();
    assert.deepEqual(initial.policy, configured.policy);
    assert.equal(initial.policyDigest, configured.policyDigest);
    assert.deepEqual(initial.roster, configured.roster);
    const policies = new Rfc64CatalogAccessPolicyRegistryV1({
      localAgentAddress: roleAgentAddress('provider2'),
      resolveRemoteAgentAddress: async () => roleAgentAddress('owner'),
    });
    policies.acceptCurrent({
      policy: initial.policy,
      policyDigest: initial.policyDigest,
      roster: initial.roster,
    });

    await adapter.addContextGraphParticipantAgent(
      contextGraphId,
      roleAgentAddress('outsider'),
    );
    await assertAuthorityParity();
    await adapter.removeContextGraphParticipantAgent(
      contextGraphId,
      roleAgentAddress('outsider'),
    );
    await assertAuthorityParity();

    await adapter.removeContextGraphParticipantAgent(
      contextGraphId,
      roleAgentAddress('receiver'),
    );
    await assertAuthorityParity();
    const advanced = composeRfc64FinalizedCatalogAuthorityV1({
      networkId: fixture.networkId,
      contextGraphId: CONTEXT_GRAPH_ID,
      snapshot: parseRfc64AuthoritySnapshotV1(
        await adapter.getContextGraphAuthoritySnapshot(contextGraphId),
        contextGraphId,
      ),
    });
    const expected = createReceiverRevokedPolicyAndRoster();
    assert.equal(advanced.policyDigest, expected.policyDigest);
    assert.equal(advanced.roster.version, '3');
    assert.deepEqual(advanced.roster.members, expected.roster.members);
    assert.equal(
      advanced.roster.members.some(
        ({ agentAddress }) => agentAddress === roleAgentAddress('receiver'),
      ),
      false,
    );
    const accepted = policies.acceptAuthoritativeCurrent({
      policy: advanced.policy,
      policyDigest: advanced.policyDigest,
      roster: advanced.roster,
    });
    assert.equal(accepted.roster?.version, '3');
    assert.equal(accepted.roster?.members.some(
      ({ agentAddress }) => agentAddress === roleAgentAddress('receiver'),
    ), false);
  } finally {
    await rpc.close();
  }
});

test('RPC evidence is method-attributed and rejects unknown or over-budget work', async () => {
  const withinBudget = {
    rpcCallCounts: {
      eth_blockNumber: 2,
      eth_call: 12,
      eth_chainId: 2,
      eth_getBlockByNumber: 4,
      eth_getCode: 1,
    },
  };
  assert.deepEqual(rpcEvidenceV1(withinBudget), {
    byMethod: withinBudget.rpcCallCounts,
    total: 21,
  });
  assert.equal(isWithinRpcBudgetV1(withinBudget), true);
  assert.equal(isWithinRpcBudgetV1({
    rpcCallCounts: { eth_call: RFC64_PRIVATE_GATE_RPC_BUDGET_V1.methods.eth_call + 1 },
  }), false);
  assert.equal(isWithinRpcBudgetV1({
    rpcCallCounts: { eth_unexpected: 1 },
  }), false);
  assert.equal(isWithinRpcBudgetV1({ rpcCallCounts: {} }), false);
  assert.equal(isWithinRpcCeilingV1({ rpcCallCounts: {} }), true);
  assert.equal(isWithinRpcCeilingV1({
    rpcCallCounts: { eth_call: RFC64_PRIVATE_GATE_RPC_BUDGET_V1.methods.eth_call + 1 },
  }), false);
  assert.equal(isWithinRpcCeilingV1({
    rpcCallCounts: { eth_unexpected: 1 },
  }), false);

  const root = await mkdtemp(join(tmpdir(), 'rfc64-private-late-rpc-'));
  const child = new AgentChild('late-rpc', root, undefined, 'late-rpc', {
    agentProcess: fileURLToPath(new URL('./fixtures/late-rpc-child.mjs', import.meta.url)),
  });
  try {
    await child.waitFor('ready');
    const inspection = await child.request({ cmd: 'inspect' }, 'inspection');
    assert.equal(isWithinRpcCeilingV1(inspection), true);
    const shutdown = await child.stop();
    assert.deepEqual(shutdown.rpcCallCounts, { eth_call: 97 });
    assert.equal(isWithinRpcBudgetV1(shutdown), false);
  } finally {
    await child.forceStop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test('child command failures retain only a bounded command phase', () => {
  const sensitiveCause = new Error('provider endpoint and wallet material');
  const classified = sanitizeGateFailureV1(
    createGateCommandFailureV1('persisted-inspection', sensitiveCause),
  );
  assert.deepEqual(classified, {
    failureClass: 'gate-command-failed',
    commandPhase: 'persisted-inspection',
  });
  assert.equal(JSON.stringify(classified).includes(sensitiveCause.message), false);
  assert.deepEqual(sanitizeGateFailureV1(
    createGateCommandFailureV1('caller-controlled-phase', sensitiveCause),
  ), {
    failureClass: 'gate-execution-failed',
  });
});
