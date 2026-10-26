# OT-RFC-27 NeuroSymbolic Marketplace — protocol-level prototype design

Status: implementation plan for branch `prototype/rfc27-marketplace-protocol`.
Scope: a devnet-testable, protocol-level prototype of the OT-RFC-27 marketplace
(https://github.com/OriginTrail/OT-RFC-repository/tree/main/RFCs/OT-RFC-27_NeuroSymbolic_Marketplace),
implemented natively in this monorepo (contracts + chain adapter + core protocol +
agent runtime + daemon routes + devnet suite), NOT as a route plugin. The existing
plugin prototype (P5, `OriginTrail/NeuroSymbolic-Marketplace` fork) settles buyer→seller
with direct ERC-20 transfers per period; this prototype implements the RFC's
protocol model instead: subscription TRAC funds a network query/inference reward
pool, sellers submit buyer-authorized receipt batches, the contract validates and
caps claims to funding (pro-rata), and the pool is distributed by the QIF blend of
finalized receipt value and stake-weighted QueryInferenceScore.

## What the prototype demonstrates end-to-end on devnet

1. Seller Core Node publishes machine-readable **offers as Knowledge Assets** in a
   **Marketplace Context Graph** (shared over SWM; buyers discover via SPARQL).
2. Buyer funds a **non-refundable period subscription** on-chain (one TRAC
   `transferFrom` into the pool) and registers a **session key** — no seller named.
3. Buyer's **Marketplace Router** selects a seller (plan policy + price caps +
   live quote), signs a **bounded, seller-specific authorization** with the
   session key, and sends the request off-chain over a new p2p protocol.
4. Seller executes (SPARQL query against its local graph, or a pluggable
   inference executor — deterministic stub on devnet), meters units, returns the
   **seller-signed result + QueryInferenceReceipt**.
5. Seller **batches receipts** (adaptive policy) and submits them on-chain; the
   contract verifies every buyer authorization (ecrecover against the registered
   session key), rejects objective faults (wrong seller, duplicate, expired, over
   max units), and records claims with the **stake factor captured at acceptance**.
6. After the settlement window, buckets are **finalized**: claims capped to the
   buyer's funded bucket, **pro-rated without submission-order priority**;
   finalized value feeds `R_i(e)` and `QueryInferenceScore_i(e)`.
7. Nodes **claim epoch rewards**: `G_i = pool(e) · QIF_i(e)` with
   `QIF = (1−λ)·R_i/ΣR + λ·Q_i/ΣQ`, λ a protocol parameter.
8. Buyer-local metering shows the RFC's one-plan/one-meter experience and the
   soft ceiling (serve stops at 95% of a bucket).

