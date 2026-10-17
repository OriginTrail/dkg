import { normalizeAssertionPromoteExecution } from './assertion-promote-input.js';
import { SwmCatalogAuthorityNotReady } from '../swm-inventory-write.js';
import { commitConfirmedDurableShareInventory } from './durable-vm-share-inventory.js';
import { createOperationContext } from '@origintrail-official/dkg-core';
import { createPromoteRetryableFailure } from '@origintrail-official/dkg-publisher';
import type { DKGAgent } from '../../dkg-agent.js';
import type { AssertionPromoteOptions } from '../../dkg-agent-types.js';
import { prepareAssertionPromote } from './assertion-promote-precommit.js';
import { SEAL_CAPABILITY_GAP_CODE } from '../../dkg-agent-publish.js';

function assertCompatibleAcknowledgement(required: boolean, requested?: boolean): void {
  if (requested === true && !required) {
    throw Object.assign(new Error('The existing immutable share operation did not require curator acknowledgement; an explicit stronger acknowledgement request cannot reuse that operation.'),
      { code: 'KA_PROMOTE_ACK_REQUIREMENT_CONFLICT' });
  }
}

async function prepareShareSeal(agent: DKGAgent, contextGraphId: string, name: string,
  promoteAgentAddress: string, opts?: AssertionPromoteOptions): Promise<void> {
  if (opts?.skipSeal) {
    throw Object.assign(
      new Error(
        'Graph-scoped Knowledge Assets must be finalized before sharing; unsealed SWM mutation is read-only legacy behavior.',
      ),
      { code: 'UNSEALED_SHARE_BLOCKED' },
    );
  }
  if (opts?.entities && opts.entities !== 'all') {
    throw Object.assign(
      new Error(
        'A graph-scoped Knowledge Asset is atomic. Create a new KA instead of sharing a subject subset.',
      ),
      { code: 'KA_ATOMIC_SHARE_REQUIRED' },
    );
  }
  try {
    await agent.prepareAtomicAssertionShare(contextGraphId, name, promoteAgentAddress, {
      subGraphName: opts?.subGraphName,
      authorAgentAddress: opts?.authorAgentAddress,
      preSignedAuthorAttestation: opts?.preSignedAuthorAttestation,
    });
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    const isCapabilityGap =
      err?.code === SEAL_CAPABILITY_GAP_CODE ||
      /requires a V10-capable chain adapter|has no private key on file|no publisher signer is available|failed to reconcile KA-number floor|no\s+kaNumberAllocator is configured/i.test(msg);
    if (!isCapabilityGap) {
      throw err;
    }
    throw Object.assign(
      new Error(
        `Cannot seal "${name}" for sharing to Shared Memory — the asset would be left ` +
          `unpublishable and Working Memory was NOT emptied. ${msg}`,
      ),
      {
        code: 'UNSEALED_SHARE_BLOCKED',
        recovery:
          'Resolve the signing capability (a local agent key + a V10 chain adapter), then retry.',
      },
    );
  }
}

export async function prepareDurableAssertionShare(agent: DKGAgent, contextGraphId: string, name: string,
  agentAddress: string, opts?: AssertionPromoteOptions) {
  const storageLane = opts?.agentAddress ?? agentAddress;
  await prepareShareSeal(agent, contextGraphId, name, storageLane, opts);
  const { publisherOptions } = await prepareAssertionPromote(agent, {
    contextGraphId, publisherPeerId: agent.node.peerId.toString(), options: opts,
  });
  let inventoryRequired: boolean;
  try { inventoryRequired = agent.requiresRfc64ShareInventoryV1(contextGraphId, opts?.subGraphName); }
  catch (cause) { if (cause instanceof SwmCatalogAuthorityNotReady) throw createPromoteRetryableFailure(cause); throw cause; }
  const recoveryBinding = await agent.publisher.prepareAssertionPromoteRecovery(
    contextGraphId, name, storageLane, publisherOptions, inventoryRequired);
  if ('completedResult' in recoveryBinding) {
    return { agentAddress: storageLane, recoveryBinding: undefined,
      completedResult: { promotedCount: 0, sealed: true, publishReady: false,
        ...(recoveryBinding.completedResult.shareOperationId ? { shareOperationId: recoveryBinding.completedResult.shareOperationId } : {}) } };
  }
  assertCompatibleAcknowledgement(recoveryBinding.intent.confirmationRequired,
    opts?.awaitCuratorAck === true && publisherOptions.confirmBeforeCommit !== undefined);
  return { agentAddress: storageLane, recoveryBinding, completedResult: undefined };
}

