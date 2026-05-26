# Storage Version Tags — operator guide

**Status:** stable as of OT-RFC-40 (PR-1 → PR-5)
**Companion:** [`docs/RFC40_MULTI_STORAGE_KC_URI_SCHEME.md`](./RFC40_MULTI_STORAGE_KC_URI_SCHEME.md), [`docs/TESTNET_RESET.md`](./TESTNET_RESET.md)

## TL;DR

Every Knowledge Collection UAL embeds the **storage instance** that
minted it. That tag is what makes V9 and V10 KCs coexist on the same
Hub today, and it is what will make V11, V12, and any future storage
upgrade additive (no chain-state wipe, no data loss) instead of
destructive.

You will see two valid UAL forms in the wild and in your own logs:

```
Default storage  (legacy, V10 today):  did:dkg:{chainId}/{publisher}/{startKAId}
Tagged storage   (V9 today, V11+...):  did:dkg:{tag}/{chainId}/{publisher}/{startKAId}
```

`{tag}` is `[a-z0-9-]+`. A KC's tag is **forever** — once a KC is minted
its UAL will never re-tag.

## What the tag is, in one sentence

A storage instance's `uri(0)` ERC-1155 view returns its `uriBase`
(`did:dkg`, `did:dkg:v9`, `did:dkg:v11`, …). The agent strips the
common `did:dkg:` prefix; whatever remains is the tag (empty for the
default storage). The tag is the storage's URI suffix, so you can read
it directly off-chain at any time.

## Why this matters to operators

Three things change on the operator-visible surface:

1. **Logs now show 4-segment UALs for V9 KAs.** This is normal:
   `did:dkg:v9/base:84532/0xA1.../12345`. Treat it identically to a
   V10 UAL — the daemon already routes correctly.
2. **The `chain-reset-wipe` hook is no longer the right answer for
   storage-only redeploys.** Bumping `network/<env>.json#chainResetMarker`
   still works, but on any network where a new KC storage version was
   deployed alongside the old one, the right cutover is "register the
   new storage with a new `uriBase`" — old data keeps resolving to old
   storage, new data uses new storage, no wipe needed. Reach for the
   marker only when actual chain entities (CG ids, identity ids) are
   redeployed too. See "When to bump the marker" below.
3. **There is no per-operator action for the multi-storage scheme to
   take effect.** PR-3's registry runs at agent boot; it discovers
   every registered KC-class storage on the Hub automatically and
   refreshes on `Hub.NewAssetStorage` / `AssetStorageChanged` events.

## Reading a UAL

```
did:dkg:base:84532/0xA1.../12345
        └── chainId        └── tokenId on the default storage's contract

did:dkg:v9/base:84532/0xA1.../12345
        └── tag            └── tokenId on the V9 KAS contract
            └── chainId
```

Helper in code: `parseUal(ual)` from `@origintrail-official/dkg-core`.
It returns `{ chainId, storageTag, publisherAddress, startKAId }` or
`null` for malformed input. Both 3- and 4-segment forms parse without
ambiguity.

## How a new storage tag goes live

For maintainers / contracts deployers (operators do nothing).

1. Deploy the new storage (e.g. `KnowledgeCollectionStorageV11`) with
   a fresh `uriBase` of the form `did:dkg:<tag>` — e.g. `did:dkg:v11`.
   The tag MUST match `[a-z0-9-]+` (no spaces, no slashes, no `:`).
2. Register it on Hub via `Hub.setAssetStorageContract(name, addr)` or
   `Hub.setAndReinitializeContracts(...)`. The Hub emits
   `NewAssetStorage` (or `AssetStorageChanged` if rotating an existing
   slot).
3. Every running daemon refreshes its `KCStorageRegistry` on those
   events. No restart needed — the next publish or random-sampling
   challenge against the new storage just works.
4. Subsequent mints into the new storage produce
   `did:dkg:<tag>/{chainId}/{publisher}/{startKAId}` UALs
   automatically — the publisher reads `uri(0)` once at init and
   stamps every UAL with that tag.

The old storage stays registered; old data keeps resolving. There is
no migration step.

## What never changes about a tag

- **The default storage's tag is empty, forever.** A storage whose
  `uriBase` is exactly `did:dkg` produces 3-segment UALs; we will not
  promote a different storage to be "the new default" because that
  would require rewriting every legacy UAL. Keep the V10 storage at
  `did:dkg`, and add V11, V12, … as tagged peers.
- **Tags are not retired.** If you need to take a storage out of
  rotation (e.g. for safety), keep it deployed and just stop minting
  into it. Existing UALs against that tag must continue to resolve.
- **Two storages MUST NOT share a tag.** The registry indexes by tag;
  collision means one of them is unreachable. The deploy pipeline
  should reject duplicate `uriBase` values; if you ever observe a
  collision in `dkg_query`, that's a contracts-side bug, not a daemon
  bug.

