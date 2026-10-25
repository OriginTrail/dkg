import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';
import { handleMarketplaceRoutes } from '../src/daemon/routes/marketplace.js';
import type { RequestContext } from '../src/daemon/routes/context.js';
import { requestAuthentication } from './_helpers/request-authentication.js';

function fakeRes() {
  const res: any = { statusCode: 0, body: '' };
  res.writeHead = (status: number) => { res.statusCode = status; };
  res.end = (body: string) => { res.body = body; };
  return res;
}

function fakeReq(method: string, path: string, body?: unknown) {
  const req: any = { method, url: path };
  if (body !== undefined) {
    req.__dkgPrebufferedBody = Buffer.from(JSON.stringify(body));
  }
  return req;
}

function runCtx(
  method: string,
  rawPath: string,
  agent: any,
  body?: unknown,
  auth?: { authEnabled?: boolean; requestToken?: string },
) {
  const res = fakeRes();
  // Mirror handle-request.ts: route on url.pathname, query lives on url.
  const url = new URL(`http://127.0.0.1${rawPath}`);
  const ctx = {
    req: fakeReq(method, rawPath, body),
    res,
    agent,
    path: url.pathname,
    url,
    // Default: auth disabled → canAdministerNode short-circuits true, so the
    // route-logic tests exercise handlers without an admin token. The gating
    // itself is covered by its own describe block below.
    authentication: auth?.authEnabled
      ? requestAuthentication({ kind: 'agent', agentAddress: '0x' + '1'.repeat(40), token: auth.requestToken })
      : requestAuthentication({ kind: 'anonymous', mode: 'disabled' }),
  } as unknown as RequestContext;
  return { res, done: handleMarketplaceRoutes(ctx) };
}

// Agent-thrown error doubles matched by the route's name-based classifier
// (the production classes set the same names in their constructors).
function namedError(name: string, message: string, extra?: Record<string, unknown>): Error {
  const err = new Error(message);
  err.name = name;
  Object.assign(err, extra);
  return err;
}

describe('daemon /api/marketplace reads', () => {
  it('GET /api/marketplace/status → 200 with bigints serialized as decimal strings', async () => {
    const agent = {
      marketplaceStatus: async () => ({
        enabled: true,
        sellerReady: true,
        buyerReady: true,
        epoch: 42n,
        settlementDeadline: 1793577600n,
        seller: { offerings: 2, pendingReceipts: 1, submittedClaims: 3 },
        buyer: { subscribed: true, epoch: 42n, sessionKeyAddress: '0x' + 'a'.repeat(40) },
      }),
    };
    const { res, done } = runCtx('GET', '/api/marketplace/status', agent);
    await done;
    expect(res.statusCode).toBe(200);
    const parsed = JSON.parse(res.body);
    expect(parsed.epoch).toBe('42');
    expect(parsed.settlementDeadline).toBe('1793577600');
    expect(parsed.seller).toEqual({ offerings: 2, pendingReceipts: 1, submittedClaims: 3 });
    expect(parsed.buyer.epoch).toBe('42');
  });

  it('GET /api/marketplace/offers → 200 { offers, count } with wei strings', async () => {
    const agent = {
      marketplaceDiscoverOffers: async () => [{
        offerId: 'urn:dkg:marketplace:offer:peer1:devnet-llm',
        sellerIdentityId: 7n,
        sellerPeerId: 'peer1',
        sellerAddress: '0x' + 'b'.repeat(40),
        offeringId: '0x' + '1'.repeat(64),
        serviceType: 'inference',
        unit: 'token',
        askPerUnitWei: 500_000_000_000n,
      }],
    };
    const { res, done } = runCtx('GET', '/api/marketplace/offers', agent);
    await done;
    expect(res.statusCode).toBe(200);
    const parsed = JSON.parse(res.body);
    expect(parsed.count).toBe(1);
    expect(parsed.offers[0].sellerIdentityId).toBe('7');
    expect(parsed.offers[0].askPerUnitWei).toBe('500000000000');
  });

  it('GET /api/marketplace/meter → 503 when the runtime is off (requireRuntime throws)', async () => {
    const agent = {
      marketplaceMeter: () => {
        throw new Error('marketplace is not running on this node (config.marketplace.enabled plus a marketplace-capable chain adapter are required)');
      },
    };
    const { res, done } = runCtx('GET', '/api/marketplace/meter', agent);
    await done;
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body).error).toMatch(/not available on this node/);
  });

  it('an unknown /api/marketplace path is left unclaimed for the trailing 404', async () => {
    const { res, done } = runCtx('GET', '/api/marketplace/nope', {});
    await done;
    expect(res.statusCode).toBe(0);
  });

  it('a non-marketplace path is ignored entirely', async () => {
    const { res, done } = runCtx('GET', '/api/status', {});
    await done;
    expect(res.statusCode).toBe(0);
  });
});

