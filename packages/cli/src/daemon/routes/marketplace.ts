// SPDX-License-Identifier: Apache-2.0
//
// The marketplace's routes (OT-RFC-27), under /api/marketplace, beside
// /api/pca: the buyer's subscriptions, fundings and top-ups and a dry run of
// each, the standing plan, the buyer wallet's funding, the accounts it can
// use, an owner's actions on an account the node owns, the gateway's access
// keys, and the reconciliation of what it holds against what landed; and the
// seller's, under /seller: Operate, landing now, and the next epoch's prices.
// `packages/marketplace` builds each answer; this module reads the request and
// maps refusals.
//
// Writes, the access keys and their calls need the node-admin token; other
// reads need any valid token. Amounts are decimal strings of wei with `…Trac`
// siblings, times are chain seconds, and a refusal is
// { error, code, args?, retryable }, with the contract error's name as `code`.
//
// A top-up may carry an `idempotencyKey`: the node sends it at most once for
// that key, and a repeat gets the first answer (`Buyer.topUpOnce`). A key
// that names another request is refused with 409 `IdempotencyKeyReused`, and
// a repeat of one whose outcome is not known yet with 503 `TopUpOutcomeUnknown`.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { ethers } from 'ethers';
import {
  MarketplaceRefusal,
  PlanError,
  accountsView,
  addBuyer,
  buyerConsent,
  catalogView,
  contractsView,
  dryRunView,
  fundingView,
  landNowView,
  parseEpoch,
  parsePlan,
  parseServices,
  parseSource,
  parseWei,
  planView,
  refusalOf,
  removeBuyer,
  sellerStatusView,
  sellerView,
  serviceDetailView,
  setBuyerLimits,
  setNextPriceView,
  setServiceSpending,
  subscriptionView,
  subscriptionsView,
  txView,
  type AccessKeyScopes,
  type Buyer,
  type FundingRequest,
  type Gateway,
  type HeldValue,
  type Seller,
} from '@origintrail-official/dkg-marketplace';
import type { BuyerLimits } from '@origintrail-official/dkg-chain';
import { canAdministerNode } from '../../auth.js';
import { jsonResponse, readBody, respondIfChainRpcTransportError, sanitizeRpcMessage, SMALL_BODY_BYTES } from '../http-utils.js';
import type { RequestContext } from './context.js';
import { handleMarketplaceGatewayRoutes } from './marketplace-gateway.js';
import { isMarketplaceGatewayRoute } from './marketplace-gateway-paths.js';

const PREFIX = '/api/marketplace';

/**
 * A view's `accountsError` is a chain read's error message. Like an error body, it must not carry RPC URLs, which
 * can hold an API key: they are stripped here, as `sanitizeRpcMessage` strips them from error bodies.
 */
function withRedactedAccountsError<V extends { accountsError?: string }>(view: V): V {
  return view.accountsError === undefined ? view : { ...view, accountsError: sanitizeRpcMessage(view.accountsError) };
}

// The status of a refusal by its kind. Any other refusal, the contracts' and
// the seller's `EpochStarted` among them, is a conflict with the chain's state
// as it is now: 409.
const REFUSAL_STATUS: Readonly<Record<string, number>> = {
  InvalidRequest: 400,
  InvalidFundingRequest: 400,
  InvalidBuyerTerms: 400,
  BudgetTermsChanged: 400,
  ZeroSessionKey: 400,
  ConsentMissing: 400,
  InvalidConsentSignature: 400,
  NodeAdminRequired: 403,
  NotAccountOwner: 403,
  NotSubscriptionBuyer: 403,
  ERC721NonexistentToken: 404,
  SubscriptionNotFound: 404,
  NotABuyer: 404,
  PlanNotFound: 404,
  KeyNotFound: 404,
  ServiceNotFound: 404,
  SellerNotFound: 404,
  IdempotencyKeyReused: 409,
  QueryInferencePaused: 503,
  QueryInferenceNotActive: 503,
  MarketplaceOff: 503,
  TopUpOutcomeUnknown: 503,
};

function refuse(res: ServerResponse, code: string, error: string, args: readonly string[] = []): void {
  const status = REFUSAL_STATUS[code] ?? 409;
  jsonResponse(res, status, { error, code, ...(args.length ? { args } : {}), retryable: status === 503 });
}

