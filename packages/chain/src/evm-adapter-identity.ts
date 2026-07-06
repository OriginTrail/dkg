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
      uniqueAddresses.map((addr) => this.readContract(
        identityStorage, 'identityStorage.getIdentityId', 'getIdentityId', addr,
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
        this.seedIdentityIdForAddress(address, identityId);
      }
    }

    return result;
  }

  /**
   * Add a single operational wallet to the node identity via
   * `Profile.addOperationalWallets(identityId, [address])`. Signed by the
   * configured admin key (the contract's `onlyAdmin` gate). Mirrors the
   * preconditions of {@link ensureOperationalWalletsRegistered}: requires an
   * admin key that is registered on-chain as an ADMIN_KEY for the identity.
   */
  async addOperationalWallet(address: string, options?: { identityId?: bigint }): Promise<TxResult> {
    await this.init();
    if (!ethers.isAddress(address)) {
      throw new Error(`addOperationalWallet: invalid address ${address}`);
    }
    const wallet = ethers.getAddress(address);
    const identityId = options?.identityId ?? (await this.getIdentityId());
    if (identityId === 0n) {
      throw new Error('addOperationalWallet: node has no on-chain profile (create a profile first).');
    }
    if (!this.adminSigner) {
      throw new Error(
        `Cannot add operational wallet to identity ${identityId}: adminPrivateKey is not configured.`,
      );
    }
    const identityStorage = await this.getIdentityStorage();
    if (!(await this.hasAdminPurpose(identityStorage, identityId, this.adminSigner.address))) {
      throw new Error(
        `Cannot add operational wallet to identity ${identityId}: configured admin wallet ` +
        `${this.adminSigner.address} is not registered on-chain as an admin key for this identity.`,
      );
    }
    const receipt = await this.sendContractTransaction(
      this.contracts.profile!,
      'addOperationalWallets',
      [identityId, [wallet]],
      this.adminSigner,
      'addOperationalWallet',
    );
    this.seedIdentityIdForAddress(wallet, identityId);
    return {
      hash: receipt.hash,
      blockNumber: receipt.blockNumber,
      txIndex: receipt.index,
      success: receipt.status === 1,
    };
  }

  /**
   * Remove a single operational wallet from the node identity via
   * `Identity.removeKey(identityId, keccak(address))`. Profile exposes no
   * remove path, so this calls Identity directly with the admin key
   * (`onlyAdmin`). REFUSES to remove the bound primary operational wallet:
   * `getIdentityId()` resolves the node's identity from `this.signer.address`,
   * so removing it would orphan the node's own identity resolution while other
   * keys remain — and the contract's only guard is `CannotDeleteOnlyOperationalKey`
   * (the LAST key), which would not stop this.
   */
  async removeOperationalWallet(address: string, options?: { identityId?: bigint }): Promise<TxResult> {
    await this.init();
    if (!ethers.isAddress(address)) {
      throw new Error(`removeOperationalWallet: invalid address ${address}`);
    }
    const wallet = ethers.getAddress(address);
    if (wallet.toLowerCase() === this.signer.address.toLowerCase()) {
      throw new Error(
        `removeOperationalWallet: refusing to remove the node's primary operational wallet ` +
        `${this.signer.address} — it anchors on-chain identity resolution.`,
      );
    }
    const identityId = options?.identityId ?? (await this.getIdentityId());
    if (identityId === 0n) {
      throw new Error('removeOperationalWallet: node has no on-chain profile.');
    }
    if (!this.adminSigner) {
      throw new Error(
        `Cannot remove operational wallet from identity ${identityId}: adminPrivateKey is not configured.`,
      );
    }
    const identityStorage = await this.getIdentityStorage();
    if (!(await this.hasAdminPurpose(identityStorage, identityId, this.adminSigner.address))) {
      throw new Error(
        `Cannot remove operational wallet from identity ${identityId}: configured admin wallet ` +
        `${this.adminSigner.address} is not registered on-chain as an admin key for this identity.`,
      );
    }
    // Refuse to remove a wallet that is itself registered as an ADMIN key for this
    // identity. `removeKey` deletes a key by hash regardless of its purpose, so
    // without this guard the "remove operational wallet" path would strip an
    // ADMIN_KEY (ERC-734 purpose 1) and could lock the operator out of admin
    // control. Operational-key removal must touch operational keys only; admin-key
    // rotation is a deliberate, separate action.
    if (await this.hasAdminPurpose(identityStorage, identityId, wallet)) {
      throw new Error(
        `removeOperationalWallet: refusing to remove ${wallet} — it is registered on-chain as ` +
        `an ADMIN key for identity ${identityId}, not an operational key. Removing it here would ` +
        `strip admin control; rotate admin keys through admin-key management instead.`,
      );
    }
    // Positive guard: only remove a wallet that IS registered as an OPERATIONAL
    // key for this identity. `removeKey` deletes a key by its hash regardless of
    // purpose, so without this an address attached with any other (non-admin,
    // non-operational) purpose could be silently deleted through the
    // operational-wallet endpoint. Operational-key removal must touch operational
    // keys only — reject anything that is not one.
    if (!(await this.hasOperationalPurpose(identityStorage, identityId, wallet))) {
      throw new Error(
        `removeOperationalWallet: refusing to remove ${wallet} — it is not registered on-chain as ` +
        `an operational key for identity ${identityId}.`,
      );
    }
    const receipt = await this.sendContractTransaction(
      this.contracts.identity!,
      'removeKey',
      [identityId, this.walletKeyHash(wallet)],
      this.adminSigner,
      'removeOperationalWallet',
    );
    this.clearIdentityIdForAddress(wallet);
    return {
      hash: receipt.hash,
      blockNumber: receipt.blockNumber,
      txIndex: receipt.index,
      success: receipt.status === 1,
    };
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
    return Boolean(await this.readContract(
      this.contracts.profileStorage, 'profileStorage.getRelayCapable', 'getRelayCapable', identityId,
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
   * OT-RFC-39 view-only address to identityId lookup.
   *
   * Positive results are cached briefly; negative results are only coalesced
   * while in flight so a later external registration is visible immediately.
   * Local wallet mutations seed or clear the cache so operator-key changes do
   * not rely on TTL expiry.
   */
  async getIdentityIdForAddress(address: string): Promise<bigint> {
    return this.readIdentityIdForAddress(address);
  }

  async ensureProfile(options?: { nodeName?: string; stakeAmount?: bigint; lockTier?: number }): Promise<bigint> {
    await this.init();

    let identityId = await this.getIdentityId();
    if (identityId === 0n) {
      identityId = await this.refreshIdentityIdForAddress(this.signer.address);
    }

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
      this.seedIdentityIdForAddress(this.signer.address, identityId);
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
        const stakingV10Addr: string = await this.readContract(
          this.contracts.hub, 'Hub.getContractAddress(StakingV10)', 'getContractAddress', 'StakingV10',
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
          const identityId = BigInt(parsed.args.identityId);
          this.seedIdentityIdForAddress(this.signer.address, identityId);
          return identityId;
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
          const identityId = BigInt(parsed.args.identityId);
          this.seedIdentityIdForAddress(this.signer.address, identityId);
          return identityId;
        }
      } catch { /* not this contract */ }
    }

    throw new Error('Identity registration succeeded but no identity ID found in events');
  }
}
