// SPDX-License-Identifier: Apache-2.0
/**
 * Serving end to end on the evm-module's Hardhat chain: a seller node and a
 * buyer node over libp2p on loopback, with the node's default settings (the
 * RFC-64 catalog carries shared memory), the seller started as the daemon
 * starts it, and a stub OpenAI-compatible model on loopback (no model
 * download). A third node only creates the Marketplace Context Graph: an open
 * graph in its owner's wallet namespace, not registered on chain, which
 * admits the seller and the buyer as it admits any node.
 *   - the seller shares its offers into the Marketplace Context Graph, each
 *     naming its node's peer id and signed by its operational wallet, each its
 *     own Knowledge Asset, with no transaction, and the buyer node reads them
 *     from its shared memory: its gateway finds the seller from them alone.
 *     (The nodes connect on loopback so that shared memory syncs; dialing by
 *     peer id on a real network is not shown here.)
 *   - a quote, and a call served with a receipt the seller's operational
 *     wallet signed, which the chain shows is a key of a Core Node;
 *   - crafted requests from the buyer node: an exact repeat
 *     (the stored receipt), the wrong seller, an expired request, a price over
 *     the budget's cap, an unknown subscription, a replayed nonce, and a call
 *     within the stop-serving window;
 *   - the buyer's gateway, started as the daemon starts it, through the
 *     daemon's routes with an access key: a chat completion from the routed
 *     seller, an over-reporting receipt from a rogue handler on the seller node
 *     that takes the seller out of routing, and 503 with Retry-After at the
 *     epoch's end;
 *   - landing: the seller lands what it served when its node's route is
 *     asked, Operate shows it, and the buyer's reconciliation matches the
 *     landed receipt to the one it holds;
 *   - a price set for the next epoch is shared again, and the buyer keeps
 *     the newer copy;
 *   - a seller that restarts shares its offers again, signed later, and
 *     calls route by the new copies.
 */
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Contract, Wallet, ethers } from 'ethers';
import { DKGAgent } from '@origintrail-official/dkg-agent';
import {
  EVMChainAdapter,
  SERVICE_CLASS_INFERENCE,
  hashServiceRequest,
  signServiceRequest,
  subscriptionIdOf,
  type MarketplaceChainAdapter,
  type MarketplaceDomain,
  type ServiceRequest,
} from '@origintrail-official/dkg-chain';
import {
  PEER_LIMITS,
  type Buyer,
  type Gateway,
  decodeMessage,
  encodeMessage,
  offerSignerOf,
  offerSubject,
  offersFromBindings,
  offersQuery,
  receiptFromWire,
  receiptSignerOf,
  requestToWire,
  resultCommitmentOf,
  serviceIdOf,
  type QuoteResponse,
  type ServeAnswer,
  type ServeResponse,
} from '@origintrail-official/dkg-marketplace';
import { createProvider, getSharedContext, revertSnapshot, takeSnapshot } from '../../chain/test/evm-test-context.js';
import { HARDHAT_KEYS, makeAdapterConfig, mintTokens } from '../../chain/test/hardhat-harness.js';
import { MemoryAuthorityIndexStore } from '../../chain/test/helpers/context-graph-authority-index.js';
import { makeTestKaNumberAllocator } from '../../agent/test/_helpers/ka-allocator.js';
import { startMarketplaceSeller, type MarketplaceSellerRuntime } from '../src/daemon/marketplace-seller.js';
import { startMarketplaceBuyer, startMarketplaceGateway } from '../src/daemon/marketplace-buyer.js';
import { handleMarketplaceRoutes } from '../src/daemon/routes/marketplace.js';
import { MARKETPLACE_GATEWAY_ROUTES } from '../src/daemon/routes/marketplace-gateway-paths.js';
import type { RequestContext } from '../src/daemon/routes/context.js';
import { requestAuthentication } from './_helpers/request-authentication.js';

