#!/usr/bin/env node
// OT-RFC-27 marketplace TEST CONSOLE — zero-dependency HTTP server (node:http;
// ethers only for chain reads/writes). Devnet tooling, not product code.
//
//   GET  /                         static console (public/index.html, app.js, styles.css)
//   GET|POST /node/<n>/api/marketplace/*   → node n's daemon, bearer token injected server-side
//   GET|POST /node/<n>/api/marketplace/gateway/v1[/*]
//                                  → node n's OpenAI-compatible buyer gateway: the BROWSER's
//                                    `Authorization` (a gateway key) is forwarded and the node
//                                    token is NEVER injected
//   GET  /node/<n>/api/status      → node n's public status (no token)
//   GET  /chain/state              chain clock, epoch, deadline, params, pools
//   GET  /chain/epoch/<e>          buckets, per-seller claims, per-node accounting (R/Q/QIF/reward)
//   GET  /chain/nodes              nodes 1..6: role, port, op wallets, identity, TRAC
//   POST /chain/warp               {seconds} | {toDeadline:true, epoch?}   (devnet time travel)
//   POST /chain/fund-buyer         {node, trac}                            (devnet TRAC top-up)
//   GET  /console/state            what the console last sent (plan policies, offering sets),
//                                  plus the devnet default offering sets and the llm-stub port
//   GET  /console/llm-stub         is the devnet llm-stub up? ({ ok, port, runHint })
//
// Env: HOST (127.0.0.1), PORT (9300), CONSOLE_ACCESS_KEY (optional),
//      DEVNET_RPC (http://127.0.0.1:8545), DEVNET_DIR (<repo>/.devnet).
// Without CONSOLE_ACCESS_KEY the server refuses to bind anything but loopback.

import { createServer } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ethers } from 'ethers';
import { devnetOfferings, llmStubPort, LLM_STUB_RUN_HINT, probeLlmStub } from './devnet-offerings.mjs';
import {
  CONSOLE_DIR,
  NODE_NUMS,
  ROLES,
  RPC,
  SCALE18,
  bigintReplacer,
  chainNow,
  chronosParams,
  epochAt,
  epochStart,
  getChain,
  mineBlock,
  parseTracToWei,
  readConsoleState,
  readNode,
  readToken,
  resetChain,
  roleLabel,
  timeWarp,
  topUpTrac,
  updateConsoleState,
  formatTrac,
} from './lib.mjs';

const HOST = process.env.HOST ?? '127.0.0.1';
const PORT = Number(process.env.PORT ?? 9300);
const ACCESS_KEY = process.env.CONSOLE_ACCESS_KEY ?? '';
const MAX_BODY_BYTES = 64 * 1024;
const PROXY_TIMEOUT_MS = 180_000;
// Gateway chat calls wait for the seller's upstream (the buyer's chat serve
// timeout is 200 s), so the proxy must outlast it.
const GATEWAY_PROXY_TIMEOUT_MS = 240_000;
const GATEWAY_BASE_PATH = '/api/marketplace/gateway/v1';
const KEYS_PATH = '/api/marketplace/keys';
const MAX_WARP_SECONDS = 400 * 24 * 3600;
const MAX_TOPUP_WEI = 1_000_000n * SCALE18;

function isLoopbackHost(host) {
  return host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host);
}

if (!Number.isInteger(PORT) || PORT <= 0 || PORT > 65535) {
  console.error(`[console] invalid PORT=${process.env.PORT}`);
  process.exit(1);
}
if (!ACCESS_KEY && !isLoopbackHost(HOST)) {
  console.error(
    `[console] refusing to bind HOST=${HOST} without CONSOLE_ACCESS_KEY.\n`
    + '  This console drives node wallets and devnet time travel; exposing it beyond loopback\n'
    + '  needs an access key. Either bind loopback (HOST=127.0.0.1) or set CONSOLE_ACCESS_KEY=<long random string>.',
  );
  process.exit(1);
}
if (ACCESS_KEY && ACCESS_KEY.length < 12) {
  console.error('[console] CONSOLE_ACCESS_KEY must be at least 12 characters.');
  process.exit(1);
}

// ───────────────────────────── http helpers ─────────────────────────────

const SECURITY_HEADERS = {
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data:",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; '),
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  res.end(body);
}

