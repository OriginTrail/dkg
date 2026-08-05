/** Independent system-record V1 golden-vector generator. Do not import production codecs. */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { generateKeyPairFromSeed } from '@libp2p/crypto/keys';
import { peerIdFromPublicKey } from '@libp2p/peer-id';
import { signAsync as ed25519Sign } from '@noble/ed25519';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { keccak_256 } from '@noble/hashes/sha3.js';

const UTF8 = new TextEncoder();
const HEX = (byte) => `0x${byte.repeat(32)}`;
const DOMAINS = {
  head: 'dkg-system-record-agent-profile-head-object-v1\n',
  transition: 'dkg-system-record-authority-transition-object-v1\n',
  fork: 'dkg-system-record-fork-resolution-object-v1\n',
  table: 'dkg-system-record-owned-subject-table-v1\n',
  envelope: 'dkg-system-record-signed-envelope-v1\n',
  provider: 'dkg-system-record-provider-signature-v1\n',
  peer: 'dkg-system-record-peer-signature-v1\n',
  evm: 'dkg-system-record-evm-signature-v1\n',
  root: 'dkg-system-record-root-descriptor-object-v1\n',
  rootCollision: 'dkg-system-record-root-collision-evidence-v1\n',
};
const peerSeed = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const peerKey = await generateKeyPairFromSeed('Ed25519', peerSeed);
const peerId = peerIdFromPublicKey(peerKey.publicKey).toString();
const peerPublicKey = Buffer.from(peerKey.publicKey.raw).toString('base64url');
const evmPrivateKey = Uint8Array.from({ length: 32 }, (_, index) => index + 33);
const evmPublicKey = secp256k1.getPublicKey(evmPrivateKey, false);
const evmIssuer = `0x${Buffer.from(keccak_256(evmPublicKey.subarray(1)).subarray(12)).toString('hex')}`;
const nextEvmPrivateKey = Uint8Array.from({ length: 32 }, (_, index) => 96 - index);
const nextEvmPublicKey = secp256k1.getPublicKey(nextEvmPrivateKey, false);
const nextIssuer = `0x${Buffer.from(keccak_256(nextEvmPublicKey.subarray(1)).subarray(12)).toString('hex')}`;
const rootSubject = `did:dkg:agent:${evmIssuer}`;
const emptyTableDigest = digest(DOMAINS.table, []);
const table = [rootSubject];
const tableDigest = digest(DOMAINS.table, table);
const seal = {
  assertionMerkleRoot: HEX('aa'), authorAddress: evmIssuer,
  authorAttestationR: HEX('11'), authorAttestationVS: HEX('22'),
  authorSchemeVersion: '1', assertedAtChainId: '20430',
  assertedAtKav10Address: '0x4444444444444444444444444444444444444444',
  reservedKaId: ((BigInt(evmIssuer) << 96n) | 7n).toString(),
  assertionFinalizedAt: '2026-08-05T11:59:59.000Z', contentScopeVersion: '2',
  kaUal: `did:dkg:otp:20430/${evmIssuer}/7`, assertionVersion: '1',
  publicTripleCount: '3', privateTripleCount: '0', privateMerkleRoot: null,
};
const active = {
  objectType: 'agent-profile-head', kind: 'agents', state: 'active',
  networkId: 'otp:20430', peerId, peerPublicKey, authoritySequence: '0', version: '0',
  evmIssuer, rootSubject, projectionSchemaDigest: HEX('cc'), issuedAt: '2026-08-05T12:00:00Z',
  ownedSubjectTableDigest: tableDigest, ownedSubjectCount: '1', projectionBytes: '256',
  projectionQuads: '3', validUntil: '2026-08-06T12:00:00Z',
  assertionCoordinate: 'agent-profile-v1', graphScopedAuthorSeal: seal,
  contentDigest: HEX('aa'), bundleDigest: HEX('bb'),
};
const activeDigest = digest(DOMAINS.head, active);
const tombstone = {
  objectType: 'agent-profile-head', kind: 'agents', state: 'tombstone',
  networkId: 'otp:20430', peerId, peerPublicKey, authoritySequence: '0', version: '1',
  previousHeadDigest: activeDigest, evmIssuer, rootSubject,
  projectionSchemaDigest: HEX('cc'), issuedAt: '2026-08-05T12:10:00Z',
  ownedSubjectTableDigest: emptyTableDigest, ownedSubjectCount: '0', projectionBytes: '0',
  projectionQuads: '0',
};
const transitionCommon = {
  objectType: 'authority-transition', kind: 'agents', networkId: 'otp:20430',
  peerId, peerPublicKey, priorAuthoritySequence: '0', nextAuthoritySequence: '1',
  priorHeadDigest: activeDigest, priorEvmIssuer: evmIssuer, nextEvmIssuer: nextIssuer,
  nextRoot: `did:dkg:agent:${nextIssuer}`, issuedAt: '2026-08-07T12:00:00Z',
};
const coSignedTransition = { ...transitionCommon, mode: 'co-signed' };
const expiredTransition = {
  ...transitionCommon, mode: 'expired-prior', priorValidUntil: active.validUntil,
};
const forkV0 = {
  objectType: 'fork-resolution', kind: 'agents', networkId: 'otp:20430', peerId,
  peerPublicKey, evmIssuer, authoritySequence: '0', forkedVersion: '0', resolutionVersion: '2',
  evidenceHeadDigests: [HEX('aa'), HEX('bb')], issuedAt: '2026-08-05T12:05:00Z',
};
const forkV1 = {
  ...forkV0, forkedVersion: '1', resolutionVersion: '3', forkBaseHeadDigest: activeDigest,
};
const signed = Object.fromEntries(await Promise.all([
  signedVector('activeEip191', active, DOMAINS.head, ['peer', 'current-evm']),
  signedVector('tombstoneEip191', tombstone, DOMAINS.head, ['peer', 'current-evm']),
  signedVector('coSignedTransitionEip191', coSignedTransition, DOMAINS.transition,
    ['peer', 'prior-evm', 'next-evm']),
  signedVector('expiredTransitionEip191', expiredTransition, DOMAINS.transition,
    ['peer', 'next-evm']),
  signedVector('forkV0Eip191', forkV0, DOMAINS.fork, ['peer', 'current-evm']),
  signedVector('forkV1Eip191', forkV1, DOMAINS.fork, ['peer', 'current-evm']),
  signedVector('activeEip1271', active, DOMAINS.head, ['peer', 'current-evm'],
    new Set(['current-evm'])),
  signedVector('coSignedTransitionEip1271', coSignedTransition, DOMAINS.transition,
    ['peer', 'prior-evm', 'next-evm'], new Set(['prior-evm', 'next-evm'])),
  signedVector('forkV1Eip1271', forkV1, DOMAINS.fork, ['peer', 'current-evm'],
    new Set(['current-evm'])),
]));
const rootDescriptor = {
  objectType: 'root-descriptor', kind: 'agents', networkId: 'otp:20430', epoch: '0',
  version: '0', treeRootDigest: HEX('dd'), totalRows: '1',
};
const rootDigest = digest(DOMAINS.root, rootDescriptor);
const providerMessage = signatureMessage(DOMAINS.provider, [
  'agents', rootDescriptor.networkId, peerId, rootDigest,
]);
const rootCollisionInput = {
  networkId: active.networkId,
  root: rootSubject,
  incumbentRecordKey: [active.networkId, peerId],
  contenderStableKey: HEX('dd'),
  contenderHeadDigest: HEX('ee'),
};
const rootCollisionTuple = [
  rootCollisionInput.networkId,
  rootCollisionInput.root,
  rootCollisionInput.incumbentRecordKey,
  rootCollisionInput.contenderStableKey,
  rootCollisionInput.contenderHeadDigest,
];

