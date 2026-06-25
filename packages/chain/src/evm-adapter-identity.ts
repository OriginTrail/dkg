// SPDX-License-Identifier: Apache-2.0

/**
 * Identity / profile / operational-wallet registration methods.
 *
 * Mixin holder extracted from evm-adapter.ts. `extends EVMChainAdapterBase`
 * for shared state (providers, signers, caches) reached via `this`. Bodies
 * are a 1:1 move — no behaviour change. Mixed into the concrete EVMChainAdapter
 * via applyMixins(); see evm-adapter.ts for the assembly.
 */

import { EVMChainAdapterBase } from './evm-adapter-base.js';
import { ethers } from 'ethers';
import type { OperationalWalletRegistrationResult, TxResult, IdentityProof } from './chain-adapter.js';

export class IdentityMethods extends EVMChainAdapterBase {
  async ensureOperationalWalletsRegistered(options?: {
    identityId?: bigint;
    additionalAddresses?: string[];
  }): Promise<OperationalWalletRegistrationResult> {
    await this.init();

    const identityId = options?.identityId ?? (await this.getIdentityId());
    const result: OperationalWalletRegistrationResult = {
      identityId,
      registered: [],
      alreadyRegistered: [],
      taken: [],
    };
    if (identityId === 0n) return result;

    const identityStorage = await this.getIdentityStorage();
    const candidates = [
      ...this.signerPool.map((s) => s.address),
      ...(options?.additionalAddresses ?? []),
    ];
    const seen = new Set<string>();
    const uniqueAddresses: string[] = [];
    for (const candidate of candidates) {
      const address = ethers.getAddress(candidate);
      const key = address.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      uniqueAddresses.push(address);
    }

    const onChainIds = await Promise.all(
      uniqueAddresses.map((addr) => this.contractReadWithFailover(
        'identityStorage.getIdentityId', identityStorage, (c) => c.getIdentityId(addr),
      ).then(BigInt)),
    );
    const missing: string[] = [];
    for (let i = 0; i < uniqueAddresses.length; i++) {
      const address = uniqueAddresses[i];
      const existingIdentityId = onChainIds[i];
      if (existingIdentityId === identityId) {
        result.alreadyRegistered.push(address);
      } else if (existingIdentityId === 0n) {
        missing.push(address);
      } else {
        result.taken.push({ address, identityId: existingIdentityId });
      }
    }

    if (missing.length === 0) return result;

    if (!this.adminSigner) {
      throw new Error(
        `Cannot register operational wallets for identity ${identityId}: ` +
        'adminPrivateKey is not configured.',
      );
    }
    if (!(await this.hasAdminPurpose(identityStorage, identityId, this.adminSigner.address))) {
      throw new Error(
        `Cannot register operational wallets for identity ${identityId}: configured admin wallet ` +
        `${this.adminSigner.address} is not registered on-chain as an admin key for this identity.`,
      );
    }

    await this.sendContractTransaction(
      this.contracts.profile!,
      'addOperationalWallets',
      [identityId, missing],
      this.adminSigner,
      'addOperationalWallets',
    );

    for (const address of missing) {
      if (await this.hasOperationalPurpose(identityStorage, identityId, address)) {
        result.registered.push(address);
      }
    }

    return result;
  }

  // =====================================================================
  // RFC 04 v0.3 / Issue #461 — Network State Registry surface (relay-capable).
  // Multiaddrs are NOT exposed here — they live in per-round attestation KCs
  // (RFC 04 §5.2), not on Profile.
  // =====================================================================

  async getRelayCapable(identityId: bigint): Promise<boolean> {
    await this.init();
    if (!this.contracts.profileStorage) {
      throw new Error('getRelayCapable: ProfileStorage not deployed on this Hub.');
    }
    return Boolean(await this.contractReadWithFailover(
      'profileStorage.getRelayCapable', this.contracts.profileStorage, (c) => c.getRelayCapable(identityId),
    ));
  }

  async setRelayCapable(relayCapable: boolean): Promise<TxResult> {
    await this.init();
    if (!this.contracts.profile) {
      throw new Error('setRelayCapable: Profile not deployed on this Hub.');
    }
    const identityId = await this.getIdentityId();
    if (identityId === 0n) {
      throw new Error('setRelayCapable: signer has no on-chain profile (call ensureProfile first).');
    }
    const receipt = await this.sendContractTransaction(
      this.contracts.profile,
      'updateRelayCapable',
      [identityId, relayCapable],
      this.signer,
      'updateRelayCapable',
    );
    return {
      hash: receipt.hash,
      blockNumber: receipt.blockNumber,
      txIndex: receipt.index,
      success: receipt.status === 1,
    };
  }

  /**
   * OT-RFC-39 — view-only address → identityId lookup. Returns 0n
   * when the address is not registered as a node operator. Caches
   * results per-process: `IdentityStorage.identities` is append-only
   * (operator key rotation goes through a separate slot), so a
   * memoised hit is safe.
   */
  async getIdentityIdForAddress(address: string): Promise<bigint> {
    if (!ethers.isAddress(address)) return 0n;
    const checksum = ethers.getAddress(address);
    const cached = this.identityIdByAddressCache.get(checksum.toLowerCase());
    if (cached !== undefined) return cached;
    await this.init();
    const identityStorage = await this.resolveContract('IdentityStorage');
    const id: bigint = await this.contractReadWithFailover(
      'identityStorage.getIdentityId', identityStorage, (c) => c.getIdentityId(checksum),
    );
    if (id > 0n) {
      // Only memoise positive hits — a 0n result may flip to non-zero
      // once the operator registers, and we don't want to lock the
      // negative answer in for the process lifetime.
      this.identityIdByAddressCache.set(checksum.toLowerCase(), id);
    }
    return id;
  }

