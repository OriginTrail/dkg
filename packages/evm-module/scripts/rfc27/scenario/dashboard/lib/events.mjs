// The marketplace's events, read from an explorer (or a node) into the indexer's
// state. Every run reads what is new: from each contract's cursor, less an
// overlap, because an explorer may index a block late. Once an epoch, and when an
// ended epoch's numbers disagree with its events, a rescan also reads a stretch
// again from a block on, which drops whatever a reorganized or late block changed:
// from an hour before the start of the epoch before the current one, or before the
// epoch that disagrees. A rescan from the first block would grow with the history
// until it no longer fits in the explorer's request limit.
//
// A read changes the state only once it has finished. One that fails part-way, on
// the explorer's request limit say, leaves the cursors, the events and the
// transactions as they were, so the next read starts where the last good one ended.

import { decodeBatchInput, decodeLog, functionName, HUB_NAMES, IFACES } from './chain.mjs';
import { startOf } from './compose.mjs';

/** Blocks re-read behind each cursor, about 30 minutes: an explorer may index a block late. */
export const OVERLAP_BLOCKS = 9_000;
/** How long before the start of its first epoch a rescan begins. */
export const RESCAN_MARGIN_SECONDS = 3_600;
/** The least time from one rescan to the next, whether the last one worked or not. */
export const RESCAN_PAUSE_SECONDS = 3_600;
/** The explorer requests a rescan wants left in the explorer's current window before it starts. */
export const RESCAN_MIN_QUOTA = 80;

export const LOG_CONTRACTS = [
  { name: 'QueryInferenceSettlement', txs: true },
  { name: 'ServiceSubscriptions', txs: true },
  { name: 'ServiceSubscriptionsWallet', txs: true },
  { name: 'StakingV10', topicEvent: 'RewardsClaimed' },
];

export const KEEP = new Set(['ReceiptsLanded', 'ReceiptBatchAccepted', 'SubscriptionFunded', 'SubscriptionToppedUp', 'BuyerAdded', 'BuyerRemoved', 'BuyerLimitsUpdated', 'ServiceSpendingSet', 'RewardsClaimed']);

/**
 * State from before a read changed it only once finished (`v` 1): a read that
 * failed part-way could move a cursor past events it never kept. Each cursor is
 * capped at the newest event held, which only a finished read adds, so what came
 * after is read again. Runs once; true if it did.
 */
export function repairState(st) {
  if ((st.v ?? 1) >= 2) return false;
  const newest = (st.logs ?? []).reduce((m, l) => Math.max(m, l.block), 0);
  for (const key of Object.keys(st.cursors ?? {})) st.cursors[key] = Math.min(st.cursors[key], newest);
  st.rescanEpoch = st.fullScanEpoch ?? null;
  st.rescanFrom = null;
  st.rescanNotBefore = null;
  delete st.fullScanEpoch;
  delete st.needFullScan;
  st.v = 2;
  return true;
}

/**
 * Whether a rescan is due and from where: once each epoch, and from an older
 * epoch whose numbers disagreed, never sooner than RESCAN_PAUSE_SECONDS after the
 * last one. Its block is that of the newest event held from before the stretch,
 * so no later than the stretch's start; 0 when no event held is that old.
 */
export function rescanPlan(st, now) {
  const clock = st.clock;
  if (!clock) return null;
  const due = st.rescanEpoch !== clock.currentEpoch || (st.rescanFrom ?? null) !== null;
  if (!due || (st.rescanNotBefore ?? 0) > now) return null;
  const fromEpoch = Math.min(clock.currentEpoch - 1, st.rescanFrom ?? Infinity);
  const fromTime = startOf(fromEpoch, clock) - RESCAN_MARGIN_SECONDS;
  let fromBlock = 0;
  for (const l of st.logs) if (l.at <= fromTime && l.block > fromBlock) fromBlock = l.block;
  return { fromEpoch, fromBlock };
}

/**
 * Reads the events into `st`: what is new since each cursor, or with `fromBlock`
 * everything again from that block on, keeping what is older. `revertOf(t)` gives
 * a reverted transaction's reason. Changes `st` only if it finishes. Returns how
 * many events it found that the state did not hold.
 */
export async function readEvents(source, st, { fromBlock = null, revertOf }) {
  const again = fromBlock !== null;
  const cursors = { ...st.cursors };
  const txs = {};
  const logs = again ? st.logs.filter((l) => l.block < fromBlock) : [...st.logs];
  const seen = new Set(logs.map((l) => `${l.tx}:${l.idx}`));
  const known = new Set(st.logs.map((l) => `${l.tx}:${l.idx}`));
  const since = (key) => (again ? fromBlock : Math.max(0, (cursors[key] ?? 0) - OVERLAP_BLOCKS));
  let added = 0;
  for (const { name, txs: wantTxs, topicEvent } of LOG_CONTRACTS) {
    for (const address of st.addresses[name] ?? []) {
      const iface = IFACES[HUB_NAMES[name]];
      const logKey = `${address}:logs`;
      const topic = topicEvent ? iface.getEvent(topicEvent).topicHash : null;
      const raws = await source.logs(address, { sinceBlock: since(logKey), topic });
      for (const raw of raws) {
        cursors[logKey] = Math.max(cursors[logKey] ?? 0, raw.block);
        const key = `${raw.tx}:${raw.idx}`;
        if (seen.has(key)) continue;
        const decoded = decodeLog(iface, raw);
        if (!decoded || !KEEP.has(decoded.k)) continue;
        seen.add(key);
        logs.push(decoded);
        if (!known.has(key)) added++;
      }
      if (!wantTxs) continue;
      const txKey = `${address}:txs`;
      const list = await source.txs(address, { sinceBlock: since(txKey) });
      for (const t of list) {
        cursors[txKey] = Math.max(cursors[txKey] ?? 0, t.block);
        if (t.to !== address) continue;
        const keepAll = name === 'QueryInferenceSettlement';
        if (!keepAll && t.ok) continue;
        const held = txs[t.hash] ?? st.txs[t.hash];
        if (held && !(held.ok === false && !held.revert)) continue;
        const groups = decodeBatchInput(t.input);
        const record = { ok: t.ok, from: t.from, to: t.to, at: t.at, block: t.block, position: t.position, fn: functionName(t.input), groups };
        if (!t.ok) record.revert = await revertOf(t);
        txs[t.hash] = record;
      }
    }
  }
  logs.sort((a, b) => a.block - b.block || a.idx - b.idx);
  st.cursors = cursors;
  Object.assign(st.txs, txs);
  st.logs = logs;
  return added;
}
