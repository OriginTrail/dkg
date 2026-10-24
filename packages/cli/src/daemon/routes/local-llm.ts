import { PayloadTooLargeError, validateContextGraphId } from '@origintrail-official/dkg-core';
import type { RequestContext } from './context.js';
import { jsonResponse, readBody } from '../http-utils.js';
import {
  DaemonLocalLlmError,
  DKG_LOCAL_LLM_UI_SESSION_ID,
} from '../local-llm-service.js';
import { createStoreQueryRequestLifecycle } from '../store-query-lifecycle.js';
import { canAdministerNode } from '../../auth.js';

export const LOCAL_LLM_CHAT_BODY_BYTES = 64 * 1024;
export const LOCAL_LLM_MAX_MESSAGE_CHARS = 16_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function serviceErrorResponse(
  res: RequestContext['res'],
  error: unknown,
): void {
  if (error instanceof DaemonLocalLlmError) {
    jsonResponse(res, error.status, { error: error.message, code: error.code });
    return;
  }
  jsonResponse(res, 500, {
    error: error instanceof Error ? error.message : String(error),
    code: 'LOCAL_LLM_RUNTIME_ERROR',
  });
}

function isNodeAdminCaller(ctx: RequestContext): boolean {
  return canAdministerNode(ctx.authentication);
}

async function readJsonObject(ctx: RequestContext): Promise<Record<string, unknown> | null> {
  let raw: string;
  try {
    raw = await readBody(ctx.req, LOCAL_LLM_CHAT_BODY_BYTES);
  } catch (error) {
    if (error instanceof PayloadTooLargeError) throw error;
    jsonResponse(ctx.res, 400, { error: 'Invalid request body', code: 'LOCAL_LLM_INVALID_REQUEST' });
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw || '{}');
  } catch {
    jsonResponse(ctx.res, 400, { error: 'Invalid JSON body', code: 'LOCAL_LLM_INVALID_REQUEST' });
    return null;
  }
  if (!isRecord(parsed)) {
    jsonResponse(ctx.res, 400, {
      error: 'Request body must be a JSON object',
      code: 'LOCAL_LLM_INVALID_REQUEST',
    });
    return null;
  }
  return parsed;
}

export async function handleLocalLlmRoutes(ctx: RequestContext): Promise<void> {
  const { req, res, path, localLlm } = ctx;
  if (!path.startsWith('/api/local-llm/')) return;

  if (!isNodeAdminCaller(ctx)) {
    return jsonResponse(res, 403, {
      error:
        'The daemon-owned local LLM requires a node-level admin token; '
        + 'agent-scoped tokens cannot access or clear its shared operator session.',
      code: 'LOCAL_LLM_FORBIDDEN',
    });
  }

  if (!localLlm) {
    return jsonResponse(res, 503, {
      error: 'The daemon local LLM service is unavailable.',
      code: 'LOCAL_LLM_OFFLINE',
    });
  }

  if (req.method === 'GET' && path === '/api/local-llm/health') {
    return jsonResponse(res, 200, await localLlm.health());
  }

  if (req.method === 'POST' && path === '/api/local-llm/chat') {
    const body = await readJsonObject(ctx);
    if (!body) return;
    const allowedKeys = new Set(['message', 'sessionId', 'contextGraphId']);
    const unexpected = Object.keys(body).filter((key) => !allowedKeys.has(key));
    if (unexpected.length) {
      return jsonResponse(res, 400, {
        error: `Unsupported local LLM request field(s): ${unexpected.join(', ')}`,
        code: 'LOCAL_LLM_INVALID_REQUEST',
      });
    }
    if (typeof body.message !== 'string' || !body.message.trim()) {
      return jsonResponse(res, 400, {
        error: 'A non-empty "message" string is required.',
        code: 'LOCAL_LLM_INVALID_REQUEST',
      });
    }
    if (body.message.length > LOCAL_LLM_MAX_MESSAGE_CHARS) {
      return jsonResponse(res, 400, {
        error: `"message" exceeds ${LOCAL_LLM_MAX_MESSAGE_CHARS} characters.`,
        code: 'LOCAL_LLM_INVALID_REQUEST',
      });
    }
    if (
      body.sessionId !== undefined
      && body.sessionId !== DKG_LOCAL_LLM_UI_SESSION_ID
    ) {
      return jsonResponse(res, 400, {
        error: `"sessionId" must be "${DKG_LOCAL_LLM_UI_SESSION_ID}".`,
        code: 'LOCAL_LLM_INVALID_REQUEST',
      });
    }
    if (body.contextGraphId !== undefined) {
      const validation = validateContextGraphId(body.contextGraphId);
      if (!validation.valid) {
        return jsonResponse(res, 400, {
          error: `Invalid "contextGraphId": ${validation.reason}`,
          code: 'LOCAL_LLM_INVALID_REQUEST',
        });
      }
    }
    const requestLifecycle = createStoreQueryRequestLifecycle(
      req,
      res,
      'local-llm-chat',
    );
    try {
      const result = await localLlm.chat({
        message: body.message,
        ...(typeof body.contextGraphId === 'string' ? { contextGraphId: body.contextGraphId } : {}),
        signal: requestLifecycle.signal,
      });
      return jsonResponse(res, 200, result);
    } catch (error) {
      if (requestLifecycle.signal.aborted || res.destroyed) return;
      return serviceErrorResponse(res, error);
    } finally {
      requestLifecycle.dispose();
    }
  }

  if (req.method === 'POST' && path === '/api/local-llm/session/clear') {
    const body = await readJsonObject(ctx);
    if (!body) return;
    if (Object.keys(body).length) {
      return jsonResponse(res, 400, {
        error: 'The clear-session request body must be empty.',
        code: 'LOCAL_LLM_INVALID_REQUEST',
      });
    }
    try {
      return jsonResponse(res, 200, await localLlm.clear());
    } catch (error) {
      return serviceErrorResponse(res, error);
    }
  }
}
