import { describe, it, expect } from 'vitest';
import { createKnowledgeAssetVmPublishHandler } from '../src/daemon/lifecycle.js';

/**
 * GH#1778 — a curator async-publishes a member-authored KA. The queued intent's
 * `agentAddress` is the resolved AUTHOR (the member). CG auto-registration on
 * `CG_NOT_REGISTERED` must use the NODE's own operational identity, NOT the
 * request's author (a member) — and it must be independent of the request
 * identity so that different callers of the same deduped job cannot collapse
 * onto one caller's registration actor.
 */

const NODE = `0x${'11'.repeat(20)}`; // the node's own default identity
const MEMBER = `0x${'22'.repeat(20)}`; // resolved KA author (not the registrant)
const CG = 'construction';

function makeMockAgent(registrationCalls: Array<Record<string, unknown> | undefined>) {
  let attempts = 0;
  return {
    async publishQueuedKnowledgeAssetVmPublish() {
      attempts += 1;
      if (attempts === 1) {
        throw Object.assign(new Error('context graph not registered on-chain'), { code: 'CG_NOT_REGISTERED' });
      }
      return { status: 'confirmed', ual: 'did:dkg:test/1/7', kaId: '7' };
    },
    async ensureRegisteredForPublish(_cg: string, opts?: Record<string, unknown>) {
      registrationCalls.push(opts);
    },
    getDefaultAgentAddress() {
      return NODE;
    },
  } as any;
}

describe('GH#1778 async VM publish CG auto-registration', () => {
  it('registers under the node identity, not the resolved member author', async () => {
    const registrationCalls: Array<Record<string, unknown> | undefined> = [];
    const handler = createKnowledgeAssetVmPublishHandler(makeMockAgent(registrationCalls));

    // The intent's agentAddress is the resolved AUTHOR (member); registration
    // must not use it, and must not depend on any per-request caller identity.
    const request: any = { contextGraphId: CG, name: 'report', agentAddress: MEMBER };
    const result = await handler.execute({ request, publishOptions: {}, publisher: undefined } as any);

    expect(result.status).toBe('confirmed');
    expect(registrationCalls).toEqual([{ callerAgentAddress: NODE }]);
  });
});
