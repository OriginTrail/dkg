import { describe, it, expect, vi } from 'vitest';
import { ethers } from 'ethers';
import {
  signAgentDelegation,
  verifyAgentDelegation,
  parseSignedAgentDelegation,
  computeDelegationDigest,
  computeWorkspaceEncryptionKeysAttestationDigest,
  type SignedAgentDelegation,
} from '../src/auth/agent-delegation.js';

const wallet = ethers.Wallet.createRandom();
const otherWallet = ethers.Wallet.createRandom();

const baseParams = {
  agentAddress: wallet.address,
  scope: 'sync:cg-test',
  issuedAtMs: 1_700_000_000_000,
  expiresAtMs: 1_700_000_000_000 + 60_000,
  delegateePeerId: '12D3KooWFakePeerForUnitTest',
  delegateeOpKey: '0x1111111111111111111111111111111111111111',
  agentPrivateKey: wallet.privateKey,
};

describe('agent-delegation primitive', () => {
  it('parses valid minimal and full delegation wire shapes', () => {
    const minimal = {
      agentAddress: wallet.address,
      scope: 'network-peer-binding:v1',
      issuedAtMs: 0,
      delegateePeerId: '12D3KooWFakePeerForParserTest',
      signature: '0xminimal-signature',
    };
    const full = {
      ...minimal,
      expiresAtMs: 1_700_000_060_000,
      delegateeOpKey: '0x1111111111111111111111111111111111111111',
      workspaceEncryptionKeys: [{
        encryptionKeyAlgorithm: 'X25519',
        publicEncryptionKey: 'public-key',
        encryptionKeyProof: 'wallet-proof',
      }],
      workspaceEncryptionKeysSignature: '0xworkspace-signature',
    };

    expect(parseSignedAgentDelegation(minimal)).toEqual(minimal);
    expect(parseSignedAgentDelegation(full)).toEqual(full);
  });

  it.each([
    ['a non-object', null],
    ['an array', []],
    ['an invalid agent address', {
      agentAddress: 'not-an-address',
      scope: 'scope',
      issuedAtMs: 0,
      delegateePeerId: 'peer',
      signature: 'signature',
    }],
    ['an empty scope', {
      agentAddress: wallet.address,
      scope: ' ',
      issuedAtMs: 0,
      delegateePeerId: 'peer',
      signature: 'signature',
    }],
    ['a negative issuance timestamp', {
      agentAddress: wallet.address,
      scope: 'scope',
      issuedAtMs: -1,
      delegateePeerId: 'peer',
      signature: 'signature',
    }],
    ['a non-finite issuance timestamp', {
      agentAddress: wallet.address,
      scope: 'scope',
      issuedAtMs: Number.POSITIVE_INFINITY,
      delegateePeerId: 'peer',
      signature: 'signature',
    }],
    ['a negative expiration timestamp', {
      agentAddress: wallet.address,
      scope: 'scope',
      issuedAtMs: 0,
      expiresAtMs: -1,
      delegateePeerId: 'peer',
      signature: 'signature',
    }],
    ['a non-finite expiration timestamp', {
      agentAddress: wallet.address,
      scope: 'scope',
      issuedAtMs: 0,
      expiresAtMs: Number.NaN,
      delegateePeerId: 'peer',
      signature: 'signature',
    }],
    ['both delegatees absent', {
      agentAddress: wallet.address,
      scope: 'scope',
      issuedAtMs: 0,
      signature: 'signature',
    }],
    ['a non-string peer delegatee', {
      agentAddress: wallet.address,
      scope: 'scope',
      issuedAtMs: 0,
      delegateePeerId: 42,
      signature: 'signature',
    }],
    ['an empty operational-key delegatee', {
      agentAddress: wallet.address,
      scope: 'scope',
      issuedAtMs: 0,
      delegateeOpKey: ' ',
      signature: 'signature',
    }],
    ['an empty signature', {
      agentAddress: wallet.address,
      scope: 'scope',
      issuedAtMs: 0,
      delegateePeerId: 'peer',
      signature: '',
    }],
    ['a non-array workspace-key bundle', {
      agentAddress: wallet.address,
      scope: 'scope',
      issuedAtMs: 0,
      delegateePeerId: 'peer',
      signature: 'signature',
      workspaceEncryptionKeys: {},
    }],
    ['a non-object workspace-key entry', {
      agentAddress: wallet.address,
      scope: 'scope',
      issuedAtMs: 0,
      delegateePeerId: 'peer',
      signature: 'signature',
      workspaceEncryptionKeys: [null],
    }],
    ['a non-X25519 workspace-key algorithm', {
      agentAddress: wallet.address,
      scope: 'scope',
      issuedAtMs: 0,
      delegateePeerId: 'peer',
      signature: 'signature',
      workspaceEncryptionKeys: [{
        encryptionKeyAlgorithm: 'RSA',
        publicEncryptionKey: 'public-key',
        encryptionKeyProof: 'wallet-proof',
      }],
    }],
    ['an empty workspace public key', {
      agentAddress: wallet.address,
      scope: 'scope',
      issuedAtMs: 0,
      delegateePeerId: 'peer',
      signature: 'signature',
      workspaceEncryptionKeys: [{
        encryptionKeyAlgorithm: 'X25519',
        publicEncryptionKey: '',
        encryptionKeyProof: 'wallet-proof',
      }],
    }],
    ['an empty workspace key proof', {
      agentAddress: wallet.address,
      scope: 'scope',
      issuedAtMs: 0,
      delegateePeerId: 'peer',
      signature: 'signature',
      workspaceEncryptionKeys: [{
        encryptionKeyAlgorithm: 'X25519',
        publicEncryptionKey: 'public-key',
        encryptionKeyProof: ' ',
      }],
    }],
    ['an empty workspace-key attestation signature', {
      agentAddress: wallet.address,
      scope: 'scope',
      issuedAtMs: 0,
      delegateePeerId: 'peer',
      signature: 'signature',
      workspaceEncryptionKeysSignature: '',
    }],
  ])('rejects %s at the wire parser boundary', (_label, value) => {
    expect(parseSignedAgentDelegation(value)).toBeUndefined();
  });

  it('signs and verifies a delegation roundtrip', async () => {
    const signed = await signAgentDelegation(baseParams);
    expect(signed.signature).toMatch(/^0x[0-9a-fA-F]+$/);
    expect(signed.agentAddress.toLowerCase()).toBe(wallet.address.toLowerCase());
    const verified = verifyAgentDelegation(signed, {
      expectedScope: baseParams.scope,
      nowMs: baseParams.issuedAtMs,
    });
    expect(verified.delegateePeerId).toBe(baseParams.delegateePeerId);
    expect(verified.delegateeOpKey).toBe(baseParams.delegateeOpKey);
  });

  it('rejects when scope does not match expectation', async () => {
    const signed = await signAgentDelegation(baseParams);
    expect(() =>
      verifyAgentDelegation(signed, {
        expectedScope: 'sync:other-cg',
        nowMs: baseParams.issuedAtMs,
      }),
    ).toThrow(/scope mismatch/);
  });

  it('rejects an expired delegation', async () => {
    const signed = await signAgentDelegation(baseParams);
    expect(() =>
      verifyAgentDelegation(signed, { nowMs: signed.expiresAtMs! + 1 }),
    ).toThrow(/expired/);
  });

  it('accepts a non-expiring delegation (expiresAtMs omitted)', async () => {
    const { expiresAtMs: _drop, ...rest } = baseParams;
    const signed = await signAgentDelegation(rest);
    expect(() =>
      verifyAgentDelegation(signed, { nowMs: Date.now() }),
    ).not.toThrow();
  });

  it('detects signer mismatch (signature forged with different key)', async () => {
    const signed = await signAgentDelegation(baseParams);
    const tampered: SignedAgentDelegation = {
      ...signed,
      signature: await otherWallet.signMessage(computeDelegationDigest(signed)),
    };
    expect(() =>
      verifyAgentDelegation(tampered, { nowMs: baseParams.issuedAtMs }),
    ).toThrow(/signer mismatch/);
  });

  it('rejects payload tampering: changing delegateeOpKey invalidates the signature', async () => {
    const signed = await signAgentDelegation(baseParams);
    const tampered: SignedAgentDelegation = {
      ...signed,
      delegateeOpKey: '0x2222222222222222222222222222222222222222',
    };
    expect(() =>
      verifyAgentDelegation(tampered, { nowMs: baseParams.issuedAtMs }),
    ).toThrow(/signer mismatch/);
  });

  it('rejects payload tampering: changing delegateePeerId invalidates the signature', async () => {
    const signed = await signAgentDelegation(baseParams);
    const tampered: SignedAgentDelegation = {
      ...signed,
      delegateePeerId: '12D3KooWDifferentPeer',
    };
    expect(() =>
      verifyAgentDelegation(tampered, { nowMs: baseParams.issuedAtMs }),
    ).toThrow(/signer mismatch/);
  });

  it('refuses to sign when private key does not match agentAddress', async () => {
    await expect(
      signAgentDelegation({
        ...baseParams,
        agentPrivateKey: otherWallet.privateKey,
      }),
    ).rejects.toThrow(/does not match agentAddress/);
  });

  it('requires at least one delegatee identifier when signing', async () => {
    const { delegateePeerId: _p, delegateeOpKey: _k, ...rest } = baseParams;
    await expect(signAgentDelegation(rest)).rejects.toThrow(
      /at least one of delegateePeerId/,
    );
  });

  it('accepts delegateePeerId-only delegation', async () => {
    const { delegateeOpKey: _drop, ...rest } = baseParams;
    const signed = await signAgentDelegation(rest);
    const verified = verifyAgentDelegation(signed, {
      expectedScope: rest.scope,
      nowMs: rest.issuedAtMs,
    });
    expect(verified.delegateePeerId).toBe(rest.delegateePeerId);
    expect(verified.delegateeOpKey).toBeUndefined();
  });

  it('accepts delegateeOpKey-only delegation', async () => {
    const { delegateePeerId: _drop, ...rest } = baseParams;
    const signed = await signAgentDelegation(rest);
    const verified = verifyAgentDelegation(signed, {
      expectedScope: rest.scope,
      nowMs: rest.issuedAtMs,
    });
    expect(verified.delegateeOpKey).toBe(rest.delegateeOpKey);
    expect(verified.delegateePeerId).toBeUndefined();
  });

  it('digest is deterministic for the same payload', async () => {
    const a = computeDelegationDigest(baseParams);
    const b = computeDelegationDigest(baseParams);
    expect(ethers.hexlify(a)).toBe(ethers.hexlify(b));
  });

  it('digest is case-insensitive for ethereum addresses', async () => {
    const a = computeDelegationDigest(baseParams);
    const b = computeDelegationDigest({
      ...baseParams,
      agentAddress: baseParams.agentAddress.toUpperCase(),
      delegateeOpKey: baseParams.delegateeOpKey!.toUpperCase(),
    });
    expect(ethers.hexlify(a)).toBe(ethers.hexlify(b));
  });

  it('binds an optional encryption-key bundle without changing v2 delegation verification', async () => {
    const signed = await signAgentDelegation(baseParams);
    const withKeys: SignedAgentDelegation = {
      ...signed,
      workspaceEncryptionKeys: [{
        encryptionKeyAlgorithm: 'X25519',
        publicEncryptionKey: 'first-public-key',
        encryptionKeyProof: 'first-wallet-proof',
      }],
    };
    const workspaceEncryptionKeysSignature = await wallet.signMessage(
      computeWorkspaceEncryptionKeysAttestationDigest(withKeys),
    );
    const attested = { ...withKeys, workspaceEncryptionKeysSignature };

    // An older curator verifies the unchanged v2 fields and ignores the
    // additive bundle. Upgraded curators verify the second wallet signature.
    expect(() => verifyAgentDelegation(attested, {
      expectedScope: baseParams.scope,
      nowMs: baseParams.issuedAtMs,
    })).not.toThrow();
    expect(ethers.verifyMessage(
      computeWorkspaceEncryptionKeysAttestationDigest(attested),
      workspaceEncryptionKeysSignature,
    ).toLowerCase()).toBe(wallet.address.toLowerCase());

    const substituted = {
      ...attested,
      workspaceEncryptionKeys: [{
        encryptionKeyAlgorithm: 'X25519' as const,
        publicEncryptionKey: 'substituted-public-key',
        encryptionKeyProof: 'substituted-wallet-proof',
      }],
    };
    expect(ethers.verifyMessage(
      computeWorkspaceEncryptionKeysAttestationDigest(substituted),
      workspaceEncryptionKeysSignature,
    ).toLowerCase()).not.toBe(wallet.address.toLowerCase());
  });

  it('sorts a reordered two-key attestation ordinally without locale collation', async () => {
    const signed = await signAgentDelegation(baseParams);
    const first = {
      encryptionKeyAlgorithm: 'X25519' as const,
      publicEncryptionKey: 'z-public-key',
      encryptionKeyProof: 'z-wallet-proof',
    };
    const second = {
      encryptionKeyAlgorithm: 'X25519' as const,
      publicEncryptionKey: 'ä-public-key',
      encryptionKeyProof: 'ä-wallet-proof',
    };
    const localeCompare = vi.spyOn(String.prototype, 'localeCompare');

    try {
      const forward = computeWorkspaceEncryptionKeysAttestationDigest({
        ...signed,
        workspaceEncryptionKeys: [first, second],
      });
      const reordered = computeWorkspaceEncryptionKeysAttestationDigest({
        ...signed,
        workspaceEncryptionKeys: [second, first],
      });

      expect(ethers.hexlify(reordered)).toBe(ethers.hexlify(forward));
      expect(localeCompare).not.toHaveBeenCalled();
    } finally {
      localeCompare.mockRestore();
    }
  });
});
