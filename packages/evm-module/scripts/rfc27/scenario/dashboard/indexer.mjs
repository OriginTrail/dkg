// The dashboard's indexer: one read of the chain, then one atomic write of
// data.json. A systemd --user timer runs it every five minutes.
//
// It reads views through Multicall3, pinned to one block, and events from
// Blockscout, because the public RPC limits eth_getLogs to 200 blocks. It holds no
// key and sends no transaction. It knows who is who only from a public file, and
// everything it shows about them comes from the chain.
//
//   DASHBOARD_DIR  where www/, state/ and logs/ live; default: this script's folder
//   RPC_URLS       comma-separated; default https://sepolia.base.org
//   BLOCKSCOUT     explorer base URL, or "node" to read logs from the RPC (a local fork)
//   NODE_LOGS_FROM with BLOCKSCOUT=node, the first block to read
//   PIN_LAG_BLOCKS how far behind the head to read; default 5 (about a second)
//   HUB            the Hub; default the Base Sepolia testnet's
//   PUBLIC_URL     where to fetch the public file from; "" for none
//   PUBLIC_FILE    the public file on disk; default <DASHBOARD_DIR>/public.json

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, appendFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { BlockscoutSource, decodeBatchInput, decodeLog, decodeRevert, functionName, HUB_NAMES, IFACES, NodeSource, revertHexOf, Rpc, subscriptionIdOf } from './lib/chain.mjs';
import { compose, FAULTS, startOf } from './lib/compose.mjs';

const env = process.env;
const DEFAULT_HUB = '0xC056e67Da4F51377Ad1B01f50F655fFdcCD809F6';
const DEFAULT_PUBLIC_URL = 'https://raw.githubusercontent.com/OriginTrail/dkg/refs/heads/test/rfc27-testnet-scenario/packages/evm-module/scripts/rfc27/scenario/public.testnet.json';

const config = {
  dir: env.DASHBOARD_DIR ?? dirname(process.argv[1]),
  hub: (env.HUB ?? DEFAULT_HUB).toLowerCase(),
  chainId: Number(env.CHAIN_ID ?? 84532),
  rpcUrls: (env.RPC_URLS ?? 'https://sepolia.base.org').split(',').map((s) => s.trim()).filter(Boolean),
  blockscout: env.BLOCKSCOUT ?? 'https://base-sepolia.blockscout.com',
  nodeLogsFrom: Number(env.NODE_LOGS_FROM ?? 0),
  pinLag: Number(env.PIN_LAG_BLOCKS ?? 5),
  explorer: env.EXPLORER ?? 'https://sepolia.basescan.org',
  publicUrl: env.PUBLIC_URL ?? DEFAULT_PUBLIC_URL,
  publicFile: env.PUBLIC_FILE ?? null,
};
config.publicFile ??= join(config.dir, 'public.json');

const paths = {
  www: join(config.dir, 'www'),
  data: join(config.dir, 'www', 'data.json'),
  state: join(config.dir, 'state'),
  cache: join(config.dir, 'state', 'cache.json'),
  publicLast: join(config.dir, 'state', 'public.last.json'),
  logs: join(config.dir, 'logs'),
  log: join(config.dir, 'logs', 'indexer.log'),
};

/** Blocks re-read behind each cursor, about 30 minutes: an explorer may index a block late. */
const OVERLAP_BLOCKS = 9_000;
/** An epoch's numbers are final only if read this long after its end, past any lagging node. */
const FINAL_MARGIN_SECONDS = 30;
const LOG_LIMIT_BYTES = 1024 * 1024;

const nowSeconds = () => Math.floor(Date.now() / 1000);

// ------------------------------------------------------------------ files

function ensureDirs() {
  for (const d of [paths.www, paths.state, paths.logs]) mkdirSync(d, { recursive: true });
}

function log(message) {
  const line = `${new Date().toISOString()} ${message}\n`;
  process.stdout.write(line);
  try {
    if (existsSync(paths.log) && statSync(paths.log).size > LOG_LIMIT_BYTES) renameSync(paths.log, `${paths.log}.1`);
    appendFileSync(paths.log, line);
  } catch {
    /* a log that cannot be written stops nothing */
  }
}

function writeAtomic(path, text) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function emptyState() {
  return { v: 1, addresses: {}, cursors: {}, logs: [], txs: {}, final: {}, live: {}, split: {}, positions: {}, operators: {}, sellersLive: {}, buyersLive: {}, lastOk: {}, fullScanEpoch: null };
}

