import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { workflowUuid } from './workflow-definition.mjs';

const reject = message => Object.assign(new Error(message), { code: 'INVALID_WORKFLOW', status: 400 });
const eventUuid = (ref, id) => { const b = createHash('sha256').update(ref + ':' + id).digest(); b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
  const h = b.toString('hex'); return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20,32)}`; };

export function eventHistorySnapshot(repository, ref, enabled = true) {
  const a = repository.activation(ref);
  return { activation: { active: enabled && !!a.active && a.expiresAt > Date.now() && a.count < 5,
    count: a.count ?? 0, expiresAt: a.expiresAt }, executions: repository.eventHistory(ref) };
}

/** Own delegated authority, durable deliveries and provider publication ordering.
 * Lookup supplies a saved revision; execute receives synchronous dispatch fences.
 */
export function createStudioEventController({ repository, provider, lookup, execute,
  listCapabilities, validateStudioCapabilities, exportTokenFile }) {
  const activation = repository.activation;
  const fingerprint = path => createHash('sha256').update(readFileSync(path, 'utf8').trim()).digest('hex');
  let polling = false, stopped = false;
  function prepareExecution({ compiled, workflow, descriptor }) {
    if (compiled.mode !== 'schedule') return { descriptor };
    if (!activation(workflow.kaRef).active) throw reject('Activate this Schedule workflow before running it.');
    return { descriptor: { ...descriptor, mode: 'action' },
      beforeDispatch: requiresExport => eventAuthorized(workflow.kaRef, requiresExport) };
  }
  function eventAuthorized(ref, requiresExportAuthorization, expectedRevision) {
    const row = repository.row(ref), active = row?.activation_json ? JSON.parse(row.activation_json) : { active: false };
    if (expectedRevision !== undefined && row?.activation_revision !== expectedRevision) throw reject('The event activation changed.');
    if (!active.active || active.expiresAt < Date.now()) throw reject('This event workflow is inactive.');
    if (requiresExportAuthorization && (!exportTokenFile || active.exportFingerprint !== fingerprint(exportTokenFile))) throw reject('The operator export authorization changed.');
  }
  async function deliverEvent({ compiled, workflow, activationRevision, providerId, executionId, invocationId, itemsJson, requiresExportAuthorization }) {
    const authorizeEvent = (needsExport = false) => eventAuthorized(workflow.kaRef, requiresExportAuthorization || needsExport, activationRevision);
    const reserved = repository.reserveEvent({ kaRef: workflow.kaRef, providerId, executionId, invocationId,
      ...(compiled.mode === 'webhook' ? { inputJson: itemsJson } : {}) }, authorizeEvent);
    if (reserved.receipt) return reserved.receipt;
    const receipt = await execute({ kaRef: workflow.kaRef, sourceHash: workflow.sourceHash, itemsJson, invocationId: reserved.invocationId },
      { authorizeExport: () => authorizeEvent(true), beforeDispatch: authorizeEvent, prepareExecution });
    return repository.completeEvent(reserved, receipt);
  }
  // Order provider changes without delaying the synchronous local revocation.
  const publications = new Map();
  async function setPublished(ref, active, expectedRevision) {
    const previous = publications.get(ref);
    const pending = (async () => {
      await previous?.catch(() => {});
      if (active) {
        const row = repository.row(ref), current = activation(ref);
        if (row?.activation_revision !== expectedRevision || !current.active || current.expiresAt < Date.now())
          throw reject('This event activation changed.');
      }
      await provider.setPublished(ref, active);
    })();
    publications.set(ref, pending);
    try { await pending; } finally { if (publications.get(ref) === pending) publications.delete(ref); }
  }
  async function reconcileUnpublication(ref) {
    const pending = repository.row(ref)?.unpublish_pending;
    if (!pending) return;
    await setPublished(ref, false);
    repository.completeUnpublication(ref, pending);
  }
  async function deactivate(ref, activationId, mode, expectedRevision) {
    if (!repository.deactivate(ref, activationId, mode === 'schedule', expectedRevision)) return;
    await reconcileUnpublication(ref);
  }
  async function activate(value, authorize) {
    if (!value || Object.keys(value).some(k => !['kaRef', 'sourceHash', 'active', 'activationId'].includes(k)) || typeof value.active !== 'boolean') throw reject('Choose an activation state.');
    const activationId = workflowUuid(value.activationId);
    const revision = typeof value.kaRef === 'string' ? repository.row(value.kaRef)?.activation_revision : undefined;
    const { compiled, workflow } = await lookup(value.kaRef, value.sourceHash);
    if (!['schedule', 'webhook'].includes(compiled.mode)) throw reject('Start with a Webhook or Schedule Trigger to activate events.');
    if (activation(value.kaRef).activationId === activationId) {
      const current = activation(value.kaRef);
      if (value.active && current.active && current.expiresAt > Date.now() && compiled.mode === 'schedule')
        await setPublished(workflow.kaRef, true, repository.row(workflow.kaRef).activation_revision);
      if (!current.active) await reconcileUnpublication(workflow.kaRef);
      return (await lookup(value.kaRef)).workflow;
    }
    if (value.active) {
      await reconcileUnpublication(workflow.kaRef);
      if (!workflow.approved) throw reject('This graph is not approved.');
      const policy = validateStudioCapabilities(compiled.definition, await listCapabilities());
      const requiresExportAuthorization = workflow.requiresExportAuthorization || policy.requiresExportAuthorization;
      if (requiresExportAuthorization) authorize();
      const a = { active: true, activationId, startedAt: Date.now(), expiresAt: Date.now() + 30 * 60 * 1000, count: 0,
        ...(requiresExportAuthorization ? { exportFingerprint: fingerprint(exportTokenFile) } : {}) };
      repository.setActivation(workflow.kaRef, a, randomUUID(), revision);
      if (compiled.mode === 'schedule') await setPublished(workflow.kaRef, true, revision + 1);
    } else {
      await deactivate(workflow.kaRef, activationId, compiled.mode);
    }
    return (await lookup(workflow.kaRef)).workflow;
  }
  async function event(key, value) {
    if (!value || Object.keys(value).some(k => !['invocationId', 'items'].includes(k))) throw reject('Supply an event identity and items.');
    const row = repository.eventWorkflow(key);
    if (!row) throw reject('Inactive event endpoint.');
    const { compiled, workflow } = await lookup(row.ka_ref);
    if (compiled.mode !== 'webhook') throw reject('This endpoint is not a webhook.');
    if (!workflow.approved) throw reject('Event workflow approval changed.');
    const policy = validateStudioCapabilities(compiled.definition, await listCapabilities());
    const invocationId = workflowUuid(value.invocationId), itemsJson = JSON.stringify(value.items);
    return deliverEvent({ compiled, workflow, activationRevision: row.activation_revision, providerId: row.provider_id,
      executionId: invocationId, invocationId, itemsJson, requiresExportAuthorization: workflow.requiresExportAuthorization || policy.requiresExportAuthorization });
  }
  async function history(ref, mayDiscloseEvent) {
    const { compiled, workflow } = await lookup(ref);
    const row = repository.row(ref), a = activation(ref);
    let disclose = false;
    if (row.event_key && workflow.approved && a.active && a.expiresAt > Date.now() && mayDiscloseEvent) {
      const capabilities = await listCapabilities();
      try {
        const policy = validateStudioCapabilities(compiled.definition, capabilities);
        disclose = mayDiscloseEvent(workflow.requiresExportAuthorization || policy.requiresExportAuthorization) === true;
      } catch (error) { if (error.code !== 'WORKFLOW_CAPABILITY_CHANGED') throw error; }
    }
    return { ...eventHistorySnapshot(repository, ref),
      ...(disclose ? { eventPath: '/spike/ka/events/' + row.event_key } : {}) };
  }
  async function poll() {
    if (polling || stopped) return; polling = true;
    try {
      // Inactive workflows can still need provider cleanup. It does not require
      // current source/catalog availability and never restores local authority.
      for (const row of repository.pendingUnpublications()) {
        try { await reconcileUnpublication(row.ka_ref); } catch { /* Retain cleanup for the next poll/restart. */ }
      }
      for (const row of repository.activatedWorkflows()) {
        const a = activation(row.ka_ref); if (!a.active) continue;
        let compiled, workflow, capabilities, requiresExportAuthorization;
        try {
          ({ compiled, workflow } = await lookup(row.ka_ref));
          capabilities = await listCapabilities();
        } catch { continue; } // Unavailable inspection is not evidence of revoked authority.
        try {
          const policy = validateStudioCapabilities(compiled.definition, capabilities);
          requiresExportAuthorization = workflow.requiresExportAuthorization || policy.requiresExportAuthorization;
          eventAuthorized(row.ka_ref, requiresExportAuthorization, row.activation_revision);
          if (!workflow.approved) throw reject('Event workflow approval changed.');
        } catch (error) {
          if (['INVALID_WORKFLOW', 'WORKFLOW_CAPABILITY_CHANGED'].includes(error.code)) {
            try { await deactivate(row.ka_ref, randomUUID(), compiled.mode, row.activation_revision); } catch {}
          }
          continue;
        }
        if (compiled.mode !== 'schedule') continue;
        const pendingExecutionIds = repository.pendingEvents(row.ka_ref).map(event => event.executionId);
        for await (const { executionId, items } of provider.timerEvents({ grant: compiled.grant,
          startedAt: a.startedAt, pendingExecutionIds })) {
          try {
            await deliverEvent({ compiled, workflow, activationRevision: row.activation_revision, providerId: row.provider_id,
              executionId, invocationId: eventUuid(row.ka_ref, executionId), itemsJson: JSON.stringify(items), requiresExportAuthorization });
          } catch { /* Retain this exact invocation for the next reconciliation poll. */ }
        }
      }
    } catch { /* A bounded retry resumes the same journalled event identities. */ }
    finally { polling = false; }
  }
  const timer = setInterval(() => void poll(), 3000); timer.unref();
  return { prepareExecution, activate, event, history, poll, stop() { stopped = true; clearInterval(timer); } };
}
