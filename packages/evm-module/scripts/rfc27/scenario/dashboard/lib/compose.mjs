// Turns what the indexer read from the chain into the page's data.json. It only
// computes: no network, no files, no clock but the one it is given, so the same
// code runs over a real read and over a generated fixture.
//
// All TRAC amounts stay in wei, as decimal strings, and every sum is a BigInt.
// Shares are floats, because only people read them. The cross-checks at the end
// compare what the views say with what the events say.

const BPS = 10_000n;
const SCALE18 = 10n ** 18n;
const FEED_CAP = 300;

const big = (x) => (x === undefined || x === null || x === '' ? 0n : BigInt(x));
const str = (x) => x.toString();
const low = (a) => String(a ?? '').toLowerCase();
const ratio = (a, b, digits = 6) => (b === 0n ? 0 : Number((a * 10n ** BigInt(digits + 2)) / b) / 10 ** (digits + 2));
const sum = (xs) => xs.reduce((a, x) => a + big(x), 0n);

export const FAULTS = [
  'None',
  'UnknownSubscription',
  'UnknownBudget',
  'OutsideEpoch',
  'EmptyGroup',
  'BelowMinCounted',
  'BadSignature',
  'InactiveGrant',
  'DuplicateNonce',
  'OutsideTime',
  'PriceOutOfRange',
  'BadArithmetic',
  'ZeroResultCommitment',
];

export const epochOf = (ts, clock) => (ts < clock.startTime ? 1 : Math.floor((ts - clock.startTime) / clock.epochLength) + 1);
export const startOf = (e, clock) => clock.startTime + (e - 1) * clock.epochLength;

/** "12:30" as seconds into a day; null if it isn't a time. */
function secondsOfDay(hhmm) {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(hhmm ?? '').trim());
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3] ?? 0);
}

/** A scheduled event's kind, in the few classes the page can check against the chain. */
export function classifyKind(kind) {
  const k = low(kind);
  if (/baseline|normal|ordinary/.test(k)) return 'baseline';
  if (/top.?up/.test(k)) return 'top-up';
  if (/remov|revok/.test(k)) return 'buyer-removed';
  if (/add/.test(k)) return 'buyer-added';
  if (/race|contend|compet/.test(k)) return 'race';
  if (/held|hold|deadline|late|miss/.test(k)) return 'missed-deadline';
  if (/empty|only|roll|no.?serv/.test(k)) return 'funding-only';
  return 'other';
}

function indexPublic(pub) {
  const buyerByAddr = new Map();
  const buyerByName = new Map();
  for (const b of pub?.buyers ?? []) {
    if (b.address) buyerByAddr.set(low(b.address), b);
    if (b.name) buyerByName.set(low(b.name), b);
  }
  const sellerById = new Map();
  const sellerByName = new Map();
  for (const s of pub?.sellers ?? []) {
    sellerById.set(Number(s.identityId), s);
    if (s.name) sellerByName.set(low(s.name), s);
  }
  const serviceById = new Map();
  for (const s of pub?.services ?? []) serviceById.set(low(s.serviceId), s);
  return { buyerByAddr, buyerByName, sellerById, sellerByName, serviceById };
}

const shortHex = (h) => (h ? `${h.slice(0, 6)}…${h.slice(-4)}` : '?');

