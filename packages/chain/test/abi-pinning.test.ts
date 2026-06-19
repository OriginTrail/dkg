/**
 * ABI hash pinning — catches silent contract changes.
 *
 * Audit findings covered:
 *
 *   CH-5 (HIGH) — `packages/chain/abi/*.json` is a *snapshot* of the
 *                 `@origintrail-official/dkg-evm-module` artifacts, copied
 *                 into this package so consumers don't need to pull the
 *                 Hardhat toolchain as a transitive dep. The copy has no
 *                 drift detector: if the contract source changes (new
 *                 event field, reordered struct member, renamed error) but
 *                 the ABI is NOT regenerated here, every call through
 *                 `EVMChainAdapter` still "works" against the live chain
 *                 right up until a decode/encode round-trip hits the drift
 *                 — and then it emits a generic ethers decode error that
 *                 is hard to attribute.
 *
 *                 This test pins a stable digest of the event-and-error
 *                 signature set for every ABI that `EVMChainAdapter`
 *                 actually loads. The digest is computed from
 *                 `(name, type, inputs[].type, inputs[].name, indexed?)` —
 *                 the subset that actually matters for off-chain parsing.
 *                 Cosmetic JSON formatting changes (whitespace, key
 *                 ordering inside objects) are filtered out so `pnpm
 *                 build` or a `jq .` reformat does not trip the pin.
 *
 *                 If the digest changes, the test prints a `UPDATE_HINT`
 *                 line showing the new value so the maintainer can review
 *                 the diff intentionally before updating the pin.
 *
 * Per QA policy: failing pin ⇒ review the ABI diff; do NOT just update
 * the pin blindly. A compatibility break here may mean downstream
 * consumers (publisher, agent, cli) also need to regenerate their ABIs.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const ABI_DIR = join(import.meta.dirname, '..', 'abi');

interface AbiEntry {
  type: string;
  name?: string;
  inputs?: Array<{ type: string; name?: string; indexed?: boolean; components?: unknown }>;
  outputs?: Array<{ type: string; name?: string; components?: unknown }>;
  stateMutability?: string;
  anonymous?: boolean;
}

/**
 * Compute a stable digest over an ABI that captures the shape used by
 * off-chain encoders/decoders and ignores cosmetic JSON layout.
 *
 * Included: event + error + function signatures with parameter types and
 *           (for events) indexed flags. Function mutability is included so
 *           a `view` → `nonpayable` flip (which silently changes whether
 *           a call needs a tx) is caught.
 *
 * Excluded: parameter *names*. We already hash `(type, indexed)` which is
 *           what ABI coders use; parameter renames that don't change the
 *           wire format must not trip this pin.
 */
function canonicalAbiDigest(contractName: string): string {
  const raw = readFileSync(join(ABI_DIR, `${contractName}.json`), 'utf8');
  const abi = JSON.parse(raw) as AbiEntry[];
  const signatures: string[] = [];
  for (const entry of abi) {
    if (entry.type === 'event') {
      const params = (entry.inputs ?? [])
        .map((i) => `${i.type}${i.indexed ? ' indexed' : ''}`)
        .join(',');
      signatures.push(`event ${entry.name}(${params})${entry.anonymous ? ' anonymous' : ''}`);
    } else if (entry.type === 'error') {
      const params = (entry.inputs ?? []).map((i) => i.type).join(',');
      signatures.push(`error ${entry.name}(${params})`);
    } else if (entry.type === 'function') {
      const params = (entry.inputs ?? []).map((i) => i.type).join(',');
      const outs = (entry.outputs ?? []).map((o) => o.type).join(',');
      signatures.push(`function ${entry.name}(${params})->${outs} [${entry.stateMutability ?? '?'}]`);
    } else if (entry.type === 'constructor') {
      const params = (entry.inputs ?? []).map((i) => i.type).join(',');
      signatures.push(`constructor(${params})`);
    }
  }
  signatures.sort();
  return createHash('sha256').update(signatures.join('\n')).digest('hex');
}

