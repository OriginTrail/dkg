// SPDX-License-Identifier: Apache-2.0
//
// The marketplace buyer's routes (OT-RFC-27), under /api/marketplace, beside
// /api/pca: the buyer's subscriptions, a dry run, fundings and top-ups, the
// standing plan, the buyer wallet's funding, the accounts it can use, and an
// owner's actions on an account the node owns. `packages/marketplace` builds
// each answer; this module reads the request and maps refusals.
//
// Reads need any valid token; writes need the node-admin token. Amounts are
// decimal strings of wei with `…Trac` siblings, times are chain seconds, and a
// refusal is { error, code, args?, retryable }, with the contract error's name
// as `code`.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { ethers } from 'ethers';
import {
  MarketplaceRefusal,
  PlanError,
  accountsView,
  addBuyer,
  buyerConsent,
  contractsView,
  dryRunView,
  fundingView,
  parseEpoch,
  parsePlan,
  parseServices,
  parseSource,
  parseWei,
  planView,
  refusalOf,
  removeBuyer,
  setBuyerLimits,
  setServiceSpending,
  subscriptionView,
  subscriptionsView,
  txView,
  type AccessKeyScopes,
  type Buyer,
  type FundingRequest,
  type Gateway,
} from '@origintrail-official/dkg-marketplace';
import type { BuyerLimits } from '@origintrail-official/dkg-chain';
import { canAdministerNode } from '../../auth.js';
import { jsonResponse, readBody, respondIfChainRpcTransportError, sanitizeRpcMessage, SMALL_BODY_BYTES } from '../http-utils.js';
import type { RequestContext } from './context.js';
import { handleMarketplaceGatewayRoutes } from './marketplace-gateway.js';
import { isMarketplaceGatewayRoute } from './marketplace-gateway-paths.js';

const PREFIX = '/api/marketplace';

// The status of a refusal by its kind. Any other refusal the contracts make
// is a conflict with the chain's state as it is now: 409.
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
  QueryInferencePaused: 503,
  QueryInferenceNotActive: 503,
  MarketplaceOff: 503,
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

/** The subscription a funding or top-up just changed; `null` while the read lags the send, which succeeded. */
async function subscriptionAfter(buyer: Buyer, subscriptionId: string) {
  const subscription = await buyer.chain.getSubscription(subscriptionId);
  return subscription ? subscriptionView(buyer.chain, subscription) : null;
}

/** The answer to `method route`, or `undefined` when no route matches. */
async function answer(buyer: Buyer, method: string, route: string, ctx: RequestContext): Promise<unknown> {
  const { req, url } = ctx;
  if (method === 'GET' && route === '/subscriptions') {
    const { epoch } = await buyer.chain.getEpochTimes();
    const asked = url.searchParams.get('epoch');
    return subscriptionsView(buyer, asked === null ? [epoch, epoch + 1] : [parseEpoch(asked, epoch)]);
  }
  if (method === 'POST' && route === '/subscriptions/preview') {
    return dryRunView(buyer.chain, await buyer.dryRun(await fundingRequestOf(buyer, req)));
  }
  if (method === 'POST' && route === '/subscriptions') {
    const funded = await buyer.fund(await fundingRequestOf(buyer, req));
    return { ...txView(funded), subscription: await subscriptionAfter(buyer, funded.subscriptionId) };
  }
  const topUp = /^\/subscriptions\/(0x[0-9a-fA-F]{64})\/top-up$/.exec(route);
  if (method === 'POST' && topUp) {
    const subscriptionId = topUp[1]!.toLowerCase();
    const sent = await buyer.topUp(subscriptionId, parseServices((await bodyOf(req)).services));
    return { ...txView(sent), subscription: await subscriptionAfter(buyer, subscriptionId) };
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
  if (method === 'GET' && route === '/funding') return fundingView(buyer);
  if (method === 'GET' && route === '/accounts') return accountsView(buyer);
  if (method === 'GET' && route === '/accounts/contracts') return contractsView(buyer);

  // GET, POST /keys and POST /keys/{keyId}/revoke: the gateway's access keys.
  if (route === '/keys' && method === 'GET') return { keys: await gatewayOf(ctx).keys.list() };
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
  const buyer = ctx.marketplace;
  if (!buyer) {
    return refuse(res, 'MarketplaceOff', 'The marketplace is off on this node: it needs marketplace.enabled and a chain with the marketplace contracts');
  }
  const method = req.method ?? 'GET';
  if (method !== 'GET' && !canAdministerNode(ctx.actor.authentication)) {
    return refuse(res, 'NodeAdminRequired', 'A node-admin token is required to fund, sign, act as an account owner or manage access keys');
  }
  try {
    const result = await answer(buyer, method, decodeURIComponent(path.slice(PREFIX.length)), ctx);
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
