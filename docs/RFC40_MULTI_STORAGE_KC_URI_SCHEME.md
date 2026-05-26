# OT-RFC-40 — Multi-storage knowledge-collection URI scheme

**Status:** Implemented (PRs 1-6 landed on `rfc40/multi-storage-kc-uri`)
**Companion:** [GitHub issue #679 — chain-reset auto-wipe](https://github.com/OriginTrail/dkg/issues/679)
**Related:** [`docs/STORAGE_VERSION_TAGS.md`](./STORAGE_VERSION_TAGS.md) (operator guide), [`docs/TESTNET_RESET.md`](./TESTNET_RESET.md), [`packages/cli/src/daemon/chain-reset-wipe.ts`](../packages/cli/src/daemon/chain-reset-wipe.ts)

## 1. Summary

The chain-reset auto-wipe in `chain-reset-wipe.ts` exists because the wire identity of a Knowledge Collection's data on disk is, today, implicitly bound to a single deployed `KnowledgeCollectionStorage` contract. When that storage contract is re-deployed (testnet reset, major mainnet upgrade), the IDs embedded in store.nq triples lose their on-chain referent and the daemon's only safe move is to destroy them.

This RFC formalises a URI scheme in which a KC's wire identity is bound to *which storage instance minted it*, not just to "the chain". Old data published against a previous storage instance continues to be valid and queryable indefinitely; new storage versions live alongside old ones; the auto-wipe becomes unnecessary on any network where this scheme is in force.

**Crucially, this is not a new pattern**. It is a formalisation of the V9 / V10 coexistence pattern that already runs in production on Base Sepolia testnet today. The work below is closing the gaps that prevent the pattern from being repeatable for V11, V12, and arbitrary future upgrades.

## 2. Motivation

Three failure modes drive this:

1. **Testnet dev rugpull (#679):** Every release-candidate redeploys storage contracts and bumps `chainResetMarker`. The next daemon boot deletes `store.nq`. Developers who switch between branches in the same `DKG_HOME` lose their local-only context graphs silently. Reproducible twice in five hours during a normal RC cadence.
2. **Mainnet upgrade rugpull risk:** The same hook is wired into mainnet's boot path. A future maintainer who bumps `chainResetMarker` in `network/mainnet-*.json` — by accident or by design — would destroy every operator's published data on next restart. There is no off-switch.
3. **Multi-storage coexistence is a real product requirement.** V9 `KnowledgeAssetsStorage` already coexists with V10 `KnowledgeCollectionStorage` on the testnet (see §3.1). Future versions will need to coexist too, and the existing convention is undocumented and partially-implemented.

## 3. Current state

### 3.1 Plural KC storage is already deployed

`packages/evm-module/deployments/base_sepolia_v10_contracts.json`:

```93:96:packages/evm-module/deployments/base_sepolia_v10_contracts.json
        "KnowledgeCollectionStorage": {
            "evmAddress": "0x4fCA405d46ADeDD7050420C1937842D2a36a04D8",
            "version": "1.0.0",
            "gitBranch": "main",
```

```309:312:packages/evm-module/deployments/base_sepolia_v10_contracts.json
        "KnowledgeAssetsStorage": {
            "evmAddress": "0x45E0e14c695681c8c93d6A489a314ea1EC28ba59",
            "version": "2.0.0",
            "gitBranch": "validate/v10-e2e-devnet",
```

Both are registered in the same Hub. Both are queried by agents via `hub.getAssetStorageAddress(<name>)`. Existence proof.

### 3.2 Each storage has its own URI prefix

`parameters.json` carries a `uriBase` per storage instance:

```51:93:packages/evm-module/deployments/parameters.json
        "KnowledgeCollectionStorage": {
            "knowledgeCollectionSize": "1000000",
            "uriBase": "did:dkg"
        },
        ...
        "KnowledgeAssetsStorage": {
            "uriBase": "did:dkg:v9"
        },
```

This is the architectural primitive we're formalising. V9 KAs are minted under the `did:dkg:v9` URI prefix; V10 KCs under `did:dkg`. The prefix is baked into the storage contract at construction time and queryable on-chain via the standard ERC-1155 `uri(uint256)` view:

```80:82:packages/evm-module/contracts/tokens/ERC1155Delta.sol
    function uri(uint256) public view virtual override returns (string memory) {
        return _uri;
    }
```

### 3.3 The chain side is already multi-storage aware

`RandomSamplingLib.Challenge` carries the storage address inline:

```6:14:packages/evm-module/contracts/libraries/RandomSamplingLib.sol
    struct Challenge {
        uint256 knowledgeCollectionId;
        uint256 chunkId; // TODO:Smaller data structure
        address knowledgeCollectionStorageContract;
        uint256 epoch;
        uint256 activeProofPeriodStartBlock;
        uint256 proofingPeriodDurationInBlocks;
        bool solved;
    }
```

Random sampling was designed for plural KC storage from day one. The challenge tells the prover *which* storage holds the targeted KC; the prover doesn't have to guess.

### 3.4 Where the current model leaks

Despite the primitives existing, three sites short-circuit on "the singular KC storage":

- **Logic-side resolution** (`KnowledgeAssetsV10.sol:325`, `RandomSampling.sol:123`): every consumer calls `hub.getAssetStorageAddress("KnowledgeCollectionStorage")` — a single name. There's no convention for V2, V3, etc. — adding a second instance under the same name is a name-collision overwrite, not an additional registration.
- **UAL construction** (`packages/publisher/src/dkg-publisher.ts:2324`, `:2625`, `:2701`, `:2756`, `:2788`, `:2802`): the UAL is hard-coded to `did:dkg:${chainId}/${publisherAddress}/${startKAId}`. The storage's actual `uriBase` is never consulted; the agent assumes V10's `did:dkg` prefix always. V9 has its own KAS path that doesn't go through this.
- **UAL parser** (`packages/publisher/src/publish-handler.ts:581-610`): splits on `/`, assumes `segments[0] = chainId`, `segments[1] = publisherAddress`, `segments[2] = startKAId`. Three-segment-only. Anything richer fails silently.

These three are the formalisation gap. Close them, and the storage-redeploy class of problem disappears.

## 4. Investigation: answering the three unverified questions

I committed in the previous round to verifying three points before finalising. Findings:

### 4.1 Random-sampling WAL shape

`packages/random-sampling/src/wal.ts`:

```44:64:packages/random-sampling/src/wal.ts
export interface ProverWalEntry {
  ts: string;
  epoch: string;
  periodStartBlock: string;
  identityId: string;
  status: ProverPeriodStatus;
  kcId?: string;
  cgId?: string;
  chunkId?: string;
  txHash?: string;
  error?: { code: string; message: string };
}
```

WAL identity is `(epoch, periodStartBlock, identityId)`. `kcId` and `cgId` are informational only — they're "set from `challenge` onwards", never used in `periodKeyEquals` (`wal.ts:77-83`). Crash recovery uses the period key, not the KC id.

**Impact on this RFC:** zero. WAL is forward-compatible with any kcId representation that's serialisable as a decimal string. Even if we never touched the WAL, adopting the upper-bits scheme (§5.4) would just produce larger decimals in the JSONL — string-typed, no schema change.

Should add `knowledgeCollectionStorageContract: string` to `ProverWalEntry` for forensics regardless (the chain already passes it; we just discard it). Half a day's work; not blocking.

### 4.2 Publish-journal idempotency keys

`packages/publisher/src/publish-journal.ts`:

```5:19:packages/publisher/src/publish-journal.ts
export interface JournalEntry {
  ual: string;
  contextGraphId: string;
  expectedPublisherAddress: string;
  expectedMerkleRoot: string;
  expectedStartKAId: string;
  expectedEndKAId: string;
  expectedChainId: string;
  rootEntities?: string[];
  createdAt: number;
}
```

Journal is keyed by **UAL + contextGraphId + merkleRoot**, no separate kcId field. Once the UAL becomes storage-discriminating, the journal naturally becomes storage-discriminating too. No journal-level changes needed.

### 4.3 External indexers / SubGraph manifests / ETL

No SubGraph (The Graph protocol) manifests in this repo. The file at `packages/cli/src/indexer.ts` is the *code-graph* indexer (DKG ontology, dev-time), not a chain-data indexer. No external pipeline assumes small/dense kcId ranges.

**Open coordination cost:** any third-party tooling that consumes `KnowledgeCollectionCreated` events would need to route on `log.address` (the emitting storage) rather than the event payload alone. This is the standard ethers/viem pattern; we shouldn't need explicit coordination, but the migration RFC's "external impact" section should call it out.

## 5. Design

### 5.1 Core invariant

**A KC's UAL fully identifies which storage instance minted it, on which chain, by which publisher, with which KA range.** No agent ever needs to guess.

### 5.2 URI shape

Two equivalent forms are valid; the parser MUST handle both:

```
Legacy / V10 default (3-segment after did:dkg:):
  did:dkg:{chainId}/{publisherAddress}/{startKAId}

Storage-tagged (4-segment after did:dkg:):
  did:dkg:{chainId}/{storageTag}/{publisherAddress}/{startKAId}
```

The `storageTag` is the suffix of the storage's on-chain `uri(0)` return value past the common `did:dkg` prefix. Examples:

| Storage `uriBase` | `storageTag` | UAL example |
|---|---|---|
| `did:dkg` (V10 default) | _(empty — legacy 3-segment form)_ | `did:dkg:base:84532/0xA1.../12345` |
| `did:dkg:v9` | `v9` | `did:dkg:v9/base:84532/0xA1.../12345` |
| `did:dkg:v11` (hypothetical) | `v11` | `did:dkg:v11/base:84532/0xA1.../12345` |
| `did:dkg:base-staking-v2` (hypothetical) | `base-staking-v2` | `did:dkg:base-staking-v2/base:84532/0xA1.../12345` |

This is the format V9 already uses for `did:dkg:v9` (see deployment script `packages/evm-module/deploy/archive/040_deploy_knowledge_assets_storage.ts`). We're standardising it.

Rules:
1. The `storageTag` MUST be `[a-z0-9-]+` (matches existing V9 `v9` and all sensible future names; precludes spaces, slashes, `:` collisions with the chainId).
2. The default `did:dkg` storage (V10's current) MUST continue to produce 3-segment UALs forever, regardless of how many other storage instances exist. This is what makes the scheme backwards-compatible with every UAL ever minted.
3. A storage instance whose `uriBase` is exactly `did:dkg` is the **default storage** for that Hub. There MUST be exactly one. Other storage instances MUST have a `uriBase` of the form `did:dkg:<storageTag>`.

### 5.3 Resolution path

Given a UAL, the agent determines which storage to query as follows:

```
function resolveStorageForUal(ual: string): Address {
  const segments = ual.slice("did:dkg:".length).split('/');
  if (segments.length === 3) {
    // Default storage — the one whose uri(0) === "did:dkg"
    return defaultKCStorage();
  }
  if (segments.length === 4) {
    const storageTag = segments[0];
    return findKCStorageByTag(storageTag);
  }
  throw new Error(`Malformed UAL: ${ual}`);
}
```

`findKCStorageByTag` consults a cache populated from Hub:

```
function buildKCStorageRegistry(): Map<string, Address> {
  const all = hub.getAllAssetStorages();
  const registry = new Map();
  for (const { name, addr } of all) {
    if (!name.startsWith("KnowledgeCollectionStorage")
        && !name.startsWith("KnowledgeAssetsStorage")) continue;
    const uriBase = await KnowledgeCollectionStorage(addr).uri(0);
    const tag = uriBase === "did:dkg"
      ? ""  // default storage
      : uriBase.slice("did:dkg:".length);
    registry.set(tag, addr);
  }
  return registry;
}
```

The registry is built once at agent startup, refreshed on `NewAssetStorage` / `AssetStorageChanged` Hub events. Cheap.

### 5.4 What we explicitly rejected: upper-bits encoding

An alternative was to embed the storage version index in the upper bits of `kcId` / `startKAId`, keeping the UAL shape flat. Considered and rejected for the following reasons:

- **URIs would be visually horrifying.** A V2-minted UAL would look like `did:dkg:base:84532/0xA1.../452312848583266388373324160190187140051835877600158453279131187530910662657`. Humans never read these, but anything that ever has to be eyeballed in a log, an error message, an indexer dashboard, or a debugger becomes incomprehensible.
- **The explicit-tag form already exists in production.** V9 ships under `did:dkg:v9/...` — the very pattern this RFC formalises. Adopting the bit-tag scheme instead would mean V9 is *not* an instance of the canonical scheme, which is wrong.
- **The chain-side `RandomSamplingLib.Challenge.knowledgeCollectionStorageContract` field is an `address`, not an upper-bits-encoded ID.** The chain itself has already chosen the explicit-address shape; matching it off-chain is consistent.
- **Storage layout in `kcToContextGraph`** (`ContextGraphStorage.sol:89`) — `mapping(uint256 kcId => uint256 cgId)` — actively reverts on collision (`KCAlreadyRegistered`). Either route (bit-tags or paired CG storage) handles this, but the explicit-tag route also implies "pair each new KC storage with its own CG storage", which is structurally cleaner.

The upper-bits scheme remains a valid fallback if some future version needs a hot-path identifier in a smaller numeric form, but it's not what we're standardising.

## 6. Backwards compatibility

This is the part most worth stress-testing. Claims, with evidence:

| Concern | Behaviour after RFC adoption | Evidence |
|---|---|---|
| Every UAL ever minted (V10) | Continues to resolve. Default-storage 3-segment form is forever valid. | §5.2 rule 2 |
| Every store.nq triple keyed by V10 UAL | Continues to be valid. Triples are unchanged. | Nothing rewrites store.nq |
| Every triple `?ual dkg:batchId "<kcId>"^^xsd:integer` | Continues to resolve. The kcId literal is per-CG-metaGraph and remains storage-internal. | `kc-extractor.ts:184-186` lookup unchanged |
| Existing V9 KAs under `did:dkg:v9` | Continues to be readable. V9 storage stays deployed; resolver knows the `v9` tag. | §3.1 — already deployed today |
| Random sampling WAL on disk | Continues to be readable. New entries CAN carry storage address but don't have to. | §4.1 |
| Publish journal on disk | Continues to be readable. UALs gain optional tag segment. | §4.2 |
| Third-party indexers consuming chain events | No code change required. `log.address` already disambiguates emitting storage. | §4.3 |
| `verifyUALConsistency` / `publisherAddressFromUal` parsers | Need teaching the 4-segment form. ~30 lines of code. | `publish-handler.ts:581`, `dkg-publisher.ts:120` |
| `dkg-publisher.ts` UAL minting (5 sites) | Need centralising and teaching to consult `storage.uri(0)` per mint. | `dkg-publisher.ts:2324`, `:2625`, `:2701`, `:2756`, `:2788`, `:2802` |
| `chainResetMarker` auto-wipe hook | **Becomes redundant** on any network where this RFC is in force. Bump the marker, register new storage with a new `uriBase`, old data continues resolving to old storage forever. | The whole RFC |

The only thing that CHANGES is what agents do at mint time and at parse time. Nothing on disk is invalidated by adopting this. Nothing on chain is invalidated. Existing testnet KCs published against `did:dkg` keep working without anyone doing anything.

## 7. Implementation plan

Six PRs, ordered, each landable independently.

### PR 1 — Centralise UAL construction (refactor, ~1 day)

`packages/core/src/constants.ts` already centralises CG URIs (lines 158-217). Extend with a single `kcUal()` helper:

```typescript
export function kcUal(
  chainId: string,
  publisherAddress: string,
  startKAId: bigint | string,
  storageTag?: string,
): string {
  const tag = storageTag && storageTag.length > 0 ? `${storageTag}/` : '';
  return `did:dkg:${tag}${chainId}/${publisherAddress}/${startKAId}`;
}
```

Replace every `did:dkg:${this.chain.chainId}/...` template literal in `dkg-publisher.ts` with a call to this. Today's call sites all pass `storageTag = undefined` and produce identical output. Zero behavioural change; just collects the format in one place for later PRs to evolve.

**Test:** existing `dkg-publisher.test.ts` should pass unchanged. Add one `core/test/constants.test.ts` block exercising the helper with and without a tag.

### PR 2 — Teach the UAL parser the 4-segment form (~1 day)

Add `parseUal()` and `publisherAddressFromUal()` (the latter already exists in `dkg-publisher.ts:120` — move and generalise) to `packages/core/src/constants.ts`:

```typescript
export interface ParsedUal {
  chainId: string;
  storageTag: string;  // '' for default storage
  publisherAddress: string;
  startKAId: bigint;
}

export function parseUal(ual: string): ParsedUal | null { ... }
```

3-segment input → `storageTag = ''`. 4-segment input → tag in position 0. Anything else → `null`.

Update `verifyUALConsistency` (`publish-handler.ts:581`) to use the parser instead of raw `split('/')`. Same range-check semantics, just via the typed structure.

**Test:** `core/test/constants.test.ts` exercises every legal form + every malformed form. `publisher/test/publish-handler.test.ts` should pass unchanged because validation behaviour for 3-segment UALs is identical.

### PR 3 — Build the KC-storage registry (~2 days)

Add `packages/chain/src/kc-storage-registry.ts`:

```typescript
export class KCStorageRegistry {
  private byTag = new Map<string, Address>();
  private byAddress = new Map<Address, { tag: string; uriBase: string }>();

  async refresh(hub: Hub): Promise<void> { ... }
  getByTag(tag: string): Address | undefined { ... }
  getDefaultAddress(): Address { ... }
  tagFor(address: Address): string | undefined { ... }
}
```

Plumb it through `evm-adapter.ts` so it refreshes on agent startup + on `NewAssetStorage`/`AssetStorageChanged` events.

This registry is only *consumed* in later PRs. Adding it now lets later PRs land independently.

**Test:** unit tests against a mock Hub with two registered storages with different `uriBase`s.

### PR 4 — Use the registry at mint time (~2 days)

When the publisher mints a KC, it calls (via `evm-adapter`) some specific `KnowledgeCollectionStorage` contract. Currently the agent always uses the one named `"KnowledgeCollectionStorage"` in Hub. Change `dkg-publisher.ts` to:

1. Resolve the storage instance it's minting into (still defaults to the named-`KnowledgeCollectionStorage` instance — this PR doesn't introduce a V2 storage, it just makes the choice explicit).
2. Read `storage.uri(0)` once at startup, cache the tag.
3. Pass the tag to `kcUal()` when constructing the UAL.

For the default storage (`uriBase === "did:dkg"`), the tag is empty → 3-segment UAL → bit-for-bit identical to today.

**Test:** existing publish E2E tests unchanged. Add a unit test using a mock storage whose `uri(0)` returns `did:dkg:v2` to confirm the 4-segment form is produced.

### PR 5 — Use the registry at resolution time (~2 days)

Two consumers need teaching:

1. **`kc-extractor.extractV10KCFromStore` / random-sampling prover**: when handed a `kcId` from the chain's challenge, also accept `Challenge.knowledgeCollectionStorageContract`. Route the meta-graph lookup to use the storage's tag. Today the prover never had to disambiguate; from this PR forward, it does.
2. **The `verifyPublisherOwnsRange` chain-adapter method** (`evm-adapter.ts:1287-1302`): teach it which KC storage to consult, derived from the UAL. Currently it always queries `this.contracts.knowledgeAssetsStorage` — the V9 path. Should become "look up the storage by UAL tag, then query that one".

**Test:** add a random-sampling e2e variant that targets a V9-tagged KC alongside a V10-default KC and confirms both produce valid proofs.

### PR 6 — Document the convention (~half day)

Add `docs/STORAGE_VERSION_TAGS.md` (operator-facing) summarising the URI format, the registry, and how to retire a tag (you don't — tags are forever). Cross-link from `TESTNET_RESET.md` and `chain-reset-wipe.ts`'s header comment.

### Total

~1.5–2 weeks calendar time at one engineer's typical pace, sequenced into 6 reviewable PRs. None of them require a new contract deployment, a chain migration, a data migration, or a forced upgrade window.

## 8. Open questions

These are the decisions the RFC does not yet make. Each is small but explicit-consent-worthy.

1. **What's the right name for the V11 KC storage when it eventually deploys?** Naming convention: `KnowledgeCollectionStorageV11`? `KnowledgeCollectionStorage` + `uriBase: "did:dkg:v11"`? The Hub registry name and the URI tag are not the same thing today; we should pick a convention. Suggest: storage name follows the SemVer/version suffix (`KnowledgeCollectionStorageV11`); URI tag is shorter (`v11`); they're related by `KnowledgeCollectionStorage` → `""` (default), `KnowledgeCollectionStorageV{N}` → `v{N}` for N ≥ 11.
2. **Should `did:dkg` always remain the default storage tag?** Yes, IMO — it preserves every existing UAL forever. But this means we can never re-deploy "the default" storage; we'd always have to deploy a new tag and migrate logic over to read both. That's the *point*, but it's worth stating explicitly so a future maintainer doesn't try to "promote" V11 to be the new default.
3. **`KnowledgeAssetsV10`'s `getAssetStorageAddress("KnowledgeCollectionStorage")` call (`KnowledgeAssetsV10.sol:325`).** When V11 storage exists, V10's logic facade still grabs only the V10 storage. That's fine if we also deploy a V11 logic facade. But it implies "every storage version deploy comes with a paired logic facade deploy". Worth codifying as a rule.
4. **What about CG storage?** `ContextGraphStorage` is also a singleton today (`getAssetStorageAddress("ContextGraphStorage")` — see `KnowledgeAssetsV10.sol:347`, `ContextGraphs.sol:65`). The same versioning question applies. This RFC focuses on KC; CG should follow the same scheme in a follow-up RFC. CG URI construction already lives in `core/src/constants.ts`, so the centralisation work is half-done for that side.
5. **The Horizon-1 changes from issue #679 — non-destructive wipe + dev opt-out + mainnet refusal — are still recommended.** This RFC removes the *need* for the wipe over time, but doesn't help operators who are already running pre-RFC daemons on networks where the marker has bumped. The two efforts are complementary.

## 9. Test plan

Per PR, plus three integration sweeps:

1. **Old-data-still-valid sweep** (post-PR-5): take a `store.nq` from a pre-RFC daemon, boot a post-RFC daemon against it, confirm every UAL in it still resolves and every triple still passes verification. Run on both a fresh checkout and a `git revert`-style downgrade roundtrip.
2. **V9 + V10 coexistence sweep** (post-PR-5): the testnet already has both. Add a CI scenario that publishes one KC against V10 and one "KA" against V9 (via the archived path) and proves both resolve cleanly from a single agent. Pins the existing production behaviour as the reference for any future V11.
3. **Hypothetical V11 sweep** (post-PR-5): deploy a `KnowledgeCollectionStorageV11` to a local devnet with `uriBase: "did:dkg:v11"`, publish a KC against it, query it via the prover. End-to-end demonstration that the scheme accommodates a brand-new storage version without a single line of agent code change beyond what this RFC ships.

## 10. Out of scope

- **Content-addressed identity** (the "merkle root IS the ID" model from my earlier note). That's a separate, larger RFC that would also be additive on top of this one — the chain-id-based UAL becomes one of multiple canonical identifiers, with merkle-root-keyed URIs as a parallel form. Not blocking this RFC; tracked separately.
- **Wholesale removal of `chainResetMarker`** from networks. The marker is still useful on networks that DO want auto-wipe (early-stage testnets where operators have explicitly opted into "fresh state on every redeploy"). The marker should be opt-in per network rather than opt-out.
- **CG storage versioning.** Same story applies, but the design has its own moving parts (CG ownership ERC-721, participant agents, name registry). Worth a sibling RFC after this one is settled.
- **Cross-chain UALs.** The chainId segment already supports CAIP-2 form (`base:84532`). Multi-chain coordination is orthogonal.

## 11. Decision required

Two yes/no calls from the reviewer:

1. **Adopt the explicit-tag URI scheme as specified in §5.2, with the V9/V10 pattern as its precedent?** Yes/no.
2. **Sequence the 6 PRs as written, or pull a subset forward / push a subset back?** If pulled forward: PR-1 + PR-2 (the format + parser) are the only ones that must precede any future V2 KC storage deployment. PR-3 through PR-5 can be deferred until V2 is concretely planned.

If both answers are yes, this RFC moves to Accepted and the work is small + bounded enough to fit in a normal sprint.