// These pins were computed at the time the test was authored against the
// ABI snapshot in `packages/chain/abi/` on branch tests/improve off v10-rc.
// If a pin changes, the test prints the new digest so the maintainer can
// update this table intentionally after reviewing the ABI diff.
const PINNED_DIGESTS: Record<string, string> = {
  // Critical V10 lifecycle contracts — drift here breaks publish/update.
  // Updated PR #357: V10 publish/update flows now carry merkleLeafCount
  // (uint256) in addition to merkleRoot, propagating through:
  //   - KnowledgeCollection.publish/update fn signatures (root cause)
  //   - KnowledgeAssetsV10 publish + ACK digest input set
  //   - KnowledgeCollectionStorage event payload (KnowledgeAssetCreated /
  //     KnowledgeAssetUpdated still carry the same ABI shape today;
  //     the digest changed because the function inputs they originate from
  //     changed). Sanity tests below pin the actual event field shapes.
  // Updated PR #436 round 2: agent-provenance review feedback. Reverted
  // the `MerkleRoot.author` struct field (would have broken the dynamic
  // array slot stride for already-deployed KCs) and moved author to a
  // parallel `merkleRootAuthors[kaId][rootIndex]` mapping. Also added
  // an `address author` argument to `createKnowledgeAsset` /
  // `updateKnowledgeAsset` and the matching indexed topic on the
  // `KnowledgeAssetCreated` / `KnowledgeAssetUpdated` events.
  // Updated PR `feature/conviction-lazy-settlement`: conviction-path
  // publish/update now invokes the NFT's `coverPublishingCost` with
  // (kcStartEpoch, kcEpochs) so it can fund the KC's epoch range via
  // the active sink. The `InvalidPublishingConvictionEpochs` error was
  // removed from KAV10 (the NFT enforces the bound internally).
  // Updated PR #470 round 3: PCA-funded publishes route into the
  // discount branch only when the wallet is a registered agent AND the
  // PCA is not expired AND `p.epochs == lockDurationEpochs`. Any miss
  // falls through to direct spend at full price — a stale agent
  // registration or wrong epoch count no longer reverts the publish.
  // The transient `PCAEpochsMismatch` error introduced earlier in this
  // PR was removed (it became unreachable). Update path uses `<=` for
  // `remainingEpochs` since update legitimately passes a delta.
  //
  // Updated PR #630 (RFC-39 Phase A.5): `KnowledgeAssetsV10.publish` /
  // `update` now thread a per-KC ciphertext commitment pair
  // (`(bytes32 ciphertextChunksRoot, uint64 ciphertextChunkCount)`)
  // through `V10PublishParams` / `V10UpdateParams`. The picker in
  // `RandomSampling` (curated draw, step 2) reads these via
  // `KnowledgeCollectionStorage.getLatestCiphertextChunksRoot` /
  // `…ChunkCount` to filter pre-LU-11 curated KCs out of the curated
  // lottery. The KCS hash drift here reflects the new storage getters
  // + the `CiphertextChunksCommitmentSet` event surface that
  // `KnowledgeAssetsV10._executeUpdateCore` emits when a non-zero pair
  // rotates the commitment.

  // Greenfield rename (rc.12): logic + storage pair replaces the legacy names.
  // Updated PR #1072 (RFC-39): the chain-local ABI now declares the new
  // `CuratedCGRequiresCiphertextCommitment(uint256)` error. evm-adapter-abi
  // resolves this contract from packages/chain/abi/ first (the evm-module copy
  // is only a fallback), so the error had to be added here for chain-side revert
  // decoding to name it instead of "unknown custom error". Digest now matches
  // the evm-module ABI surface.
  // Re-pinned for OT-RFC-49 (catalog-sampling strip): the curated random-sampling
  // commitment moved from the private ciphertext to the public `_catalog`. ABI
  // surface changes: errors `PublicCGCannotHaveCatalogCommitment` /
  // `CuratedCGRequiresCatalogCommitment` / `IncompleteCatalogCommitment` (renamed
  // from the `*Ciphertext*` set), and `PublishParams`/`UpdateParams` now carry
  // `catalogRoot`/`catalogLeafCount` (was `ciphertextChunksRoot`/`ciphertextChunkCount`).
  KnowledgeAssetsLifecycle:     'fcfe8541052c25c31775e0e5b6a2923bba024e59dd3c03e829f330f8499191cb',

  // Re-pinned for OT-RFC-43 Option-1 (variant 1a, PR #975): deterministic
  // author-namespaced KA identity. `createKnowledgeAsset` now takes an explicit
  // caller-supplied `uint256 kaId` (the packed author-namespaced id), and two
  // guard errors were added — `KaIdAlreadyMinted(uint256)` and
  // `KaIdNamespaceMismatch(uint256,address)` — plus a deprecated accessor.
  // Re-pinned again (#1080): added the O(1) `getMaxKaNumberForAuthor(address)
  // -> int256` view so the off-chain allocator reconciles its floor with one
  // eth_call instead of an unbounded `KnowledgeAssetCreated` log scan. Pure
  // function-only ABI addition (events + errors unchanged); the chain-local
  // copy is refreshed in lockstep with the evm-module ABI in the same PR.
  // Re-pinned for OT-RFC-49 (catalog-sampling strip): `setCatalogCommitment` /
  // `getCatalogRoot` / `getCatalogLeafCount` + event `KnowledgeAssetCatalogCommitmentSet`
  // (replacing the `*Ciphertext*` setter/getters/event, now removed from the ABI).
  DKGKnowledgeAssets:           '4b0adb51db38c7e11de0692f77bd322e2f01ac3dc393d0ed9ca7a7bfcdd2d358',
  // V8 `KnowledgeCollection` ABI was moved to `abi/archive/` in
  // `archive-non-v10-contracts`; the pin entry is intentionally dropped.
  // Updated for SPEC_CG_MEMORY_MODEL: per-CG hosting committees and
  // per-CG `requiredSignatures` were removed. Every CG is hosted by the
  // sharding table at publish time and the ACK quorum is the system
  // parameter `parametersStorage.minimumRequiredSignatures()`.
  // `setHostingNodes`, `updateQuorum`, `getHostingNodes`, `isHostingNode`,
  // `getContextGraphRequiredSignatures`, `HostingNodesSet`, `QuorumUpdated`,
  // and the `hostingNodes`+`requiredSignatures` fields on `createContextGraph`
  // / `ContextGraphCreated` / `getContextGraph` are all gone.
  // Updated OT-RFC-38 / LU-6 Phase B: `bytes32 nameHash` added as the 8th
  // arg to `createContextGraph` (+ matching `bytes32 indexed nameHash` in
  // `ContextGraphCreated` event between `owner` and `participantAgents`),
  // plus a new `getNameHash(uint256)` accessor. Curator-committed wire
  // identifier so hosting cores can derive the SWM gossip topic directly
  // from chain events — no off-chain discovery channel required for
  // registered CGs.
  ContextGraphs:                'a27718118b5d03626b0e3389ad854451caf3ed0c702cea1b770953bb439d589e',
  // Repinned: KC→KA rename of the public getters (getContextGraphKCCount/At/List →
  // getContextGraphKaCount/At/List); adapter updated, contract bumped to 10.0.3.
  ContextGraphStorage:          '30d101a1794836279085d21dc8e7acb83fe6545ab1bc1455fab80fc33ecafa8c',
  // Identity / staking — consulted on every publish.
  Hub:                          '36976cc71bb87963b8b715791b32e4eb6b7bb85c712998afd6184221289a506b',
  Identity:                     'ca39efe9bd9ec4fd8ae67dccdf9eb888bf91232341c3a56216624477620ff4d8',
  IdentityStorage:              'd7c58ba8ae28523dc1a6ff0bc228a3bceb9d327e53d258099dada656db262479',
  // Updated PR #470 round 2: `MAX_PUBLISHING_CONVICTION_EPOCHS = 60`
  // exposed as a public constant + tightened bound in
  // `setPublishingConvictionEpochs`. Caps the worst-case
  // `_settleElapsed` / `_finalSweep` loop count so governance can no
  // longer brick PCAs by raising `publishingConvictionEpochs`.
  //
  // Updated (protocol treasury fee): added `protocolTreasuryFee()` (uint16
  // getter), `protocolTreasury()` (address getter),
  // `MAX_PROTOCOL_TREASURY_FEE()` (uint16 constant getter),
  // `setProtocolTreasuryFee(uint16)`, `setProtocolTreasury(address)`, and
  // the `ProtocolTreasurySet(address indexed)` event. The fee is skimmed
  // from staker-bound TRAC on every paid publish / update / extend by
  // `KnowledgeAssetsLifecycle` + `PublishingConviction` (no ABI change on
  // those two — internal logic + version bump only).
  //
  // Updated PR #1083: added `ZeroShardingTableSizeLimit()` for the
  // governance guard that rejects `setShardingTableSizeLimit(0)`.
  ParametersStorage:            '7816845cbccd120eaf44eccea56f530e9c8e8894023d0693fddcc8546161575d',
  // Added PR #470 round 3: pin the V10 NFT-backed PCA contract so that
  // any drift in its events (CostCovered / WindowSettled /
  // AccountFinalSwept / TokensAddedToEpochRange consumers) or errors
  // (AccountExpired / NoConvictionAccount / InvalidConvictionKcEpochs)
  // is flagged at the chain-package boundary. `EVMChainAdapter`
  // resolves this contract and the publisher SDK probes it via
  // `getConvictionAgentAccountId` / `getConvictionAccountLockDurationEpochs`
  // (Codex round-3 finding on PR #470).
  //
  // Updated PR #650 (storage / logic split): the wrapper is now a slim
  // ERC-721 facade. PCA business events (AccountCreated, ToppedUp,
  // CostCovered, WindowSettled, AccountFinalSwept, AgentRegistered,
  // AgentDeregistered) and PCA business errors (NoConvictionAccount,
  // AccountExpired, AgentAlreadyRegistered, AgentNotRegistered,
  // AgentCapReached, InvalidConvictionKcEpochs,
  // InvalidPublishingConvictionEpochs, InsufficientAllowance,
  // AccountAlreadyFullySettled, BillingWindowMismatch) all moved to
  // `PublishingConviction` (logic) — the wrapper digest collapses to
  // the ERC-721 surface plus mint/burn forwarders. The post-split
  // pins below capture all three surfaces; chain consumers MUST load
  // both `DKGPublishingConvictionNFT` (for ERC-721 + forwarders) and
  // `PublishingConviction` (for PCA event/error decoding) — see
  // `getPcaLogicInterface` in `evm-adapter.ts` and the
  // `ERROR_ABI_CONTRACTS` list update in the same file. This
  // intentional break is documented as the v2.x → v3.0.0 wrapper
  // bump in the wrapper NatSpec.
  //
  // Updated OT-RFC-51 (publishing allocation): INTENTIONAL drift across the
  // three conviction pins below — the conviction account now designates a
  // primary node that receives the PCA's per-epoch publishing allocation.
  // ABI surface changes synced into packages/chain/abi/ and re-pinned here:
  //   - createAccount gained a `uint72 primaryNode` arg (new arity) — wrapper
  //     forwarder + logic entrypoint.
  //   - new `setPrimaryNode(accountId, primaryNode)` to (re)designate the node,
  //     with a `ZeroPrimaryNode` revert guard; `moveEpochPublishingAllocation`
  //     shifts the seeded allocation when the designation changes.
  //   - the PCA Account tuple widened to carry the designated primaryNode.
  //   - the old per-publish "realized-publish credit" path (which credited a
  //     node's allocation per publish) was removed; allocation is now seeded
  //     prorated at account creation. The legacy "publishingAllocation" naming
  //     was renamed accordingly. The KAL/KCS pins did NOT drift (verified) —
  //     this RFC touched only the conviction contracts.
  DKGPublishingConvictionNFT:   '5bf5638221eb973bf4ba084378cfdaf6211decb6b68dd0b9bce2f93842bd7fca',
  // Updated (protocol treasury fee): added the public
  // `convictionStakingStorage()` getter (the TRAC vault the fee is paid out
  // of via `transferStake`). No event/error surface change — `settle()`,
  // `coverPublishingCost`, and the PCA business events/errors are unchanged.
  // Updated OT-RFC-51: see the conviction-pin note above — createAccount arity,
  // setPrimaryNode/ZeroPrimaryNode/PrimaryNodeUnchanged/moveEpochPublishingAllocation,
  // widened Account tuple, realized-publish credit removed / publishingAllocation rename.
  // Repinned: KC→KA rename of error InvalidConvictionKcEpochs → InvalidConvictionKaEpochs
  // (error selector change; contract bumped to 10.0.5).
  PublishingConviction:         'a4d44a594509e508091b1f91adfb1d68bec65e38e497f054116493af327ff096',
  // Updated OT-RFC-51: storage surface for the above — primaryNode field on the
  // widened Account tuple + the seeded per-epoch publishing allocation getters.
  PublishingConvictionStorage:  '7eeae71f0efd9183fce232ccc669227dfd70fe4f93b4663392a0a52c1ccba859',
};