## How resolution works (for the curious)

```
Publish path  (mint)          Resolution path  (read / verify)
──────────────────             ──────────────────────────────
publisher.publish()            kc-extractor.extractV10KC(...)
  ↓                              ↓
ChainAdapter.mintingStorageTag   parseUal(ual).storageTag
  (read from KCS.uri(0)            ↓
   once at init, cached)          KCStorageRegistry.getByTag(tag)
  ↓                                ↓
kcUal(chainId, pub, id, tag)    storage contract address
  ↓                                ↓
4-segment if tag != ''          query that contract
  3-segment otherwise           (publisher / merkle root / range)
```

Random sampling is the most subtle case: the chain-side
`Challenge.knowledgeCollectionStorageContract` is the address of the
storage that holds the challenged KC. The prover passes that address
through `KCStorageRegistry.tagFor(addr)` to get the storage tag, then
filters its meta-graph lookup by that tag — so a prover holding two
KCs with the same `kcId` (one V9, one V10) attests to the right one.

## When to bump `chainResetMarker` after this RFC

You're bumping the marker because **non-storage** chain entities have
been replaced and the daemon's per-node state (publish journal,
random-sampling WAL) references entities that no longer exist:

- Hub redeploy (new chain identity altogether): **bump.**
- IdentityStorage / Profile redeploy: **bump.**
- Context graph storage redeploy *with new ownership*: **bump.**
- KC storage v→v+1 redeploy (new `uriBase`, both registered): **don't
  bump.** Old data is still valid; the multi-storage scheme handles it.
- KC storage same-tag redeploy (a "fix-forward" that reuses
  `uri(0)`): **bump if and only if existing data on the old contract
  is being abandoned.** Otherwise prefer redeploying as a new tag.

The auto-wipe hook itself is unchanged by this RFC — it remains the
right tool when chain identity actually changes.

## Failure modes & how to debug them

| Symptom | First check |
|---|---|
| Publish gets a "publisher does not own UAL range …" rejection on a default-storage UAL | The receiver is on a Hub without a V9 KAS deployment. The V10 default path defers to ACK auth and should NOT be hitting the V9 `getPublisherRange*` API. If it is, the receiver hasn't picked up RFC-40 PR-5; upgrade. |
| Random-sampling proof fails with "no KC found" but the KC is in the local store | The prover may be looking for the wrong storage's KC. Check that `KCStorageRegistry.tagFor(challenge.knowledgeCollectionStorageContract)` returns a non-undefined tag. If undefined, the challenged storage isn't in the registry — refresh by triggering a `Hub.NewAssetStorage` event or restarting the daemon. |
| `parseUal()` returns `null` for what looks like a valid UAL | The publisher address must match `^0x[0-9a-fA-F]{40}$` — the parser intentionally rejects "UALs" that are actually CG data URIs (`did:dkg:context-graph:...`) or other DID forms. If your UAL doesn't have a valid 40-hex-character publisher segment, it's not a KC UAL. |
| Daemon log shows a UAL with an unfamiliar tag | This is fine — tags are forever. Look it up: `dkg query 'PREFIX hub: <…> SELECT ?addr WHERE { ?addr code:uriBase "did:dkg:<tag>" }'` or read `Hub.getAssetStorageAddress(...)` directly. |

## Cross-references

- [`packages/core/src/constants.ts`](../packages/core/src/constants.ts):
  `kcUal()`, `parseUal()`, `publisherAddressFromUal()`,
  `STORAGE_TAG_PATTERN`.
- [`packages/chain/src/kc-storage-registry.ts`](../packages/chain/src/kc-storage-registry.ts):
  `KCStorageRegistry`, `deriveStorageTag()`.
- [`packages/chain/src/evm-adapter.ts`](../packages/chain/src/evm-adapter.ts):
  `mintingStorageTag` field, `kcStorageRegistry` field, Hub event
  listeners that refresh the registry, tag-aware
  `verifyPublisherOwnsRange()`.
- [`packages/random-sampling/src/kc-extractor.ts`](../packages/random-sampling/src/kc-extractor.ts):
  `extractV10KCFromStore({ expectedStorageTag })`.
- [`packages/cli/src/daemon/chain-reset-wipe.ts`](../packages/cli/src/daemon/chain-reset-wipe.ts):
  the auto-wipe hook (unchanged by this RFC; still the right tool for
  non-storage chain-identity changes).
- [`docs/TESTNET_RESET.md`](./TESTNET_RESET.md): full reset runbook
  (Phases A-D).
- [`docs/RFC40_MULTI_STORAGE_KC_URI_SCHEME.md`](./RFC40_MULTI_STORAGE_KC_URI_SCHEME.md):
  the design rationale, alternatives considered, and PR sequencing.
