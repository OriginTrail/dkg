---
status: current
version: v10
audience: operator
doc_type: how-to
---

# Write preflight coalescing

Every write route checks that its target context graph exists, is writable on
this node and lets the caller write, before it does any work. That check (the
write preflight) reads the store several times. When many async share and
publish submissions target one graph at once, each repeated the same reads, and
under load those reads queued behind each other.

Concurrent preflights of one graph for one caller now share one probe. Who is
admitted does not change: a caller is judged on the policy as it stands when its
request arrives.

## What is shared

A request that finds a probe in flight for the same context graph **and the same
caller** joins it. Different callers never share, and neither do different
graphs: the allowlist is the graph's and the verdict is the caller's. A caller
the node cannot read as an address (`null`, an empty string, a malformed
address) is judged as no caller, and shares with no address.

A probe stops being joinable the moment something it watches may have changed:

- a write to the ontology graph, the agents graph or any context graph's
  `_meta` graph settles (a curator revokes an agent, a graph becomes private,
  a roster changes), or
- the graph's own subscription entry is written (subscribed, synced, its
  participant list). Any write counts, including one that puts an equal row back:
  a change that was made and then reverted cannot be told from no change, so it
  ends the probe too.

A request that arrives after such a change starts its own probe and never gets
the answer read before it. The callers that had already joined keep the earlier
answer: their requests were in flight when the change landed.

### A policy write whose outcome is unknown

A write to a policy source can end without telling the node whether it took
effect: the store's deadline passes, or the response is lost. A remote store may
still apply it afterwards, and nothing then reports that it did. A probe that
began between the timeout and that late commit has read the old policy, and a
request arriving after the commit would be given its answer.

So while such an outcome is unresolved, **nothing is shared**: every preflight
probes the store itself, exactly as with coalescing off. A request is never
joined to another probe, never served from the result cache and never leaves a
result in it. This holds for the **unresolved-write window** after the outcome is
reported: two minutes (120000 ms) unless `DKG_WRITE_PREFLIGHT_UNRESOLVED_WRITE_WINDOW_MS`
says otherwise. A further unknown outcome extends it. Sharing then resumes with a
fresh generation, so no probe that began inside the window can be joined. A write
that is confirmed, or that provably changed nothing, never stops sharing. A
subscription change is made in memory and has no unknown outcome.

While the window is open the requests are counted as `preflight_direct`. A store
that is slow enough to time out policy writes is slow for the probe reads too,
so the cost is that of coalescing off, for a short time.

#### The window is a policy, not a guarantee

The window is the node's own setting for the write preflight. It is **not**
derived from any store's deadline and does not change when a store's timeout
settings change. No store promises when it stops working on a write that its
caller gave up on: a read can be given a server-side deadline, but an insert or
an update is sent without one, so nothing bounds how late an abandoned write may
land. Two minutes is a best-effort estimate of that delay.

**What can still be missed.** If the store applies an abandoned policy write
*later* than the window, a request that arrives after the commit can still join a
probe that began before it landed, and be given the policy as it was. This lasts
for at most one probe's join lifetime after the commit, which is 10 seconds
(a probe in flight that long is not joined, and the result cache counts its TTL,
10 seconds at most, from the start of the probe). Probes that begin after the
commit read the new policy. Requests that were already waiting on an older probe
keep their answer in every case.

**Strict mode.** An operator who needs a guarantee instead of an estimate sets
`DKG_WRITE_PREFLIGHT_UNRESOLVED_WRITE_WINDOW_MS=0`. After any policy write with an
unknown outcome, sharing then stays off **for the rest of the process**: no join,
no cache hit and no cache store, whenever the late commit lands. The cost is that
from then on every preflight probes the store itself until the daemon is
restarted. A write that is confirmed does not bring sharing back, and the
ordinary rules apply until the first unknown outcome, so a node whose policy
writes are all confirmed loses nothing.

Some of the probe's reads are **not** watched: whether the graph exists
(`contextGraphExists`), whether it holds content yet, the persisted subscription
row, and an on-chain identity lookup. A change to one of these does not end a
probe, so a request that arrives after the change can still join a probe that
began before it and read the older state. That probe began no more than 10
seconds earlier, usually far less. A read started after the change would have
seen it; the shared one does not. The older answer is what the request would
have had if it had arrived a moment sooner, and a graph that is still catching
up is covered by the readiness wait below.

Two more rules keep a stale answer away:

