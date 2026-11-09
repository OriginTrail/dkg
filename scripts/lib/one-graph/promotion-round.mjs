// Case 4's round of promotions in the one-graph promotion suite
// (scripts/devnet-test-one-graph-promotion.mjs): the curator promotes each
// candidate report in turn, and a promotion carries only the report it
// selected. Every report not (yet) promoted is watched on every Edge, in
// shared memory and out of Verified Memory at every reading: the other
// reports for the whole round, each candidate until its own promotion is
// sent, and a candidate whose promotion was refused from then on.

/**
 * The round. `io` is the suite's reports (createReports), `nodes` the Edges
 * that must show each placement, `candidates` the written reports to promote
 * in turn, `others` the written reports not to promote, `promote(record)` the
 * suite's promotion check (resolves to when the promotion was confirmed, or
 * null), and `settle(handles)` the suite's way of waiting for watches and
 * reporting their pairs. Each promoted report must reach Verified Memory and
 * leave shared memory within the configured bound of its promotion. Resolves
 * to { promoted }, the candidates whose promotion was confirmed.
 */
export async function promotionRound({ io, caseId, nodes, candidates, others, promote, settle }) {
  // A report that must stay where it is: in shared memory, and in no reading of Verified Memory.
  const retention = (records, fromWhat) => {
    if (records.length === 0) return null;
    const options = { from: Date.now(), fromWhat, bound: Infinity };
    return io.watch(records.flatMap(record => [...io.pairs(caseId, record, nodes, 'kept', options), ...io.pairs(caseId, record, nodes, 'unpromoted', options)]));
  };
  const retained = [retention(others, 'start of the promotions')].filter(Boolean);
  const awaiting = new Map(candidates.map(record => [record, retention([record], 'start of the promotions')]));
  const promoted = [];
  const placements = [];
  for (const record of candidates) {
    // A candidate is watched like the others until its own promotion is sent: an earlier
    // promotion must not have carried it. Its watch, read at least once, ends and is judged
    // before the request.
    const own = awaiting.get(record);
    await own.readOnce();
    own.close();
    await settle([own]);
    const at = await promote(record);
    if (at === null) {
      retained.push(retention([record], 'refusal of its promotion'));
      continue;
    }
    promoted.push(record);
    const options = { from: at, fromWhat: 'promotion' };
    placements.push(io.watch([...io.pairs(caseId, record, nodes, 'vm', options), ...io.pairs(caseId, record, nodes, 'gone', options)]));
  }
  await settle(placements);
  for (const handle of retained) handle.close();
  await settle(retained);
  return { promoted };
}
