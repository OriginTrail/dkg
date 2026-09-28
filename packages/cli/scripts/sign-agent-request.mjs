#!/usr/bin/env node
// Local signer: only public proofs leave this process. Build the CLI before use.
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { ethers } from 'ethers';
import { signAgentDelegation, encryptionKeyEnrollmentPayload, computeWorkspaceEncryptionKeysAttestationDigest } from '@origintrail-official/dkg-agent';
import { computeWorkspaceAgentEncryptionKeyProofPayload, decodeWorkspaceEncryptionKey } from '@origintrail-official/dkg-core';
import { signAgentHttpHeaders } from '../dist/agent-http-signing.js';
import { assertBoundSemanticInvocation, boundSemanticInvocationScope } from '../dist/semantic-runtime-bound-invocation.js';

const [mode, ...args] = process.argv.slice(2);
const options = {};
for (let i = 0; i < args.length; i += 2) {
  if (!args[i].startsWith('--') || !args[i + 1] || options[args[i].slice(2)] !== undefined) throw new Error('Expected unique --name value arguments');
  options[args[i].slice(2)] = args[i + 1];
}
const required = (key) => { if (!options[key]) throw new Error(`Missing --${key}`); return options[key]; };
const allowed = mode === 'http'
  ? ['key-file', 'peer', 'method', 'path', 'body', 'content-type', 'out']
  : mode === 'invocation' ? ['key-file', 'peer', 'forwarder', 'input', 'out']
  : mode === 'enrollment' ? ['key-file', 'peer', 'input', 'out']
  : mode === 'join' ? ['key-file', 'peer', 'deployment', 'graph', 'curator', 'input', 'out'] : [];
if (!allowed.length || Object.keys(options).some((key) => !allowed.includes(key))) {
  throw new Error('Use http --key-file PATH --peer ID --method METHOD --path /api/path [--body FILE] [--content-type TYPE] --out headers.txt; or invocation --key-file PATH --peer EXECUTOR --forwarder CLIENT --input invocation.json --out authorized.json; or enrollment --key-file PATH --peer CLIENT --input enrollment.json --out activation.json; or join --key-file PATH --peer CLIENT --deployment ID --graph CANONICAL_ID --curator PEER --input enrolled-key.json --out join.json');
}
// The file must contain a hex private key. It is never an argument, header or payload.
const wallet = new ethers.Wallet(readFileSync(required('key-file'), 'utf8').trim());
let output;
if (mode === 'http') {
  const contentType = options['content-type'] ?? (options.body ? 'application/json' : '');
  if (/[\r\n]/.test(contentType)) throw new Error('Invalid content type');
  const headers = signAgentHttpHeaders({
    agentAddress: wallet.address, method: required('method'), targetPeerId: required('peer'),
    path: required('path'), contentType, body: options.body ? readFileSync(options.body) : Buffer.alloc(0),
    timestamp: String(Date.now()), nonce: randomBytes(24).toString('hex'),
  }, wallet.signingKey);
  output = Object.entries(headers).map(([name, value]) => `${name}: ${value}\n`).join('');
} else if (mode === 'enrollment') {
  const challenge = JSON.parse(readFileSync(required('input'), 'utf8'));
  if (challenge.version !== 1 || challenge.targetPeerId !== required('peer')
    || challenge.agentAddress.toLowerCase() !== wallet.address.toLowerCase()
    || challenge.encryptionKeyAlgorithm !== 'X25519' || challenge.expiresAt <= Date.now()) {
    throw new Error('Enrollment does not match this agent/node, or has expired');
  }
  const encryptionKeyProof = await wallet.signMessage(computeWorkspaceAgentEncryptionKeyProofPayload({
    agentAddress: wallet.address, encryptionKeyAlgorithm: 'X25519',
    publicKeyBytes: decodeWorkspaceEncryptionKey(challenge.publicEncryptionKey),
  }));
  const custodyProof = await wallet.signMessage(encryptionKeyEnrollmentPayload(challenge));
  output = JSON.stringify({ agentAddress: wallet.address, enrollmentId: challenge.enrollmentId, encryptionKeyProof, custodyProof }, null, 2) + '\n';
} else if (mode === 'join') {
  const key = JSON.parse(readFileSync(required('input'), 'utf8'));
  if (key.agentAddress.toLowerCase() !== wallet.address.toLowerCase() || key.targetPeerId !== required('peer')) throw new Error('Key enrollment does not match this agent/node');
  const now = Date.now();
  const delegation = await signAgentDelegation({
    agentPrivateKey: wallet.privateKey, agentAddress: wallet.address, delegateePeerId: required('peer'),
    scope: `sync:deployment=${required('deployment')}:${required('graph')}`, issuedAtMs: now,
    expiresAtMs: now + 365 * 24 * 60 * 60 * 1000,
  });
  delegation.workspaceEncryptionKeys = [{ encryptionKeyAlgorithm: key.encryptionKeyAlgorithm, publicEncryptionKey: key.publicEncryptionKey, encryptionKeyProof: key.encryptionKeyProof }];
  delegation.workspaceEncryptionKeysSignature = await wallet.signMessage(computeWorkspaceEncryptionKeysAttestationDigest(delegation));
  output = JSON.stringify({ agentName: 'external-backend', curatorPeerId: required('curator'), delegation }, null, 2) + '\n';
} else {
  const input = JSON.parse(readFileSync(required('input'), 'utf8'));
  if (Object.keys(input).some((key) => !['contextGraphId', 'operationIri', 'invocationId'].includes(key))) throw new Error('Only graph, operation and invocation ID are accepted');
  const unsigned = { version: 3, kind: 'bound-operation', ...input };
  assertBoundSemanticInvocation(unsigned);
  const now = Date.now();
  const authorization = await signAgentDelegation({
    agentPrivateKey: wallet.privateKey, agentAddress: wallet.address, delegateePeerId: required('forwarder'),
    scope: boundSemanticInvocationScope(unsigned, required('peer')), issuedAtMs: now, expiresAtMs: now + 300_000,
  });
  output = JSON.stringify({ ...input, authorization }, null, 2) + '\n';
}
writeFileSync(required('out'), output, { mode: 0o600 });