- A probe that has been in flight for 10 seconds is not joined.
- The second pass of a write that waited for its graph to finish catching up
  always probes anew: it exists to see what the wait changed.

Store errors are unchanged. A failed probe fails every request that joined it,
each with the error it would have had, and the next request starts again.

## Switches

Set before the daemon starts; a change needs a restart. The daemon logs the
effective setting once at start (`Write preflight coalescing: on, result cache:
off, unresolved-write window: 120000 ms`; `unresolved-write window: strict` for
`0`).

| Variable | Default | Meaning |
| --- | --- | --- |
| `DKG_WRITE_PREFLIGHT_COALESCING` | on | `0`, `false`, `no` or `off` turns coalescing off: every preflight probes, exactly as before. |
| `DKG_WRITE_PREFLIGHT_CACHE` | off | `1`, `true`, `yes` or `on` keeps a fast-accepted probe for a short time (below). Needs coalescing. |
| `DKG_WRITE_PREFLIGHT_CACHE_TTL_MS` | `2000` | How long the cache keeps it, 100 to 10000 ms. Used only when the cache is on. |
| `DKG_WRITE_PREFLIGHT_UNRESOLVED_WRITE_WINDOW_MS` | `120000` | How long sharing stays off after a policy write whose outcome is unknown, in whole milliseconds. `0` is **strict**: sharing stays off for the rest of the process after such a write. A best-effort window, not a guarantee of the store (see above). Read whether or not coalescing is on. |

A value that is not recognized never turns a feature on by accident: a
mistyped `DKG_WRITE_PREFLIGHT_COALESCING` leaves coalescing **off**, a mistyped
`DKG_WRITE_PREFLIGHT_CACHE` leaves the cache off, and both are warned in the
daemon log. A TTL outside its range is clamped, and one that is not a number
falls back to the default, each with a warning. A window that is not a whole
number of milliseconds (`soon`, `-5`, `1.5`, `1e3`) falls back to 120000, with a
warning: to be strict, write `0` exactly, and check the startup line.

To roll back, set `DKG_WRITE_PREFLIGHT_COALESCING=0` and restart.

## Seeing how often it works

The `async_admission_usage` line counts what the coalescer did since the daemon
started: `preflight_flights` (probes started), `preflight_joins`,
`preflight_cache_hits`, `preflight_cache_stores` and `preflight_direct`. Every
request is counted once, so the share that did not read the store itself is
`joins / (flights + joins + cache hits + direct)` between two lines. See
[Backpressure observability](./backpressure-observability.md#write-preflight-coalescing).
A write to a policy graph ends every probe in flight, not only the target
graph's, so under heavy policy writes the join rate can be low; if it is low in
the mixed qualification cell, a per-graph generation is the refinement.

## The result cache

Off by default. When it is on, a probe that ended in a **fast accept** for a
caller is kept for the TTL and served to the same caller again, so a burst of
submissions by one agent reads the store once. It is kept only when it cannot
be stale in a way the daemon does not see:

- only a fast accept, for that caller, and only served to a request that would
  fast-accept it again: a refusal is never kept (it is cheaper to ask again
  than to go on refusing after the cause is gone);
- never an answer from a probe that found the store unavailable;
- never an answer that consulted the chain, which is the case when the graph's
  allowlist names an on-chain identity ID: it can change without any local write;
- dropped by any change that would stop a probe from being joined (above), and
  by the TTL, which counts from the start of the probe;
- neither read nor written while a policy write's outcome is unknown (above), which with a strict window is for the rest of the process;
- at most 256 entries, the oldest first.

Enabling it needs a staleness review first (OT-RFC-73 decision D-10). What the
cache cannot see is a change that reaches the node without passing through its
store, and the first `TTL` after one is the window it can serve the old answer.

## Store pressure in the follow-up reads

After the probe, the preflight reads whether the named graph is writable here
and, for trusted local callers, whether it exists locally. When the store
refuses one of those reads (scheduler `queue_full` or `queue_wait_timeout`, or a
store deadline) the route now answers a retryable **`503`** with
`Retry-After: 1`, like every other store read, instead of `500`:

```json
{
  "code": "STORE_SCHEDULER_BUSY",
  "reason": "queue_wait_timeout",
  "priority": "normal",
  "retryable": true,
  "outcome": "not_started"
}
```

A store deadline carries `code: "STORE_OPERATION_TIMEOUT"` and
`outcome: "indeterminate"`. Any other failure of these reads is still a `500`.
The `async_admission_usage` line counts the refusal against the route's
`write_preflight` phase.
