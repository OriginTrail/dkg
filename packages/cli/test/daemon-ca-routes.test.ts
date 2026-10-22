/**
 * /api/ca — Conviction Account service spending (OT-RFC-27) on the daemon.
 *
 * Every route: the token rules, 503 without service contracts or without a
 * buyer key the node can sign for, the status of each contract refusal, the
 * owner and assignee roles of POST /assignments, the caps route's merge of a
 * partial body and its `unchanged` answer, and fresh status reads. The last
 * block runs the whole flow through the routes over the mock adapter's model
 * of the contracts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { DKGAgent } from '@origintrail-official/dkg-agent';
import {
  ChainRpcTransportError,
  ConvictionServiceRevertError,
  ConvictionServiceUnavailableError,
  MockChainAdapter,
  NoChainAdapter,
  RemoteSignerError,
  SERVICE_ASSIGNMENT_TYPES,
  serviceAssignmentDigest,
  type CaAssignmentTerms,
  type CaEip712Domain,
  type CaPeriod,
} from '@origintrail-official/dkg-chain';
import { handleCaRoutes } from '../src/daemon/routes/ca.js';
import type { RequestContext } from '../src/daemon/routes/context.js';
import { requestAuthentication } from './_helpers/request-authentication.js';

const TRAC = 10n ** 18n;
const PRIMARY = ethers.getAddress('0x' + '11'.repeat(20));
const BUYER = ethers.getAddress('0x' + '22'.repeat(20));
const STRANGER = ethers.getAddress('0x' + '33'.repeat(20));
const SS = ethers.getAddress('0x' + '5e'.repeat(20));
const DOMAIN: CaEip712Domain = { name: 'DKGConvictionServices', version: '1', chainId: 31337, verifyingContract: SS };
const bytes32 = (n: number): string => ethers.toBeHex(n, 32);
const TX = { hash: bytes32(0x77), blockNumber: 123, txIndex: 0, success: true };
const ADMIN_TOKEN = 'node-admin-token';
const AGENT_TOKEN = 'dkg_at_agent';

function fakeRes() {
  const res: any = { statusCode: 0, body: '', headers: {} as Record<string, string> };
  res.writeHead = (status: number) => { res.statusCode = status; };
  res.setHeader = (name: string, value: string) => { res.headers[name] = value; };
  res.end = (body: string) => { res.body = body; res.writableEnded = true; };
  return res;
}

async function call(
  agent: any,
  method: string,
  path: string,
  body?: unknown,
  opts: { token?: string; wallets?: string[] } = {},
): Promise<{ status: number; json: any; handled: boolean }> {
  const res = fakeRes();
  const req: any = { method, url: path };
  if (body !== undefined) req.__dkgPrebufferedBody = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  const url = new URL(`http://127.0.0.1${path}`);
  const authentication = opts.token === undefined
    ? requestAuthentication({ kind: 'anonymous', mode: 'disabled' })
    : opts.token === AGENT_TOKEN
      ? requestAuthentication({ kind: 'agent', agentAddress: '0x' + 'a'.repeat(40), token: AGENT_TOKEN })
      : requestAuthentication({ kind: 'nodeOperator', token: opts.token });
  const ctx = {
    req, res, agent, path: url.pathname, url, authentication,
    opWallets: { wallets: (opts.wallets ?? [PRIMARY]).map((address) => ({ address })) },
  } as unknown as RequestContext;
  await handleCaRoutes(ctx);
  return { status: res.statusCode, json: res.body ? JSON.parse(res.body) : undefined, handled: res.writableEnded === true };
}

const ASSIGNMENT = {
  assignee: BUYER,
  maxCostPerPeriod: 25n * TRAC, maxInferenceCostPerPeriod: 25n * TRAC, maxQueryCostPerPeriod: 0n,
  maxCostPerWindow: 100n * TRAC, maxTotalCost: 1000n * TRAC, maxPeriodSeconds: 2_678_400,
  expiresAt: 4_000_000_000, assignedAt: 1_760_000_100, revokedAt: 0, nonce: 3n, active: true,
  usage: { totalCost: 7n * TRAC, windowCost: 7n * TRAC, window: 3, periods: 1 },
};

const PERIOD: CaPeriod = {
  subscriptionId: bytes32(0x51), accountId: 42n, assignee: BUYER, sessionKey: ethers.ZeroAddress,
  periodId: bytes32(0xa1), planDigest: bytes32(0xd1), periodStart: 1_760_400_200, periodEnd: 1_762_992_200,
  fundedEpoch: 1203, fundedWindow: 3, discountBps: 3000, value: 10n * TRAC, cost: 7n * TRAC,
  drawnFromWindow: 7n * TRAC, drawnFromTopUp: 0n,
  buckets: [{ bucketId: bytes32(1), serviceClass: 1, value: 10n * TRAC, maxAskWeiPerUnit: 2_500_000_000_000n }],
};

const STATUS = {
  accountId: 42n, owner: PRIMARY, logicVersion: '10.1.0', serviceSpendingEnabledAt: 1_760_400_000,
  discountBps: 3000, lockDurationEpochs: 12, expiresAtTimestamp: 1_761_236_000,
  window: { index: 3, baseAllowance: 100n * TRAC, baseRemaining: 93n * TRAC, topUpBuffer: 0n, expired: false },
  schedule: { exact: true, firstEpoch: 1201, lastEpoch: 1224 },
  labels: { total: 7n * TRAC, cursor: 1205, remainingBaseCapacity: 1193n * TRAC },
  assignments: { count: 1, active: 1 },
  treasuryWired: false,
};

/** A facade stub: account 42 owned by the node's primary wallet, BUYER assigned on it. */
function stubAgent(over: Record<string, unknown> = {}) {
  return {
    supportsConvictionService: true,
    supportsPublishingConvictionNft: true,
    getConvictionServiceBuyerAddress: () => BUYER,
    getPublishingConvictionAccountInfo: vi.fn(async (id: bigint) => (id === 42n ? { owner: PRIMARY } : null)),
    getConvictionServiceContracts: vi.fn(async () => ({
      serviceSubscriptions: SS, convictionServiceStorage: STRANGER, publishingConviction: STRANGER, logicVersion: '10.1.0', domain: DOMAIN,
    })),
    getConvictionServiceStatus: vi.fn(async (id: bigint) => (id === 42n ? STATUS : null)),
    getConvictionServiceAssignmentNonce: vi.fn(async () => 3n),
    setConvictionServiceSpending: vi.fn(async () => TX),
    signConvictionServiceConsent: vi.fn(async (t: CaAssignmentTerms) => ({ digest: serviceAssignmentDigest(DOMAIN, t), signature: '0x' + 'cd'.repeat(65) })),
    assignConvictionServiceBuyer: vi.fn(async (_terms: CaAssignmentTerms, _signatures: unknown, _sendAs: string) => ({ ...TX, digest: bytes32(0xdd) })),
    revokeConvictionServiceBuyer: vi.fn(async () => ({ ...TX, nextNonce: 5n })),
    updateConvictionServiceCaps: vi.fn(async () => TX),
    advanceConvictionServiceNonce: vi.fn(async () => ({ ...TX, nextNonce: 5n })),
    listConvictionServiceAssignments: vi.fn(async () => [ASSIGNMENT]),
    listConvictionServiceAccountsByAssignee: vi.fn(async () => [{ accountId: 42n, ...ASSIGNMENT }]),
    listPublishingConvictionAccountsForWallets: vi.fn(async () => [
      { accountId: 42n, relation: 'owned' }, { accountId: 43n, relation: 'agent' }, { accountId: 44n, relation: 'both' },
    ]),
    getConvictionServiceLabels: vi.fn(async (_id: bigint, from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => ({
      epoch: from + i, scheduled: 100n * TRAC, baseLabel: 0n, topUpLabel: 0n, serviceLabel: 0n, pool: 900n * TRAC,
    }))),
    listServicePeriods: vi.fn(async () => ({ total: 1, periods: [PERIOD] })),
    fundServicePeriodFromConviction: vi.fn(async () => ({ ...TX, subscriptionId: PERIOD.subscriptionId, cost: PERIOD.cost, logIndex: 7, existing: false, period: PERIOD })),
    ...over,
  };
}

