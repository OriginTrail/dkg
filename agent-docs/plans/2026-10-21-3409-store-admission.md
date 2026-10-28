# Issue 3409: store admission investigation and bounded improvement

Date: 2026-10-21. Status: implementing a qualified opt-in capacity policy; controlled comparisons complete. Owner: this chat; no delegated agents.
Branch: `codex/3409-store-admission-investigation`, starting at `a8df45838` from current `testnet-canary`. Existing PR #3397 remains separate and unmerged. User authorizes further investigation and improvements through the existing PR, a stack or an independent PR; no merge or production tuning is authorized.

## Outcome and evidence

Explain the relationship between #3409 and #3397, reproduce the admission boundary, and select a measured improvement before changing production policy. #3409 reports 248 samples with both normal slots occupied and queued work while ACK/health were idle. Four total slots reserve one each for ACK and health; ordinary work cannot borrow them. The report also shows a hot core/thread and CPU steal. Aggregate idle CPU and spare RAM/disk do not prove available parallel backend throughput. 312 missing diagnostic intervals are unknown, not healthy. The observer did not match specific requests to store holders, so their causal attribution remains open.

#3397 removes redundant projection invalidations. It does not alter admission and its previous live comparison did not reproduce sustained store pressure or demonstrate latency improvement. Repeated `agent.contextGraph.confirmedMeta.*` reads use direct canonical ASK queries and bypass that projection cache. A public metadata confirmation normally performs placeholder/private/public queries; a private definition normally takes two. Reduce repeated admission/HTTP boundaries without adding stale authority caching if a controlled backend comparison demonstrates benefit.

The scheduler file at source `7563618d2` and this current base is byte-identical. Merged #3396 adds bound async-share recovery and changes the lease-expiry aftermath for new bound jobs; it explicitly does not fix the original worker stall or retroactively repair ambiguous failures. Heartbeat writes still share the queue mutation mutex and normal store lane. Renewal delay and execution ownership require separate evidence.

## Design and scope decisions

- Preserve the four-slot ceiling, ACK/health reservations, queue limits/deadlines and duplicate-work fencing. Active store work is non-preemptible: lending every reservation cannot promise immediate reclaim. A naive borrowing change risks delaying health/ACK behind long requests.
- Prefer one independently reviewable fresh PR for a demonstrated reduction in canonical metadata reads. It has no dependency on #3397 and should be measured on current canary. Keep #3397's cache optimization and evidence intact.
- Candidate: compose canonical metadata proof patterns into one source-qualified query returning placeholder/private/public observations. Keep proof models shared with existing ASK builders and approved-member semantics; no SPARQL text slicing, TTL cache, relaxed authority or skipped persistence. Preserve cancellation, transient failure handling and live chain decisions. Do not implement this candidate unless benchmark/semantic exploration supports it.
- Scheduler borrowing/backend-specific capacity and lease-renewal changes are separate potential PRs, with their own safety/measurement gates.

## Executable chunks

1. Read full issue/current source and history; map scheduler, adapters, metadata confirmation and promote lease. Reproduce two normal holders plus queued normal with idle reserved lanes using real scheduler callbacks. Establish that higher ordinary admission can delay a non-preemptible health request. Save exact source and observations.
2. Establish a real Blazegraph controlled workload with current scheduler, same deterministic metadata and bounded concurrent confirmations. Measure completed requests, query counts, median/P90/P95, queue wait/rejections, ACK/health latency and process/backend resources. Compare baseline and prototype query grouping in alternating arms; retain failed/missing outcomes and correctness comparisons. No wallet or production service is needed for discovery.
3. If benefit and semantic equivalence are demonstrated, implement structured proof composition and focused tests on private/public/member/placeholder/incomplete/conflicting metadata, cancellation, errors and chain fallback. Keep authored code/tests near 500 lines or split if needed. If benefit is absent or semantics require broad redesign, retain investigation/report and stop implementation with a specific next experiment.
4. For a warranted implementation, run focused tests, build/types and required lint/size/routing checks. Validate real backend parity. If live publishing is necessary to make a latency claim, use the dkg-testnet skill, claim an existing batch and carry the native author allocator watermark. Do not imply a backend benchmark proves live publication throughput.
5. Save an evidence report explaining facts, causal limits, chosen PR boundaries and a staged follow-up experiment. Submit a justified fresh PR into testnet-canary and drive remote review/CI within github-pr-driver limits. Do not merge. Record the current head/review budget before observing.

