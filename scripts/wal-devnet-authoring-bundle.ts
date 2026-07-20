#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { computeNetworkId } from '../packages/core/src/genesis.js';
import {
  MutableSetCommitment,
  RDF_POLICY_MEDIA_TYPE_V1,
  WAL_V1_ENUMS,
  collectionIdV1,
  createRdfPolicyV1,
  createWalObjectV1,
  encodeProtocolTuple,
  encodePublicDkgPayload,
  encodeRdfPolicyV1,
  namespaceIdV1,
  normalizeAddress20,
  protocolTupleId,
  recoverEip191Address,
  signEip191DigestWithPrivateKey,
  signSingleProtocolTuple,
  signThresholdProtocolTuple,
  walObjectId,
  type CborProtocolValue,
  type WalEip191Signer,
} from '../packages/wal/src/index.js';

interface WalletFile {
  adminWallet?: { privateKey?: string; address?: string };
  wallets?: Array<{ privateKey?: string; address?: string }>;
}

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function hex(value: Uint8Array): string {
  return Buffer.from(value).toString('hex');
}

function address(value: string, label: string): Uint8Array {
  try {
    return normalizeAddress20(value);
  } catch (error) {
    throw new Error(`${label} must be a canonical EVM address`, { cause: error });
  }
}

function signer(privateKeyHex: string, label: string): WalEip191Signer & { address: Uint8Array } {
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKeyHex)) {
    throw new Error(`${label} private key must be 0x-prefixed bytes32 hex`);
  }
  const privateKey = Uint8Array.from(privateKeyHex.slice(2).match(/../g)!, pair => Number.parseInt(pair, 16));
  const digest = new Uint8Array(32);
  const signerAddress = recoverEip191Address(
    digest,
    signEip191DigestWithPrivateKey(digest, privateKey),
  );
  return {
    address: signerAddress,
    signMessage: value => signEip191DigestWithPrivateKey(value, privateKey),
  };
}

async function atomicJson(path: string, value: unknown, mode = 0o600): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode });
  await chmod(temporary, mode);
  await rename(temporary, path);
}

