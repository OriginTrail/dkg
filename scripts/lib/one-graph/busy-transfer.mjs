// The busy-slot case of the one-graph promotion suite
// (scripts/devnet-test-one-graph-promotion.mjs): edgeB subscribes to a large
// graph whose Verified Memory the curator has published, and while that
// transfer holds edgeB's only general sync slot, a report arrives in the
// graph's sub-graph and the curator promotes others. The judgements are in
// ../qa/one-graph-promotion.mjs.
//
// The evidence is edgeB's own. Its log names each admission to its sync slots
// with the general pool's policy (`Sync backpressure running <label> (global
// inflight=1/1, queued=0/0)`); the transfer of the large graph is many short
// admissions `durable:<graph>:<peer>`, one or a few assets each. Its
// diagnostics (/api/diagnostics/backpressure, read every second) name the
// running operations and their age, never a graph: a reading dates the
// running durable work's start, and the log ties that start to an admission
// of the transfer and to no other. Durable work never takes the reserved
// shared-memory slot beside the general one, so under one general slot the
// durable work a reading shows holds that slot. A report reaches edgeB through
// gossip and counts only when an admission of the transfer held the slot at
// that moment. A read's completion is not that moment, so edgeB's reads of
// each report are made every quarter second from before it is created, and
// date its arrival between the last read that missed it and the first that
// found it (arrivalWindow); the first reading after that window must show an
// admission that started before the window opened. Because the transfer
// leaves the slot for moments between admissions, edgeA shares again, up to
// SHARE_ATTEMPTS times, until a receipt lands inside one. A promotion reaches
// edgeB through edgeB's own sync work, which needs the slot itself, so its
// receipt counts when the transfer held the slot at some reading between the
// promotion and the last read that still missed the delivery: the delivery
// contended with it. Either receipt must fall within the transfer's life; one
// that does not, or lacks that evidence, leaves the case not exercised. The
// readings are kept in the run's folder.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { brief, sleep, waitFor } from '../member-sharing/devnet.mjs';
import { heldAt } from '../member-sharing/observation.mjs';
import {
  admissionPolicyProblem, arrivalWindow, busyReceiptOutcome, countLogLines, pairOutcome, parseAdmissions, slotHolder, transferContended,
  transferHeldThrough, transferLifetime, transferOccupancy,
} from '../qa/one-graph-promotion.mjs';
import { settled } from './reports.mjs';

const secs = ms => Math.round(ms / 1000);
// How often edgeA shares a report during the transfer, at most, until edgeB
// receives one while an admission of the transfer holds its slot.
const SHARE_ATTEMPTS = 6;

/**
 * One reading of a node's sync slots: the running operations of every lane
 * of its `sync-global` scheduler, with the moments the request went out and
 * the answer came.
 */
async function slotReading(devnet, node) {
  const sentAt = Date.now();
  const answer = await devnet.api(node, 'GET', '/api/diagnostics/backpressure', undefined, { timeoutMs: 5000 });
  const at = Date.now();
  const scheduler = Array.isArray(answer.json?.schedulers) ? answer.json.schedulers.find(s => s?.scheduler === 'sync-global') : undefined;
  if (answer.status !== 200 || !scheduler) return { at, unreadable: answer.status === 200 ? 'no sync-global scheduler in the diagnostics' : brief(answer) };
  const operations = (Array.isArray(scheduler.lanes) ? scheduler.lanes : []).flatMap(lane => (Array.isArray(lane?.activeOperations) ? lane.activeOperations : [])
    .map(operation => ({ lane: lane.lane, operation: operation?.operation, oldestAgeMs: operation?.oldestAgeMs })));
  return { sentAt, at, operations };
}

/** Reads a node's sync slots every second until stopped. */
function readSlots(devnet, node) {
  const readings = [];
  let reading = true;
  const done = (async () => {
    while (reading) {
      readings.push(await slotReading(devnet, node));
      await sleep(1000);
    }
  })();
  return { readings, stop: async () => { reading = false; await done; } };
}

