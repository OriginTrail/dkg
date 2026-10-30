# Async publisher wallet scheduling

The daemon rotates sparse publishing work across free publisher wallets. Required funding
observations start concurrently through one scheduling capability, which returns a
wallet-bound attempt. Direct processing uses that same preparation path. The runner orders wallet
selection and durable claims, then releases that scheduling turn immediately after the claim
is recorded: up to all configured wallets can execute concurrently. A busy wallet is skipped;
wallets with different service times are not expected to finish equal numbers of jobs.

The native runtime probes all configured wallets once during publisher startup. A healthy
wallet then relies on the existing transaction preparation and the exact maximum-cost
balance check immediately before signing a publish or update. It does not repeat advisory
fee/balance probes for every healthy job. A recognized native-gas failure revokes eligibility
and defers the wallet for 30 seconds. After that delay, a fresh advisory observation must succeed
before it becomes eligible again; unavailable reads wait five seconds instead of classifying
an RPC outage as insufficient funds. A balance can change after any routing observation,
so the exact pre-sign check remains authoritative throughout.

`AsyncLiftWalletFunding` keeps `before-claim` as its library default: eligible observations
expire after five seconds and refresh outside the canonical lock before a synchronous
freshness check inside it. The native runtime explicitly selects `after-failure` and completes
its first probes before exposing publisher availability. A positive observation in that mode
means that no later native-gas failure has revoked it; its age is not current affordability proof.
The runner preserves free-wallet rotation and concurrent execution in both modes.

Advisory observations overlap independent block, priority-fee and pending-balance reads and
reuse the canonical fee arithmetic, configured floors and caps. Their initial gas budget is
1,000,000 gas; preparation replaces the estimate with its actual buffered gas limit. The
estimate can conservatively defer a wallet that could afford a smaller transaction. Approval
transactions retain their existing handling. TRAC/PCA funding and authorization remain with
the existing publisher preparation.

Concurrent preparations share a lightweight queue existence read; payload selection and
retry promotion remain under the canonical claim lock. After the one-time startup probes,
empty queues do not cause funding RPCs. If every wallet is deferred, work stays accepted
under its original ID. A newly depleted wallet can briefly claim a job before the exact
execution checks detect the loss and safely return that same job to the queue. Adapters
without the optional native-gas observation capability retain their existing behavior.

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
the legacy failure policy by default; installing an eligibility observer does not change that
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
| Eligibility and age | `wallet_funding.reason`, `observedAt`, `ageMs`, `retryAt`, estimated required wei and observed balance |

These events expose scheduling and ownership separately. Receipt proof can release nonce
ownership while local finalization continues, so busy duration is not the same as end-to-end
publication latency. Diagnostic failures cannot grant claims, undo durable writes or change
the publish outcome. Raw RPC errors, signed transactions and wallet keys are not emitted by
these scheduling events.

An existing terminal `insufficient_funds` job is skipped by both automatic and manual retry.
After repairing its funding, an operator can use the existing guarded clear and resubmit flow.
This change does not revive historical terminal jobs.
