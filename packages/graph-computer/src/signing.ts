import { AbiCoder, getAddress, getBytes, keccak256, verifyMessage, sha256 as hash, toUtf8Bytes, hexlify, randomBytes } from 'ethers';
import type { AgentSigner, PreparedInvocation } from './types.js';
import { canonicalInputs } from './inputs.js';

export const sha256 = (value: string) => hash(toUtf8Bytes(value)).slice(2);

/** DKG-HTTP-REQUEST-V1; compatibility is tested against the daemon's signing implementation. */
export async function signHttpRequest(
  signer: AgentSigner, address: string, peerId: string, method: string, path: string, body?: string,
) {
  const timestamp = String(Date.now());
  const nonce = hexlify(randomBytes(24)).slice(2);
  const contentType = body === undefined ? '' : 'application/json';
  const message = JSON.stringify([
    'DKG-HTTP-REQUEST-V1', address.toLowerCase(), peerId, method, path,
    contentType, sha256(body ?? ''), timestamp, nonce,
  ]);
  const signature = await signChecked(signer, address, message);
  return {
    authorization: `DKG-Agent ${signature}`,
    'x-dkg-agent-address': address,
    'x-dkg-agent-target': peerId,
    'x-dkg-agent-timestamp': timestamp,
    'x-dkg-agent-nonce': nonce,
    ...(contentType ? { 'content-type': contentType } : {}),
  };
}

/** Bound-operation v3/v4 scope inside an EIP-191 agent-delegation v2 proof. */
export async function signInvocation(signer: AgentSigner, address: string, forwarder: string, request: PreparedInvocation) {
  const version = request.inputs === undefined ? 3 : 4;
  const scope = `dkg.semantic-runtime.bound-operation.v${version}:` + sha256(JSON.stringify([
    version, 'bound-operation', request.graphId, request.operationIri,
    request.invocationId.toLowerCase(), request.executorPeerId,
    ...(version === 4 ? [sha256(canonicalInputs(request.inputs))] : []),
  ]));
  const issuedAtMs = Date.now();
  const payload = {
    agentAddress: address, delegateePeerId: forwarder, scope,
    issuedAtMs, expiresAtMs: issuedAtMs + 300_000,
  };
  const encoded = AbiCoder.defaultAbiCoder().encode(
    ['string', 'string', 'address', 'string', 'string', 'uint256', 'uint256'],
    ['dkg.agent-delegation.v2', scope, address.toLowerCase(), forwarder, '', issuedAtMs, payload.expiresAtMs],
  );
  return { ...payload, signature: await signChecked(signer, address, getBytes(keccak256(encoded))) };
}

async function signChecked(signer: AgentSigner, address: string, message: string | Uint8Array) {
  const signature = await signer.signMessage(message);
  if (getAddress(verifyMessage(message, signature)) !== getAddress(address)) {
    throw new Error('Signer changed identity or returned an invalid signature');
  }
  return signature;
}