## Measurement and review gates

The initial local comparison must use identical data and fixed concurrency, no discarded retries, consistent timing, warm-up outside measured windows, and all-job denominators. Include both private and public graphs, stable-authority and mutation transitions; do not equate fewer requests with lower backend CPU. Hardware observations are local and cannot reproduce Gnosis/hypervisor steal. A later live test must sustain queueing at the observed two-slot boundary, unlike the prior small-payload run, or explicitly report failure to reproduce.

Self-review (not independent): authority security requires canonical models and fail-closed malformed results; concurrent mutation must not allow an older cached proof; cancellation cannot leak slots. Admission changes must preserve immediate reserved capacity or explicitly quantify a bounded weaker contract. Lease investigation must preserve ambiguity and duplicate prevention. Remote review will provide independent review if implementation proceeds. No policy default increase before controlled evidence.

## Owned resources and continuation

Task scratch: `.tmp/3409/`, containing sanitized source responses, harness and logs. Current checkout is retained for PR work. Reuse local dependencies; any experiment container must have a task ownership label, isolated namespace/ports and a cleanup condition. Retain benchmark results/harness, remove only owned runtime containers after use. No funded wallet claim currently held. Next: build required local packages, reproduce scheduler partitioning, then benchmark proof-query grouping.

## Selected implementation after measurement

The user's follow-up explicitly prioritizes reconsidering the two-slot policy. The fixed-query/write comparison tested 2/4/6/8 ordinary slots with one ACK and one health reservation throughout, in forward/reverse order on four-CPU/4-GiB Blazegraph. All 3,072 confirmations and bookkeeping writes passed; moving 2 → 4 ordinary slots roughly doubled throughput while probe p95 stayed 16–19 ms. Eight ordinary slots increased probe tails. This is a local backend experiment, not production or end-to-end publication qualification.

Choose a fresh independent PR: `DKG_STORE_CONCURRENCY_POLICY=configured` lets the existing `DKG_STORE_MAX_CONCURRENT` explicitly set total capacity beyond the process CPU clamp. Budget 6 leaves four ordinary slots and the existing two reservations. Default CPU policy, queue limits/deadlines and constructor overrides remain unchanged; invalid/unknown policy retains CPU protection. Unsafe numeric process settings do not bypass the ceiling. The small opt-in change enables a bounded real-host qualification without universally increasing the incident-tested default. Its reproduction script and measured report are part of the PR.

A separate query-grouping prototype reduced mixed private/public confirmation queries 960 → 384 per 384 requests and roughly doubled backend throughput at the same two-slot limit. It is retained as `.tmp/3409/metadata-prototype.patch`, not shipped in the capacity PR. Strict placeholder/approved-member ordering, cancellation, mutation and canonical proof parity need their own implementation/security checks before a separate PR. Combining capacity and read reduction in one PR would obscure attribution.

Remaining verification: complete the portable benchmark on the restored baseline proof implementation, verify production singleton configuration and CPU-clamped fallback tests, build/lint/size checks, inspect final authored diff, then open the independent PR into testnet-canary and request otReviewAgent review. Lease instrumentation remains a separate follow-up. No funded wallet claim or production tuning is part of this capacity change.

## Local completion and handoff

The final portable comparison reproduces 2 → 4 ordinary-slot improvement (36.67 → 74.71 confirmations/s, cohort weighted), with no failures across 3,072 final calls. Three capacity campaigns passed 9,216 calls in total; the independent metadata prototype passed another 3,072. Sixty-four scheduler tests, storage/agent build/type/package checks, production shared-adapter integration, lint, size and whitespace checks passed. The portable namespaces and owned container are removed; no wallet claim or credential was used. The query prototype is preserved locally and excluded from the PR. Next: publish the fresh opt-in capacity PR and drive remote review/checks; leave #3397 and universal default tuning separate.
