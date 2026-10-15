/**
 * A node that holds no local key as a member of a private context graph,
 * against the shared Hardhat node. Its default agent's author key lives in an
 * external signer; its workspace encryption key is generated and kept on the
 * node and bound to the agent by a proof the signer signs. A core node with
 * local keys curates a private graph that allowlists that agent. The keyless
 * node catches the graph up, shares into it (the signer signs the shared-memory
 * envelope and each recipient's sender-key setup package over their framed
 * fields) and reads what the curator shares into it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { connectRemoteSigners, type RemoteSigners } from '@origintrail-official/dkg-chain';
import { SWM_SENDER_KEY_SETUP_AAD_DOMAIN, SYSTEM_CONTEXT_GRAPHS } from '@origintrail-official/dkg-core';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { resolveWorkspaceAgentRecipientKeys } from '@origintrail-official/dkg-publisher';
import { DKGAgent } from '../src/index.js';
import {
  createEVMAdapter,
  getSharedContext,
  HARDHAT_KEYS,
  revertSnapshot,
  takeSnapshot,
} from '../../chain/test/evm-test-context.js';
import { startFakeRemoteSigner, type FakeSigner, type FakeSignerRequest } from '../../chain/test/helpers/fake-remote-signer.js';
import { makeTestKaNumberAllocator } from './_helpers/ka-allocator.js';
import { createPublishProtocolAgent, pollUntil, sleep } from './_helpers/publish-protocol.js';

const PAYER_TOKEN = 'private-payer-credential-3c4d5e6f708192a3';
const AUTHOR_TOKEN = 'private-author-credential-a39281706f5e4d3c';
const author = new ethers.Wallet(HARDHAT_KEYS.EXTRA2);
const PRIVATE_CG = 'keyless-private-member';
const FROM_EDGE = 'urn:keyless-private:from-edge';
const FROM_CURATOR = 'urn:keyless-private:from-curator';

let snapshotId: string;
let fake: FakeSigner;
let remote: RemoteSigners | undefined;
let curator: DKGAgent;
let edge: DKGAgent;

/** The first `count` length-framed fields of an `eth_sign` request's data, as text. */
function framedFields(request: FakeSignerRequest, count: number): string[] {
  const signed = ethers.getBytes(String(request.params[1]));
  const fields: string[] = [];
  for (let offset = 0; fields.length < count && offset < signed.length;) {
    const length = new DataView(signed.buffer, signed.byteOffset + offset, 4).getUint32(0, false);
    fields.push(new TextDecoder().decode(signed.subarray(offset + 4, offset + 4 + length)));
    offset += 4 + length;
  }
  return fields;
}

function firstFramedField(request: FakeSignerRequest): string {
  return framedFields(request, 1)[0];
}

function sharedNames(agent: DKGAgent, subject: string) {
  return () => agent.query(`SELECT ?name WHERE { <${subject}> <http://schema.org/name> ?name }`, {
    contextGraphId: PRIVATE_CG,
    graphSuffix: '_shared_memory',
  });
}

