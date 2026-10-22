---
status: current
version: v10
audience: human+agent
doc_type: how-to
---

# Spend a Conviction Account on Services

A Publishing Conviction Account can also pay for services sold on the DKG, such as inference and query services, as [OT-RFC-27 (NeuroSymbolic Marketplace)](https://github.com/OriginTrail/OT-RFC-repository/tree/main/RFCs/OT-RFC-27_NeuroSymbolic_Marketplace) describes. The account's owner opts it in and assigns a buyer key, within caps that the buyer key consents to. The buyer key then funds service periods from the account.

A funded period moves no TRAC. Its cost, the period's value less the account's discount, is drawn from the account's allowance for the current billing window, then from its top-up buffer, and the same amount of the account's scheduled emission is labelled for services. A service seller verifies a funded period on chain before it serves it.

This feature is in the source tree, not yet in a released package: check [Feature availability](../references/availability.md) against your installed version. For the account itself, see [Publishing Conviction](publishing-conviction.md).

## Roles

| Node | Its key | Runs |
| --- | --- | --- |
| Owner node | Its primary operational wallet owns the account NFT. | `dkg ca services`, `assign` with the assignee's consent, `caps`, `revoke`, `advance-nonce` |
| Assignee node | Its buyer key: `chain.caBuyerAddress`, or by default its primary operational wallet. | `dkg ca consent`, `fund`, and `assign` with the owner's signature |

The buyer key must be one of the node's operational wallets: a local key in `wallets.json`, or a payer account of an [external signer](external-signer.md). It needs native gas for its transactions, and no TRAC. To use another wallet than the primary one, name it in `~/.dkg/config.json` and restart the node; the startup log names the buyer key:

```json
{ "chain": { "caBuyerAddress": "0x…" } }
```

One node can be both the owner and the assignee, and then runs every step itself. The reads (`contracts`, `mine`, `status`, `assignments`, `periods`, `labels`) run on any node. The writes need the node-admin token, which the CLI uses by default.

## Before You Start

```bash
dkg ca contracts
dkg ca mine
```

`dkg ca contracts` names the service contracts. A node whose chain has none answers every `dkg ca` command with `CA_UNAVAILABLE` (HTTP 503). `dkg ca mine` names the node's wallet and buyer key, and lists the accounts the wallet owns and those the buyer key is assigned on. If the owner node owns no account yet, [create one](publishing-conviction.md#create-a-pca).

## Opt the Account In

On the owner node:

```bash
dkg ca services <accountId> enable
dkg ca status <accountId>
```

The status shows `serviceSpending: on since …`, the discount, the current window's allowance, and the schedule: `exact` for an account created after the chain's schedule cut-over, `conservative basis` for an older one. Switching on is refused while the chain's schedule cut-over is not set (`ExactScheduleFromUnset`), while a protocol treasury is wired, and once the account has expired.

## Consent on the Assignee Node

The buyer key signs the caps it accepts. Nothing is sent:

```bash
dkg ca consent <accountId> --max-period 25 --max-window 100 --max-total 1000 \
  --expires 2026-12-01T00:00:00Z --out consent.json
```

The caps are amounts of cost, the allowance drawn after the account's discount, in TRAC:

| Option | Caps | Default |
| --- | --- | --- |
| `--max-period` | the cost of one period | required |
| `--max-inference` | the inference cost of one period | `--max-period` |
| `--max-query` | the query cost of one period | `0`: no query services |
| `--max-window` | the cost per billing window | `0`: no window cap |
| `--max-total` | the total cost of the assignment | required |
| `--max-period-days` | the longest period, in whole days | `31` |
| `--expires` | when the assignment expires: an ISO-8601 time with a zone, such as `2026-12-01T00:00:00Z` | required |

`--max-inference` and `--max-query` may not exceed `--max-period`, nor both be 0. `--max-total` must be at least `--max-period`, `--max-window` either 0 or at least `--max-period`, and `--expires` in the future.

The consent is EIP-712 typed data, a `ServiceAssignment` under the `DKGConvictionServices` domain, signed at the account's current assignment nonce. Without `--out`, the command prints it as JSON. The file holds no secret: hand it to the owner node.

## Assign the Buyer Key

On the owner node:

```bash
dkg ca assign <accountId> --consent consent.json
dkg ca assignments <accountId>
```

An assignment uses up the account's assignment nonce, so a consent assigns once: a repeat is refused with `InvalidAssignmentNonce`. Running the command again is therefore safe when its answer was lost; `dkg ca assignments` shows whether it landed. Assigning the same buyer key again, with a new consent, replaces its caps and starts its usage from zero.

**An owner whose key is not on a node**, such as a hardware wallet, signs the consent's `terms` with its own wallet (`eth_signTypedData_v4`), using the `domain` and `types` that `dkg ca contracts --json` prints and the primary type `ServiceAssignment`. The assignee node then sends the assignment, and consents by sending it:

```bash
dkg ca assign <accountId> --consent consent.json --owner-signature 0x…
```

**A buyer key whose signer refuses typed data** consents the same way, by sending the assignment with the owner's signature. That needs an owner who signs with a wallet of its own, as above: an owner node signs only by sending the assignment, which needs the assignee's signature. Without a consent, the file holds only the terms for the owner to sign: amounts in wei, `expiresAt` in unix seconds, and the account's current assignment nonce, which the `assignmentNonce(accountId)` view of the `ConvictionServiceStorage` contract that `dkg ca contracts` names returns:

```json
{
  "terms": {
    "accountId": "42", "assignee": "0x…",
    "maxCostPerPeriod": "25000000000000000000", "maxInferenceCostPerPeriod": "25000000000000000000",
    "maxQueryCostPerPeriod": "0", "maxCostPerWindow": "0", "maxTotalCost": "100000000000000000000",
    "maxPeriodSeconds": 2678400, "expiresAt": 1796083200, "nonce": "3"
  }
}
```

## Fund a Period

On the assignee node, write the period as a plan file, `plan.json`:

```json
{
  "periodSeconds": 2592000,
  "planDigest": "0x…",
  "buckets": [
    { "bucketId": "0x…", "serviceClass": "inference", "value": "10", "maxAskWeiPerUnit": "2500000000000" }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `periodId` | The period's id: 32 bytes of hex, unique per buyer key. Leave it out, and `dkg ca fund` writes a new one into the file before it sends anything. |
| `periodSeconds` | The period's length, at most the assignment's longest period. |
| `sessionKey` | Optional: an address the period records for the service; the zero address by default. |
| `planDigest` | 32 bytes that commit to the plan bought. The contracts record it without reading it; the seller checks it. |
| `buckets` | One or more, in strictly increasing order of `bucketId` (32 bytes each), each with a `serviceClass` of `inference` or `query`, a `value` in TRAC, and the highest ask it pays, `maxAskWeiPerUnit`, in wei per unit. |

The plan you bought from a service determines `planDigest` and the buckets, which its seller checks. Then fund the period:

```bash
dkg ca fund <accountId> --plan plan.json
```

Example output, from a local chain:

```text
periodId 0x7712…4885 is written to plan.json: running this command again repeats this period, and never funds a second one.
Funded period 0x7712…4885 from account 1:
  subscriptionId:   0xbb80…21b7
  txHash:           0x2cd9…09d8
  block:            326
  logIndex:         2
  assignee:         0xFABB…694a
  value:            10.0 TRAC
  cost:             7.0 TRAC (30.00% off)
  drawnFromWindow:  7.0 TRAC (window 0)
  drawnFromTopUp:   0.0 TRAC
  period:           2026-10-22T08:12:28.000Z to 2026-11-21T08:12:28.000Z
  fundedEpoch:      1
  sessionKey:       0x0000000000000000000000000000000000000000
  planDigest:       0x59b3…d576
  buckets:          1
    0x496d…f3ef  inference  10.0 TRAC  maxAskWeiPerUnit 2500000000000
```

Here 10 TRAC of services cost an account with a 30 % discount 7 TRAC of its allowance. A funding is checked against the caps stored at its block, and funds exactly one period, entirely or not at all.

**Running the command again is safe.** The `periodId` in `plan.json` is the period's idempotency key: a period already funded under it is answered as funded, and nothing is sent. So if the command reports `Outcome unknown`, because the node did not answer in time, run the same command again: it funds the period once at most. A refused funding sends nothing, and the same file funds its period once the cause is fixed. To fund another period, use a new plan file, or remove `periodId` from this one.

**Hand the funding to the seller.** The seller verifies the period from its own chain reads before it serves it: the `PeriodFunded` log at `txHash` and `logIndex`, emitted by the chain's `ServiceSubscriptions` contract, and the period stored under `subscriptionId`. It checks the buyer key, the plan digest, the dates and the buckets against the plan it sold.

## Inspect

```bash
dkg ca status <accountId>
dkg ca assignments <accountId>
dkg ca periods <accountId> [--offset <n>] [--limit <n>]
dkg ca labels <accountId> [--from <epoch>] [--to <epoch>]
dkg ca mine
```

`dkg ca assignments` shows each assignment's caps, state and usage. `dkg ca periods` lists the funded periods in funding order, 50 at a time by default and at most 100. `dkg ca labels` shows up to 120 epochs of the account's span, by default its first ones: each epoch's scheduled emission, the parts labelled for services (`baseLabel` from the window allowance, `topUpLabel` from the top-up buffer), and the epoch's pool, which a `serviceLabel` never exceeds.

## Change the Caps

On the owner node:

```bash
dkg ca caps <accountId> <assignee> --max-window 50 --max-total 1500
```

- Options left out keep their values, and equal caps send nothing (`unchanged`). The usage and the nonce stay as they are. The assignee's consent is not needed: the caps bound only what the account lets the buyer key draw.
- New caps apply from the next funding. Funded periods keep their records.
- Caps may go below the usage, which refuses fundings: a total cap below the usage refuses every funding until it is raised, and a window cap below the window's cost refuses fundings for the rest of that window.
- A later `--expires` does not renew an expired assignment; only a new assignment does.
- Terms that the buyer key signed at the current nonce and nobody submitted stay valid, and submitting them would replace the new caps and reset the usage. Run `dkg ca advance-nonce <accountId>` to rule that out.

## Revoke, Advance the Nonce, or Pause

On the owner node:

```bash
dkg ca revoke <accountId> <assignee>
dkg ca advance-nonce <accountId>
dkg ca services <accountId> disable
```

- `revoke` refuses the buyer key's new fundings at once and advances the nonce. Funded periods run to their end, because they are not refundable.
- `advance-nonce` makes terms that were signed and not submitted unusable.
- `services <accountId> disable` pauses service spending. Fundings are refused, assignments are kept, funded periods run to their end, and `enable` resumes it.
- Assignments survive a transfer of the account NFT, as its publishing agents do. The previous owner's signatures no longer verify. The new owner can revoke the assignments or switch service spending off.

## JSON Output

Every `dkg ca` command takes `--json` and prints the node's answer as it came: amounts as decimal strings of wei, most with a `…Trac` sibling for display. `dkg ca fund` prints its `periodId` line on stderr, so its standard output stays one JSON document.

## Refusals

A refused command prints the contract's error, the HTTP status, the error's arguments with amounts in TRAC, and what to do next, then exits with status 1.

| Error | HTTP | Means |
| --- | --- | --- |
| `NotAccountOwner` | 403 | The node's wallet does not own the account: run the owner's commands on the owner node. |
| `NotAssigned` | 403 | The buyer key holds no assignment on the account. |
| `InvalidAssignmentTerms` | 400 | The caps break a rule above; `reason` names the cap. |
| `InvalidAssignmentNonce` | 409 | The nonce moved after the consent was signed: sign a new consent. |
| `ServiceSpendingDisabled` | 409 | Service spending is off. |
| `AssignmentRevoked`, `AssignmentExpired` | 409 | Only a new assignment allows funding again. |
| `CapExceeded` | 409 | The cost is above the named cap. For the window and total caps, `attempted` includes the usage. |
| `InsufficientAllowance` | 409 | The current window has too little allowance left. |
| `LabelCapacityExceeded` | 409 | The account's remaining scheduled emission cannot cover the cost. |
| `InvalidFundingRequest` | 400 | The plan breaks a rule; `reason` names it. |
| `ExactScheduleFromUnset`, `ServiceFundingPausedTreasuryWired` | 503 | The chain cannot serve service spending now. |
| `CA_UNAVAILABLE` | 503 | The chain has no service contracts. |
| `CA_BUYER_KEY_UNAVAILABLE` | 503 | The node holds no signer for its buyer key. |
| `REMOTE_SIGNER_REJECTED` | 502 | The buyer key's external signer refused; the hint says how to allow the consent or send the assignment instead. |

## On a Local Development Chain

A local Hardhat deployment leaves the schedule cut-over unset, so `dkg ca services <accountId> enable` is refused with `ExactScheduleFromUnset`. Set it once, from the Hub owner, through `Hub.forwardCall` to `ConvictionServiceStorage.setExactScheduleFrom(<unix time>)`, and create the account after it, so that its schedule is exact. `packages/cli/test/ca-command-hardhat.test.ts` runs the commands of this page in its order against such a chain.

## API Routes

| Route | Purpose |
| --- | --- |
| `GET /api/ca/contracts` | The contracts, and the consent's EIP-712 domain and types. |
| `GET /api/ca/mine` | The accounts the node owns, and those its buyer key is assigned on. |
| `GET /api/ca/:id` | The status, read fresh. |
| `POST /api/ca/:id/services` | Switch service spending on or off. |
| `POST /api/ca/:id/consent` | Sign a consent with the buyer key. |
| `POST /api/ca/:id/assignments` | Submit an assignment. |
| `GET /api/ca/:id/assignments` | List the assignments. |
| `POST /api/ca/:id/assignments/:assignee/caps` | Change an assignment's caps. |
| `DELETE /api/ca/:id/assignments/:assignee` | Revoke an assignment. |
| `POST /api/ca/:id/nonce` | Advance the assignment nonce. |
| `GET /api/ca/:id/labels` | Labels per epoch. |
| `GET /api/ca/:id/periods` | List the funded periods. |
| `POST /api/ca/:id/periods` | Fund a period. |

Writes need the node-admin token; reads need any valid token. A node whose chain has no service contracts answers 503.
