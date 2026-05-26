/**
 * Registry of all Knowledge Collection storage instances on a Hub,
 * indexed by their on-chain `uriBase` storage tag.
 *
 * Background — OT-RFC-40 §5.3:
 *
 * The DKG ontology has always permitted plural KC storage instances on
 * one Hub: V9 `KnowledgeAssetsStorage` (`uriBase: "did:dkg:v9"`) ships
 * alongside V10 `KnowledgeCollectionStorage` (`uriBase: "did:dkg"`)
 * on Base Sepolia today, both registered via `Hub.assetStorageSet`.
 * Until OT-RFC-40, this primitive was used but not surfaced — every
 * agent path resolved a single hardcoded name (`"KnowledgeCollectionStorage"`),
 * so a future V11 deploy under a fresh name would have been invisible
 * even though the chain itself supports it.
 *
 * This registry surfaces the primitive: given a Hub it discovers every
 * KC-class storage, reads each one's `uri(0)` (the ERC-1155 metadata
 * URI base baked into the storage at construction time), parses the
 * suffix into a UAL storage tag, and caches both directions so the
 * publisher can pick the right instance when minting and the resolver
 * can pick the right instance when handed an opaque UAL.
 *
 * Tag derivation (RFC §5.2 rule 2 + 3):
 *
 *   uriBase === "did:dkg"          → tag = ""    (the default storage)
 *   uriBase === "did:dkg:v9"       → tag = "v9"
 *   uriBase === "did:dkg:v11"      → tag = "v11"
 *   uriBase === "did:dkg:foo-bar"  → tag = "foo-bar"
 *
 * Anything that doesn't start with `did:dkg` or that yields a tag
 * which doesn't match `STORAGE_TAG_PATTERN` is logged as a warning
 * and skipped. Worst case is a misconfigured storage instance is
 * invisible to the agent until its deployment is fixed; we never
 * crash the daemon over a registry parse failure.
 *
 * The registry is intentionally a plain class with injected readers
 * rather than an evm-adapter-coupled component so it is unit-testable
 * without spinning up an actual chain. PR-3 lands the data structure;
 * PR-4 wires it into `dkg-publisher.ts` mint sites; PR-5 wires it into
 * the resolution sites.
 */

import { DID_DKG_PREFIX, STORAGE_TAG_PATTERN } from '@origintrail-official/dkg-core';

/**
 * Hub registry name prefixes that this registry treats as KC-class
 * storage. V9 KAS is included because it IS a KC-class storage in the
 * V10+ ontology — its UALs share the `did:dkg:` scheme and are routed
 * by the same tag mechanism.
 *
 * Other asset storages (e.g. `ContextGraphStorage`) are deliberately
 * excluded: CG-storage versioning is the subject of a sibling RFC.
 */
const KC_STORAGE_NAME_PREFIXES: readonly string[] = [
  'KnowledgeCollectionStorage',
  'KnowledgeAssetsStorage',
];

export interface KCStorageEntry {
  /**
   * Hub registry name as returned by `Hub.getAllAssetStorages()`,
   * e.g. `"KnowledgeCollectionStorage"` or `"KnowledgeAssetsStorage"`.
   * Distinct from `tag`: the same Hub name can in principle outlive
   * its tag (e.g. on a chain reset) but the tag is what UALs carry.
   */
  hubName: string;
  /** Storage contract address. */
  address: string;
  /**
   * Full `uri(0)` return value, e.g. `"did:dkg"` or `"did:dkg:v9"`.
   * Useful for round-tripping in logs / diagnostics; the RFC-40
   * routing key is `tag`, not `uriBase`.
   */
  uriBase: string;
  /**
   * Storage tag — empty string for the default storage (RFC §5.2
   * rule 3: there MUST be exactly one default), otherwise a value
   * matching `STORAGE_TAG_PATTERN`.
   */
  tag: string;
}