const MODEL_A = 'urn:test:model:serving-a';
const MODEL_B = 'urn:test:model:serving-b';
const A = serviceIdOf(MODEL_A);
const B = serviceIdOf(MODEL_B);
const PRICE = 1_000n;
const BODY = { messages: [{ role: 'user', content: 'synthetic question' }], max_tokens: 16 };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let snapshot: string;
let dirs: string[] = [];
let upstream: Server;
let upstreamCalls = 0;
let ownerAgent: DKGAgent;
let sellerAgent: DKGAgent;
let buyerAgent: DKGAgent;
/** The Marketplace Context Graph: in the owner's wallet namespace, so its id says whose policy it is. */
let contextGraph: string;
let selling: MarketplaceSellerRuntime;
let buyerChain: MarketplaceChainAdapter;
let domain: MarketplaceDomain;
let sellerIdentity: bigint;
/** The seller's operational wallet's transaction count before it first shares. */
let sellerNonce: number;
let subscriptionId: string;
const session = Wallet.createRandom();
let startSeller: () => Promise<MarketplaceSellerRuntime>;
let gatewayBuyer: Buyer;
let gateway: Gateway;
/** An access key of the buyer node, made in the first gateway test. */
let gatewayKey: string;
const CHAT = { model: MODEL_A, messages: [{ role: 'user', content: 'synthetic question' }], max_tokens: 16 };
const GATEWAY_CHAT = MARKETPLACE_GATEWAY_ROUTES.chat.path;

/** One request through the daemon's marketplace routes: as the node admin, or with `token` as the bearer. */
async function route(method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; body: any; headers?: Record<string, string> }> {
  const res: any = { statusCode: 0, body: '' };
  res.writeHead = (status: number, headers?: Record<string, string>) => { res.statusCode = status; res.headers = headers; };
  res.setHeader = () => undefined;
  res.end = (text: string) => { res.body = text; res.writableEnded = true; };
  const req: any = { method, url: path };
  if (body !== undefined) req.__dkgPrebufferedBody = Buffer.from(JSON.stringify(body));
  const url = new URL(`http://127.0.0.1${path}`);
  const authentication = token === undefined
    ? requestAuthentication({ kind: 'nodeOperator' })
    : requestAuthentication({ kind: 'anonymous', mode: 'public', presentedToken: token });
  await handleMarketplaceRoutes({
    req, res, url, path: url.pathname, marketplace: gatewayBuyer, marketplaceGateway: gateway, actor: { authentication },
  } as unknown as RequestContext);
  return { status: res.statusCode, body: JSON.parse(res.body), headers: res.headers };
}

/** One request through the seller node's marketplace routes, as its node admin. */
async function sellerRoute(method: string, path: string): Promise<{ status: number; body: any }> {
  const res: any = { statusCode: 0, body: '' };
  res.writeHead = (status: number) => { res.statusCode = status; };
  res.setHeader = () => undefined;
  res.end = (text: string) => { res.body = text; res.writableEnded = true; };
  const url = new URL(`http://127.0.0.1${path}`);
  await handleMarketplaceRoutes({
    req: { method, url: path }, res, url, path: url.pathname, marketplaceSeller: selling.seller,
    actor: { authentication: requestAuthentication({ kind: 'nodeOperator' }) },
  } as unknown as RequestContext);
  return { status: res.statusCode, body: JSON.parse(res.body) };
}

/** Send a crafted `serve`; `attempt` makes a new message of the same request, as a retry after a lost answer does. */
async function serve(request: ServiceRequest, key: ethers.Wallet | ethers.HDNodeWallet = session, attempt = 0): Promise<ServeResponse> {
  const payload = encodeMessage({ request: requestToWire(request), signature: signServiceRequest(key.privateKey, domain, request), body: BODY });
  const answer = await buyerAgent.sendMarketplaceMessage(sellerAgent.peerId, 'serve', payload, {
    timeoutMs: PEER_LIMITS.serveTimeoutMs, maxReadBytes: PEER_LIMITS.serveResponseBytes, messageId: `${hashServiceRequest(domain, request)}:${attempt}`,
  });
  return decodeMessage(answer) as ServeResponse;
}

