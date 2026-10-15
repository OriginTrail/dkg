/**
 * A node that holds no local key joins a private context graph, in the
 * default catalog mode, against the shared Hardhat node. Its default agent's
 * author key lives in an external signer. A core node with local keys curates
 * a registered private graph and has published into it; it invites the
 * keyless agent, which then asks to join: the signer signs the agent's
 * delegation and its encryption-key bundle from their fields
 * (`dkg_signAgentDelegation`, `dkg_signJoinEncryptionKeys`). The curator
 * accepts the request as from a member and the keyless node catches the graph
 * up.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ethers } from 'ethers';
import { connectRemoteSigners, type RemoteSigners } from '@origintrail-official/dkg-chain';
import { DKGAgent } from '../src/index.js';
import { verifyAgentDelegation } from '../src/auth/agent-delegation.js';
import { verifyJoinEncryptionKeyBundle } from '../src/internal/join-encryption-key-bundle.js';
import {
  AGENT_DELEGATION_SIGNING_METHOD,
  JOIN_ENCRYPTION_KEYS_SIGNING_METHOD,
} from '../src/external-agent-join-signing.js';
import { TEST_SNAPSHOT_CONFIG } from '../../../scripts/testing/snapshot-storage.js';
import {
  createEVMAdapter,
  createProvider,
  getSharedContext,
  HARDHAT_KEYS,
  revertSnapshot,
  takeSnapshot,
} from '../../chain/test/evm-test-context.js';
import { mintTokens } from '../../chain/test/hardhat-harness.js';
import { startFakeRemoteSigner, type FakeSigner } from '../../chain/test/helpers/fake-remote-signer.js';
import { makeTestKaNumberAllocator } from './_helpers/ka-allocator.js';
import { installHardhatACKProvider } from './_helpers/v10-acks.js';
import { pollUntil, sleep } from './_helpers/publish-protocol.js';

const PAYER_TOKEN = 'join-payer-credential-4d5e6f708192a3b4';
const AUTHOR_TOKEN = 'join-author-credential-b4a39281706f5e4d';
const author = new ethers.Wallet(HARDHAT_KEYS.EXTRA2);
const CG = 'keyless-join-private';
const ENTITY = 'urn:keyless-join:entity';

let snapshotId: string;
let fake: FakeSigner;
let remote: RemoteSigners | undefined;
let curator: DKGAgent;
let joiner: DKGAgent;
const dirs: string[] = [];

describe('a keyless node joins a private context graph', () => {
  beforeAll(async () => {
    snapshotId = await takeSnapshot();
    const { rpcUrl, hubAddress } = getSharedContext();
    await mintTokens(createProvider(), hubAddress, HARDHAT_KEYS.DEPLOYER, new ethers.Wallet(HARDHAT_KEYS.CORE_OP).address, ethers.parseEther('50000000'));
    fake = await startFakeRemoteSigner({
      credentials: [
        { token: PAYER_TOKEN, keys: [HARDHAT_KEYS.PUBLISHER] },
        { token: AUTHOR_TOKEN, keys: [author.privateKey] },
      ],
    });
    remote = await connectRemoteSigners({ url: fake.url, authToken: PAYER_TOKEN, author: { authToken: AUTHOR_TOKEN } });
    const curatorDir = await mkdtemp(join(tmpdir(), 'dkg-keyless-join-curator-'));
    const joinerDir = await mkdtemp(join(tmpdir(), 'dkg-keyless-join-joiner-'));
    dirs.push(curatorDir, joinerDir);
    const sharedChain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    curator = await DKGAgent.create({
      ...TEST_SNAPSHOT_CONFIG,
      name: 'JoinCurator',
      listenPort: 0,
      listenHost: '127.0.0.1',
      nodeRole: 'core',
      kaNumberAllocator: makeTestKaNumberAllocator(),
      chainAdapter: sharedChain,
      chainConfig: { rpcUrl, hubAddress, operationalKeys: [HARDHAT_KEYS.CORE_OP], chainId: 'evm:31337' },
      dataDir: curatorDir,
    });
    joiner = await DKGAgent.create({
      ...TEST_SNAPSHOT_CONFIG,
      name: 'KeylessJoiner',
      listenPort: 0,
      listenHost: '127.0.0.1',
      nodeRole: 'edge',
      kaNumberAllocator: makeTestKaNumberAllocator(),
      chainConfig: { rpcUrl, hubAddress, chainId: 'evm:31337', signers: remote.operational },
      authorSigners: remote.authors,
      dataDir: joinerDir,
    });
    await curator.start();
    await installHardhatACKProvider(curator, sharedChain);
    await joiner.start();
    const address = curator.multiaddrs.find((entry) => entry.includes('/tcp/') && !entry.includes('/p2p-circuit'))!;
    await joiner.connectTo(address);
    await sleep(1_500);
  }, 180_000);

  afterAll(async () => {
    await joiner?.stop().catch(() => {});
    await curator?.stop().catch(() => {});
    remote?.destroy();
    await fake?.close();
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
    if (snapshotId) await revertSnapshot(snapshotId);
  }, 60_000);

  it('signs its join request through the signer, from the delegation and the key bundle', async () => {
    expect(joiner.getDefaultAgentAddress()).toBe(author.address);
    const delegation = await joiner.signJoinRequest(CG, author.address);
    expect(verifyAgentDelegation(delegation)).toMatchObject({ agentAddress: author.address, delegateePeerId: joiner.peerId });
    expect(verifyJoinEncryptionKeyBundle(delegation, joiner.peerId)?.keys).toHaveLength(1);

    const [delegationRequest] = fake.calls(AGENT_DELEGATION_SIGNING_METHOD);
    expect(delegationRequest.authorization).toBe(`Bearer ${AUTHOR_TOKEN}`);
    expect(delegationRequest.params[1]).toMatchObject({
      agentAddress: author.address.toLowerCase(),
      delegateePeerId: joiner.peerId,
      scope: expect.stringMatching(new RegExp(`^sync:deployment=.+:${CG}$`)),
    });
    const [keysRequest] = fake.calls(JOIN_ENCRYPTION_KEYS_SIGNING_METHOD);
    expect(keysRequest.params[1]).toMatchObject({
      agentAddress: author.address.toLowerCase(),
      delegationSignature: delegation.signature.toLowerCase(),
    });
    expect(fake.calls('eth_sign').filter((request) => ethers.dataLength(String(request.params[1])) === 32)).toEqual([]);
  }, 60_000);

  it('joins the private graph it was invited to and catches it up', async () => {
    await curator.createContextGraph({ id: CG, name: 'Keyless join', description: '', accessPolicy: 1 });
    await curator.registerContextGraph(CG);
    await curator.assertion.create(CG, 'before-join');
    await curator.assertion.write(CG, 'before-join', [{ subject: ENTITY, predicate: 'http://schema.org/name', object: '"Shared before the join"' }]);
    await curator.assertion.promote(CG, 'before-join');
    expect((await curator.publishFromFinalizedAssertion(CG, 'before-join')).status).toBe('confirmed');
    await curator.inviteAgentToContextGraph(CG, author.address);

    const delegation = await joiner.signJoinRequest(CG, author.address);
    const forwarded = await joiner.forwardJoinRequest(CG, delegation, 'keyless-member', curator.peerId);
    expect(forwarded).toMatchObject({ delivered: 1, alreadyMember: true });

    const caughtUp = await pollUntil(
      () => joiner.query(`SELECT ?name WHERE { <${ENTITY}> <http://schema.org/name> ?name }`, CG),
      (rows) => rows.length > 0,
      60_000,
    );
    expect(caughtUp.map((row: Record<string, unknown>) => row.name)).toEqual(['"Shared before the join"']);
    expect(joiner.getSubscribedContextGraphs().get(CG)?.subscribed).toBe(true);
  }, 150_000);

  it('shares into the private graph as a member, and reads what the curator shares', async () => {
    const fromMember = 'urn:keyless-join:from-member';
    await joiner.assertion.create(CG, 'from-member');
    await joiner.assertion.write(CG, 'from-member', [{ subject: fromMember, predicate: 'http://schema.org/name', object: '"Shared by the keyless member"' }]);
    await joiner.assertion.finalize(CG, 'from-member');
    await joiner.assertion.promote(CG, 'from-member');
    const atCurator = await pollUntil(
      () => curator.query(`SELECT ?name WHERE { <${fromMember}> <http://schema.org/name> ?name }`, { contextGraphId: CG, graphSuffix: '_shared_memory' }),
      (rows) => rows.length > 0,
      30_000,
    );
    expect(atCurator.map((row: Record<string, unknown>) => row.name)).toEqual(['"Shared by the keyless member"']);

    const fromCurator = 'urn:keyless-join:from-curator';
    await curator.assertion.create(CG, 'from-curator');
    await curator.assertion.write(CG, 'from-curator', [{ subject: fromCurator, predicate: 'http://schema.org/name', object: '"Shared by the curator"' }]);
    await curator.assertion.finalize(CG, 'from-curator');
    await curator.assertion.promote(CG, 'from-curator');
    const atMember = await pollUntil(
      () => joiner.query(`SELECT ?name WHERE { <${fromCurator}> <http://schema.org/name> ?name }`, { contextGraphId: CG, graphSuffix: '_shared_memory' }),
      (rows) => rows.length > 0,
      30_000,
    );
    expect(atMember.map((row: Record<string, unknown>) => row.name)).toEqual(['"Shared by the curator"']);
    // No digest was ever signed blind.
    expect(fake.calls('eth_sign').filter((request) => ethers.dataLength(String(request.params[1])) === 32)).toEqual([]);
  }, 150_000);
});