// ------------------------------------------------------------------ the public file

function validPublic(j) {
  return !!j && typeof j === 'object' && Number(j.network?.chainId) === config.chainId && String(j.network?.hub ?? '').toLowerCase() === config.hub && Array.isArray(j.sellers) && Array.isArray(j.buyers);
}

/** Who is who: the repository's copy if it is out, else a local copy, else the last good one. */
async function loadPublic() {
  if (config.publicUrl) {
    try {
      const res = await fetch(config.publicUrl, { signal: AbortSignal.timeout(10_000) });
      if (res.ok) {
        const j = await res.json();
        if (validPublic(j)) {
          writeAtomic(paths.publicLast, JSON.stringify(j));
          return { pub: j, source: 'repository', at: nowSeconds() };
        }
      }
    } catch (e) {
      log(`public file: ${e.message}`);
    }
  }
  if (existsSync(config.publicFile)) {
    const j = readJson(config.publicFile);
    if (validPublic(j)) {
      writeAtomic(paths.publicLast, JSON.stringify(j));
      return { pub: j, source: 'file', at: Math.floor(statSync(config.publicFile).mtimeMs / 1000) };
    }
    log(`public file ${config.publicFile} does not match this chain and Hub; ignored`);
  }
  const last = readJson(paths.publicLast);
  if (validPublic(last)) return { pub: last, source: 'last good copy', at: Math.floor(statSync(paths.publicLast).mtimeMs / 1000) };
  return { pub: null, source: 'none', at: null };
}

// ------------------------------------------------------------------ the Hub and the clock

function contractOf(st, name) {
  const addresses = st.addresses[name];
  if (!addresses?.length) throw new Error(`no address for ${name}`);
  return { address: addresses[addresses.length - 1], iface: IFACES[HUB_NAMES[name]] };
}

/** Every contract from the Hub, each run: one registered again keeps its old address, for its logs. */
async function resolveContracts(rpc, st, blockHex) {
  const hub = { address: config.hub, iface: IFACES.Hub };
  const names = Object.keys(HUB_NAMES);
  const answers = await rpc.readAll(names.map((n) => ({ c: hub, fn: 'getContractAddress', args: [n] })), blockHex);
  names.forEach((n, i) => {
    const a = answers[i];
    if (!a) throw new Error(`the Hub holds no ${n}`);
    const lower = a.toLowerCase();
    st.addresses[n] ??= [];
    if (st.addresses[n][st.addresses[n].length - 1] !== lower) st.addresses[n].push(lower);
  });
  st.contracts = Object.fromEntries(names.map((n) => [n, st.addresses[n][st.addresses[n].length - 1]]));
}

async function readClock(rpc, st, pin) {
  const [start, length, epoch, activation, lambda, paused, maxFee, maxStake] = await rpc.readAll(
    [
      { c: contractOf(st, 'Chronos'), fn: 'startTime' },
      { c: contractOf(st, 'Chronos'), fn: 'epochLength' },
      { c: contractOf(st, 'Chronos'), fn: 'getCurrentEpoch' },
      { c: contractOf(st, 'QueryInferenceStorage'), fn: 'activationEpoch' },
      { c: contractOf(st, 'QueryInferenceStorage'), fn: 'lambdaBps' },
      { c: contractOf(st, 'QueryInferenceStorage'), fn: 'paused' },
      { c: contractOf(st, 'ParametersStorage'), fn: 'maxOperatorFee' },
      { c: contractOf(st, 'ParametersStorage'), fn: 'maximumStake' },
    ],
    pin.blockHex,
  );
  if (start === null || length === null || epoch === null) throw new Error('Chronos did not answer');
  st.clock = {
    startTime: Number(start),
    epochLength: Number(length),
    currentEpoch: Number(epoch),
    activationEpoch: activation === null ? null : Number(activation),
    block: pin.number,
    blockTime: pin.timestamp,
  };
  st.params = {
    lambdaBps: lambda === null ? null : Number(lambda),
    paused: !!paused,
    maxOperatorFee: maxFee === null ? '10000' : maxFee.toString(),
    maximumStake: maxStake === null ? null : maxStake.toString(),
  };
}

// ------------------------------------------------------------------ events

const LOG_CONTRACTS = [
  { name: 'QueryInferenceSettlement', txs: true },
  { name: 'ServiceSubscriptions', txs: true },
  { name: 'ServiceSubscriptionsWallet', txs: true },
  { name: 'StakingV10', topicEvent: 'RewardsClaimed' },
];

