import { describe, expect, it } from 'vitest';
import { computePublishPublisherDigest } from '@origintrail-official/dkg-core';
import { ethers } from 'ethers';
import { PublishGatewayHandler } from '../src/index.js';

const CHAIN_ID = 31337n;
const KAV10_ADDRESS = '0x000000000000000000000000000000000000c10a';
const CG_ID = 42n;
const MERKLE_ROOT = ethers.keccak256(ethers.toUtf8Bytes('gateway-root'));

async function callGateway(handler: PublishGatewayHandler, request: Record<string, unknown>) {
  const bytes = await handler.handler(
    new TextEncoder().encode(JSON.stringify(request)),
    { toString: () => 'peer-test' },
  );
  return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, string>;
}

describe('PublishGatewayHandler', () => {
  it('signs the V10 publisher digest with the configured core identity', async () => {
    const wallet = ethers.Wallet.createRandom();
    const nodeIdentityId = 7n;
    const handler = new PublishGatewayHandler({
      nodeRole: 'core',
      nodeIdentityId,
      signerWallet: wallet,
      chainId: CHAIN_ID,
      kav10Address: KAV10_ADDRESS,
      isActiveCore: async () => true,
    });

    const response = await callGateway(handler, {
      chainId: CHAIN_ID.toString(),
      kav10Address: KAV10_ADDRESS,
      contextGraphId: CG_ID.toString(),
      merkleRoot: MERKLE_ROOT,
      nodeIdentityId: nodeIdentityId.toString(),
    });

    expect(response.error).toBeUndefined();
    expect(response.nodeIdentityId).toBe(nodeIdentityId.toString());
    expect(ethers.getAddress(response.signer)).toBe(wallet.address);

    const digest = computePublishPublisherDigest(
      CHAIN_ID,
      KAV10_ADDRESS,
      nodeIdentityId,
      CG_ID,
      ethers.getBytes(MERKLE_ROOT),
    );
    const recovered = ethers.verifyMessage(
      digest,
      ethers.Signature.from({ r: response.signatureR, yParityAndS: response.signatureVS }),
    );
    expect(ethers.getAddress(recovered)).toBe(wallet.address);
  });

  it('refuses to sign from an edge node', async () => {
    const handler = new PublishGatewayHandler({
      nodeRole: 'edge',
      nodeIdentityId: 7n,
      signerWallet: ethers.Wallet.createRandom(),
      chainId: CHAIN_ID,
      kav10Address: KAV10_ADDRESS,
    });

    const response = await callGateway(handler, {
      contextGraphId: CG_ID.toString(),
      merkleRoot: MERKLE_ROOT,
    });

    expect(response.error).toContain('Only core nodes can act as publish gateways');
  });

  it('fails clearly when a requested PCA account is unavailable', async () => {
    const handler = new PublishGatewayHandler({
      nodeRole: 'core',
      nodeIdentityId: 7n,
      signerWallet: ethers.Wallet.createRandom(),
      chainId: CHAIN_ID,
      kav10Address: KAV10_ADDRESS,
      pcaAccountId: 100n,
      isActiveCore: async () => true,
      getConvictionAccountInfo: async () => ({ id: 99n }),
    });

    const response = await callGateway(handler, {
      contextGraphId: CG_ID.toString(),
      merkleRoot: MERKLE_ROOT,
      pcaAccountId: '99',
    });

    expect(response.error).toContain('Publish gateway PCA account 99 unavailable');
  });

  it('confirms a configured PCA account when available', async () => {
    const handler = new PublishGatewayHandler({
      nodeRole: 'core',
      nodeIdentityId: 7n,
      signerWallet: ethers.Wallet.createRandom(),
      chainId: CHAIN_ID,
      kav10Address: KAV10_ADDRESS,
      pcaAccountId: 99n,
      isActiveCore: async () => true,
      getConvictionAccountInfo: async (id) => id === 99n ? { id } : null,
    });

    const response = await callGateway(handler, {
      contextGraphId: CG_ID.toString(),
      merkleRoot: MERKLE_ROOT,
      pcaAccountId: '99',
    });

    expect(response.error).toBeUndefined();
    expect(response.pcaAccountId).toBe('99');
  });

  it('fails clearly when a requested paymaster is unavailable', async () => {
    const paymaster = '0x000000000000000000000000000000000000beef';
    const handler = new PublishGatewayHandler({
      nodeRole: 'core',
      nodeIdentityId: 7n,
      signerWallet: ethers.Wallet.createRandom(),
      chainId: CHAIN_ID,
      kav10Address: KAV10_ADDRESS,
      paymaster: '0x000000000000000000000000000000000000feed',
      // Required in combination with `paymaster` to satisfy the
      // fail-closed invariant introduced in PR #405.
      allowedPeers: new Set(['peer-test']),
      isActiveCore: async () => true,
      isPaymasterValid: async () => false,
    });

    const response = await callGateway(handler, {
      contextGraphId: CG_ID.toString(),
      merkleRoot: MERKLE_ROOT,
      paymaster,
    });

    expect(response.error).toContain(`Publish gateway paymaster ${ethers.getAddress(paymaster)} unavailable`);
  });

  it('confirms a configured paymaster when valid', async () => {
    const paymaster = '0x000000000000000000000000000000000000beef';
    const handler = new PublishGatewayHandler({
      nodeRole: 'core',
      nodeIdentityId: 7n,
      signerWallet: ethers.Wallet.createRandom(),
      chainId: CHAIN_ID,
      kav10Address: KAV10_ADDRESS,
      paymaster,
      // Required in combination with `paymaster` to satisfy the
      // fail-closed invariant introduced in PR #405.
      allowedPeers: new Set(['peer-test']),
      isActiveCore: async () => true,
      isPaymasterValid: async (candidate) => ethers.getAddress(candidate) === ethers.getAddress(paymaster),
    });

    const response = await callGateway(handler, {
      contextGraphId: CG_ID.toString(),
      merkleRoot: MERKLE_ROOT,
      paymaster,
    });

    expect(response.error).toBeUndefined();
    expect(ethers.getAddress(response.paymaster)).toBe(ethers.getAddress(paymaster));
  });

  it('refuses to sign when the identity is not an active sharding-table core', async () => {
    const handler = new PublishGatewayHandler({
      nodeRole: 'core',
      nodeIdentityId: 7n,
      signerWallet: ethers.Wallet.createRandom(),
      chainId: CHAIN_ID,
      kav10Address: KAV10_ADDRESS,
      isActiveCore: async () => false,
    });

    const response = await callGateway(handler, {
      contextGraphId: CG_ID.toString(),
      merkleRoot: MERKLE_ROOT,
    });

    expect(response.error).toContain('Publish gateway identity is not an active sharding-table core node');
  });

  it('refuses to sign for peers outside the allowlist', async () => {
    const handler = new PublishGatewayHandler({
      nodeRole: 'core',
      nodeIdentityId: 7n,
      signerWallet: ethers.Wallet.createRandom(),
      chainId: CHAIN_ID,
      kav10Address: KAV10_ADDRESS,
      isActiveCore: async () => true,
      allowedPeers: new Set(['allowed-peer-1', 'allowed-peer-2']),
    });

    const response = await callGateway(handler, {
      contextGraphId: CG_ID.toString(),
      merkleRoot: MERKLE_ROOT,
    });

    expect(response.error).toContain('Publish gateway peer peer-test is not allowed');
  });

  it('refuses to construct when paymaster is set without an allowlist (fail-closed)', () => {
    expect(() => new PublishGatewayHandler({
      nodeRole: 'core',
      nodeIdentityId: 7n,
      signerWallet: ethers.Wallet.createRandom(),
      chainId: CHAIN_ID,
      kav10Address: KAV10_ADDRESS,
      paymaster: '0x000000000000000000000000000000000000beef',
      isActiveCore: async () => true,
      isPaymasterValid: async () => true,
    })).toThrow(/paymaster is configured but allowedPeers is empty/);
  });

  it('refuses to construct when paymaster is set with an empty allowlist (fail-closed)', () => {
    expect(() => new PublishGatewayHandler({
      nodeRole: 'core',
      nodeIdentityId: 7n,
      signerWallet: ethers.Wallet.createRandom(),
      chainId: CHAIN_ID,
      kav10Address: KAV10_ADDRESS,
      paymaster: '0x000000000000000000000000000000000000beef',
      allowedPeers: new Set(),
      isActiveCore: async () => true,
      isPaymasterValid: async () => true,
    })).toThrow(/paymaster is configured but allowedPeers is empty/);
  });

  it('signs for peers inside the allowlist', async () => {
    const wallet = ethers.Wallet.createRandom();
    const handler = new PublishGatewayHandler({
      nodeRole: 'core',
      nodeIdentityId: 7n,
      signerWallet: wallet,
      chainId: CHAIN_ID,
      kav10Address: KAV10_ADDRESS,
      isActiveCore: async () => true,
      allowedPeers: new Set(['peer-test']),
    });

    const response = await callGateway(handler, {
      contextGraphId: CG_ID.toString(),
      merkleRoot: MERKLE_ROOT,
    });

    expect(response.error).toBeUndefined();
    expect(ethers.getAddress(response.signer)).toBe(wallet.address);
  });
});