async function request(over: Partial<ServiceRequest> = {}): Promise<ServiceRequest> {
  await createProvider().send('evm_mine', []);
  const { now } = await buyerChain.getEpochTimes();
  return {
    subscriptionId, serviceId: A, seller: sellerIdentity, nonce: 0n, pricePerUnit: PRICE,
    maxUnits: 1_000n, maxValueWei: 1_000n * PRICE, issuedAt: now, expiry: now + 600, ...over,
  };
}

const codeOf = (r: ServeResponse) => (r.ok ? 'ok' : r.code);

describe('serving between two nodes on Hardhat', () => {
  beforeAll(async () => {
    snapshot = await takeSnapshot();
    upstream = createServer((req, res) => {
      upstreamCalls++;
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'synthetic answer' } }], usage: { prompt_tokens: 9, completion_tokens: 6 },
        }));
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}/v1`;

    const { rpcUrl, hubAddress } = getSharedContext();
    const [ownerDir, sellerDir, buyerDir] = await Promise.all(['owner', 'seller', 'buyer'].map((n) => mkdtemp(join(tmpdir(), `mkt-${n}-`))));
    dirs = [ownerDir!, sellerDir!, buyerDir!];
    // As the daemon wires its nodes: the chain adapter keeps the finalized Context Graph index, and the catalog is on.
    const adapter = (key: string, more: string[] = []) => new EVMChainAdapter({
      ...makeAdapterConfig(rpcUrl, hubAddress, key, more), localContextGraphAuthorityIndexStore: new MemoryAuthorityIndexStore(),
    });
    ownerAgent = await DKGAgent.create({ name: 'MarketplaceOwner', dataDir: ownerDir!, listenPort: 0, nodeRole: 'edge', chainAdapter: adapter(HARDHAT_KEYS.EXTRA3) });
    sellerAgent = await DKGAgent.create({
      name: 'MarketplaceSeller', dataDir: sellerDir!, listenPort: 0, nodeRole: 'core',
      chainAdapter: adapter(HARDHAT_KEYS.CORE_OP), kaNumberAllocator: makeTestKaNumberAllocator(),
    });
    buyerAgent = await DKGAgent.create({
      name: 'MarketplaceBuyer', dataDir: buyerDir!, listenPort: 0, nodeRole: 'edge', chainAdapter: adapter(HARDHAT_KEYS.EXTRA1, [HARDHAT_KEYS.EXTRA2]),
    });
    for (const agent of [ownerAgent, sellerAgent, buyerAgent]) await agent.start();
    const dialable = (agent: DKGAgent) => agent.multiaddrs.find((a) => a.includes('/tcp/') && !a.includes('/p2p-circuit'))!;
    await sellerAgent.connectTo(dialable(ownerAgent));
    await buyerAgent.connectTo(dialable(ownerAgent));
    await buyerAgent.connectTo(dialable(sellerAgent));
    const owner = ownerAgent.getDefaultAgentAddress()!.toLowerCase();
    contextGraph = `${owner}/marketplace-serving-e2e`;
    await ownerAgent.createContextGraph({ id: contextGraph, name: 'Marketplace', description: 'Offers', accessPolicy: 0, callerAgentAddress: owner });

    startSeller = async () => {
      const runtime = (await startMarketplaceSeller({
        config: {
          marketplace: {
            contextGraphId: contextGraph,
            seller: {
              enabled: true,
              services: [MODEL_A, MODEL_B].map((model) => ({ model, pricePerUnit: String(PRICE), capacity: 2, backend: { kind: 'llamacpp', baseUrl, model: 'stub' } })),
              // Hardhat's base fee is above the testnet ceilings.
              landing: { baseFeeCeilingGwei: 1_000, lastStretchBaseFeeCeilingGwei: 1_000 },
            },
          },
        },
        agent: sellerAgent,
        signer: new Wallet(HARDHAT_KEYS.CORE_OP).address,
        dataDir: sellerDir,
        log: () => undefined,
      }))!;
      await runtime.seller.tick();
      return runtime;
    };
    sellerNonce = await createProvider().getTransactionCount(new Wallet(HARDHAT_KEYS.CORE_OP).address);
    selling = await startSeller();
    sellerIdentity = selling.seller.gate.identityId;

    // The buyer funds this epoch with its own session key: A under a cap the price meets, B under one it does not.
    buyerChain = buyerAgent.marketplaceChain()!;
    domain = (await buyerChain.getMarketplaceContracts()).requestDomain;
    const buyer = new Wallet(HARDHAT_KEYS.EXTRA1).address;
    await mintTokens(createProvider(), hubAddress, HARDHAT_KEYS.DEPLOYER, buyer, 10n ** 21n);
    await buyerChain.approveServiceSubscriptionsWallet(10n ** 21n);
    const { epoch } = await buyerChain.getEpochTimes();
    const budgets = [
      { serviceId: A, serviceClass: SERVICE_CLASS_INFERENCE, value: 10n ** 15n, maxPricePerUnit: 10n ** 12n },
      { serviceId: B, serviceClass: SERVICE_CLASS_INFERENCE, value: 10n ** 15n, maxPricePerUnit: 1n },
    ].sort((x, y) => (BigInt(x.serviceId) < BigInt(y.serviceId) ? -1 : 1));
    ({ subscriptionId } = await buyerChain.fundFromWallet({ epoch, sessionKey: session.address, planDigest: ethers.ZeroHash, budgets }));

    // The gateway's buyer is the node's second wallet, which funds this epoch through the buyer, with a session key it keeps.
    const second = new Wallet(HARDHAT_KEYS.EXTRA2).address;
    await mintTokens(createProvider(), hubAddress, HARDHAT_KEYS.DEPLOYER, second, 10n ** 21n);
    const config = { marketplace: { enabled: true, buyerWallet: second, tickSeconds: 3_600, contextGraphId: contextGraph } };
    gatewayBuyer = startMarketplaceBuyer({
      config, agent: buyerAgent, wallets: [buyer, second], dataDir: buyerDir!, dashDb: { insertNotification: () => undefined }, log: () => undefined,
    })!;
    await gatewayBuyer.fund({ epoch, source: { kind: 'wallet' }, services: [{ serviceId: A, serviceClass: SERVICE_CLASS_INFERENCE, value: 10n ** 15n, maxPricePerUnit: 10n ** 12n }] });
    // The gateway subscribes the buyer node to the graph once the graph admits it.
    gateway = await startMarketplaceGateway({ config, agent: buyerAgent, buyer: gatewayBuyer, dataDir: buyerDir! });
  }, 180_000);

  afterAll(async () => {
    await gateway?.stop();
    await gatewayBuyer?.stop();
    await selling?.stop();
    for (const agent of [buyerAgent, sellerAgent, ownerAgent]) await agent?.stop().catch(() => undefined);
    await new Promise((resolve) => upstream?.close(resolve));
    await revertSnapshot(snapshot);
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  }, 60_000);

  it('is a Core Node, and its signed offers reach the buyer through the Marketplace Context Graph', async () => {
    expect(selling.seller.gate.open).toBe(true);
    const { epoch } = await buyerChain.getEpochTimes();
    let offers: ReturnType<typeof offersFromBindings> = [];
    for (let i = 0; i < 240 && offers.length < 4; i++) {
      const result = await buyerAgent.query(offersQuery([epoch, epoch + 1]), { contextGraphId: contextGraph, graphSuffix: '_shared_memory' });
      offers = offersFromBindings(result.bindings as Record<string, unknown>[]);
      if (offers.length < 4) await sleep(250);
    }
    expect(offers.map((o) => `${o.serviceId}:${o.epoch}`).sort()).toEqual([`${A}:${epoch}`, `${A}:${epoch + 1}`, `${B}:${epoch}`, `${B}:${epoch + 1}`].sort());
    expect(offers.every((o) => o.seller === sellerIdentity && o.pricePerUnit === PRICE && o.provenance === 'weights-pinned')).toBe(true);
    // Each names the seller node's peer, and the chain says its operational wallet signed it: the gateway's router keeps them all.
    expect(offers.every((o) => o.peerId === sellerAgent.peerId)).toBe(true);
    expect(offers.every((o) => offerSignerOf(domain, o) === new Wallet(HARDHAT_KEYS.CORE_OP).address)).toBe(true);
    expect(await gateway.router.offersOf([epoch, epoch + 1])).toHaveLength(4);
    // Each its own Knowledge Asset of the seller's, named after its subject and shared, with no transaction.
    const assets = await Promise.all(offers.map((o) => sellerAgent.assertion.history(contextGraph, `offer-${offerSubject(o.signature).split(':').pop()}`)));
    expect(assets.every((asset) => asset?.status === 'swm-shared')).toBe(true);
    expect(new Set(assets.map((asset) => asset?.reservedUal)).size).toBe(4);
    expect(await createProvider().getTransactionCount(new Wallet(HARDHAT_KEYS.CORE_OP).address)).toBe(sellerNonce);
  }, 120_000);

  it('quotes over the messenger, and serves a call with a receipt a Core Node key signed', async () => {
    const quoted = decodeMessage(await buyerAgent.sendMarketplaceMessage(sellerAgent.peerId, 'quote', encodeMessage({ services: [A, B] }), {
      timeoutMs: PEER_LIMITS.quoteTimeoutMs, maxReadBytes: PEER_LIMITS.quoteResponseBytes,
    })) as QuoteResponse;
    expect(quoted).toMatchObject({ seller: String(sellerIdentity), offers: [{ serviceId: A, pricePerUnit: String(PRICE), available: true, capacity: 2 }, { serviceId: B }] });

    const call = await request();
    const answer = await serve(call) as ServeAnswer;
    expect(answer).toMatchObject({ ok: true, result: { content: 'synthetic answer' } });
    const receipt = receiptFromWire(answer.receipt);
    expect(receipt).toMatchObject({ requestDigest: hashServiceRequest(domain, call), resultCommitment: resultCommitmentOf('synthetic answer'), units: 15n, valueWei: 15n * PRICE });
    const signer = receiptSignerOf(domain, receipt, answer.receiptSignature)!;
    expect(await buyerChain.verifyACKIdentityDetailed(signer, sellerIdentity)).toEqual({ valid: true });

    // An exact repeat, as a new message, gets the stored answer; the model ran once.
    const before = upstreamCalls;
    expect(await serve(call, session, 1)).toEqual(answer);
    expect(upstreamCalls).toBe(before);
    expect(codeOf(await serve({ ...call, maxUnits: 999n }))).toBe('NonceUsed');
  });

  it('refuses crafted requests: the wrong seller, an expired request, a price over the cap, an unknown subscription', async () => {
    const before = upstreamCalls;
    expect(codeOf(await serve(await request({ nonce: 10n, seller: sellerIdentity + 1n })))).toBe('BadSignature');
    expect(codeOf(await serve(await request({ nonce: 11n }), Wallet.createRandom()))).toBe('BadSignature');
    const expired = await request({ nonce: 12n });
    expect(codeOf(await serve({ ...expired, expiry: expired.issuedAt }))).toBe('Expired');
    expect(codeOf(await serve(await request({ nonce: 13n, serviceId: B })))).toBe('PriceOverCap');
    expect(codeOf(await serve(await request({ nonce: 14n, subscriptionId: `0x${'ab'.repeat(32)}` })))).toBe('SubscriptionNotFound');
    expect(codeOf(await serve(await request({ nonce: 15n, pricePerUnit: PRICE + 1n })))).toBe('WrongPrice');
    expect(upstreamCalls).toBe(before);
  });

  it('serves a chat completion through the buyer gateway, with an access key, from the routed seller', async () => {
    const minted = await route('POST', '/api/marketplace/keys', { label: 'test-agent', budget: String(10n ** 12n), rps: 100 });
    expect(minted.status).toBe(200);
    expect(minted.body.secret).toMatch(/^dkgmk_/);
    gatewayKey = minted.body.secret;
    // No key, and the node admin's token, which is not one.
    expect((await route('POST', GATEWAY_CHAT, CHAT, '')).status).toBe(401);
    expect((await route('POST', GATEWAY_CHAT, CHAT)).status).toBe(401);
    const models = await route('GET', MARKETPLACE_GATEWAY_ROUTES.models.path, undefined, minted.body.secret);
    expect(models.body.data.map((m: { id: string }) => m.id).sort()).toEqual([MODEL_A]);

    // Routed by the seller's signed offer alone: the peer it dials is the one the offer names.
    const answer = await route('POST', GATEWAY_CHAT, CHAT, minted.body.secret);
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({
      object: 'chat.completion', model: MODEL_A, choices: [{ message: { role: 'assistant', content: 'synthetic answer' } }],
      marketplace: { serviceId: A, seller: Number(sellerIdentity), units: 15, value: String(15n * PRICE) },
    });
    const keys = await route('GET', '/api/marketplace/keys');
    expect(keys.body.keys[0]).toMatchObject({ label: 'test-agent', spent: String(15n * PRICE) });
  });

  it("lands what the seller served, and the buyer's reconciliation matches it to the receipt it holds", async () => {
    // The node's first proof of the epoch, as RandomSampling records it: the Hub owner stands in.
    const provider = createProvider();
    const hub = new Contract(getSharedContext().hubAddress, ['function getContractAddress(string) view returns (address)'], provider);
    const rss = new Contract(await hub.getContractAddress('RandomSamplingStorage'), [
      'function addToNodeEpochScore(uint256 epoch, uint72 identityId, uint256 score)',
      'function addToAllNodesEpochScore(uint256 epoch, uint256 score)',
    ], new Wallet(HARDHAT_KEYS.DEPLOYER, provider));
    const { epoch } = await buyerChain.getEpochTimes();
    await (await rss.addToNodeEpochScore(epoch, sellerIdentity, 10n ** 18n)).wait();
    await (await rss.addToAllNodesEpochScore(epoch, 10n ** 18n)).wait();
    await provider.send('evm_increaseTime', [31]);
    await provider.send('evm_mine', []);

    // Landing now, through the seller node's route: the direct call's receipt and the gateway's, one group each, in one batch.
    const landed = await sellerRoute('POST', '/api/marketplace/seller/land');
    expect(landed).toMatchObject({ status: 200, body: { batches: [{ items: 2, value: String(30n * PRICE), counted: String(30n * PRICE) }], refused: 0 } });
    expect(await sellerRoute('GET', '/api/marketplace/seller')).toMatchObject({
      status: 200,
      body: {
        identityId: Number(sellerIdentity), gate: { profile: true, shardingTable: true }, scoredThisEpoch: true,
        ledger: { served: 0, landed: 2, landedValue: String(30n * PRICE) }, batches: [{ tx: landed.body.batches[0].tx, items: 2 }],
        thisEpoch: { servedValue: String(30n * PRICE) }, lastLanding: { refused: 0, waiting: false },
      },
    });
    // Held until the gateway's job sees it landed; then matched.
    expect((await route('GET', '/api/marketplace/reconciliation')).body.rows).toMatchObject([{ held: { count: 0 }, landed: { count: 1, matched: 1 } }]);
    await gateway.tick();
    const reconciled = await route('GET', '/api/marketplace/reconciliation');
    expect(reconciled).toMatchObject({ status: 200, body: { epoch, final: false } });
    expect(reconciled.body.rows).toEqual([{
      subscriptionId: subscriptionIdOf(new Wallet(HARDHAT_KEYS.EXTRA2).address, epoch), budgetIndex: 0, serviceId: A, seller: Number(sellerIdentity),
      held: { count: 0, value: '0', valueTrac: '0.0' },
      landed: { count: 1, matched: 1, value: String(15n * PRICE), valueTrac: ethers.formatEther(15n * PRICE), counted: String(15n * PRICE), countedTrac: ethers.formatEther(15n * PRICE), txs: [expect.stringMatching(/^0x[0-9a-f]{64}$/)] },
    }]);
  });

  it('shares an offer again when its next price is set, and the buyer keeps the newer copy', async () => {
    const { epoch } = await buyerChain.getEpochTimes();
    await selling.seller.setNextPrice(A, 2n * PRICE);
    await selling.seller.tick();
    const nextOfA = async () => (await gateway.router.offersOf([epoch + 1])).find((o) => o.serviceId === A);
    let next = await nextOfA();
    for (let i = 0; i < 240 && next?.pricePerUnit !== 2n * PRICE; i++) {
      await sleep(250);
      next = await nextOfA();
    }
    expect(next).toMatchObject({ seller: sellerIdentity, pricePerUnit: 2n * PRICE, peerId: sellerAgent.peerId });
  }, 120_000);

  it('shares its offers again after a restart, signed later, and the buyer routes by the new copies', async () => {
    const { epoch } = await buyerChain.getEpochTimes();
    const before = Math.max(...(await gateway.router.offersOf([epoch])).map((o) => o.signedAt));
    await selling.stop();
    // A later chain time, so the restarted seller signs later than its last copies.
    await createProvider().send('evm_increaseTime', [5]);
    await createProvider().send('evm_mine', []);
    selling = await startSeller();
    // The new copies reach the buyer's shared memory, and its router keeps them over the old ones.
    let offers = await gateway.router.offersOf([epoch]);
    for (let i = 0; i < 240 && !offers.every((o) => o.signedAt > before); i++) {
      await sleep(250);
      offers = await gateway.router.offersOf([epoch]);
    }
    expect(offers.map((o) => o.serviceId).sort()).toEqual([A, B].sort());
    expect(offers.every((o) => o.signedAt > before && o.peerId === sellerAgent.peerId)).toBe(true);
    const answer = await route('POST', GATEWAY_CHAT, CHAT, gatewayKey);
    expect(answer).toMatchObject({ status: 200, body: { marketplace: { seller: Number(sellerIdentity) } } });
  }, 120_000);

  it('takes a seller whose receipt over-reports out of routing, with a rogue handler on the seller node', async () => {
    await selling.stop();
    const honest = selling.seller;
    const rogue = sellerAgent.registerMarketplaceHandlers({
      quote: async (payload) => encodeMessage(await honest.quote(decodeMessage(payload))),
      serve: async (payload) => {
        const answer = await honest.serve(decodeMessage(payload));
        return encodeMessage(answer.ok ? { ...answer, receipt: { ...answer.receipt, units: '1000000', valueWei: String(10n ** 6n * PRICE) } } : answer);
      },
    }, { quote: PEER_LIMITS.quoteRequestBytes, serve: PEER_LIMITS.serveRequestBytes });
    try {
      const bad = await route('POST', GATEWAY_CHAT, CHAT, gatewayKey);
      expect(bad).toMatchObject({ status: 502, body: { error: { code: 'bad_receipt' }, problem: 'units_over_max' } });
      expect((await route('POST', GATEWAY_CHAT, CHAT, gatewayKey)).body.error.code).toBe('no_seller');
    } finally {
      rogue();
      selling = await startSeller();
    }
  });

  it('refuses new calls within the stop-serving window, and quotes itself unavailable', async () => {
    const call = await request({ nonce: 20n });
    const { endsAt } = await buyerChain.getEpochTimes();
    const provider = createProvider();
    const latest = (await provider.getBlock('latest'))!.timestamp;
    await provider.send('evm_increaseTime', [endsAt - 120 - latest]);
    await provider.send('evm_mine', []);
    expect(await serve(call)).toEqual({ ok: false, code: 'EpochEnding', retry: true });
    const quoted = decodeMessage(await buyerAgent.sendMarketplaceMessage(sellerAgent.peerId, 'quote', encodeMessage({ services: [A] }), {
      timeoutMs: PEER_LIMITS.quoteTimeoutMs, maxReadBytes: PEER_LIMITS.quoteResponseBytes,
    })) as QuoteResponse;
    expect(quoted.offers[0]!.available).toBe(false);
    // The buyer's gateway answers 503 until the next epoch starts.
    const gap = await route('POST', GATEWAY_CHAT, CHAT, gatewayKey);
    expect(gap).toMatchObject({ status: 503, body: { error: { code: 'epoch_ending' } } });
    expect(Number(gap.headers?.['Retry-After'])).toBeGreaterThan(0);
    expect(Number(gap.headers?.['Retry-After'])).toBeLessThanOrEqual(120);
  });
});