function sendJson(res, status, value) {
  send(res, status, JSON.stringify(value, bigintReplacer), {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
}

function sendError(res, status, error, extra = {}) {
  sendJson(res, status, { error, ...extra });
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error(`request body over ${MAX_BODY_BYTES} bytes`), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parseJsonBody(text) {
  if (text.trim().length === 0) return {};
  try {
    return JSON.parse(text);
  } catch (e) {
    throw Object.assign(new Error(`invalid JSON body: ${e.message}`), { status: 400 });
  }
}

function errMessage(err) {
  return err?.shortMessage ?? err?.message ?? String(err);
}

// ───────────────────────────── access control ─────────────────────────────

const COOKIE_NAME = 'mkt_console';
const SESSION_TOKEN = ACCESS_KEY
  ? createHash('sha256').update(`otrfc27-console-v1:${ACCESS_KEY}`).digest('base64url')
  : '';

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function cookieValue(req, name) {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return undefined;
}

const ALLOWED_LOOPBACK_HOSTS = new Set([
  `127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`, `${HOST}:${PORT}`,
]);

/** true = proceed; false = response already sent. */
function authorize(req, res, url) {
  if (!ACCESS_KEY) {
    // DNS-rebinding guard: a keyless console only answers loopback Host headers.
    if (!ALLOWED_LOOPBACK_HOSTS.has(String(req.headers.host ?? '').toLowerCase())) {
      send(res, 403, 'Forbidden: this keyless console only answers loopback Host headers (set CONSOLE_ACCESS_KEY to serve other hosts).\n', {
        'Content-Type': 'text/plain; charset=utf-8',
      });
      return false;
    }
    return true;
  }
  const queryKey = url.searchParams.get('key');
  if (queryKey !== null) {
    if (!safeEqual(queryKey, ACCESS_KEY)) {
      send(res, 401, 'Unauthorized: wrong access key.\n', { 'Content-Type': 'text/plain; charset=utf-8' });
      return false;
    }
    url.searchParams.delete('key');
    const clean = `${url.pathname}${url.searchParams.size > 0 ? `?${url.searchParams}` : ''}`;
    const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
    // 200 + refresh (not a 302): a SameSite=Strict cookie set on a redirect
    // that a cross-site link started is withheld from the redirected request;
    // a refresh issued by this page is same-site, so the cookie rides along.
    const safeClean = clean.replace(/[^A-Za-z0-9/_.\-?=&%]/g, '').replace(/&/g, '&amp;');
    send(
      res,
      200,
      `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${safeClean}">`
        + `<title>Opening console</title><p>Access key accepted. <a href="${safeClean}">Continue to the console</a>.</p>\n`,
      {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Set-Cookie': `${COOKIE_NAME}=${SESSION_TOKEN}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000${secure}`,
      },
    );
    return false;
  }
  const cookie = cookieValue(req, COOKIE_NAME);
  const header = req.headers['x-console-key'];
  if ((cookie && safeEqual(cookie, SESSION_TOKEN)) || (typeof header === 'string' && safeEqual(header, ACCESS_KEY))) {
    return true;
  }
  send(res, 401, 'Unauthorized: this console requires an access key — open it once as <console-url>/?key=<CONSOLE_ACCESS_KEY>.\n', {
    'Content-Type': 'text/plain; charset=utf-8',
  });
  return false;
}

/** Mutations must be same-origin JSON (cross-site forms/fetches are refused). */
function checkMutationOrigin(req) {
  const type = String(req.headers['content-type'] ?? '');
  if (!type.toLowerCase().startsWith('application/json')) {
    throw Object.assign(new Error('POST requires Content-Type: application/json'), { status: 415 });
  }
  const origin = req.headers.origin;
  if (origin && origin !== 'null') {
    let originHost;
    try {
      originHost = new URL(origin).host;
    } catch {
      originHost = '';
    }
    if (originHost !== req.headers.host) {
      throw Object.assign(new Error('cross-origin POST refused'), { status: 403 });
    }
  } else if (origin === 'null') {
    throw Object.assign(new Error('cross-origin POST refused'), { status: 403 });
  }
}

// ───────────────────────────── static files ─────────────────────────────

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
};

function serveStatic(res, pathname) {
  const entry = STATIC[pathname];
  if (!entry) return false;
  try {
    const body = readFileSync(join(CONSOLE_DIR, 'public', entry[0]));
    send(res, 200, body, { 'Content-Type': entry[1], 'Cache-Control': 'no-cache' });
  } catch {
    sendError(res, 500, `static file missing: public/${entry[0]}`);
  }
  return true;
}

// ───────────────────────────── node proxy ─────────────────────────────

/** The node's buyer gateway (exact base or a subpath; `apiPath` is the WHATWG-normalized pathname). */
const isGatewayPath = (apiPath) => apiPath === GATEWAY_BASE_PATH || apiPath.startsWith(`${GATEWAY_BASE_PATH}/`);
/** Gateway key administration: its 201 mint response carries the one-time plaintext key. */
const isKeysPath = (apiPath) => apiPath === KEYS_PATH || apiPath.startsWith(`${KEYS_PATH}/`);

async function proxyToNode(req, res, num, apiPath, search) {
  const isMarketplace = apiPath === '/api/marketplace' || apiPath.startsWith('/api/marketplace/');
  const isGateway = isGatewayPath(apiPath);
  const isStatus = apiPath === '/api/status';
  if (!isMarketplace && !isStatus) {
    return sendError(res, 404, 'only /api/marketplace/* and GET /api/status are proxied');
  }
  if (req.method !== 'GET' && req.method !== 'POST') return sendError(res, 405, 'GET or POST only');
  if (isStatus && req.method !== 'GET') return sendError(res, 405, 'GET only');

  const node = readNode(num);
  if (!node.exists) return sendError(res, 503, `node${num} has no devnet home — is the devnet running?`);
  let bodyText;
  if (req.method === 'POST') {
    checkMutationOrigin(req);
    bodyText = await readBody(req);
    parseJsonBody(bodyText); // reject malformed JSON before it reaches the node
  }
  const headers = { Accept: isGateway ? 'application/json, text/event-stream' : 'application/json' };
  if (isGateway) {
    // The gateway authenticates by a scoped key the BROWSER holds: forward its
    // Authorization header verbatim (never logged) and NEVER inject the node
    // token — a node token on a gateway path is refused, and injecting it
    // would let any page on this origin spend without a key.
    const auth = req.headers.authorization;
    if (typeof auth === 'string' && auth.length > 0) headers.Authorization = auth;
  } else if (isMarketplace) {
    // Token injected server-side for marketplace routes only; it never reaches the browser.
    const token = readToken(num);
    if (token) headers.Authorization = `Bearer ${token}`;
  }
  if (bodyText !== undefined) headers['Content-Type'] = 'application/json';
  const timeoutMs = isGateway ? GATEWAY_PROXY_TIMEOUT_MS : PROXY_TIMEOUT_MS;
  const started = Date.now();
  let upstream;
  try {
    upstream = await fetch(`http://127.0.0.1:${node.apiPort}${apiPath}${search}`, {
      method: req.method,
      headers,
      ...(bodyText !== undefined ? { body: bodyText } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError';
    return sendError(res, timedOut ? 504 : 502, timedOut
      ? `node${num} did not answer within ${timeoutMs / 1000}s`
      : `node${num} is unreachable on :${node.apiPort} (${errMessage(err.cause ?? err)})`, { code: 'NODE_UNREACHABLE' });
  }
  const text = await upstream.text();
  if (req.method === 'POST') {
    console.log(`[console] node${num} POST ${apiPath} → ${upstream.status} (${Date.now() - started} ms)`);
    // Only plan policies and offering sets are remembered, from 200s. A key
    // mint (201) carries the plaintext key: it is never persisted or logged.
    if (upstream.status === 200 && !isGateway && !isKeysPath(apiPath)) rememberMutation(num, apiPath, bodyText, text);
  }
  send(res, upstream.status, text, {
    'Content-Type': upstream.headers.get('content-type') ?? 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
}

/** Remember the plan policy / offering set the console sent (the node APIs do not echo them). */
function rememberMutation(num, apiPath, bodyText, responseText) {
  try {
    const body = JSON.parse(bodyText);
    const resp = JSON.parse(responseText);
    if (apiPath === '/api/marketplace/subscribe') {
      updateConsoleState((s) => {
        const prev = s.plans[num];
        const epoch = String(resp.epoch);
        const sameEpoch = prev && prev.epoch === epoch;
        s.plans[num] = {
          epoch,
          policy: body.policy,
          lastAmountWei: String(resp.amountWei),
          fundedByConsoleWei: (BigInt(sameEpoch ? prev.fundedByConsoleWei ?? '0' : '0') + BigInt(resp.amountWei)).toString(),
          sessionKeyAddress: resp.sessionKeyAddress,
          txHash: resp.txHash,
          at: new Date().toISOString(),
        };
      });
    } else if (apiPath === '/api/marketplace/seller/offerings') {
      updateConsoleState((s) => {
        s.offerings[num] = {
          offerings: body.offerings,
          published: resp.published ?? [],
          publish: body.publish !== false,
          at: new Date().toISOString(),
        };
      });
    }
  } catch (err) {
    console.warn(`[console] could not record ${apiPath} for node${num}: ${errMessage(err)}`);
  }
}

// ───────────────────────────── chain views ─────────────────────────────

let nodesCache = { at: 0, value: undefined, inflight: undefined };

async function probeOnline(apiPort) {
  try {
    const r = await fetch(`http://127.0.0.1:${apiPort}/api/status`, { method: 'HEAD', signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

/** Nodes 1..6 with identity + TRAC (cached ~3s; shared by /chain/nodes and /chain/epoch). */
async function nodesSnapshot({ fresh = false } = {}) {
  if (!fresh && nodesCache.value && Date.now() - nodesCache.at < 3000) return nodesCache.value;
  if (nodesCache.inflight) return nodesCache.inflight;
  nodesCache.inflight = (async () => {
    const chain = await getChain();
    const nodes = await Promise.all(NODE_NUMS.map(async (num) => {
      const node = readNode(num);
      const role = ROLES[num]?.key ?? 'other';
      const base = {
        num,
        role,
        label: roleLabel(num, node.nodeRole),
        apiPort: node.apiPort,
        name: node.name,
        tier: node.nodeRole,
        present: node.exists,
        marketplaceEnabled: node.marketplaceEnabled,
        peerId: node.peerId ?? null,
      };
      if (!node.exists) return { ...base, online: false, opWallets: [], identityId: '0', tracWei: '0' };
      const primary = node.opWallets[0];
      const [online, identityId, wallets] = await Promise.all([
        probeOnline(node.apiPort),
        primary ? chain.identityStorage.getIdentityId(primary).catch(() => 0n) : Promise.resolve(0n),
        Promise.all(node.opWallets.map(async (address) => {
          const [trac, eth] = await Promise.all([
            chain.token.balanceOf(address),
            chain.provider.getBalance(address),
          ]);
          return { address, tracWei: BigInt(trac), ethWei: BigInt(eth) };
        })),
      ]);
      return {
        ...base,
        online,
        primaryWallet: primary ?? null,
        opWallets: wallets,
        identityId: BigInt(identityId),
        tracWei: wallets.reduce((sum, w) => sum + w.tracWei, 0n),
        primaryTracWei: wallets[0]?.tracWei ?? 0n,
      };
    }));
    nodesCache = { at: Date.now(), value: nodes, inflight: undefined };
    return nodes;
  })().finally(() => {
    nodesCache.inflight = undefined;
  });
  return nodesCache.inflight;
}

function identityIndex(nodes) {
  const byId = new Map();
  const byAddress = new Map();
  for (const n of nodes) {
    if (BigInt(n.identityId ?? 0) > 0n) byId.set(BigInt(n.identityId).toString(), n.num);
    for (const w of n.opWallets ?? []) byAddress.set(w.address.toLowerCase(), n.num);
  }
  return { byId, byAddress };
}

async function readParams(chain) {
  const p = await chain.marketplace.getParams();
  return {
    lambdaQif18: BigInt(p.lambdaQif18),
    settlementGraceSeconds: BigInt(p.settlementGraceSeconds),
    softCeilingBps: Number(p.softCeilingBps),
    rewardCapMultiple: Number(p.rewardCapMultiple),
  };
}

function deadlineFor(cp, params, epoch) {
  return epochStart(cp, epoch + 1n) + params.settlementGraceSeconds;
}

/**
 * Where an epoch is in its settlement lifecycle (one word the UI can map to
 * copy): next → current (receipts open) → grace (epoch over, receipts still
 * open) → ready (deadline passed, buckets left to finalize) → settled (every
 * bucket finalized) | empty (deadline passed, nobody subscribed).
 */
function epochPhase({ epoch, current, now, deadline, openBuckets, buyers }) {
  if (epoch > current) return 'next';
  if (epoch === current && now <= deadline) return 'current';
  if (now <= deadline) return 'grace';
  if (buyers === 0) return 'empty';
  return openBuckets > 0n ? 'ready' : 'settled';
}

async function chainState() {
  const chain = await getChain();
  const [cp, clock, params] = await Promise.all([chronosParams(chain), chainNow(chain), readParams(chain)]);
  const epoch = epochAt(cp, clock.now);
  const lo = epoch > 4n ? epoch - 4n : 1n;
  const epochs = [];
  for (let e = lo; e <= epoch + 1n; e++) epochs.push(e);
  const rows = await Promise.all(epochs.map(async (e) => {
    const [dist, open, buyers] = await Promise.all([
      chain.marketplace.getEpochRewardDistribution(e),
      chain.storage.openBuckets(e),
      chain.storage.getEpochBuyers(e),
    ]);
    const deadline = deadlineFor(cp, params, e);
    return {
      epoch: e,
      start: epochStart(cp, e),
      end: epochStart(cp, e + 1n),
      deadline,
      // `settled` is kept for scripts: it only means "past the deadline".
      settled: clock.now > deadline,
      pastDeadline: clock.now > deadline,
      phase: epochPhase({ epoch: e, current: epoch, now: clock.now, deadline, openBuckets: BigInt(open), buyers: buyers.length }),
      secondsToDeadline: deadline > clock.now ? deadline - clock.now : 0n,
      pool: BigInt(dist.pool),
      distributed: BigInt(dist.distributed),
      undistributed: BigInt(dist.undistributed),
      openBuckets: BigInt(open),
      buyers: buyers.length,
    };
  }));
  const current = rows.find((r) => r.epoch === epoch);
  const end = epochStart(cp, epoch + 1n);
  return {
    chainId: chain.chainId,
    rpc: RPC,
    blockNumber: clock.blockNumber,
    chainTime: clock.now,
    latestBlockTimestamp: clock.latestBlockTimestamp,
    wallTime: clock.wall,
    chainAheadSeconds: clock.now - clock.wall,
    epoch,
    epochLength: cp.epochLength,
    epochStart: epochStart(cp, epoch),
    epochEnd: end,
    secondsToNextEpoch: end > clock.now ? end - clock.now : 0n,
    settlementDeadline: current.deadline,
    secondsToDeadline: current.secondsToDeadline,
    settled: current.settled,
    pastDeadline: current.pastDeadline,
    phase: current.phase,
    params,
    pool: { pool: current.pool, distributed: current.distributed, undistributed: current.undistributed },
    openBuckets: current.openBuckets,
    epochs: rows,
    contracts: chain.addrs,
  };
}

function qif18(lambda, r, sumR, q, sumQ) {
  const rTerm = sumR > 0n ? ((SCALE18 - lambda) * r) / sumR : 0n;
  const qTerm = sumQ > 0n ? (lambda * q) / sumQ : 0n;
  return rTerm + qTerm;
}

function cappedReward(pool, qif, capMultiple, r) {
  let reward = (pool * qif) / SCALE18;
  const cap = BigInt(capMultiple) * r;
  const capBinding = capMultiple !== 0 && reward > cap;
  if (capBinding) reward = cap;
  return { reward, uncapped: (pool * qif) / SCALE18, cap: capMultiple !== 0 ? cap : null, capBinding };
}

async function epochDetail(epoch) {
  const chain = await getChain();
  const [cp, clock, params, nodes] = await Promise.all([
    chronosParams(chain), chainNow(chain), readParams(chain), nodesSnapshot(),
  ]);
  const { byId, byAddress } = identityIndex(nodes);
  const deadline = deadlineFor(cp, params, epoch);
  const settled = clock.now > deadline;
  const [dist, open, buyers] = await Promise.all([
    chain.marketplace.getEpochRewardDistribution(epoch),
    chain.storage.openBuckets(epoch),
    chain.storage.getEpochBuyers(epoch),
  ]);
  const pool = BigInt(dist.pool);

  const buckets = await Promise.all(buyers.map(async (buyerRaw) => {
    const buyer = ethers.getAddress(buyerRaw);
    const [b, sellerIds, sessionKey, cursor] = await Promise.all([
      chain.marketplace.getBucket(buyer, epoch),
      chain.storage.getBucketSellers(buyer, epoch),
      chain.marketplace.activeSessionKey(buyer),
      chain.storage.finalizeCursor(buyer, epoch),
    ]);
    const funded = BigInt(b.funded);
    const totalClaimed = BigInt(b.totalClaimed);
    const proRata = totalClaimed > funded;
    const claims = await Promise.all(sellerIds.map(async (sidRaw, index) => {
      const sid = BigInt(sidRaw);
      const c = await chain.marketplace.getSellerClaim(buyer, epoch, sid);
      const claimed = BigInt(c.claimed);
      const qiRaw = BigInt(c.qiRaw);
      const finalizedPreview = claimed === 0n ? 0n : (proRata ? (claimed * funded) / totalClaimed : claimed);
      return {
        identityId: sid,
        node: byId.get(sid.toString()) ?? null,
        claimed,
        qiRaw,
        enrolled: Boolean(c.enrolled),
        finalizedValue: finalizedPreview,
        qiScore: claimed === 0n ? 0n : (qiRaw * finalizedPreview) / claimed,
        processed: Boolean(b.finalized) || index < Number(cursor),
      };
    }));
    return {
      buyer,
      buyerNode: byAddress.get(buyer.toLowerCase()) ?? null,
      funded,
      totalClaimed,
      totalFinalized: BigInt(b.totalFinalized),
      finalized: Boolean(b.finalized),
      finalizeCursor: BigInt(cursor),
      overClaimed: proRata,
      residue: proRata ? funded - claims.reduce((s, c) => s + c.finalizedValue, 0n) : 0n,
      activeSessionKey: sessionKey,
      canFinalize: settled && funded > 0n && !b.finalized,
      sellers: claims,
    };
  }));

  // Per-node accounting: every claimant plus every devnet node with an identity.
  const ids = new Set();
  for (const n of nodes) if (BigInt(n.identityId ?? 0) > 0n) ids.add(BigInt(n.identityId).toString());
  for (const b of buckets) for (const s of b.sellers) ids.add(s.identityId.toString());

  // Projection "if every open bucket finalized now": add each unprocessed
  // claimant's pro-rata share to the already-finalized totals.
  const projR = new Map();
  const projQ = new Map();
  for (const b of buckets) {
    if (b.finalized) continue;
    for (const s of b.sellers) {
      if (s.processed || s.claimed === 0n) continue;
      const k = s.identityId.toString();
      projR.set(k, (projR.get(k) ?? 0n) + s.finalizedValue);
      projQ.set(k, (projQ.get(k) ?? 0n) + s.qiScore);
    }
  }

  const accounting = await Promise.all([...ids].map(async (k) => {
    const id = BigInt(k);
    const [a, qifChain] = await Promise.all([
      chain.marketplace.getNodeEpochAccounting(epoch, id),
      chain.marketplace.getQif18(epoch, id),
    ]);
    return { id, a, qifChain: BigInt(qifChain) };
  }));
  const sumR = accounting.length ? BigInt(accounting[0].a.totalFinalizedValue) : 0n;
  const sumQ = accounting.length ? BigInt(accounting[0].a.totalQiScore) : 0n;
  let projSumR = sumR;
  let projSumQ = sumQ;
  for (const v of projR.values()) projSumR += v;
  for (const v of projQ.values()) projSumQ += v;

  const nodeRows = accounting.map(({ id, a, qifChain }) => {
    const k = id.toString();
    const R = BigInt(a.finalizedValue);
    const Q = BigInt(a.qiScore);
    const actual = cappedReward(pool, qifChain, params.rewardCapMultiple, R);
    const pR = R + (projR.get(k) ?? 0n);
    const pQ = Q + (projQ.get(k) ?? 0n);
    const pQif = qif18(params.lambdaQif18, pR, projSumR, pQ, projSumQ);
    const projected = cappedReward(pool, pQif, params.rewardCapMultiple, pR);
    const claimed = Boolean(a.claimed);
    const allFinalized = BigInt(open) === 0n;
    return {
      identityId: id,
      node: byId.get(k) ?? null,
      R,
      Q,
      sumR,
      sumQ,
      rShare18: sumR > 0n ? (R * SCALE18) / sumR : 0n,
      qShare18: sumQ > 0n ? (Q * SCALE18) / sumQ : 0n,
      qif18: qifChain,
      qifMirror18: qif18(params.lambdaQif18, R, sumR, Q, sumQ),
      expectedReward: actual.reward,
      uncappedReward: actual.uncapped,
      rewardCap: actual.cap,
      capBinding: actual.capBinding,
      claimed,
      claimable: settled && allFinalized && sumR > 0n && !claimed && actual.reward > 0n,
      projected: {
        R: pR,
        Q: pQ,
        sumR: projSumR,
        sumQ: projSumQ,
        qif18: pQif,
        reward: projected.reward,
        capBinding: projected.capBinding,
      },
    };
  });
  nodeRows.sort((x, y) => (x.node ?? 99) - (y.node ?? 99));

  return {
    epoch,
    chainTime: clock.now,
    currentEpoch: epochAt(cp, clock.now),
    epochEnd: epochStart(cp, epoch + 1n),
    deadline,
    settled,
    pastDeadline: settled,
    phase: epochPhase({
      epoch, current: epochAt(cp, clock.now), now: clock.now, deadline, openBuckets: BigInt(open), buyers: buyers.length,
    }),
    secondsToDeadline: deadline > clock.now ? deadline - clock.now : 0n,
    params,
    pool,
    distributed: BigInt(dist.distributed),
    undistributed: BigInt(dist.undistributed),
    openBuckets: BigInt(open),
    allFinalized: BigInt(open) === 0n,
    sumR,
    sumQ,
    buckets,
    nodes: nodeRows,
  };
}

async function warp(body) {
  const chain = await getChain();
  const cp = await chronosParams(chain);
  const params = await readParams(chain);
  // Mine first so the latest block timestamp is exact chain "now".
  await mineBlock(chain);
  const before = await chainNow(chain);
  const t0 = before.latestBlockTimestamp;
  let seconds;
  let target;
  if (body.toDeadline === true) {
    const epoch = body.epoch === undefined ? epochAt(cp, t0) : parseEpoch(body.epoch);
    const deadline = deadlineFor(cp, params, epoch);
    const delta = deadline + 15n - t0;
    seconds = delta > 0n ? delta : 0n;
    target = { epoch, deadline };
  } else {
    if (!Number.isSafeInteger(body.seconds) || body.seconds <= 0 || body.seconds > MAX_WARP_SECONDS) {
      throw Object.assign(new Error(`seconds must be an integer in 1..${MAX_WARP_SECONDS}`), { status: 400 });
    }
    seconds = BigInt(body.seconds);
  }
  if (seconds > BigInt(MAX_WARP_SECONDS)) {
    throw Object.assign(new Error(`refusing to warp ${seconds}s (> ${MAX_WARP_SECONDS}s)`), { status: 400 });
  }
  if (seconds > 0n) await timeWarp(chain, seconds);
  // Fresh read (the provider runs with caching off; see getChain).
  const after = await chainNow(chain);
  if (seconds > 0n && after.latestBlockTimestamp < t0 + seconds) {
    console.warn(`[console] time travel: chain reads ${after.latestBlockTimestamp} after +${seconds}s from ${t0} (expected ≥ ${t0 + seconds})`);
  }
  console.log(`[console] devnet time travel: +${seconds}s (chain ${t0} → ${after.latestBlockTimestamp})`);
  return {
    warpedSeconds: seconds,
    alreadyPast: seconds === 0n,
    chainTimeBefore: t0,
    chainTimeAfter: after.latestBlockTimestamp,
    epochBefore: epochAt(cp, t0),
    epochAfter: epochAt(cp, after.latestBlockTimestamp),
    ...(target ? { target } : {}),
  };
}

async function fundNode(body) {
  const num = Number(body.node);
  if (!NODE_NUMS.includes(num)) throw Object.assign(new Error('node must be 1..6'), { status: 400 });
  let addWei;
  try {
    addWei = parseTracToWei(body.trac);
  } catch (err) {
    throw Object.assign(new Error(`trac: ${err.message}`), { status: 400 });
  }
  if (addWei <= 0n || addWei > MAX_TOPUP_WEI) {
    throw Object.assign(new Error('trac must be > 0 and ≤ 1,000,000'), { status: 400 });
  }
  const node = readNode(num);
  const address = node.opWallets[0];
  if (!address) throw Object.assign(new Error(`node${num} has no operational wallet`), { status: 409 });
  const chain = await getChain();
  const r = await topUpTrac(chain, address, addWei);
  nodesCache.at = 0;
  console.log(`[console] devnet TRAC top-up: node${num} ${address} +${formatTrac(addWei)} TRAC`);
  return { node: num, address, beforeWei: r.before, afterWei: r.after, addedWei: r.added };
}

function parseEpoch(raw) {
  const s = String(raw);
  if (!/^\d{1,12}$/.test(s) || BigInt(s) === 0n) {
    throw Object.assign(new Error('epoch must be a positive integer'), { status: 400 });
  }
  return BigInt(s);
}

function chainFailure(res, err) {
  if (err?.status) return sendError(res, err.status, err.message);
  resetChain();
  const msg = errMessage(err);
  const down = /ECONNREFUSED|fetch failed|network|timeout/i.test(msg);
  return sendError(res, down ? 503 : 500, down ? `chain RPC unreachable at ${RPC} (${msg})` : msg, {
    code: down ? 'CHAIN_DOWN' : 'CHAIN_ERROR',
  });
}

// ───────────────────────────── router ─────────────────────────────

async function handle(req, res) {
  const url = new URL(req.url ?? '/', 'http://console.local');
  if (!authorize(req, res, url)) return;
  const { pathname } = url;

  if (req.method === 'GET' && serveStatic(res, pathname)) return;
  if (req.method === 'GET' && pathname === '/healthz') return sendJson(res, 200, { ok: true });

  const nodeMatch = /^\/node\/([1-6])(\/api\/.*)$/.exec(pathname);
  if (nodeMatch) {
    const search = [...url.searchParams].length > 0 ? `?${url.searchParams}` : '';
    return proxyToNode(req, res, Number(nodeMatch[1]), nodeMatch[2], search);
  }

  if (pathname === '/console/state' && req.method === 'GET') {
    const s = readConsoleState();
    return sendJson(res, 200, {
      roles: Object.fromEntries(Object.entries(ROLES).map(([n, r]) => [n, r.key])),
      accessKeyRequired: Boolean(ACCESS_KEY),
      plans: s.plans,
      offerings: s.offerings,
      // The seeder's offering sets ("Load devnet defaults"). Connector config
      // names the secret FILE only, never its content.
      devnetOfferings: devnetOfferings(),
      llmStub: { port: llmStubPort(), runHint: LLM_STUB_RUN_HINT },
      gatewayBasePath: GATEWAY_BASE_PATH,
    });
  }
  if (pathname === '/console/llm-stub' && req.method === 'GET') {
    return sendJson(res, 200, { port: llmStubPort(), runHint: LLM_STUB_RUN_HINT, ...(await probeLlmStub()) });
  }

  try {
    if (req.method === 'GET' && pathname === '/chain/state') return sendJson(res, 200, await chainState());
    if (req.method === 'GET' && pathname === '/chain/nodes') {
      return sendJson(res, 200, { nodes: await nodesSnapshot({ fresh: url.searchParams.get('fresh') === '1' }) });
    }
    const epochMatch = /^\/chain\/epoch\/([^/]+)$/.exec(pathname);
    if (req.method === 'GET' && epochMatch) return sendJson(res, 200, await epochDetail(parseEpoch(epochMatch[1])));
    if (req.method === 'POST' && (pathname === '/chain/warp' || pathname === '/chain/fund-buyer')) {
      checkMutationOrigin(req);
      const body = parseJsonBody(await readBody(req));
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return sendError(res, 400, 'body must be a JSON object');
      }
      return sendJson(res, 200, pathname === '/chain/warp' ? await warp(body) : await fundNode(body));
    }
  } catch (err) {
    return chainFailure(res, err);
  }
  return sendError(res, 404, `no route: ${req.method} ${pathname}`);
}

const server = createServer((req, res) => {
  handle(req, res).catch((err) => {
    if (!res.headersSent) sendError(res, err?.status ?? 500, errMessage(err));
    else res.end();
  });
});

server.on('error', (err) => {
  console.error(`[console] server error: ${errMessage(err)}`);
  process.exit(1);
});

server.listen(PORT, HOST, async () => {
  const shownHost = HOST.includes(':') ? `[${HOST}]` : HOST;
  const base = `http://${shownHost}:${PORT}/`;
  const lines = [
    '',
    'OT-RFC-27 marketplace test console',
    `  URL     ${base}${ACCESS_KEY ? '?key=<CONSOLE_ACCESS_KEY>   (sets an HttpOnly cookie, then drops the key from the URL)' : ''}`,
    `  Access  ${ACCESS_KEY ? 'access key REQUIRED on every request (cookie or X-Console-Key header)' : 'loopback only, no key (set CONSOLE_ACCESS_KEY to expose beyond loopback)'}`,
    `  Chain   ${RPC}`,
  ];
  try {
    const chain = await getChain();
    lines.push(`          Hub ${chain.addrs.Hub} · Marketplace ${chain.addrs.Marketplace}`);
  } catch (err) {
    lines.push(`          (not reachable yet: ${errMessage(err)})`);
  }
  lines.push('  Nodes');
  for (const num of NODE_NUMS) {
    const n = readNode(num);
    const online = n.exists ? await probeOnline(n.apiPort) : false;
    lines.push(
      `    node${num}  :${n.apiPort}  ${roleLabel(num, n.nodeRole).padEnd(28)} ${online ? 'online ' : 'OFFLINE'}`
      + `${n.peerId ? `  peer …${n.peerId.slice(-8)}` : ''}${n.marketplaceEnabled ? '' : '  (marketplace disabled)'}`,
    );
  }
  const stub = await probeLlmStub();
  lines.push(`  Stub    llm-stub :${llmStubPort()} ${stub.ok ? `up (model ${stub.model})` : `DOWN — start it: ${LLM_STUB_RUN_HINT}`}`);
  lines.push('  Views   Buyer = node2 · Seller A = node1 · Seller B = node3', '');
  console.log(lines.join('\n'));
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close();
    process.exit(0);
  });
}
