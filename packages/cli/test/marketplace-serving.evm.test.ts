// SPDX-License-Identifier: Apache-2.0
/**
 * Serving end to end on the evm-module's Hardhat chain: a seller node and a
 * buyer node over libp2p on loopback, with the node's default settings (the
 * RFC-64 catalog carries the graph between nodes), the seller started as the
 * daemon starts it, and a stub OpenAI-compatible model on loopback (no model
 * download). A third node only owns the Marketplace Context Graph: a public
 * graph in its owner's wallet namespace, registered on chain open to any
 * publisher, which admits the seller and the buyer as it admits any node.
 *   - a seller without TRAC publishes nothing, stays unlisted with the reason
 *     in Operate, and the buyer routes to no one;
 *   - funded, it publishes each service's offer to the graph's Verifiable
 *     Memory, one Knowledge Asset per service, naming its node's peer id and
 *     signed by its operational wallet; the buyer reads them from its
 *     Verifiable Memory alone, one row per seller and service, with none in
 *     shared memory, and its gateway finds the seller from them alone. (The
 *     nodes connect on loopback so that the graph syncs; dialing by peer id on
 *     a real network is not shown here.)
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
 *   - a price set for the next epoch updates the same asset, still one row per
 *     seller and service, and the buyer routes by it;
 *   - a seller that restarts sends no transaction, and calls route as before;
 *   - a service dropped from the settings is withdrawn, and the buyer drops it;
 *   - with two epochs or fewer left, the asset is extended on chain and the
 *     offer published with its new last epoch.
 */
import { EventEmitter } from 'node:events';
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
  TERM_EPOCHS,
  type Buyer,
  type Gateway,
  decodeMessage,
  encodeMessage,
  receiptFromWire,
  receiptSignerOf,
  requestToWire,
  resultCommitmentOf,
  serviceIdOf,
  serviceOfferSignerOf,
  serviceOffersFromBindings,
  serviceOffersQuery,
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
const SELLER_WALLET = new Wallet(HARDHAT_KEYS.CORE_OP).address;

/** Ask `read` until `done` says yes, for up to a minute; the last answer either way. */
async function until<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  let value = await read();
  for (let i = 0; i < 240 && !done(value); i++) {
    await sleep(250);
    value = await read();
  }
  return value;
}

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
let subscriptionId: string;
const session = Wallet.createRandom();
let startSeller: (models?: string[]) => Promise<MarketplaceSellerRuntime>;
/** The Token, as the seller's operational wallet sends it. */
let sellerToken: Contract;
let gatewayBuyer: Buyer;
let gateway: Gateway;
/** An access key of the buyer node, made in the first gateway test. */
let gatewayKey: string;
const CHAT = { model: MODEL_A, messages: [{ role: 'user', content: 'synthetic question' }], max_tokens: 16 };
const GATEWAY_CHAT = MARKETPLACE_GATEWAY_ROUTES.chat.path;

