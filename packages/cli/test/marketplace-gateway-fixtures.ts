// Shared fixtures for the OT-RFC-27 buyer gateway tests: a fake agent that
// drives the spend guard the way the agent runtime does (admit → settle
// exactly once), result doubles carrying the spec's golden numbers (GV-2:
// usage 17/5/22, ask 5e11, maxUnits 273), and a real HTTP server around the
// production dispatch.

import { createServer, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import {
  createMarketplaceGatewayDispatch,
  isMarketplaceGatewayPath,
  type MarketplaceGatewayDispatch,
} from '../src/daemon/marketplace-gateway-dispatch.js';
import {
  MarketplaceGatewayKeyStore,
  gatewayKeyStorePath,
} from '../src/marketplace-gateway-key-store.js';
import type { ResolvedMarketplaceGatewayConfig } from '../src/marketplace-config.js';
import type { MarketplaceGatewayAgent } from '../src/daemon/routes/marketplace-gateway.js';

export const ASK_WEI = 500_000_000_000n;
export const GV2_MESSAGES = [
  { role: 'system', content: 'You are terse.' },
  { role: 'user', content: 'hello marketplace world' },
];
export const GV2_REPLY = 'STUB:WORLD MARKETPLACE HELLO :: ok';
export const CALL_ID = `0x${'ab'.repeat(32)}`;
export const WORST_CASE_WEI = 273n * ASK_WEI;
export const RECEIPT_WEI = 22n * ASK_WEI;

export function tempHome(prefix = 'dkg-mkt-gw-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function namedError(name: string, message: string, extra: Record<string, unknown> = {}): Error {
  const err = new Error(message);
  err.name = name;
  Object.assign(err, extra);
  return err;
}

export function fakeInvoke(overrides: { servedUnits?: bigint; costWei?: bigint; result?: unknown } = {}) {
  const servedUnits = overrides.servedUnits ?? 22n;
  return {
    result: overrides.result ?? {},
    resultBytes: new Uint8Array(),
    receipt: {
      authDigest: `0x${'11'.repeat(32)}`,
      servedUnits,
      receiptValueWei: overrides.costWei ?? servedUnits * ASK_WEI,
      resultCommitment: `0x${'22'.repeat(32)}`,
      sellerSig: `0x${'33'.repeat(65)}`,
    },
    authorization: {
      chainId: 31337n,
      marketplaceAddress: `0x${'44'.repeat(20)}`,
      buyer: `0x${'55'.repeat(20)}`,
      sellerIdentityId: 1n,
      offeringId: `0x${'66'.repeat(32)}`,
      callId: CALL_ID,
      epoch: 7n,
      maxUnits: 273n,
      askPerUnitWei: ASK_WEI,
      expiry: 1_900_000_000n,
      authDigest: `0x${'11'.repeat(32)}`,
      signature: `0x${'77'.repeat(65)}`,
    },
    seller: { peerId: '12D3KooWSeller', identityId: 1n, address: `0x${'88'.repeat(20)}` },
    servedUnits,
    costWei: overrides.costWei ?? servedUnits * ASK_WEI,
    recount: { verdict: 'match' as const, servedUnits, recountUnits: servedUnits },
  };
}

export function fakeChatResult(overrides: Record<string, unknown> = {}) {
  const invoke = fakeInvoke();
  return {
    callId: CALL_ID,
    model: 'stub-chat',
    message: { role: 'assistant' as const, content: GV2_REPLY },
    finishReason: 'stop' as const,
    usage: { promptTokens: 17, completionTokens: 5, totalTokens: 22 },
    metering: {
      basis: 'pinned' as const,
      tokenizer: { kind: 'stub-words-v1' as const, digest: `sha256:${'77c4'.padEnd(64, '0')}` },
      chatTemplate: { id: 'openai-chat-count/v1' as const, digest: `sha256:${'5366'.padEnd(64, '0')}` },
      promptUnits: 17,
      toolUnits: 0,
      completionUnits: 5,
      servedUnits: 22,
      truncated: false,
      providerUsage: { prompt_tokens: 17, completion_tokens: 5 },
    },
    recount: invoke.recount,
    invoke,
    ...overrides,
  };
}

export function fakeQueryResult() {
  const invoke = fakeInvoke({ servedUnits: 4n });
  return {
    callId: CALL_ID,
    result: { bindings: [{ s: 'urn:x' }] },
    rowCount: 1,
    metering: {
      scheduleDigest: `sha256:${'70be'.padEnd(64, '0')}`,
      admissionUnits: 3,
      deliveryUnits: 1,
      servedUnits: 4,
      rowCount: 1,
    },
    recount: invoke.recount,
    invoke,
  };
}

type Guard = { admit(w: bigint): void; settle(o: { costWei: bigint; servedUnits: bigint; delivery: 'served' | 'not-served' | 'ambiguous' }): void };

/**
 * A fake agent: by default it admits the GV-2 worst case through the spend
 * guard and settles the receipt value, exactly as the runtime does.
 */
export function makeFakeAgent(overrides: Partial<Record<keyof MarketplaceGatewayAgent, (input: any) => Promise<any>>> = {}) {
  const calls: Array<{ method: string; input: any }> = [];
  const agent: MarketplaceGatewayAgent = {
    marketplaceChatCompletion: async (input: any) => {
      calls.push({ method: 'chat', input });
      if (overrides.marketplaceChatCompletion) return overrides.marketplaceChatCompletion(input);
      const guard = input.spendGuard as Guard | undefined;
      guard?.admit(WORST_CASE_WEI);
      guard?.settle({ costWei: RECEIPT_WEI, servedUnits: 22n, delivery: 'served' });
      return fakeChatResult();
    },
    marketplaceGatewayQuery: async (input: any) => {
      calls.push({ method: 'query', input });
      if (overrides.marketplaceGatewayQuery) return overrides.marketplaceGatewayQuery(input);
      const guard = input.spendGuard as Guard | undefined;
      guard?.admit(103n * ASK_WEI);
      guard?.settle({ costWei: 4n * ASK_WEI, servedUnits: 4n, delivery: 'served' });
      return fakeQueryResult();
    },
    marketplaceGatewayModels: async () => {
      calls.push({ method: 'models', input: undefined });
      if (overrides.marketplaceGatewayModels) return overrides.marketplaceGatewayModels(undefined);
      return [
        {
          id: 'other-chat', offers: 1, sellers: [3n], minAskPerUnitWei: ASK_WEI, meteringBases: ['provider-reported'],
          tokenizerKinds: [], provenanceClasses: ['upstream-claimed'], toolTransports: ['none'], routable: false,
        },
        {
          id: 'stub-chat', contextLength: 32768n, offers: 2, sellers: [1n, 3n], minAskPerUnitWei: ASK_WEI,
          meteringBases: ['pinned'], tokenizerKinds: ['stub-words-v1'], provenanceClasses: ['upstream-claimed'],
          toolTransports: ['native'], routable: true,
        },
      ];
    },
  } as MarketplaceGatewayAgent;
  return { agent, calls };
}

export const DEFAULT_GATEWAY_CONFIG: ResolvedMarketplaceGatewayConfig = {
  defaultMaxTokens: 256,
  maxBodyBytes: 4 * 1024 * 1024,
  maxConcurrent: 16,
};

export interface GatewayServer {
  url: string;
  base: string;
  server: Server;
  dispatch: MarketplaceGatewayDispatch;
  store: MarketplaceGatewayKeyStore;
  logs: string[];
  close(): Promise<void>;
}

/** The production dispatch behind a real HTTP server (carve-out only; anything else 418). */
export async function startGatewayServer(opts: {
  agent: MarketplaceGatewayAgent;
  config?: Partial<ResolvedMarketplaceGatewayConfig>;
  store?: MarketplaceGatewayKeyStore;
  nowMs?: () => number;
  corsOrigin?: string | null;
  bodyTimeoutMs?: number;
}): Promise<GatewayServer> {
  const logs: string[] = [];
  const store = opts.store ?? new MarketplaceGatewayKeyStore(gatewayKeyStorePath(tempHome()));
  const dispatch = createMarketplaceGatewayDispatch({
    agent: opts.agent,
    gateway: { ...DEFAULT_GATEWAY_CONFIG, ...opts.config },
    dataDir: '/nonexistent',
    log: (line) => logs.push(line),
    store,
    ...(opts.nowMs ? { nowMs: opts.nowMs } : {}),
    ...(opts.bodyTimeoutMs ? { bodyTimeoutMs: opts.bodyTimeoutMs } : {}),
  })!;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    if (isMarketplaceGatewayPath(url.pathname)) {
      await dispatch.handle(req, res, url, opts.corsOrigin ?? null);
      return;
    }
    res.writeHead(418).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;
  return {
    url,
    base: `${url}/api/marketplace/gateway/v1`,
    server,
    dispatch,
    store,
    logs,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}

export async function mintKey(
  store: MarketplaceGatewayKeyStore,
  scopes: Partial<{ label: string; budgetWei: bigint; expiresAt: number | null; modelAllowlist: string[] | null; allowQuery: boolean; rps: number }> = {},
): Promise<{ plaintext: string; keyId: string }> {
  const { plaintext, record } = await store.mint({
    label: 'test',
    budgetWei: 10n ** 18n,
    expiresAt: null,
    modelAllowlist: null,
    allowQuery: true,
    rps: 1000,
    ...scopes,
  }, Math.floor(Date.now() / 1000));
  return { plaintext, keyId: record.keyId };
}

export const bearer = (key: string): Record<string, string> => ({ Authorization: `Bearer ${key}` });

export async function postJson(url: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, headers: res.headers, text, json };
}

export async function getJson(url: string, headers: Record<string, string> = {}) {
  const res = await fetch(url, { headers });
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, headers: res.headers, text, json };
}