const KEEP = new Set(['ReceiptsLanded', 'ReceiptBatchAccepted', 'SubscriptionFunded', 'SubscriptionToppedUp', 'BuyerAdded', 'BuyerRemoved', 'BuyerLimitsUpdated', 'ServiceSpendingSet', 'RewardsClaimed']);

async function readEvents(source, st, pub, rpc) {
  const clock = st.clock;
  const fullScan = st.fullScanEpoch !== clock?.currentEpoch || st.needFullScan === true;
  const seen = new Set(st.logs.map((l) => `${l.tx}:${l.idx}`));
  let added = 0;
  for (const { name, txs: wantTxs, topicEvent } of LOG_CONTRACTS) {
    for (const address of st.addresses[name] ?? []) {
      const iface = IFACES[HUB_NAMES[name]];
      const logKey = `${address}:logs`;
      const since = fullScan ? 0 : Math.max(0, (st.cursors[logKey] ?? 0) - OVERLAP_BLOCKS);
      const topic = topicEvent ? iface.getEvent(topicEvent).topicHash : null;
      const raws = await source.logs(address, { sinceBlock: since, topic });
      for (const raw of raws) {
        st.cursors[logKey] = Math.max(st.cursors[logKey] ?? 0, raw.block);
        const key = `${raw.tx}:${raw.idx}`;
        if (seen.has(key)) continue;
        const decoded = decodeLog(iface, raw);
        if (!decoded || !KEEP.has(decoded.k)) continue;
        seen.add(key);
        st.logs.push(decoded);
        added++;
      }
      if (!wantTxs) continue;
      const txKey = `${address}:txs`;
      const txSince = fullScan ? 0 : Math.max(0, (st.cursors[txKey] ?? 0) - OVERLAP_BLOCKS);
      const list = await source.txs(address, { sinceBlock: txSince });
      for (const t of list) {
        st.cursors[txKey] = Math.max(st.cursors[txKey] ?? 0, t.block);
        if (t.to !== address) continue;
        const keepAll = name === 'QueryInferenceSettlement';
        if (!keepAll && t.ok) continue;
        if (st.txs[t.hash] && !(st.txs[t.hash].ok === false && !st.txs[t.hash].revert)) continue;
        const groups = decodeBatchInput(t.input);
        const record = { ok: t.ok, from: t.from, to: t.to, at: t.at, block: t.block, position: t.position, fn: functionName(t.input), groups };
        if (!t.ok) record.revert = await revertOf(t, source, rpc);
        st.txs[t.hash] = record;
      }
    }
  }
  st.logs.sort((a, b) => a.block - b.block || a.idx - b.idx);
  if (fullScan) {
    st.fullScanEpoch = clock?.currentEpoch ?? null;
    st.needFullScan = false;
  }
  return added;
}

/** A reverted transaction's reason, however it can be had; null means the chain's record alone says it reverted. */
async function revertOf(t, source, rpc) {
  let hex = revertHexOf(t.revert);
  if (!hex) {
    try {
      hex = revertHexOf(await source.revertOf(t.hash));
    } catch {
      hex = null;
    }
  }
  if (!hex) {
    try {
      await rpc.call('eth_call', [{ from: t.from, to: t.to, data: t.input }, `0x${(t.block - 1).toString(16)}`]);
    } catch (e) {
      if (typeof e.rpcData === 'string') hex = e.rpcData;
    }
  }
  return decodeRevert(hex, FAULTS);
}

// ------------------------------------------------------------------ views

const str = (x) => (x === null || x === undefined ? null : x.toString());

/** A view an epoch's numbers can't do without: if it fails, the epoch stays out of the final cache and is read again. */
const required = (rec, put) => (r) => {
  if (r === null) rec.incomplete = true;
  else put(r);
};

