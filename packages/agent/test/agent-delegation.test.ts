import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';
import {
  signAgentDelegation,
  verifyAgentDelegation,
  computeDelegationDigest,
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
});