async function main(): Promise<void> {
const nodeDir = resolve(argument('--node-dir'));
const genesisId = argument('--genesis-id');
const contextGraphs = argument('--context-graphs').split(',').map(value => value.trim()).filter(Boolean);
if (contextGraphs.length === 0 || new Set(contextGraphs).size !== contextGraphs.length) {
  throw new Error('--context-graphs must contain unique non-empty IDs');
}

const configPath = join(nodeDir, 'config.json');
const walletsPath = join(nodeDir, 'wallets.json');
const config = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
const walletFile = JSON.parse(await readFile(walletsPath, 'utf8')) as WalletFile;
if (!walletFile.adminWallet?.privateKey || !Array.isArray(walletFile.wallets) || walletFile.wallets.length === 0) {
  throw new Error('devnet WAL authoring requires adminWallet and at least one operational wallet');
}
const curator = signer(walletFile.adminWallet.privateKey, 'adminWallet');
const writerIds = walletFile.wallets.map((wallet, index) => {
  if (!wallet.address) throw new Error(`wallets[${index}].address is required`);
  return address(wallet.address, `wallets[${index}].address`);
});
if (writerIds.some(writer => hex(writer) === hex(curator.address))) {
  throw new Error('devnet curator and WAL content writers must be disjoint');
}

const networkId = await computeNetworkId(genesisId);
const authorityUnsigned = [
  1n,
  0n,
  networkId,
  0n,
  1n,
  [curator.address],
  0n,
  4_102_444_800_000n,
  null,
  [],
] satisfies readonly CborProtocolValue[];
const authority = await signThresholdProtocolTuple('AuthoritySetV1', authorityUnsigned, [curator]);
const authorityId = protocolTupleId('AuthoritySetV1', authority);
const policyWriter = signer(`0x${randomBytes(32).toString('hex')}`, 'policy writer');
const policyWriterId = policyWriter.address;
const views: Array<Record<string, unknown>> = [];

for (const contextGraphId of contextGraphs) {
  const collectionId = collectionIdV1([networkId, contextGraphId, null, 0n]);
  const swmNamespaceId = namespaceIdV1([networkId, contextGraphId, null, 0n, 0n, 0n, null]);
  const vmNamespaceId = namespaceIdV1([networkId, contextGraphId, null, 1n, 0n, 0n, null]);
  const policy = createRdfPolicyV1({
    allowedGraphPrefixes: ['did:dkg:context-graph:'],
    maxQuadsPerMutation: 1_000_000n,
    maxWalObjectBytes: 1_073_741_824n,
    allowedPayloadKinds: [
      BigInt(WAL_V1_ENUMS.payloadKind.DKG_MUTATION),
      BigInt(WAL_V1_ENUMS.payloadKind.RDF_POLICY),
    ],
  });
  const policyPayload = encodePublicDkgPayload({
    payloadKind: BigInt(WAL_V1_ENUMS.payloadKind.RDF_POLICY),
    codec: BigInt(WAL_V1_ENUMS.codec.DETERMINISTIC_CBOR),
    mediaType: RDF_POLICY_MEDIA_TYPE_V1,
    contentBytes: encodeRdfPolicyV1(policy),
  });
  const policyObject = await createWalObjectV1([
    1n,
    swmNamespaceId,
    policyWriterId,
    0n,
    0n,
    null,
    policyPayload.canonicalBytes,
  ], policyWriter);
  const commitment = new MutableSetCommitment([walObjectId(policyObject.walObjectId)]);
  const policyCheckpoint = await signSingleProtocolTuple('AuthorCheckpointV1', [
    1n,
    swmNamespaceId,
    policyWriterId,
    0n,
    0n,
    1n,
    commitment.root,
    1n,
    0n,
    null,
    null,
    0n,
  ], policyWriter);
  const membershipWriters = [...writerIds, policyWriterId].sort(Buffer.compare);
  const membershipUnsigned = [
    1n,
    collectionId,
    0n,
    0n,
    1n,
    membershipWriters,
    [],
    [],
    [swmNamespaceId, vmNamespaceId].sort(Buffer.compare),
    policyObject.walObjectId,
    null,
    BigInt(Date.now()),
    authorityId,
  ] satisfies readonly CborProtocolValue[];
  const membership = await signThresholdProtocolTuple(
    'MembershipCheckpointV1',
    membershipUnsigned,
    [curator],
  );
  views.push({
    contextGraphId,
    subGraphName: null,
    writerEpoch: '0',
    membershipCheckpoints: [hex(encodeProtocolTuple('MembershipCheckpointV1', membership))],
    policyWalObject: hex(policyObject.canonicalBytes),
    policyCheckpoint: hex(encodeProtocolTuple('AuthorCheckpointV1', policyCheckpoint)),
  });
}

const walRoot = join(nodeDir, 'wal-v1');
await mkdir(walRoot, { recursive: true, mode: 0o700 });
await atomicJson(join(walRoot, 'local-authoring.json'), {
  version: 1,
  networkId,
  curatorAuthoritySets: [hex(encodeProtocolTuple('AuthoritySetV1', authority))],
  views,
});

if (!config.sync || typeof config.sync !== 'object' || Array.isArray(config.sync)) {
  throw new Error('devnet config must select sync.mode=parallel before WAL authoring is provisioned');
}
const sync = config.sync as Record<string, unknown>;
if (sync.mode !== 'parallel') throw new Error('devnet WAL authoring requires sync.mode=parallel');
const wal = sync.wal && typeof sync.wal === 'object' && !Array.isArray(sync.wal)
  ? sync.wal as Record<string, unknown>
  : {};
wal.localAuthoring = {
  bundlePath: 'local-authoring.json',
  curatorAuthoritySetId: hex(authorityId),
};
sync.wal = wal;
config.sync = sync;
await atomicJson(configPath, config);

process.stdout.write(`${JSON.stringify({
  nodeDir,
  networkId,
  curatorAuthoritySetId: hex(authorityId),
  views: contextGraphs,
})}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