async function readEpochs(rpc, st, pub, pin) {
  const clock = st.clock;
  const QIS = contractOf(st, 'QueryInferenceStorage');
  const QS = contractOf(st, 'QueryInferenceSettlement');
  const SSS = contractOf(st, 'ServiceSubscriptionsStorage');
  const SS = contractOf(st, 'ServiceSubscriptions');
  const KPI = contractOf(st, 'StakingKPI');
  const RSS = contractOf(st, 'RandomSamplingStorage');
  const ES = contractOf(st, 'EpochStorageV8');
  const CSS = contractOf(st, 'ConvictionStakingStorage');
  const PS = contractOf(st, 'ProfileStorage');
  const IDS = contractOf(st, 'IdentityStorage');

  const current = clock.currentEpoch;
  const first = Number(pub?.firstEpoch ?? clock.activationEpoch ?? current);
  const sellers = new Set((pub?.sellers ?? []).map((s) => Number(s.identityId)));
  const buyers = new Set((pub?.buyers ?? []).map((b) => b.address?.toLowerCase()).filter(Boolean));
  const accounts = new Map();
  for (const b of pub?.buyers ?? []) {
    if (b.address && b.accountId) accounts.set(b.address.toLowerCase(), String(b.accountId));
  }
  for (const l of st.logs) {
    if (l.a?.seller !== undefined) sellers.add(Number(l.a.seller));
    if (l.a?.buyer) buyers.add(l.a.buyer);
    if (l.a?.buyer && l.a.accountId && l.a.accountId !== '0') accounts.set(l.a.buyer, l.a.accountId);
  }
  const sellerList = [...sellers];

  // Every epoch from the first to the next one, the next for what is funded ahead.
  const epochs = [];
  for (let e = first; e <= Math.max(current, first) + 1; e++) epochs.push(e);

  const live = {};
  const final = {};
  const calls = [];
  const at = (fn) => {
    calls.push(fn);
  };
  for (const e of epochs) {
    const known = st.final[e];
    const startsNext = startOf(e + 1, clock);
    const isFinal = pin.timestamp >= startsNext + FINAL_MARGIN_SECONDS;
    const rec = known ? structuredClone(known) : { epoch: e, sellers: {}, subs: {} };
    (isFinal ? final : live)[e] = rec;

    if (!known) {
      at({ c: QIS, fn: 'fundingIn', args: [e], put: required(rec, (r) => { rec.wallet = str(r[0]); rec.account = str(r[1]); }) });
      at({ c: QIS, fn: 'getEpochTotals', args: [e], put: required(rec, (r) => { rec.served = str(r.totalServed); rec.weighted = str(r.totalWeighted); rec.lambdaBps = Number(r.lambdaBps); }) });
      at({ c: QS, fn: 'epochPool', args: [e], put: required(rec, (r) => { rec.pool = str(r); }) });
      at({ c: ES, fn: 'getEpochPool', args: [1, e], put: required(rec, (r) => { rec.publishingPool = str(r); }) });
      at({ c: RSS, fn: 'getAllNodesEpochScore', args: [e], put: required(rec, (r) => { rec.allNodesScore = str(r); }) });
    }
    const endTs = startsNext - 1;
    for (const id of sellerList) {
      if (rec.sellers[id]) continue;
      const n = (rec.sellers[id] = {});
      at({ c: QIS, fn: 'getNodeEpoch', args: [id, e], put: required(rec, (r) => { n.served = str(r.servedValue); n.weighted = str(r.weightedValue); }) });
      at({ c: QS, fn: 'queryInferenceGross', args: [e, id], put: required(rec, (r) => { n.gross = str(r); }) });
      at({ c: RSS, fn: 'getNodeEpochScore', args: [e, id], put: required(rec, (r) => { n.nodeScore = str(r); }) });
      at({ c: RSS, fn: 'getEpochNodeValidProofsCount', args: [e, id], put: (r) => { n.proofs = str(r); } });
      at({ c: PS, fn: 'getOperatorFeePercentageByTimestampReverse', args: [id, endTs], put: (r) => { n.feeBps = str(r); } });
      at({ c: KPI, fn: 'getNetNodeRewards', args: [id, e], put: (r) => { n.net = str(r); } });
    }
    for (const buyer of buyers) {
      if (rec.subs[buyer] !== undefined) continue;
      const id = subscriptionIdOf(buyer, e).toLowerCase();
      at({
        c: SSS,
        fn: 'getSubscription',
        args: [id],
        put: (s) => {
          if (s === null) {
            rec.incomplete = true;
            return;
          }
          if (Number(s.startsAt) === 0) {
            rec.subs[buyer] = null;
            return;
          }
          rec.subs[buyer] = {
            id,
            accountId: str(s.accountId),
            buyer: s.buyer.toLowerCase(),
            grantNonce: str(s.grantNonce),
            epoch: Number(s.epoch),
            startsAt: Number(s.startsAt),
            endsAt: Number(s.endsAt),
            fundedEpoch: Number(s.fundedEpoch),
            discountBps: Number(s.discountBps),
            budgetCount: Number(s.budgetCount),
            value: str(s.value),
            cost: str(s.cost),
            spentFromWindow: str(s.spentFromWindow),
            spentFromTopUp: str(s.spentFromTopUp),
            budgets: [],
          };
        },
      });
    }
    // Which sellers' splits a claim has made so far: never cached until it is true.
    for (const id of sellerList) {
      if (st.split[`${id}:${e}`]) continue;
      at({ c: CSS, fn: 'isOperatorFeeClaimedForEpoch', args: [id, e], put: (r) => { if (r) st.split[`${id}:${e}`] = true; } });
    }
  }
  await runCalls(rpc, calls, pin);

  // The budgets of the subscriptions just found, and what each has used.
  const budgetCalls = [];
  for (const rec of [...Object.values(live), ...Object.values(final)]) {
    for (const s of Object.values(rec.subs)) {
      if (!s || s.budgets.length) continue;
      budgetCalls.push({
        c: SSS,
        fn: 'getBudgets',
        args: [s.id],
        put: required(rec, (r) => {
          s.budgets = [...r].map((b) => ({ serviceId: b.serviceId.toLowerCase(), serviceClass: Number(b.serviceClass), value: str(b.value), maxPricePerUnit: str(b.maxPricePerUnit) }));
        }),
      });
    }
  }
  await runCalls(rpc, budgetCalls, pin);
  const usedCalls = [];
  for (const rec of [...Object.values(live), ...Object.values(final)]) {
    for (const s of Object.values(rec.subs)) {
      if (!s) continue;
      s.budgets.forEach((b, i) => {
        if (b.used !== undefined) return;
        usedCalls.push({ c: QIS, fn: 'budgetUsed', args: [s.id, i], put: required(rec, (r) => { b.used = str(r); }) });
      });
    }
  }
  await runCalls(rpc, usedCalls, pin);

  // What is never final: the sellers' stake now, the grants, the positions behind claims, who sent a refused batch.
  const sellersLive = {};
  const buyersLive = {};
  const liveCalls = [];
  for (const id of sellerList) {
    const row = (sellersLive[id] = {});
    liveCalls.push({ c: PS, fn: 'getName', args: [id], put: (r) => { row.name = r ?? null; } });
    liveCalls.push({ c: QS, fn: 'stakeFactor', args: [id], put: (r) => { row.factor18 = str(r); } });
    liveCalls.push({ c: CSS, fn: 'getNodeEffectiveStake', args: [id], put: (r) => { row.stake = str(r); } });
  }
  for (const [buyer, accountId] of accounts) {
    const row = (buyersLive[buyer] = {});
    liveCalls.push({
      c: SSS,
      fn: 'getGrant',
      args: [accountId, buyer],
      put: (g) => {
        row.grant = g && Number(g.grantedAt) !== 0 ? { maxCostPerEpoch: str(g.maxCostPerEpoch), grantedAt: Number(g.grantedAt), expiresAt: Number(g.expiresAt), revokedAt: Number(g.revokedAt), nonce: str(g.nonce), owner: g.owner.toLowerCase() } : null;
      },
    });
    liveCalls.push({ c: SSS, fn: 'getUsage', args: [accountId, buyer], put: (u) => { row.usage = u ? Number(u.subscriptions ?? u) : null; } });
    liveCalls.push({ c: SSS, fn: 'buyerCount', args: [accountId], put: (n) => { row.buyerCount = n === null ? null : Number(n); } });
    liveCalls.push({
      c: SS,
      fn: 'currentWindowAllowance',
      args: [accountId],
      put: (r) => {
        row.allowance = r ? { window: Number(r[0]), baseRemaining: str(r[1]), topUpBuffer: str(r[2]), expired: !!r[3] } : null;
      },
    });
  }
  for (const l of st.logs) {
    if (l.k === 'RewardsClaimed' && st.positions[l.a.tokenId] === undefined) {
      liveCalls.push({ c: CSS, fn: 'getPosition', args: [l.a.tokenId], put: (p) => { if (p) st.positions[l.a.tokenId] = Number(p.identityId); } });
    }
  }
  for (const t of Object.values(st.txs)) {
    if (t.ok !== false || !t.from || st.operators[t.from] !== undefined) continue;
    liveCalls.push({ c: IDS, fn: 'getIdentityId', args: [t.from], put: (r) => { if (r !== null) st.operators[t.from] = Number(r); } });
  }
  await runCalls(rpc, liveCalls, pin);

  // Nothing above threw, so it replaces the last good read as one. An epoch a
  // required view failed for stays live, and a final one keeps what it had.
  for (const [e, rec] of Object.entries(final)) {
    if (rec.incomplete) {
      delete rec.incomplete;
      if (!st.final[e]) live[e] = rec;
      delete final[e];
    }
  }
  st.live = live;
  st.final = { ...st.final, ...final };
  st.sellersLive = sellersLive;
  st.buyersLive = buyersLive;
}

