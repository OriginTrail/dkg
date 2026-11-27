// Agent-key signatures on a live daemon (mock chain): only agents the node knows may sign. The
// recipient of an encryption enrollment that the operator prepared may sign its own activation before
// this node holds an agent record for it, and only that request.
import { randomBytes } from 'node:crypto';

import {
  WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519,
  computeWorkspaceAgentEncryptionKeyProofPayload,
  decodeWorkspaceEncryptionKey,
} from '@origintrail-official/dkg-core';
import { encryptionKeyEnrollmentPayload, type EncryptionKeyEnrollment } from '@origintrail-official/dkg-agent';
import { ethers } from 'ethers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { signAgentHttpHeaders } from '../src/agent-http-signing.js';
import { startLiveDaemon, stopLiveDaemon, type LiveDaemon } from './helpers/live-daemon.js';

let daemon: LiveDaemon;
let operatorToken: string;
let peerId: string;

type Signer = ethers.Wallet | ethers.HDNodeWallet;

function signedHeaders(signer: Signer, method: 'GET' | 'POST', path: string, contentType: string, body: Buffer) {
  return signAgentHttpHeaders({
    agentAddress: signer.address, method, path, targetPeerId: peerId, contentType, body,
    timestamp: String(Date.now()), nonce: randomBytes(24).toString('hex'),
  }, signer.signingKey);
}

async function parsed(res: Response) {
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try { body = text ? JSON.parse(text) as Record<string, unknown> : {}; } catch { /* non-JSON body */ }
  return { status: res.status, body };
}

async function signedGet(signer: Signer, path: string) {
  const headers = signedHeaders(signer, 'GET', path, '', Buffer.alloc(0));
  return parsed(await fetch(`${daemon.base}${path}`, { method: 'GET', headers }));
}

async function signedPost(signer: Signer, path: string, body: unknown) {
  const bytes = Buffer.from(JSON.stringify(body));
  const headers = signedHeaders(signer, 'POST', path, 'application/json', bytes);
  return parsed(await fetch(`${daemon.base}${path}`, { method: 'POST', headers, body: bytes }));
}

async function asOperator(path: string, body: unknown) {
  const res = await fetch(`${daemon.base}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${operatorToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

describe('agent-key signers on a live daemon (mock chain)', () => {
  beforeAll(async () => {
    daemon = await startLiveDaemon({ extraConfig: { chain: { type: 'mock' } } });
    operatorToken = daemon.token!;
    const status = await (await fetch(`${daemon.base}/api/status`)).json() as { peerId?: string };
    peerId = String(status.peerId);
  });

  afterAll(async () => {
    await stopLiveDaemon(daemon);
  });

  it('refuses a key the node does not know', async () => {
    const stranger = ethers.Wallet.createRandom();
    const res = await signedGet(stranger, '/api/agent/identity');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('AGENT_HTTP_AGENT_UNKNOWN');
  });

  it('accepts a self-sovereign agent registered on the node by its public key', async () => {
    const signer = ethers.Wallet.createRandom();
    const registered = await asOperator('/api/agent/register', { name: 'key-signer', publicKey: signer.signingKey.publicKey });
    expect(registered.status, JSON.stringify(registered.body)).toBe(200);
    const res = await signedGet(signer, '/api/agent/identity');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  it('lets an enrollment recipient sign only its own activation, which makes it a known agent', async () => {
    const recipient = ethers.Wallet.createRandom();
    const prepared = await asOperator('/api/agent/encryption-enrollments', { agentAddress: recipient.address });
    expect(prepared.status, JSON.stringify(prepared.body)).toBe(201);
    const challenge = prepared.body as unknown as EncryptionKeyEnrollment;

    // A pending enrollment admits its recipient on the activation route only.
    expect((await signedGet(recipient, '/api/agent/identity')).body.code).toBe('AGENT_HTTP_AGENT_UNKNOWN');

    const keyPayload = computeWorkspaceAgentEncryptionKeyProofPayload({
      agentAddress: recipient.address,
      encryptionKeyAlgorithm: WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519,
      publicKeyBytes: decodeWorkspaceEncryptionKey(challenge.publicEncryptionKey),
    });
    const activated = await signedPost(recipient, '/api/agent/encryption-enrollments/activate', {
      agentAddress: recipient.address,
      enrollmentId: challenge.enrollmentId,
      encryptionKeyProof: recipient.signingKey.sign(ethers.hashMessage(keyPayload)).serialized,
      custodyProof: await recipient.signMessage(encryptionKeyEnrollmentPayload(challenge)),
    });
    expect(activated.status, JSON.stringify(activated.body)).toBe(200);
    expect(activated.body.agentAddress).toBe(recipient.address);

    // Activation recorded the recipient as an agent, so it now signs like any other.
    expect((await signedGet(recipient, '/api/agent/identity')).status).toBe(200);
  });
});