describe('POST /api/marketplace/seller/offerings', () => {
  it('parses wei strings to bigint before the mixin and forwards publish:false', async () => {
    const calls: Array<[unknown, unknown]> = [];
    const agent = {
      marketplaceSetOfferings: async (offerings: unknown, opts: unknown) => {
        calls.push([offerings, opts]);
        return { offerings: 1, published: [] };
      },
    };
    const { res, done } = runCtx('POST', '/api/marketplace/seller/offerings', agent, {
      offerings: [{ offeringLocalId: 'devnet-llm', serviceType: 'inference', unit: 'token', askPerUnitWei: '500000000000' }],
      publish: false,
    });
    await done;
    expect(res.statusCode).toBe(200);
    expect(calls).toEqual([[
      [{ offeringLocalId: 'devnet-llm', serviceType: 'inference', unit: 'token', askPerUnitWei: 500_000_000_000n }],
      { publish: false },
    ]]);
    expect(JSON.parse(res.body)).toEqual({ offerings: 1, published: [] });
  });

  it('→ 400 on a malformed offering, naming the key; mixin not called', async () => {
    let called = false;
    const agent = { marketplaceSetOfferings: async () => { called = true; return { offerings: 0, published: [] }; } };
    const { res, done } = runCtx('POST', '/api/marketplace/seller/offerings', agent, {
      offerings: [{ offeringLocalId: 'x', serviceType: 'chat', unit: 'token', askPerUnitWei: '1' }],
    });
    await done;
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/offerings\[0\]\.serviceType/);
    expect(called).toBe(false);
  });

  it('→ 400 when askPerUnitWei exceeds uint96 (the contract ask width)', async () => {
    let called = false;
    const agent = { marketplaceSetOfferings: async () => { called = true; return { offerings: 0, published: [] }; } };
    const { res, done } = runCtx('POST', '/api/marketplace/seller/offerings', agent, {
      offerings: [{
        offeringLocalId: 'devnet-llm', serviceType: 'inference', unit: 'token',
        askPerUnitWei: (1n << 96n).toString(),
      }],
    });
    await done;
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/offerings\[0\]\.askPerUnitWei must fit in uint96/);
    expect(called).toBe(false);
  });

  it('→ 409 SELLER_UNAVAILABLE when the node has no operational signing key', async () => {
    const agent = {
      marketplaceSetOfferings: async () => {
        throw new Error('marketplace: seller role unavailable on this node (no operational signing key)');
      },
    };
    const { res, done } = runCtx('POST', '/api/marketplace/seller/offerings', agent, { offerings: [] });
    await done;
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).code).toBe('SELLER_UNAVAILABLE');
  });
});