describe('ABI pin digest — detects silent contract surface drift [CH-5]', () => {
  for (const [name, expected] of Object.entries(PINNED_DIGESTS)) {
    it(`${name} ABI digest is stable`, () => {
      const actual = canonicalAbiDigest(name);
      if (expected === 'PIN_UNSET') {
        // First run — establish the pin baseline. This test stays RED until
        // the maintainer captures the digest in PINNED_DIGESTS. That RED
        // state is deliberate: `PIN_UNSET` means "nobody has reviewed this
        // ABI yet for the pin table".
        //
        // UPDATE_HINT: copy the value below into PINNED_DIGESTS[name].
        console.log(`UPDATE_HINT [${name}]: ${actual}`);
        expect(expected, `pin not yet set; current digest is ${actual}`).not.toBe('PIN_UNSET');
      } else {
        if (actual !== expected) {
          console.log(`UPDATE_HINT [${name}]: new digest is ${actual}`);
        }
        expect(actual).toBe(expected);
      }
    });
  }
});

describe('ABI content sanity — required event/error surfaces are present [CH-5 / CH-6]', () => {
  it('KnowledgeCollectionStorage declares KnowledgeAssetCreated with the full spec field set', () => {
    const abi = JSON.parse(
      readFileSync(join(ABI_DIR, 'DKGKnowledgeAssets.json'), 'utf8'),
    ) as AbiEntry[];
    const ev = abi.find((e) => e.type === 'event' && e.name === 'KnowledgeAssetCreated');
    expect(ev).toBeDefined();
    const types = (ev!.inputs ?? []).map((i) => i.type);
    // V10.1 author-attestation surface: id, author, publishOperationId,
    // merkleRoot, byteSize, startEpoch, endEpoch, tokenAmount, isImmutable.
    // `author` is an indexed `address` so off-chain readers can filter
    // event logs by author identity without a storage call.
    expect(types).toEqual([
      'uint256',
      'address',
      'string',
      'bytes32',
      'uint88',
      'uint40',
      'uint40',
      'uint96',
      'bool',
    ]);
    const authorInput = ev!.inputs?.[1];
    expect(authorInput?.name).toBe('author');
    expect(authorInput?.indexed).toBe(true);
  });

  it('KnowledgeCollectionStorage declares KnowledgeAssetsMinted (id, to, startId, endId)', () => {
    const abi = JSON.parse(
      readFileSync(join(ABI_DIR, 'DKGKnowledgeAssets.json'), 'utf8'),
    ) as AbiEntry[];
    const ev = abi.find((e) => e.type === 'event' && e.name === 'KnowledgeAssetsMinted');
    expect(ev).toBeDefined();
    const types = (ev!.inputs ?? []).map((i) => i.type);
    expect(types).toEqual(['uint256', 'address', 'uint256', 'uint256']);
  });

  it('ContextGraphStorage declares ContextGraphCreated with the post-LU-6-Phase-B shape (nameHash inserted as 3rd field)', () => {
    // OT-RFC-38 / LU-6 Phase B adds `bytes32 indexed nameHash` between
    // `owner` and `participantAgents`. The field is INSERTED rather
    // than appended so cores reading the event can pull it off the
    // indexed topics array (topic[3] in the new layout) instead of
    // ABI-decoding the data tail — keeps the chain-event-driven host-
    // mode auto-subscribe path O(1) per event.
    const abi = JSON.parse(
      readFileSync(join(ABI_DIR, 'ContextGraphStorage.json'), 'utf8'),
    ) as AbiEntry[];
    const ev = abi.find((e) => e.type === 'event' && e.name === 'ContextGraphCreated');
    expect(ev).toBeDefined();
    const types = (ev!.inputs ?? []).map((i) => i.type);
    expect(types).toEqual([
      'uint256',   // contextGraphId
      'address',   // owner
      'bytes32',   // nameHash (LU-6 Phase B)
      'address[]', // participantAgents
      'uint256',   // metadataBatchId
      'uint8',     // accessPolicy
      'uint8',     // publishPolicy
      'address',   // publishAuthority
      'uint256',   // publishAuthorityAccountId
    ]);
    // Indexed: contextGraphId, owner, nameHash.
    const indexed = (ev!.inputs ?? []).map((i) => Boolean(i.indexed));
    expect(indexed.slice(0, 3)).toEqual([true, true, true]);
  });

  it('KnowledgeCollectionStorage declares KnowledgeAssetUpdated (V10 update event)', () => {
    const abi = JSON.parse(
      readFileSync(join(ABI_DIR, 'DKGKnowledgeAssets.json'), 'utf8'),
    ) as AbiEntry[];
    const ev = abi.find((e) => e.type === 'event' && e.name === 'KnowledgeAssetUpdated');
    expect(ev).toBeDefined();
    const types = (ev!.inputs ?? []).map((i) => i.type);
    // V10.1 update event mirrors the publish event: the second indexed
    // arg is `author`. The current V10.1 update path emits
    // `address(0)` (no attestation yet) but the slot is reserved for
    // vNext when updates start signing the EIP-712 envelope too.
    expect(types).toEqual(['uint256', 'address', 'string', 'bytes32', 'uint256', 'uint96']);
  });
});

