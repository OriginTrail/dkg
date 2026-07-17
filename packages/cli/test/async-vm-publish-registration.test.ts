import { describe, it, expect } from 'vitest';
import { createKnowledgeAssetVmPublishHandler } from '../src/daemon/lifecycle.js';

/**
 * GH#1778 — a curator async-publishes a member-authored KA. The queued intent's
 * `agentAddress` is the resolved AUTHOR (the member). CG auto-registration on
 * `CG_NOT_REGISTERED` must stamp the CG curator with the ENQUEUING CALLER
 * (`callerAgentAddress`, the operator who requested the publish) — matching the
 * synchronous `vm/publish` lane — NOT the resolved member author. When the
 * request carries no caller, registration passes no caller and the agent's
 * `stampAddressCurator` falls back to the node default (again, as sync does).
 */

const CALLER = `0x${'11'.repeat(20)}`; // operator / token holder that enqueued
const MEMBER = `0x${'22'.repeat(20)}`; // resolved KA author (must NOT be the registrant)
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
  } as any;
}

describe('GH#1778 async VM publish CG auto-registration', () => {
  it('registers under the enqueuing caller, not the resolved member author', async () => {
    const registrationCalls: Array<Record<string, unknown> | undefined> = [];
    const handler = createKnowledgeAssetVmPublishHandler(makeMockAgent(registrationCalls));

    const request: any = { contextGraphId: CG, name: 'report', agentAddress: MEMBER, callerAgentAddress: CALLER };
    const result = await handler.execute({ request, publishOptions: {}, publisher: undefined } as any);

    expect(result.status).toBe('confirmed');
    expect(registrationCalls).toEqual([{ callerAgentAddress: CALLER }]);
  });

  it('passes no caller when the request has none (defers to the node-default curator stamp)', async () => {
    const registrationCalls: Array<Record<string, unknown> | undefined> = [];
    const handler = createKnowledgeAssetVmPublishHandler(makeMockAgent(registrationCalls));

    // No callerAgentAddress (tokenless / pre-#1778 job). Registration must NOT
    // fall back to the resolved member author — it passes nothing, and the real
    // stampAddressCurator falls back to the node default (as the sync lane does).
    const request: any = { contextGraphId: CG, name: 'report', agentAddress: MEMBER };
    await handler.execute({ request, publishOptions: {}, publisher: undefined } as any);

    expect(registrationCalls).toEqual([{}]);
  });
});
