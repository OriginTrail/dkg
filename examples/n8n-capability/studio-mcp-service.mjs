import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { canonical, closed, fail, hash, id, nativeInputDigest, readOnlyDefinition, runInput } from './studio-mcp-contract.mjs';
import { configuredDkgProfile } from './dkg-profile.mjs';
import { n8nWorkflowSha256, n8nPinnedExecutionMatches } from '../../packages/cli/dist/semantic-runtime-n8n-contract.js';
import { createStudioNativeRunner } from './studio-native-runner.mjs';
import { recordedNativeExecutionInput } from './studio-native-execution.mjs';

/** Small native admission journal, not a second receipt or workflow engine.
 * Arguments/results remain in n8n; only identity, pins and state live here.
 */
export function createStudioMcpService({ repository, provider, installation, accountId, profile = configuredDkgProfile,
  runner = createStudioNativeRunner(provider, installation), dkg }) {
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
    const definition = readOnlyDefinition(workflow.definition, profile);
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
  const summary = r => ({ accountId: r.account_id, runKey: r.run_key, kaRef: r.ka_ref,
    workflowSha256: r.workflow_sha256, status: r.status, approvedBy: r.actor.id,
    ...Object.fromEntries(Object.entries(r.actor).filter(([key]) =>
      ['startedBy', 'agentVersion', 'toolDigest', 'approvalDecisionId'].includes(key))),
    ...(r.execution_id ? { n8nExecutionId: r.execution_id } : {}),
    createdAt: r.created_at, updatedAt: r.updated_at, actions: [] });
  async function readRun(value, actor) {
    actorCheck(actor);
    if (!closed(value, ['runKey']) || !id(value.runKey)) throw fail('STUDIO_INVALID_RUN', 400);
    let r = row(value.runKey);
    if (!r || actor.startedBy && canonical(r.actor) !== canonical(actor)) throw fail('STUDIO_RUN_NOT_FOUND', 404);
    if (!r.execution_id) return summary(r);
    const workflow = saved(r.ka_ref);
    let observed;
    try { observed = await runner.inspect(workflow, r, value.runKey); }
    catch { return summary(r); } // No expiry/timer can release a possibly running execution.
    if (['succeeded', 'failed'].includes(observed.status)) update(value.runKey, observed.status);
    r = row(value.runKey);
    return { ...summary(r), ...(!workflow.withdrawn && observed.status === 'succeeded' ? { output: observed.output, ...(observed.steps ? { steps: observed.steps } : {}) } : {}) };
  }
  async function run(value, actor) {
    actorCheck(actor);
    const workflow = saved(value?.kaRef);
    if (workflow.withdrawn) throw fail('STUDIO_WORKFLOW_WITHDRAWN');
    readOnlyDefinition(workflow.definition, profile);
    const input = runInput(value, workflow, profile);
    const requestHash = createHash('sha256').update(canonical({ value, actor })).digest('hex');
    if (journal.matchingRun(accountId, value.runKey, requestHash)) return readRun({ runKey: value.runKey }, actor);
    const prior = journal.activeAgentRun(accountId);
    if (actor.startedBy && prior) await readRun({ runKey: prior.run_key }, { id: actor.id, accountId, role: 'owner' });
    if (!journal.reserveRun({ accountId, runKey: value.runKey, requestHash, inputSha256: nativeInputDigest(input),
      kaRef: workflow.kaRef, workflowSha256: workflow.grant.workflowSha256, actor })) return readRun({ runKey: value.runKey }, actor);
    let dispatched = false;
    try {
      const version = await runner.prepare(workflow);
      if (saved(workflow.kaRef).withdrawn) throw fail('STUDIO_WORKFLOW_WITHDRAWN');
      if (workflow.definition.nodes.some(n => n.componentId === 'dkg-read')) {
        if (profile.accountId !== accountId) throw fail('STUDIO_READ_PROFILE_REQUIRED');
        // Legacy column name source_hash holds the execution pin on this native
        // path; no Program/sourceHash is exposed or invented in the MCP contract.
        dkg.grant({ ...workflow, sourceHash: workflow.grant.workflowSha256 }, value.runKey, input,
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
    for (let i = 0; !r.execution_id && r.status === 'unconfirmed' && i < 40; i++) {
      await delay(50);
      r = row(value.effectId);
    }
    const workflow = saved(r.ka_ref);
    readOnlyDefinition(workflow.definition, profile);
    if (!['running', 'unconfirmed'].includes(r.status) || workflow.withdrawn
      || value.workflowId !== workflow.grant.workflowId || !/^\d{1,20}$/.test(value.executionId ?? '')
      || r.execution_id !== value.executionId) throw fail('STUDIO_NATIVE_UNCONFIRMED');
    const execution = await provider.api('/executions/' + value.executionId + '?includeData=true');
    let received;
    try { received = recordedNativeExecutionInput(execution); }
    catch { throw fail('STUDIO_NATIVE_UNCONFIRMED'); }
    // The running execution's pending stack or saved run data must prove the
    // exact granted input, in addition to the durable POST acknowledgement.
    if (String(execution.id) !== value.executionId || received.invocationId !== r.run_key
      || !n8nPinnedExecutionMatches({ ...workflow.published, versionId: r.version_id }, execution, workflow.grant, r.version_id))
      throw fail('STUDIO_NATIVE_UNCONFIRMED');
    if (saved(r.ka_ref).withdrawn) throw fail('STUDIO_WORKFLOW_WITHDRAWN');
    return dkg.call(value, { ...workflow, nativeMcp: true, sourceHash: workflow.grant.workflowSha256 }, value.workflowId, received);
  }
  return { list, get, run, readRun, withdraw, dkgComponent };
}