describe('ABI dir reflects the KC→KA rename — retired ABIs gone, renamed ABIs present [rc.12]', () => {
  // The greenfield rename (rc.12) replaced the V10.0 logic/storage pair
  // `KnowledgeAssetsV10` + `KnowledgeCollectionStorage` with
  // `KnowledgeAssetsLifecycle` + `DKGKnowledgeAssets`, and moved the V8
  // `KnowledgeCollection` ABI under `abi/archive/`. `EVMChainAdapter` loads
  // ABIs by bare filename from this dir (`readContractAbi`), so a retired ABI
  // silently re-surfacing at the top level is exactly the drift the rename
  // was meant to eliminate — a consumer could bind to a stale contract
  // surface. The digest pins above only cover files that still exist; this
  // block pins the directory SHAPE so a regenerate/copy mistake that brings
  // an old ABI back turns the lane red.
  const retired = [
    'KnowledgeAssetsV10',
    'KnowledgeCollectionStorage',
    'KnowledgeCollection',
  ];
  for (const name of retired) {
    it(`retired ABI abi/${name}.json is NOT present at the top level`, () => {
      expect(existsSync(join(ABI_DIR, `${name}.json`))).toBe(false);
    });
  }

  const active = ['KnowledgeAssetsLifecycle', 'DKGKnowledgeAssets'];
  for (const name of active) {
    it(`renamed ABI abi/${name}.json IS present`, () => {
      expect(existsSync(join(ABI_DIR, `${name}.json`))).toBe(true);
    });
  }
});
