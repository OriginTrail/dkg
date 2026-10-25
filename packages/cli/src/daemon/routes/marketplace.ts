// OT-RFC-27 marketplace operator routes: the daemon surface over the agent's
// marketplace mixin (`agent.marketplace*`). Reads (status, offers, meter) are
// ungated; every mutating route is node-admin-gated like the sibling PCA
// writes (the on-chain funding/claim transactions are signed with the node's
// own wallets). Wei amounts cross this boundary as decimal strings — the
// shared jsonResponse serializer stringifies every bigint on the way out, and
// `parseMarketplaceUint` rejects JSON numbers above 2^53 on the way in.

import { ethers } from 'ethers';
import type {
  MarketplaceOfferingConfig,
  MarketplaceSettleAction,
} from '@origintrail-official/dkg-agent';
import {
  jsonResponse,
  readBody,
  SMALL_BODY_BYTES,
  respondIfChainRpcTransportError,
} from '../http-utils.js';
import type { RequestContext } from './context.js';
import { canAdministerNode } from '../../auth.js';
import {
  MARKETPLACE_SERVICE_TYPES,
  parseMarketplaceOffering,
  parseMarketplaceUint,
} from '../../marketplace-config.js';

// The agent mixin's own parameter types, extracted instead of imported: the
// CLI package has no direct dependency on the marketplace domain package, and
// the agent's method signatures are the one authoritative wire contract here.
type MarketplaceAgent = RequestContext['agent'];
type AgentPlanPolicy = Parameters<MarketplaceAgent['marketplaceSubscribe']>[0]['policy'];
type AgentServiceType = Parameters<MarketplaceAgent['marketplaceInvoke']>[0]['serviceType'];

const FEATURE_UNAVAILABLE_503 = {
  error:
    'Marketplace is not available on this node — it requires config.marketplace.enabled '
    + '(or DKG_MARKETPLACE_ENABLED=1) and a marketplace-capable chain adapter',
};

/**
 * `POST /api/marketplace/invoke` without `maxUnits`: the worst-case unit
 * grant the authorization carries. The router still enforces the plan
 * bucket's `maxUnitsPerCall`, so a default above a bucket cap fails the
 * route rather than over-authorizing.
 */
const DEFAULT_INVOKE_MAX_UNITS = 1000n;

const SETTLE_ACTIONS: readonly MarketplaceSettleAction[] = ['flush-receipts', 'finalize', 'claim', 'roll'];

function safeParseJson(body: string): { ok: true; value: any } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(body) };
  } catch (e: any) {
    return { ok: false, error: `Invalid JSON: ${e?.message ?? String(e)}` };
  }
}

// The mixin's requireRuntime gate and the buyer service's capability checks
// → 503 (deployment gap, not a caller error). Matched on message because the
// runtime-off signal is a plain Error thrown across the agent boundary.
function isMarketplaceOff(msg: string): boolean {
  return /marketplace is not running on this node/i.test(msg)
    || /chain adapter does not support marketplace/i.test(msg)
    || /chain adapter (?:cannot|reports no)/i.test(msg)
    || /No blockchain configured/i.test(msg);
}

// Caller errors the agent reports as plain Errors: a missing settle default
// or an epoch the adapter cannot resolve → 400 (pass the field explicitly).
function isMissingCallerInput(msg: string): boolean {
  return /pass `epoch`|pass `buyer`|cannot resolve the current epoch/i.test(msg);
}

/**
 * One classification for every agent-thrown marketplace error. The typed
 * buyer errors are matched by their stable `name` (set in their constructors)
 * rather than `instanceof`, so this module stays free of value imports from
 * the agent runtime root and the route tests stay in the fast unit lane.
 */
function respondMarketplaceError(res: RequestContext['res'], err: any, prefix: string): void {
  const msg = err?.message ?? String(err);
  if (isMarketplaceOff(msg)) return jsonResponse(res, 503, FEATURE_UNAVAILABLE_503);
  if (err?.name === 'MarketplaceNotSubscribedError') {
    return jsonResponse(res, 409, { error: msg, code: 'NOT_SUBSCRIBED' });
  }
  if (err?.name === 'MarketplaceRouteError') {
    return jsonResponse(res, 409, {
      error: msg,
      code: 'NO_ROUTE',
      reason: err.reason,
      rejections: err.rejections ?? [],
    });
  }
  if (err?.name === 'MarketplaceInvokeError') {
    // The selected seller (or its transport) failed the call — upstream fault.
    return jsonResponse(res, 502, { error: msg, code: err.code ?? 'INVOKE_FAILED' });
  }
  if (/seller role unavailable/i.test(msg)) {
    return jsonResponse(res, 409, { error: msg, code: 'SELLER_UNAVAILABLE' });
  }
  if (isMissingCallerInput(msg)) return jsonResponse(res, 400, { error: msg });
  if (respondIfChainRpcTransportError(res, err)) return;
  return jsonResponse(res, 500, { error: `${prefix} failed: ${msg}` });
}

