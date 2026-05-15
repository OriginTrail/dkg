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
import { readFileSync } from 'node:fs';
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
  //   - KnowledgeCollectionStorage event payload (KnowledgeCollectionCreated /
  //     KnowledgeCollectionUpdated still carry the same ABI shape today;
  //     the digest changed because the function inputs they originate from
  //     changed). Sanity tests below pin the actual event field shapes.
  // Updated PR #436 round 2: agent-provenance review feedback. Reverted
  // the `MerkleRoot.author` struct field (would have broken the dynamic
  // array slot stride for already-deployed KCs) and moved author to a
  // parallel `merkleRootAuthors[kcId][rootIndex]` mapping. Also added
  // an `address author` argument to `createKnowledgeCollection` /
  // `updateKnowledgeCollection` and the matching indexed topic on the
  // `KnowledgeCollectionCreated` / `KnowledgeCollectionUpdated` events.
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
  KnowledgeAssetsV10:           '785311d19ce39743522bf1db501f41276fb22d715a2cc94cc67d96f8a22e519e',
  KnowledgeCollectionStorage:   'e165cbddc6569602d1d5c05c15909fd0a9ff851f974357cf80297041b2a83fd2',
  KnowledgeCollection:          'c906207c38ffded8944d7255498f7fc9f2c864098a3f8f3670df19006dbcd395',
  ContextGraphs:                'ee69f0d50b54df966b8bfb3bf457fe6d2865393f51f8770b4185fafd324b9462',
  ContextGraphStorage:          '4e0ef683d10ead0f167ee08d7d980df4d37a24dcabf2dad3970cf9d7b6d4813b',
  // Identity / staking — consulted on every publish.
  Hub:                          '36976cc71bb87963b8b715791b32e4eb6b7bb85c712998afd6184221289a506b',
  Identity:                     '29d09dd97de53de69d5bf2282d2f3008044ab43fb86c812fc4912552c9288946',
  IdentityStorage:              'd7c58ba8ae28523dc1a6ff0bc228a3bceb9d327e53d258099dada656db262479',
  // Updated PR #470 round 2: `MAX_PUBLISHING_CONVICTION_EPOCHS = 60`
  // exposed as a public constant + tightened bound in
  // `setPublishingConvictionEpochs`. Caps the worst-case
  // `_settleElapsed` / `_finalSweep` loop count so governance can no
  // longer brick PCAs by raising `publishingConvictionEpochs`.
  ParametersStorage:            '70d4024b4faf2004f59561b8b785a509c3abadaa89b249adfe6177783f996a97',
  // Added PR #470 round 3: pin the V10 NFT-backed PCA contract so that
  // any drift in its events (CostCovered / WindowSettled /
  // AccountFinalSwept / TokensAddedToEpochRange consumers) or errors
  // (AccountExpired / NoConvictionAccount / InvalidConvictionKcEpochs)
  // is flagged at the chain-package boundary. `EVMChainAdapter`
  // resolves this contract and the publisher SDK probes it via
  // `getConvictionAgentAccountId` / `getConvictionAccountLockDurationEpochs`
  // (Codex round-3 finding on PR #470).
  DKGPublishingConvictionNFT:   '2364949790c200cb7a8cce2f0e6502316fcb1d124e7eed23ffa24fa109565bb5',
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
  it('KnowledgeCollectionStorage declares KnowledgeCollectionCreated with the full spec field set', () => {
    const abi = JSON.parse(
      readFileSync(join(ABI_DIR, 'KnowledgeCollectionStorage.json'), 'utf8'),
    ) as AbiEntry[];
    const ev = abi.find((e) => e.type === 'event' && e.name === 'KnowledgeCollectionCreated');
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
      readFileSync(join(ABI_DIR, 'KnowledgeCollectionStorage.json'), 'utf8'),
    ) as AbiEntry[];
    const ev = abi.find((e) => e.type === 'event' && e.name === 'KnowledgeAssetsMinted');
    expect(ev).toBeDefined();
    const types = (ev!.inputs ?? []).map((i) => i.type);
    expect(types).toEqual(['uint256', 'address', 'uint256', 'uint256']);
  });

  it('ContextGraphStorage declares ContextGraphCreated with the full participant struct', () => {
    const abi = JSON.parse(
      readFileSync(join(ABI_DIR, 'ContextGraphStorage.json'), 'utf8'),
    ) as AbiEntry[];
    const ev = abi.find((e) => e.type === 'event' && e.name === 'ContextGraphCreated');
    expect(ev).toBeDefined();
    const types = (ev!.inputs ?? []).map((i) => i.type);
    expect(types).toEqual([
      'uint256',   // contextGraphId
      'address',   // owner
      'uint72[]',  // hostingNodes
      'address[]', // participantAgents
      'uint8',     // requiredSignatures
      'uint256',   // metadataBatchId
      'uint8',     // accessPolicy
      'uint8',     // publishPolicy
      'address',   // publishAuthority
      'uint256',   // publishAuthorityAccountId
    ]);
  });

  it('KnowledgeCollectionStorage declares KnowledgeCollectionUpdated (V10 update event)', () => {
    const abi = JSON.parse(
      readFileSync(join(ABI_DIR, 'KnowledgeCollectionStorage.json'), 'utf8'),
    ) as AbiEntry[];
    const ev = abi.find((e) => e.type === 'event' && e.name === 'KnowledgeCollectionUpdated');
    expect(ev).toBeDefined();
    const types = (ev!.inputs ?? []).map((i) => i.type);
    // V10.1 update event mirrors the publish event: the second indexed
    // arg is `author`. The current V10.1 update path emits
    // `address(0)` (no attestation yet) but the slot is reserved for
    // vNext when updates start signing the EIP-712 envelope too.
    expect(types).toEqual(['uint256', 'address', 'string', 'bytes32', 'uint256', 'uint96']);
  });
});