  async ensureProfile(options?: { nodeName?: string; stakeAmount?: bigint; lockTier?: number }): Promise<bigint> {
    await this.init();

    let identityId = await this.getIdentityId();

    // Step 1: Create profile if none exists
    if (identityId === 0n) {
      const nodeName = options?.nodeName ?? `node-${Date.now()}`;
      if (!this.adminSigner) {
        throw new Error(
          'Cannot create profile: adminPrivateKey is required so the profile admin key is not lost.',
        );
      }
      const nodeId = ethers.hexlify(ethers.randomBytes(32));

      const receipt = await this.sendContractTransaction(
        this.contracts.profile!,
        'createProfile',
        [this.adminSigner.address, [], nodeName, nodeId, 0],
        this.signer,
        'createProfile',
      );

      for (const log of receipt.logs) {
        try {
          const parsed = this.contracts.identity!.interface.parseLog({
            topics: [...log.topics],
            data: log.data,
          });
          if (parsed?.name === 'IdentityCreated') {
            identityId = BigInt(parsed.args.identityId);
            break;
          }
        } catch { /* not this contract */ }
      }

      if (identityId === 0n) {
        throw new Error('Profile created but no IdentityCreated event found');
      }
    }

    // Step 2: Stake via V10 path (separate try/catch so profile isn't lost).
    //
    // V10 consolidation (v4.0.0): stake routes through
    // `DKGStakingConvictionNFT.createConviction(identityId, amount, lockTier)`,
    // which mints a V10 NFT position, writes `nodeStakeV10` in
    // `ConvictionStakingStorage`, and pulls TRAC into the V10 vault (CSS) via
    // `StakingV10`. The legacy V8 `Staking.stake` path updates only V8
    // `StakingStorage` and leaves `nodeStakeV10 = 0`, so
    // `RandomSampling.calculateNodeScore` (which reads `getNodeStakeV10`
    // exclusively) computes zero and node scores never grow — exactly the
    // bug we just chased on devnet. This path mirrors `scripts/devnet.sh`.
    //
    // TRAC allowance must go to `StakingV10` (the actual `transferFrom`
    // caller), NOT to the NFT — the NFT is only the entry point and never
    // custodies TRAC.
    const stakeAmount = options?.stakeAmount ?? ethers.parseEther('50000');
    const lockTier = options?.lockTier ?? 1; // tier 1 = 1-month, cheapest non-zero multiplier
    if (stakeAmount > 0n && this.contracts.token) {
      try {
        const stakingNFT = await this.resolveContract('DKGStakingConvictionNFT');
        const stakingV10Addr: string = await this.contractReadWithFailover(
          'Hub.getContractAddress(StakingV10)', this.contracts.hub, (c) => c.getContractAddress('StakingV10'),
        );
        if (stakingV10Addr === ethers.ZeroAddress) {
          throw new Error('StakingV10 not registered in Hub — V10 staking unavailable');
        }
        await this.sendContractTransaction(
          this.contracts.token,
          'approve',
          [stakingV10Addr, stakeAmount],
          this.signer,
          'approve staking TRAC',
        );
        // Wait an extra block for state propagation on public RPCs
        await new Promise(r => setTimeout(r, 2000));

        await this.sendContractTransaction(
          stakingNFT,
          'createConviction',
          [identityId, stakeAmount, lockTier],
          this.signer,
          'create staking conviction',
        );
      } catch (err) {
        console.warn(
          `[ensureProfile] V10 staking failed for identity ${identityId} (profile exists, stake manually via DKGStakingConvictionNFT.createConviction): ` +
          (err instanceof Error ? err.message : String(err)),
        );
      }
    }

    return identityId;
  }

  async registerIdentity(proof: IdentityProof): Promise<bigint> {
    await this.init();
    if (!this.adminSigner) {
      throw new Error(
        'Cannot register identity: adminPrivateKey is required so the profile admin key is not lost.',
      );
    }
    const nodeName = `node-${ethers.hexlify(ethers.randomBytes(4)).slice(2)}`;
    const nodeId = proof.publicKey.length > 0 ? proof.publicKey : ethers.randomBytes(32);

    const receipt = await this.sendContractTransaction(
      this.contracts.profile!,
      'createProfile',
      [this.adminSigner.address, [], nodeName, nodeId, 0],
      this.signer,
      'createProfile',
    );

    for (const log of receipt.logs) {
      try {
        const parsed = this.contracts.identity!.interface.parseLog({
          topics: [...log.topics],
          data: log.data,
        });
        if (parsed?.name === 'IdentityCreated') {
          return BigInt(parsed.args.identityId);
        }
      } catch { /* not this contract */ }
    }

    for (const log of receipt.logs) {
      try {
        const parsed = this.contracts.profile!.interface.parseLog({
          topics: [...log.topics],
          data: log.data,
        });
        if (parsed?.name === 'ProfileCreated') {
          return BigInt(parsed.args.identityId);
        }
      } catch { /* not this contract */ }
    }

    throw new Error('Identity registration succeeded but no identity ID found in events');
  }
}