/** One request through the daemon's marketplace routes: as the node admin, or with `token` as the bearer. */
async function route(method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; body: any; headers?: Record<string, string> }> {
  // Emitters, as the gateway listens for a client that goes away.
  const res: any = Object.assign(new EventEmitter(), { statusCode: 0, body: '' });
  res.writeHead = (status: number, headers?: Record<string, string>) => { res.statusCode = status; res.headers = headers; };
  res.setHeader = () => undefined;
  res.end = (text: string) => { res.body = text; res.writableEnded = true; };
  const req: any = Object.assign(new EventEmitter(), { method, url: path });
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

/** The offers in a node's Verifiable Memory of the graph, as its query returns them, signatures not checked. */
async function offersInVm(agent: DKGAgent) {
  const result = await agent.query(serviceOffersQuery(), { contextGraphId: contextGraph, view: 'verifiable-memory' });
  return serviceOffersFromBindings(result.bindings as Record<string, unknown>[]);
}

/** The listing of each service, as the seller node's Operate shows it. */
async function listings(): Promise<Record<string, any>> {
  const operate = await sellerRoute('GET', '/api/marketplace/seller');
  return Object.fromEntries(operate.body.offerings.map((o: any) => [o.serviceId, o.listing]));
}

/** A run of the seller's offer job, after any run its tick or its admission started. */
async function runOffers(): Promise<void> {
  await selling.seller.offers!.run();
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
    // Public, registered on chain, and open to any publisher: registering it takes the owner's deposit.
    const provider = createProvider();
    await mintTokens(provider, hubAddress, HARDHAT_KEYS.DEPLOYER, new Wallet(HARDHAT_KEYS.EXTRA3).address, ethers.parseEther('50000000'));
    await ownerAgent.createContextGraph({ id: contextGraph, name: 'Marketplace', description: 'Offers', accessPolicy: 0, callerAgentAddress: owner });
    await ownerAgent.registerContextGraph(contextGraph, { accessPolicy: 0, publishPolicy: 1, callerAgentAddress: owner });

    // The seller starts with no TRAC: what the harness gave its wallet goes back to the deployer.
    const hub = new Contract(hubAddress, ['function getContractAddress(string) view returns (address)'], provider);
    sellerToken = new Contract(await hub.getContractAddress('Token'), [
      'function transfer(address to, uint256 amount) returns (bool)', 'function balanceOf(address owner) view returns (uint256)',
    ], new Wallet(HARDHAT_KEYS.CORE_OP, provider));
    await (await sellerToken.transfer(new Wallet(HARDHAT_KEYS.DEPLOYER).address, await sellerToken.balanceOf(SELLER_WALLET))).wait();
    // A Core signs StorageACKs, its own publish's included, once its node has started its Verifiable Memory work.
    await until(async () => (sellerAgent as unknown as { vmReconcileRuntimeReady: boolean }).vmReconcileRuntimeReady, (ready) => ready);

    startSeller = async (models = [MODEL_A, MODEL_B]) => {
      const runtime = (await startMarketplaceSeller({
        config: {
          marketplace: {
            contextGraphId: contextGraph,
            seller: {
              enabled: true,
              services: models.map((model) => ({ model, pricePerUnit: String(PRICE), capacity: 2, backend: { kind: 'llamacpp', baseUrl, model: 'stub' } })),
              // Hardhat's base fee is above the testnet ceilings.
              landing: { baseFeeCeilingGwei: 1_000, lastStretchBaseFeeCeilingGwei: 1_000 },
            },
          },
        },
        agent: sellerAgent,
        signer: SELLER_WALLET,
        dataDir: sellerDir,
        log: () => undefined,
      }))!;
      await runtime.seller.tick();
      return runtime;
    };
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

  it('publishes nothing without TRAC, stays unlisted with the reason in Operate, and the buyer routes to no one', async () => {
    expect(selling.seller.gate.open).toBe(true);
    const nonce = await createProvider().getTransactionCount(SELLER_WALLET);
    // Asked until the graph admits the node and the publish meets the empty wallet.
    const unlisted = await until(async () => {
      await runOffers();
      return listings();
    }, (l) => l[A]?.problem === 'no-trac' && l[B]?.problem === 'no-trac');
    expect(unlisted[A]).toMatchObject({ listed: false, problem: 'no-trac', retryAt: expect.any(Number) });
    expect(unlisted[A].message).toMatch(/enough funds/);
    expect(await createProvider().getTransactionCount(SELLER_WALLET)).toBe(nonce);
    const { epoch } = await buyerChain.getEpochTimes();
    expect(await gateway.router.offersOf([epoch, epoch + 1])).toEqual([]);
    expect(await gateway.router.pick(A, epoch, 10n ** 12n)).toBeNull();
  }, 120_000);

  it('once funded, publishes each offer to Verifiable Memory, and the buyer routes from it: one row per seller and service, none in shared memory', async () => {
    await mintTokens(createProvider(), getSharedContext().hubAddress, HARDHAT_KEYS.DEPLOYER, SELLER_WALLET, 10n ** 21n);
    selling.seller.offers!.poke(true);
    await runOffers();
    const listed = await listings();
    const { epoch } = await buyerChain.getEpochTimes();
    for (const id of [A, B]) expect(listed[id]).toMatchObject({ listed: true, validUntilEpoch: epoch + TERM_EPOCHS, withdrawn: false });
    expect(listed[A]).not.toHaveProperty('problem');
    // Each its own Knowledge Asset of the seller's, named after its service, on chain through its last epoch.
    for (const id of [A, B]) {
      expect((await sellerAgent.assertion.history(contextGraph, `offer-${id}`))?.state).toBe('published');
      expect((await sellerAgent.chain.getKnowledgeAssetUpdateContext!(BigInt(listed[id].kaId))).endEpoch).toBe(BigInt(epoch + TERM_EPOCHS));
    }
    // The buyer reads them from its Verifiable Memory, and its gateway's router keeps them.
    const routed = await until(() => gateway.router.offersOf([epoch, epoch + 1]), (offers) => offers.length === 4);
    expect(routed.map((o) => `${o.serviceId}:${o.epoch}`).sort()).toEqual([`${A}:${epoch}`, `${A}:${epoch + 1}`, `${B}:${epoch}`, `${B}:${epoch + 1}`].sort());
    expect(routed.every((o) => o.seller === sellerIdentity && o.pricePerUnit === PRICE && o.provenance === 'weights-pinned' && o.peerId === sellerAgent.peerId)).toBe(true);
    const rows = await offersInVm(buyerAgent);
    expect(rows.map((o) => o.serviceId).sort()).toEqual([A, B].sort());
    expect(rows.every((o) => serviceOfferSignerOf(domain, o) === SELLER_WALLET)).toBe(true);
    const shared = await buyerAgent.query(serviceOffersQuery(), { contextGraphId: contextGraph, graphSuffix: '_shared_memory' });
    expect(shared.bindings).toEqual([]);
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

  it('updates the same asset when the next price is set, still one row per seller and service, and the buyer routes by it', async () => {
    const { epoch } = await buyerChain.getEpochTimes();
    const before = await listings();
    await selling.seller.setNextPrice(A, 2n * PRICE);
    await runOffers();
    const after = await listings();
    expect(after[A]).toMatchObject({ listed: true, kaId: before[A].kaId });
    expect(after[B]).toEqual(before[B]);
    const nextOfA = await until(async () => (await gateway.router.offersOf([epoch + 1])).find((o) => o.serviceId === A), (o) => o?.pricePerUnit === 2n * PRICE);
    expect(nextOfA).toMatchObject({ seller: sellerIdentity, pricePerUnit: 2n * PRICE, peerId: sellerAgent.peerId });
    expect((await gateway.router.offersOf([epoch])).find((o) => o.serviceId === A)?.pricePerUnit).toBe(PRICE);
    // The buyer holds the newest version alone.
    const rows = await offersInVm(buyerAgent);
    expect(rows.map((o) => o.serviceId).sort()).toEqual([A, B].sort());
    expect(rows.find((o) => o.serviceId === A)).toMatchObject({ pricePerUnit: PRICE, priceEpoch: epoch, nextPricePerUnit: 2n * PRICE });
  }, 120_000);

  it('sends no transaction after a restart, and the buyer routes as before', async () => {
    const nonce = await createProvider().getTransactionCount(SELLER_WALLET);
    const before = await listings();
    await selling.stop();
    selling = await startSeller();
    await runOffers();
    expect(await listings()).toEqual(before);
    expect(await createProvider().getTransactionCount(SELLER_WALLET)).toBe(nonce);
    const answer = await route('POST', GATEWAY_CHAT, CHAT, gatewayKey);
    expect(answer).toMatchObject({ status: 200, body: { marketplace: { seller: Number(sellerIdentity) } } });
  }, 120_000);

  it('withdraws a service its settings no longer name, by an update of its asset, and the buyer drops it', async () => {
    const { epoch } = await buyerChain.getEpochTimes();
    const before = await listings();
    await selling.stop();
    selling = await startSeller([MODEL_A]);
    await runOffers();
    expect(selling.seller.offers!.listingOf(B, epoch)).toMatchObject({ listed: false, withdrawn: true, kaId: before[B].kaId });
    const offered = await until(() => gateway.router.offersOf([epoch]), (offers) => !offers.some((o) => o.serviceId === B));
    expect(offered.map((o) => o.serviceId)).toEqual([A]);
    expect((await offersInVm(buyerAgent)).find((o) => o.serviceId === B)).toMatchObject({ withdrawn: true });
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

  it('extends its offer\'s asset on chain when two epochs or fewer are left, and publishes its new last epoch', async () => {
    const { epoch, endsAt } = await buyerChain.getEpochTimes();
    const kaId = BigInt((await listings())[A].kaId);
    expect((await sellerAgent.chain.getKnowledgeAssetUpdateContext!(kaId)).endEpoch).toBe(BigInt(epoch + TERM_EPOCHS));
    const provider = createProvider();
    const latest = (await provider.getBlock('latest'))!.timestamp;
    // Into the epoch with two left of the asset's term.
    const epochLength = endsAt - (await buyerChain.getEpochTimes()).startsAt;
    await provider.send('evm_increaseTime', [endsAt - latest + (TERM_EPOCHS - 3) * epochLength + 60]);
    await provider.send('evm_mine', []);
    expect((await buyerChain.getEpochTimes()).epoch).toBe(epoch + TERM_EPOCHS - 2);
    const tokens = await sellerToken.balanceOf(SELLER_WALLET);
    await selling.seller.tick();
    await runOffers();
    expect((await sellerAgent.chain.getKnowledgeAssetUpdateContext!(kaId)).endEpoch).toBe(BigInt(epoch + 2 * TERM_EPOCHS));
    expect(await sellerToken.balanceOf(SELLER_WALLET)).toBeLessThan(tokens);
    expect(await listings()).toMatchObject({ [A]: { listed: true, kaId: String(kaId), validUntilEpoch: epoch + 2 * TERM_EPOCHS } });
    // B, listed again by the seller's restart after the rogue handler, is extended too: A is looked for by its id.
    const routed = await until(() => gateway.router.offersOf([epoch + TERM_EPOCHS + 1]), (offers) => offers.some((o) => o.serviceId === A));
    expect(routed.find((o) => o.serviceId === A)).toMatchObject({ seller: sellerIdentity, serviceId: A });
  }, 180_000);
});