describe('POST /api/marketplace/subscribe', () => {
  const policy = {
    totalBudgetWei: '10000000000000000000',
    buckets: [{
      match: { serviceType: 'inference' },
      budgetWei: '6000000000000000000',
      priceCapWeiPerUnit: '1000000000000',
      maxUnitsPerCall: '2000',
    }],
    softCeilingBps: 9500,
  };

  it('amountTrac converts via parseEther; the policy reaches the mixin as bigints', async () => {
    const calls: any[] = [];
    const agent = {
      marketplaceSubscribe: async (opts: any) => {
        calls.push(opts);
        return { epoch: 42n, sessionKeyAddress: '0x' + 'c'.repeat(40), tx: { hash: '0xfund', blockNumber: 9 } };
      },
    };
    const { res, done } = runCtx('POST', '/api/marketplace/subscribe', agent, {
      amountTrac: '10',
      epoch: 42,
      policy,
    });
    await done;
    expect(res.statusCode).toBe(200);
    expect(calls).toEqual([{
      amountWei: ethers.parseEther('10'),
      epoch: 42n,
      policy: {
        totalBudgetWei: 10n * 10n ** 18n,
        buckets: [{
          match: { serviceType: 'inference' },
          budgetWei: 6n * 10n ** 18n,
          priceCapWeiPerUnit: 1_000_000_000_000n,
          maxUnitsPerCall: 2000n,
        }],
        softCeilingBps: 9500,
      },
    }]);
    const parsed = JSON.parse(res.body);
    expect(parsed).toEqual({
      epoch: '42',
      sessionKeyAddress: '0x' + 'c'.repeat(40),
      amountWei: (10n * 10n ** 18n).toString(),
      txHash: '0xfund',
      blockNumber: 9,
    });
  });

  it('amountWei is taken verbatim; sellerAllow/Deny parse to identityId bigints', async () => {
    const calls: any[] = [];
    const agent = {
      marketplaceSubscribe: async (opts: any) => {
        calls.push(opts);
        return { epoch: 1n, sessionKeyAddress: '0x' + 'c'.repeat(40), tx: { hash: '0x1', blockNumber: 1 } };
      },
    };
    const { res, done } = runCtx('POST', '/api/marketplace/subscribe', agent, {
      amountWei: '5000000000000000000',
      policy: { ...policy, sellerAllow: ['7', 9], sellerDeny: ['11'] },
    });
    await done;
    expect(res.statusCode).toBe(200);
    expect(calls[0].amountWei).toBe(5n * 10n ** 18n);
    expect(calls[0].policy.sellerAllow).toEqual([7n, 9n]);
    expect(calls[0].policy.sellerDeny).toEqual([11n]);
    expect('epoch' in calls[0]).toBe(false);
  });

  it('→ 400 unless exactly one of amountWei/amountTrac is passed', async () => {
    let called = false;
    const agent = { marketplaceSubscribe: async () => { called = true; return {} as never; } };
    for (const body of [{ policy }, { amountWei: '1', amountTrac: '1', policy }]) {
      const { res, done } = runCtx('POST', '/api/marketplace/subscribe', agent, body);
      await done;
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toMatch(/exactly one of amountWei/);
    }
    expect(called).toBe(false);
  });

  it('→ 400 on an empty bucket list or malformed bucket field', async () => {
    const agent = { marketplaceSubscribe: async () => ({}) as never };
    const empty = runCtx('POST', '/api/marketplace/subscribe', agent, {
      amountTrac: '1', policy: { totalBudgetWei: '1', buckets: [] },
    });
    await empty.done;
    expect(empty.res.statusCode).toBe(400);
    expect(JSON.parse(empty.res.body).error).toMatch(/policy\.buckets must be a non-empty array/);
    const badCap = runCtx('POST', '/api/marketplace/subscribe', agent, {
      amountTrac: '1',
      policy: { ...policy, buckets: [{ ...policy.buckets[0], priceCapWeiPerUnit: '0.1' }] },
    });
    await badCap.done;
    expect(badCap.res.statusCode).toBe(400);
    expect(JSON.parse(badCap.res.body).error).toMatch(/policy\.buckets\[0\]\.priceCapWeiPerUnit/);
  });

  it('width-bounds numeric inputs at the boundary → 400 naming the field', async () => {
    let called = false;
    const agent = { marketplaceSubscribe: async () => { called = true; return {} as never; } };
    const uint96Max = (1n << 96n) - 1n;
    const uint64Max = (1n << 64n) - 1n;

    // amountWei over uint96.
    const bigAmount = runCtx('POST', '/api/marketplace/subscribe', agent, {
      amountWei: (uint96Max + 1n).toString(), policy,
    });
    await bigAmount.done;
    expect(bigAmount.res.statusCode).toBe(400);
    expect(JSON.parse(bigAmount.res.body).error).toMatch(/amountWei must fit in uint96/);

    // amountTrac that converts past uint96 (~79.2 billion TRAC).
    const bigTrac = runCtx('POST', '/api/marketplace/subscribe', agent, {
      amountTrac: '99228162514264337594', policy,
    });
    await bigTrac.done;
    expect(bigTrac.res.statusCode).toBe(400);
    expect(JSON.parse(bigTrac.res.body).error).toMatch(/amountTrac must fit in uint96/);

    // priceCapWeiPerUnit over uint96 / maxUnitsPerCall over uint64.
    const bigCap = runCtx('POST', '/api/marketplace/subscribe', agent, {
      amountTrac: '1',
      policy: { ...policy, buckets: [{ ...policy.buckets[0], priceCapWeiPerUnit: (uint96Max + 1n).toString() }] },
    });
    await bigCap.done;
    expect(bigCap.res.statusCode).toBe(400);
    expect(JSON.parse(bigCap.res.body).error).toMatch(/policy\.buckets\[0\]\.priceCapWeiPerUnit must fit in uint96/);
    const bigUnits = runCtx('POST', '/api/marketplace/subscribe', agent, {
      amountTrac: '1',
      policy: { ...policy, buckets: [{ ...policy.buckets[0], maxUnitsPerCall: (uint64Max + 1n).toString() }] },
    });
    await bigUnits.done;
    expect(bigUnits.res.statusCode).toBe(400);
    expect(JSON.parse(bigUnits.res.body).error).toMatch(/policy\.buckets\[0\]\.maxUnitsPerCall must fit in uint64/);

    // epoch over uint64; identity ids over uint72.
    const bigEpoch = runCtx('POST', '/api/marketplace/subscribe', agent, {
      amountTrac: '1', policy, epoch: (uint64Max + 1n).toString(),
    });
    await bigEpoch.done;
    expect(bigEpoch.res.statusCode).toBe(400);
    expect(JSON.parse(bigEpoch.res.body).error).toMatch(/epoch must fit in uint64/);
    const bigIdentity = runCtx('POST', '/api/marketplace/subscribe', agent, {
      amountTrac: '1', policy: { ...policy, sellerAllow: [(1n << 72n).toString()] },
    });
    await bigIdentity.done;
    expect(bigIdentity.res.statusCode).toBe(400);
    expect(JSON.parse(bigIdentity.res.body).error).toMatch(/policy\.sellerAllow\[0\] must fit in uint72/);

    // Exactly at the bound passes the parser (the mixin double answers).
    const atBound = runCtx('POST', '/api/marketplace/subscribe', { marketplaceSubscribe: async () => ({ epoch: 1n, sessionKeyAddress: '0x' + 'c'.repeat(40), tx: { hash: '0x1', blockNumber: 1 } }) }, {
      amountWei: uint96Max.toString(), policy,
    });
    await atBound.done;
    expect(atBound.res.statusCode).toBe(200);
    expect(called).toBe(false);
  });

  it('→ 503 when the chain adapter has no marketplace surface', async () => {
    const agent = {
      marketplaceSubscribe: async () => {
        throw new Error('marketplace: chain adapter does not support marketplace settlement');
      },
    };
    const { res, done } = runCtx('POST', '/api/marketplace/subscribe', agent, { amountTrac: '1', policy });
    await done;
    expect(res.statusCode).toBe(503);
  });
});

