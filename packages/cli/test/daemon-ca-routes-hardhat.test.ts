/**
 * Conviction Account service spending (OT-RFC-27) end to end against the
 * contracts on the shared Hardhat node: the /api/ca routes of three nodes,
 * each a DKGAgent over a real EVM adapter, served over HTTP and driven through
 * the API client.
 *
 * - Node A owns a 100,000 TRAC account (the 30 % discount tier) with its
 *   primary wallet, a local key.
 * - Node B's buyer key is its primary wallet, a local key.
 * - Node C's buyer key is a payer account of an external signer (a stand-in
 *   serving the eth JSON-RPC signing API): consent is EIP-712 typed data
 *   (eth_signTypedData_v4), the assignment and the funding are transactions
 *   (eth_signTransaction).
 *
 * The local deployment leaves the schedule cut-over unset, so the test sets
 * it through the Hub (Hub.forwardCall) before it creates the account.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ethers, Wallet } from 'ethers';
import { DKGAgent } from '@origintrail-official/dkg-agent';
import { EVMChainAdapter, connectRemoteSigners, type RemoteSigners } from '@origintrail-official/dkg-chain';
import { handleCaRoutes } from '../src/daemon/routes/ca.js';
import { jsonResponse } from '../src/daemon/http-utils.js';
import type { RequestContext } from '../src/daemon/routes/context.js';
import { ApiClient } from '../src/api-client.js';
import type { CaTermsWire } from '../src/ca-client.js';
import { requestAuthentication } from './_helpers/request-authentication.js';
import {
  createProvider,
  getSharedContext,
  HARDHAT_KEYS,
  revertSnapshot,
  takeSnapshot,
} from '../../chain/test/evm-test-context.js';
import { makeAdapterConfig, mintTokens } from '../../chain/test/hardhat-harness.js';
import { startFakeRemoteSigner, type FakeSigner } from '../../chain/test/helpers/fake-remote-signer.js';

const PAYER_TOKEN = 'conviction-payer-credential-4e5f6a7b';
const REFUSING_TOKEN = 'conviction-refusing-credential-8c9d0e1f';
const DAY = 86_400;
const TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)');

interface Node {
  agent: DKGAgent;
  chain: EVMChainAdapter;
  client: ApiClient;
  server: Server;
}

const owner = new Wallet(HARDHAT_KEYS.EXTRA1);
const localBuyer = new Wallet(HARDHAT_KEYS.EXTRA2);
const remoteBuyer = Wallet.createRandom();
const refusingBuyer = Wallet.createRandom();

let snapshotId: string;
let fake: FakeSigner;
let remote: RemoteSigners;
let refusing: RemoteSigners;
let accountId: string;
let tokenAddress: string;
let chainNow: number;
const nodes: Node[] = [];
let a: Node;
let b: Node;
let c: Node;
let d: Node;

/** Serve one node's /api/ca routes on a loopback port, as the daemon dispatches them. */
async function serve(name: string, chain: EVMChainAdapter, primaryWallet: string): Promise<Node> {
  const agent = await DKGAgent.create({
    name, listenHost: '127.0.0.1', listenPort: 0, nodeRole: 'edge', chainAdapter: chain,
    rfc64CatalogActivation: { enabled: false }, syncOnConnectEnabled: false,
  });
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const ctx = {
      req, res, agent, url, path: url.pathname,
      authentication: requestAuthentication({ kind: 'anonymous', mode: 'disabled' }),
      opWallets: { wallets: [{ address: primaryWallet }] },
    } as unknown as RequestContext;
    handleCaRoutes(ctx)
      .then(() => { if (!res.writableEnded) jsonResponse(res, 404, { error: 'Not found' }); })
      .catch((err: unknown) => jsonResponse(res, 500, { error: String(err) }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const node = { agent, chain, server, client: new ApiClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`) };
  nodes.push(node);
  return node;
}

async function sendEth(to: string, ether: string): Promise<void> {
  const deployer = new Wallet(HARDHAT_KEYS.DEPLOYER, createProvider());
  await (await deployer.sendTransaction({ to, value: ethers.parseEther(ether) })).wait();
}

/** An HTTP error of the client, as status, error and its route body. */
async function refusal(promise: Promise<unknown>): Promise<{ status: number; error: string; body: any }> {
  const err = await promise.then(() => null, (e: unknown) => e) as { httpStatus?: number; message?: string; responseBody?: unknown } | null;
  expect(err, 'expected an error answer').not.toBeNull();
  return { status: err!.httpStatus!, error: err!.message!, body: err!.responseBody };
}

/** The funding's receipt holds no TRAC Transfer log: CA-funded periods move no TRAC. */
async function expectNoTracTransfer(txHash: string): Promise<void> {
  const receipt = await createProvider().getTransactionReceipt(txHash);
  expect(receipt?.status).toBe(1);
  expect(receipt!.logs.filter((log) => log.address.toLowerCase() === tokenAddress.toLowerCase() && log.topics[0] === TRANSFER_TOPIC)).toEqual([]);
}

const plan = (periodId: string, value: string) => ({
  periodId,
  periodSeconds: 30 * DAY,
  planDigest: ethers.id(`plan ${periodId}`),
  buckets: [{ bucketId: ethers.id('bucket inference'), serviceClass: 'inference' as const, value, maxAskWeiPerUnit: '2500000000000' }],
});

describe('/api/ca against the contracts on Hardhat', () => {
  beforeAll(async () => {
    snapshotId = await takeSnapshot();
    const provider = createProvider();
    const { rpcUrl, hubAddress } = getSharedContext();
    const deployer = new Wallet(HARDHAT_KEYS.DEPLOYER, provider);
    const hub = new ethers.Contract(hubAddress, [
      'function getContractAddress(string) view returns (address)',
      'function forwardCall(address target, bytes data) returns (bytes)',
    ], deployer);
    tokenAddress = await hub.getContractAddress('Token');

    // The schedule cut-over, set once through the Hub, at or before the chain's time.
    const cssAddress = await hub.getContractAddress('ConvictionServiceStorage');
    const css = new ethers.Contract(cssAddress, [
      'function exactScheduleFrom() view returns (uint40)',
      'function setExactScheduleFrom(uint40 timestamp)',
    ], provider);
    chainNow = (await provider.getBlock('latest'))!.timestamp;
    if (BigInt(await css.exactScheduleFrom()) === 0n) {
      await (await hub.forwardCall(cssAddress, css.interface.encodeFunctionData('setExactScheduleFrom', [chainNow]))).wait();
    }
    expect(BigInt(await css.exactScheduleFrom())).toBeGreaterThan(0n);

    await mintTokens(provider, hubAddress, HARDHAT_KEYS.DEPLOYER, owner.address, ethers.parseEther('100000'));
    await sendEth(remoteBuyer.address, '10');
    await sendEth(refusingBuyer.address, '10');
    fake = await startFakeRemoteSigner({
      credentials: [
        { token: PAYER_TOKEN, keys: [remoteBuyer.privateKey] },
        { token: REFUSING_TOKEN, keys: [refusingBuyer.privateKey] },
      ],
      // A signer locked to the documented typed-data domains refuses this one.
      reject: (method, request) => (method === 'eth_signTypedData_v4' && request.authorization === `Bearer ${REFUSING_TOKEN}`
        ? { code: -32000, message: 'typed data domain not allowed for this account' }
        : undefined),
    });
    remote = await connectRemoteSigners({ url: fake.url, authToken: PAYER_TOKEN });
    refusing = await connectRemoteSigners({ url: fake.url, authToken: REFUSING_TOKEN });
    const external = (signers: RemoteSigners) => new EVMChainAdapter({
      rpcUrl, hubAddress, chainId: 'evm:31337', signers: signers.operational, allowNoAdminSigner: true,
    });
    const local = (key: string) => new EVMChainAdapter(makeAdapterConfig(rpcUrl, hubAddress, key));
    a = await serve('ca-owner', local(HARDHAT_KEYS.EXTRA1), owner.address);
    b = await serve('ca-local-buyer', local(HARDHAT_KEYS.EXTRA2), localBuyer.address);
    c = await serve('ca-remote-buyer', external(remote), remoteBuyer.address);
    d = await serve('ca-refusing-buyer', external(refusing), refusingBuyer.address);

    // The account, created after the cut-over, so its schedule is exact.
    accountId = (await a.chain.createPublishingConvictionAccount(ethers.parseEther('100000'))).accountId.toString();
  }, 180_000);

  afterAll(async () => {
    for (const node of nodes) {
      await new Promise<void>((resolve) => node.server.close(() => resolve()));
      await node.agent.stop().catch(() => {});
      node.chain.destroy();
    }
    remote?.destroy();
    refusing?.destroy();
    await fake?.close();
    if (snapshotId) await revertSnapshot(snapshotId);
  });

  it('opts in on the owner node and reads the status fresh', async () => {
    const contracts = await a.client.ca.contracts();
    expect(contracts.domain).toMatchObject({ name: 'DKGConvictionServices', version: '1', chainId: 31337 });
    expect(contracts.logicVersion).toBe('10.1.0');
    const before = await a.client.ca.status(accountId);
    expect(before).toMatchObject({ ownedByNode: true, buyerKey: owner.address, serviceSpending: { enabled: false }, schedule: { exact: true } });

    const enabled = await a.client.ca.setServices(accountId, true);
    expect(enabled).toMatchObject({ accountId, enabled: true, txHash: expect.stringMatching(/^0x/) });
    const after = await a.client.ca.status(accountId);
    expect(after.serviceSpending.enabled).toBe(true);
    expect(after.discountBps).toBe(3000);
    expect(after.schedule.lastEpoch - after.schedule.firstEpoch + 1).toBe(2 * after.lockDurationEpochs);
    // Node B does not own the account.
    expect((await b.client.ca.status(accountId)).ownedByNode).toBe(false);
    expect(await refusal(a.client.ca.setServices(accountId, true))).toMatchObject({ status: 409, error: 'ServiceSpendingUnchanged' });
  });

  it('assigns node B on its consent, sent by the owner node', async () => {
    const expiresAt = new Date((chainNow + 30 * DAY) * 1000).toISOString();
    const consent = await b.client.ca.consent(accountId, { maxCostPerPeriod: '25', maxCostPerWindow: '100', maxTotalCost: '1000', expiresAt });
    expect(consent.terms).toMatchObject({ accountId, assignee: localBuyer.address, nonce: '0', maxQueryCostPerPeriod: '0' });
    expect(ethers.verifyTypedData(consent.domain, (await a.client.ca.contracts()).types, consent.terms, consent.assigneeSignature)).toBe(localBuyer.address);
    // The assignee node cannot submit it without the owner's signature, nor can any other node.
    expect((await refusal(b.client.ca.assign(accountId, consent))).status).toBe(400);
    expect((await refusal(c.client.ca.assign(accountId, consent))).status).toBe(403);

    const assigned = await a.client.ca.assign(accountId, consent);
    expect(assigned).toMatchObject({ accountId, assignee: localBuyer.address, digest: consent.digest, sentAs: 'owner' });
    const { assignments } = await a.client.ca.assignments(accountId);
    expect(assignments).toEqual([expect.objectContaining({ assignee: localBuyer.address, active: true, nonce: '0', maxTotalCostTrac: '1000.0' })]);
    // The nonce advanced: the same terms no longer assign.
    expect(await refusal(a.client.ca.assign(accountId, consent))).toMatchObject({ status: 409, error: 'InvalidAssignmentNonce' });
  });

  it('funds a period from the account on node B, moving no TRAC, and answers a repeated period id from the chain', async () => {
    const periodId = ethers.id('first period of node B');
    const funded = await b.client.ca.fund(accountId, plan(periodId, '10'));
    expect(funded).toMatchObject({
      periodId, assignee: localBuyer.address, valueTrac: '10.0', costTrac: '7.0', drawnFromWindowTrac: '7.0', drawnFromTopUp: '0',
      discountBps: 3000, existing: false,
    });
    expect(funded.periodEnd - funded.periodStart).toBe(30 * DAY);
    await expectNoTracTransfer(funded.txHash);

    const again = await b.client.ca.fund(accountId, plan(periodId, '10'));
    expect(again).toMatchObject({ existing: true, subscriptionId: funded.subscriptionId, txHash: funded.txHash, logIndex: funded.logIndex });

    const { total, periods } = await a.client.ca.periods(accountId);
    expect(total).toBe(1);
    expect(periods[0]).toMatchObject({ subscriptionId: funded.subscriptionId, planDigest: plan(periodId, '10').planDigest });
    const status = await a.client.ca.status(accountId);
    expect(status.labels.totalTrac).toBe('7.0');
    const labels = await a.client.ca.labels(accountId);
    expect(labels.from).toBe(status.schedule.firstEpoch);
    const labelled = labels.epochs.filter((e) => BigInt(e.baseLabel) > 0n);
    expect(labelled.reduce((sum, e) => sum + BigInt(e.baseLabel), 0n)).toBe(ethers.parseEther('7'));
    for (const e of labelled) {
      expect(BigInt(e.baseLabel)).toBeLessThanOrEqual(BigInt(e.scheduled));
      expect(BigInt(e.serviceLabel)).toBeLessThanOrEqual(BigInt(e.pool));
    }
  });

  it('changes the caps on the owner node, keeping the usage: below it they refuse funding, raised again they allow it', async () => {
    const assignee = localBuyer.address;
    const tightened = await a.client.ca.updateCaps(accountId, assignee, { maxCostPerPeriod: '5', maxInferenceCostPerPeriod: '5', maxTotalCost: '5' });
    expect(tightened).toMatchObject({ unchanged: false, caps: { maxTotalCostTrac: '5.0', maxCostPerWindowTrac: '100.0' }, usage: { totalCostTrac: '7.0', periods: 1 } });
    // A retry sends nothing.
    expect((await a.client.ca.updateCaps(accountId, assignee, { maxTotalCost: '5' })).unchanged).toBe(true);
    // The assignee node may not change them.
    expect(await refusal(b.client.ca.updateCaps(accountId, assignee, { maxTotalCost: '6' }))).toMatchObject({ status: 403, error: 'NotAccountOwner' });

    const capped = await refusal(b.client.ca.fund(accountId, plan(ethers.id('second period of node B'), '1')));
    expect(capped).toMatchObject({ status: 409, error: 'CapExceeded', body: { args: { cap: 'maxTotalCost' } } });

    await a.client.ca.updateCaps(accountId, assignee, { maxCostPerPeriod: '25', maxInferenceCostPerPeriod: '25', maxTotalCost: '1000' });
    await b.client.ca.fund(accountId, plan(ethers.id('third period of node B'), '10'));
    const [stored] = (await a.client.ca.assignments(accountId)).assignments;
    expect(stored!.usage).toMatchObject({ totalCostTrac: '14.0', periods: 2 });
    expect(stored!.nonce).toBe('0');
  });

  it('revokes node B on the owner node, after which its funding is refused', async () => {
    const revoked = await a.client.ca.revoke(accountId, localBuyer.address);
    expect(revoked).toMatchObject({ revoked: true, nextNonce: '2' });
    expect(await refusal(b.client.ca.fund(accountId, plan(ethers.id('fourth period of node B'), '1')))).toMatchObject({ status: 409, error: 'AssignmentRevoked' });
    const mine = await b.client.ca.mine();
    expect(mine.assigned).toEqual([expect.objectContaining({ accountId, active: false, revokedAt: expect.any(Number) })]);
    expect((await a.client.ca.mine()).owned).toContainEqual({ accountId });
    expect((await a.client.ca.advanceNonce(accountId)).nextNonce).toBe('3');
  });

  it('consents through an external signer, submits as the assignee with the owner\'s signature, and funds through it', async () => {
    const { domain, types } = await a.client.ca.contracts();
    const expiresAt = new Date((chainNow + 30 * DAY) * 1000).toISOString();
    const consent = await c.client.ca.consent(accountId, { maxCostPerPeriod: '25', maxTotalCost: '100', expiresAt });
    expect(consent.terms).toMatchObject({ assignee: remoteBuyer.address, nonce: '3' });
    expect(fake.calls('eth_signTypedData_v4')).toHaveLength(1);
    expect(ethers.verifyTypedData(domain, types, consent.terms, consent.assigneeSignature)).toBe(remoteBuyer.address);

    // The owner signs the same terms away from the node, as a hardware wallet would.
    const ownerSignature = await owner.signTypedData(domain, types, consent.terms);
    const signedTransactions = fake.calls('eth_signTransaction').length;
    const assigned = await c.client.ca.assign(accountId, { terms: consent.terms, ownerSignature });
    expect(assigned.sentAs).toBe('assignee');
    const funded = await c.client.ca.fund(accountId, plan(ethers.id('first period of node C'), '10'));
    expect(funded).toMatchObject({ assignee: remoteBuyer.address, costTrac: '7.0', existing: false });
    expect(fake.calls('eth_signTransaction')).toHaveLength(signedTransactions + 2);
    await expectNoTracTransfer(funded.txHash);
    expect((await c.client.ca.mine()).assigned).toEqual([expect.objectContaining({ accountId, active: true })]);
  });

  it('answers a signer\'s refusal of the consent with the other way to consent, which then assigns', async () => {
    const expiresAt = new Date((chainNow + 30 * DAY) * 1000).toISOString();
    const refused = await refusal(d.client.ca.consent(accountId, { maxCostPerPeriod: '25', maxTotalCost: '100', expiresAt }));
    expect(refused).toMatchObject({ status: 502, body: { code: 'REMOTE_SIGNER_REJECTED', hint: expect.stringMatching(/owner's signature/) } });

    // The assignee consents by sending the assignment, with the owner's signature over the terms.
    const status = await a.client.ca.status(accountId);
    const nonce = await d.chain.getConvictionServiceAssignmentNonce(BigInt(accountId));
    const terms: CaTermsWire = {
      accountId, assignee: refusingBuyer.address,
      maxCostPerPeriod: ethers.parseEther('25').toString(), maxInferenceCostPerPeriod: ethers.parseEther('25').toString(),
      maxQueryCostPerPeriod: '0', maxCostPerWindow: '0', maxTotalCost: ethers.parseEther('100').toString(),
      maxPeriodSeconds: 31 * DAY, expiresAt: chainNow + 30 * DAY, nonce: nonce.toString(),
    };
    const { domain, types } = await a.client.ca.contracts();
    const assigned = await d.client.ca.assign(accountId, { terms, ownerSignature: await owner.signTypedData(domain, types, terms) });
    expect(assigned.sentAs).toBe('assignee');
    expect((await a.client.ca.status(accountId)).assignments.count).toBe(status.assignments.count + 1);
  });
});