/**
 * Minimal Hub surface this registry needs. Mirrors
 * `Hub.getAllAssetStorages()` (declared in `Hub.sol:109-111`). Kept
 * as an interface rather than depending on an `ethers.Contract`
 * directly so the registry can be exercised by unit tests against an
 * in-memory fake.
 */
export interface KCStorageHubReader {
  getAllAssetStorages(): Promise<Array<{ name: string; addr: string }>>;
}

/**
 * Reads `uri(0)` (the ERC-1155 metadata URI) from a single KC storage
 * contract. Mirrors `ERC1155Delta.uri(uint256)` (declared in
 * `tokens/ERC1155Delta.sol:80-82` — the implementation returns the
 * `_uri` set in the `KnowledgeCollectionStorage` constructor; the
 * `tokenId` argument is ignored). Kept narrow and injectable so the
 * registry doesn't drag the full storage ABI into its surface.
 */
export interface KCStorageUriReader {
  /** Returns the storage's full `uriBase`, e.g. `"did:dkg"` or `"did:dkg:v9"`. */
  readUriBase(storageAddress: string): Promise<string>;
}

export interface KCStorageRegistryLogger {
  warn(message: string): void;
}

export interface KCStorageRegistryOptions {
  /** Optional logger; defaults to a no-op so unit tests don't need to stub it. */
  log?: KCStorageRegistryLogger;
}

/**
 * Caches the (tag, address, hubName, uriBase) tuple for every
 * KC-class storage on a single Hub.
 *
 * Lifecycle:
 *   - Construct with the two readers + options.
 *   - Call `refresh()` once at adapter init.
 *   - Call `refresh()` again on `Hub.NewAssetStorage` /
 *     `Hub.AssetStorageChanged` events (PR-3 ships the data
 *     structure; the evm-adapter wiring pulls in the listener
 *     plumbing in a future PR).
 *
 * Lookups are O(1) and side-effect-free. `refresh()` is the only
 * mutating operation; it is safe to call concurrently — concurrent
 * refreshes converge on the same final state, the worst case is
 * extra work.
 */
export class KCStorageRegistry {
  private byTag = new Map<string, KCStorageEntry>();
  private byAddress = new Map<string, KCStorageEntry>();
  private defaultEntry: KCStorageEntry | undefined;

  constructor(
    private readonly hubReader: KCStorageHubReader,
    private readonly uriReader: KCStorageUriReader,
    private readonly options: KCStorageRegistryOptions = {},
  ) {}

  private warn(message: string): void {
    this.options.log?.warn(`[KCStorageRegistry] ${message}`);
  }

