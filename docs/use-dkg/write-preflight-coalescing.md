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
off`).

| Variable | Default | Meaning |
| --- | --- | --- |
| `DKG_WRITE_PREFLIGHT_COALESCING` | on | `0`, `false`, `no` or `off` turns coalescing off: every preflight probes, exactly as before. |
| `DKG_WRITE_PREFLIGHT_CACHE` | off | `1`, `true`, `yes` or `on` keeps a fast-accepted probe for a short time (below). Needs coalescing. |
| `DKG_WRITE_PREFLIGHT_CACHE_TTL_MS` | `2000` | How long the cache keeps it, 100 to 10000 ms. Used only when the cache is on. |

A value that is not recognized never turns a feature on by accident: a
mistyped `DKG_WRITE_PREFLIGHT_COALESCING` leaves coalescing **off**, a mistyped
`DKG_WRITE_PREFLIGHT_CACHE` leaves the cache off, and both are warned in the
daemon log. A TTL outside its range is clamped, and one that is not a number
falls back to the default, each with a warning.

To roll back, set `DKG_WRITE_PREFLIGHT_COALESCING=0` and restart.

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
