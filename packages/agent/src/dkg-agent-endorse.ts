// SPDX-License-Identifier: Apache-2.0

/**
 * Endorsement / verification subsystem extracted from dkg-agent.ts as a mixin
 * holder: endorse(), verify(), verifiable-memory promotion, batch trust-level
 * stamping and batch chain-provenance resolution. 1:1 move; methods take
 * `this: DKGAgent` so cross-calls resolve against the composed class.
 */

import {
  contextGraphDataGraphUri,
  contextGraphMetaGraphUri,
  contextGraphVerifiableMemoryUri,
  contextGraphVerifiableMemoryMetaUri,
  computeACKDigest,
  createOperationContext,
  assertSafeIri,
  TrustLevel,
  isTrustLevelQuad,
} from '@origintrail-official/dkg-core';
import { loadSelectedVerifiableMemoryQuads, type Quad } from '@origintrail-official/dkg-storage';

import { VerifyCollector, buildVerificationMetadata, type PublishResult } from '@origintrail-official/dkg-publisher';
import { ethers } from 'ethers';

import { canonicalAgentDidSubject } from './profile.js';

// rc.9 PR-10: JoinApprovalRetryQueue removed — substrate outbox
// (durable, SQLite-backed) replaces it. We keep a minimal local
// type alias so listPendingJoinApprovalRetries() retains its old
// public shape while it stubs out to []. PR-12 rebuilds the operator
// diagnostic surface on top of the substrate outbox and will return
// real entries with substrate-shaped metadata.
type JoinApprovalRetryEntry = {
  contextGraphId: string;
  agentAddress: string;
  attempts: number;
  firstFailureAt: number;
  nextAttemptAt: number;
  lastError: string;
};

import { DKGAgentBase } from './dkg-agent-base.js';
import type { DKGAgent } from './dkg-agent.js';

export class EndorseVerifyMethods extends DKGAgentBase {
  /**
   * Endorse a published Knowledge Asset. Publishes a `dkg:endorses` triple
   * to the Context Graph's data graph. Endorsements ride regular PUBLISH
   * batches — no separate chain transaction required.
   */
  async endorse(this: DKGAgent, opts: {
    contextGraphId: string;
    knowledgeAssetUal: string;
    agentAddress?: string;
  }): Promise<PublishResult> {
    const { buildEndorsementQuads } = await import('./endorse.js');
    // A-12: spec §03 / §22 require the endorser DID to be the
    // Ethereum-address form. Passing a libp2p peer id here produced
    // a `did:dkg:agent:${peerId}` URI (12D3KooW-prefixed in practice),
    // which is non-spec. Prefer the per-call agentAddress, then the
    // node's default agent address, then fall back to the peer id
    // only if no EVM identity is known (kept for backward
    // compatibility with test harnesses; runtime always has a
    // defaultAgentAddress after auto-registration).
    //
    // A-12 review: normalise the address casing through
    // `canonicalAgentDidSubject` so the endorsement DID converges
    // with the profile DID for the same wallet (checksum vs
    // lowercase inputs previously produced two distinct RDF
    // subjects). Callers must also verify the address is owned by
    // this node before calling — /api/endorse does that via the
    // bearer token; see packages/cli/src/daemon.ts.
    const raw = opts.agentAddress ?? this.defaultAgentAddress ?? this.peerId;
    const endorser = canonicalAgentDidSubject(raw);
    const trustTargets = await this.resolveEndorsementTrustTargets(
      opts.contextGraphId,
      opts.knowledgeAssetUal,
    );
    const quads = buildEndorsementQuads(
      endorser,
      opts.knowledgeAssetUal,
      opts.contextGraphId,
    );
    const result = await this.publish(opts.contextGraphId, quads);
    if (result.status === 'confirmed') {
      const dataGraph = contextGraphDataGraphUri(opts.contextGraphId);
      await this.stampTrustLevel(
        dataGraph,
        await this.getSubjectsForRoots(dataGraph, trustTargets),
        TrustLevel.Endorsed,
      );
    }
    return result;
  }

  // ── VERIFY ────────────────────────────────────────────────────────

