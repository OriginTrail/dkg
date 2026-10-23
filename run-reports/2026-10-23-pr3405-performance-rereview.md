# PR #3405 performance rereview — 23 October 2026

## Outcome

Lupuszr's [review 5625589390](https://github.com/OriginTrail/dkg/pull/3405#pullrequestreview-5625589390) validates the directory-identity, response-EOF and queue/preparation corrections on foundation `214cd54df`, with no newly reproduced correctness blocker. The remaining fresh/mixed worker throughput P1 is valid and **remains open**. No owner acceptance of that cost has been given.

His three-pair native persistent-worker/blob/index/changelog recheck against base `9031533da` reports fresh writes **744.92 → 171.56/s** and mixed writes **2,502.07 → 729.85/s**. Both miss the proposed 80%-of-base throughput gate. Mixed small-write p95 improves **8.771 → 0.590 ms**; zero read failures. This establishes improved independent small-write progress without establishing throughput acceptance. Base does not provide the new per-blob persistence guarantee; required file/directory barriers cannot simply be removed to match its throughput.

## Rejected optimization experiment

A native macOS arm64 / Node 22.23.3 / pnpm 10.28.1 experiment kept each blob's same-writer file sync and coalesced only subsequent directory barriers. Each batch snapshotted completed writers; later arrivals waited for a later batch. A short instrumented probe reduced directory sync count but did not improve throughput.

The fuller comparison used the review's unchanged benchmark source and workload: persistent worker, blob/index/enabled-changelog decorators, 80 KiB literals, eight writers/two continuous small-query readers, 1,200 measured writes per case, fresh directories, three alternating pairs (control/candidate, candidate/control, control/candidate). Twelve cases / 14,400 measured writes completed with all write-count/user-graph-count assertions and zero-read-failure assertions passing. Setup/warmup, final flush and close are excluded as in the review harness.

| Workload | Unchanged `214cd54df`, writes/s by round | Directory-batch prototype, writes/s by round | Median control → prototype |
|---|---|---|---|
| Fresh | 282.26, 284.67, 291.85 | 239.98, 228.82, 244.46 | 284.67 → 239.98 (-15.7%) |
| Mixed | 1,154.62, 1,196.45, 1,163.75 | 952.78, 941.69, 1,058.27 | 1,163.75 → 952.78 (-18.1%) |

The prototype is **discarded**. No directory batching API or changed persistence rule is included in the PR. The experiment compares the fixed foundation to a prototype, **not to the target branch**; host load and controls differ from the review, so these numbers neither replace his measurements nor establish the proposed budget. Local diagnostic source, candidate patch and raw results are retained under ignored `.tmp/pr-3405-takeover/`.

## Stack and support scope

The foundation incorporates target `f9b5f2524` without changing its durability implementation. Stock managed Oxigraph remains uncertified. The dependent #3406 compatibility policy preserves healthy acknowledged-write completion and retries failed local writes, without a new restart-durability promise or custom engine. Embedded/worker snapshots and qualified Blazegraph remain the stronger supported contracts.

Performance requires a demonstrated contract-preserving improvement or an explicit owner-approved backend/workload budget before merge. Neither CI, previous targeted live recovery nor this rejected experiment closes that decision. The upper PR is being rebased and revalidated; the previous live result applies to frozen `a6a10f93d` and must not be represented as a new-tip test after integration changes.

## Updated foundation validation

Runtime dependency closure, dependent type/package contracts and prepared CLI build pass. Full storage:1,653 passed/107files,45environment-gated skips. Selected managed/runtime CLI:54 passed/4files, including actual stock-server writes and supervised restart while commitment remains absent. Lint, disabled-test audit (zero additions), source-size ratchets and git diff checks pass. No production source from the batching experiment remains. New foundation source changes are solely inherited from target f9b5f2524; authored changes are this evidence, execution plan and corrected managed-compatibility documentation.