  /**
   * Re-read every KC-class storage from the Hub and rebuild the cache.
   * Replaces the previous cache atomically so concurrent lookups
   * never see a partially-rebuilt state.
   */
  async refresh(): Promise<void> {
    let storages: Array<{ name: string; addr: string }>;
    try {
      storages = await this.hubReader.getAllAssetStorages();
    } catch (err) {
      this.warn(`Hub.getAllAssetStorages() failed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    const nextByTag = new Map<string, KCStorageEntry>();
    const nextByAddress = new Map<string, KCStorageEntry>();
    let nextDefault: KCStorageEntry | undefined;

    for (const { name, addr } of storages) {
      if (!KC_STORAGE_NAME_PREFIXES.some(prefix => name.startsWith(prefix))) continue;

      let uriBase: string;
      try {
        uriBase = await this.uriReader.readUriBase(addr);
      } catch (err) {
        this.warn(
          `${name} at ${addr}: uri(0) read failed (${err instanceof Error ? err.message : String(err)}); skipping`,
        );
        continue;
      }

      const tag = deriveStorageTag(uriBase);
      if (tag === null) {
        this.warn(`${name} at ${addr}: malformed uriBase "${uriBase}" (expected "did:dkg" or "did:dkg:<tag>"); skipping`);
        continue;
      }

      const entry: KCStorageEntry = { hubName: name, address: addr, uriBase, tag };

      const existingByTag = nextByTag.get(tag);
      if (existingByTag) {
        // Two storages claiming the same tag is a deployment-time
        // misconfiguration (RFC §5.2 rule 3 implies tags are unique).
        // We tolerate this rather than throw so the daemon doesn't
        // crash, but we surface it loudly. The newer registration wins
        // because that matches the Hub's update semantics
        // (`AssetStorageChanged` overwrites).
        this.warn(
          `tag "${tag || '(default)'}" claimed by both ${existingByTag.hubName} (${existingByTag.address}) and ${name} (${addr}); using the latter`,
        );
      }

      nextByTag.set(tag, entry);
      nextByAddress.set(addr, entry);
      if (tag === '') nextDefault = entry;
    }

    if (!nextDefault) {
      this.warn(
        'no default KC storage (uriBase === "did:dkg") detected on this Hub; UALs in the legacy 3-segment form will not resolve via this registry',
      );
    }

    this.byTag = nextByTag;
    this.byAddress = nextByAddress;
    this.defaultEntry = nextDefault;
  }

  /**
   * Look up a storage by its UAL tag. Empty string returns the
   * default storage (the one whose `uriBase` is exactly `did:dkg`).
   */
  getByTag(tag: string): KCStorageEntry | undefined {
    if (tag === '') return this.defaultEntry;
    return this.byTag.get(tag);
  }

  /**
   * Look up a storage by its on-chain address. Returns `undefined`
   * for any address not seen by the most recent `refresh()`.
   *
   * Address lookup is intentionally case-sensitive: callers should
   * either pass the address in the same case the Hub returned (which
   * the EVM adapter already does) or normalise via ethers.getAddress
   * upstream. Avoiding internal normalisation keeps this class
   * ethers-free and unit-testable.
   */
  getByAddress(address: string): KCStorageEntry | undefined {
    return this.byAddress.get(address);
  }

  /**
   * Convenience accessor for the default storage's entry. Returns
   * `undefined` if the most recent `refresh()` did not detect any
   * storage with `uriBase === "did:dkg"`.
   */
  getDefault(): KCStorageEntry | undefined {
    return this.defaultEntry;
  }

  /**
   * The default storage's address. Useful for sites that want to
   * preserve "always mint into the default" behaviour while still
   * routing the UAL tag correctly.
   */
  getDefaultAddress(): string | undefined {
    return this.defaultEntry?.address;
  }

  /**
   * Tag for a known address; mirrors `getByAddress` but returns just
   * the tag for sites (e.g. mint UAL construction) that only need
   * the routing key.
   */
  tagFor(address: string): string | undefined {
    return this.byAddress.get(address)?.tag;
  }

  /** Snapshot of every entry, for diagnostic/CLI use. */
  getAll(): KCStorageEntry[] {
    return Array.from(this.byAddress.values());
  }
}

/**
 * Parse a storage's `uriBase` into the RFC-40 storage tag. Returns
 * `null` if the input is malformed (doesn't start with `did:dkg`, or
 * yields a tag that doesn't match `STORAGE_TAG_PATTERN`).
 *
 * Exported for unit tests and for deployment-time validation; in
 * normal operation the registry calls this internally.
 */
export function deriveStorageTag(uriBase: string): string | null {
  // Default storage: "did:dkg" exactly. No trailing colon, no tag.
  if (uriBase === 'did:dkg') return '';

  // Tagged storage: must start with "did:dkg:".
  if (!uriBase.startsWith(DID_DKG_PREFIX)) return null;
  const tag = uriBase.slice(DID_DKG_PREFIX.length);

  // Empty tag after the prefix is malformed (would mean uriBase ends
  // with a bare colon).
  if (tag.length === 0) return null;

  // Tag character set is intentionally narrow — see `parseUal`'s
  // disambiguation rules. A storage whose `uriBase` is rejected here
  // is undeployable under the RFC-40 scheme; the deployment script is
  // expected to validate against `STORAGE_TAG_PATTERN` before
  // submitting the construction tx.
  if (!STORAGE_TAG_PATTERN.test(tag)) return null;

  return tag;
}
