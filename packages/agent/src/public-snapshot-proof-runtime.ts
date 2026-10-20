// SPDX-License-Identifier: Apache-2.0
import { ethers } from 'ethers';
import { startRequestAbortLifecycle } from '@origintrail-official/dkg-core';
import type { ChainAdapter } from '@origintrail-official/dkg-chain';
import type { AgentWorkLifetime } from './agent-work-lifetime.js';
import { PublicSnapshotAdmission } from './public-snapshot-admission.js';

/** Shared physical request ownership for both proof protocols on one node. */
export class PublicSnapshotProofRuntime {
  private readonly admission = new PublicSnapshotAdmission(Date.now, 4);
  constructor(
    private readonly chain: Pick<ChainAdapter, 'getIdentityId' | 'signMessage'>,
    private readonly workLifetime: AgentWorkLifetime,
  ) {}

  async respond(peer: string, authorize: (signal: AbortSignal) => {
    assertCurrent(): void;
    validate(): Promise<void>;
    proof(identityId: string): { fields: Record<string, string>; payload: Uint8Array };
  }): Promise<Uint8Array> {
    const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
    const lifetime = startRequestAbortLifecycle(10_000, [this.workLifetime.signal]);
    let release: (() => void) | undefined;
    try {
      lifetime.signal.throwIfAborted();
      const request = authorize(lifetime.signal);
      const assertCurrent = () => { lifetime.signal.throwIfAborted(); request.assertCurrent(); };
      assertCurrent();
      release = this.admission.acquire(peer);
      const operation = (async () => {
        await request.validate();
        assertCurrent();
        const identityId = (await this.chain.getIdentityId({ signal: lifetime.signal, ownership: 'independent' })).toString();
        assertCurrent();
        const proof = request.proof(identityId);
        const signature = await this.chain.signMessage!(proof.payload, { signal: lifetime.signal });
        assertCurrent();
        return encode({ ...proof.fields, signature: ethers.Signature.from({
          r: ethers.hexlify(signature.r), yParityAndS: ethers.hexlify(signature.vs),
        }).serialized });
      })();
      this.workLifetime.track(operation);
      return await operation;
    } catch { return encode({ unavailable: true }); }
    finally { release?.(); lifetime.release(); }
  }
}