export function compose({ state, pub, status, now, network }) {
  const clock = state.clock ?? null;
  const params = state.params ?? {};
  if (!clock) {
    return { schema: 1, generatedAt: now, status, network, contracts: state.contracts ?? {}, clock: null, params, sellers: [], buyers: [], services: [], epochs: [], feed: [], scenario: [], claims: [], checks: [] };
  }

  const idx = indexPublic(pub);
  const logs = [...(state.logs ?? [])].sort((a, b) => a.block - b.block || a.idx - b.idx);
  const txs = state.txs ?? {};
  const activation = clock.activationEpoch || null;
  const firstEpoch = Number(pub?.firstEpoch ?? activation ?? clock.currentEpoch);
  const current = clock.currentEpoch;
  const lastListed = Math.max(current, firstEpoch);
  const rawOf = (e) => state.final?.[e] ?? state.live?.[e] ?? null;

  // Subscriptions: what the views hold, and what the events say first.
  const subIndex = new Map();
  for (const l of logs) {
    if (l.k === 'SubscriptionFunded') {
      subIndex.set(low(l.a.subscriptionId), { buyer: low(l.a.buyer), epoch: Number(l.a.epoch), accountId: l.a.accountId, discountBps: Number(l.a.discountBps), budgets: l.a.budgets ?? [] });
    }
  }
  const rawEpochNumbers = [...new Set([...Object.keys(state.final ?? {}), ...Object.keys(state.live ?? {})].map(Number))];
  for (const e of rawEpochNumbers) {
    for (const s of Object.values(rawOf(e)?.subs ?? {})) {
      if (!s) continue;
      subIndex.set(low(s.id), { buyer: low(s.buyer), epoch: Number(s.epoch), accountId: s.accountId, discountBps: Number(s.discountBps), budgets: s.budgets ?? [] });
    }
  }
  const serviceOfBudget = (subId, i) => subIndex.get(low(subId))?.budgets?.[i]?.serviceId;

  // ------------------------------------------------------------------ who is who

  const sellerIds = new Set();
  for (const s of pub?.sellers ?? []) sellerIds.add(Number(s.identityId));
  for (const l of logs) if (l.k === 'ReceiptsLanded' || l.k === 'ReceiptBatchAccepted') sellerIds.add(Number(l.a.seller));
  const liveSellers = state.sellersLive ?? {};
  const sellers = [...sellerIds].map((id) => {
    const p = idx.sellerById.get(id);
    const live = liveSellers[id] ?? {};
    return {
      id,
      name: live.name || p?.name || `node ${id}`,
      address: p?.address ?? null,
      listed: !!p,
      stake: live.stake ?? null,
      factor18: live.factor18 ?? null,
    };
  });
  const orderOf = (id) => {
    const i = (pub?.sellers ?? []).findIndex((s) => Number(s.identityId) === id);
    return i < 0 ? 1000 + id : i;
  };
  sellers.sort((a, b) => orderOf(a.id) - orderOf(b.id));
  const sellerName = (id) => sellers.find((s) => s.id === Number(id))?.name ?? `node ${id}`;

  const buyerAddrs = new Set();
  for (const b of pub?.buyers ?? []) if (b.address) buyerAddrs.add(low(b.address));
  for (const l of logs) {
    if (l.a?.buyer) buyerAddrs.add(low(l.a.buyer));
  }
  const liveBuyers = state.buyersLive ?? {};
  const buyers = [...buyerAddrs].map((addr) => {
    const p = idx.buyerByAddr.get(addr);
    const accountEvent = [...logs].reverse().find((l) => low(l.a?.buyer) === addr && l.a?.accountId && l.a.accountId !== '0');
    const accountId = p?.accountId ?? accountEvent?.a?.accountId ?? null;
    const live = liveBuyers[addr] ?? {};
    const removed = [...logs].reverse().find((l) => l.k === 'BuyerRemoved' && low(l.a.buyer) === addr);
    return {
      address: addr,
      name: p?.name ?? shortHex(addr),
      listed: !!p,
      pays: accountId && String(accountId) !== '0' ? 'account' : p?.pays ?? 'wallet',
      accountId: accountId === null ? null : String(accountId),
      owner: p?.owner ?? null,
      home: p?.home ?? null,
      grant: live.grant ?? null,
      usage: live.usage ?? null,
      buyersOnAccount: live.buyerCount ?? null,
      allowance: live.allowance ?? null,
      removedAt: removed?.at ?? null,
      removedTx: removed?.tx ?? null,
    };
  });
  const buyerOrder = (a) => {
    const i = (pub?.buyers ?? []).findIndex((b) => low(b.address) === a);
    return i < 0 ? 1000 : i;
  };
  buyers.sort((a, b) => buyerOrder(a.address) - buyerOrder(b.address));
  const buyerName = (addr) => idx.buyerByAddr.get(low(addr))?.name ?? shortHex(addr);

  const serviceIds = new Set();
  for (const s of pub?.services ?? []) serviceIds.add(low(s.serviceId));
  for (const s of subIndex.values()) for (const b of s.budgets) serviceIds.add(low(b.serviceId));
  const classOf = new Map();
  for (const s of subIndex.values()) for (const b of s.budgets) classOf.set(low(b.serviceId), Number(b.serviceClass));
  const services = [...serviceIds].map((id) => {
    const p = idx.serviceById.get(id);
    const cls = Number(p?.serviceClass ?? classOf.get(id) ?? 0);
    return {
      id,
      label: p?.label ?? shortHex(id),
      listed: !!p,
      cls,
      unit: p?.unit ?? (cls === 1 ? 'token' : cls === 2 ? 'query unit' : 'unit'),
    };
  });
  const serviceOrder = (id) => {
    const i = (pub?.services ?? []).findIndex((s) => low(s.serviceId) === id);
    return i < 0 ? 1000 : i;
  };
  services.sort((a, b) => serviceOrder(a.id) - serviceOrder(b.id));
  const serviceLabel = (id) => services.find((s) => s.id === low(id))?.label ?? shortHex(id);

  // ------------------------------------------------------------------ landed groups, joined with their calldata

  const groupSeen = new Map();
  const landed = [];
  for (const l of logs) {
    if (l.k !== 'ReceiptsLanded') continue;
    const n = groupSeen.get(l.tx) ?? 0;
    groupSeen.set(l.tx, n + 1);
    const call = txs[l.tx]?.groups?.[n];
    const sameGroup = call && low(call.sub) === low(l.a.subscriptionId) && Number(call.budget) === Number(l.a.budgetIndex);
    const sub = subIndex.get(low(l.a.subscriptionId));
    const counted = big(l.a.counted);
    const servedPart = (counted * (BPS - BigInt(sub?.discountBps ?? 0))) / BPS;
    const weightedPart = (servedPart * big(l.a.stakeFactor18)) / SCALE18;
    landed.push({
      l,
      epoch: epochOf(l.at, clock),
      seller: Number(l.a.seller),
      sub: low(l.a.subscriptionId),
      budget: Number(l.a.budgetIndex),
      service: serviceOfBudget(l.a.subscriptionId, Number(l.a.budgetIndex)) ?? null,
      buyer: sub?.buyer ?? null,
      receipts: Number(l.a.itemCount),
      units: sameGroup ? big(call.units) : null,
      minCounted: sameGroup ? call.minCounted : null,
      value: big(l.a.value),
      counted,
      served: servedPart,
      weighted: weightedPart,
    });
  }

  // ------------------------------------------------------------------ epochs

  const epochNumbers = [];
  for (let e = firstEpoch; e <= lastListed; e++) epochNumbers.push(e);
  const ahead = rawOf(current + 1);
  if (ahead && big(ahead.wallet) + big(ahead.account) > 0n && !epochNumbers.includes(current + 1)) epochNumbers.push(current + 1);

  const maxFee = big(params.maxOperatorFee ?? 10000);
  let waiting = 0n;
  const epochs = epochNumbers.map((e) => {
    const raw = rawOf(e) ?? {};
    const startsAt = startOf(e, clock);
    const endsAt = startOf(e + 1, clock);
    const state_ = e < current ? 'ended' : e === current ? 'current' : e === firstEpoch && current < firstEpoch ? 'upcoming' : 'ahead';
    const wallet = big(raw.wallet);
    const account = big(raw.account);
    const money = wallet + account;
    const served = big(raw.served);
    const weighted = big(raw.weighted);
    const pool = big(raw.pool);
    const waitingBefore = waiting;
    const hasValue = served > 0n;
    const rolledIn = hasValue && pool > money ? pool - money : 0n;
    if (hasValue) waiting = 0n;
    else if (state_ === 'ended' || state_ === 'current') waiting = waitingBefore + money;
    const projectedPool = hasValue ? pool : waitingBefore + money;
    const unused = money > served ? money - served : 0n;
    const publishingPool = big(raw.publishingPool);
    const allScore = big(raw.allNodesScore);

    const sellerRows = sellers.map((s) => {
      const n = raw.sellers?.[s.id] ?? {};
      const sServed = big(n.served);
      const sWeighted = big(n.weighted);
      const gross = big(n.gross);
      const nodeScore = big(n.nodeScore);
      const publishing = allScore > 0n ? (publishingPool * nodeScore) / allScore : 0n;
      const total = publishing + gross;
      const feeBps = big(n.feeBps);
      const fee = (total * feeBps) / maxFee;
      const net = n.net !== undefined && n.net !== null ? big(n.net) : total - fee;
      const salesPart = served > 0n ? (pool * sServed) / served : 0n;
      const stakePart = gross - salesPart;
      const here = landed.filter((g) => g.epoch === e && g.seller === s.id);
      return {
        id: s.id,
        served: str(sServed),
        weighted: str(sWeighted),
        factor18: sServed > 0n ? str((sWeighted * SCALE18) / sServed) : null,
        salesShare: ratio(sServed, served),
        weightedShare: ratio(sWeighted, weighted),
        qifShare: ratio(gross, pool),
        gross: str(gross),
        salesPart: str(salesPart),
        stakePart: str(stakePart),
        nodeScore: str(nodeScore),
        proofs: n.proofs === undefined ? null : Number(n.proofs),
        scoreShare: ratio(nodeScore, allScore),
        publishing: str(publishing),
        feeBps: Number(feeBps),
        fee: str(fee),
        net: str(net),
        splitDone: !!state.split?.[`${s.id}:${e}`],
        batches: new Set(here.map((g) => g.l.tx)).size,
        receipts: here.reduce((a, g) => a + g.receipts, 0),
      };
    });

    const subRows = Object.values(raw.subs ?? {})
      .filter(Boolean)
      .map((s) => {
        const topUps = logs.filter((l) => l.k === 'SubscriptionToppedUp' && low(l.a.subscriptionId) === low(s.id)).map((l) => ({ at: l.at, tx: l.tx, value: l.a.value, cost: l.a.cost }));
        const fundedLog = logs.find((l) => l.k === 'SubscriptionFunded' && low(l.a.subscriptionId) === low(s.id));
        const budgets = (s.budgets ?? []).map((b, i) => {
          const groups = landed.filter((g) => g.sub === low(s.id) && g.budget === i);
          const bySeller = new Map();
          for (const g of groups) bySeller.set(g.seller, (bySeller.get(g.seller) ?? 0n) + g.counted);
          return {
            index: i,
            service: low(b.serviceId),
            cls: Number(b.serviceClass),
            value: b.value,
            maxPrice: b.maxPricePerUnit,
            used: b.used ?? '0',
            usedShare: ratio(big(b.used), big(b.value)),
            bySeller: [...bySeller].map(([id, counted]) => ({ id, counted: str(counted) })),
          };
        });
        const used = sum(budgets.map((b) => b.used));
        return {
          id: s.id,
          buyer: low(s.buyer),
          accountId: String(s.accountId),
          discountBps: Number(s.discountBps),
          value: s.value,
          cost: s.cost,
          used: str(used),
          usedShare: ratio(used, big(s.value)),
          startsAt: Number(s.startsAt),
          endsAt: Number(s.endsAt),
          fundedEpoch: Number(s.fundedEpoch),
          fundedAt: fundedLog?.at ?? null,
          fundedTx: fundedLog?.tx ?? null,
          budgets,
          topUps,
        };
      })
      .sort((a, b) => buyerOrder(a.buyer) - buyerOrder(b.buyer));

    const here = landed.filter((g) => g.epoch === e);
    const serviceRows = services
      .map((svc) => {
        const budgetsOf = subRows.flatMap((s) => s.budgets.filter((b) => b.service === svc.id));
        const groups = here.filter((g) => low(g.service) === svc.id);
        const rollup = (gs) => {
          const known = gs.filter((g) => g.units !== null);
          const knownUnits = known.reduce((a, g) => a + g.units, 0n);
          const knownValue = known.reduce((a, g) => a + g.value, 0n);
          return {
            receipts: gs.reduce((a, g) => a + g.receipts, 0),
            units: str(knownUnits),
            unitsComplete: known.length === gs.length,
            value: str(gs.reduce((a, g) => a + g.value, 0n)),
            counted: str(gs.reduce((a, g) => a + g.counted, 0n)),
            served: str(gs.reduce((a, g) => a + g.served, 0n)),
            weighted: str(gs.reduce((a, g) => a + g.weighted, 0n)),
            avgPrice: knownUnits > 0n ? str(knownValue / knownUnits) : null,
          };
        };
        return {
          service: svc.id,
          budget: str(sum(budgetsOf.map((b) => b.value))),
          used: str(sum(budgetsOf.map((b) => b.used))),
          ...rollup(groups),
          bySeller: sellers.map((s) => ({ id: s.id, ...rollup(groups.filter((g) => g.seller === s.id)) })).filter((r) => r.receipts > 0),
        };
      })
      .filter((r) => big(r.budget) > 0n || r.receipts > 0);

    const batchLogs = logs.filter((l) => l.k === 'ReceiptBatchAccepted' && epochOf(l.at, clock) === e);
    const refused = Object.entries(txs).filter(([, t]) => t.ok === false && t.fn === 'submitReceiptBatch' && epochOf(t.at, clock) === e);

    return {
      epoch: e,
      startsAt,
      endsAt,
      state: state_,
      final: !!state.final?.[e],
      wallet: str(wallet),
      account: str(account),
      money: str(money),
      served: str(served),
      weighted: str(weighted),
      lambdaBps: hasValue ? Number(raw.lambdaBps ?? 0) : null,
      pool: str(pool),
      projectedPool: str(projectedPool),
      rolledIn: str(rolledIn),
      waitingBefore: str(waitingBefore),
      waitingAfter: str(waiting),
      unused: str(unused),
      unusedShare: ratio(unused, money),
      publishingPool: str(publishingPool),
      allNodesScore: str(allScore),
      budgetValue: str(sum(subRows.map((s) => s.value))),
      budgetUsed: str(sum(subRows.map((s) => s.used))),
      batches: batchLogs.length,
      groups: here.length,
      receipts: batchLogs.reduce((a, l) => a + Number(l.a.itemCount), 0),
      landedValue: str(here.reduce((a, g) => a + g.value, 0n)),
      counted: str(here.reduce((a, g) => a + g.counted, 0n)),
      partials: here.filter((g) => g.counted < g.value).length,
      refused: refused.length,
      buyerEvents: logs
        .filter((l) => (l.k === 'BuyerRemoved' || l.k === 'BuyerAdded') && epochOf(l.at, clock) === e)
        .map((l) => ({ t: l.k === 'BuyerRemoved' ? 'removed' : 'added', buyer: low(l.a.buyer), at: l.at, tx: l.tx })),
      firstBatchAt: batchLogs[0]?.at ?? null,
      lastBatchAt: batchLogs[batchLogs.length - 1]?.at ?? null,
      sellers: sellerRows,
      subs: subRows,
      services: serviceRows,
    };
  });

  // ------------------------------------------------------------------ feed

  // One row per batch, which is one transaction, with the groups inside it.
  const feed = [];
  const batchRows = new Map();
  for (const g of landed) {
    let row = batchRows.get(g.l.tx);
    if (!row) {
      row = { t: 'batch', at: g.l.at, block: g.l.block, idx: g.l.idx, tx: g.l.tx, seller: g.seller, receipts: 0, value: 0n, counted: 0n, partial: false, factor18: g.l.a.stakeFactor18, groups: [] };
      batchRows.set(g.l.tx, row);
      feed.push(row);
    }
    row.receipts += g.receipts;
    row.value += g.value;
    row.counted += g.counted;
    row.partial ||= g.counted < g.value;
    row.groups.push({ buyer: g.buyer, service: g.service ? low(g.service) : null, receipts: g.receipts, value: str(g.value), counted: str(g.counted), partial: g.counted < g.value });
  }
  for (const row of batchRows.values()) {
    row.value = str(row.value);
    row.counted = str(row.counted);
  }
  for (const l of logs) {
    const base = { at: l.at, block: l.block, idx: l.idx, tx: l.tx };
    if (l.k === 'SubscriptionFunded') feed.push({ ...base, t: 'funded', buyer: low(l.a.buyer), epoch: Number(l.a.epoch), accountId: l.a.accountId, value: l.a.value, cost: l.a.cost, discountBps: Number(l.a.discountBps), budgets: (l.a.budgets ?? []).length });
    if (l.k === 'SubscriptionToppedUp') feed.push({ ...base, t: 'top-up', buyer: low(l.a.buyer), accountId: l.a.accountId, value: l.a.value, cost: l.a.cost });
    if (l.k === 'BuyerAdded') feed.push({ ...base, t: 'buyer-added', buyer: low(l.a.buyer), accountId: l.a.accountId, limit: l.a.maxCostPerEpoch, expiresAt: Number(l.a.expiresAt) });
    if (l.k === 'BuyerRemoved') feed.push({ ...base, t: 'buyer-removed', buyer: low(l.a.buyer), accountId: l.a.accountId });
    if (l.k === 'BuyerLimitsUpdated') feed.push({ ...base, t: 'limits', buyer: low(l.a.buyer), accountId: l.a.accountId, limit: l.a.maxCostPerEpoch, expiresAt: Number(l.a.expiresAt) });
    if (l.k === 'ServiceSpendingSet') feed.push({ ...base, t: 'spending', accountId: l.a.accountId, enabled: !!l.a.enabled });
    if (l.k === 'RewardsClaimed') {
      if (epochOf(l.at, clock) >= firstEpoch) feed.push({ ...base, t: 'claim', tokenId: l.a.tokenId, node: state.positions?.[l.a.tokenId] ?? null, amount: l.a.amount });
    }
  }
  const refusedRows = [];
  for (const [hash, t] of Object.entries(txs)) {
    if (t.ok !== false) continue;
    if (epochOf(t.at, clock) < firstEpoch) continue;
    const groups = (t.groups ?? []).map((g) => {
      const sub = subIndex.get(low(g.sub));
      return {
        buyer: sub?.buyer ?? null,
        subEpoch: sub?.epoch ?? null,
        service: serviceOfBudget(g.sub, Number(g.budget)) ? low(serviceOfBudget(g.sub, Number(g.budget))) : null,
        receipts: g.items,
        value: g.value,
      };
    });
    const seller = t.from ? state.operators?.[low(t.from)] ?? null : null;
    const row = {
      t: 'refused',
      at: t.at,
      block: t.block,
      idx: t.position ?? 0,
      tx: hash,
      fn: t.fn ?? null,
      from: t.from ?? null,
      seller: seller ? Number(seller) : null,
      fault: t.revert?.fault ?? t.revert?.name ?? null,
      faultInferred: !!t.revert?.inferred,
      groups,
      value: str(sum(groups.map((g) => g.value))),
    };
    const subEpoch = groups.map((g) => g.subEpoch).find((x) => x !== null && x !== undefined);
    if (subEpoch && epochOf(t.at, clock) > subEpoch) {
      row.lateBy = t.at - startOf(subEpoch + 1, clock);
      // An explorer does not always keep the revert data: the times alone say this one.
      if (!row.fault) {
        row.fault = 'OutsideEpoch';
        row.faultInferred = true;
      }
    }
    refusedRows.push(row);
    feed.push(row);
  }
  feed.sort((a, b) => b.at - a.at || b.block - a.block || b.idx - a.idx);

  // ------------------------------------------------------------------ claims

  const claims = logs
    .filter((l) => l.k === 'RewardsClaimed' && epochOf(l.at, clock) >= firstEpoch)
    .map((l) => ({ at: l.at, tx: l.tx, tokenId: l.a.tokenId, node: state.positions?.[l.a.tokenId] ?? null, amount: l.a.amount, epoch: epochOf(l.at, clock) }))
    .reverse();

  // ------------------------------------------------------------------ scheduled events against the chain

  const epochRow = (e) => epochs.find((x) => x.epoch === e);
  const scenario = (pub?.events ?? []).map((ev) => {
    const baseEpoch = Number(pub.firstEpoch ?? activation ?? firstEpoch);
    const e = baseEpoch + Number(ev.epochOffset ?? 0);
    const kind = classifyKind(ev.kind);
    const whoBuyer = idx.buyerByName.get(low(ev.who));
    const whoSeller = idx.sellerByName.get(low(ev.who));
    const secs = secondsOfDay(ev.atUtc);
    const scheduledAt = startOf(e, clock) + (secs ?? 0);
    const out = { epoch: e, epochOffset: Number(ev.epochOffset ?? 0), atUtc: ev.atUtc ?? null, scheduledAt, hasTime: secs !== null, kind: ev.kind ?? 'event', cls: kind, who: ev.who ?? null, note: ev.note ?? '', status: 'scheduled', parts: [] };
    const nowTs = clock.blockTime ?? now;
    const epochEnded = e < current;
    const epochRunning = e === current;
    const passed = nowTs >= scheduledAt;
    const pending = (waitingText) => {
      if (epochEnded) {
        out.status = 'not-seen';
        out.parts = [waitingText];
      } else if (epochRunning && passed) {
        out.status = 'waiting';
        out.parts = [waitingText];
      } else {
        out.status = 'scheduled';
        out.parts = [];
      }
    };
    const inEpoch = (l) => epochOf(l.at, clock) === e;
    const buyerAddr = whoBuyer ? low(whoBuyer.address) : null;
    const row = epochRow(e);

    if (kind === 'baseline') {
      if (row && (big(row.money) > 0n || row.batches > 0)) {
        out.status = epochRunning && row.batches === 0 ? 'waiting' : 'seen';
        out.parts.push(`${row.subs.length} buyer${row.subs.length === 1 ? '' : 's'} funded`, { wei: row.money }, `of money, and ${row.batches} batch${row.batches === 1 ? '' : 'es'} landed${epochRunning ? ' so far' : ''}, counting`, { wei: row.served }, 'of served value.');
        if (big(row.rolledIn) > 0n) out.parts.push('Its pool took', { wei: row.rolledIn }, 'rolled in from the empty epochs before it.');
      } else pending('Nothing funded or served on-chain.');
    } else if (kind === 'buyer-added') {
      const hits = logs.filter((l) => l.k === 'BuyerAdded' && inEpoch(l) && (!buyerAddr || low(l.a.buyer) === buyerAddr));
      if (hits.length) {
        out.status = 'seen';
        for (const h of hits) {
          out.parts.push(`${buyerName(h.a.buyer)} added to account ${h.a.accountId} at`, { t: h.at }, 'under a grant of', { wei: h.a.maxCostPerEpoch }, 'per subscription', { tx: h.tx });
          const funded = logs.find((l) => l.k === 'SubscriptionFunded' && low(l.a.buyer) === low(h.a.buyer) && Number(l.a.epoch) === e);
          if (funded) out.parts.push('Then it funded this epoch at cost', { wei: funded.a.cost }, { tx: funded.tx });
        }
      } else pending('No new grant on-chain.');
    } else if (kind === 'top-up') {
      const hits = logs.filter((l) => l.k === 'SubscriptionToppedUp' && inEpoch(l) && (!buyerAddr || low(l.a.buyer) === buyerAddr));
      if (hits.length) {
        out.status = 'seen';
        for (const h of hits) out.parts.push(`${buyerName(h.a.buyer)} topped up`, { wei: h.a.value }, 'of budget at cost', { wei: h.a.cost }, 'at', { t: h.at }, { tx: h.tx });
      } else pending('No top-up on-chain.');
    } else if (kind === 'buyer-removed') {
      const hits = logs.filter((l) => l.k === 'BuyerRemoved' && inEpoch(l) && (!buyerAddr || low(l.a.buyer) === buyerAddr));
      if (hits.length) {
        out.status = 'seen';
        for (const h of hits) {
          out.parts.push(`${buyerName(h.a.buyer)} removed from account ${h.a.accountId} at`, { t: h.at }, { tx: h.tx });
          const after = landed.filter((g) => g.buyer === low(h.a.buyer) && g.epoch === e && g.l.at > h.at);
          const counted = after.reduce((a, g) => a + g.counted, 0n);
          if (after.length) out.parts.push(`Then ${after.length} group${after.length === 1 ? '' : 's'} of receipts served before the removal landed, counting`, { wei: str(counted) }, '.');
          const refused = refusedRows.filter((r) => r.fault === 'InactiveGrant' && r.groups.some((g) => g.buyer === low(h.a.buyer)));
          if (refused.length) out.parts.push(`${refused.length} batch${refused.length === 1 ? ' was' : 'es were'} refused: issued after the grant ended`, { tx: refused[0].tx });
        }
      } else pending('No removal on-chain.');
    } else if (kind === 'race') {
      const partials = landed.filter((g) => g.epoch === e && g.counted < g.value && (!buyerAddr || g.buyer === buyerAddr));
      const refused = refusedRows.filter((r) => r.fault === 'BelowMinCounted' && epochOf(r.at, clock) === e);
      if (partials.length || refused.length) {
        out.status = 'seen';
        for (const g of partials.slice(0, 4)) {
          const others = new Set(landed.filter((x) => x.sub === g.sub && x.budget === g.budget).map((x) => x.seller));
          out.parts.push(`${sellerName(g.seller)} counted`, { wei: str(g.counted) }, 'of', { wei: str(g.value) }, `on ${g.buyer ? buyerName(g.buyer) : 'a buyer'}'s ${g.service ? serviceLabel(g.service) : 'service'} budget${others.size > 1 ? `, against ${others.size - 1} other seller${others.size > 2 ? 's' : ''}` : ''}`, { tx: g.l.tx });
        }
        if (refused.length) out.parts.push(`${refused.length} batch${refused.length === 1 ? ' was' : 'es were'} refused: the budget had less left than the batch's minimum`, { tx: refused[0].tx });
      } else pending('No partial count on-chain.');
    } else if (kind === 'missed-deadline') {
      const sellerId = whoSeller ? Number(whoSeller.identityId) : null;
      const refused = refusedRows.filter((r) => (r.fault === 'OutsideEpoch' || r.lateBy !== undefined) && r.groups.some((g) => g.subEpoch === e) && (sellerId === null || r.seller === sellerId));
      const lastOfSeller = landed.filter((g) => g.epoch === e && (sellerId === null || g.seller === sellerId)).pop();
      if (refused.length) {
        out.status = 'seen';
        for (const r of refused.slice(0, 3)) {
          const late = r.lateBy !== undefined ? `, ${r.lateBy}s after the deadline` : '';
          out.parts.push(`The chain refused a batch from ${r.seller ? sellerName(r.seller) : 'a seller'} worth`, { wei: r.value }, `${late}. It never counts.`.replace(/^\. /, '. '), { tx: r.tx });
        }
      } else if (epochEnded) {
        out.status = 'no-trace';
        out.parts.push('No refused batch on-chain: a batch that is held and never sent leaves no transaction.');
        if (lastOfSeller) out.parts.push(`What the chain does show: ${sellerName(lastOfSeller.seller)}'s last batch of the epoch landed at`, { t: lastOfSeller.l.at }, { tx: lastOfSeller.l.tx }, ', and it landed nothing after that.');
      } else if (epochRunning && passed) {
        out.status = 'waiting';
        if (lastOfSeller) out.parts.push(`${sellerName(lastOfSeller.seller)}'s last batch so far landed at`, { t: lastOfSeller.l.at }, { tx: lastOfSeller.l.tx });
        else out.parts.push(`No batch from ${ev.who ?? 'this seller'} so far in this epoch.`);
      }
    } else if (kind === 'funding-only') {
      if (row && big(row.served) > 0n) {
        if (epochEnded || epochRunning) {
          out.status = epochEnded ? 'differs' : 'waiting';
          out.parts.push('Served value counted in this epoch:', { wei: row.served }, '. Its money joined its own pool.');
        }
      } else if (epochEnded && row) {
        out.status = 'seen';
        const next = epochRow(e + 1);
        out.parts.push('No served value.', { wei: row.money }, 'of money rolled forward', ...(next && big(next.rolledIn) > 0n ? [`into epoch ${e + 1}'s pool.`] : ['and is waiting.']));
      } else if (epochRunning && row) {
        out.status = 'so-far';
        out.parts.push('No served value so far.', { wei: row.money }, 'funded. If it stays this way, the money rolls forward.');
      } else out.status = 'scheduled';
    } else {
      const hits = logs.filter((l) => inEpoch(l) && (!buyerAddr || low(l.a.buyer) === buyerAddr) && (!whoSeller || Number(l.a.seller) === Number(whoSeller.identityId)));
      if (hits.length) {
        out.status = 'seen';
        out.parts.push(`${hits.length} on-chain event${hits.length === 1 ? '' : 's'} in this epoch${ev.who ? ` from ${ev.who}` : ''}.`, { tx: hits[0].tx });
      } else pending('Nothing on-chain yet.');
    }
    return out;
  });

  // ------------------------------------------------------------------ cross-checks

  // The events are read just before the views, so in the epoch in progress they
  // can trail the views by a few blocks: that is "catching up" (null), not a
  // disagreement. An ended epoch has no such excuse, and asks for a full scan.
  const checks = [];
  let eventsBehind = false;
  const check = (epoch, name, ok, detail) => checks.push({ epoch, name, ok: !!ok, detail });
  const checkEvents = (row, name, ok, detail) => {
    if (ok || row.state === 'ended') {
      if (!ok) eventsBehind = true;
      checks.push({ epoch: row.epoch, name, ok, detail });
    } else checks.push({ epoch: row.epoch, name, ok: null, detail });
  };
  let walk = 0n;
  for (const row of epochs) {
    if (row.state === 'ahead' || row.state === 'upcoming') continue;
    const e = row.epoch;
    const served = big(row.served);
    const money = big(row.money);
    const pool = big(row.pool);
    walk += money;
    const expected = served > 0n ? walk : 0n;
    if (served > 0n) walk = 0n;
    check(e, 'pool', expected === pool, 'The pool read from the settlement equals the money of this epoch and of the empty epochs before it, worked out here.');
    check(e, 'served', sum(row.sellers.map((s) => s.served)) === served, "The sellers' served value adds up to the epoch's total.");
    check(e, 'weighted', sum(row.sellers.map((s) => s.weighted)) === big(row.weighted), "The sellers' weighted value adds up to the epoch's total.");
    const eventServed = landed.filter((g) => g.epoch === e).reduce((a, g) => a + g.served, 0n);
    checkEvents(row, 'events', eventServed === served, 'Served value worked out from every landed batch event equals the storage total.');
    const eventCounted = landed.filter((g) => g.epoch === e).reduce((a, g) => a + g.counted, 0n);
    checkEvents(row, 'budgets', eventCounted === big(row.budgetUsed), "Counted value in the events equals what the subscriptions' budgets have used.");
    const gross = sum(row.sellers.map((s) => s.gross));
    const withValue = BigInt(row.sellers.filter((s) => big(s.served) > 0n).length);
    check(e, 'payout', gross <= pool && pool - gross <= 2n * withValue, 'The sellers’ gross adds up to the pool, less at most 2 wei per seller with value.');
    const walletSubs = sum(row.subs.filter((s) => s.accountId === '0').map((s) => s.cost));
    const accountSubs = sum(row.subs.filter((s) => s.accountId !== '0').map((s) => s.cost));
    checkEvents(row, 'funding', walletSubs === big(row.wallet) && accountSubs === big(row.account), 'The subscriptions read here add up to the money booked for the epoch.');
  }

  return {
    schema: 1,
    generatedAt: now,
    status: { ...status, eventsBehind },
    network,
    contracts: state.contracts ?? {},
    clock: { ...clock, firstEpoch },
    params,
    public: { source: status?.public?.source ?? 'none', at: status?.public?.at ?? null, scenarioName: pub?.name ?? null },
    sellers,
    buyers,
    services,
    epochs,
    feed: feed.slice(0, FEED_CAP),
    feedTotal: feed.length,
    scenario,
    claims: claims.slice(0, 200),
    claimsTotal: claims.length,
    checks,
  };
}
