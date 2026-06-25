// SPDX-License-Identifier: Apache-2.0

/**
 * ACK / signature / identity-verification methods.
 *
 * Mixin holder extracted from evm-adapter.ts. `extends EVMChainAdapterBase`
 * for shared state (providers, signers, caches) reached via `this`. Bodies
 * are a 1:1 move — no behaviour change. Mixed into the concrete EVMChainAdapter
 * via applyMixins(); see evm-adapter.ts for the assembly.
 */

import { EVMChainAdapterBase } from './evm-adapter-base.js';
import { ethers } from 'ethers';
import type { VerifyACKIdentityResult } from './chain-adapter.js';
import { OPERATIONAL_KEY_PURPOSE } from './evm-adapter-constants.js';

export class AckSignMethods extends EVMChainAdapterBase {
  async getMinimumRequiredSignatures(): Promise<number> {
    // PR3 / RC11: TTL-cached. Governance vote that changes
    // `minimumRequiredSignatures` propagates within 1h to the ACK
    // collector; on-chain validation in `KnowledgeAssetsLifecycle` would
    // reject a publish that used the stale quorum so a single
    // mis-routed retry past the boundary is the worst-case symptom.
    const now = Date.now();
    if (EVMChainAdapterBase.preflightCacheFresh(this.cachedMinRequiredSignatures, now)) {
      return this.cachedMinRequiredSignatures!.value;
    }
    await this.init();
    // FAIL-CLOSED (Codex PR #595 round-5): the agent + publisher
    // verify paths trust whatever this method returns. A silent
    // fallback to a hardcoded `3` (or any other value) when
    // ParametersStorage isn't resolvable would let verify use the
    // wrong quorum without anyone noticing. Refuse to guess.
    if (!this.contracts.parametersStorage) {
      throw new Error(
        'getMinimumRequiredSignatures: ParametersStorage contract is not resolvable. ' +
        'Verify cannot enforce ACK quorum without a real chain read — fix the adapter wiring or pass an explicit override.',
      );
    }
    const value = Number(await this.contractReadWithFailover(
      'parametersStorage.minimumRequiredSignatures',
      this.contracts.parametersStorage,
      (c) => c.minimumRequiredSignatures(),
    ));
    this.cachedMinRequiredSignatures = { value, cachedAt: now };
    return value;
  }

  async isShardingTableMember(identityId: bigint): Promise<boolean> {
    if (identityId <= 0n) return false;
    await this.init();
    const storage = await this.resolveContract('ShardingTableStorage');
    if (!storage) {
      throw new Error(
        'isShardingTableMember: ShardingTableStorage contract is not resolvable. ' +
        'Verify path cannot enforce sharding-table eligibility without it.',
      );
    }
    return Boolean(await this.contractReadWithFailover(
      'shardingTableStorage.nodeExists', storage, (c) => c.nodeExists(identityId),
    ));
  }

  /**
   * Off-chain pre-flight for the V10 ACK signer gate. Mirrors the on-chain
   * check in `KnowledgeAssetsLifecycle._verifyACKSignature` (post-RFC-001): the
   * recovered signer must be a registered OPERATIONAL_KEY for the claimed
   * identity AND that identity must be in the active sharding table.
   *
   * Returns a structured reason on rejection so the ACKCollector log can
   * distinguish operator-actionable failures (key registration, sub-
   * `minimumStake` stake) from infrastructure failures (RPC outage). Pre-
   * RFC-001 versions of this method gated on `getNodeStakeV10 > 0`, which
   * let sub-`minimumStake` operators clear off-chain quorum and then revert
   * on-chain with `"ACK signer not in sharding table"`. ST membership is
   * updated atomically by `StakingV10` whenever a node's V10 stake crosses
   * `minimumStake` up or down.
   */
  async verifyACKIdentityDetailed(
    recoveredAddress: string,
    claimedIdentityId: bigint,
  ): Promise<VerifyACKIdentityResult> {
    try {
      await this.init();
      const identityStorage = await this.resolveContract('IdentityStorage');
      if (!identityStorage) return { valid: false, reason: 'rpc-error' };

      const keyHash = ethers.keccak256(ethers.solidityPacked(['address'], [recoveredAddress]));
      const hasPurpose: boolean = await this.contractReadWithFailover(
        'identityStorage.keyHasPurpose', identityStorage,
        (c) => c.keyHasPurpose(claimedIdentityId, keyHash, OPERATIONAL_KEY_PURPOSE),
      );
      if (!hasPurpose) return { valid: false, reason: 'key-not-registered' };

      const shardingTableStorage = await this.resolveContract('ShardingTableStorage');
      if (!shardingTableStorage) return { valid: false, reason: 'rpc-error' };
      const inST: boolean = Boolean(await this.contractReadWithFailover(
        'shardingTableStorage.nodeExists', shardingTableStorage,
        (c) => c.nodeExists(claimedIdentityId),
      ));
      if (!inST) return { valid: false, reason: 'not-in-sharding-table' };
      return { valid: true };
    } catch {
      // Any chain-side throw (filter expired, RPC rate-limit, contract
      // resolution failure mid-call) is reported as `rpc-error` so the
      // ACKCollector can log it distinctly from a definitive negative.
      // Mirrors the existing wrapper in `dkg-agent.ts:createV10ACKProvider`
      // which used to swallow these exceptions as `false`, conflating
      // transient infra failures with permanent rejections.
      return { valid: false, reason: 'rpc-error' };
    }
  }