function parseIdentityIdList(raw: unknown, field: string): bigint[] {
  if (!Array.isArray(raw)) throw new Error(`${field} must be an array of node identityIds`);
  return raw.map((entry, index) => parseMarketplaceUint(entry, `${field}[${index}]`));
}

/**
 * Parse the subscribe body's `policy` into the agent's `PlanPolicy`. Bucket
 * indexes are positional — they align 1:1 with the meter the agent keeps —
 * so the array order the caller sends is preserved verbatim.
 */
function parsePlanPolicy(raw: unknown): AgentPlanPolicy {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('policy must be an object ({ totalBudgetWei, buckets, ... })');
  }
  const policy = raw as Record<string, unknown>;
  if (!Array.isArray(policy.buckets) || policy.buckets.length === 0) {
    throw new Error('policy.buckets must be a non-empty array');
  }
  const buckets = policy.buckets.map((rawBucket, index) => {
    const field = `policy.buckets[${index}]`;
    if (!rawBucket || typeof rawBucket !== 'object' || Array.isArray(rawBucket)) {
      throw new Error(`${field} must be a bucket object`);
    }
    const bucket = rawBucket as Record<string, unknown>;
    const match = bucket.match as Record<string, unknown> | undefined;
    if (!match || typeof match !== 'object' || Array.isArray(match)) {
      throw new Error(`${field}.match must be an object ({ serviceType, modelId? })`);
    }
    if (typeof match.serviceType !== 'string'
      || !(MARKETPLACE_SERVICE_TYPES as readonly string[]).includes(match.serviceType)) {
      throw new Error(`${field}.match.serviceType must be one of ${MARKETPLACE_SERVICE_TYPES.join(', ')}`);
    }
    if (match.modelId !== undefined && typeof match.modelId !== 'string') {
      throw new Error(`${field}.match.modelId must be a string`);
    }
    return {
      match: {
        serviceType: match.serviceType as AgentServiceType,
        ...(match.modelId !== undefined ? { modelId: match.modelId } : {}),
      },
      budgetWei: parseMarketplaceUint(bucket.budgetWei, `${field}.budgetWei`),
      priceCapWeiPerUnit: parseMarketplaceUint(bucket.priceCapWeiPerUnit, `${field}.priceCapWeiPerUnit`),
      maxUnitsPerCall: parseMarketplaceUint(bucket.maxUnitsPerCall, `${field}.maxUnitsPerCall`),
    };
  });
  if (policy.softCeilingBps !== undefined
    && (typeof policy.softCeilingBps !== 'number' || !Number.isInteger(policy.softCeilingBps)
      || policy.softCeilingBps < 0 || policy.softCeilingBps > 10_000)) {
    throw new Error('policy.softCeilingBps must be an integer between 0 and 10000');
  }
  return {
    totalBudgetWei: parseMarketplaceUint(policy.totalBudgetWei, 'policy.totalBudgetWei'),
    buckets,
    ...(policy.sellerAllow !== undefined ? { sellerAllow: parseIdentityIdList(policy.sellerAllow, 'policy.sellerAllow') } : {}),
    ...(policy.sellerDeny !== undefined ? { sellerDeny: parseIdentityIdList(policy.sellerDeny, 'policy.sellerDeny') } : {}),
    ...(policy.softCeilingBps !== undefined ? { softCeilingBps: policy.softCeilingBps } : {}),
  };
}

/** `amountWei` (decimal wei string) or `amountTrac` (decimal TRAC) — exactly one. */
function parseSubscriptionAmountWei(body: Record<string, unknown>): bigint {
  const { amountWei, amountTrac } = body;
  if ((amountWei === undefined) === (amountTrac === undefined)) {
    throw new Error('pass exactly one of amountWei (decimal wei string) or amountTrac (decimal TRAC)');
  }
  if (amountWei !== undefined) {
    const wei = parseMarketplaceUint(amountWei, 'amountWei');
    if (wei <= 0n) throw new Error('amountWei must be > 0');
    return wei;
  }
  if (typeof amountTrac !== 'string' && typeof amountTrac !== 'number') {
    throw new Error('amountTrac must be a decimal number of TRAC tokens');
  }
  const s = String(amountTrac).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error('amountTrac must be a positive decimal number of TRAC tokens');
  const wei = ethers.parseEther(s);
  if (wei <= 0n) throw new Error('amountTrac must be > 0');
  return wei;
}

