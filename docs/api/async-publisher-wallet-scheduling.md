# Async publisher wallet scheduling

The daemon rotates sparse publishing work across free publisher wallets. Funding observations
for free lanes start concurrently. The runner then orders wallet
selection and durable claims, then releases that scheduling turn immediately after the claim
is recorded: up to all configured wallets can execute concurrently. A busy wallet is skipped;
wallets with different service times are not expected to finish equal numbers of jobs.

The EVM publisher runtime checks current native balance and the current fee policy before a
new claim. Its initial advisory gas budget is 1,000,000 gas; preparation replaces that estimate
with the actual buffered gas limit. The estimate includes configured fee floors and fee caps.
It is a routing hint, not an affordability guarantee, and can conservatively defer a wallet
that could afford a smaller transaction. Immediately before signing a publish or update, the
runtime checks the exact prepared maximum gas cost (including transaction value) again.
Approval transactions retain their existing handling. TRAC/PCA funding and authorization
remain with the existing publisher preparation.

Insufficient gas or a funding failure defers a wallet for 30 seconds. A failed funding read
waits five seconds instead of treating an RPC outage as insufficient funds. After the delay,
the next attempt uses fresh observations; a funded result expires after five seconds and is
checked again after waiting for the canonical claim lock. Empty queues do not cause funding
RPCs. If no wallet is eligible, jobs remain accepted and visible with their original IDs.
Adapters without the optional native-gas observation capability retain their existing behavior.

A funding error can return the same logical job to the accepted queue only if the fenced
worker proves the publish was never dispatched and the durable job carries no transaction
history. The immutable request, admission identity and original acceptance timestamp stay the
same. The claim/recovery journal records the transition and previous wallet. Historical failed
jobs are not silently revived.

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
