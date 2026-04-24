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
  KnowledgeAssetsV10:           '610d0fc24d0b4a0651ea54ece222aacc5699131347b33334d1de89e8ca365a9e',
  KnowledgeCollectionStorage:   '734edc3a9a106aefe429d6a50daf9c821ccdfe6a6e051cc520a7f6e61b258dfb',
  KnowledgeCollection:          'c919254895cea1dc922f1e62db1ff2fbaba4a61d249023e584e2f8c10f42dbab',
  ContextGraphs:                '25a5e18897044b88c129e7e0fc68eec8fd99e64ded658f29f69df85f95cd25fc',
  ContextGraphStorage:          '7df78d2a870cd14236a2fa30461ea9bcae4a338e5ba20b466149a00ace5ee2be',
  // Identity / staking — consulted on every publish.
  Hub:                          '36976cc71bb87963b8b715791b32e4eb6b7bb85c712998afd6184221289a506b',
  Identity:                     '29d09dd97de53de69d5bf2282d2f3008044ab43fb86c812fc4912552c9288946',
  IdentityStorage:              'd7c58ba8ae28523dc1a6ff0bc228a3bceb9d327e53d258099dada656db262479',
  ParametersStorage:            'd8fbd96c9d4115c4d937bb11770c208af68f2b6b8ec1146379997ebdcf484b68',
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
    // Spec §06 / §07: id, publishOperationId, merkleRoot, byteSize,
    // startEpoch, endEpoch, tokenAmount, isImmutable.
    expect(types).toEqual([
      'uint256',
      'string',
      'bytes32',
      'uint88',
      'uint40',
      'uint40',
      'uint96',
      'bool',
    ]);
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
    expect(types).toEqual(['uint256', 'string', 'bytes32', 'uint256', 'uint96']);
  });
});