const CONSENT_BODY = { maxCostPerPeriod: '25', maxCostPerWindow: '100', maxTotalCost: '1000', expiresAt: '2096-01-01T00:00:00Z' };
const WIRE_TERMS = {
  accountId: '42', assignee: BUYER, maxCostPerPeriod: '25000000000000000000', maxInferenceCostPerPeriod: '25000000000000000000',
  maxQueryCostPerPeriod: '0', maxCostPerWindow: '100000000000000000000', maxTotalCost: '1000000000000000000000',
  maxPeriodSeconds: 2678400, expiresAt: 3976214400, nonce: '3',
};
const PLAN = {
  periodId: bytes32(0xa1), periodSeconds: 2_592_000, planDigest: bytes32(0xd1),
  buckets: [{ bucketId: bytes32(1), serviceClass: 'inference', value: '10', maxAskWeiPerUnit: '2500000000000' }],
};

/** Every write route, with a body it accepts. */
const WRITES: Array<[string, string, unknown?]> = [
  ['POST', '/api/ca/42/services', { enabled: true }],
  ['POST', '/api/ca/42/consent', CONSENT_BODY],
  ['POST', '/api/ca/42/assignments', { terms: WIRE_TERMS, assigneeSignature: '0x' + 'cd'.repeat(65) }],
  ['DELETE', `/api/ca/42/assignments/${BUYER}`],
  ['POST', `/api/ca/42/assignments/${BUYER}/caps`, { maxTotalCost: '1500' }],
  ['POST', '/api/ca/42/nonce'],
  ['POST', '/api/ca/42/periods', PLAN],
];
const READS = ['/api/ca/contracts', '/api/ca/mine', '/api/ca/42', '/api/ca/42/assignments', '/api/ca/42/labels', '/api/ca/42/periods'];

afterEach(() => {
  vi.restoreAllMocks();
});

describe('token rules', () => {
  it.each(WRITES)('%s %s needs a node-admin token, refusing an agent token before anything is called', async (method, path, body) => {
    const agent = stubAgent();
    const refused = await call(agent, method, path, body, { token: AGENT_TOKEN });
    expect(refused.status).toBe(403);
    expect(refused.json.error).toMatch(/Node-admin token required/);
    for (const fn of Object.values(agent)) if (vi.isMockFunction(fn)) expect(fn).not.toHaveBeenCalled();
    expect((await call(stubAgent(), method, path, body, { token: ADMIN_TOKEN })).status).toBe(200);
  });

  it.each(READS)('GET %s answers any valid token', async (path) => {
    expect((await call(stubAgent(), 'GET', path, undefined, { token: AGENT_TOKEN })).status).toBe(200);
  });

  it('leaves every path outside /api/ca, and unknown /api/ca paths, to the next handler', async () => {
    for (const [method, path] of [['GET', '/api/cat'], ['GET', '/api/pca/42'], ['GET', '/api/ca'], ['PUT', '/api/ca/42'],
      ['POST', `/api/ca/42/assignments/${BUYER}`], ['GET', '/api/ca/42/unknown'], ['POST', '/api/ca/contracts']]) {
      expect((await call(stubAgent(), method!, path!)).handled, `${method} ${path}`).toBe(false);
    }
  });
});