export async function promoteAssertion(agent: DKGAgent, contextGraphId: string, name: string,
  agentAddress: string, opts: AssertionPromoteOptions | undefined, warn: (message: string) => void) {
  const execution = normalizeAssertionPromoteExecution(opts), options = execution.options;
  const promoteAgentAddress = options.agentAddress ?? agentAddress;
  if (execution.kind === 'ordinary') await prepareShareSeal(agent, contextGraphId, name, promoteAgentAddress, options);
  const sealed = true;
  const { gossipSigner, publisherOptions } = await prepareAssertionPromote(agent, {
    contextGraphId,
    publisherPeerId: agent.node.peerId.toString(),
    options,
  });
  if (execution.kind === 'bound') {
    assertCompatibleAcknowledgement(execution.binding.intent.confirmationRequired,
      options.awaitCuratorAck === true && publisherOptions.confirmBeforeCommit !== undefined);
  }
  const {
    promotedCount,
    gossipPayload,
    promotedAllRoots,
    shareOperationId,
  } = await agent.publisher.assertionPromote(
    contextGraphId,
    name,
    promoteAgentAddress,
    { ...publisherOptions, recoveryBinding: execution.kind === 'bound' ? execution.binding : undefined,
      executionAuthority: execution.kind === 'bound' ? execution.authority : undefined },
  );
  const finish = async () => {
    if (gossipPayload) {
      try {
        // Preserve the immutable operation id through the fan-out seam.
        // Direct share() already does this; assertion promotion previously
        // dropped it, so receiver acknowledgements/watchdog retries could
        // not be correlated for imported (including Markdown) KAs.
        await agent.publishWorkspaceGossip(
          contextGraphId,
          gossipPayload,
          createOperationContext('share'),
          gossipSigner,
          shareOperationId,
          { subGraphName: options.subGraphName ?? null },
        );
      } catch (err: any) {
        warn(`Promote gossip failed (local SWM committed): ${err?.message ?? err}`);
      }
    }
    // OT-RFC-43 A2 (decision 2) — stamp dkg:swmCurrentAssertion on the
    // lifecycle URN so the SWM pointer is observable (and can diverge from
    // WM/VM). A VM no-op must not restamp a pointer or notify SWM observers.
    // The hook classifies its own pointer stamp (canonical durable-finalization
    // boundary): a failure never reports success, and a replay of this same
    // committed operation repairs it.
    if (promotedAllRoots) {
      await agent.afterDurableSwmPromotionV1({
        contextGraphId,
        subGraphName: options.subGraphName,
        assertionCoordinate: name,
        lifecycleAgentAddress: promoteAgentAddress,
        ctx: createOperationContext('share'),
        ...(execution.kind === 'bound' ? { recoveryBinding: execution.binding }
          : { shareOperationId: shareOperationId ?? null }),
      });
    }
    if (!promotedAllRoots && execution.kind === 'bound' && execution.binding.inventoryRequired) {
      await commitConfirmedDurableShareInventory(agent, {
        contextGraphId, subGraphName: options.subGraphName, assertionCoordinate: name,
        lifecycleAgentAddress: promoteAgentAddress,
        recoveryBinding: execution.binding, ctx: createOperationContext('share'),
      });
    }
  };
  if (execution.kind === 'bound' && execution.authority) await execution.authority.run(finish);
  else await finish();
  // #1116 (round 9) — the swmShareComplete marker mark/clear now lives INSIDE
  // assertionPromote (co-located with the member-row REPLACE, gated on the
  // same isFullCompletePromote), so it stays in lockstep with the rows for
  // EVERY caller of the public assertionPromote — not just this wrapper. The
  // `promotedAllRoots` result is still used below for `publishReady`.
  // A repaired/replayed share has promotedCount=0 but retains its durable
  // shareOperationId. It is just as publish-ready as the first response;
  // a VM no-op has no share operation id and remains false here.
  const publishReady = sealed && promotedAllRoots && !!shareOperationId;
  return { promotedCount, sealed, publishReady, ...(shareOperationId ? { shareOperationId } : {}) };
}

/** Agent bindings keep admission and mutation fencing in the publisher's lifecycle domain. */
export function durableAssertionShareMethods(agent: DKGAgent, agentAddress: string, warn: (message: string) => void) {
  return {
    async admitDurableShare(request: import('@origintrail-official/dkg-publisher').BoundPromoteRequest, workerId: string) {
      const queue = agent.promoteQueue;
      const admit = queue.enqueueAndClaim?.bind(queue);
      if (!admit) throw new Error('Durable share admission is unavailable');
      return agent.publisher.admitPreparedAssertionShare(request, () => admit(request, workerId));
    },
    prepareDurableShare: (contextGraphId: string, name: string, opts?: AssertionPromoteOptions) =>
      prepareDurableAssertionShare(agent, contextGraphId, name, agentAddress, opts),
    promote: (contextGraphId: string, name: string, opts?: AssertionPromoteOptions) =>
      promoteAssertion(agent, contextGraphId, name, agentAddress, opts, warn),
  };
}
