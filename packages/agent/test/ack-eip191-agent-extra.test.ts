/**
 * Six-field ACK digest and EIP-191 signing with real secp256k1 identities.
 * Cross-check the framing against ethers and verify keystore address contracts;
 * no DKG node or chain is started. The DID checks below validate the address
 * embedded in the string, not the DKGAgent.registerAgent integration path.
 */
import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';
import {
  computeACKDigest,
  eip191Hash,
  keccak256Hex,
  PROTOCOL_STORAGE_ACK,
} from '@origintrail-official/dkg-core';
import {
  generateCustodialAgent,
  registerSelfSovereignAgent,
  agentFromPrivateKey,
} from '../src/agent-keystore.js';

describe('A-10: 6-field ACK digest + EIP-191 signing (agent identity)', () => {
  const CG_ID = 12345n;
  const merkleRoot = ethers.getBytes(
    '0x' + 'ab'.repeat(32),
  );
  const kaCount = 3;
  const byteSize = 4096n;
  const epochs = 2;
  const tokenAmount = 100n * 10n ** 18n;

  it('agent signs the 6-field digest; ecrecover over EIP-191 recovers the agent address', async () => {
    // A fresh custodial agent — real secp256k1 keypair, no chain dependency.
    const agent = generateCustodialAgent('tester');
    expect(agent.privateKey).toBeDefined();
    const wallet = new ethers.Wallet(agent.privateKey!);
    expect(wallet.address).toBe(agent.agentAddress);

    // Compute the V10 6-field ACK digest.
    const digest = computeACKDigest(CG_ID, merkleRoot, kaCount, byteSize, epochs, tokenAmount);
    expect(digest.length).toBe(32);

    // Sign the digest with EIP-191 "personal sign" semantics — the same
    // framing the Solidity `ECDSA.toEthSignedMessageHash` applies on chain.
    const signature = await wallet.signMessage(digest);

    // ecrecover path A: use ethers' wrapper that applies the same prefix.
    const recoveredA = ethers.verifyMessage(digest, signature);
    expect(recoveredA.toLowerCase()).toBe(wallet.address.toLowerCase());

    // ecrecover path B: manually compute eip191Hash and recover. This
    // cross-checks that `eip191Hash` is byte-equivalent to
    // `ethers.hashMessage(digest)` — C-3 style pinning but from the agent
    // layer consumer side.
    const manualEip191 = eip191Hash(digest);
    const ethersEip191 = ethers.getBytes(ethers.hashMessage(digest));
    expect(Buffer.from(manualEip191).toString('hex')).toBe(Buffer.from(ethersEip191).toString('hex'));

    const recoveredB = ethers.recoverAddress(manualEip191, signature);
    expect(recoveredB.toLowerCase()).toBe(wallet.address.toLowerCase());
  });

  it('tampered signature does NOT recover the agent address', async () => {
    const agent = generateCustodialAgent('tamper-test');
    const wallet = new ethers.Wallet(agent.privateKey!);

    const digest = computeACKDigest(CG_ID, merkleRoot, kaCount, byteSize, epochs, tokenAmount);
    const signature = await wallet.signMessage(digest);

    expect(ethers.verifyMessage(digest, signature).toLowerCase()).toBe(wallet.address.toLowerCase());

    // Recovery may reject an invalid curve point or return a different signer.
    // Keep assertions OUTSIDE the recovery catch so an accepted tampered
    // signature cannot be mistaken for an expected parser/recovery exception.
    for (const pos of [0, 40, 10, 50]) {
      const sigBytes = ethers.getBytes(signature);
      sigBytes[pos] ^= 0x01;
      let recovered: string;
      try {
        recovered = ethers.verifyMessage(digest, ethers.hexlify(sigBytes));
      } catch {
        continue;
      }
      expect(recovered.toLowerCase(), `tampered signature byte ${pos}`)
        .not.toBe(wallet.address.toLowerCase());
    }
  });

  it('tampered digest (different tokenAmount) does NOT recover the agent address', async () => {
    const agent = generateCustodialAgent('digest-tamper');
    const wallet = new ethers.Wallet(agent.privateKey!);

    const originalDigest = computeACKDigest(CG_ID, merkleRoot, kaCount, byteSize, epochs, tokenAmount);
    const signature = await wallet.signMessage(originalDigest);

    // Simulate an ACK replay across cost params — verifier rebuilds the
    // digest with a different tokenAmount. ecrecover must return a
    // different address.
    const replayDigest = computeACKDigest(
      CG_ID, merkleRoot, kaCount, byteSize, epochs, tokenAmount + 1n,
    );
    expect(keccak256Hex(originalDigest)).not.toBe(keccak256Hex(replayDigest));

    const recovered = ethers.verifyMessage(replayDigest, signature);
    expect(recovered.toLowerCase()).not.toBe(wallet.address.toLowerCase());
  });

  it('self-sovereign agent (node never holds private key) also round-trips', async () => {
    // Holder-side: agent keeps the private key, only the public key reaches
    // the node. This mirrors `mode: "self-sovereign"`.
    const holder = ethers.Wallet.createRandom();
    const registered = registerSelfSovereignAgent('self-sovereign', holder.signingKey.publicKey);

    // Node-side record has no private key.
    expect(registered.privateKey).toBeUndefined();
    expect(registered.agentAddress).toBe(holder.address);
    expect(registered.mode).toBe('self-sovereign');

    const digest = computeACKDigest(CG_ID, merkleRoot, kaCount, byteSize, epochs, tokenAmount);
    const signature = await holder.signMessage(digest);

    const recovered = ethers.verifyMessage(digest, signature);
    expect(recovered.toLowerCase()).toBe(registered.agentAddress.toLowerCase());
  });
});

describe('A-10 / A-12: storage-ack libp2p protocol id is pinned', () => {
  // If the constant shifts, ACK collectors and handlers will disagree and
  // ACK collection silently times out. See also storage-ack-protocol-extra.
  // rc.9 PR-11: pin bumped to the substrate-versioned prefix.
  it(`is exactly "/dkg/10.0.1/storage-ack"`, () => {
    expect(PROTOCOL_STORAGE_ACK).toBe('/dkg/10.0.1/storage-ack');
  });
});

describe('A-12: DKG agent DID format (runtime, not just fixtures)', () => {
  const ETH_ADDR_DID_RE = /^did:dkg:agent:0x[a-fA-F0-9]{40}$/;

  it('agentFromPrivateKey produces a DID whose address form round-trips', () => {
    const pk = '0x' + 'ab'.repeat(32);
    // This is a deterministic private key — we care about the format only.
    const rec = agentFromPrivateKey(pk, 'from-pk');
    const did = `did:dkg:agent:${rec.agentAddress}`;
    expect(did).toMatch(ETH_ADDR_DID_RE);
    // and the public key is a secp256k1 point — 0x04 || X || Y → 130 hex chars.
    expect(rec.publicKey).toMatch(/^0x04[0-9a-f]{128}$/i);
  });

  it('registerSelfSovereignAgent produces an Ethereum-address DID, NOT a peer-id DID', () => {
    const w = ethers.Wallet.createRandom();
    const rec = registerSelfSovereignAgent('name', w.signingKey.publicKey);
    const did = `did:dkg:agent:${rec.agentAddress}`;
    expect(did).toMatch(ETH_ADDR_DID_RE);
    // Spec §03 / §22: the agent DID is the EVM address form. A peer-id
    // form (did:dkg:agent:Qm...) does not match this pin and is rejected.
    expect(did).not.toMatch(/^did:dkg:agent:Qm/);
  });
});