Out of scope (documented, per RFC "works in progress"): Conviction Account
funding (explicit migration required), attested-execution/TEE profile,
multi-seller composition per request, delegator-level reward distribution
(operator fee split via StakingKPI — prototype pays the gross node reward to the
node's operational wallet), fiat rails, production receipt-batch gas calibration.

## Units and precision

- All on-chain TRAC values are **wei (1e18)**, `uint96` for funded amounts
  (matches staking), `uint256` for accumulated values. Asks are **wei per unit**
  (`uint96`). Units (tokens / query units) are `uint64`. No floating point
  anywhere; TS side uses `bigint` exclusively for money/units.
- 18-decimal fixed point (`SCALE18 = 1e18`) for stake factor and QIF math,
  exactly like `RandomSampling.sol`.

## Shared cryptographic spec (MUST match byte-for-byte across Solidity and TS)

### Authorization digest (buyer session key → seller-specific bounded request)

```
AUTH_DOMAIN = "DKG_MKT_AUTH_V1"   (ASCII, no length prefix — abi.encodePacked)

authDigest = keccak256(abi.encodePacked(
    AUTH_DOMAIN,              // string literal
    chainId,                  // uint256 (block.chainid)
    marketplaceAddress,       // address (the Marketplace contract)
    buyer,                    // address (funding wallet, NOT the session key)
    sellerIdentityId,         // uint72
    offeringId,               // bytes32
    callId,                   // bytes32 (buyer-generated, single-use)
    epoch,                    // uint256 (Chronos epoch the bucket belongs to)
    maxUnits,                 // uint64
    askPerUnit,               // uint96 (wei per unit, the accepted ask)
    expiry                    // uint40 (unix seconds; authorization expiry)
))
signature = sessionKey.signMessage(authDigest)   // EIP-191 personal-sign over the
                                                 // 32 raw bytes ("\x19Ethereum
                                                 // Signed Message:\n32" + digest)
```

TS mirror with `ethers.solidityPackedKeccak256(["string","uint256","address","address","uint72","bytes32","bytes32","uint256","uint64","uint96","uint40"], ...)`
— note `uint72` packs as 9 bytes; follow `packages/core/src/crypto/ack.ts`'s
EIP-191 pattern (`eip191Hash`). Max receipt value is implicit:
`maxUnits * askPerUnit`.

### Receipt digest (seller → buyer, off-chain verifiability)

```
RCPT_DOMAIN = "DKG_MKT_RCPT_V1"
receiptDigest = keccak256(abi.encodePacked(
    RCPT_DOMAIN,              // string literal
    authDigest,               // bytes32
    servedUnits,              // uint64
    receiptValue,             // uint256 (= servedUnits * askPerUnit)
    resultCommitment          // bytes32 (sha256 of the raw result bytes)
))
sellerSig = sellerOperationalWallet.signMessage(receiptDigest)  // EIP-191
```

The contract does not verify `sellerSig` (the submitting tx's `msg.sender` must
be an operational wallet of the seller identity — that IS the seller signature);
the buyer verifies `sellerSig` off-chain before trusting the receipt, and the
`resultCommitment` is stored in the claim event for audit.

## 1. Contracts — `packages/evm-module`

### `contracts/storage/MarketplaceStorage.sol` (`HubDependent`, writes `onlyContracts`)

State (keyed types below; names indicative):

- Params (setters `onlyOwnerOrMultiSigOwner`-equivalent via Hub owner, following
  ParametersStorage conventions but scoped here to avoid touching ParametersStorage):
  - `lambdaQif18` (uint256, default 0.4e18) — λ_QIF.
  - `settlementGraceSeconds` (uint256, default epochLength/4 set at deploy) —
    receipts for epoch `e` are accepted until `epochEnd(e) + grace`; finalization
    and reward claims happen after that deadline.
  - `softCeilingBps` (uint16, default 9500) — node-side guidance, stored for
    discoverability (contract does not enforce it).
- Buckets: `bucket[buyer][epoch] = { funded (uint96), totalClaimed (uint256),
  totalFinalized (uint256), finalized (bool) }` plus `bucketSellers[buyer][epoch]`
  (uint72[] of claimant identityIds) and
  `sellerClaims[buyer][epoch][identityId] = { claimed (uint256), qiRaw (uint256) }`
  (`qiRaw` = Σ claimValue·S18/1e18 captured at acceptance).
- Session keys: `sessionKeyOwner[sessionKey] = buyer`,
  `activeSessionKey[buyer] = sessionKey`.
- Replay: `consumedAuth[authDigest] = bool`.
- Epoch accounting: `epochPool[epoch]` (uint256), per-epoch buyer list
  `epochBuyers[epoch]` (address[], first funding pushes), open-bucket counter
  `openBuckets[epoch]` (uint256), `nodeFinalizedValue[epoch][identityId]` (R_i),
  `nodeQiScore[epoch][identityId]` (Q_i), `epochTotalFinalizedValue[epoch]`,
  `epochTotalQiScore[epoch]`, `rewardClaimed[epoch][identityId]`.

### `contracts/Marketplace.sol` (`ContractStatus`, `INamed`("Marketplace"), `IVersioned`("1.0.0"), `IInitializable`)

`initialize()` binds via Hub: `Token`, `IdentityStorage`, `ShardingTableStorage`,
`ParametersStorage`, `ConvictionStakingStorage`, `Chronos`, `MarketplaceStorage`.

External functions:

- `fundSubscription(uint96 amount, address sessionKey, uint256 epoch)`
  — `epoch` must be current or current+1 (Chronos); `token.transferFrom(msg.sender,
  address(this), amount)`; `bucket.funded += amount`; `epochPool[epoch] += amount`;
  first funding of a (buyer, epoch) pushes buyer onto `epochBuyers[epoch]` and
  increments `openBuckets[epoch]`; registers/rotates `sessionKey` for buyer
  (zero address = keep current). Emits `SubscriptionFunded`. Non-refundable by
  construction (no withdrawal path).
- `submitReceiptBatch(ReceiptClaim[] calldata claims)` where
  `ReceiptClaim { address buyer; uint256 epoch; bytes32 offeringId; bytes32 callId;
  uint64 maxUnits; uint96 askPerUnit; uint40 expiry; uint64 servedUnits;
  bytes32 resultCommitment; bytes authSignature; }`
  — resolves `identityId = identityStorage.getIdentityId(msg.sender)`, requires
  `identityId != 0` and the node to be in the sharding table (Core Node check);
  per claim (reject the whole batch on any objective fault — bounded batch size,
  e.g. `require(claims.length <= 100)`):
  - bucket exists (`funded > 0`) and `block.timestamp <= epochEnd(epoch) + grace`;
  - `block.timestamp <= expiry`; `servedUnits <= maxUnits`; `servedUnits > 0`;
  - recompute `authDigest`, require `!consumedAuth[authDigest]`, mark consumed;
  - `ecrecover` EIP-191 over `authDigest` must equal `activeSessionKey[buyer]`
    (use OZ `ECDSA.recover(MessageHashUtils.toEthSignedMessageHash(digest), sig)`);
  - `value = uint256(servedUnits) * askPerUnit`;
  - stake factor at acceptance: `S18 = Math.sqrt(min(effStake, maximumStake)·1e18/maximumStake · 1e18)`
    (exact math copied from `RandomSampling._calculateNodeScore` step 1, with
    `ConvictionStakingStorage.getNodeEffectiveStake(identityId)`);
  - accrue `sellerClaims.claimed += value`, `.qiRaw += value·S18/1e18`,
    `bucket.totalClaimed += value`; push identityId to `bucketSellers` on first
    claim; emit `ReceiptClaimed(buyer, epoch, identityId, offeringId, callId,
    servedUnits, value, resultCommitment)`.
- `finalizeBucket(address buyer, uint256 epoch)` — permissionless; requires
  `block.timestamp > epochEnd(epoch) + grace` and not yet finalized. If
  `totalClaimed <= funded`: finalized_i = claimed_i. Else pro-rata:
  `finalized_i = claimed_i · funded / totalClaimed` (floor; residue stays in the
  pool). For each claimant: `nodeFinalizedValue[epoch][id] += finalized_i`,
  `nodeQiScore[epoch][id] += qiRaw_i · finalized_i / claimed_i`; update epoch
  totals; `bucket.finalized = true`; decrement `openBuckets[epoch]`. Emits
  `BucketFinalized`.
- `claimEpochReward(uint72 identityId, uint256 epoch)` — requires
  `block.timestamp > epochEnd(epoch) + grace`, `openBuckets[epoch] == 0`,
  `epochTotalFinalizedValue[epoch] > 0`, not already claimed, and `msg.sender`
  to be an operational wallet of `identityId`. Computes
  `qif18 = (1e18 − λ)·R_i·1e18/ΣR/1e18 + λ·Q_i·1e18/ΣQ/1e18` (careful fixed-point
  ordering: `((1e18−λ)·R_i/ΣR) + (λ·Q_i/ΣQ)` with 18-dec scaling),
  `reward = epochPool[epoch] · qif18 / 1e18`, marks claimed, transfers TRAC to
  `msg.sender`. Emits `EpochRewardClaimed`. (Operator-fee/delegator split via
  StakingKPI is documented follow-up; prototype pays gross node reward.)
- `rollEpochPool(uint256 epoch)` — permissionless; requires deadline passed,
  `openBuckets[epoch] == 0`, `epochTotalFinalizedValue[epoch] == 0`,
  `epochPool[epoch] > 0`: moves the pool to the current epoch (RFC: funded
  period with no finalized receipt value rolls forward).
- Views: `getBucket`, `getSellerClaim`, `getNodeEpochAccounting(epoch, id)
  → (R_i, Q_i, ΣR, ΣQ, pool, claimed?)`, `getQif18(epoch, identityId)`,
  `settlementDeadline(epoch)`, `activeSessionKey(buyer)`, params getters.

### Deploy scripts

`deploy/active/058_deploy_marketplace_storage.ts` and
`deploy/active/059_deploy_marketplace.ts` using `hre.helpers.deploy({newContractName})`,
with `func.tags` and `func.dependencies` (Token, IdentityStorage,
ShardingTableStorage, ParametersStorage, ConvictionStakingStorage, Chronos,
MarketplaceStorage). Follow `017_deploy_ask_storage.ts` / `020_deploy_ask.ts`
shape. Check whether `998_initialize_contracts.ts` needs the new names added.

### Contract tests

Hardhat test under `packages/evm-module/test/` following existing conventions
(check how Ask/RandomSampling are tested; use the repo's fixture/deploy helpers):
fund→claim→finalize→reward happy path; pro-rata over-claim; replay rejection;
wrong-seller rejection (digest binds identityId); expired auth; session key
rotation; non-core seller rejection; pool rollover; λ edge values (0 and 1e18).

### ABI vendoring

After `pnpm --filter dkg-evm-module compile`:
`node scripts/sync-chain-abis.mjs Marketplace MarketplaceStorage` (vendored into
`packages/chain/abi/`; `packages/chain/test/vendored-abi-sync.unit.test.ts` enforces).

## 2. TS domain package — `packages/marketplace` (`@origintrail-official/dkg-marketplace`)

Pure domain logic, no daemon imports. Dependencies: `ethers` + workspace core
only if needed (prefer zero workspace deps; digests via ethers).
Scaffold copied from `packages/http-utils` (package.json shape, tsconfig extends
`../../tsconfig.base.json`, vitest config with
`coverageForUnbaselinedPackage('marketplace')` from `../../vitest.coverage.ts`).

- `src/types.ts` — `MarketplaceOffer { offerId (UAL string), sellerIdentityId
  (bigint), sellerPeerId (string), sellerAddress? , offeringId (bytes32 hex),
  serviceType 'inference'|'query'|'reasoning'|'graph-ml', modelId?, unit
  'token'|'query-unit', askPerUnitWei (bigint), capacityUnitsPerMin?, expiresAt?,
  region?, transports? }`, `PlanPolicy { totalBudgetWei, buckets:
  [{ match: {serviceType, modelId?}, budgetWei, priceCapWeiPerUnit,
  maxUnitsPerCall }], sellerAllow?/sellerDeny?, softCeilingBps=9500 }`,
  `BoundedAuthorization` (all authDigest fields + signature),
  `QueryInferenceReceipt { authDigest, servedUnits, receiptValueWei,
  resultCommitment, sellerSig }`, `ReceiptClaimInput` (what the contract takes),
  `MeterState`, `RouteDecision`.
- `src/digests.ts` — `computeAuthDigest(fields)`, `computeReceiptDigest(fields)`,
  `eip191Sign/RecoverDigest` helpers; `offeringIdFor(string)` = keccak256(utf8).
  MUST implement the exact spec above; include fixed test vectors in tests so
  the Solidity side can assert the same vectors.
- `src/session-key.ts` — create session key from 32 random bytes
  (`node:crypto randomBytes` → `new ethers.Wallet(hex)`; do NOT use
  `Wallet.createRandom` — repo audit bans it), persist/load JSON
  `{ privateKey, address, createdAt }`, sign authorizations.
- `src/router.ts` — `selectRoute(offers, quotes, policy, meter, request)`:
  filters by serviceType/model/price-cap/allow-deny/capacity/expiry, enforces
  soft ceiling (remaining bucket · softCeilingBps/10000 must cover worst-case
  `maxUnits·ask`), picks lowest ask (tie: better local delivery history, then
  lexicographic peerId for determinism). Pure function.
- `src/metering.ts` — buyer meter: bucket accounting (bigint), reserve at
  admission / settle on receipt / void on failure; `meterSummary()` for the RFC's
  "used · remaining · resets" line. Unit counting helpers:
  `countTokens(text) = ceil(utf8Bytes/4)` (deterministic prototype tokenizer,
  both sides use it), `queryUnits(sparql, rowCount) = 10 + ceil(bytes/100) + rows`
  (static schedule, documented).
- `src/batching.ts` — `ReceiptBatcher`: accumulates receipts per epoch, decides
  submission on `maxBatchSize` / `maxDelayMs` / bucket-exposure thresholds
  (adaptive: exposure > threshold → submit now). Pure decision + injected clock.
- `src/receipts.ts` — build/verify receipts (seller + buyer sides),
  `verifyReceiptAgainstAuthorization`.
- `src/index.ts` — exports everything.
- `test/*.test.ts` — digest vectors (fixed hex expectations), router policy
  matrix, metering reservation/settle/void, batcher decisions, pro-rata mirror
  of contract math (same floor semantics), soft ceiling.

## 3. Core protocol — `packages/core`

- `src/constants.ts`: `PROTOCOL_MARKETPLACE_QUOTE = '/dkg/10.0.1/marketplace-quote'`,
  `PROTOCOL_MARKETPLACE_SERVE = '/dkg/10.0.1/marketplace-serve'` (Messenger-prefix
  semantics), plus `MARKETPLACE_CONTEXT_GRAPH = 'marketplace'` name constant and
  a `marketplaceOfferGraphUri()` helper if the KA helpers need one (follow
  existing graph-URI builders; offers live as ordinary KAs in the CG, so likely
  no new URI builder is needed).
- `src/proto/marketplace.ts` — protobufjs codecs (follow `proto/storage-ack.ts`):
  - `MarketplaceQuoteRequest { offeringId (bytes) }` /
    `MarketplaceQuoteResponse { available (bool), askPerUnitWei (string),
    capacityUnitsPerMin (uint64), declineCode (string) }`
  - `MarketplaceServeRequest { version (uint32), buyer (bytes, 20),
    sellerIdentityId (string decimal), offeringId (bytes, 32), callId (bytes, 32),
    epoch (uint64), maxUnits (uint64), askPerUnitWei (string), expiry (uint64),
    authSignature (bytes, 65), payloadKind (string 'inference'|'query'),
    payload (bytes, JSON) }`
  - `MarketplaceServeResponse { ok (bool), errorCode (string), servedUnits (uint64),
    receiptValueWei (string), resultCommitment (bytes, 32), sellerSignature
    (bytes, 65), result (bytes, JSON), authDigest (bytes, 32) }`
  Re-export from `proto/index.ts` and `src/index.ts` (mind the exports map).

## 4. Chain layer — `packages/chain`

- `src/chain-adapter.ts`: add marketplace methods to the `ChainAdapter`
  interface (all optional-capability style consistent with the codebase; include
  `supportsMarketplace(): boolean`):
  `marketplaceFundSubscription({amountWei, sessionKey, epoch})`,
  `marketplaceSubmitReceiptBatch(claims: ReceiptClaimInput[])`,
  `marketplaceFinalizeBucket(buyer, epoch)`,
  `marketplaceClaimEpochReward(identityId, epoch)`,
  `marketplaceRollEpochPool(epoch)`,
  `marketplaceGetBucket(buyer, epoch)`, `marketplaceGetSellerClaim(buyer, epoch,
  identityId)`, `marketplaceGetNodeEpochAccounting(epoch, identityId)`,
  `marketplaceGetActiveSessionKey(buyer)`, `marketplaceGetParams()`,
  `marketplaceSettlementDeadline(epoch)`, `getCurrentEpoch()` (reuse if an
  equivalent exists).
- `src/evm-adapter-marketplace.ts` — `MarketplaceMethods` mixin over
  `EVMChainAdapterBase`; bind contracts in base `init()` via
  `resolveOptionalHubBinding(() => bind('marketplace', this.resolveContract('Marketplace')))`
  (+ storage read binding if needed); `supportsMarketplace()` = binding present.
  TRAC `approve` before `fundSubscription` (token binding exists).
- Mix into `EVMChainAdapter` (`src/evm-adapter.ts`) + `export interface` merge.
- `src/mock-adapter.ts` — full in-memory implementation mirroring contract
  semantics (buckets, replay set, pro-rata, QIF with λ, epoch = configurable
  clock) so agent unit tests run chainless. `NoChainAdapter` —
  `supportsMarketplace(): false` + throwing stubs consistent with its style.
- ABI loading via `loadAbi('Marketplace')` (vendored JSON).
- Unit tests: adapter method encoding against a hardhat-deployed contract is the
  evm-integration lane's job; add mock-adapter tests + (if the repo pattern
  allows cheaply) an evm-integration file registered in
  `scripts/ci/evm-test-scopes.mjs` — only if conventions make it low-friction;
  otherwise devnet suite covers the real chain path.

## 5. Agent runtime — `packages/agent`

- `src/marketplace/` module (keep `dkg-agent-lifecycle.ts` edits minimal):
  - `seller-service.ts` — `MarketplaceSellerService`: holds offerings
    (`{ offeringLocalId, serviceType, modelId?, unit, askPerUnitWei, executor }`),
    registers `PROTOCOL_MARKETPLACE_QUOTE` + `PROTOCOL_MARKETPLACE_SERVE`
    handlers via the shared router/messenger, verifies the request auth sig
    locally (session key read via chain adapter `marketplaceGetActiveSessionKey`
    — cacheable), enforces its own per-callId replay guard, executes via the
    executor, meters with the shared counting helpers, caps `servedUnits` at
    `maxUnits` (truncate inference output to fit — fail closed if impossible),
    builds + signs the receipt (operational wallet), responds, hands the receipt
    to the `ReceiptBatcher`; a timer flushes batches through
    `chain.marketplaceSubmitReceiptBatch`.
  - `executors.ts` — `MarketplaceExecutor` interface
    `{ kind, execute(payload) → { resultBytes, unitsServed } }`;
    `createQueryExecutor(queryFn)` bridging to the node's local SPARQL (inject
    the agent's existing query entry point; count via `queryUnits`);
    `createStubInferenceExecutor()` — deterministic echo/transform with
    `countTokens` metering (devnet/testing); real LLM connectors are future
    node-side config.
  - `buyer-service.ts` — `MarketplaceBuyerService`: session key lifecycle
    (persisted under the node data dir), `subscribe({epoch, amountWei, policy})`
    → chain fund; `discoverOffers()` → SPARQL over the marketplace CG (local
    view; the node subscribes/syncs the CG — reuse existing CG subscribe/query
    machinery); `invoke({serviceType, modelId?, payload, maxUnits})` → quote →
    `selectRoute` → sign authorization → serve request over messenger → verify
    receipt (sig, commitment, units ≤ max, value math) → meter settle → return
    result + receipt; maintains delivery history for routing.
  - `offer-publisher.ts` — publish each offering as a KA into the
    `marketplace` context graph (create CG if missing via existing agent CG
    APIs; wm/write → finalize → swm/share with public access). RDF vocabulary:
    namespace `https://w3id.org/dkg/marketplace#` — `mkt:Offer`,
    `mkt:offeringId`, `mkt:serviceType`, `mkt:unit`, `mkt:askPerUnitWei`,
    `mkt:sellerIdentityId`, `mkt:sellerPeerId`, `mkt:modelId`, `mkt:expiresAt`.
- `src/dkg-agent-marketplace.ts` — `MarketplaceMethods` mixin exposing
  `marketplaceStatus() / marketplaceSubscribe() / marketplaceInvoke() /
  marketplaceDiscoverOffers() / marketplacePublishOfferings() /
  marketplaceSettle({finalize buyers?, claim epoch}) / marketplaceMeter()`;
  added to the `applyMixins` list + `DKGAgent` interface merge in
  `dkg-agent.ts`.
- Lifecycle: in `dkg-agent-lifecycle.ts`, behind `config.marketplace?.enabled`
  (`DKG_MARKETPLACE_ENABLED` boolean env override via the existing
  `resolveBooleanEnvOverride` pattern in CLI config mapping), construct the
  services after messenger setup and register handlers; no-op when disabled or
  when `!chain.supportsMarketplace()` (log once).
- Config: `DKGAgentConfig.marketplace?: { enabled: boolean; seller?: {
  offerings: OfferingConfig[] }; buyer?: { } }` in `dkg-agent-types.ts`.
- Unit tests with `MockChainAdapter` + in-process messenger pair (follow
  existing agent test harness patterns): full buy→serve→receipt→batch→finalize→
  reward flow chainless; auth failures; replay; soft ceiling stop; meter math.

## 6. Daemon + CLI — `packages/cli`

- `src/daemon/routes/marketplace.ts` → `handleMarketplaceRoutes(ctx)`:
  - `GET  /api/marketplace/status` (enabled, role readiness, epoch, deadline)
  - `POST /api/marketplace/seller/offerings` (set/publish offerings)
  - `GET  /api/marketplace/offers` (discovered offers)
  - `POST /api/marketplace/subscribe` `{ amountTrac | amountWei, epoch?, policy }`
  - `POST /api/marketplace/invoke` `{ serviceType, modelId?, payload, maxUnits? }`
  - `GET  /api/marketplace/meter`
  - `POST /api/marketplace/settle` `{ action: 'flush-receipts'|'finalize'|'claim'|'roll',
    buyer?, epoch? }` (testing/ops rail)
  Wire into `handle-request.ts` dispatch chain. Follow existing route-module
  style + auth conventions (operator-gated like other mutating routes).
- `src/api-client.ts`: typed client methods for each route.
- `src/commands/marketplace.ts`: `dkg marketplace status|offers|subscribe|invoke|meter|settle`
  registered in `cli.ts` (thin wrappers over the client).
- `src/config.ts` (`DkgConfig`): optional `marketplace` block mapped into
  `DKGAgentConfig.marketplace` where the daemon builds the agent config;
  boolean env override `DKG_MARKETPLACE_ENABLED`.
- `scripts/devnet.sh`: generated node `config.json` gets
  `"marketplace": { "enabled": true }` (serving still requires explicitly
  configured offerings, so this is inert until a test seeds them).

## 7. Devnet suite — `devnet/marketplace-rfc27/`

Files: `package.json` (private, name matching existing devnet suite convention),
`vitest.config.ts` (copy `devnet/v10-core-flows` shape: forks pool, 900s
timeout, serial), `automated.test.ts` using `devnet/_bootstrap/harness.ts`:

1. `detectDevnet(6)`; ensure identities; seller A = node1, seller B = node3
   (both core), buyer = node2.
2. Sellers configure offerings via `POST /api/marketplace/seller/offerings`:
   A: `devnet-llm` (inference stub, token unit, ask 0.5 µTRAC/token →
   5e11 wei) + `devnet-knowledge` (query unit, 15 µTRAC); B: `devnet-llm`
   at a higher ask (routing check). Offer KAs land in the `marketplace` CG.
3. Buyer subscribes: `fundTrac` the buyer's operational wallet, then
   `POST /api/marketplace/subscribe` with 10 TRAC and a policy with per-bucket
   caps; assert on-chain bucket via status route.
4. Buyer discovers offers (poll until CG sync delivers them), then invokes
   chat-style calls (router must pick seller A's cheaper ask) and SPARQL calls;
   assert results, meter movement, receipt verification.
5. Force receipt flush on sellers (`settle {action:'flush-receipts'}`); assert
   claims on-chain (`getSellerClaim`).
6. Over-authorization drill: drive usage so combined claims of A+B exceed the
   funded bucket → after `timeWarpSeconds` past deadline, `finalize`, assert
   pro-rata (floor) matches the TS mirror computation.
7. `claim` for both sellers; assert TRAC balances increased by
   `pool · QIF_i` within rounding, with QIF recomputed in the test from
   on-chain `R_i, Q_i, ΣR, ΣQ, λ`.
8. Soft-ceiling assertion: a call that would cross 95% of a bucket is refused
   locally with a `soft_ceiling` error.

Registration (all four, or `pnpm test:devnet:manifest` fails): directory,
`pnpm-workspace.yaml` entry, `devnet/suites.json` "all" array, root script
`test:devnet:marketplace-rfc27`.

## 8. Repo gate checklist (hard CI gates — all must be satisfied)

- Root `vitest.config.ts` projects += `packages/marketplace`.
- `scripts/lib/ci-lanes.mjs`: add `marketplace` to an existing lane's packages
  array (`kosava-supporting` unless something fits better).
- Coverage: `coverageForUnbaselinedPackage('marketplace')`.
- ≥1 test file in every package with a vitest config; no `--passWithNoTests`.
- No raw `dialProtocol` (use router/messenger) — `scripts/audit-dial-protocol.mjs`.
- No `Wallet.createRandom` — `scripts/audit-create-random.mjs` (use
  `randomBytes(32)` → `new Wallet(...)`).
- File-size audit: keep new files comfortably under the cap (split modules).
- Exports maps: new public exports from core/chain/agent/marketplace need
  package.json `exports` entries (agent runs `test:package-exports`).
- ABI vendoring sync test (`packages/chain/test/vendored-abi-sync.unit.test.ts`).
- `pnpm lint` (oxlint baseline, NUL check, disabled-tests policy), `pnpm knip`
  (new package may need a knip entry), `pnpm test:inventory`.
- evm-module: `pnpm --filter dkg-evm-module compile` + its test conventions;
  deploy scripts with proper `func.dependencies`.

## 9. Validation sequence

1. `DKG_SKIP_EVM_BUILD=1 pnpm build:packages`
2. `pnpm --filter dkg-evm-module compile` + contract tests
3. Per-package vitest for marketplace/chain/core/agent/cli touched suites
4. `pnpm lint`, `node scripts/audit-*.mjs`, `pnpm test:inventory`
5. `pnpm build && ./scripts/devnet.sh clean && ./scripts/devnet.sh start 6 &&
   node devnet/_bootstrap/bootstrap.cjs && pnpm test:devnet:marketplace-rfc27`

## 10. Post-review amendments

Changes landed after the adversarial review and the first live devnet run.
They refine the design above (which is left as written); the code is the
authority for details.

- **Session keys bind per buyer, permanently.** `sessionKeyOwner` (a global
  key→buyer map, squattable by front-running another buyer's key) is removed.
  `boundSessionKeys[buyer][key]` records every key a buyer ever registered;
  receipt verification accepts ANY bound key, so a rotation via a later
  `fundSubscription` keeps OLD keys valid and can never strand already-served
  receipts. Two buyers binding the same key is harmless — each binding spends
  only its own buckets. `SessionKeyAlreadyBound` no longer exists; view
  `isSessionKeyBound(buyer, key)` added.
- **Zero-value claims revert (`ZeroClaimValue`) and enrollment is explicit.**
  A zero-ask claim could previously enroll a claimant whose pro-rata share
  divides by its own zero claim and brick finalization; sellers now enroll
  once via an explicit flag (`getSellerClaim` returns a 3rd `enrolled` field),
  so repeated claims cannot multiply a claimant's list entries. The domain
  `proRataFinalize` mirror and the finalize loop OMIT `claimed == 0` sellers
  as defense in depth.
- **Finalization is paginated.** `finalizeBucket(buyer, epoch, maxSellers)`
  (0 = all remaining) with a stored cursor and `BucketFinalizeProgress`, so a
  bucket with more claimants than one block's gas still finalizes; claims on a
  finalized or mid-pagination bucket revert `ClaimsClosedForBucket`. The chain
  adapter's `marketplaceFinalizeBucket` takes an optional `maxSellers`
  (omitted = 0 = all), so existing 2-arg callers are unchanged.
- **Reward cap + per-epoch distribution tracking.** `rewardCapMultiple`
  (uint16, default 10, 0 = uncapped; 4th member of `getParams()`) caps
  `claimEpochReward` at `min(pool·QIF_i/1e18, rewardCapMultiple·R_i)` — the
  wash-trading guard against harvesting an under-utilized pool's stake-side
  QIF with fabricated self-claims. Paid rewards are tracked per epoch:
  `getEpochRewardDistribution(epoch) → (pool, distributed, undistributed)`;
  the capped remainder stays in the contract (governance follow-up).
- **The marketplace CG is registered on-chain and buyers sync to it.** Under
  RFC-64 an unregistered plain-name CG has no authority a replica will accept,
  so offer shares never propagated. The FIRST seller publish now registers the
  `marketplace` CG on-chain (one extra tx from the seller's operational
  wallet; later sellers adopt the existing binding); marketplace-enabled nodes
  subscribe with always-on sync, and empty discovery triggers a throttled
  (≥30s) SWM backfill from connected peers. First-publish → buyer discovery
  convergence can take up to ~3 minutes (sync catchup backoff 30/60/120/240s).
- **Multi-seller offers are Knowledge Assets in Verifiable Memory; a reprice
  updates the same KA.** Browser QA found that a seller's reprice never
  reached other nodes and that sellers A and B never saw each other's offers.
  Two root causes. (1) Split anchor: seller B published one second after A
  registered the CG, created its own local `marketplace` CG and registered it
  again — the local status and the finalized-chain authority read both lag a
  fresh registration, and `registerContextGraph` skips chain reconciliation
  for a locally-created graph — so the chain held two slots under one name
  hash (ContextGraphStorage does not enforce uniqueness). Nodes bound
  different slots, their RFC-64 policy digests differed
  (`catalog-transport-policy-denied` between the halves), and the name's
  reverse lookup became ambiguous (fail closed). (2) Wrong write lane: offers
  were written with the generic legacy `share()` (manifest-scoped SWM,
  content-scope v0). Receivers never apply that live — a catalog-mode CG
  declines root-scope legacy apply ("legacy SWM apply is not authoritative for
  root scope"), and the graph-scoped validator rejects v0 as
  `LEGACY_KA_READ_ONLY` — so offers only crossed via the slow, union-only
  legacy SWM sync pull, which can never replace an old ask. Graph-scoped
  SWM-only KAs cannot be repriced either: an unpublished KA's next draft is
  sealed at the same assertion version, and peers and the RFC-64 catalog
  refuse a same-version share with new content. Fix
  (`packages/agent/src/marketplace/offer-assets.ts`, `offer-publisher.ts`):
  a seller first resolves the marketplace name on-chain with an uncached
  current-state lookup and ADOPTS an existing anchor (binds that slot, never
  creates or registers its own); only a proven absence registers (public,
  open publish policy, so every seller is an authorized publisher of its own
  KAs). Each (seller, offering) is one KA named `marketplace-offer-<id>`,
  authored by the receipt-signing agent, published to VM through the KA
  lifecycle; a changed offering is an on-chain update of that KA (version
  confirmed + 1) that every node applies by replacing the old content during
  chain reconciliation, and an unchanged one sends no transaction. Offers
  carry `mkt:revision`; discovery queries per KA graph (`GRAPH ?g`), accepts an
  offer only from a KA authored by its `sellerAddress`, and keeps the newest
  revision per (seller, offering). It is also monotonic per node: it never
  returns a revision below one it already returned. The store alone is not:
  once the seller's update confirms, the new version's shared-memory copy is
  retracted from every node (a confirmed publish removes the author's SWM
  graph and its RFC-64 SWM inventory row), while each node replaces its VM
  copy only when it reconciles the update from the chain — on the devnet
  ~15 s on the edges and ~50–60 s on the cores that signed the update's ACK
  (they wait out the 30 s staged-copy grace, then fetch from a peer) — so in
  between the store holds only the old ask. Every discovery nudges a
  throttled (≥30s) VM reconcile of the CG. Each publish still logs `legacy
  SWM apply is not authoritative` on the other nodes: the KA lifecycle's
  share also fans out on the legacy substrate, which catalog-mode receivers
  decline (they take the content from the catalog and the chain) — the same
  as any KA published into a registered CG. The seller's `local-query`
  executor now serves the buyer's SPARQL over its Verifiable Memory of the CG
  only: with shared memory included, the query engine runs the query once
  per partition and unions the results, so `LIMIT 5` returned 10 rows (21
  query units, `OVER_MAX_UNITS` against the drill's maxUnits 16) while offer
  KAs were also held in shared memory right after a publish.
- **Authorization expiry derives from CHAIN time**, not the buyer's wall
  clock, fixing repeated-run `AuthorizationExpired` drift on time-warped
  devnets where `block.timestamp` runs ahead of real time.
- **Router NO_ROUTE reasons distinguish empty discovery from policy.**
  `no-offers` = discovery returned nothing (rejections `[]`, typically an
  unsynced CG); `no-eligible-offer` = offers were seen and every one carries a
  rejection (`soft-ceiling`, `price-cap`, `deny-list`, …). The daemon invoke
  route surfaces both as 409 `{ code: 'NO_ROUTE', reason, rejections }`.
- **Seller-side serve hardening.** The seller refuses to serve with errorCode
  `UNDERFUNDED` when the buyer's bucket cannot cover the call's worst-case
  exposure, and refuses stale authorizations; its replay guard and
  pending-receipt batch are persisted durably so a restart neither re-serves a
  consumed callId nor drops signed-but-unsubmitted receipts.