describe('POST /api/marketplace/invoke', () => {
  const invokeResult = {
    result: { echo: 'hi' },
    resultBytes: new TextEncoder().encode('{"echo":"hi"}'),
    receipt: {
      authDigest: '0x' + 'a'.repeat(64),
      servedUnits: 640n,
      receiptValueWei: 320_000_000_000_000n,
      resultCommitment: '0x' + 'b'.repeat(64),
      sellerSig: '0x' + 'c'.repeat(130),
    },
    authorization: { callId: '0x' + 'd'.repeat(64), maxUnits: 1000n },
    seller: { peerId: 'peer1', identityId: 7n, address: '0x' + 'e'.repeat(40) },
    servedUnits: 640n,
    costWei: 320_000_000_000_000n,
  };

  it('forwards maxUnits as bigint (default 1000n) and omits resultBytes from the wire', async () => {
    const calls: any[] = [];
    const agent = { marketplaceInvoke: async (opts: any) => { calls.push(opts); return invokeResult; } };
    const { res, done } = runCtx('POST', '/api/marketplace/invoke', agent, {
      serviceType: 'inference',
      payload: { prompt: 'hi' },
    });
    await done;
    expect(res.statusCode).toBe(200);
    expect(calls).toEqual([{ serviceType: 'inference', payload: { prompt: 'hi' }, maxUnits: 1000n }]);
    const parsed = JSON.parse(res.body);
    expect(parsed.servedUnits).toBe('640');
    expect(parsed.costWei).toBe('320000000000000');
    expect(parsed.seller.identityId).toBe('7');
    expect(parsed.receipt.receiptValueWei).toBe('320000000000000');
    expect(parsed.authorization.maxUnits).toBe('1000');
    expect('resultBytes' in parsed).toBe(false);
  });

  it('explicit maxUnits and modelId are forwarded; zero maxUnits → 400', async () => {
    const calls: any[] = [];
    const agent = { marketplaceInvoke: async (opts: any) => { calls.push(opts); return invokeResult; } };
    const ok = runCtx('POST', '/api/marketplace/invoke', agent, {
      serviceType: 'query', modelId: 'stub-1', payload: { sparql: 'SELECT * WHERE { ?s ?p ?o }' }, maxUnits: '64',
    });
    await ok.done;
    expect(ok.res.statusCode).toBe(200);
    expect(calls[0].maxUnits).toBe(64n);
    expect(calls[0].modelId).toBe('stub-1');
    const zero = runCtx('POST', '/api/marketplace/invoke', agent, {
      serviceType: 'query', payload: { sparql: 'x' }, maxUnits: 0,
    });
    await zero.done;
    expect(zero.res.statusCode).toBe(400);
    expect(JSON.parse(zero.res.body).error).toMatch(/maxUnits must be > 0/);
    // Units are uint64 on-chain — width-bounded at the route boundary.
    const wide = runCtx('POST', '/api/marketplace/invoke', agent, {
      serviceType: 'query', payload: { sparql: 'x' }, maxUnits: (1n << 64n).toString(),
    });
    await wide.done;
    expect(wide.res.statusCode).toBe(400);
    expect(JSON.parse(wide.res.body).error).toMatch(/maxUnits must fit in uint64/);
  });

  it('→ 400 for an unknown serviceType or a non-object payload', async () => {
    let called = false;
    const agent = { marketplaceInvoke: async () => { called = true; return invokeResult; } };
    const badService = runCtx('POST', '/api/marketplace/invoke', agent, { serviceType: 'chat', payload: {} });
    await badService.done;
    expect(badService.res.statusCode).toBe(400);
    const badPayload = runCtx('POST', '/api/marketplace/invoke', agent, { serviceType: 'inference', payload: 'hi' });
    await badPayload.done;
    expect(badPayload.res.statusCode).toBe(400);
    expect(called).toBe(false);
  });

  it('MarketplaceNotSubscribedError → 409 NOT_SUBSCRIBED', async () => {
    const agent = {
      marketplaceInvoke: async () => {
        throw namedError('MarketplaceNotSubscribedError', 'marketplace: no active subscription — call subscribe() first');
      },
    };
    const { res, done } = runCtx('POST', '/api/marketplace/invoke', agent, { serviceType: 'inference', payload: { prompt: 'x' } });
    await done;
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).code).toBe('NOT_SUBSCRIBED');
  });

  it('MarketplaceRouteError → 409 NO_ROUTE carrying reason + rejections (soft ceiling visible)', async () => {
    const agent = {
      marketplaceInvoke: async () => {
        throw namedError('MarketplaceRouteError', 'marketplace: no route (no-eligible-offer)', {
          reason: 'no-eligible-offer',
          rejections: [{ offerId: 'offer-1', reason: 'soft-ceiling' }],
        });
      },
    };
    const { res, done } = runCtx('POST', '/api/marketplace/invoke', agent, { serviceType: 'inference', payload: { prompt: 'x' } });
    await done;
    expect(res.statusCode).toBe(409);
    const parsed = JSON.parse(res.body);
    expect(parsed.code).toBe('NO_ROUTE');
    expect(parsed.reason).toBe('no-eligible-offer');
    expect(parsed.rejections).toEqual([{ offerId: 'offer-1', reason: 'soft-ceiling' }]);
  });

  it('MarketplaceInvokeError → 502 with the seller errorCode (upstream fault, not a 500)', async () => {
    const agent = {
      marketplaceInvoke: async () => {
        throw namedError('MarketplaceInvokeError', 'marketplace: invoke failed (BAD_RECEIPT): sellerSig mismatch', { code: 'BAD_RECEIPT' });
      },
    };
    const { res, done } = runCtx('POST', '/api/marketplace/invoke', agent, { serviceType: 'inference', payload: { prompt: 'x' } });
    await done;
    expect(res.statusCode).toBe(502);
    expect(JSON.parse(res.body).code).toBe('BAD_RECEIPT');
  });
});

