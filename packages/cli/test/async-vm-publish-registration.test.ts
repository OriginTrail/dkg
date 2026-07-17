import { describe, it, expect } from 'vitest';
import { createKnowledgeAssetVmPublishHandler } from '../src/daemon/lifecycle.js';

/**
 * GH#1778 — a curator async-publishes a member-authored KA. The queued intent's
 * `agentAddress` is the resolved AUTHOR (the member), but CG auto-registration on
 * `CG_NOT_REGISTERED` must use the CALLER (the operator/token holder) carried in
 * `callerAgentAddress`, not the author. Before the fix, registration used the
 * member author and could register under / authorize the wrong identity.
 */

const CURATOR = `0x${'11'.repeat(20)}`;
const MEMBER = `0x${'22'.repeat(20)}`;
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
      return CURATOR;
    },
  } as any;
}

describe('GH#1778 async VM publish CG auto-registration', () => {
  it('registers under the caller (curator), not the resolved member author', async () => {
    const registrationCalls: Array<Record<string, unknown> | undefined> = [];
    const handler = createKnowledgeAssetVmPublishHandler(makeMockAgent(registrationCalls));

    const request: any = {
      contextGraphId: CG,
      name: 'report',
      agentAddress: MEMBER, // resolved AUTHOR
      callerAgentAddress: CURATOR, // token/caller identity
    };
    const result = await handler.execute({ request, publishOptions: {}, publisher: undefined } as any);

    expect(result.status).toBe('confirmed');
    expect(registrationCalls).toHaveLength(1);
    expect(registrationCalls[0]).toEqual({ callerAgentAddress: CURATOR });
  });

  it('falls back to agentAddress for an older intent without callerAgentAddress', async () => {
    const registrationCalls: Array<Record<string, unknown> | undefined> = [];
    const handler = createKnowledgeAssetVmPublishHandler(makeMockAgent(registrationCalls));

    const request: any = { contextGraphId: CG, name: 'report', agentAddress: MEMBER };
    await handler.execute({ request, publishOptions: {}, publisher: undefined } as any);

    expect(registrationCalls[0]).toEqual({ callerAgentAddress: MEMBER });
  });
});
