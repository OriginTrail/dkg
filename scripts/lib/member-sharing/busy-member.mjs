// Case 6 of the issue-3251 member-sharing suite
// (scripts/devnet-test-issue-3251-member-sharing.mjs): member 2 subscribes to
// a large graph, and the writes are made while that transfer holds member 2's
// general sync slot. When a write arrives only after the transfer gave up the
// slot, the attempt proved nothing, and another one transfers another large
// graph and makes the writes again. The judgements are in ../qa/busy-slot.mjs;
// the node's admission trace is read through ../qa/admission-trace.mjs.

import { readFileSync } from 'node:fs';
import { waitFor } from './devnet.mjs';
import { heldAt, watched } from './observation.mjs';
import { traceAdmissions } from '../qa/admission-trace.mjs';
import {
  admissionsBySlot, attemptVerdict, besideTransfer, busySlotCovered, generalSlotIdleFor, heldTransfer, nextLargeSize, ownerLargeSize, transferChain, transferSettled,
} from '../qa/busy-slot.mjs';
import { describe } from '../qa/member-sharing.mjs';

const seconds = ms => Math.round(ms / 1000);
const sizeText = size => `${size.assets} assets of ${size.triples} triples`;

/**
 * The large graph, written by `author` (the feeder, or the owner): `assets`
 * assets of `triples` triples, each over 50 subjects with an equal share of
 * them, about 100 bytes a value. `graph.key` keeps the assets of each large
 * graph apart.
 */
export async function fillBigGraph(io, author, graph, { assets, triples, stamp }) {
  const perSubject = Math.max(1, Math.ceil(triples / 50));
  for (let i = 0; i < assets; i++) {
    const quads = Array.from({ length: triples }, (_, t) => ({
      subject: `urn:issue3251:${graph.key}:${stamp}:${i}:${Math.floor(t / perSubject)}`, predicate: `urn:issue3251:payload:${t % perSubject}`,
      object: `"row ${t} of asset ${i} ${'x'.repeat(80)}"`, graph: '',
    }));
    const outcome = await io.createAndShare(author, { contextGraphId: graph.id, name: `i3251-${graph.key}-${stamp.toLowerCase()}-${i}`, quads },
      { createTimeoutMs: 300_000, jobTimeoutMs: 300_000, pollMs: 500 });
    if (outcome.error) throw new Error(`asset ${i} of the ${graph.key} graph: ${outcome.error}`);
  }
}

/**
 * The large graph of case 6's attempt `attempt`, kept away from the Cores and
 * filled with `size` ({ assets, triples per asset }). The first is the
 * owner's. A later one is written by a feeder that holds nothing yet, started
 * for it (member 2 dials it through node 2), or put in place of the one that
 * wrote the attempt before (once `audit` saw it out of the public graph): the
 * owner, whose writes case 6 waits for, holds no more than before, and no node
 * holds the large graphs of several attempts. Without a feeder the owner
 * writes it, no larger than it can take (ownerLargeSize).
 *
 * A freshly started feeder has died within seconds, with nothing in its log,
 * and that says nothing about the writes. So a feeder that fails while it
 * writes the graph is given up and the owner writes the graph instead. It
 * needs no audit: no write is made while a large graph is written, so it has
 * carried none. Throws when the owner fails too. `ctx` is { edges, graphs, io,
 * say, stamp, audit (when) }. Returns the graph, with the `size` it carries.
 */