describe('503 without the service contracts or the buyer key', () => {
  it('answers 503 on every route of a node without a chain', async () => {
    const agent = await DKGAgent.create({ name: 'CaNoChain', listenHost: '127.0.0.1', listenPort: 0, chainAdapter: new NoChainAdapter(), nodeRole: 'core' });
    for (const [method, path, body] of [...WRITES, ...READS.map((p) => ['GET', p] as [string, string])]) {
      const answer = await call(agent, method, path, body);
      expect(answer.status, `${method} ${path}`).toBe(503);
      expect(answer.json.code, `${method} ${path}`).toBe('CA_UNAVAILABLE');
    }
  });

  it('answers 503 when the Hub has no service contracts', async () => {
    const refusal = new ConvictionServiceUnavailableError();
    const agent = stubAgent({
      getConvictionServiceContracts: vi.fn(async () => null),
      setConvictionServiceSpending: vi.fn(async () => { throw refusal; }),
      getConvictionServiceStatus: vi.fn(async () => { throw refusal; }),
    });
    expect((await call(agent, 'GET', '/api/ca/contracts')).json.code).toBe('CA_UNAVAILABLE');
    expect((await call(agent, 'POST', '/api/ca/42/services', { enabled: true })).status).toBe(503);
    expect((await call(agent, 'GET', '/api/ca/42')).json).toMatchObject({ code: 'CA_UNAVAILABLE', accountId: '42' });
  });

  it('answers 503, saying why, on the routes that sign as the buyer key when the node holds no signer for it', async () => {
    const agent = stubAgent({ getConvictionServiceBuyerAddress: () => null });
    for (const [path, body] of [['/api/ca/42/consent', CONSENT_BODY], ['/api/ca/42/periods', PLAN]] as const) {
      const answer = await call(agent, 'POST', path, body);
      expect(answer.status).toBe(503);
      expect(answer.json).toMatchObject({ code: 'CA_BUYER_KEY_UNAVAILABLE', error: expect.stringMatching(/chain\.caBuyerAddress/) });
    }
    expect(agent.signConvictionServiceConsent).not.toHaveBeenCalled();
    expect(agent.fundServicePeriodFromConviction).not.toHaveBeenCalled();
    // The node's own accounts are still listed.
    expect((await call(agent, 'GET', '/api/ca/mine')).json).toMatchObject({ buyerKey: null, assigned: [], owned: [{ accountId: '42' }, { accountId: '44' }] });
  });
});

describe('the status of each refusal', () => {
  const TABLE: Array<[number, string[]]> = [
    [400, ['InvalidAssignmentTerms', 'InvalidFundingRequest', 'ConsentMissing', 'InvalidConsentSignature']],
    [403, ['NotAccountOwner', 'NotAssigned']],
    [404, ['UnknownAccount', 'ERC721NonexistentToken']],
    [409, ['ServiceSpendingDisabled', 'ServiceSpendingUnchanged', 'InvalidAssignmentNonce', 'AssignmentRevoked', 'AssignmentExpired',
      'CapsUnchanged', 'CapExceeded', 'PeriodAlreadyFunded', 'LabelCapacityExceeded', 'InsufficientAllowance', 'AccountExpired']],
    [503, ['ExactScheduleFromUnset', 'ServiceFundingPausedTreasuryWired']],
    [500, ['DrawMismatch']],
  ];
  for (const [status, names] of TABLE) {
    it.each(names)(`${status}: %s`, async (name) => {
      const agent = stubAgent({
        setConvictionServiceSpending: vi.fn(async () => { throw new ConvictionServiceRevertError(name, { accountId: 42n, limit: 25n * TRAC }); }),
      });
      const answer = await call(agent, 'POST', '/api/ca/42/services', { enabled: true });
      expect(answer.status).toBe(status);
      expect(answer.json).toEqual({ error: name, accountId: '42', args: { accountId: '42', limit: '25000000000000000000' } });
    });
  }

  it('answers transport failures as retryable, without the RPC URL', async () => {
    const exhausted: any = new Error('fund failed on all configured RPC endpoints (https://rpc.example/v2/SECRETKEY)');
    exhausted.code = 'RPC_ENDPOINTS_EXHAUSTED';
    const answer = await call(stubAgent({ fundServicePeriodFromConviction: vi.fn(async () => { throw exhausted; }) }), 'POST', '/api/ca/42/periods', PLAN);
    expect(answer.status).toBe(503);
    expect(JSON.stringify(answer.json)).not.toContain('SECRETKEY');
    const timeout = await call(stubAgent({
      advanceConvictionServiceNonce: vi.fn(async () => { throw new ChainRpcTransportError('RPC_TIMEOUT', 'tx timed out waiting for a receipt'); }),
    }), 'POST', '/api/ca/42/nonce');
    expect(timeout.status).toBe(504);
  });

  it('answers an external signer\'s refusal of the consent as 502 with the other way to consent, and its outage as 503', async () => {
    const refused = new RemoteSignerError('REMOTE_SIGNER_REJECTED', 'Remote signer at signer.local rejected eth_signTypedData_v4: domain not allowed');
    const answer = await call(stubAgent({ signConvictionServiceConsent: vi.fn(async () => { throw refused; }) }), 'POST', '/api/ca/42/consent', CONSENT_BODY);
    expect(answer.status).toBe(502);
    expect(answer.json).toMatchObject({ code: 'REMOTE_SIGNER_REJECTED', error: expect.stringMatching(/domain not allowed/), hint: expect.stringMatching(/assignments/) });
    const down = new RemoteSignerError('REMOTE_SIGNER_UNAVAILABLE', 'Remote signer at signer.local is unreachable');
    const wrapped = Object.assign(new Error('fund service period failed'), { cause: down });
    const funding = await call(stubAgent({ fundServicePeriodFromConviction: vi.fn(async () => { throw wrapped; }) }), 'POST', '/api/ca/42/periods', PLAN);
    expect(funding.status).toBe(503);
    expect(funding.json.code).toBe('REMOTE_SIGNER_UNAVAILABLE');
    expect(funding.json.hint).toBeUndefined();
  });

  it('answers any other failure as 500, and a malformed request as 400 before anything is called', async () => {
    const broken = await call(stubAgent({ getConvictionServiceStatus: vi.fn(async () => { throw new Error('boom at /Users/x/file.ts:1:2'); }) }), 'GET', '/api/ca/42');
    expect(broken.status).toBe(500);
    expect(broken.json.error).toMatch(/^getConvictionServiceStatus failed: boom/);
    const agent = stubAgent();
    for (const [method, path, body] of [
      ['GET', '/api/ca/x1'], ['POST', '/api/ca/42/services', { enabled: 'yes' }], ['POST', '/api/ca/42/services', '{not json'],
      ['DELETE', '/api/ca/42/assignments/0x1234'], ['GET', '/api/ca/42/labels?from=-1'], ['GET', '/api/ca/42/periods?limit=ten'],
    ] as Array<[string, string, unknown?]>) {
      expect((await call(agent, method, path, body)).status, `${method} ${path}`).toBe(400);
    }
    for (const fn of Object.values(agent)) if (vi.isMockFunction(fn)) expect(fn).not.toHaveBeenCalled();
    // A body over the small-body limit is answered as every daemon route answers it.
    const oversized = await call(agent, 'POST', '/api/ca/42/periods', { ...PLAN, planDigest: 'x'.repeat(300 * 1024) });
    expect(oversized.status).toBe(413);
  });
});

