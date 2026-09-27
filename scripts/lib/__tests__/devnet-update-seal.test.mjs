// build_update_body (scripts/devnet-update-helpers.sh + devnet-update-seal.mjs)
// builds the owner-sealed POST /api/update body the devnet scripts send. The
// daemon rejects a seal whose expectedNewMerkleRoot differs from its own
// canonical recompute, so these tests hand the built body to the real
// DKGAgent.update() checks. Needs built packages, bash and python3.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../..');
const req = createRequire(path.join(REPO_ROOT, 'packages/cli/package.json'));
const { DKGAgent, buildPublicProjection } = req('@origintrail-official/dkg-agent');
const {
  computeFlatKCRootV10,
  skolemizeKnowledgeAssetParts,
} = req('@origintrail-official/dkg-publisher');
const { contextGraphDataUri } = req('@origintrail-official/dkg-core');
const { ethers } = req('ethers');

const CHAIN_ID = 31337n;
const KAV_ADDRESS = '0x1111111111111111111111111111111111111111';
// Well-known Hardhat test account #1.
const OWNER_KEY = '0x59c6995e998f97a5a0044976f7d4b21ddc10b15f2b79366a0a69c3fcf4e7f5c2';
const OWNER = new ethers.Wallet(OWNER_KEY);
const KA_ID = (BigInt(OWNER.address) << 96n) | 7n;
const CG = 'devnet-update-seal-cg';
const SEAL_ACCEPTED = new Error('seal accepted');

const quad = (subject, predicate, object) => ({ subject, predicate, object, graph: '' });

/**
 * Run build_update_body with the chain replaced by stubs: ownerOf answers with
 * the owner wallet, and a JSON-RPC stub answers eth_chainId for the seal.
 */
async function buildUpdateBody(quads, privateQuads = [], legacyCuratedCg = '') {
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      const parsed = JSON.parse(body);
      const answer = (call) => (call.method === 'eth_chainId'
        ? { jsonrpc: '2.0', id: call.id, result: ethers.toQuantity(CHAIN_ID) }
        : { jsonrpc: '2.0', id: call.id, error: { code: -32601, message: `unexpected ${call.method}` } });
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(Array.isArray(parsed) ? parsed.map(answer) : answer(parsed)));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const dir = await mkdtemp(path.join(tmpdir(), 'devnet-update-seal-'));
  try {
    const devnetDir = path.join(dir, 'devnet');
    await mkdir(path.join(devnetDir, 'node1'), { recursive: true });
    await writeFile(
      path.join(devnetDir, 'node1', 'wallets.json'),
      JSON.stringify({ wallets: [{ address: OWNER.address, privateKey: OWNER_KEY }] }),
    );
    const contractsJson = path.join(dir, 'contracts.json');
    await writeFile(contractsJson, JSON.stringify({
      contracts: { KnowledgeAssetsLifecycle: { evmAddress: KAV_ADDRESS } },
    }));
    const chainCall = path.join(dir, 'chain-call.sh');
    await writeFile(chainCall, `#!/bin/sh\necho '{"result":"${OWNER.address}"}'\n`);
    await chmod(chainCall, 0o755);
    const { stdout } = await promisify(execFile)('bash', [
      '-c',
      'source scripts/devnet-update-helpers.sh && build_update_body 1 "$KA" "$CG" "$QUADS" "$PRIVATE_QUADS" "$LEGACY_CURATED_CG"',
    ], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        REPO_ROOT,
        DEVNET_DIR: devnetDir,
        NUM_NODES: '1',
        CONTRACTS_JSON: contractsJson,
        CHAIN_CALL: chainCall,
        RPC_URL: `http://127.0.0.1:${server.address().port}`,
        KA: KA_ID.toString(),
        CG,
        QUADS: JSON.stringify(quads),
        PRIVATE_QUADS: JSON.stringify(privateQuads),
        LEGACY_CURATED_CG: legacyCuratedCg,
      },
    });
    return JSON.parse(stdout);
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
}

/** Decode the seal as POST /api/update does, then run DKGAgent.update(). */
async function submitUpdate(body, wireSeal = body.precomputedUpdateAttestation) {
  const agentLike = {
    log: { info() {}, warn() {}, error() {}, debug() {} },
    chain: {
      getEvmChainId: async () => CHAIN_ID,
      getKnowledgeAssetsLifecycleAddress: async () => KAV_ADDRESS,
      hasContractCode: async () => false,
      // Consulted only after the seal's root and signature were accepted.
      getKnowledgeAssetOwner: async () => { throw SEAL_ACCEPTED; },
    },
  };
  const precomputedUpdateAttestation = {
    expectedNewMerkleRoot: ethers.getBytes(wireSeal.expectedNewMerkleRoot),
    authorAddress: wireSeal.authorAddress,
    signature: {
      r: ethers.getBytes(wireSeal.signature.r),
      vs: ethers.getBytes(wireSeal.signature.vs),
    },
    schemeVersion: wireSeal.schemeVersion,
  };
  return DKGAgent.prototype.update.call(
    agentLike,
    BigInt(body.kaId),
    body.contextGraphId,
    body.quads,
    body.privateQuads ?? [],
    { precomputedUpdateAttestation },
  );
}

test('seals the root /api/update recomputes for a curated update payload', async () => {
  const quads = [
    quad('urn:rfc49:secret:1/alice', 'http://schema.org/name', '"Alice — UPDATED"'),
    quad('urn:rfc49:secret:1/alice', 'http://schema.org/jobTitle', '"Lead (added on update)"'),
  ];
  // RFC-49 used to pass the curated graph as a sixth helper argument. Keeping
  // that invocation here catches any restoration of catalog-floor injection.
  const body = await buildUpdateBody(quads, [], CG);
  assert.equal(body.kaId, KA_ID.toString());
  assert.equal(body.contextGraphId, CG);
  await assert.rejects(submitUpdate(body), (err) => err === SEAL_ACCEPTED);

  // Since v10.0.7 a curated CG's `_catalog` floor is a separate catalog
  // commitment: a seal that folds it into the KA root is rejected.
  const cgDid = contextGraphDataUri(CG);
  const floor = buildPublicProjection({ ual: cgDid, accessPolicy: 'private', graph: cgDid });
  const canonical = await skolemizeKnowledgeAssetParts([...quads, ...floor], []);
  const withFloor = {
    ...body.precomputedUpdateAttestation,
    expectedNewMerkleRoot: ethers.hexlify(computeFlatKCRootV10(canonical.publicQuads, [])),
  };
  await assert.rejects(submitUpdate(body, withFloor), /expectedNewMerkleRoot mismatch/);
});

test('seals blank nodes and private quads as /api/update canonicalizes them', async () => {
  const quads = [
    quad('urn:doc:1', 'urn:hasPart', '_:part'),
    quad('_:part', 'urn:value', '"two"'),
    quad('urn:doc:2', 'urn:value', '"three"'),
  ];
  const privateQuads = [
    quad('urn:doc:1', 'urn:secret', '"s1"'),
    quad('urn:doc:1', 'urn:secret', '"s2"'),
    quad('urn:doc:2', 'urn:secret', '"s3"'),
    quad('_:hidden', 'urn:secret', '"s4"'),
  ];
  const body = await buildUpdateBody(quads, privateQuads);
  assert.deepEqual(body.privateQuads, privateQuads);
  await assert.rejects(submitUpdate(body), (err) => err === SEAL_ACCEPTED);
});
