// Case 6 of the issue-3251 member-sharing suite
// (scripts/devnet-test-issue-3251-member-sharing.mjs): member 2 subscribes to
// a large graph, and the writes are made while that transfer holds member 2's
// only sync slot. The judgements are in ../qa/busy-slot.mjs; the node's
// admission trace is read through ../qa/admission-trace.mjs.

import { readFileSync } from 'node:fs';
import { waitFor } from './devnet.mjs';
import { heldAt, watched } from './observation.mjs';
import { traceAdmissions } from '../qa/admission-trace.mjs';
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

/** The admissions member 2's trace holds now (null when it wrote none). */
function readTrace(file) {
  try { return traceAdmissions(readFileSync(file, 'utf8')); } catch { return null; }
}

/**
 * Case 6. The node's own evidence must show the transfer in the slot: its
 * admission trace (DKG_SYNC_ADMISSION_TRACE, `member2.trace`) names the
 * admission of the large graph that holds its only general slot (its general
 * pool one slot and no queue, as the trace records the effective policy; a
 * reserved shared-memory slot beside it is the fix under test), and a write
 * counts only when it was received before that admission gave up the slot. A
 * running catch-up job proves nothing by itself. A write received only after
 * the transfer gave up the slot, or a transfer never admitted, means the case
 * was not exercised.
 *
 * `ctx` is { devnet, edges, graphs, io, report, precondition, boundMs, sub }; `pub` and `big` are graphs.
 */
export async function busyMember(ctx, pub, big) {
  const { devnet, edges, graphs, io, report, precondition, boundMs, sub } = ctx;
  const { owner, member1, member2 } = edges;
  const seconds = ms => Math.round(ms / 1000);
  await precondition(6, 'before the large transfer');
  const offset = devnet.logSize(member2);
  const isTransfer = admission => admission.label.includes(`:${big.id}:`);
  await graphs.subscribe(member2, big);
  const admitted = await waitFor(() => {
    const held = heldTransfer(readTrace(member2.trace), isTransfer);
    return { ok: Boolean(held.transfer), ...held };
  }, 30_000, 500);
  if (!admitted.ok) {
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
  const readAt = Date.now();
  const busy = busySlotCovered({ transfer: admitted.transfer, admissions: readTrace(member2.trace), readAt, until });
  for (const pair of pairs) {
    // A receipt counts only when the transfer had not given up the slot by then.
    const received = heldAt(pair);
    if (received !== null && !receivedWhileHeld(received, busy)) {
      report.fail(6, `${describe(pair.record)} at ${member2.label}: held ${seconds(received - pair.from)} s after the share, after the large transfer gave up the slot (${busy.reason ?? 'no trace'}): not exercised`);
    } else report.reportPair(pair, { boundMs, definitionSeen: io.definitionSeen(pair.record.author, pair.record.graph) });
  }
  const refused = devnet.logSince(member2, offset).split(`Sync backpressure rejected shared-memory:${pub.id}:`).length - 1;
  report.note(`case 6: member2's transfer of the large graph held its only sync slot ${busy.held ? `through every receipt check (${seconds(until - from)} s)` : `for ${busy.provenUntil === null ? 0 : Math.max(0, seconds(busy.provenUntil - from))} s of ${seconds(until - from)} s (then ${busy.reason})`}; member2 refused ${refused} pull(s) of the public graph for a busy slot`);
  return undefined;
}