const vectors = {
  identities: { peerId, peerPublicKey, evmIssuer, rootSubject },
  emptyTableDigest,
  variants: Object.fromEntries([
    ['active', vector(DOMAINS.head, active)],
    ['tombstone', vector(DOMAINS.head, tombstone)],
    ['coSignedTransition', vector(DOMAINS.transition, coSignedTransition)],
    ['expiredTransition', vector(DOMAINS.transition, expiredTransition)],
    ['forkV0', vector(DOMAINS.fork, forkV0)],
    ['forkV1', vector(DOMAINS.fork, forkV1)],
  ]),
  signed,
  provider: {
    rootDescriptor, rootDigest,
    messageHex: Buffer.from(providerMessage).toString('hex'),
    signature: Buffer.from(await ed25519Sign(providerMessage, peerSeed)).toString('base64url'),
  },
  rootCollision: {
    input: rootCollisionInput,
    canonical: canonical(rootCollisionTuple),
    digest: digest(DOMAINS.rootCollision, rootCollisionTuple),
  },
};

const fixturePath = resolve(dirname(fileURLToPath(import.meta.url)), 'vectors.json');
const rendered = `${JSON.stringify(vectors, null, 2)}\n`;
if (process.argv.includes('--check')) {
  if (readFileSync(fixturePath, 'utf8') !== rendered) {
    throw new Error('system-record V1 golden vectors are stale; rerun generate.mjs');
  }
} else {
  writeFileSync(fixturePath, rendered);
}

