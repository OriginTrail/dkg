// Case 6 of the issue-3251 member-sharing suite
// (scripts/devnet-test-issue-3251-member-sharing.mjs): member 2 subscribes to
// a large graph, and the writes are made while that transfer holds member 2's
// only sync slot. The judgements are in ../qa/busy-slot.mjs.

import { brief, sleep, waitFor } from './devnet.mjs';
import { heldAt, watched } from './observation.mjs';
import { admissionRecords } from '../qa/admission-identity.mjs';
import { busySlotCovered, heldTransfer, receivedWhileHeld } from '../qa/busy-slot.mjs';
import { describe } from '../qa/member-sharing.mjs';

/** The large graph: `assets` assets of `triples` triples, each over 50 subjects with an equal share of them, about 100 bytes a value. */
export async function fillBigGraph(io, owner, graph, { assets, triples, stamp }) {
  const perSubject = Math.max(1, Math.ceil(triples / 50));
  for (let i = 0; i < assets; i++) {
    const quads = Array.from({ length: triples }, (_, t) => ({
      subject: `urn:issue3251:big:${stamp}:${i}:${Math.floor(t / perSubject)}`, predicate: `urn:issue3251:payload:${t % perSubject}`,
      object: `"row ${t} of asset ${i} ${'x'.repeat(80)}"`, graph: '',
    }));
    const outcome = await io.createAndShare(owner, { contextGraphId: graph.id, name: `i3251-big-${stamp.toLowerCase()}-${i}`, quads },
      { createTimeoutMs: 300_000, jobTimeoutMs: 300_000, pollMs: 2000 });
    if (outcome.error) throw new Error(`asset ${i} of the large graph: ${outcome.error}`);
  }
}

/**
 * One reading of a node's sync slots: its `sync-global` scheduler in the
 * backpressure diagnostics, with the moments the request was sent and the
 * answer came, and the class of its oldest running operation.
 */
async function slotReading(devnet, node) {
  const sentAt = Date.now();
  const answer = await devnet.api(node, 'GET', '/api/diagnostics/backpressure', undefined, { timeoutMs: 5000 });
  const at = Date.now();
  const scheduler = Array.isArray(answer.json?.schedulers) ? answer.json.schedulers.find(s => s?.scheduler === 'sync-global') : undefined;
  if (answer.status !== 200 || !scheduler?.totals) return { at, unreadable: answer.status === 200 ? 'no sync-global scheduler in the diagnostics' : brief(answer) };
  const { inflight, inflightLimit, queueLimit, oldestActiveAgeMs } = scheduler.totals;
  const running = (Array.isArray(scheduler.lanes) ? scheduler.lanes : []).flatMap(lane => (Array.isArray(lane?.activeOperations) ? lane.activeOperations : []));
  const oldestOperations = [...new Set(running
    .filter(operation => typeof operation?.operation === 'string' && operation.oldestAgeMs === oldestActiveAgeMs)
    .map(operation => operation.operation.split(':', 1)[0]))];
  return { sentAt, at, inflight, inflightLimit, queueLimit, capacityModel: scheduler.capacityModel, oldestActiveAgeMs, ...(oldestOperations.length ? { oldestOperations } : {}) };
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
 * Case 6. The node's own evidence must show the transfer in the slot: its log
 * names the admission of the large graph (`Sync backpressure running
 * shared-memory:<large graph>:…`), and its slot readings show the admission
 * that started then still running, every second, until each write was
 * received. A receipt counts only when a reading taken at or after it still
 * showed the transfer; nothing is assumed past the last such reading. A
 * running catch-up job proves nothing by itself. A write received only after
 * the transfer left the slot (to other work, or to nothing), or a transfer
 * never admitted, means the case was not exercised.
 *
 * `ctx` is { devnet, edges, graphs, io, report, precondition, boundMs, sub }; `pub` and `big` are graphs.
 */
export async function busyMember(ctx, pub, big) {
  const { devnet, edges, graphs, io, report, precondition, boundMs, sub } = ctx;
  const { owner, member1, member2 } = edges;
  const seconds = ms => Math.round(ms / 1000);
  await precondition(6, 'before the large transfer');
  const offset = devnet.logSize(member2);
  const needle = `:${big.id}:`;
  const slots = readSlots(devnet, member2);
  await graphs.subscribe(member2, big);
  // The whole log: an admission just before the subscribe could have started in the same second as the transfer.
  const isTransfer = record => record.label.includes(needle);
  const admitted = await waitFor(async () => {
    const reading = slots.readings.at(-1);
    const held = heldTransfer(reading, admissionRecords(devnet.logSince(member2, 0)), isTransfer);
    return { ok: Boolean(held.transfer), reading, ...held };
  }, 30_000, 500);
  if (!admitted.ok) {
    await slots.stop();
    return report.fail(6, `not exercised: member2's transfer of the large graph did not hold its sync slot within 30 s of the subscribe (${admitted.why}); raise MEMBER_SHARING_BIG_ASSETS / MEMBER_SHARING_BIG_TRIPLES`);
  }
  const from = Date.now();
  const handles = [
    await io.writeAndWatch(6, owner, pub, null, 'owner while member2 is busy, root', [member2]),
    await io.writeAndWatch(6, owner, pub, sub, 'owner while member2 is busy, sub-graph', [member2]),
    await io.writeAndWatch(6, member1, pub, null, 'member1 while member2 is busy, root', [member2]),
  ];
  const pairs = await watched(handles);
  const until = Date.now();
  // One reading taken after the last receipt check, so that the evidence can reach the window's end.
  await waitFor(() => ({ ok: slots.readings.some(reading => (Number.isFinite(reading.sentAt) ? reading.sentAt : reading.at) >= until) }), 10_000, 200);
  await slots.stop();
  // The confirming reading again, against the whole log as it stands now: an
  // admission whose line was written late cannot pass for the transfer.
  const confirmed = heldTransfer(admitted.reading, admissionRecords(devnet.logSince(member2, 0)), isTransfer);
  const busy = confirmed.transfer
    ? busySlotCovered({ transfer: confirmed.transfer, samples: slots.readings, from, until })
    : { held: false, reason: `the whole log no longer ties the work in the slot to the transfer (${confirmed.why})`, provenUntil: null };
  for (const pair of pairs) {
    // A receipt counts only when a reading taken at or after it still showed
    // the transfer in the slot; between two such readings the same admission
    // held it throughout.
    const received = heldAt(pair);
    if (received !== null && !receivedWhileHeld(received, busy)) {
      report.fail(6, `${describe(pair.record)} at ${member2.label}: held ${seconds(received - pair.from)} s after the share, later than the last reading that showed the large transfer in the slot (${busy.reason ?? 'no reading'}): not exercised`);
    } else report.reportPair(pair, { boundMs, definitionSeen: io.definitionSeen(pair.record.author, pair.record.graph) });
  }
  const refused = devnet.logSince(member2, offset).split(`Sync backpressure rejected shared-memory:${pub.id}:`).length - 1;
  report.note(`case 6: member2's transfer of the large graph held its only sync slot ${busy.held ? `through every receipt check (${seconds(until - from)} s)` : `for ${busy.provenUntil === null ? 0 : seconds(busy.provenUntil - from)} s of ${seconds(until - from)} s (then ${busy.reason})`}; member2 refused ${refused} pull(s) of the public graph for a busy slot`);
  return undefined;
}