describe('reads', () => {
  it('GET /api/ca/:id reads the status fresh on every request, with the node\'s view of it', async () => {
    const agent = stubAgent();
    const first = await call(agent, 'GET', '/api/ca/42');
    expect(first.json).toEqual({
      accountId: '42', owner: PRIMARY, ownedByNode: true, buyerKey: BUYER, logicVersion: '10.1.0',
      serviceSpending: { enabled: true, enabledAt: 1_760_400_000 },
      discountBps: 3000, lockDurationEpochs: 12, expiresAtTimestamp: 1_761_236_000,
      window: {
        index: 3, baseAllowance: '100000000000000000000', baseAllowanceTrac: '100.0', baseRemaining: '93000000000000000000',
        baseRemainingTrac: '93.0', topUpBuffer: '0', topUpBufferTrac: '0.0', expired: false,
      },
      schedule: { exact: true, firstEpoch: 1201, lastEpoch: 1224 },
      labels: { total: '7000000000000000000', totalTrac: '7.0', cursor: 1205, remainingBaseCapacity: '1193000000000000000000', remainingBaseCapacityTrac: '1193.0' },
      assignments: { count: 1, active: 1 },
      treasuryWired: false,
    });
    expect((await call(agent, 'GET', '/api/ca/42', undefined, { wallets: [STRANGER] })).json.ownedByNode).toBe(false);
    expect(agent.getConvictionServiceStatus).toHaveBeenCalledTimes(2);
    expect((await call(agent, 'GET', '/api/ca/7')).json).toEqual({ error: 'UnknownAccount', accountId: '7', args: {} });
  });

  it('GET /api/ca/contracts hands out the addresses and the typed data for signing away from the node', async () => {
    const { status, json } = await call(stubAgent(), 'GET', '/api/ca/contracts');
    expect(status).toBe(200);
    expect(json).toMatchObject({ serviceSubscriptions: SS, logicVersion: '10.1.0', domain: DOMAIN, primaryType: 'ServiceAssignment' });
    expect(json.types).toEqual(SERVICE_ASSIGNMENT_TYPES);
  });

  it('GET /api/ca/mine lists the accounts the primary wallet owns and those the buyer key is assigned on', async () => {
    const agent = stubAgent();
    const { json } = await call(agent, 'GET', '/api/ca/mine');
    expect(json.owner).toBe(PRIMARY);
    expect(json.buyerKey).toBe(BUYER);
    expect(json.owned).toEqual([{ accountId: '42' }, { accountId: '44' }]);
    expect(json.assigned).toEqual([expect.objectContaining({ accountId: '42', assignee: BUYER, active: true, maxTotalCost: '1000000000000000000000', maxTotalCostTrac: '1000.0' })]);
    expect(agent.listPublishingConvictionAccountsForWallets).toHaveBeenCalledWith([PRIMARY]);
    expect(agent.listConvictionServiceAccountsByAssignee).toHaveBeenCalledWith(BUYER);
  });

  it('GET /api/ca/:id/assignments lists every assignment with its caps and usage, and 404s an unknown account', async () => {
    const { json } = await call(stubAgent(), 'GET', '/api/ca/42/assignments');
    expect(json).toEqual({ accountId: '42', assignments: [{
      assignee: BUYER,
      maxCostPerPeriod: '25000000000000000000', maxCostPerPeriodTrac: '25.0',
      maxInferenceCostPerPeriod: '25000000000000000000', maxInferenceCostPerPeriodTrac: '25.0',
      maxQueryCostPerPeriod: '0', maxQueryCostPerPeriodTrac: '0.0',
      maxCostPerWindow: '100000000000000000000', maxCostPerWindowTrac: '100.0',
      maxTotalCost: '1000000000000000000000', maxTotalCostTrac: '1000.0',
      maxPeriodSeconds: 2_678_400, expiresAt: 4_000_000_000, assignedAt: 1_760_000_100, revokedAt: 0, nonce: '3', active: true,
      usage: { totalCost: '7000000000000000000', totalCostTrac: '7.0', windowCost: '7000000000000000000', windowCostTrac: '7.0', window: 3, periods: 1 },
    }] });
    expect((await call(stubAgent(), 'GET', '/api/ca/7/assignments')).status).toBe(404);
  });

  it('GET /api/ca/:id/labels reads the first epochs of the span by default, and at most 120', async () => {
    const agent = stubAgent();
    const { json } = await call(agent, 'GET', '/api/ca/42/labels');
    expect(json).toMatchObject({ accountId: '42', cursor: 1205, from: 1201, to: 1224 });
    expect(json.epochs[0]).toEqual({
      epoch: 1201, scheduled: '100000000000000000000', scheduledTrac: '100.0', baseLabel: '0', baseLabelTrac: '0.0',
      topUpLabel: '0', topUpLabelTrac: '0.0', serviceLabel: '0', serviceLabelTrac: '0.0', pool: '900000000000000000000', poolTrac: '900.0',
    });
    await call(agent, 'GET', '/api/ca/42/labels?from=1300');
    expect(agent.getConvictionServiceLabels).toHaveBeenLastCalledWith(42n, 1300, 1300);
    await call(agent, 'GET', '/api/ca/42/labels?from=1000&to=1119');
    expect(agent.getConvictionServiceLabels).toHaveBeenLastCalledWith(42n, 1000, 1119);
    expect((await call(agent, 'GET', '/api/ca/42/labels?from=1000&to=1120')).status).toBe(400);
    expect((await call(agent, 'GET', '/api/ca/42/labels?from=1210&to=1201')).status).toBe(400);
    expect((await call(agent, 'GET', '/api/ca/7/labels')).status).toBe(404);
  });

  it('GET /api/ca/:id/periods pages the funded periods, buckets by class name', async () => {
    const agent = stubAgent();
    const { json } = await call(agent, 'GET', '/api/ca/42/periods?offset=0&limit=10');
    expect(agent.listServicePeriods).toHaveBeenCalledWith(42n, 0, 10);
    expect(json).toMatchObject({ accountId: '42', total: 1, offset: 0, limit: 10 });
    expect(json.periods[0]).toMatchObject({
      subscriptionId: PERIOD.subscriptionId, assignee: BUYER, cost: '7000000000000000000', costTrac: '7.0', fundedWindow: 3,
      buckets: [{ bucketId: bytes32(1), serviceClass: 'inference', value: '10000000000000000000', valueTrac: '10.0', maxAskWeiPerUnit: '2500000000000' }],
    });
    await call(agent, 'GET', '/api/ca/42/periods');
    expect(agent.listServicePeriods).toHaveBeenLastCalledWith(42n, 0, 50);
    expect((await call(agent, 'GET', '/api/ca/7/periods')).status).toBe(404);
  });
});

