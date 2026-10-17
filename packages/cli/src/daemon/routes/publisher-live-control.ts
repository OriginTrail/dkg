import type { RequestContext } from './context.js';
import { jsonResponse, readBody, SMALL_BODY_BYTES } from '../http-utils.js';
import { requireNodeAdmin } from '../node-admin-guard.js';

/** Admission's publisher is deliberately separate; maintenance controls the live runtime. */
export async function handlePublisherLiveControlRoute(ctx: RequestContext): Promise<boolean> {
  const { req, res, path } = ctx;
  const action = req.method === 'GET' && path === '/api/publisher/control' ? 'status'
    : req.method === 'POST' && path === '/api/publisher/pause' ? 'pause'
    : req.method === 'POST' && path === '/api/publisher/resume' ? 'resume' : null;
  if (!action) return false;
  if (!requireNodeAdmin(ctx.authentication, res, `${req.method} ${path}`, 'control the node publisher')) return true;
  if (action !== 'status') {
    const body = await readBody(req, SMALL_BODY_BYTES);
    try {
      const parsed: unknown = JSON.parse(body || '{}');
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).length) throw new Error();
    } catch {
      jsonResponse(res, 400, { error: 'Publisher control expects an empty JSON object.' });
      return true;
    }
  }
  const runtime = ctx.publisherState.runtime;
  if (!runtime) {
    jsonResponse(res, 503, { error: 'Publisher live runtime is unavailable.', code: 'PUBLISHER_RUNTIME_UNAVAILABLE' });
    return true;
  }
  const control = runtime.control;
  try {
    const status = action === 'status' ? control.status() : await control[action]();
    jsonResponse(res, status.effectiveState === 'unavailable' ? 503 : 200, status);
  } catch {
    jsonResponse(res, 503, { error: 'Publisher control could not commit; inspect the runtime and restart to reload durable intent.',
      code: 'PUBLISHER_CONTROL_UNAVAILABLE' });
  }
  return true;
}
