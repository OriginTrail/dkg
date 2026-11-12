import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { canonical, closed, fail, hash, id, readOnlyDefinition, runInput } from './studio-mcp-contract.mjs';
import { nativeInputDigest } from './studio-native-execution.mjs';
import { createStudioCompiler } from './studio-definition.mjs';
import { n8nWorkflowSha256 } from '../../packages/cli/dist/semantic-runtime-n8n-contract.js';
import { createStudioNativeRunner } from './studio-native-runner.mjs';
import { assertDkgEnabled } from './dkg-components.mjs';

/** Small native admission journal, not a second receipt or workflow engine.
 * Arguments/results remain in n8n; only identity, pins and state live here.
 */
export function createStudioMcpService({ repository, provider, installation, accountId, compiler = createStudioCompiler(),
  runner = createStudioNativeRunner(provider, installation), dkg }) {
  const { profile } = compiler.registry;
  const journal = repository.mcp;
  const row = key => journal.run(accountId, key);
  const update = (key, status) => journal.updateRunStatus(accountId, key, status);
  function actorCheck(actor) {
    if (!actor || actor.accountId !== accountId || actor.role !== 'owner' || !id(actor.id)) throw fail('STUDIO_MCP_FORBIDDEN', 403);
  }
  function saved(ref) {
    if (typeof ref !== 'string' || ref.length > 256) throw fail('STUDIO_WORKFLOW_NOT_FOUND', 404);
    const stored = journal.savedNative(ref);
    if (!stored) throw fail('STUDIO_WORKFLOW_NOT_FOUND', 404);
    if (stored.kaRef !== ref || n8nWorkflowSha256(stored.published) !== stored.grant.workflowSha256) throw fail('STUDIO_NATIVE_PIN_CHANGED');
    return stored;
  }
  function describe(ref) {
    const workflow = saved(ref);
    const definition = readOnlyDefinition(workflow.definition, compiler);
    return { kaRef: ref, workflowSha256: workflow.grant.workflowSha256, definition,
      approved: !workflow.withdrawn, approvalKind: 'saved-workflow', effect: 'read', execution: 'native-n8n',
      ...(definition.nodes.some(n => n.componentId === 'dkg-read') ? {
        profileRevision: profile.revision, readGraphs: profile.workflowTools.readGraphs,
      } : {}) };
  }
  function list(actor) {
    actorCheck(actor);
    return journal.listSavedNative().flatMap(ref => {
      try { return [describe(ref)]; } catch { return []; }
    });
  }
  function get(value, actor) {
    actorCheck(actor);
    if (!closed(value, ['kaRef', 'workflowSha256']) || !hash(value.workflowSha256)) throw fail('STUDIO_INVALID_PIN', 400);
    const result = describe(value.kaRef);
    if (result.workflowSha256 !== value.workflowSha256) throw fail('STUDIO_NATIVE_PIN_CHANGED');
    return result;
  }
  const summary = r => ({ accountId: r.accountId, runKey: r.runKey, kaRef: r.kaRef,
    workflowSha256: r.workflowSha256, status: r.status, approvedBy: r.actor.id,
    ...Object.fromEntries(Object.entries(r.actor).filter(([key]) =>
      ['startedBy', 'agentVersion', 'toolDigest', 'approvalDecisionId'].includes(key))),
    ...(r.checkpoint.executionId ? { n8nExecutionId: r.checkpoint.executionId } : {}),
    createdAt: r.createdAt, updatedAt: r.updatedAt, actions: [] });
  function assertDisclosureAllowed(ref) {
    const workflow = saved(ref);
    if (workflow.withdrawn) throw fail('STUDIO_WORKFLOW_WITHDRAWN');
    const definition = readOnlyDefinition(workflow.definition, compiler);
    assertDkgEnabled(definition, profile);
    const readsDkg = definition.nodes.some(n => n.componentId === 'dkg-read');
    if (readsDkg && profile.accountId !== accountId) throw fail('STUDIO_READ_PROFILE_REQUIRED');
    return readsDkg;
  }
  async function readRun(value, actor) {
    actorCheck(actor);
    if (!closed(value, ['runKey']) || !id(value.runKey)) throw fail('STUDIO_INVALID_RUN', 400);
    let r = row(value.runKey);
    if (!r || actor.startedBy && canonical(r.actor) !== canonical(actor)) throw fail('STUDIO_RUN_NOT_FOUND', 404);
    if (!r.checkpoint.executionId) return summary(r);
    const workflow = saved(r.kaRef);
    let observed;
    try { observed = await runner.inspect(workflow, r.checkpoint); }
    catch { return summary(r); } // No expiry/timer can release a possibly running execution.
    if (['succeeded', 'failed'].includes(observed.status)) update(value.runKey, observed.status);
    r = row(value.runKey);
    // Terminal evidence releases capacity even after profile or account access
    // changes. Disclosure separately requires today's eligibility and authority.
    if (observed.status !== 'succeeded') return summary(r);
    try {
      if (assertDisclosureAllowed(r.kaRef)) {
        await profile.authorize({ ...actor, runKey: r.runKey });
        // Withdrawal/profile changes may occur during the remote authorization.
        assertDisclosureAllowed(r.kaRef);
      }
    } catch { return summary(r); }
    return { ...summary(r), output: observed.output, ...(observed.steps ? { steps: observed.steps } : {}) };
  }
  async function run(value, actor) {
    actorCheck(actor);
    const workflow = saved(value?.kaRef);
    if (workflow.withdrawn) throw fail('STUDIO_WORKFLOW_WITHDRAWN');
    readOnlyDefinition(workflow.definition, compiler);
    const input = runInput(value, workflow, compiler);
    const requestHash = createHash('sha256').update(canonical({ value: input.argumentsJson === undefined ? value : { ...value, arguments: JSON.parse(input.argumentsJson) }, actor })).digest('hex');
    if (journal.matchingRun(accountId, value.runKey, requestHash)) return readRun({ runKey: value.runKey }, actor);
    const prior = journal.activeAgentRun(accountId);
    if (actor.startedBy && prior) await readRun({ runKey: prior.runKey }, { id: actor.id, accountId, role: 'owner' });
    if (!journal.reserveRun({ accountId, runKey: value.runKey, requestHash, inputDigest: nativeInputDigest(input),
      kaRef: workflow.kaRef, workflowSha256: workflow.grant.workflowSha256, actor })) return readRun({ runKey: value.runKey }, actor);
    let dispatched = false;
    try {
      const version = await runner.prepare(workflow);
      if (saved(workflow.kaRef).withdrawn) throw fail('STUDIO_WORKFLOW_WITHDRAWN');
      if (workflow.definition.nodes.some(n => n.componentId === 'dkg-read')) {
        if (profile.accountId !== accountId) throw fail('STUDIO_READ_PROFILE_REQUIRED');
        dkg.grant(workflow, { invocationId: value.runKey, revisionDigest: workflow.grant.workflowSha256 }, input,
          { ...actor, runKey: value.runKey });
      }
      // Persist uncertainty BEFORE the POST. Crash/lost acknowledgement never retries it.
      journal.prepareDispatch(accountId, value.runKey, version); dispatched = true;
      const executionId = await runner.dispatch(workflow, value.runKey, input);
      journal.acknowledgeRun(accountId, value.runKey, executionId);
    } catch {
      if (!dispatched) update(value.runKey, 'failed');
    }
    return readRun({ runKey: value.runKey }, actor);
  }
  function withdraw(value, actor) {
    actorCheck(actor);
    if (actor.startedBy) throw fail('STUDIO_MCP_FORBIDDEN', 403);
    // Revocation uses the stored identity/pin, independently of today's profile
    // eligibility. A changed or disabled profile must never prevent withdrawal.
    if (!closed(value, ['kaRef', 'workflowSha256']) || !hash(value.workflowSha256)) throw fail('STUDIO_INVALID_PIN', 400);
    if (saved(value.kaRef).grant.workflowSha256 !== value.workflowSha256) throw fail('STUDIO_NATIVE_PIN_CHANGED');
    journal.withdrawNative(value.kaRef);
    return { ...value, approved: false };
  }
  async function dkgComponent(value) {
    let r = row(value?.effectId);
    if (!r) return undefined; // Not a native MCP run: existing manual service handles it.
    // Respond to Webhook precedes DKG Read. Its acknowledgement can race the
    // callback, so briefly wait for the dispatcher to persist that exact ID.
    // Missing/lost acknowledgements stay unconfirmed; no callback can adopt an ID.
    for (let i = 0; !r.checkpoint.executionId && r.status === 'unconfirmed' && i < 40; i++) {
      await delay(50);
      r = row(value.effectId);
    }
    const workflow = saved(r.kaRef);
    readOnlyDefinition(workflow.definition, compiler);
    if (!id(value.effectId) || !['running', 'unconfirmed'].includes(r.status) || workflow.withdrawn
      || value.workflowId !== workflow.grant.workflowId || !/^\d{1,20}$/.test(value.executionId ?? '')
      || r.checkpoint.executionId !== value.executionId) throw fail('STUDIO_NATIVE_UNCONFIRMED');
    const received = await runner.verifyCallback(workflow, r.checkpoint);
    if (saved(r.kaRef).withdrawn) throw fail('STUDIO_WORKFLOW_WITHDRAWN');
    const assertCurrent = () => {
      if (saved(r.kaRef).withdrawn) throw fail('STUDIO_WORKFLOW_WITHDRAWN');
      if (!['running', 'unconfirmed'].includes(row(r.runKey).status)) throw fail('STUDIO_NATIVE_UNCONFIRMED');
    };
    return dkg.call(value, workflow, { invocationId: r.runKey, revisionDigest: workflow.grant.workflowSha256,
      authorize: () => assertCurrent }, value.workflowId, received);
  }
  return { list, get, run, readRun, withdraw, dkgComponent };
}