export async function handleMarketplaceRoutes(ctx: RequestContext): Promise<void> {
  const { req, res, agent, path, authentication } = ctx;

  if (!path.startsWith('/api/marketplace')) return;

  // Mutating routes move the node's own TRAC (subscribe) or submit node-signed
  // transactions (offerings publish, settle), so they require the node-admin
  // token — mirrors requireNodeAdmin in the PCA routes. Reads are ungated.
  const requireNodeAdmin = (): boolean => {
    if (canAdministerNode(authentication)) return true;
    jsonResponse(res, 403, {
      error: 'Node-admin token required (~/.dkg/auth.token) to drive marketplace writes; '
        + 'agent-scoped tokens cannot sign node-wallet transactions.',
    });
    return false;
  };

  // GET /api/marketplace/status — enabled flag, role readiness, epoch and
  // settlement deadline, seller/buyer runtime counters. Never 503s: a node
  // with the runtime off answers { enabled: false, ... } so operators can
  // tell "disabled" from "down".
  if (req.method === 'GET' && path === '/api/marketplace/status') {
    try {
      return jsonResponse(res, 200, await agent.marketplaceStatus());
    } catch (err: any) {
      return respondMarketplaceError(res, err, 'marketplaceStatus');
    }
  }

  // POST /api/marketplace/seller/offerings — replace the served offering set
  // and (by default) publish each one as an offer KA into the `marketplace`
  // Context Graph. Body: { offerings: [...], publish?: boolean }.
  if (req.method === 'POST' && path === '/api/marketplace/seller/offerings') {
    if (!requireNodeAdmin()) return;
    const body = await readBody(req, SMALL_BODY_BYTES);
    const parsed = safeParseJson(body);
    if (!parsed.ok) return jsonResponse(res, 400, { error: parsed.error });
    const { offerings, publish } = parsed.value ?? {};
    if (!Array.isArray(offerings)) {
      return jsonResponse(res, 400, { error: 'offerings must be an array of offering objects' });
    }
    if (publish !== undefined && typeof publish !== 'boolean') {
      return jsonResponse(res, 400, { error: 'publish must be a boolean' });
    }
    let configs: MarketplaceOfferingConfig[];
    try {
      configs = offerings.map((offering: unknown, index: number) =>
        parseMarketplaceOffering(offering, `offerings[${index}]`));
    } catch (err: any) {
      return jsonResponse(res, 400, { error: err?.message ?? String(err) });
    }
    try {
      const result = await agent.marketplaceSetOfferings(
        configs,
        publish !== undefined ? { publish } : {},
      );
      return jsonResponse(res, 200, result);
    } catch (err: any) {
      return respondMarketplaceError(res, err, 'marketplaceSetOfferings');
    }
  }

  // GET /api/marketplace/offers — offers discovered via SPARQL over the
  // node's local view of the `marketplace` Context Graph.
  if (req.method === 'GET' && path === '/api/marketplace/offers') {
    try {
      const offers = await agent.marketplaceDiscoverOffers();
      return jsonResponse(res, 200, { offers, count: offers.length });
    } catch (err: any) {
      return respondMarketplaceError(res, err, 'marketplaceDiscoverOffers');
    }
  }

  // POST /api/marketplace/subscribe — fund the non-refundable period
  // subscription and register the session key. Body: { amountWei | amountTrac,
  // epoch?, policy }. The policy drives the local router + meter only; the
  // chain sees the funded amount and the session key.
  if (req.method === 'POST' && path === '/api/marketplace/subscribe') {
    if (!requireNodeAdmin()) return;
    const body = await readBody(req, SMALL_BODY_BYTES);
    const parsed = safeParseJson(body);
    if (!parsed.ok) return jsonResponse(res, 400, { error: parsed.error });
    const value = (parsed.value ?? {}) as Record<string, unknown>;
    let amountWei: bigint;
    let policy: AgentPlanPolicy;
    let epoch: bigint | undefined;
    try {
      amountWei = parseSubscriptionAmountWei(value);
      policy = parsePlanPolicy(value.policy);
      epoch = value.epoch === undefined ? undefined : parseMarketplaceUint(value.epoch, 'epoch');
    } catch (err: any) {
      return jsonResponse(res, 400, { error: err?.message ?? String(err) });
    }
    try {
      const result = await agent.marketplaceSubscribe({
        amountWei,
        policy,
        ...(epoch !== undefined ? { epoch } : {}),
      });
      return jsonResponse(res, 200, {
        epoch: result.epoch,
        sessionKeyAddress: result.sessionKeyAddress,
        amountWei,
        txHash: result.tx.hash,
        blockNumber: result.tx.blockNumber,
      });
    } catch (err: any) {
      return respondMarketplaceError(res, err, 'marketplaceSubscribe');
    }
  }

  // POST /api/marketplace/invoke — route, authorize, serve and settle one
  // marketplace call. Body: { serviceType, modelId?, payload, maxUnits? }
  // (payload is the executor's JSON — { prompt } for inference, { sparql }
  // for query). `resultBytes` stays off the wire: `result` is its JSON and
  // `receipt.resultCommitment` is its hash.
  if (req.method === 'POST' && path === '/api/marketplace/invoke') {
    if (!requireNodeAdmin()) return;
    const body = await readBody(req, SMALL_BODY_BYTES);
    const parsed = safeParseJson(body);
    if (!parsed.ok) return jsonResponse(res, 400, { error: parsed.error });
    const { serviceType, modelId, payload, maxUnits } = (parsed.value ?? {}) as Record<string, unknown>;
    if (typeof serviceType !== 'string'
      || !(MARKETPLACE_SERVICE_TYPES as readonly string[]).includes(serviceType)) {
      return jsonResponse(res, 400, { error: `serviceType must be one of ${MARKETPLACE_SERVICE_TYPES.join(', ')}` });
    }
    if (modelId !== undefined && typeof modelId !== 'string') {
      return jsonResponse(res, 400, { error: 'modelId must be a string' });
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return jsonResponse(res, 400, { error: 'payload must be a JSON object (e.g. { "prompt": ... } or { "sparql": ... })' });
    }
    let units: bigint;
    try {
      units = maxUnits === undefined ? DEFAULT_INVOKE_MAX_UNITS : parseMarketplaceUint(maxUnits, 'maxUnits');
    } catch (err: any) {
      return jsonResponse(res, 400, { error: err?.message ?? String(err) });
    }
    if (units <= 0n) return jsonResponse(res, 400, { error: 'maxUnits must be > 0' });
    try {
      const result = await agent.marketplaceInvoke({
        serviceType: serviceType as AgentServiceType,
        ...(modelId !== undefined ? { modelId } : {}),
        payload: payload as Record<string, unknown>,
        maxUnits: units,
      });
      return jsonResponse(res, 200, {
        result: result.result,
        servedUnits: result.servedUnits,
        costWei: result.costWei,
        seller: result.seller,
        receipt: result.receipt,
        authorization: result.authorization,
      });
    } catch (err: any) {
      return respondMarketplaceError(res, err, 'marketplaceInvoke');
    }
  }

  // GET /api/marketplace/meter — the buyer meter snapshot plus the RFC's
  // one-line `used · remaining · resets` summary.
  if (req.method === 'GET' && path === '/api/marketplace/meter') {
    try {
      return jsonResponse(res, 200, agent.marketplaceMeter());
    } catch (err: any) {
      return respondMarketplaceError(res, err, 'marketplaceMeter');
    }
  }

  // POST /api/marketplace/settle — the testing/ops rail: flush-receipts
  // (seller), finalize (permissionless, buyer defaults to this node's funding
  // wallet), claim (this node's epoch reward), roll (empty pool forward).
  // Body: { action, buyer?, epoch? }; epoch defaults to the active
  // subscription's funded epoch.
  if (req.method === 'POST' && path === '/api/marketplace/settle') {
    if (!requireNodeAdmin()) return;
    const body = await readBody(req, SMALL_BODY_BYTES);
    const parsed = safeParseJson(body);
    if (!parsed.ok) return jsonResponse(res, 400, { error: parsed.error });
    const { action, buyer, epoch } = (parsed.value ?? {}) as Record<string, unknown>;
    if (typeof action !== 'string' || !(SETTLE_ACTIONS as readonly string[]).includes(action)) {
      return jsonResponse(res, 400, { error: `action must be one of ${SETTLE_ACTIONS.join(', ')}` });
    }
    if (buyer !== undefined && (typeof buyer !== 'string' || !ethers.isAddress(buyer))) {
      return jsonResponse(res, 400, { error: 'buyer must be a valid 0x-prefixed EVM address' });
    }
    let epochValue: bigint | undefined;
    try {
      epochValue = epoch === undefined ? undefined : parseMarketplaceUint(epoch, 'epoch');
    } catch (err: any) {
      return jsonResponse(res, 400, { error: err?.message ?? String(err) });
    }
    try {
      const result = await agent.marketplaceSettle({
        action: action as MarketplaceSettleAction,
        ...(buyer !== undefined ? { buyer } : {}),
        ...(epochValue !== undefined ? { epoch: epochValue } : {}),
      });
      if ('batches' in result) {
        // flush-receipts: local batch submission counters, not a single tx.
        return jsonResponse(res, 200, { action, ...result });
      }
      return jsonResponse(res, 200, {
        action,
        txHash: result.hash,
        blockNumber: result.blockNumber,
        ...(result.rewardWei !== undefined ? { rewardWei: result.rewardWei } : {}),
      });
    } catch (err: any) {
      return respondMarketplaceError(res, err, `marketplaceSettle ${action}`);
    }
  }
}
