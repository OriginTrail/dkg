# RFC-64 M1 selective coverage evidence

This directory defines the closed, deterministic evidence boundary for the M1
three-process devnet harness. The process launcher is intentionally separate;
it will populate this contract from real Publisher, Edge, and Core processes.

The verifier passes only when all of these user-visible outcomes are proven:

- the corpus digest, network, exact Git/runtime manifests, and three distinct
  process peer IDs match a trust anchor supplied outside the evidence artifact;
- Publisher-owned source snapshots match the anchored corpus, so a receiver
  cannot redefine the VM or SWM state it is expected to receive;
- an Edge has no VM or SWM payload before the user selects a graph;
- an on-demand selection receives an exact point-in-time VM and SWM snapshot
  but does not advance after restart without another request;
- an always-on selection receives the first exact snapshot and advances to the
  second exact snapshot after restart;
- unselected public and private graphs remain payload-free on the Edge;
- automatic Core rounds never exceed the configured batch and never include a
  private graph;
- every public graph is eventually scheduled and converges to exact final VM
  and SWM heads, inventory digests, asset counts, and payload triple counts.

Edge results are bound to runtime subscription modes and distinct operation job
IDs whose completion records carry the exact resulting snapshot. After restart,
always-on work must come from the reconciler; on-demand payload remains at its
first snapshot but its process-local mode is absent until a second explicit user
request reactivates and advances it. Core results are
bound to scheduler-issued automatic jobs with an empty explicit selection list
and exact final-wave per-graph completion records. Every public graph must first
appear within the anchored coverage-round limit. Manual catch-up cannot be
relabeled as automatic evidence.

Metadata is allowed to exist for an excluded graph because chain and discovery
metadata are not corpus payload. Metadata-only responses can never satisfy a
required plane: `reportedComplete` is treated as an assertion, and the verifier
independently requires exact nonzero data, counts, heads, and inventory roots.

Run the bounded contract checks with:

```sh
pnpm test:m1:rfc64-selective-coverage:unit
pnpm typecheck:m1:rfc64-selective-coverage
```