describe('POST /api/marketplace/settle', () => {
  it('flush-receipts returns the local submission counters verbatim', async () => {
    const agent = {
      marketplaceSettle: async (opts: any) => {
        expect(opts).toEqual({ action: 'flush-receipts' });
        return { batches: 2, claims: 5, failedClaims: 0, errors: [] };
      },
    };
    const { res, done } = runCtx('POST', '/api/marketplace/settle', agent, { action: 'flush-receipts' });
    await done;
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ action: 'flush-receipts', batches: 2, claims: 5, failedClaims: 0, errors: [] });
  });

  it('claim returns txHash/blockNumber plus the parsed rewardWei as a string', async () => {
    const agent = {
      marketplaceSettle: async (opts: any) => {
        expect(opts).toEqual({ action: 'claim', epoch: 42n });
        return { hash: '0xclaim', blockNumber: 12, success: true, rewardWei: 7n * 10n ** 18n };
      },
    };
    const { res, done } = runCtx('POST', '/api/marketplace/settle', agent, { action: 'claim', epoch: '42' });
    await done;
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ action: 'claim', txHash: '0xclaim', blockNumber: 12, rewardWei: '7000000000000000000' });
  });

  it('finalize forwards a validated buyer address; a malformed one → 400', async () => {
    const buyer = ethers.getAddress('0x' + '2'.repeat(40));
    const calls: any[] = [];
    const agent = {
      marketplaceSettle: async (opts: any) => { calls.push(opts); return { hash: '0xfin', blockNumber: 3, success: true }; },
    };
    const ok = runCtx('POST', '/api/marketplace/settle', agent, { action: 'finalize', buyer, epoch: 1 });
    await ok.done;
    expect(ok.res.statusCode).toBe(200);
    expect(calls).toEqual([{ action: 'finalize', buyer, epoch: 1n }]);
    const bad = runCtx('POST', '/api/marketplace/settle', agent, { action: 'finalize', buyer: 'not-an-address' });
    await bad.done;
    expect(bad.res.statusCode).toBe(400);
  });

  it('→ 400 for an unknown action; the agent\'s missing-epoch error also maps to 400', async () => {
    let called = false;
    const unknown = runCtx('POST', '/api/marketplace/settle', { marketplaceSettle: async () => { called = true; } }, { action: 'sweep' });
    await unknown.done;
    expect(unknown.res.statusCode).toBe(400);
    expect(called).toBe(false);
    const agent = {
      marketplaceSettle: async () => {
        throw new Error('marketplace settle roll: pass `epoch` (no active subscription to default from)');
      },
    };
    const noEpoch = runCtx('POST', '/api/marketplace/settle', agent, { action: 'roll' });
    await noEpoch.done;
    expect(noEpoch.res.statusCode).toBe(400);
  });
});