async function bodyOf(req: IncomingMessage): Promise<Record<string, unknown>> {
  try {
    const body: unknown = JSON.parse((await readBody(req, SMALL_BODY_BYTES)) || '{}');
    if (body && typeof body === 'object' && !Array.isArray(body)) return body as Record<string, unknown>;
  } catch {
    // Not JSON: refused below.
  }
  throw new PlanError('the body must be a JSON object');
}

function accountIdOf(raw: string): bigint {
  if (!/^[1-9]\d*$/.test(raw)) throw new PlanError('the account id must be a positive integer');
  return BigInt(raw);
}

function addressOf(raw: unknown, field: string): string {
  if (typeof raw !== 'string' || !ethers.isAddress(raw)) throw new PlanError(`${field} must be an EVM address`);
  return ethers.getAddress(raw);
}

function limitsOf(body: Record<string, unknown>): BuyerLimits {
  const expiresAt = body.expiresAt;
  if (typeof expiresAt !== 'number' || !Number.isSafeInteger(expiresAt) || expiresAt <= 0) {
    throw new PlanError('expiresAt must be a time in chain seconds');
  }
  return { maxCostPerEpoch: parseWei(body.maxCostPerEpoch, 'maxCostPerEpoch'), expiresAt };
}

async function fundingRequestOf(buyer: Buyer, req: IncomingMessage): Promise<FundingRequest> {
  const body = await bodyOf(req);
  const { epoch } = await buyer.chain.getEpochTimes();
  return { epoch: parseEpoch(body.epoch, epoch), source: parseSource(body.source), services: parseServices(body.services) };
}

/** A top-up's key: absent, or a short token of letters, digits and `._:-` (a UUID, say). */
function idempotencyKeyOf(raw: unknown): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(raw)) {
    throw new PlanError('idempotencyKey must be 1 to 128 letters, digits or ._:-');
  }
  return raw;
}

/** An access key's scopes from a request: a label, a budget in wei, and its services, rate and expiry if it limits them. */
function scopesOf(body: Record<string, unknown>): AccessKeyScopes {
  if (typeof body.label !== 'string' || body.label === '' || body.label.length > 100) throw new PlanError('label must be a short text');
  const services = body.services ?? null;
  if (services !== null && (!Array.isArray(services) || !services.every((s) => typeof s === 'string' && ethers.isHexString(s, 32)))) {
    throw new PlanError('services must be a list of service ids');
  }
  const rps = body.rps ?? 5;
  if (typeof rps !== 'number' || !Number.isSafeInteger(rps) || rps < 1 || rps > 1_000) throw new PlanError('rps must be a whole number from 1 to 1000');
  const expiresAt = body.expiresAt ?? null;
  if (expiresAt !== null && (typeof expiresAt !== 'number' || !Number.isSafeInteger(expiresAt) || expiresAt <= 0)) {
    throw new PlanError('expiresAt must be a time in seconds');
  }
  return {
    label: body.label,
    budget: parseWei(body.budget, 'budget'),
    services: services === null ? null : (services as string[]).map((s) => s.toLowerCase()),
    rps,
    expiresAt,
  };
}

function gatewayOf(ctx: RequestContext): Gateway {
  if (!ctx.marketplaceGateway) throw new MarketplaceRefusal('MarketplaceOff');
  return ctx.marketplaceGateway;
}

/** The gateway's held value of a budget, while the gateway runs. */
function heldOf(ctx: RequestContext): HeldValue | undefined {
  const gateway = ctx.marketplaceGateway;
  return gateway ? (subscriptionId, budgetIndex) => gateway.heldValue(subscriptionId, budgetIndex) : undefined;
}

/** The subscription a funding or top-up just changed; `null` while the read lags the send, which succeeded. */
async function subscriptionAfter(buyer: Buyer, subscriptionId: string, ctx: RequestContext) {
  const subscription = await buyer.chain.getSubscription(subscriptionId);
  return subscription ? subscriptionView(buyer.chain, subscription, heldOf(ctx)) : null;
}

/** The answer to a seller route, under /seller, or `undefined` when none matches. */
async function sellerAnswer(seller: Seller, method: string, route: string, req: IncomingMessage): Promise<unknown> {
  if (method === 'GET' && route === '/seller') return sellerStatusView(seller);
  if (method === 'POST' && route === '/seller/land') return landNowView(seller);
  const price = /^\/seller\/offerings\/(0x[0-9a-fA-F]{64})\/price$/.exec(route);
  if (method === 'PUT' && price) return setNextPriceView(seller, price[1]!.toLowerCase(), parseWei((await bodyOf(req)).price, 'price'));
  return undefined;
}