  /**
   * Propose verification for a published batch: collect M-of-N approvals,
   * anchor on-chain, and promote triples to Verifiable Memory.
   */
  async verify(this: DKGAgent, opts: {
    contextGraphId: string;
    verifiableMemoryId: string;
    batchId: bigint;
    requiredSignatures?: number;
    timeoutMs?: number;
  }): Promise<{
    txHash?: string;
    blockNumber?: number;
    verifiableMemoryId: string;
    signers: string[];
    status: 'verified' | 'partial' | 'no_quorum';
    trustLevel: TrustLevel;
  }> {
    const ctx = createOperationContext('verify');

    // 1. Look up batch merkle root from local metadata (use typed literal for batchId)
    const metaGraph = assertSafeIri(contextGraphMetaGraphUri(opts.contextGraphId));
    const dkgNamespaces = ['http://dkg.io/ontology/', 'https://dkg.network/ontology#'];
    // Try typed literal first, fallback to untyped for backward compat.
    let batchBindings: Record<string, string>[] | null = null;
    for (const ns of dkgNamespaces) {
      for (const literal of [`"${opts.batchId}"^^<http://www.w3.org/2001/XMLSchema#integer>`, `"${opts.batchId}"`]) {
        const r = await this.store.query(
          `SELECT ?root WHERE { GRAPH <${metaGraph}> { ?kc <${ns}merkleRoot> ?root . ?kc <${ns}batchId> ${literal} } } LIMIT 1`,
        );
        if (r.type === 'bindings' && r.bindings.length > 0) {
          batchBindings = r.bindings as Record<string, string>[];
          break;
        }
      }
      if (batchBindings) break;
    }
    if (!batchBindings) {
      throw new Error(`Batch ${opts.batchId} not found in context graph ${opts.contextGraphId}`);
    }
    const rootHex = batchBindings[0]['root'];
    const merkleRootValue = /^"([^"]+)"/.exec(rootHex)?.[1] ?? rootHex;
    const merkleRoot = ethers.getBytes(
      merkleRootValue.startsWith('0x') ? merkleRootValue : `0x${merkleRootValue}`,
    );

    // 2. Look up context graph on-chain config
    const onChainId = await this.getContextGraphOnChainId(opts.contextGraphId);
    const contextGraphIdOnChain = onChainId ? BigInt(onChainId) : null;
    if (!contextGraphIdOnChain) {
      throw new Error(`Context graph ${opts.contextGraphId} not found on-chain`);
    }

    // 3. Determine ACK quorum.
    // LU-2: per SPEC_CG_MEMORY_MODEL there is no per-CG `requiredSignatures`
    // — every CG uses the system parameter
    // `parametersStorage.minimumRequiredSignatures()`. An explicit caller
    // override (`opts.requiredSignatures`) wins for advisory/test paths
    // (e.g. `/api/verify?requiredSignatures=...`); otherwise we read the
    // system param off-chain via the adapter accessor.
    //
    // FAIL-CLOSED (Codex PR #595 round-3): `chain.verify()` only calls
    // `registerKnowledgeAsset()` — it does NOT submit the collected
    // signatures on-chain. This local quorum check is therefore the
    // *only* enforcement gate. If the chain adapter can't tell us the
    // system minimum (RPC outage, missing method, invalid value), we
    // must NOT silently downgrade to quorum=1 — that's fail-open. We
    // throw with an actionable error pointing the caller at the
    // explicit override knob instead.
    let requiredSignatures = opts.requiredSignatures ?? 0;
    if (requiredSignatures === 0) {
      if (typeof this.chain.getMinimumRequiredSignatures !== 'function') {
        throw new Error(
          'Cannot determine ACK quorum for verify: chain adapter does not implement `getMinimumRequiredSignatures()`. ' +
          'Pass `opts.requiredSignatures` explicitly (advisory paths only) or use a chain adapter that supports the system-parameter lookup.',
        );
      }
      let sysMin: number;
      try {
        sysMin = await this.chain.getMinimumRequiredSignatures();
      } catch (err: any) {
        throw new Error(
          `Cannot determine ACK quorum for verify: getMinimumRequiredSignatures() failed (${err?.message ?? err}). ` +
          `Pass opts.requiredSignatures explicitly or fix the chain adapter connection.`,
        );
      }
      if (!Number.isInteger(sysMin) || sysMin < 1) {
        throw new Error(
          `Cannot determine ACK quorum for verify: getMinimumRequiredSignatures() returned invalid value ${sysMin} (must be a positive integer). ` +
          `Pass opts.requiredSignatures explicitly or fix the chain adapter.`,
        );
      }
      requiredSignatures = sysMin;
    }

    // 4. Sign the verify digest as proposer
    const signerKey = this.config.ackSignerKey
      ?? (typeof this.chain.getACKSignerKey === 'function' ? this.chain.getACKSignerKey() : undefined)
      ?? this.config.chainConfig?.operationalKeys?.[0];
    if (!signerKey) throw new Error('No signer key available for verify');

    const digest = computeACKDigest(contextGraphIdOnChain, merkleRoot);
    const prefixedHash = ethers.hashMessage(digest);
    const signingKey = new ethers.SigningKey(signerKey);
    const proposerSig = signingKey.sign(prefixedHash);
    const proposerAddress = ethers.computeAddress(signingKey.publicKey);

    // 5. Collect M-of-N approvals
    // SPEC_CG_MEMORY_MODEL §4.3: sharding-table membership is the only
    // authoritative gate for who can ACK a VM publish. Adapters that
    // don't implement the membership probe are a misconfiguration here
    // (real EVM and the in-tree mock both implement it). Cache decisions
    // per batch to avoid hammering the RPC for repeated approvers.
    if (typeof this.chain.isShardingTableMember !== 'function') {
      throw new Error(
        'verify: chain adapter does not implement `isShardingTableMember()`. ' +
        'Cannot enforce SPEC_CG_MEMORY_MODEL §4.3 sharding-table ACK eligibility — refusing fail-open.',
      );
    }
    const shardingMembershipCache = new Map<string, boolean>();
    const probeShardingTableMembership = async (identityId: bigint): Promise<boolean> => {
      if (identityId <= 0n) return false;
      const key = identityId.toString();
      const cached = shardingMembershipCache.get(key);
      if (cached !== undefined) return cached;
      try {
        const ok = await this.chain.isShardingTableMember!(identityId);
        shardingMembershipCache.set(key, ok);
        return ok;
      } catch (err: any) {
        this.log.warn(
          ctx,
          `[verify] isShardingTableMember(${identityId}) probe failed (${err?.message ?? err}); ` +
          `dropping that signer's approval as fail-closed`,
        );
        shardingMembershipCache.set(key, false);
        return false;
      }
    };

    // Proposer eligibility computed BEFORE collect() so VerifyCollector
    // can require the full `requiredSignatures` remote ACKs (instead of
    // `requiredSignatures - 1`) when the proposer can't self-count.
    // Edge nodes have identityId=0 and aren't in the sharding table, so
    // they always need every ACK to come from a member peer.
    const proposerEligible =
      this.identityId > 0n && await probeShardingTableMembership(this.identityId);

    const collector = new VerifyCollector({
      // rc.9 PR-11: route through messenger.sendReliable so
      // /dkg/10.0.1/verify-proposal gets envelope wrap + sender-side
      // idempotency. App-level fan-out via VerifyCollector is
      // unchanged; queued is treated as a per-peer failure (caller
      // moves on to the next peer; substrate keeps the queued entry
      // in the outbox for diagnostics).
      sendP2P: async (peerId: string, protocol: string, data: Uint8Array) => {
        const sendResult = await this.messenger.sendReliable(peerId, protocol, data);
        if (!sendResult.delivered) {
          throw new Error(`substrate queued (transport): ${sendResult.error}`);
        }
        return sendResult.response;
      },
      // Codex PR #608: previously fanned out to ALL connected libp2p
      // peers, which broadcast `rootEntities` (subject URIs of the
      // batch) on EVERY verify proposal — a privacy regression for
      // invite-only CGs where those URIs are part of the curated
      // payload. The fix is two-tier:
      //   1. Curated CGs (peer-allowlist OR agent-gated): only fan out
      //      to peers in `cgMemberEnumerator.enumerate(cg).members`,
      //      which mirrors the same authority the SWM data-plane uses.
      //      For agent-gated CGs without a peer allowlist, that returns
      //      `{ source: 'none', members: [] }` (fail-closed) — verify
      //      then has no remote recipients and `allowPartial: true` lets
      //      the proposer collect its own self-attestation as the only
      //      vote, which is correct: only members can verify a curated
      //      batch's plaintext root anyway.
      //   2. Public CGs: fall back to the gossip-eligible member set
      //      (live topic subscribers), which still narrows the broadcast
      //      versus "every connected libp2p peer".
      // Downstream `probeShardingTableMembership` continues to filter
      // approvals by sharding-table membership before they count toward
      // quorum, so this only changes WHO RECEIVES the proposal, not
      // who can vote.
      getParticipantPeers: async (contextGraphId: string) => {
        try {
          const enumeration = await this.getOrCreateCGMemberEnumerator().enumerate(contextGraphId);
          return enumeration.members.filter((id) => id !== this.peerId);
        } catch (err) {
          // Degrade gracefully: if enumeration fails (e.g. SPARQL
          // backend hiccup) we don't want to silently broadcast to
          // every connected peer (the leak we just plugged). Log and
          // return empty so `allowPartial: true` lets the proposer
          // proceed with just its self-attestation rather than
          // leaking via a fail-open fallback.
          this.log.warn(
            ctx,
            `[verify] CG-member enumeration failed for ${contextGraphId} — broadcasting to no remote peers ` +
            `(prevents fail-open leak of rootEntities). Error: ${err instanceof Error ? err.message : String(err)}`,
          );
          return [];
        }
      },
      log: (msg: string) => this.log.info(ctx, msg),
    });

    const entities = await this.getRootEntities(opts.contextGraphId, opts.batchId);

    const result = await collector.collect({
      contextGraphId: opts.contextGraphId,
      contextGraphIdOnChain,
      verifiableMemoryId: (() => {
        try { return BigInt(opts.verifiableMemoryId); }
        catch { throw new Error(`verifiableMemoryId must be a numeric string, got: "${opts.verifiableMemoryId}"`); }
      })(),
      batchId: opts.batchId,
      merkleRoot,
      entities,
      proposerSignature: { r: ethers.getBytes(proposerSig.r), vs: ethers.getBytes(proposerSig.yParityAndS) },
      requiredSignatures,
      proposerCountsTowardQuorum: proposerEligible,
      timeoutMs: opts.timeoutMs ?? 30 * 60 * 1000, // 30 min default; VerifyCollector also enforces this as its max.
      allowPartial: true,
    });

    // 6. Resolve identity IDs for each approver before on-chain submission.
    const resolvedSignatures: Array<{ identityId: bigint; r: Uint8Array; vs: Uint8Array }> = [];
    const resolvedSignerAddresses: string[] = [];
    if (proposerEligible) {
      resolvedSignatures.push({
        identityId: this.identityId,
        r: ethers.getBytes(proposerSig.r),
        vs: ethers.getBytes(proposerSig.yParityAndS),
      });
      resolvedSignerAddresses.push(proposerAddress);
    }
    for (const a of result.approvals) {
      let id = a.identityId || await this.resolveVerifyApprovalIdentityId(a.approverAddress);
      if (!id || id === 0n) continue;
      if (!(await probeShardingTableMembership(id))) continue;
      resolvedSignatures.push({ identityId: id, r: a.signatureR, vs: a.signatureVS });
      resolvedSignerAddresses.push(a.approverAddress);
    }
    if (!result.quorumReached || resolvedSignatures.length < requiredSignatures) {
      // Trust degradation: any remote sharding-table-eligible ACK we
      // collected (i.e. any signer past the proposer slot) lifts the
      // batch to PartiallyVerified; otherwise it's self-attested.
      const remoteCount = resolvedSignatures.length - (proposerEligible ? 1 : 0);
      const trustLevel = remoteCount > 0
        ? TrustLevel.PartiallyVerified
        : TrustLevel.SelfAttested;
      const status = remoteCount > 0 ? 'partial' : 'no_quorum';
      await this.stampBatchTrustLevel(
        opts.contextGraphId,
        opts.batchId,
        contextGraphDataGraphUri(opts.contextGraphId),
        trustLevel,
      );
      this.log.info(
        ctx,
        `Verify batch ${opts.batchId} did not reach quorum ` +
          `(${resolvedSignatures.length}/${requiredSignatures} sharding-table-eligible signers, ` +
          `${remoteCount}/${result.requiredRemoteApprovals} remote approvals) — ` +
          `stamped trustLevel=${trustLevel} without chain tx`,
      );
      return {
        verifiableMemoryId: opts.verifiableMemoryId,
        signers: resolvedSignerAddresses,
        status,
        trustLevel,
      };
    }

    // 7. Submit on-chain only after quorum. Partial writes above are
    // metadata-only and deliberately do not claim a transaction hash.
    let txResult: { hash: string; blockNumber: number };
    const existingContextGraphId = typeof this.chain.getKAContextGraphId === 'function'
      ? await this.chain.getKAContextGraphId(opts.batchId).catch(() => 0n)
      : 0n;
    if (existingContextGraphId === contextGraphIdOnChain) {
      const provenance = await this.getBatchChainProvenance(opts.contextGraphId, opts.batchId);
      if (!provenance) {
        throw new Error(`Batch ${opts.batchId} is already registered on-chain but local chain provenance is missing`);
      }
      txResult = provenance;
      this.log.info(
        ctx,
        `Verify batch ${opts.batchId} already registered on-chain for context graph ${contextGraphIdOnChain}; ` +
          `using publish tx ${txResult.hash.slice(0, 16)}... for ConsensusVerified metadata`,
      );
    } else {
      if (typeof this.chain.verify !== 'function') {
        throw new Error('Chain adapter does not support verify');
      }
      txResult = await this.chain.verify({
        contextGraphId: contextGraphIdOnChain,
        batchId: opts.batchId,
        merkleRoot,
        signerSignatures: resolvedSignatures,
      });
    }

    // 8. Promote triples to Verifiable Memory (only include signers actually sent on-chain)
    await this.promoteToVerifiableMemory(
      opts.contextGraphId,
      opts.verifiableMemoryId,
      opts.batchId,
      txResult.hash,
      txResult.blockNumber,
      resolvedSignerAddresses,
    );

    this.log.info(ctx, `Verified batch ${opts.batchId} → _verifiable_memory/${opts.verifiableMemoryId} (tx=${txResult.hash.slice(0, 16)}...)`);

    return {
      txHash: txResult.hash,
      blockNumber: txResult.blockNumber,
      verifiableMemoryId: opts.verifiableMemoryId,
      signers: resolvedSignerAddresses,
      status: 'verified',
      trustLevel: TrustLevel.ConsensusVerified,
    };
  }

  async resolveVerifyApprovalIdentityId(this: DKGAgent, approverAddress: string): Promise<bigint> {
    // Post-SPEC_CG_MEMORY_MODEL: identity resolution is whatever the
    // chain adapter exposes via `getIdentityIdForAddress`. The legacy
    // candidate-set probe against per-CG `participantIdentityId`
    // triples was a pre-LU2 affordance and has been removed (Codex
    // PR #595 round-5: stop using legacy roster as a verify filter).
    // Modern responders that want to be counted MUST stamp their
    // identityId in the VerifyApproval payload.
    if (typeof (this.chain as any).getIdentityIdForAddress !== 'function') {
      return 0n;
    }
    try {
      const id = await (this.chain as any).getIdentityIdForAddress(approverAddress);
      return id ? BigInt(id) : 0n;
    } catch {
      return 0n;
    }
  }

  async promoteToVerifiableMemory(this: DKGAgent,
    contextGraphId: string,
    verifiableMemoryId: string,
    batchId: bigint,
    txHash: string,
    blockNumber: number,
    signers: string[],
  ): Promise<void> {
    // Query only the triples belonging to this batch via root entities in _meta
    const rootEntities = await this.getRootEntities(contextGraphId, batchId);
    if (rootEntities.length === 0) {
      this.log.warn(createOperationContext('verify'), `No root entities found for batch ${batchId} — skipping VM promotion`);
      return;
    }
    const dataGraph = assertSafeIri(contextGraphDataGraphUri(contextGraphId));
    // Query root entities AND their skolemized children (subjects starting
    // with the root entity URI, e.g. <root>/.well-known/genid/...).
    // The storage VM slice helper uses STRSTARTS to capture the full closure
    // instead of an exact VALUES match, which would miss child/blank-node
    // subjects.
    // A3 (O(store) relief): bind the per-KA VM graph set via the fast index
    // instead of an unbounded `GRAPH ?g` + STRSTARTS(?g,…) scan (?s is only
    // FILTER-narrowed, so the old form scanned every quad). Same target set as
    // the old filter (dataGraph + `${dataGraph}/_verifiable_memory/*`).
    const authoritativeQuads = await loadSelectedVerifiableMemoryQuads(this.store, dataGraph, rootEntities);

    const vmGraph = assertSafeIri(contextGraphVerifiableMemoryUri(contextGraphId, verifiableMemoryId));
    const vmQuads: Quad[] = authoritativeQuads
      .filter((quad) => !isTrustLevelQuad(quad))
      .map((quad) => ({
        subject: quad.subject,
        predicate: quad.predicate,
        object: quad.object,
        graph: vmGraph,
      }));
    if (vmQuads.length > 0) {
      await this.store.insert(vmQuads);
    }
    await this.stampTrustLevel(
      vmGraph,
      [...new Set(vmQuads.map((q) => q.subject))],
      TrustLevel.ConsensusVerified,
    );

    // Write verification metadata
    const vmMetaGraph = contextGraphVerifiableMemoryMetaUri(contextGraphId, verifiableMemoryId);
    const metaQuads = buildVerificationMetadata({
      contextGraphId,
      verifiableMemoryId,
      batchId,
      txHash,
      blockNumber,
      signers,
      verifiedAt: new Date(),
      graph: vmMetaGraph,
    });
    await this.store.insert(metaQuads);
  }

  async stampBatchTrustLevel(this: DKGAgent,
    contextGraphId: string,
    batchId: bigint,
    graph: string,
    level: TrustLevel,
  ): Promise<void> {
    const subjects = await this.getBatchSubjects(contextGraphId, batchId);
    await this.stampTrustLevel(graph, subjects, level);
  }

  async getBatchSubjects(this: DKGAgent, contextGraphId: string, batchId: bigint): Promise<string[]> {
    const rootEntities = await this.getRootEntities(contextGraphId, batchId);
    return this.getSubjectsForRoots(contextGraphDataGraphUri(contextGraphId), rootEntities);
  }

  async getRootEntities(this: DKGAgent, contextGraphId: string, batchId: bigint): Promise<string[]> {
    const metaGraph = assertSafeIri(contextGraphMetaGraphUri(contextGraphId));
    // Read-both note (RFC ka-metadata-trim P3.1): this UNION already covers
    // BOTH shapes — the first branch matches the collapsed UAL subject
    // (`rootEntity` + `batchId` on one node), the second the legacy
    // `<ual>/<n> partOf <ual>` token rows. No migration needed.
    // Try typed literal first, fallback to untyped for backward compat
    for (const ns of ['http://dkg.io/ontology/', 'https://dkg.network/ontology#']) {
      for (const literal of [`"${batchId}"^^<http://www.w3.org/2001/XMLSchema#integer>`, `"${batchId}"`]) {
        const result = await this.store.query(
          `SELECT ?entity WHERE {
            GRAPH <${metaGraph}> {
              {
                ?ka <${ns}rootEntity> ?entity .
                ?ka <${ns}batchId> ${literal} .
              }
              UNION
              {
                ?ka <${ns}rootEntity> ?entity ;
                    <${ns}partOf> ?kc .
                ?kc <${ns}batchId> ${literal} .
              }
            }
          }`,
        );
        if (result.type === 'bindings' && result.bindings.length > 0) {
          return (result.bindings as Record<string, string>[]).map(r => r['entity']).filter(Boolean);
        }
      }
    }
    return [];
  }

  async getBatchChainProvenance(this: DKGAgent,
    contextGraphId: string,
    batchId: bigint,
  ): Promise<{ hash: string; blockNumber: number } | null> {
    const metaGraph = assertSafeIri(contextGraphMetaGraphUri(contextGraphId));
    for (const ns of ['http://dkg.io/ontology/', 'https://dkg.network/ontology#']) {
      for (const literal of [`"${batchId}"^^<http://www.w3.org/2001/XMLSchema#integer>`, `"${batchId}"`]) {
        const result = await this.store.query(
          `SELECT ?tx ?block WHERE {
            GRAPH <${metaGraph}> {
              ?kc <${ns}batchId> ${literal} .
              ?kc <${ns}transactionHash> ?tx .
              OPTIONAL { ?kc <${ns}blockNumber> ?block }
            }
          } LIMIT 1`,
        );
        if (result.type !== 'bindings' || result.bindings.length === 0) continue;
        const row = result.bindings[0] as Record<string, string>;
        const hash = /^"([^"]+)"/.exec(row.tx ?? '')?.[1] ?? row.tx;
        if (!hash) continue;
        const rawBlock = /^"([^"]+)"/.exec(row.block ?? '')?.[1] ?? row.block;
        const blockNumber = rawBlock ? Number(rawBlock) : 0;
        return {
          hash,
          blockNumber: Number.isFinite(blockNumber) ? blockNumber : 0,
        };
      }
    }
    return null;
  }

  // ── CCL ──────────────────────────────────────────────────────────────

}