describe('owner writes', () => {
  it('switches service spending, revokes and advances the nonce, answering with the transaction', async () => {
    const agent = stubAgent();
    expect((await call(agent, 'POST', '/api/ca/42/services', { enabled: false })).json)
      .toEqual({ accountId: '42', enabled: false, txHash: TX.hash, blockNumber: 123 });
    expect(agent.setConvictionServiceSpending).toHaveBeenCalledWith(42n, false);
    expect((await call(agent, 'DELETE', `/api/ca/42/assignments/${BUYER.toLowerCase()}`)).json)
      .toEqual({ accountId: '42', assignee: BUYER, revoked: true, nextNonce: '5', txHash: TX.hash, blockNumber: 123 });
    expect(agent.revokeConvictionServiceBuyer).toHaveBeenCalledWith(42n, BUYER);
    expect((await call(agent, 'POST', '/api/ca/42/nonce')).json).toEqual({ accountId: '42', nextNonce: '5', txHash: TX.hash, blockNumber: 123 });
  });

  it('refuses a transaction that was mined but did not succeed', async () => {
    const agent = stubAgent({ setConvictionServiceSpending: vi.fn(async () => ({ ...TX, success: false })) });
    expect((await call(agent, 'POST', '/api/ca/42/services', { enabled: true })).status).toBe(502);
  });
});