/** The answer to `method route`, or `undefined` when no route matches. */
async function answer(buyer: Buyer, method: string, route: string, ctx: RequestContext): Promise<unknown> {
  const { req, url } = ctx;
  if (method === 'GET' && route === '/subscriptions') {
    const { epoch } = await buyer.chain.getEpochTimes();
    const asked = url.searchParams.get('epoch');
    return subscriptionsView(buyer, asked === null ? [epoch, epoch + 1] : [parseEpoch(asked, epoch)], heldOf(ctx));
  }
  if (method === 'POST' && route === '/subscriptions/preview') {
    return dryRunView(buyer.chain, await buyer.dryRun(await fundingRequestOf(buyer, req)));
  }
  if (method === 'POST' && route === '/subscriptions') {
    const funded = await buyer.fund(await fundingRequestOf(buyer, req));
    return { ...txView(funded), subscription: await subscriptionAfter(buyer, funded.subscriptionId, ctx) };
  }
  const topUpDryRun = /^\/subscriptions\/(0x[0-9a-fA-F]{64})\/top-up\/preview$/.exec(route);
  if (method === 'POST' && topUpDryRun) {
    return dryRunView(buyer.chain, await buyer.dryRunTopUp(topUpDryRun[1]!.toLowerCase(), parseServices((await bodyOf(req)).services)));
  }
  const topUp = /^\/subscriptions\/(0x[0-9a-fA-F]{64})\/top-up$/.exec(route);
  if (method === 'POST' && topUp) {
    const subscriptionId = topUp[1]!.toLowerCase();
    const body = await bodyOf(req);
    const services = parseServices(body.services);
    const key = idempotencyKeyOf(body.idempotencyKey);
    const sent = key === undefined ? txView(await buyer.topUp(subscriptionId, services)) : await buyer.topUpOnce(subscriptionId, services, key);
    // The top-up went through: a read of its subscription that fails leaves the answer without it, as one that lags does.
    return { ...sent, subscription: await subscriptionAfter(buyer, subscriptionId, ctx).catch(() => null) };
  }
  if (route === '/plan' && method === 'PUT') {
    const plan = parsePlan(await bodyOf(req));
    await buyer.store.writePlan(plan);
    return planView(buyer, plan);
  }
  if (route === '/plan' && method === 'GET') {
    const plan = await buyer.store.readPlan();
    if (!plan) throw new MarketplaceRefusal('PlanNotFound');
    return planView(buyer, plan);
  }
  // The catalog, from the offers in the Marketplace Context Graph, and the gateway's calls.
  if (method === 'GET' && route === '/catalog') return catalogView(gatewayOf(ctx));
  const service = /^\/services\/(0x[0-9a-fA-F]{64})$/.exec(route);
  if (method === 'GET' && service) return serviceDetailView(gatewayOf(ctx), service[1]!);
  const storefront = /^\/sellers\/([1-9]\d{0,20})$/.exec(route);
  if (method === 'GET' && storefront) return sellerView(gatewayOf(ctx), BigInt(storefront[1]!));
  // Each access key's calls: the node admin's alone, as the keys are.
  if (method === 'GET' && route === '/activity') {
    if (!canAdministerNode(ctx.actor.authentication)) throw new MarketplaceRefusal('NodeAdminRequired');
    const { epoch } = await buyer.chain.getEpochTimes();
    const asked = url.searchParams.get('epoch');
    return gatewayOf(ctx).activity(asked === null ? epoch : parseEpoch(asked, epoch), url.searchParams.get('key') ?? undefined);
  }
  if (method === 'GET' && route === '/reconciliation') {
    const { epoch } = await buyer.chain.getEpochTimes();
    const asked = url.searchParams.get('epoch');
    return gatewayOf(ctx).reconciliation(asked === null ? epoch : parseEpoch(asked, epoch));
  }
  if (method === 'GET' && route === '/funding') return withRedactedAccountsError(await fundingView(buyer));
  if (method === 'GET' && route === '/accounts') return withRedactedAccountsError(await accountsView(buyer));
  if (method === 'GET' && route === '/accounts/contracts') return contractsView(buyer);

  // GET, POST /keys and POST /keys/{keyId}/revoke: the gateway's access keys, the node admin's alone.
  if (route === '/keys' && method === 'GET') {
    if (!canAdministerNode(ctx.actor.authentication)) throw new MarketplaceRefusal('NodeAdminRequired');
    return { keys: await gatewayOf(ctx).keys.list() };
  }
  if (route === '/keys' && method === 'POST') {
    const { secret, key } = await gatewayOf(ctx).keys.make(scopesOf(await bodyOf(req)), Math.floor(Date.now() / 1000));
    return { ...key, secret };
  }
  const revoke = /^\/keys\/([^/]+)\/revoke$/.exec(route);
  if (revoke && method === 'POST') {
    const key = await gatewayOf(ctx).keys.revoke(revoke[1]!, Math.floor(Date.now() / 1000));
    if (!key) throw new MarketplaceRefusal('KeyNotFound', [revoke[1]!]);
    return key;
  }

  const onAccount = /^\/accounts\/([^/]+)\/(buyer-consent|service-spending|buyers)$/.exec(route);
  if (method === 'POST' && onAccount) {
    const accountId = accountIdOf(onAccount[1]!);
    const body = await bodyOf(req);
    if (onAccount[2] === 'buyer-consent') return buyerConsent(buyer, accountId, limitsOf(body));
    if (onAccount[2] === 'service-spending') {
      if (typeof body.enabled !== 'boolean') throw new PlanError('enabled must be true or false');
      return txView(await setServiceSpending(buyer, accountId, body.enabled));
    }
    if (body.buyerSignature !== undefined && typeof body.buyerSignature !== 'string') throw new PlanError('buyerSignature must be a hex string');
    return txView(await addBuyer(buyer, accountId, {
      ...limitsOf(body),
      ...(body.buyer !== undefined ? { buyer: addressOf(body.buyer, 'buyer') } : {}),
      ...(body.buyerSignature !== undefined ? { buyerSignature: body.buyerSignature } : {}),
    }));
  }
  const onBuyer = /^\/accounts\/([^/]+)\/buyers\/([^/]+?)(\/limits)?$/.exec(route);
  if (onBuyer && method === 'POST' && onBuyer[3]) {
    const limits = limitsOf(await bodyOf(req));
    return txView(await setBuyerLimits(buyer, accountIdOf(onBuyer[1]!), addressOf(onBuyer[2], 'buyer'), limits));
  }
  if (onBuyer && method === 'DELETE' && !onBuyer[3]) {
    return txView(await removeBuyer(buyer, accountIdOf(onBuyer[1]!), addressOf(onBuyer[2], 'buyer')));
  }
  return undefined;
}