function vector(domain, object) {
  return { object, canonical: canonical(object), digest: digest(domain, object) };
}

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

function digest(domain, value) {
  const bytes = UTF8.encode(`${domain}${canonical(value)}`);
  return `0x${Buffer.from(sha256(bytes)).toString('hex')}`;
}

function signatureMessage(domain, tuple) {
  return UTF8.encode(`${domain}${canonical(tuple)}`);
}

async function signedVector(name, object, objectDomain, roles, eip1271Roles = new Set()) {
  const objectDigest = digest(objectDomain, object);
  const messages = Object.fromEntries(roles.map((role) => [
    role,
    Buffer.from(roleMessage(object, objectDigest, role)).toString('hex'),
  ]));
  const signatures = await Promise.all(roles.map(async (role) => {
    const message = Uint8Array.from(Buffer.from(messages[role], 'hex'));
    if (role === 'peer') {
      return {
        role, suite: 'ed25519-v1', signer: peerId, evidence: { kind: 'none' },
        signature: Buffer.from(await ed25519Sign(message, peerSeed)).toString('base64url'),
      };
    }
    const signer = role === 'next-evm' ? nextIssuer : evmIssuer;
    if (eip1271Roles.has(role)) {
      return {
        role, suite: 'eip1271-current-finalized-v1', signer,
        evidence: {
          kind: 'eip1271-current-finalized', chainId: '20430', contractAddress: signer,
          finalizedBlockNumber: '123456', finalizedBlockHash: HEX('ef'),
        },
        signature: '0x1234',
      };
    }
    return {
      role, suite: 'eip191-personal-sign-digest-v1', signer, evidence: { kind: 'none' },
      signature: signEvm(message, role === 'next-evm' ? nextEvmPrivateKey : evmPrivateKey),
    };
  }));
  const envelope = { object, objectDigest, signatures };
  return [name, {
    envelope,
    canonical: canonical(envelope),
    envelopeDigest: digest(DOMAINS.envelope, envelope),
    messages,
  }];
}

function roleMessage(object, objectDigest, role) {
  const recordKey = [object.networkId, object.peerId];
  let tuple;
  if (object.objectType === 'agent-profile-head') {
    tuple = ['agent-profile-head', objectDigest, object.networkId, recordKey,
      object.authoritySequence, object.version,
      ...(role === 'peer' ? [] : ['current-evm', object.evmIssuer])];
  } else if (object.objectType === 'authority-transition') {
    const issuer = role === 'prior-evm' ? object.priorEvmIssuer : object.nextEvmIssuer;
    tuple = ['authority-transition', objectDigest, object.networkId, recordKey,
      object.priorAuthoritySequence, object.nextAuthoritySequence, object.priorHeadDigest,
      role, ...(role === 'peer' ? [] : [issuer])];
  } else {
    tuple = ['fork-resolution', objectDigest, object.networkId, recordKey,
      object.authoritySequence, object.forkedVersion, object.resolutionVersion,
      role, ...(role === 'peer' ? [] : [object.evmIssuer])];
  }
  return signatureMessage(role === 'peer' ? DOMAINS.peer : DOMAINS.evm, tuple);
}

function personalHash(message) {
  return keccak_256(Uint8Array.from(Buffer.concat([
    Buffer.from(`\x19Ethereum Signed Message:\n${message.byteLength}`), Buffer.from(message),
  ])));
}

function signEvm(message, privateKey) {
  const recovered = secp256k1.sign(personalHash(message), privateKey, {
    format: 'recovered', prehash: false, lowS: true,
  });
  const bytes = new Uint8Array(65);
  bytes.set(recovered.subarray(1));
  bytes[64] = recovered[0] + 27;
  return `0x${Buffer.from(bytes).toString('hex')}`;
}