  async verifyACKIdentity(recoveredAddress: string, claimedIdentityId: bigint): Promise<boolean> {
    // PR #711 + rc.12: delegate to the structured variant so the off-chain
    // gate stays in lockstep with the on-chain `KnowledgeAssetsLifecycle` ACK-
    // signer check (operational-key purpose AND sharding-table membership).
    // The legacy V10-stake / V8-stake fallback that lived inline here is
    // superseded by the ST-membership check inside
    // `verifyACKIdentityDetailed`, which is updated atomically by
    // `StakingV10` whenever a node crosses `minimumStake`. PR #732's
    // lazy-cache perf optimization is unaffected — the other call sites
    // in this file pick up `getIdentityStorage()` via the auto-merge.
    return (await this.verifyACKIdentityDetailed(recoveredAddress, claimedIdentityId)).valid;
  }

  async verifySyncIdentity(recoveredAddress: string, claimedIdentityId: bigint): Promise<boolean> {
    await this.init();
    const identityStorage = await this.getIdentityStorage();
    if (!identityStorage) return false;

    const keyHash = ethers.keccak256(ethers.solidityPacked(['address'], [recoveredAddress]));
    return this.contractReadWithFailover(
      'identityStorage.keyHasPurpose', identityStorage,
      (c) => c.keyHasPurpose(claimedIdentityId, keyHash, OPERATIONAL_KEY_PURPOSE),
    );
  }

  async signACKDigest(digest: Uint8Array): Promise<{ r: Uint8Array; vs: Uint8Array } | undefined> {
    try {
      const identityId = await this.getIdentityId();
      if (identityId === 0n) return undefined;
      if (!(await this.isOperationalWalletRegistered(identityId, this.signer.address))) {
        return undefined;
      }

      const sig = ethers.Signature.from(await this.signer.signMessage(digest));
      return {
        r: ethers.getBytes(sig.r),
        vs: ethers.getBytes(sig.yParityAndS),
      };
    } catch {
      return undefined;
    }
  }

  getACKSignerKey(): string | undefined {
    return this.signer.privateKey;
  }

  async signMessage(messageHash: Uint8Array): Promise<{ r: Uint8Array; vs: Uint8Array }> {
    const sig = ethers.Signature.from(
      await this.signer.signMessage(messageHash),
    );
    return {
      r: ethers.getBytes(sig.r),
      vs: ethers.getBytes(sig.yParityAndS),
    };
  }

  async signMessageAs(address: string, messageHash: Uint8Array): Promise<{ r: Uint8Array; vs: Uint8Array }> {
    const selected = this.findSignerByAddress(address);
    if (!selected) {
      throw new Error(`Cannot sign with ${address}: address is not present in the EVM signer pool.`);
    }
    const sig = ethers.Signature.from(
      await selected.signMessage(messageHash),
    );
    return {
      r: ethers.getBytes(sig.r),
      vs: ethers.getBytes(sig.yParityAndS),
    };
  }

  async signTypedData(
    domain: ethers.TypedDataDomain,
    types: Record<string, Array<{ name: string; type: string }>>,
    value: Record<string, unknown>,
  ): Promise<string> {
    return this.signer.signTypedData(domain, types, value);
  }

  async signTypedDataAs(
    address: string,
    domain: ethers.TypedDataDomain,
    types: Record<string, Array<{ name: string; type: string }>>,
    value: Record<string, unknown>,
  ): Promise<string> {
    const selected = this.findSignerByAddress(address);
    if (!selected) {
      throw new Error(`Cannot sign typed data with ${address}: address is not present in the EVM signer pool.`);
    }
    return selected.signTypedData(domain, types, value);
  }
}
