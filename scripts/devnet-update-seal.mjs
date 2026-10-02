#!/usr/bin/env node
/*
 * devnet-update-seal.mjs — build precomputedUpdateAttestation for POST /api/update
 *
 * RC12 requires the publisher to receive an off-band UpdateAuthorAttestation seal.
 * The seal commits to the same root the daemon recomputes before it accepts an
 * update (DKGAgent.update): the payload canonicalized as one graph-scoped KA,
 * with a single private root over all private quads. A curated CG's `_catalog`
 * floor is not part of that root: since v10.0.7 the producer commits it as a
 * separate catalog commitment.
 *
 * Usage:
 *   node devnet-update-seal.mjs --key 0x... --ka-id <id> --quads-json '<quad-array>' [--private-quads-json '<quad-array>']
 *
 * Output: one JSON line { ok, precomputedUpdateAttestation?, error? }
 *   Wire format matches agent-chat.ts parsePrecomputedUpdateAttestation.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = process.env.REPO_ROOT || path.resolve(__dirname, '..');
const RPC = process.env.RPC_URL || 'http://127.0.0.1:8545';
const CONTRACTS_JSON =
  process.env.CONTRACTS_JSON ||
  path.join(REPO_ROOT, 'packages/evm-module/deployments/localhost_contracts.json');

// Resolve via CLI package (pnpm workspace links publisher + core).
const cliPkg = path.join(REPO_ROOT, 'packages/cli/package.json');
const req = createRequire(cliPkg);
const { ethers } = req('ethers');
const {
  computeFlatKCRootV10,
  computePrivateRootV10,
  skolemizeKnowledgeAssetParts,
} = req('@origintrail-official/dkg-publisher');
const {
  buildUpdateAuthorAttestationTypedData,
  AUTHOR_SCHEME_VERSION_V1,
} = req('@origintrail-official/dkg-core');

function out(o) {
  process.stdout.write(JSON.stringify(o, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)) + '\n');
}

function toHex32(bytes) {
  return ethers.hexlify(bytes);
}

async function buildUpdateSeal({ kaId, quads, privateQuads, author, kav10Address, provider }) {
  // The canonical recompute of DKGAgent.update().
  const canonical = await skolemizeKnowledgeAssetParts(quads, privateQuads ?? []);
  const privateRoot = computePrivateRootV10(canonical.privateQuads);
  const newMerkleRoot = computeFlatKCRootV10(canonical.publicQuads, privateRoot ? [privateRoot] : []);
  const chainIdNum = await provider.getNetwork().then((n) => n.chainId);
  const td = buildUpdateAuthorAttestationTypedData({
    chainId: BigInt(chainIdNum),
    kav10Address,
    kaId: BigInt(kaId),
    newMerkleRoot,
    authorAddress: author.address,
  });
  const sigHex = await author.signTypedData(td.domain, td.types, td.message);
  const sig = ethers.Signature.from(sigHex);
  return {
    expectedNewMerkleRoot: toHex32(newMerkleRoot),
    authorAddress: author.address,
    signature: {
      r: toHex32(ethers.getBytes(sig.r)),
      vs: toHex32(ethers.getBytes(sig.yParityAndS)),
    },
    schemeVersion: AUTHOR_SCHEME_VERSION_V1,
  };
}

async function main() {
  let key = null;
  let kaId = null;
  let quadsJson = null;
  let privateQuadsJson = null;
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--key') key = argv[++i];
    else if (argv[i] === '--ka-id') kaId = argv[++i];
    else if (argv[i] === '--quads-json') quadsJson = argv[++i];
    else if (argv[i] === '--private-quads-json') privateQuadsJson = argv[++i];
  }
  if (!key || kaId == null || !quadsJson) {
    out({ ok: false, error: 'usage: --key 0x.. --ka-id <id> --quads-json <json-array>' });
    process.exit(2);
  }

  const deployment = JSON.parse(fs.readFileSync(CONTRACTS_JSON, 'utf8'));
  const map = deployment.contracts || deployment;
  // EIP-712 UpdateAuthorAttestation domain uses the lifecycle logic contract only.
  // DKGKnowledgeAssets is the ERC-721 storage layer — wrong verifyingContract.
  const kav10 =
    map.KnowledgeAssetsLifecycle?.evmAddress ||
    map.KnowledgeAssetsV10?.evmAddress;
  if (!kav10) {
    out({
      ok: false,
      error:
        'KnowledgeAssetsLifecycle or KnowledgeAssetsV10 not in deployment map (required for update seals)',
    });
    process.exit(1);
  }

  let quads;
  let privateQuads;
  try {
    quads = JSON.parse(quadsJson);
  } catch (e) {
    out({ ok: false, error: `invalid quads JSON: ${e.message}` });
    process.exit(1);
  }
  if (privateQuadsJson) {
    try {
      privateQuads = JSON.parse(privateQuadsJson);
    } catch (e) {
      out({ ok: false, error: `invalid private quads JSON: ${e.message}` });
      process.exit(1);
    }
  }

  const provider = new ethers.JsonRpcProvider(RPC);
  const author = new ethers.Wallet(key, provider);
  try {
    const seal = await buildUpdateSeal({
      kaId,
      quads,
      privateQuads,
      author,
      kav10Address: kav10,
      provider,
    });
    out({ ok: true, precomputedUpdateAttestation: seal });
  } catch (e) {
    out({ ok: false, error: e?.shortMessage || e?.message || String(e) });
    process.exit(1);
  }
}

main().catch((e) => {
  out({ ok: false, error: e?.message || String(e) });
  process.exit(1);
});