describe('a keyless node as a member of a private context graph', () => {
  beforeAll(async () => {
    snapshotId = await takeSnapshot();
    const { rpcUrl, hubAddress } = getSharedContext();
    fake = await startFakeRemoteSigner({
      credentials: [
        { token: PAYER_TOKEN, keys: [HARDHAT_KEYS.PUBLISHER] },
        { token: AUTHOR_TOKEN, keys: [author.privateKey] },
      ],
    });
    remote = await connectRemoteSigners({ url: fake.url, authToken: PAYER_TOKEN, author: { authToken: AUTHOR_TOKEN } });
    curator = await createPublishProtocolAgent({
      name: 'PrivateCurator',
      listenPort: 0,
      listenHost: '127.0.0.1',
      nodeRole: 'core',
      kaNumberAllocator: makeTestKaNumberAllocator(),
      chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
      syncOnConnectEnabled: false,
    });
    edge = await createPublishProtocolAgent({
      name: 'KeylessMember',
      store: new OxigraphStore(),
      listenPort: 0,
      listenHost: '127.0.0.1',
      nodeRole: 'edge',
      kaNumberAllocator: makeTestKaNumberAllocator(),
      chainConfig: { rpcUrl, hubAddress, chainId: 'evm:31337', signers: remote.operational },
      authorSigners: remote.authors,
      syncOnConnectEnabled: false,
      // Catch the private graph up on the durable sync lane, whatever its
      // catalog responsibility: the lane that authenticates as the agent.
      rfc64CatalogActivation: { enabled: true, rollout: { killSwitch: true, defaultMode: 'legacy', contextGraphModes: {} } },
    });
    await curator.start();
    await edge.start();
    const address = curator.multiaddrs.find((entry) => entry.includes('/tcp/') && !entry.includes('/p2p-circuit'))!;
    await edge.connectTo(address);
    await sleep(1_000);
  }, 180_000);

  afterAll(async () => {
    await edge?.stop().catch(() => {});
    await curator?.stop().catch(() => {});
    remote?.destroy();
    await fake?.close();
    if (snapshotId) await revertSnapshot(snapshotId);
  });

  it('has a node-held encryption key bound by the signer, which the curator resolves from its profile', async () => {
    expect(edge.getDefaultAgentAddress()).toBe(author.address);
    const [proof] = fake.calls('eth_sign');
    expect(proof.authorization).toBe(`Bearer ${AUTHOR_TOKEN}`);
    expect(firstFramedField(proof)).toBe('domain');

    // Each node publishes its profile (as a daemon does at startup) and learns
    // the other's, and so its encryption key and peer.
    await edge.publishProfile();
    await curator.publishProfile();
    await curator.syncFromPeer(edge.peerId, [SYSTEM_CONTEXT_GRAPHS.AGENTS]);
    await edge.syncFromPeer(curator.peerId, [SYSTEM_CONTEXT_GRAPHS.AGENTS]);
    const [key] = await resolveWorkspaceAgentRecipientKeys(curator.store, author.address);
    expect(key).toMatchObject({ agentAddress: author.address, peerId: edge.peerId });
    const local = (edge as any).localAgents.get(author.address);
    expect(key.recipientKeyId).toBe(local.workspaceEncryptionKeys[0].encryptionKeyId);
  }, 120_000);

  it('catches up the private graph the curator allowlisted it in', async () => {
    await curator.createContextGraph({
      id: PRIVATE_CG,
      name: 'Keyless private member',
      accessPolicy: 1,
      allowedAgents: [curator.getDefaultAgentAddress()!, author.address],
    });
    curator.subscribeToContextGraph(PRIVATE_CG);
    edge.subscribeToContextGraph(PRIVATE_CG);
    await edge.whenRfc64CatalogResponsibilitiesIdleV1();
    await edge.syncFromPeer(curator.peerId, [PRIVATE_CG]);
    expect(await edge.isPrivateContextGraph(PRIVATE_CG)).toBe(true);
  }, 120_000);

  it('shares into the private graph, signing the envelope and the sender-key packages through the signer', async () => {
    const before = fake.requests.length;
    await edge.assertion.create(PRIVATE_CG, 'from-edge');
    await edge.assertion.write(PRIVATE_CG, 'from-edge', [
      { subject: FROM_EDGE, predicate: 'http://schema.org/name', object: '"Written by the keyless member"' },
    ]);
    await edge.assertion.finalize(PRIVATE_CG, 'from-edge');
    await edge.assertion.promote(PRIVATE_CG, 'from-edge');
    const received = await pollUntil(sharedNames(curator, FROM_EDGE), (rows) => rows.length > 0, 20_000);
    expect(received.map((row: Record<string, unknown>) => row.name)).toEqual(['"Written by the keyless member"']);

    // The signer was asked for the setup package of each recipient (the curator's
    // agent and its own) and the envelope of the share, each over its framed fields.
    const signed = fake.requests.slice(before).filter((request) => request.method === 'eth_sign');
    expect(signed.every((request) => request.authorization === `Bearer ${AUTHOR_TOKEN}`)).toBe(true);
    expect(signed.every((request) => ethers.getAddress(String(request.params[0])) === author.address)).toBe(true);
    const packages = signed.filter((request) => firstFramedField(request) === 'domain');
    expect(packages.map((request) => framedFields(request, 2)[1])).toEqual([SWM_SENDER_KEY_SETUP_AAD_DOMAIN, SWM_SENDER_KEY_SETUP_AAD_DOMAIN]);
    expect(signed.filter((request) => firstFramedField(request) === 'share-write')).toHaveLength(1);
    expect(signed).toHaveLength(3);
  }, 120_000);

  it('reads what the curator shares into the private graph', async () => {
    await curator.assertion.create(PRIVATE_CG, 'from-curator');
    await curator.assertion.write(PRIVATE_CG, 'from-curator', [
      { subject: FROM_CURATOR, predicate: 'http://schema.org/name', object: '"Written by the curator"' },
    ]);
    await curator.assertion.finalize(PRIVATE_CG, 'from-curator');
    await curator.assertion.promote(PRIVATE_CG, 'from-curator');
    const received = await pollUntil(sharedNames(edge, FROM_CURATOR), (rows) => rows.length > 0, 20_000);
    expect(received.map((row: Record<string, unknown>) => row.name)).toEqual(['"Written by the curator"']);
  }, 120_000);
});