async function runCalls(rpc, calls, pin) {
  if (!calls.length) return;
  const answers = await rpc.readAll(calls, pin.blockHex);
  calls.forEach((c, i) => c.put(answers[i]));
}

// ------------------------------------------------------------------ one run

async function main() {
  ensureDirs();
  const startedAt = Date.now();
  const st = readJson(paths.cache) ?? emptyState();
  const stats = {};
  const errors = [];
  const rpc = new Rpc(config.rpcUrls, { stats });
  const source = config.blockscout === 'node' ? new NodeSource(rpc, config.nodeLogsFrom) : new BlockscoutSource(config.blockscout, { stats });

  const { pub, source: publicSource, at: publicAt } = await loadPublic();

  let pin = null;
  let rpcOk = false;
  try {
    pin = await rpc.pinnedBlock(config.pinLag);
    await resolveContracts(rpc, st, pin.blockHex);
    await readClock(rpc, st, pin);
    rpcOk = true;
  } catch (e) {
    errors.push(`RPC: ${e.message}`);
    log(`rpc failed: ${e.message}`);
  }

  // Events need the addresses: from this run, or the last that had them.
  let eventsOk = false;
  let explorerHead = null;
  if (Object.keys(st.addresses).length) {
    try {
      const added = await readEvents(source, st, pub, rpc);
      explorerHead = await source.head();
      eventsOk = true;
      if (added) log(`events: ${added} new, ${st.logs.length} held`);
    } catch (e) {
      errors.push(`Explorer: ${e.message}`);
      log(`explorer failed: ${e.message}`);
    }
  } else errors.push('Explorer: not read, the contract addresses are not known yet');

  if (rpcOk) {
    try {
      await readEpochs(rpc, st, pub, pin);
    } catch (e) {
      rpcOk = false;
      errors.push(`RPC: ${e.message}`);
      log(`views failed: ${e.message}`);
    }
  }

  const now = nowSeconds();
  if (rpcOk) st.lastOk.rpc = now;
  if (eventsOk) st.lastOk.events = now;
  const headBlock = st.clock?.block ?? null;
  const status = {
    stale: !rpcOk || !eventsOk,
    errors,
    rpc: { ok: rpcOk, lastOkAt: st.lastOk.rpc ?? null, block: st.clock?.block ?? null, blockTime: st.clock?.blockTime ?? null },
    events: {
      ok: eventsOk,
      lastOkAt: st.lastOk.events ?? null,
      head: explorerHead?.block ?? st.lastEvents?.head ?? null,
      lagBlocks: explorerHead && headBlock ? Math.max(0, headBlock - explorerHead.block) : (st.lastEvents?.lagBlocks ?? null),
    },
    public: { source: publicSource, at: publicAt },
    run: { ms: Date.now() - startedAt, ...stats },
  };
  if (eventsOk) st.lastEvents = { head: status.events.head, lagBlocks: status.events.lagBlocks };

  const network = { chainId: config.chainId, hub: config.hub, explorer: config.explorer, blockscout: config.blockscout === 'node' ? null : config.blockscout, rpc: config.rpcUrls[0] };
  const data = compose({ state: st, pub, status, now, network });

  // A cross-check that fails against the events asks for a full scan next time: a block may have been indexed late.
  if (eventsOk && data.status.eventsBehind) st.needFullScan = true;

  writeAtomic(paths.cache, JSON.stringify(st));
  writeAtomic(paths.data, JSON.stringify(data));
  log(`done in ${Date.now() - startedAt} ms: block ${st.clock?.block ?? '?'}, epoch ${st.clock?.currentEpoch ?? '?'}, ${errors.length ? `errors: ${errors.join('; ')}` : 'no errors'}, ${stats.rpcCalls ?? 0} RPC and ${stats.explorerCalls ?? 0} explorer calls`);
}

main().catch((e) => {
  log(`fatal: ${e.stack ?? e.message}`);
  process.exitCode = 1;
});
