// The busy-slot case of the one-graph promotion suite
// (scripts/devnet-test-one-graph-promotion.mjs): edgeB subscribes to a large
// graph whose Verified Memory the curator has published, and while that
// transfer holds edgeB's only general sync slot, a report arrives in the
// graph's sub-graph and the curator promotes another one. The judgements are
// in ../qa/one-graph-promotion.mjs.
//
// The evidence is edgeB's own. Its log names each admission to its sync slots
// with the general pool's policy (`Sync backpressure running <label> (global
// inflight=1/1, queued=0/0)`); a transfer of the large graph is
// `durable:<graph>:<peer>`. Its diagnostics (/api/diagnostics/backpressure,
// read every second) name the running operations and their age, never a
// graph: a reading dates the running durable work's start, and the log ties
// that start to the transfer's admission and to no other. Durable work never
// takes the reserved shared-memory slot beside the general one, so under one
// general slot the durable work a reading shows is the slot's holder.

import { brief, sleep, waitFor } from '../member-sharing/devnet.mjs';
import { heldAt } from '../member-sharing/observation.mjs';
import {
  admissionPolicyProblem, countLogLines, identifyTransfer, pairOutcome, parseAdmissions, promotionOutcome, receivedWhileHeld,
  transferHeldThrough,
} from '../qa/one-graph-promotion.mjs';
import { describe } from '../qa/member-sharing.mjs';
import { settled } from './reports.mjs';

const secs = ms => Math.round(ms / 1000);

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
 * The case. `ctx` is { devnet, edges, graphs, io, report, caseId, boundMs };
 * `main` is the graph, `large` the large graph (published), `promote` the
 * report the curator promotes while the transfer holds the slot (or null).
 * Returns the record of the report shared in the window and whether `promote`
 * was promoted, for the cases after it: { shared, promoted }.
 */
export async function busyEdge(ctx, main, large, promote) {
  const { devnet, edges, graphs, io, report, caseId } = ctx;
  const { curator, edgeA, edgeB } = edges;
  const offset = devnet.logSize(edgeB);
  const slots = readSlots(devnet, edgeB);
  const subscribedAt = await graphs.subscribe(edgeB, large);
  const isTransfer = admission => admission.label.startsWith(`durable:${large.id}:`);
  const identified = await waitFor(async () => {
    const reading = slots.readings.at(-1);
    const found = identifyTransfer(reading, parseAdmissions(devnet.logSince(edgeB, offset)), isTransfer);
    return { ok: Boolean(found.transfer), ...found };
  }, 90_000, 500);
  if (!identified.ok) {
    await slots.stop();
    report.fail(caseId, `not exercised: ${edgeB.label}'s transfer of the large graph was not seen in its general sync slot within 90 s of the subscribe (${identified.why}); raise ONE_GRAPH_LARGE_ASSETS / ONE_GRAPH_LARGE_TRIPLES`);
    return { shared: null, promoted: false };
  }
  const { transfer } = identified;
  const policy = admissionPolicyProblem(transfer);
  if (policy) report.fail(caseId, `${edgeB.label} does not run the profile's sync policy: ${policy} (its admission ${transfer.label})`);
  report.note(`case ${caseId}: ${edgeB.label} runs the transfer ${transfer.label} in its general sync slot, admitted ${secs(transfer.to - subscribedAt)} s after it subscribed to the large graph`);

  const from = Date.now();
  const handles = [];
  const shared = await io.share(edgeA, main, 'edgeA while edgeB is busy');
  handles.push(io.watch(io.pairs(caseId, shared, [edgeB, curator], 'swm')));
  let promoted = false;
  if (promote) {
    const { answer, at } = await io.promote(curator, promote);
    const outcome = promotionOutcome(answer, { authorAddress: promote.author.agentAddress });
    if (outcome.ok) {
      promoted = true;
      const options = { from: at, fromWhat: 'promotion' };
      handles.push(io.watch([
        ...io.pairs(caseId, promote, [edgeB, curator, edgeA], 'vm', options),
        ...io.pairs(caseId, promote, [edgeB, curator, edgeA], 'gone', options),
      ]));
    } else report.fail(caseId, `the curator's promotion of ${describe(promote)} while ${edgeB.label} was busy failed: ${outcome.why}`);
  }
  const pairs = await settled(handles);
  const until = Date.now();
  // One reading taken after the last check, so that the evidence can reach the window's end.
  await waitFor(() => ({ ok: slots.readings.some(reading => (Number.isFinite(reading.sentAt) ? reading.sentAt : reading.at) >= until) }), 10_000, 200);
  await slots.stop();
  const busy = transferHeldThrough({ transfer, readings: slots.readings, from, until });
  for (const pair of pairs) {
    const received = pair.node === edgeB ? heldAt(pair) : null;
    if (received !== null && !receivedWhileHeld(received, busy)) {
      report.fail(caseId, `${describe(pair.record)} at ${edgeB.label}: shown ${secs(received - pair.from)} s after the ${pair.fromWhat ?? 'share'}, later than the last reading that showed the transfer in the slot (${busy.reason ?? 'no reading'}): not exercised`);
      continue;
    }
    const result = pairOutcome(pair, { boundMs: ctx.boundMs });
    if (result.outcome === 'pass') report.pass(caseId, result.text);
    else report.fail(caseId, result.text);
  }
  const log = devnet.logSince(edgeB, offset);
  const window = { from, until };
  const reserved = parseAdmissions(log).filter(admission => admission.reserved && admission.label.startsWith(`shared-memory:${main.id}:`) && admission.at >= from - 1000 && admission.at <= until);
  report.note(`case ${caseId}: the transfer held ${edgeB.label}'s general slot ${busy.held ? `through every check (${secs(until - from)} s)` : `for ${busy.provenUntil === null ? 0 : secs(busy.provenUntil - from)} s of ${secs(until - from)} s (then ${busy.reason})`}; meanwhile its log shows ${countLogLines(log, 'Sync backpressure rejected ', window)} sync admission(s) refused and ${reserved.length} pull(s) of the graph in the reserved shared-memory slot`);
  return { shared, promoted };
}