export async function handleMarketplaceRoutes(ctx: RequestContext): Promise<void> {
  const { req, res, path } = ctx;
  if (path !== PREFIX && !path.startsWith(`${PREFIX}/`)) return;
  // The gateway checks its own callers, before anything else.
  if (isMarketplaceGatewayRoute(req.method, path)) return handleMarketplaceGatewayRoutes(ctx);
  const selling = path === `${PREFIX}/seller` || path.startsWith(`${PREFIX}/seller/`);
  const buyer = ctx.marketplace;
  const seller = ctx.marketplaceSeller;
  if (selling ? !seller : !buyer) {
    return refuse(res, 'MarketplaceOff', selling
      ? 'Selling is off on this node: it needs marketplace.seller.enabled and a chain with the marketplace contracts'
      : 'The marketplace is off on this node: it needs marketplace.enabled and a chain with the marketplace contracts');
  }
  const method = req.method ?? 'GET';
  if (method !== 'GET' && !canAdministerNode(ctx.actor.authentication)) {
    return refuse(res, 'NodeAdminRequired', 'A node-admin token is required to fund, sign, act as an account owner, manage access keys, land or set prices');
  }
  try {
    const route = decodeURIComponent(path.slice(PREFIX.length));
    const result = selling ? await sellerAnswer(seller!, method, route, req) : await answer(buyer!, method, route, ctx);
    if (result === undefined) return jsonResponse(res, 404, { error: 'Not found' });
    return jsonResponse(res, 200, result);
  } catch (err) {
    if (err instanceof PlanError || err instanceof URIError) return refuse(res, 'InvalidRequest', err.message);
    const refusal = refusalOf(err);
    if (refusal) return refuse(res, refusal.code, `${refusal.code}(${refusal.args.join(', ')})`, refusal.args);
    if (err instanceof Error && /^Hub\w*NotFoundError$/.test(err.name)) {
      return refuse(res, 'MarketplaceOff', 'The chain has no marketplace contracts');
    }
    if (respondIfChainRpcTransportError(res, err, { retryable: true })) return;
    return jsonResponse(res, 500, { error: sanitizeRpcMessage(err instanceof Error ? err.message : String(err)), code: 'Error', retryable: false });
  }
}
