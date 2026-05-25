# ADR 0001 — recreateProfile is admin-only

- Status: Accepted
- Scope: `packages/evm-module` · `Profile.recreateProfile`
- Related: PRD "Recreate Profile for an existing Identity (testnet recovery)"

## Context

After a testnet `ProfileStorage` redeploy, some nodes have an on-chain
`Identity` but no `Profile`. `recreateProfile` re-attaches a `Profile`
to such an `Identity`, reusing the existing `identityId` so that the
surviving `identityId`-keyed staking, conviction and sharding state
stays addressable.

Genesis `createProfile` is whitelist-gated and called by an
**Operational** key on a brand-new identity with zero stake. `Recreate`
is different: it acts on an `identityId` that may already carry
third-party delegated stake, and it sets the initial operator fee.

## Decision

`recreateProfile(address operationalWallet, …)` is gated `onlyWhitelisted`
and resolves + enforces the admin check in-body:

- The caller passes the node's **Operational wallet** — operators know this
  (it is the node's running key); the numeric `identityId` is internal and
  often unknown. The contract resolves
  `identityId = IdentityStorage.getIdentityId(operationalWallet)`.
- It then calls `_checkAdmin(identityId)`: `msg.sender` must hold that
  identity's **Admin** key. Authorization is the Admin key, exactly as
  before — the operational wallet is only an *identifier*, never the
  authorizer. A zero/unknown wallet resolves to `id 0` (no admin) and
  reverts, which also proves the `Identity` exists.
- The existing whitelist gate is preserved.

(Original draft took `uint72 identityId` directly, gated
`onlyAdmin(identityId)`. Changed to the operational-wallet form for
operator ergonomics — admins rarely know the numeric id — without
weakening authorization: the admin key is still enforced, just after
in-body resolution rather than via the modifier.)

## Rationale

An Operational ("hot") key must not be able to set the operator fee on a
stake-bearing node. A compromised hot key could otherwise re-price the
node's operator fee against its delegators. Restricting recovery to the
Admin key removes that vector while still letting honest operators
recover their nodes with a single transaction.

## Consequences

- Operators must control each bricked Identity's original Admin key to
  recover (operationally verified, off-chain).
- If testnet whitelisting is enabled, the bricked identities' **Admin**
  wallets must be whitelisted before recovery — the genesis flow
  whitelisted the Operational caller instead.
- **Sharding-table consistency (enforced).** `ShardingTableStorage`
  survives a ProfileStorage-only redeploy and caches `nodeId` per
  `identityId`. `recreateProfile` therefore *reverts* (`NodeIdShardingMismatch`)
  if the node is still in the ring (`nodeExists(identityId)`) and the
  supplied `nodeId` differs from the surviving ring entry. This is a
  **read-only** check — recovery deliberately does **not** rewrite ring
  state (out of scope; would touch ShardingTable). Honest recovery (same
  node, same `nodeId`) is unaffected; only a divergent `nodeId` is refused.

## Known limitations

- **Operator-fee history is not recoverable.** The pre-redeploy operator-fee
  schedule was Profile-resident and is gone. `recreateProfile` seeds a
  single fresh fee at recovery time (like genesis `createProfile`). For any
  **unclaimed pre-recovery epochs**, `StakingV10._claim` resolves the
  historical split via `getOperatorFeePercentageByTimestampReverse`, which
  now falls back to the new recovery-time fee — i.e. recovery can
  retroactively change reward splits for those epochs. This is **accepted
  as a known testnet limitation**: the data is unrecoverable on-chain, and
  a real (mainnet) event of this kind would be handled by a state
  migration, not this recovery path. Operationally: settle/claim all
  pre-recovery epochs before recovering, or accept reward drift for
  unclaimed ones.
