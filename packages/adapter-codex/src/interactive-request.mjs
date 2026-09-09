import { HTTP_ERROR } from './http-error.mjs';

const APPROVAL_METHODS = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'applyPatchApproval',
  'execCommandApproval',
]);
const DECISION_LABELS = {
  accept: 'Allow once', acceptForSession: 'Allow for session', decline: 'Decline', cancel: 'Cancel',
  approved: 'Allow once', denied: 'Decline', abort: 'Cancel',
};

export function normalizeInteractiveRequest(request) {
  const params = request.params ?? {};
  const threadId = params.threadId ?? params.conversationId;
  const base = { id: request.id, threadId };
  if (request.method === 'item/tool/requestUserInput') {
    return { ...base, kind: 'questions', title: 'Codex needs your input', details: {
      questions: params.questions ?? [],
    } };
  }
  if (request.method === 'item/permissions/requestApproval') {
    return { ...base, kind: 'permissions', title: 'Approval required', details: {
      reason: params.reason, permissions: params.permissions,
    }, actions: decisionActions(['accept', 'decline']) };
  }
  if (request.method === 'mcpServer/elicitation/request') {
    return { ...base, kind: 'elicitation', title: 'Additional information requested', details: {
      message: params.message, url: params.url, schema: params.requestedSchema,
    }, actions: decisionActions(['accept', 'decline', 'cancel']) };
  }
  if (!APPROVAL_METHODS.has(request.method)) return null;
  const legacy = request.method === 'applyPatchApproval' || request.method === 'execCommandApproval';
  const advertised = params.availableDecisions;
  const decisions = legacy ? ['approved', 'denied', 'abort']
    : Array.isArray(advertised) ? advertised.filter((decision) => typeof decision === 'string')
      : ['accept', 'acceptForSession', 'decline', 'cancel'];
  return {
    ...base,
    kind: 'approval',
    title: params.networkApprovalContext ? 'Network access approval required' : 'Approval required',
    details: {
      reason: params.reason, command: params.command, cwd: params.cwd,
      network: params.networkApprovalContext,
      additionalPermissions: params.additionalPermissions,
      grantRoot: params.grantRoot,
    },
    actions: decisionActions(decisions),
  };
}

function decisionActions(decisions) {
  return decisions.map((decision) => ({ id: decision, label: DECISION_LABELS[decision] ?? decision }));
}

/** Validate one normalized UI response and map it back to Codex RPC. */
export function approvalResult(request, input) {
  const normalized = normalizeInteractiveRequest(request);
  if (!normalized) throw HTTP_ERROR(400, 'Unsupported interactive request.');
  if (normalized.kind === 'questions') {
    const answers = {};
    for (const question of normalized.details.questions) {
      const answer = input.answers?.[question.id];
      if (!Array.isArray(answer?.answers) || !answer.answers.length
          || answer.answers.some((value) => typeof value !== 'string' || !value.trim() || value.length > 20_000)) {
        throw HTTP_ERROR(400, 'Answer each question before continuing.');
      }
      answers[question.id] = { answers: answer.answers };
    }
    return { answers };
  }
  if (normalized.kind === 'permissions') {
    if (!normalized.actions.some(({ id }) => id === input.decision)) {
      throw HTTP_ERROR(400, 'Choose Allow or Decline.');
    }
    return {
      permissions: input.decision === 'accept' ? request.params.permissions : {},
      scope: 'turn',
    };
  }
  if (normalized.kind === 'elicitation') {
    if (!normalized.actions.some(({ id }) => id === input.action)) {
      throw HTTP_ERROR(400, 'Invalid response.');
    }
    return { action: input.action, content: input.content ?? null };
  }
  if (!normalized.actions.some(({ id }) => id === input.decision)) {
    throw HTTP_ERROR(400, 'Invalid approval decision.');
  }
  return { decision: input.decision };
}
