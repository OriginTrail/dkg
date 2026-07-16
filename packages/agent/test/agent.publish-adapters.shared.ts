import { expect } from 'vitest';
import { MockChainAdapter, type ChainAdapter, type OnChainPublishResult, type V10PublishDirectParams } from '@origintrail-official/dkg-chain';
import { ethers } from 'ethers';



class OperationalKeyOnlyPublishChainAdapter implements ChainAdapter {
  readonly chainId = 'mock:31337';
  capturedPublisherAddress?: string;

  constructor(private readonly wallet: ethers.Wallet) {}

  getOperationalPrivateKey(): string {
    return this.wallet.privateKey;
  }

  isV10Ready(): boolean {
    return true;
  }

  async getEvmChainId(): Promise<bigint> {
    return 31337n;
  }

  async getKnowledgeAssetsLifecycleAddress(): Promise<string> {
    return '0x00000000000000000000000000000000000000A1';
  }

  // Greenfield (PR #815): the publisher needs the DKGKnowledgeAssets address
  // to build the KA UAL after an on-chain publish.
  async getDKGKnowledgeAssetsAddress(): Promise<string> {
    return '0x00000000000000000000000000000000000000A2';
  }

  async createKnowledgeAssets(params: V10PublishDirectParams): Promise<OnChainPublishResult> {
    this.capturedPublisherAddress = params.publisherAddress;
    if (params.publisherAddress.toLowerCase() !== this.wallet.address.toLowerCase()) {
      throw new Error('publisher did not use the adapter operational key fallback');
    }
    // OT-RFC-43 Option 1: the contract _safeMints the reserved id, so echo
    // params.reservedKaId as the minted kaId (publisher asserts mintedKaId ===
    // reservedKaId). Fall back to the legacy fixed id when none was reserved.
    const kaId = params.reservedKaId ?? 1n;
    return {
      batchId: kaId,
      kaId,
      startKAId: 101n,
      endKAId: 101n,
      txHash: `0x${'34'.repeat(32)}`,
      blockNumber: 1,
      blockTimestamp: Math.floor(Date.now() / 1000),
      publisherAddress: this.wallet.address,
    };
  }
}

class ExternalOperationalKeyPublishChainAdapter implements ChainAdapter {
  readonly chainId = 'mock:31337';
  capturedPublisherAddress?: string;

  constructor(private readonly expectedPublisherAddress: string) {}

  isV10Ready(): boolean {
    return true;
  }

  async getEvmChainId(): Promise<bigint> {
    return 31337n;
  }

  async getKnowledgeAssetsLifecycleAddress(): Promise<string> {
    return '0x00000000000000000000000000000000000000A1';
  }

  // Greenfield (PR #815): the publisher needs the DKGKnowledgeAssets address
  // to build the KA UAL after an on-chain publish.
  async getDKGKnowledgeAssetsAddress(): Promise<string> {
    return '0x00000000000000000000000000000000000000A2';
  }

  async createKnowledgeAssets(params: V10PublishDirectParams): Promise<OnChainPublishResult> {
    this.capturedPublisherAddress = params.publisherAddress;
    if (params.publisherAddress.toLowerCase() !== this.expectedPublisherAddress.toLowerCase()) {
      throw new Error('publisher did not use chainConfig.operationalKeys fallback');
    }
    // OT-RFC-43 Option 1: the contract _safeMints the reserved id, so echo
    // params.reservedKaId as the minted kaId (publisher asserts mintedKaId ===
    // reservedKaId). Fall back to the legacy fixed id when none was reserved.
    const kaId = params.reservedKaId ?? 1n;
    return {
      batchId: kaId,
      kaId,
      startKAId: 101n,
      endKAId: 101n,
      txHash: `0x${'56'.repeat(32)}`,
      blockNumber: 1,
      blockTimestamp: Math.floor(Date.now() / 1000),
      publisherAddress: this.expectedPublisherAddress,
    };
  }
}

class AddressOnlyExternalOperationalKeyPublishChainAdapter extends ExternalOperationalKeyPublishChainAdapter {
  getSignerAddress(): string {
    return ethers.Wallet.createRandom().address;
  }
}

class AsyncAddressSignMessageAsPublishChainAdapter extends ExternalOperationalKeyPublishChainAdapter {
  constructor(private readonly wallet: ethers.Wallet) {
    super(wallet.address);
  }

  async getSignerAddress(): Promise<string> {
    return this.wallet.address;
  }

