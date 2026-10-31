import { waitFor } from './devnet.mjs';

/**
 * A feeder that ran must not follow the public graph (`publicGraph`), as no
 * Core may: its gossip could carry writes. A node whose store is busy can fail
 * to answer: its listing gives up after 5 s, as an HTTP 500, and one operation
 * has held a feeder's store for 20 s, right after a transfer. So it is asked
 * again for up to `boundMs`, and the first answer that says either way decides.
 * One that says neither by then still fails: that is not proof it stayed out.
 */
export async function auditFeederIsolation({ edges, graphs, fail, note = () => {} }, publicGraph, when, { boundMs = 60_000, everyMs = 2_000 } = {}) {
  let unread = 0;
  let firstReason;
  const fed = await waitFor(async () => {
    const seen = await graphs.following(edges.feeder, publicGraph);
    if (seen.state === 'following' || seen.state === 'not-following') return { ok: true, ...seen };
    unread += 1;
    firstReason ??= seen.reason ?? seen.state;
    return { ok: false, ...seen };
  }, boundMs, everyMs);
  if (fed.state === 'following') fail(2, `${when} the feeder ${edges.feeder.label} follows the public graph: its gossip may have carried writes`);
  else if (fed.state !== 'not-following') fail(2, `${when} it is not known whether the feeder ${edges.feeder.label} follows the public graph (${fed.reason ?? fed.state})`);
  if (fed.ok && unread > 0) note(`${when} the feeder ${edges.feeder.label} could not say whether it follows the public graph ${unread} time(s) (first: ${firstReason}), then it did`);
}
