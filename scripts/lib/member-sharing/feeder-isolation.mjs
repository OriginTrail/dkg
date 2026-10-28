/** A feeder that ran must not follow the public graph (`publicGraph`), as no Core may: its gossip could carry writes. */
export async function auditFeederIsolation({ edges, graphs, fail }, publicGraph, when) {
  const fed = await graphs.following(edges.feeder, publicGraph);
  if (fed.state === 'following') fail(2, `${when} the feeder ${edges.feeder.label} follows the public graph: its gossip may have carried writes`);
  else if (fed.state !== 'not-following') fail(2, `${when} it is not known whether the feeder ${edges.feeder.label} follows the public graph (${fed.reason ?? fed.state})`);
}