  async signMessageAs(address: string, messageHash: Uint8Array): Promise<{ r: Uint8Array; vs: Uint8Array }> {
    if (address.toLowerCase() !== this.wallet.address.toLowerCase()) {
      throw new Error(`unexpected signer ${address}`);
    }
    const sig = ethers.Signature.from(await this.wallet.signMessage(messageHash));
    return {
      r: ethers.getBytes(sig.r),
      vs: ethers.getBytes(sig.yParityAndS),
    };
  }
}

class GenericSignMessageExternalOperationalKeyPublishChainAdapter extends ExternalOperationalKeyPublishChainAdapter {
  constructor(
    expectedPublisherAddress: string,
    private readonly genericSigner: ethers.Wallet,
  ) {
    super(expectedPublisherAddress);
  }

  async signMessage(messageHash: Uint8Array): Promise<{ r: Uint8Array; vs: Uint8Array }> {
    const sig = ethers.Signature.from(await this.genericSigner.signMessage(messageHash));
    return {
      r: ethers.getBytes(sig.r),
      vs: ethers.getBytes(sig.yParityAndS),
    };
  }
}

class MultiSignerGenericSignMessagePublishChainAdapter extends ExternalOperationalKeyPublishChainAdapter {
  constructor(
    expectedPublisherAddress: string,
    private readonly genericSigner: ethers.Wallet,
    private readonly advertisedSigner: ethers.Wallet,
  ) {
    super(expectedPublisherAddress);
  }

  async getSignerAddresses(): Promise<string[]> {
    return [this.advertisedSigner.address];
  }

  async signMessage(messageHash: Uint8Array): Promise<{ r: Uint8Array; vs: Uint8Array }> {
    const sig = ethers.Signature.from(await this.genericSigner.signMessage(messageHash));
    return {
      r: ethers.getBytes(sig.r),
      vs: ethers.getBytes(sig.yParityAndS),
    };
  }
}

class SingleAddressMismatchedGenericSignMessagePublishChainAdapter extends ExternalOperationalKeyPublishChainAdapter {
  constructor(
    expectedPublisherAddress: string,
    private readonly advertisedSigner: ethers.Wallet,
    private readonly genericSigner: ethers.Wallet,
  ) {
    super(expectedPublisherAddress);
  }

  getSignerAddress(): string {
    return this.advertisedSigner.address;
  }

  async signMessage(messageHash: Uint8Array): Promise<{ r: Uint8Array; vs: Uint8Array }> {
    const sig = ethers.Signature.from(await this.genericSigner.signMessage(messageHash));
    return {
      r: ethers.getBytes(sig.r),
      vs: ethers.getBytes(sig.yParityAndS),
    };
  }
}

class SingleSignerAdapterPublishChainAdapter extends ExternalOperationalKeyPublishChainAdapter {
  constructor(private readonly adapterWallet: ethers.Wallet) {
    super(adapterWallet.address);
  }

  getSignerAddress(): string {
    return this.adapterWallet.address;
  }

  async signMessage(messageHash: Uint8Array): Promise<{ r: Uint8Array; vs: Uint8Array }> {
    const sig = ethers.Signature.from(await this.adapterWallet.signMessage(messageHash));
    return {
      r: ethers.getBytes(sig.r),
      vs: ethers.getBytes(sig.yParityAndS),
    };
  }
}

class ReservingAuthorityContextGraphChainAdapter extends ExternalOperationalKeyPublishChainAdapter {
  reservations = 0;

  constructor(private readonly wallet: ethers.Wallet) {
    super(wallet.address);
  }

  async getAuthorizedPublisherAddress(): Promise<string> {
    this.reservations += 1;
    return ethers.Wallet.createRandom().address;
  }

  getSignerAddress(): string {
    return this.wallet.address;
  }

  async signMessageAs(address: string, messageHash: Uint8Array): Promise<{ r: Uint8Array; vs: Uint8Array }> {
    if (address.toLowerCase() !== this.wallet.address.toLowerCase()) {
      throw new Error(`unexpected signer ${address}`);
    }
    const sig = ethers.Signature.from(await this.wallet.signMessage(messageHash));
    return {
      r: ethers.getBytes(sig.r),
      vs: ethers.getBytes(sig.yParityAndS),
    };
  }
}

export { OperationalKeyOnlyPublishChainAdapter, ExternalOperationalKeyPublishChainAdapter, AddressOnlyExternalOperationalKeyPublishChainAdapter, AsyncAddressSignMessageAsPublishChainAdapter, GenericSignMessageExternalOperationalKeyPublishChainAdapter, MultiSignerGenericSignMessagePublishChainAdapter, SingleAddressMismatchedGenericSignMessagePublishChainAdapter, SingleSignerAdapterPublishChainAdapter, ReservingAuthorityContextGraphChainAdapter };
