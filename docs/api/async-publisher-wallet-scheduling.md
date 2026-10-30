# Async publisher wallet scheduling

The daemon rotates sparse publishing work across free publisher wallets. Required funding
observations start concurrently through one scheduling capability, which returns a
wallet-bound attempt. Direct processing uses that same preparation path. The runner orders wallet
selection and durable claims, then releases that scheduling turn immediately after the claim
is recorded: up to all configured wallets can execute concurrently. A busy wallet is skipped;
wallets with different service times are not expected to finish equal numbers of jobs.

Wallet scheduling does not estimate funding at startup or before a claim. Every configured,
free wallet outside cooldown may attempt the next job. `AsyncLiftWalletCooldown` only paces
wallets after a recognized native-gas failure: it excludes that wallet for 30 seconds, then
permits another actual-job attempt without a funding probe, top-up notification or new enqueue.
An elapsed cooldown never authorizes a signature or releases transaction ownership. A later
deferral is rechecked under the canonical claim lock and cannot be bypassed by an older
prepared scheduling attempt. Cooldowns are process-local; durable locks and chain recovery
remain authoritative across restarts.

Transaction preparation retains the existing job-specific gas estimate, gas-limit buffer,
fee floors/caps and TRAC/PCA handling. Immediately before signing, the async runtime reads
the pending balance and checks the prepared execution-gas maximum (`gasLimit * maxFeePerGas`,
or legacy `gasPrice`, plus native value). There is no assumed one-million-gas threshold,
previous-job estimate, observation cache or advisory fee RPC. This local calculation does not
separately estimate Base's L1 data or operator fee; it is not a guarantee of complete all-fee
affordability. Native-fee rejections during preparation can use the same proven pre-dispatch
recovery, while an error after the durable transaction boundary remains recovery-owned.
No new fee buffer or oracle subsystem is introduced.

Concurrent preparations share a lightweight queue existence read; payload selection and
retry promotion remain under the canonical claim lock. If all wallets fail actual funding
checks, the original jobs return unsigned to accepted and the wallets cool down. Later attempts
recheck the actual job; a replenished wallet can complete it without resubmission. This can
repeat validation, RPC and storage-ACK work when wallets remain underfunded. A separate TRAC
approval may already have occurred before a publication's cost check; its existing handling
is unchanged. Healthy wallets and distinct jobs still execute concurrently.

The chain's funding selector marks a native shortfall only when every refreshed candidate
has a known native balance at or below its configured gas floor. The publisher recognizes
that marker and the immediate native-gas cause of the chain's own funding-error wrapper;
arbitrary cause chains are not followed. A recognized native-gas
error can return the same logical job to the accepted queue only if the fenced
worker proves the publish was never dispatched and the durable job carries no transaction
history. The immutable request, admission identity and original acceptance timestamp stay the
same. The claim/recovery journal records the transition and previous wallet. Historical failed
jobs are not silently revived. Job-specific TRAC/PCA shortfalls keep the existing terminal failed-job contract, allowing
later affordable jobs to proceed. Automatic and manual retry do not revive those terminal
failures; the existing guarded clear/resubmit path remains available after funding repair.
Native-gas eligibility cannot establish that a particular publication has enough TRAC or PCA coverage.

The runtime explicitly selects `fundingRecoveryPolicy: 'proof-first'`. Library consumers keep
the legacy failure policy by default; installing wallet cooldowns does not change that
durable recovery contract. Both execution paths use the same failure-disposition decision.

A signed transaction already recorded by the write-ahead boundary is different. Insufficient
funds reported after that boundary does not erase its hash or release its nonce. A prior
endpoint could have accepted the transaction before another endpoint rejected it. Existing
chain reconciliation decides its outcome. A missing receipt, replenished balance or elapsed
cooldown does not prove absence; create absence requires the existing finalized nonce and
unminted-identity proof, and updates retain their stricter recovery rules.

## Diagnostics

Set `DKG_ASYNC_PUBLISH_TRACE=1` on the daemon to emit the bounded
`async_publish_claim_trace` events. Wallet and claim epoch identifiers are hashed.

| Measurement | Events/fields |
| --- | --- |
| Per-wallet claims | `claim_outcome`, `result: claimed`, job ID and claim epoch |
| Completions/failures | `wallet_job_settled`, job ID, status and failure code; deduplicate repeated observations by job/status |
| Wallet busy duration | Join `wallet_lock_written.acquiredAt` with `wallet_lock_deleted.wallTimeMs` for the same wallet/job; heartbeat writes keep the original acquisition time |
| Wallet cooldown | `wallet_funding.reason`, `observedAt` and `retryAt` for actual-failure cooldowns |

These events expose scheduling and ownership separately. Receipt proof can release nonce
ownership while local finalization continues, so busy duration is not the same as end-to-end
publication latency. Diagnostic failures cannot grant claims, undo durable writes or change
the publish outcome. Raw RPC errors, signed transactions and wallet keys are not emitted by
these scheduling events.

An existing terminal `insufficient_funds` job is skipped by both automatic and manual retry.
After repairing its funding, an operator can use the existing guarded clear and resubmit flow.
This change does not revive historical terminal jobs.