describe('node-admin gating', () => {
  const WRITE_ROUTES: Array<[string, unknown]> = [
    ['/api/marketplace/seller/offerings', { offerings: [] }],
    ['/api/marketplace/subscribe', { amountTrac: '1', policy: { totalBudgetWei: '1', buckets: [] } }],
    ['/api/marketplace/invoke', { serviceType: 'inference', payload: {} }],
    ['/api/marketplace/settle', { action: 'claim' }],
  ];

  it('every POST route → 403 for an agent-scoped token, before any body parsing', async () => {
    for (const [path, body] of WRITE_ROUTES) {
      let called = false;
      const trap = async () => { called = true; return {} as never; };
      const agent = {
        resolveAgentByToken: () => '0x' + '1'.repeat(40),
        marketplaceSetOfferings: trap,
        marketplaceSubscribe: trap,
        marketplaceInvoke: trap,
        marketplaceSettle: trap,
      };
      const { res, done } = runCtx('POST', path, agent, body, { authEnabled: true, requestToken: 'dkg_at_x' });
      await done;
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body).error).toMatch(/Node-admin token required/);
      expect(called).toBe(false);
    }
  });

  it('reads stay open to agent-scoped callers', async () => {
    const agent = {
      resolveAgentByToken: () => '0x' + '1'.repeat(40),
      marketplaceStatus: async () => ({ enabled: false, sellerReady: false, buyerReady: false }),
    };
    const { res, done } = runCtx('GET', '/api/marketplace/status', agent, undefined, { authEnabled: true, requestToken: 'dkg_at_x' });
    await done;
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).enabled).toBe(false);
  });
});
