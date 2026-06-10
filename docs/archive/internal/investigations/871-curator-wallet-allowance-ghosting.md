# Investigation: rc.12 curator wallet `approve(KAV, X)` ghosting (#871)

> Status: **Resolved — operator-side / RPC read artifact. No code bug.**
> Filed: 2026-06-01 (issue [#871](https://github.com/OriginTrail/dkg/issues/871))
> Investigated: 2026-06-01 against `origin/main` @ `e75d0e67` (post-rc.12)

## TL;DR

The curator wallet's `token.approve(KAV_Lifecycle, 10 TRAC)` on Base Sepolia
**did succeed and did update on-chain allowance to 10 TRAC**, identical to
the alt-key and keystore wallets. The issue's reported symptom ("allowance
still reads `1n` after a confirmed approve") is contradicted by on-chain
evidence and is most likely a **read-side artifact in the operator's
reproduction script** (RPC stale read, provider caching, or a typo in the
spender address used for the read). The on-chain `KnowledgeAssetsLifecycle`
address listed in the issue body is **off by several characters** from the
real rc.12 deployment and points at a never-funded EOA.

There is no code defect in the daemon's approval path that explains the
reported behaviour. We are landing one small observability change so the
next operator who sees "1 wei dust" on a publishing wallet can identify it
as the intentional `#720` per-publish floor instead of mistaking it for a
ghosted approval.

## The bug as reported

From [#871](https://github.com/OriginTrail/dkg/issues/871):

- Network: `base_sepolia_v10` (chainId `84532`)
- Token (TRAC): `0x2A58BdD13176D85906D804cdbFFA0D9119282DC8`
- Issue body's spender (`KnowledgeAssetsLifecycle`): `0x7558E9B30BeBFB94c0d09a52e2F00f1bD3d7BDe5`
- HariSeldon curator wallet: `0x395A3dc5d209Ecc051260C3991925dfc5C416a83`

The user reported that calling `token.approve(spender, 10 TRAC)` from each
of three operational wallets confirmed (`status=1`) on every wallet, but
that `allowance(curator, spender)` continued to read `1n` after the curator
wallet's tx confirmed — while the alt-key and keystore wallets
returned the expected `10 TRAC`.

## Hypotheses tested

### H1. Custom `approve`/`allowance` hook on the Token contract

`packages/evm-module/contracts/Token.sol` is a vanilla OpenZeppelin ERC20
with `Ownable + AccessControl + MINTER_ROLE`. No custom `_approve`,
`_beforeTokenTransfer`, or `transferFrom` overrides; no PCA owner mapping
or agent-to-account redirect inside the Token contract itself.

`agentToAccountId` lives on `DKGPublishingConvictionNFT`, not on `Token`,
and only affects the publishing path (see `KnowledgeAssetsLifecycle.sol`
`publish` / `_executePublishCore`). It cannot route an `approve` to a
different `_allowances[owner][spender]` slot, because `approve` is a
direct write to the ERC20 mapping with no hook.

The deployed bytecode at `0x2A58BdD…2DC8` is 3,699 bytes — consistent with
a vanilla ERC20 + AccessControl. There is no off-chain artifact in this
repo or in any rc.12 branch that suggests a non-vanilla TRAC at this
address.

> **H1 is ruled out: the Token contract has no path that can swallow an
> `approve` and leave allowance unchanged.**

### H2. Approval being silently overridden by a hook

There is no transfer / approval hook anywhere in `Token.sol` that could
suppress an `approve` write. ERC20's `_approve` unconditionally writes
`_allowances[owner][spender] = amount` and emits `Approval(owner, spender,
amount)`. If the tx confirms with `status=1`, the storage write happened.

> **H2 is ruled out: there is no on-chain mechanism that can confirm a tx
> with `status=1` and not update the allowance mapping.**

### H3. Daemon racing the user's approve

The curator wallet **is** in the daemon's operational wallet pool (per
`~/.dkg/wallets.json`) and the daemon **does** use it for V10 publishes
(per `~/.dkg/daemon.log`, e.g. block `42270519` neighbourhood publishes
visible at `12:11:49` and `12:22:44` local).

The daemon's only `approve` site for the V10 publish/update flow is
`ensureV10ApproveTrac` in `packages/chain/src/evm-adapter.ts` (line ~1024).
That helper:

1. Reads `currentAllowance = token.allowance(signer.address, kav10Address)`.
2. Computes `{ needsApprove, targetAllowance } = computeApprovalAction(policy, tokenAmount, currentAllowance)`.
3. Submits `token.approve(kav10Address, targetAllowance)` only when
   `needsApprove === true`.

For the default `per-publish` policy, `needsApprove === currentAllowance < publishFloor`,
where `publishFloor = max(tokenAmount, 1n)` (`V10_PUBLISH_ONCHAIN_MIN_ALLOWANCE`).
Once the user's manual approve sets `currentAllowance` to `10 TRAC`,
`needsApprove` becomes `false` for every subsequent zero-cost publish, so
the daemon **does not** issue a competing `approve` tx that could lower
the allowance back down. There is no path in the V10 daemon code that
calls `approve(spender, 0)` or `decreaseAllowance(spender, …)` against
the TRAC token.

A grep across `packages/chain/src/**` confirms a single runtime `approve(KAV, …)`
caller (`ensureV10ApproveTrac`); the V8/V9 archived methods in
`packages/chain/src/archive/evm-adapter-v8-v9-methods.ts` are not on the
rc.12 publish path.

#### On-chain `Approval(owner=curator, …)` event scan

Pulling every `Approval` event with `owner=curator` from TRAC over the
last ~50 000 Base Sepolia blocks (~24 h, covering the issue filing time
of `2026-06-01T10:39:07Z`):

```
=== curator (0x395A3dc5d209Ecc051260C3991925dfc5C416a83) — 1 Approval event ===
  blk=42270519  ts=2026-06-01T10:22:06.000Z
  spender=0x7558E9B30BeFA87F68C808c1f705b30507d19146  (real rc.12 KAV)
  value=10000000000000000000  (= 10 TRAC)
  tx=0x9f590889a06b14602efbb4cf475d081a84c7eac9eb99bb8e28d3f428d5559290
```

```
=== alt9835 — 2 Approval events ===
  blk=42270458  ts=10:20:04Z  spender=KAV  value=1
  blk=42270518  ts=10:22:04Z  spender=KAV  value=10000000000000000000  (10 TRAC)

=== alt165B — 2 Approval events ===
  blk=42270351  ts=10:16:30Z  spender=KAV  value=1
  blk=42270522  ts=10:22:12Z  spender=KAV  value=10000000000000000000  (10 TRAC)
```

The on-chain truth is unambiguous:

- Each of the three wallets emitted exactly one `Approval(KAV, 10 TRAC)`
  inside an 8-second window around `10:22:04 → 10:22:12 UTC`. The
  curator's approve mined at `10:22:06`.
- The two `value=1` events on the alt wallets at `10:16` / `10:20` are the
  daemon's earlier per-publish floor approves (`ensureV10ApproveTrac` →
  `effectivePublishAllowance(0n) = 1n`) — these are the "pre-existing
  dust" mentioned in the issue. The curator wallet was already at
  `currentAllowance >= 1` from a daemon publish that pre-dated the 50k
  block scan window, so it did not need a fresh `approve(KAV, 1)` in
  this window.
- **No daemon `approve` event lands between any wallet's manual 10 TRAC
  approve and the issue filing time.** The race described as H3 did not
  occur on-chain.

#### Current on-chain allowance reads (sampled `2026-06-01 ~13:00 UTC`)

```
curator → KAV : 9999999999999999999  (= 10 TRAC − 1 wei)
alt9835 → KAV : 10000000000000000000 (= 10 TRAC)
alt165B → KAV : 10000000000000000000 (= 10 TRAC)
```

The curator is `1 wei` short of 10 TRAC because **one V10 publish has
fired on the curator wallet** since the user's manual approve at `10:22:06`,
consuming exactly 1 wei via the contract's direct-spend branch
(`KnowledgeAssetsLifecycle._addTokens` → `transferFrom(msg.sender, CSS, fullCost)`).
This confirms the curator's PCA gate (`agentToAccountId(curator) != 0 &&
p.epochs == lockDurationEpochs && block.timestamp < expiry`) is not
satisfied for the publishes the daemon ran on it — they fall through to
the direct-spend branch, which is exactly the path `ensureV10ApproveTrac`
is sized for.

> **H3 is ruled out: the only `Approval(curator, KAV, …)` event in the
> 24-hour window around the issue is the user's manual `10 TRAC` write,
> and the post-approve allowance is `10 TRAC − 1 wei`. The daemon did
> not race or reset the user's approve.**

### H4. EVM tx-ordering / replay

There is no replay or reordering issue: `approve` is a single SSTORE
overwrite, and the on-chain log shows exactly one matching `Approval`
event with `value=10 TRAC` at block `42270519`. After that block, every
canonical RPC source returns `allowance(curator, KAV) = 10 TRAC` (then
`10 TRAC − 1 wei` after the next publish).

### H5. Spender-address typo in the reproduction (the actual culprit)

The address quoted in the issue body —
`0x7558E9B30BeBFB94c0d09a52e2F00f1bD3d7BDe5` — is **not** the rc.12
`KnowledgeAssetsLifecycle`. The real address (per
`packages/evm-module/deployments/base_sepolia_v10_contracts.json` on the
`v10.0.0-rc.12` tag) is:

```
0x7558E9B30BeFA87F68C808c1f705b30507d19146
```

The two are identical for the first 11 characters and visually similar but
differ from byte 12 onwards. The typo'd address has:

- empty bytecode (not a contract),
- 0 ETH balance,
- 0 transactions sent,
- no occurrences anywhere in the dkg repository or any rc.12 branch.

If the user's reproduction script ever resolved the spender to the typo'd
address — even momentarily, e.g. via a copy-paste in an interactive REPL
session — then `allowance(curator, TYPO_EOA)` would read `0` (or
whatever stale value an earlier session had set). That `0` displayed
under ethers v6 as the literal `0n` BigInt, which is one keystroke off
from the issue's reported `1n`.

A second branch of H5: the user's pre-existing-dust `1n` is real (it's the
daemon's per-publish floor on the real KAV) and the post-approve `1n` is
also a read against the **real** KAV, but the **provider cached** the
read across blocks. Some public Base Sepolia RPCs will return the same
`eth_call` result for several seconds when the same `(to, data, blockTag)`
tuple is hit in rapid succession; combined with `provider.pollingInterval`
or a stale `latest`-block pin in ethers, the post-approve read can return
the pre-approve value. The other two wallets escape the cache because
the call signature is different (different `owner` parameter).

> **H5 is the most likely root cause.** The user's tx unambiguously
> updated on-chain allowance; the discrepancy is in the read, not the
> write.

## What we found

1. **Curator wallet's `approve(KAV, 10 TRAC)` succeeded on-chain** at
   block `42270519`, mined at `2026-06-01T10:22:06Z`, tx
   `0x9f590889a06b14602efbb4cf475d081a84c7eac9eb99bb8e28d3f428d5559290`.
   Verified by replaying the `Approval(address indexed owner, address
   indexed spender, uint256 value)` log filtered on `owner=curator` over
   the last 50 000 blocks.

2. **Current on-chain allowance** for `curator → real-rc.12 KAV` is
   `9999999999999999999` (= 10 TRAC − 1 wei). The 1-wei delta is one
   subsequent direct-spend publish; everything is consistent with the
   `ensureV10ApproveTrac` + `_addTokens` paths.

3. **The daemon never raced or reset** the user's approve. The only
   `Approval(curator, KAV, …)` event in the relevant 24-hour window is
   the user's manual `10 TRAC` write. No daemon `approve(KAV, 1)` event
   landed after it.

4. **The issue body's spender address is a typo** — `…BeBFB94c0d09a52e2F00f1bD3d7BDe5`
   vs the real `…BeFA87F68C808c1f705b30507d19146`. The typo'd address is
   an empty EOA. We cannot prove the user's reproduction _used_ this
   typo (the script wasn't shared), but the report's key signal —
   "allowance unchanged at `1n`" — fits one of two read-side patterns:
   (a) reading allowance against the typo'd EOA, or (b) reading the
   real KAV through a stale provider cache.

5. **The daemon's per-publish 1-wei floor is real and intentional.**
   `effectivePublishAllowance(0n) === 1n` is the documented `#720`
   workaround for the contract's `transferFrom(..., 1n)` minimum on
   zero-cost publishes. Without observability around it, operators who
   manually inspect on-chain allowance see "1 wei dust" persisting after
   every publish and reasonably suspect a stuck or ghosted approval.

## What we changed

1. **Investigation note (this document)** at
   `docs/investigations/871-curator-wallet-allowance-ghosting.md`,
   capturing the on-chain proof so the next person to hit this symptom
   can rule out the daemon and look at their reproduction script's RPC
   handling and spender-address resolution.

2. **One observability log line** in
   `packages/chain/src/evm-adapter.ts` `ensureV10ApproveTrac` — when
   the per-publish policy emits its floor approval (`targetAllowance ==
   V10_PUBLISH_ONCHAIN_MIN_ALLOWANCE` and `mode == 'per-publish'`),
   we now emit a `console.warn` explaining that this 1-wei value is
   the intentional `#720` workaround and not a stuck approval. This
   does not fire on the curator wallet right now (the daemon hasn't
   needed to refresh its allowance since the user's manual write), but
   it will let the next operator who sees a 1-wei floor approve in their
   logs immediately understand the source.

We did **not** ship a regression test: there is no behavioural change in
the production path — only the addition of one diagnostic log line —
and the existing `effectivePublishAllowance` / `computeApprovalAction`
unit tests in `packages/chain/test/evm-adapter.unit.test.ts` already
pin the 1-wei floor.

## Root cause

**Operator-side / RPC read artifact, not a code bug.** The user's
manual `approve(KAV, 10 TRAC)` from the curator wallet succeeded and
updated the on-chain mapping. The reported "allowance unchanged at
`1n`" is most plausibly:

- a typo in the spender address used by the reproduction script
  (the issue body itself contains a non-rc.12 address that points at
  an empty EOA), and/or
- a stale `eth_call` / provider cache returning the pre-approve value
  for the curator's `(owner, spender)` slot specifically, while the
  alt-key and keystore wallets escape the cache because their `owner`
  parameter differs.

The `1-wei dust` the user observed _before_ the manual approve is real
and expected — it's the daemon's per-publish floor under
`chain.approvalPolicy = "per-publish"` (default), which is the
intentional workaround for the contract's `transferFrom(..., 1n)`
minimum on zero-cost publishes (#720).

## Recommended next steps

For the issue reporter:

1. Re-run the reproduction with the **rc.12 deployment KAV address**
   `0x7558E9B30BeFA87F68C808c1f705b30507d19146`, sourced via
   `chain.knowledgeAssetsLifecycle` from the daemon's running config
   rather than typed by hand. The address listed in the issue body
   (`…BeBFB94c0d09a52e2F00f1bD3d7BDe5`) is not a deployed contract.
2. After the approve confirms, before reading `allowance(...)`, force
   a fresh provider read: rebuild the `JsonRpcProvider` (drop the
   client-side block cache) or hit a different RPC endpoint
   (`https://sepolia.base.org` ↔ a private endpoint) for the read.
   If the second read returns 10 TRAC while the first still reads
   1 wei, the issue is upstream RPC caching, not the daemon.
3. The on-chain truth (Approval event at block `42270519`, current
   allowance `~9.999…99 TRAC`) is already what the user expected — no
   further on-chain action is needed.

For the platform:

- The single observability log added here will surface the per-publish
  floor explicitly the next time a wallet enters the daemon pool with
  `currentAllowance < 1`. We are intentionally not tightening the floor
  (it's the documented `#720` workaround and removing it would re-brick
  zero-cost publishes); the goal is making it visible so operators
  don't pattern-match it as a bug.

## Closing the issue

This is operator/RPC-side. We have left the issue open with a comment
linking to this document and to the transaction hashes that prove
on-chain success, so the reporter can verify and close.

## Appendix — tools used

All on-chain reads were performed against the public Base Sepolia RPC
(`https://sepolia.base.org`) via ethers v6. The relevant queries were:

```js
const provider = new ethers.JsonRpcProvider("https://sepolia.base.org");
const TRAC = "0x2A58BdD13176D85906D804cdbFFA0D9119282DC8";
const KAV  = "0x7558E9B30BeFA87F68C808c1f705b30507d19146"; // rc.12 actual
const t = new ethers.Contract(TRAC, [
  "function allowance(address,address) view returns (uint256)",
  "event Approval(address indexed owner, address indexed spender, uint256 value)",
], provider);

// 1) Current allowances (sanity).
await t.allowance("0x395A3dc5d209Ecc051260C3991925dfc5C416a83", KAV);

// 2) Approval(owner=curator) replay over last ~50k blocks, paged 2000 blocks
//    at a time to satisfy the public RPC's eth_getLogs window cap.
const padOwner = ethers.zeroPadValue(curator, 32);
const topic = ethers.id("Approval(address,address,uint256)");
for (let end = latest; end > latest - 50000; end -= 2000) {
  const start = Math.max(0, end - 1999);
  await provider.getLogs({ address: TRAC, topics: [topic, padOwner], fromBlock: start, toBlock: end });
}
```
