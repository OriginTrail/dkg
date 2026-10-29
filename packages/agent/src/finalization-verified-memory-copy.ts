// SPDX-License-Identifier: Apache-2.0

import type { OperationContext } from '@origintrail-official/dkg-core';
import type { TripleStore } from '@origintrail-official/dkg-storage';
import { ethers } from 'ethers';
import { resolveConfirmedGraphScopedVm } from './confirmed-graph-scoped-vm-resolver.js';
import type { ParsedGraphScopedFinalization } from './finalization-graph-envelope.js';
import type { ExactVerifiedMemoryCopyQuery } from './finalization-recovery-verified-memory.js';

function optionalHex(value: Uint8Array | undefined): string | undefined {
  return value === undefined ? undefined : ethers.hexlify(value).toLowerCase();
}

/**
 * Whether Verified Memory holds the exact assertion a graph-scoped
 * finalization names: confirmed metadata for its version, batch and
 * namespace with the same envelope, and stored content that verifies against
 * `merkleRoot`. A copy recorded under another transaction is not that
 * assertion; a copy from the receiptless chain-reconcile lane records none.
 */
export async function holdsExactVerifiedMemoryCopy(
  store: TripleStore,
  query: ExactVerifiedMemoryCopyQuery,
): Promise<boolean> {
  const { candidate } = query;
  const subGraphName = candidate.msg.subGraphName || undefined;
  const resolution = await resolveConfirmedGraphScopedVm(store, {
    contextGraphId: query.contextGraphId,
    ual: candidate.scope.ual,
    assertionVersion: BigInt(candidate.assertionVersion),
    merkleRoot: query.merkleRoot,
    kaId: candidate.kaId,
    batchId: candidate.batchId,
    ...(subGraphName ? { subGraphName } : {}),
  });
  if (resolution.status !== 'verified') return false;
  const { envelope } = resolution;
  return (
    envelope.transactionHash === undefined
    || envelope.transactionHash.toLowerCase() === candidate.msg.txHash.toLowerCase()
  )
    && envelope.publicTripleCount === candidate.publicTripleCount
    && envelope.privateTripleCount === candidate.privateTripleCount
    && optionalHex(envelope.privateMerkleRoot) === optionalHex(candidate.privateMerkleRoot);
}

interface FinalizationHeadLog {
  info(ctx: OperationContext, message: string): void;
  warn(ctx: OperationContext, message: string): void;
}

/**
 * Report a graph-scoped finalization that found no matching SWM head. A node
 * whose Verified Memory already holds the exact assertion has missed nothing,
 * so that case is informational. Every other miss keeps the warning, and so
 * does one whose Verified Memory read fails: this report never changes how the
 * finalization itself is handled.
 */
export async function reportUnmatchedGraphScopedSwmHead(
  store: TripleStore,
  log: FinalizationHeadLog,
  ctx: OperationContext,
  contextGraphId: string,
  candidate: ParsedGraphScopedFinalization,
): Promise<void> {
  const { ual } = candidate.scope;
  let held = false;
  try {
    held = await holdsExactVerifiedMemoryCopy(store, {
      contextGraphId,
      candidate,
      merkleRoot: candidate.msg.kcMerkleRoot,
    });
  } catch {
    // The warning below still names the miss.
  }
  if (held) {
    log.info(ctx, `Finalization: ${ual} is already in Verified Memory; it needs no graph-scoped SWM head`);
    return;
  }
  log.warn(ctx, `Finalization: no matching graph-scoped SWM head for ${ual}`);
}
