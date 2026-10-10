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

/**
 * GH#3081 — the queue hands its executor an observer for the steps after the confirmation. It
 * arrives on the execution input and belongs in the executor's own options, not in the publish
 * options the executor passes on to the publish or update call.
 */
describe('GH#3081 the queue\'s step observer through the publish handler', () => {
  function makeRecordingAgent(options: { registered: boolean }) {
    const executions: Array<{ publishOptions: unknown; executorOptions: unknown }> = [];
    const agent = {
      async publishQueuedKnowledgeAssetVmPublish(_request: unknown, publishOptions: unknown, executorOptions: unknown) {
        executions.push({ publishOptions, executorOptions });
        if (!options.registered && executions.length === 1) {
          throw Object.assign(new Error('context graph not registered on-chain'), { code: 'CG_NOT_REGISTERED' });
        }
        return { status: 'confirmed', ual: 'did:dkg:test/1/7', kaId: '7' };
      },
      async ensureRegisteredForPublish() {},
    } as any;
    return { agent, executions };
  }

  const request: any = { contextGraphId: CG, name: 'report', agentAddress: MEMBER };

  it('forwards it in the executor\'s options and leaves the publish options as they came', async () => {
    const { agent, executions } = makeRecordingAgent({ registered: true });
    const onPostConfirmationStep = () => {};
    const publishOptions = { contextGraphId: CG };

    await createKnowledgeAssetVmPublishHandler(agent).execute(
      { request, publishOptions, publisher: undefined, onPostConfirmationStep } as any,
    );

    expect(executions).toHaveLength(1);
    expect(executions[0]!.executorOptions).toEqual({ onPostConfirmationStep });
    expect(executions[0]!.publishOptions).toBe(publishOptions);
    expect(publishOptions).toEqual({ contextGraphId: CG });
  });

  it('forwards it again when the publish is repeated after a registration', async () => {
    const { agent, executions } = makeRecordingAgent({ registered: false });
    const onPostConfirmationStep = () => {};

    await createKnowledgeAssetVmPublishHandler(agent).execute(
      { request, publishOptions: {}, publisher: undefined, onPostConfirmationStep } as any,
    );

    expect(executions.map((execution) => execution.executorOptions)).toEqual([
      { onPostConfirmationStep },
      { onPostConfirmationStep },
    ]);
  });

  it('passes none when the queue gave none, next to the wallet\'s publisher', async () => {
    const { agent, executions } = makeRecordingAgent({ registered: true });
    const publisher: any = { name: 'wallet-publisher' };

    const handler = createKnowledgeAssetVmPublishHandler(agent);
    await handler.execute({ request, publishOptions: {}, publisher: undefined } as any);
    await handler.execute({ request, publishOptions: {}, publisher } as any);

    expect(executions.map((execution) => execution.executorOptions)).toEqual([
      {},
      { publisherOverride: publisher },
    ]);
  });
});