describe('POST /api/ca/:id/consent', () => {
  it('signs the terms with the buyer key at the current nonce, sends nothing, and answers terms, digest, signature and domain', async () => {
    const agent = stubAgent();
    const { status, json } = await call(agent, 'POST', '/api/ca/42/consent', CONSENT_BODY);
    expect(status).toBe(200);
    expect(json.terms).toEqual(WIRE_TERMS);
    expect(Object.keys(json)).toEqual(['terms', 'digest', 'assigneeSignature', 'domain']);
    expect(json.domain).toEqual(DOMAIN);
    expect(agent.getConvictionServiceAssignmentNonce).toHaveBeenCalledWith(42n);
    const signed = agent.signConvictionServiceConsent.mock.calls[0]![0];
    // Defaults: the inference cap is the period cap; no query; 31 days.
    expect(signed).toMatchObject({ assignee: BUYER, maxInferenceCostPerPeriod: 25n * TRAC, maxQueryCostPerPeriod: 0n, maxPeriodSeconds: 2_678_400, nonce: 3n });
    expect(json.digest).toBe(serviceAssignmentDigest(DOMAIN, signed));
    expect(agent.assignConvictionServiceBuyer).not.toHaveBeenCalled();
  });

  it('takes an explicit nonce and every cap, and refuses terms the contracts would refuse before signing', async () => {
    const agent = stubAgent();
    await call(agent, 'POST', '/api/ca/42/consent', {
      ...CONSENT_BODY, maxInferenceCostPerPeriod: '20', maxQueryCostPerPeriod: '0.5', maxPeriodSeconds: 86_400, nonce: '9',
      expiresAt: '2096-01-01T02:00:00+02:00',
    });
    expect(agent.getConvictionServiceAssignmentNonce).not.toHaveBeenCalled();
    expect(agent.signConvictionServiceConsent.mock.calls[0]![0]).toMatchObject({
      maxInferenceCostPerPeriod: 20n * TRAC, maxQueryCostPerPeriod: TRAC / 2n, maxPeriodSeconds: 86_400, nonce: 9n, expiresAt: 3_976_214_400,
    });
    for (const [body, reason] of [
      [{ ...CONSENT_BODY, maxTotalCost: '10' }, 'maxTotalCost'],
      [{ ...CONSENT_BODY, maxCostPerWindow: '10' }, 'maxCostPerWindow'],
      [{ ...CONSENT_BODY, maxInferenceCostPerPeriod: '0' }, 'classCaps'],
      [{ ...CONSENT_BODY, expiresAt: '2001-01-01T00:00:00Z' }, 'expiresAt'],
    ] as const) {
      const answer = await call(agent, 'POST', '/api/ca/42/consent', body);
      expect(answer.status).toBe(400);
      expect(answer.json).toEqual({ error: 'InvalidAssignmentTerms', accountId: '42', args: { reason } });
    }
    for (const body of [
      { ...CONSENT_BODY, expiresAt: '2096-01-01T00:00:00' },
      { maxCostPerPeriod: '25', expiresAt: '2096-01-01T00:00:00Z' },
      { ...CONSENT_BODY, maxTotal: '10' },
      { ...CONSENT_BODY, maxCostPerPeriod: '1.0000000000000000001' },
      { ...CONSENT_BODY, maxCostPerPeriod: '-1' },
    ]) {
      expect((await call(agent, 'POST', '/api/ca/42/consent', body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(agent.signConvictionServiceConsent).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/ca/:id/assignments', () => {
  const SIG = '0x' + 'cd'.repeat(65);

  it('sends as the owner, with the assignee\'s consent, when the primary wallet owns the account', async () => {
    const agent = stubAgent();
    const consent = (await call(agent, 'POST', '/api/ca/42/consent', CONSENT_BODY)).json;
    // The consent answer as a whole is a valid body.
    const { status, json } = await call(agent, 'POST', '/api/ca/42/assignments', consent);
    expect(status).toBe(200);
    expect(json).toEqual({ accountId: '42', assignee: BUYER, digest: bytes32(0xdd), sentAs: 'owner', txHash: TX.hash, blockNumber: 123 });
    const [terms, signatures, sendAs] = agent.assignConvictionServiceBuyer.mock.calls[0]!;
    expect(sendAs).toBe('owner');
    expect(signatures).toEqual({ owner: undefined, assignee: consent.assigneeSignature });
    expect(terms).toEqual({
      accountId: 42n, assignee: BUYER, maxCostPerPeriod: 25n * TRAC, maxInferenceCostPerPeriod: 25n * TRAC, maxQueryCostPerPeriod: 0n,
      maxCostPerWindow: 100n * TRAC, maxTotalCost: 1000n * TRAC, maxPeriodSeconds: 2_678_400, expiresAt: 3_976_214_400, nonce: 3n,
    });
    const missing = await call(agent, 'POST', '/api/ca/42/assignments', { terms: WIRE_TERMS });
    expect(missing.status).toBe(400);
    expect(missing.json.error).toMatch(/assigneeSignature is required/);
  });

  it('sends as the assignee, with the owner\'s signature, when the node\'s buyer key is the assignee', async () => {
    const agent = stubAgent({ getPublishingConvictionAccountInfo: vi.fn(async () => ({ owner: STRANGER })) });
    const { json } = await call(agent, 'POST', '/api/ca/42/assignments', { terms: WIRE_TERMS, ownerSignature: SIG });
    expect(json.sentAs).toBe('assignee');
    expect(agent.assignConvictionServiceBuyer.mock.calls[0]!.slice(1)).toEqual([{ owner: SIG, assignee: undefined }, 'assignee']);
    const missing = await call(agent, 'POST', '/api/ca/42/assignments', { terms: WIRE_TERMS, assigneeSignature: SIG });
    expect(missing.status).toBe(400);
    expect(missing.json.error).toMatch(/ownerSignature is required/);
  });

  it('answers 403 on a node that is neither the owner nor the assignee, sending nothing', async () => {
    const agent = stubAgent({ getPublishingConvictionAccountInfo: vi.fn(async () => ({ owner: STRANGER })) });
    const answer = await call(agent, 'POST', '/api/ca/42/assignments', { terms: { ...WIRE_TERMS, assignee: STRANGER }, ownerSignature: SIG });
    expect(answer.status).toBe(403);
    expect(answer.json).toMatchObject({ owner: STRANGER, nodeWallet: PRIMARY, buyerKey: BUYER, assignee: STRANGER });
    expect(agent.assignConvictionServiceBuyer).not.toHaveBeenCalled();
  });

  it('assigns the primary wallet itself without signatures, and 404s an unknown account', async () => {
    const agent = stubAgent();
    expect((await call(agent, 'POST', '/api/ca/42/assignments', { terms: { ...WIRE_TERMS, assignee: PRIMARY } })).json.sentAs).toBe('owner');
    expect((await call(agent, 'POST', '/api/ca/7/assignments', { terms: { ...WIRE_TERMS, accountId: '7' }, assigneeSignature: SIG })).status).toBe(404);
  });

  it('refuses terms of another account, or signed under another chain\'s domain or digest, before sending', async () => {
    const agent = stubAgent();
    for (const body of [
      { terms: { ...WIRE_TERMS, accountId: '43' }, assigneeSignature: SIG },
      { terms: WIRE_TERMS, assigneeSignature: SIG, domain: { ...DOMAIN, chainId: 8453 } },
      { terms: WIRE_TERMS, assigneeSignature: SIG, digest: bytes32(0xee) },
      { terms: { ...WIRE_TERMS, maxTotalCostTrac: '1000.0' }, assigneeSignature: SIG },
      { terms: WIRE_TERMS, assigneeSignature: 'cd'.repeat(65) },
    ]) {
      expect((await call(agent, 'POST', '/api/ca/42/assignments', body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(agent.assignConvictionServiceBuyer).not.toHaveBeenCalled();
  });
});

describe('POST /api/ca/:id/assignments/:assignee/caps', () => {
  const path = `/api/ca/42/assignments/${BUYER}/caps`;

  it('merges a partial body over the stored caps, read fresh, and sends all seven', async () => {
    const agent = stubAgent();
    const { status, json } = await call(agent, 'POST', path, { maxCostPerWindow: '50', maxTotalCost: '1500' });
    expect(status).toBe(200);
    expect(agent.listConvictionServiceAssignments).toHaveBeenCalledWith(42n);
    expect(agent.updateConvictionServiceCaps).toHaveBeenCalledWith(42n, BUYER, {
      maxCostPerPeriod: 25n * TRAC, maxInferenceCostPerPeriod: 25n * TRAC, maxQueryCostPerPeriod: 0n,
      maxCostPerWindow: 50n * TRAC, maxTotalCost: 1500n * TRAC, maxPeriodSeconds: 2_678_400, expiresAt: 4_000_000_000,
    });
    expect(json).toMatchObject({
      accountId: '42', assignee: BUYER, unchanged: false, txHash: TX.hash, blockNumber: 123,
      caps: { maxCostPerWindow: '50000000000000000000', maxTotalCost: '1500000000000000000000', maxCostPerPeriod: '25000000000000000000', expiresAt: 4_000_000_000 },
      usage: { totalCost: '7000000000000000000', window: 3, periods: 1 },
    });
  });

  it('sends nothing for caps equal to the stored ones, so a retry never meets CapsUnchanged', async () => {
    const agent = stubAgent();
    for (const body of [{ maxTotalCost: '1000' }, {}]) {
      const { status, json } = await call(agent, 'POST', path, body);
      expect(status).toBe(200);
      expect(json.unchanged).toBe(true);
      expect(json.txHash).toBeUndefined();
    }
    expect(agent.updateConvictionServiceCaps).not.toHaveBeenCalled();
  });

  it('refuses in the contract\'s order: not the owner, no live assignment, then the caps', async () => {
    const notOwner = stubAgent({ getPublishingConvictionAccountInfo: vi.fn(async () => ({ owner: STRANGER })) });
    expect((await call(notOwner, 'POST', path, { maxTotalCost: '1500' })).json).toMatchObject({ error: 'NotAccountOwner', accountId: '42' });
    expect(notOwner.listConvictionServiceAssignments).not.toHaveBeenCalled();
    const cases: Array<[Partial<typeof ASSIGNMENT>[], number, string]> = [
      [[], 403, 'NotAssigned'],
      [[{ revokedAt: 1_760_500_000, active: false }], 409, 'AssignmentRevoked'],
      [[{ active: false }], 409, 'AssignmentExpired'],
    ];
    for (const [stored, status, error] of cases) {
      const agent = stubAgent({ listConvictionServiceAssignments: vi.fn(async () => stored.map((over) => ({ ...ASSIGNMENT, ...over }))) });
      // Equal caps too: a dead assignment is never answered `unchanged`.
      const answer = await call(agent, 'POST', path, { maxTotalCost: '1000' });
      expect([answer.status, answer.json.error]).toEqual([status, error]);
    }
    const agent = stubAgent();
    const invalid = await call(agent, 'POST', path, { maxCostPerWindow: '10' });
    expect(invalid.json).toEqual({ error: 'InvalidAssignmentTerms', accountId: '42', args: { reason: 'maxCostPerWindow' } });
    expect((await call(agent, 'POST', path, { maxTotal: '10' })).status).toBe(400);
    expect(agent.updateConvictionServiceCaps).not.toHaveBeenCalled();
  });
});

describe('POST /api/ca/:id/periods', () => {
  it('funds the plan with the buyer key and answers the period from the funding, with its log index', async () => {
    const agent = stubAgent();
    const { status, json } = await call(agent, 'POST', '/api/ca/42/periods', PLAN);
    expect(status).toBe(200);
    expect(agent.fundServicePeriodFromConviction).toHaveBeenCalledWith({
      accountId: 42n, periodId: bytes32(0xa1), sessionKey: ethers.ZeroAddress, periodSeconds: 2_592_000, planDigest: bytes32(0xd1),
      buckets: [{ bucketId: bytes32(1), serviceClass: 1, value: 10n * TRAC, maxAskWeiPerUnit: 2_500_000_000_000n }],
    });
    expect(json).toMatchObject({
      subscriptionId: PERIOD.subscriptionId, periodId: bytes32(0xa1), cost: '7000000000000000000', costTrac: '7.0',
      drawnFromWindow: '7000000000000000000', drawnFromTopUp: '0', periodStart: 1_760_400_200, periodEnd: 1_762_992_200,
      txHash: TX.hash, blockNumber: 123, logIndex: 7, existing: false,
    });
  });

  it('chooses a random period id when the plan has none, and takes query buckets', async () => {
    const agent = stubAgent();
    await call(agent, 'POST', '/api/ca/42/periods', { ...PLAN, periodId: undefined, buckets: [{ ...PLAN.buckets[0], serviceClass: 'query' }] });
    await call(agent, 'POST', '/api/ca/42/periods', { ...PLAN, periodId: undefined });
    const [[first], [second]] = agent.fundServicePeriodFromConviction.mock.calls as any;
    expect(first.periodId).toMatch(/^0x[0-9a-f]{64}$/);
    expect(first.periodId).not.toBe(second.periodId);
    expect(first.buckets[0].serviceClass).toBe(2);
  });

  it('refuses a malformed plan before anything is sent', async () => {
    const agent = stubAgent();
    for (const plan of [
      { ...PLAN, buckets: [] },
      { ...PLAN, buckets: [{ ...PLAN.buckets[0], serviceClass: 'storage' }] },
      { ...PLAN, buckets: [{ ...PLAN.buckets[0], value: '0' }] },
      { ...PLAN, planDigest: '0x12' },
      { ...PLAN, periodSeconds: 0 },
      { ...PLAN, seller: 'x' },
    ]) {
      expect((await call(agent, 'POST', '/api/ca/42/periods', plan)).status, JSON.stringify(plan)).toBe(400);
    }
    expect(agent.fundServicePeriodFromConviction).not.toHaveBeenCalled();
  });
});

describe('the whole flow over the mock adapter', () => {
  const DAY = 86_400;
  // The consent route checks expiry against the node's clock, so the mock's
  // clock starts at today's epoch.
  const EPOCH = Math.floor(Date.now() / 1000 / DAY);
  const T0 = EPOCH * DAY;

  it('opts in, consents, assigns, funds, reads, changes caps, revokes and refuses the next funding', async () => {
    const ownerWallet = ethers.Wallet.createRandom();
    const buyer = new ethers.Wallet(ethers.Wallet.createRandom().privateKey);
    const chain = new MockChainAdapter('mock:31337', ownerWallet.address);
    chain.configureMockConvictionService({ now: T0, buyer });
    const status = vi.spyOn(chain, 'getConvictionServiceStatus');
    const agent = await DKGAgent.create({ name: 'CaFlow', listenHost: '127.0.0.1', listenPort: 0, chainAdapter: chain, nodeRole: 'core' });
    const { accountId } = await chain.createPublishingConvictionAccount(1_200_000n * TRAC);
    const id = accountId.toString();
    const as = { wallets: [ownerWallet.address] };

    expect((await call(agent, 'POST', `/api/ca/${id}/services`, { enabled: true }, as)).status).toBe(200);
    expect((await call(agent, 'GET', `/api/ca/${id}`, undefined, as)).json).toMatchObject({
      ownedByNode: true, buyerKey: buyer.address, serviceSpending: { enabled: true, enabledAt: T0 },
    });
    expect(status).toHaveBeenLastCalledWith(accountId, { fresh: true });

    const expires = new Date((T0 + 60 * DAY) * 1000).toISOString();
    const consent = await call(agent, 'POST', `/api/ca/${id}/consent`, { ...CONSENT_BODY, expiresAt: expires }, as);
    expect(consent.status).toBe(200);
    const { domain } = (await chain.getConvictionServiceContracts())!;
    expect(ethers.verifyTypedData(domain, SERVICE_ASSIGNMENT_TYPES, consent.json.terms, consent.json.assigneeSignature)).toBe(buyer.address);
    expect((await call(agent, 'POST', `/api/ca/${id}/assignments`, consent.json, as)).json.sentAs).toBe('owner');
    expect((await call(agent, 'GET', `/api/ca/${id}/assignments`, undefined, as)).json.assignments).toEqual([
      expect.objectContaining({ assignee: buyer.address, active: true, nonce: '0' }),
    ]);

    const funded = await call(agent, 'POST', `/api/ca/${id}/periods`, PLAN, as);
    expect(funded.json).toMatchObject({ existing: false, costTrac: '2.5', value: '10000000000000000000' });
    const again = await call(agent, 'POST', `/api/ca/${id}/periods`, PLAN, as);
    expect(again.json).toMatchObject({ existing: true, subscriptionId: funded.json.subscriptionId, txHash: funded.json.txHash });
    expect((await call(agent, 'GET', `/api/ca/${id}/periods`, undefined, as)).json.total).toBe(1);
    const labels = (await call(agent, 'GET', `/api/ca/${id}/labels?from=${EPOCH}&to=${EPOCH + 1}`, undefined, as)).json;
    expect(labels.epochs[0]).toMatchObject({ epoch: EPOCH, baseLabel: '2500000000000000000' });
    expect((await call(agent, 'GET', '/api/ca/mine', undefined, as)).json).toMatchObject({
      owner: ownerWallet.address, buyerKey: buyer.address, owned: [{ accountId: id }], assigned: [expect.objectContaining({ accountId: id })],
    });

    // Tighten the total below the usage: the next funding is refused, the usage kept.
    const caps = await call(agent, 'POST', `/api/ca/${id}/assignments/${buyer.address}/caps`, { maxCostPerPeriod: '2', maxInferenceCostPerPeriod: '2', maxTotalCost: '2' }, as);
    expect(caps.json).toMatchObject({ unchanged: false, usage: { totalCostTrac: '2.5', periods: 1 } });
    const capped = await call(agent, 'POST', `/api/ca/${id}/periods`, { ...PLAN, periodId: bytes32(0xa2), buckets: [{ ...PLAN.buckets[0], value: '1' }] }, as);
    expect([capped.status, capped.json.error, capped.json.args.cap]).toEqual([409, 'CapExceeded', 'maxTotalCost']);

    const revoked = await call(agent, 'DELETE', `/api/ca/${id}/assignments/${buyer.address}`, undefined, as);
    expect(revoked.json).toMatchObject({ revoked: true, nextNonce: '2' });
    const refused = await call(agent, 'POST', `/api/ca/${id}/periods`, { ...PLAN, periodId: bytes32(0xa3) }, as);
    expect([refused.status, refused.json.error]).toEqual([409, 'AssignmentRevoked']);
    expect((await call(agent, 'POST', `/api/ca/${id}/nonce`, undefined, as)).json.nextNonce).toBe('3');
  });
});