export async function writeLargeGraph(ctx, attempt, size) {
  const { edges, graphs, io, say, stamp, audit } = ctx;
  const author = await edges.prepareLargeGraphAuthor(attempt, () => audit(`before attempt ${attempt} of case 6`));
  if (author === edges.feeder) say(`feeder ${author.label} up, holding nothing yet, and dialed by member2`);
  const carried = attempt > 1 && author === edges.owner ? ownerLargeSize(size) : size;
  try {
    const graph = await graphs.createGraph(attempt === 1 ? 'large' : `large${attempt}`, { accessPolicy: 0, publishPolicy: 1, register: false }, { by: author });
    await graphs.keepCoresOut(graph);
    const started = Date.now();
    await fillBigGraph(io, author, graph, { ...carried, stamp });
    say(`large graph ${graph.key} written: ${sizeText(carried)} in ${seconds(Date.now() - started)} s`);
    return { ...graph, size: carried };
  } catch (error) {
    if (author === edges.owner) throw error;
    await edges.giveUpFeeder(error);
    return writeLargeGraph(ctx, attempt, size);
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
 * pool one slot and no queue, as the trace records the effective policy; the
 * reserved slots beside it are the fixes under test), and a write counts only
 * when it was received before the last trace line that shows that admission
 * holding the slot (its release, or a `holding` line once a second); a pull of
 * the large graph taking the slot again at once continues it (transferChain).
 * The three writes are made at once, as soon as the transfer holds the slot,
 * so that their window is short beside the transfer. A running catch-up job
 * proves nothing by itself.
 *
 * The transfer's length is not known in advance, and the writes may take up
 * to their bound to arrive. So when a write is received only after the
 * transfer gave up the slot (the attempt proved nothing), or the transfer gave
 * it up before the writes could start, another attempt follows, up to
 * `attempts` in all: member 2 subscribes to a new large graph (`largeGraph`),
 * sized from the rate its trace measured for the last transfer to hold the
 * slot for as long as a write can take to arrive, its bound, or the window the
 * last writes needed if that was longer, within what one node holds well
 * (nextLargeSize), and the three writes are made again. A subscribe that keeps
 * being refused ends only its attempt, and another follows in the same way.
 * Only the last attempt is judged as the case: its writes as usual, and a write
 * of it received after the slot was free, or a transfer never admitted to the
 * general slot, as not exercised. A write never received fails the case at
 * once, whatever the slot did; so does a node that writes no trace or runs
 * another sync policy, and a trace that shows another admission in the one
 * general slot at the same time as the transfer.
 *
 * `ctx` is { devnet, edges, graphs, io, report, precondition, boundMs, sub,
 * attempts (1), largeGraph (attempt, size) => the next large graph, connect
 * (dials what each attempt needs, before it: a relay's circuit lasts 30 min),
 * admitMs (how long the transfer has to take the general slot, 60 s), idleMs
 * (how long the general slot must have been free before the subscribe, 1.5 s),
 * sizing (options of nextLargeSize) }; `pub` is a graph and `big` a large
 * graph, with its `size` ({ assets, triples per asset }). Returns a function
 * that says, once the transfer of the attempt judged is over, how long it held
 * the slot in all: the margin that attempt had. Returns undefined instead when
 * no writes were judged.
 */
export async function busyMember(ctx, pub, big) {
  const { report, attempts = 1, largeGraph, graphs, edges, boundMs } = ctx;
  for (let attempt = 1; ; attempt += 1) {
    const outcome = await busyAttempt(ctx, pub, big, { attempt, attempts });
    if (!outcome.again) return outcome.heldInAll;
    // The next transfer must hold the slot for as long as a write can take to arrive, not only as long as the last
    // writes took. With no window measured (the transfer was over before the writes), the next graph is at least
    // twice as large.
    const { heldMs, neededMs } = outcome.measured;
    const size = nextLargeSize(big.size, { heldMs, neededMs: Math.max(neededMs ?? 0, boundMs) }, { ...(neededMs === null ? { minGrowth: 2 } : {}), ...ctx.sizing });
    const sizing = size.expectedHoldMs === null ? 'no rate was measured' : `sized to hold the slot about ${seconds(size.expectedHoldMs)} s at the rate measured`;
    report.note(`case 6, attempt ${attempt} of ${attempts}: ${outcome.why}; attempt ${attempt + 1} transfers a large graph of ${sizeText(size)}, ${sizing}`);
    try {
      // Member 2 stops following the last large graph: its periodic pulls of it would hold a reserved slot.
      if (outcome.subscribed !== false) await graphs.unsubscribe(edges.member2, big);
      big = await largeGraph(attempt + 1, size);
    } catch (error) {
      outcome.judge();
      return report.fail(6, `the large graph of attempt ${attempt + 1} could not be set up: ${error?.message ?? error}`);
    }
  }
}

/**
 * One attempt of case 6 (see busyMember). Reports the attempt and returns
 * { again: false, heldInAll (see busyMember) } when it is judged as the case;
 * returns { again: true, why, measured: { heldMs, neededMs }, judge } when
 * another attempt is to follow: `judge` reports it as the case after all (when
 * the next one cannot start), and `subscribed: false` says member 2 never
 * joined this attempt's graph.
 */
async function busyAttempt(ctx, pub, big, { attempt, attempts }) {
  const { devnet, edges, io, report, precondition, boundMs, sub, admitMs = 60_000, idleMs = 1_500 } = ctx;
  const { owner, member1, member2 } = edges;
  const last = attempt >= attempts;
  const of = attempts > 1 ? `, attempt ${attempt} of ${attempts}` : '';
  try {
    await ctx.connect?.();
  } catch (error) {
    report.fail(6, `${error?.message ?? error}${of}`);
    return { again: false };
  }
  await precondition(6, `before the large transfer${of}`);
  const offset = devnet.logSize(member2);
  const isTransfer = admission => admission.label.includes(`:${big.id}:`);
  const isPublic = admission => admission.label.includes(`:${pub.id}:`);
  // A pull takes the general slot when it is free and otherwise the reserved
  // shared-memory slot, so the subscribe waits for a moment when member 2's
  // general slot is free (its other graphs' pulls come and go). Its catch-up
  // asks one peer at a time (DKG_CATCHUP_MAX_CONCURRENT_PEERS=1,
  // temporary-edges.mjs): the pull from the node that holds the large graph
  // is the transfer, and the other peers' empty pulls of it continue it.
  await waitFor(() => ({ ok: generalSlotIdleFor(readTrace(member2.trace), Date.now()) >= idleMs }), 60_000, 250);
  // A subscribe can be refused for a moment, until the node has the graph's
  // authority (as keepCoresOut knows). One that keeps being refused ends this
  // attempt and not the run: the cases after this one still have to run.
  const joined = await waitFor(async () => {
    try {
      await ctx.graphs.subscribe(member2, big);
      return { ok: true };
    } catch (error) {
      return { ok: false, why: error?.message ?? String(error) };
    }
  }, admitMs, 1_000);
  if (!joined.ok) {
    const why = `member2 could not subscribe to the large graph (${sizeText(big.size)}) within ${seconds(admitMs)} s: ${joined.why}`;
    if (last) {
      report.fail(6, `not exercised: ${why}${attempts > 1 ? ` in the last of ${attempts} attempts` : ''}`);
      return { again: false };
    }
    return { again: true, why, subscribed: false, measured: { heldMs: null, neededMs: null }, judge: () => report.fail(6, `not exercised: ${why}`) };
  }
  const admitted = await waitFor(() => {
    const held = heldTransfer(readTrace(member2.trace), isTransfer, { now: Date.now() });
    return { ok: Boolean(held.transfer), ...held };
  }, admitMs, 250);
  if (!admitted.ok) {
    const why = `member2's transfer of the large graph (${sizeText(big.size)}) did not hold its general sync slot within ${seconds(admitMs)} s of the subscribe (${admitted.why})`;
    // A transfer that held the slot too briefly, or took a reserved slot, may hold it as the case needs when it is longer.
    if (!last && ['young', 'reserved', 'ended'].includes(admitted.kind)) {
      const admissions = readTrace(member2.trace) ?? [];
      const first = admissions.find(admission => isTransfer(admission) && admission.slot === 'general');
      const chain = first ? transferChain(first, admissions, { isTransfer }) : [];
      const heldMs = chain.length ? chain.at(-1).heldUntil - chain[0].startedAt : null;
      return { again: true, why, measured: { heldMs, neededMs: null }, judge: () => report.fail(6, `not exercised: ${why}`) };
    }
    report.fail(6, `not exercised: ${why}${last && attempts > 1 ? ` in the last of ${attempts} attempts` : ''}`);
    return { again: false };
  }
  const from = Date.now();
  const handles = await Promise.all([
    io.writeAndWatch(6, owner, pub, null, 'owner while member2 is busy, root', [member2]),
    io.writeAndWatch(6, owner, pub, sub, 'owner while member2 is busy, sub-graph', [member2]),
    io.writeAndWatch(6, member1, pub, null, 'member1 while member2 is busy, root', [member2]),
  ]);
  const pairs = await watched(handles);
  const until = Date.now();
  // The evidence must reach past the last receipt check: the transfer's
  // release, or a `holding` line written after it (once a second).
  const settled = await waitFor(() => {
    const admissions = readTrace(member2.trace);
    return { ok: transferSettled(admitted.transfer, admissions, { until, now: Date.now(), isTransfer }), admissions };
  }, 5_000, 250);
  const busy = busySlotCovered({ transfer: admitted.transfer, admissions: settled.admissions, until, isTransfer });
  const receipts = pairs.map(pair => heldAt(pair));
  const verdict = attemptVerdict(receipts, busy);
  const chain = transferChain(admitted.transfer, settled.admissions, { isTransfer });
  const start = chain[0]?.startedAt ?? admitted.transfer.startedAt;
  const heldMs = busy.provenUntil === null ? null : busy.provenUntil - start;
  const pulls = Object.entries(admissionsBySlot(settled.admissions, isPublic, from, until)).map(([slot, count]) => `${count} in the ${slot} slot`);
  const log = devnet.logSince(member2, offset);
  const refused = log.split(`Sync backpressure rejected shared-memory:${pub.id}:`).length - 1;
  // A shared-memory read the node refuses answers like one that finds nothing; its log says which it was.
  const deniedReads = log.split(`Shared memory query denied for unauthorized or unconfirmed context graph "${pub.id}"`).length - 1;
  const readmitted = chain.length - 1;
  const heldText = busy.held ? `through every receipt check (${seconds(until - from)} s)` : `for ${busy.provenUntil === null ? 0 : Math.max(0, seconds(busy.provenUntil - from))} s of ${seconds(until - from)} s (then ${busy.reason})`;
  // How long the authors took to share the writes: the part of the window that is theirs, not member 2's.
  const shared = pairs.map(pair => (typeof pair.record.doneAt === 'number' ? `${seconds(pair.record.doneAt - from)} s` : 'not written')).join(', ');
  const noteText = `case 6${of}: member2's transfer of the large graph (${sizeText(big.size)}) held its general sync slot ${heldText}${readmitted > 0 ? `, taking it again at once ${readmitted} time(s)` : ''}; the writes were shared ${shared} after they started; member2's pulls of the public graph meanwhile: ${pulls.length ? pulls.join(', ') : 'none'}; refused for a busy slot: ${refused}; shared-memory reads of it member2 refused as unauthorized or unconfirmed: ${deniedReads}`;
  const judge = () => {
    for (const [i, pair] of pairs.entries()) {
      // A receipt counts only when the trace shows the transfer still holding the slot at or after it.
      if (verdict.late.includes(i)) {
        report.fail(6, `${describe(pair.record)} at ${member2.label}: held ${seconds(receipts[i] - pair.from)} s after the share, after the last trace line that shows the large transfer holding the slot (${busy.reason ?? 'no trace'}): not exercised`);
      } else report.reportPair(pair, { boundMs, definitionSeen: io.definitionSeen(pair.record.author, pair.record.graph) });
    }
  };
  // Another attempt can prove a write that arrived after the transfer gave up the slot; it cannot change a write
  // never received, nor a trace that no longer shows the transfer or shows another admission in the one general
  // slot at the same time as it (one that only took the slot between the transfer's admissions can be retried).
  const contradicted = chain.length === 0 || besideTransfer(chain, settled.admissions) !== null;
  if (verdict.exercised || verdict.missing.length > 0 || contradicted || last) {
    judge();
    report.note(noteText);
    const heldInAll = () => {
      const whole = transferChain(admitted.transfer, readTrace(member2.trace), { isTransfer });
      const end = whole.at(-1);
      if (!end) return `case 6${of}: the trace no longer shows member2's transfer of the large graph`;
      const past = Math.max(0, seconds(end.heldUntil - until));
      return `case 6${of}: member2's transfer of the large graph held its general sync slot ${seconds(end.heldUntil - whole[0].startedAt)} s in all${end.releasedAt === null ? ' so far' : ''}, ${past} s past the last receipt check`;
    };
    return { again: false, heldInAll };
  }
  report.note(noteText);
  const neededMs = Math.max(...verdict.late.map(i => receipts[i])) - start;
  const why = `${verdict.late.length} of its writes reached member2 only after the last trace line that shows the transfer holding the slot (${busy.reason ?? 'no trace'}), up to ${seconds(neededMs)} s after the transfer took it: not exercised`;
  return { again: true, why, measured: { heldMs, neededMs }, judge };
}