/**
 * The case. `ctx` is { devnet, edges, graphs, io, report, caseId, boundMs,
 * stamp, ensureDefinition, promote }; `main` is the graph, `large` the large
 * graph (published), `promotions` the reports the curator promotes while the
 * transfer runs. `ensureDefinition(node, graph, caseId)` is the suite's
 * remedy for a subscriber that holds no definition of a graph, and
 * `promote(caseId, record)` its promotion check (which applies the known
 * gaps), resolving to when the promotion was confirmed, or null. Returns the
 * records of the reports shared in the window and the reports promoted, for
 * the cases after it: { shared, promoted }.
 */
export async function busyEdge(ctx, main, large, promotions) {
  const { devnet, edges, graphs, io, report, caseId } = ctx;
  const { curator, edgeA, edgeB } = edges;
  const offset = devnet.logSize(edgeB);
  const slots = readSlots(devnet, edgeB);
  const subscribedAt = await graphs.subscribe(edgeB, large);
  const isTransfer = admission => admission.label.startsWith(`durable:${large.id}:`);
  const admissions = () => parseAdmissions(devnet.logSince(edgeB, offset));
  const started = () => waitFor(async () => {
    const holder = slotHolder(slots.readings.at(-1), admissions(), isTransfer);
    return { ok: holder.state === 'transfer', ...holder };
  }, 90_000, 500);
  let seen = await started();
  if (!seen.ok) {
    const listed = await io.listingEntry(edgeB, large);
    if (listed.readable && !listed.defined) {
      report.note(`case ${caseId}: no transfer of the large graph in ${edgeB.label}'s general slot within 90 s of its subscribe, and it holds no definition of that graph`);
      await ctx.ensureDefinition(edgeB, large, caseId);
      seen = await started();
    }
  }
  if (!seen.ok) {
    await slots.stop();
    report.fail(caseId, `not exercised: ${edgeB.label}'s transfer of the large graph was never seen in its general sync slot (last reading: ${seen.state}); raise ONE_GRAPH_LARGE_ASSETS / ONE_GRAPH_LARGE_TRIPLES`);
    return { shared: [], promoted: [] };
  }
  const policy = admissionPolicyProblem(seen.admission);
  if (policy) report.fail(caseId, `${edgeB.label} does not run the profile's sync policy: ${policy} (its admission ${seen.admission.label})`);
  report.note(`case ${caseId}: ${edgeB.label} runs ${seen.admission.label} in its general sync slot, ${secs(seen.admission.at - subscribedAt)} s after it subscribed to the large graph`);

  const from = Date.now();
  // The promotions run beside the reports; each is confirmed on chain before its watch starts.
  const promoting = (async () => {
    const watches = [];
    const done = [];
    for (const record of promotions) {
      const at = await ctx.promote(caseId, record);
      if (at === null) continue;
      done.push(record);
      const options = { from: at, fromWhat: 'promotion' };
      watches.push(io.watch([
        ...io.pairs(caseId, record, [edgeB, curator, edgeA], 'vm', options),
        ...io.pairs(caseId, record, [edgeB, curator, edgeA], 'gone', options),
      ]));
    }
    return { promoted: done, pairs: await settled(watches) };
  })();
  // A report reaches edgeB at once through gossip, often between two of the
  // transfer's admissions. edgeA shares again, up to SHARE_ATTEMPTS times while
  // the transfer runs, until edgeB receives a report while an admission of the
  // transfer holds its slot throughout the window of its arrival.
  const shared = [];
  const reportPairs = [];
  const arrivals = new Map();
  const readingAfter = moment => waitFor(() => ({ ok: slots.readings.some(reading => (Number.isFinite(reading.sentAt) ? reading.sentAt : reading.at) >= moment) }), 5000, 200);
  for (let attempt = 1; attempt <= SHARE_ATTEMPTS; attempt += 1) {
    if (attempt > 1) await sleep(1500);
    let dating = null;
    const record = await io.share(edgeA, main, `edgeA while edgeB is busy ${attempt}`, { onStart: made => { dating = io.dateArrival(edgeB, made, 'swm'); } });
    shared.push(record);
    const pairs = await settled([io.watch(io.pairs(caseId, record, [edgeB, curator], 'swm'))]);
    reportPairs.push(...pairs);
    const window = arrivalWindow(await dating.stop());
    arrivals.set(record, window);
    const heldBy = heldAt(pairs.find(pair => pair.node === edgeB));
    if (heldBy === null) break;
    // The report was there by the first read that found it, the watch's or the dating's.
    const received = Math.min(heldBy, window?.by ?? Infinity);
    await readingAfter(received);
    const log = devnet.logSince(edgeB, offset);
    const all = parseAdmissions(log);
    if (transferHeldThrough(window && { after: window.after, by: received }, slots.readings, all, isTransfer).held) break;
    const life = transferLifetime(log, all, isTransfer, slots.readings);
    if (!life || received > life.to) break;
  }
  const { promoted, pairs: promotionPairs } = await promoting;
  const until = Date.now();
  // One reading taken after the last check, so that the evidence reaches the window's end.
  await readingAfter(until);
  await slots.stop();
  const kept = join(devnet.dir, 'one-graph-promotion', ctx.stamp);
  mkdirSync(kept, { recursive: true });
  writeFileSync(join(kept, `node${edgeB.number}-${edgeB.role}.slot-readings.jsonl`), slots.readings.map(reading => JSON.stringify(reading)).join('\n'));

  const log = devnet.logSince(edgeB, offset);
  const all = parseAdmissions(log);
  const life = transferLifetime(log, all, isTransfer, slots.readings);
  // Every edgeB receipt counts only while an admission of the transfer held its
  // slot (busyReceiptOutcome). Of the shares, the last decides; an earlier one
  // is noted. The other Edges' pairs are ordinary delivery checks.
  const lastAttempt = reportPairs.filter(pair => pair.node === edgeB).at(-1);
  for (const pair of [...reportPairs, ...promotionPairs]) {
    const result = pairOutcome(pair, { boundMs: ctx.boundMs });
    if (pair.node !== edgeB) {
      (result.outcome === 'pass' ? report.pass : report.fail)(caseId, result.text);
      continue;
    }
    // A report must land under a transfer admission, dated by its quarter-second
    // reads; a promotion's delivery, which needs the slot itself, must have
    // contended with the transfer for it, dated by its watch's reads.
    const delivery = pair.kind !== 'swm';
    const window = delivery ? arrivalWindow(pair.dating) : arrivals.get(pair.record) ?? null;
    const heldBy = heldAt(pair);
    const received = heldBy === null ? null : Math.min(heldBy, window?.by ?? Infinity);
    let held;
    if (received !== null) {
      held = delivery ? transferContended(pair.from, window?.after, slots.readings, all, isTransfer)
        : transferHeldThrough(window && { after: window.after, by: received }, slots.readings, all, isTransfer);
    }
    const verdict = busyReceiptOutcome(result, { received, life, held, delivery });
    if (pair.kind === 'swm' && pair !== lastAttempt) report.note(`case ${caseId}: an earlier share: ${verdict.text}`);
    else (verdict.outcome === 'pass' ? report.pass : report.fail)(caseId, verdict.text);
  }
  const occupancy = transferOccupancy({ readings: slots.readings, admissions: all, isTransfer, from, until });
  const reserved = all.filter(admission => admission.reserved && admission.label.startsWith(`shared-memory:${main.id}:`) && admission.at >= from - 1000 && admission.at <= until);
  report.note(`case ${caseId}: the transfer ran ${life ? `${life.admissions} admission(s) from ${secs(life.from - subscribedAt)} s to ${secs(life.to - subscribedAt)} s after the subscribe` : 'no admission'}; in the window of ${secs(until - from)} s, ${occupancy.transfer} of ${occupancy.total} slot readings show it in the general slot; ${countLogLines(log, 'Sync backpressure rejected ', { from, until })} sync admission(s) refused, ${reserved.length} pull(s) of the graph in the reserved shared-memory slot`);
  return { shared, promoted };
}
