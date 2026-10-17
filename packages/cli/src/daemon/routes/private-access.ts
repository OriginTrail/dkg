import { isAccessError, type AccessErrorCode } from '@origintrail-official/dkg-publisher';
import type { RequestContext } from './context.js';
import { requireNodeAdmin } from '../node-admin-guard.js';
import { jsonResponse, readBody, safeParseJson, sendSerializedJsonResponse, serializeJsonResponse, SMALL_BODY_BYTES } from '../http-utils.js';
import { createStoreQueryRequestLifecycle } from '../store-query-lifecycle.js';

const MAX_JSON_BYTES = 2 * 1024 * 1024;
const failures = {
  ACCESS_INVALID_REQUEST: { status: 400, error: 'A valid publisher peer ID and current KA UAL are required' },
  ACCESS_RESPONSE_TOO_LARGE: { status: 413, error: 'Private access response is too large' },
  ACCESS_BUSY: { status: 429, error: 'A private access request is already running' },
  ACCESS_INTEGRITY_FAILED: { status: 502, error: 'Private access payload failed its peer-root self-check' },
  ACCESS_TIMEOUT: { status: 504, error: 'Private access timed out' },
  ACCESS_UNAVAILABLE: { status: 503, error: 'Private access is unavailable' },
  ACCESS_REQUEST_OWNED_REQUIRED: { status: 503, error: 'Private access is unavailable' },
} satisfies Record<AccessErrorCode, { status: number; error: string }>;

/** Explicit operator read; returned content is never inserted into local graphs. */
export async function handlePrivateAccessRoutes(ctx: RequestContext): Promise<void> {
  const { req, res, path, authentication, agent } = ctx;
  if (req.method !== 'POST' || path !== '/api/access/request') return;
  if (!requireNodeAdmin(authentication, res, 'POST /api/access/request', 'request private content as the node')) return;
  const body = safeParseJson(await readBody(req, SMALL_BODY_BYTES), res);
  if (!body) return;
  if (typeof body.publisherPeerId !== 'string' || typeof body.kaUal !== 'string'
    || Object.keys(body).some(key => key !== 'publisherPeerId' && key !== 'kaUal')) {
    jsonResponse(res, 400, { code: 'ACCESS_INVALID_REQUEST', error: failures.ACCESS_INVALID_REQUEST.error });
    return;
  }
  const lifecycle = createStoreQueryRequestLifecycle(req, res, 'api.private-access');
  try {
    const result = await agent.requestPrivateAccess({ publisherPeerId: body.publisherPeerId, kaUal: body.kaUal }, {
      signal: lifecycle.signal,
    });
    if (lifecycle.signal.aborted) return;
    if (!result.granted) {
      jsonResponse(res, 403, { code: 'ACCESS_DENIED', error: 'Publisher denied private access' });
      return;
    }
    const serialized = serializeJsonResponse(200, result);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_JSON_BYTES) {
      jsonResponse(res, 413, { code: 'ACCESS_RESPONSE_TOO_LARGE', error: failures.ACCESS_RESPONSE_TOO_LARGE.error });
      return;
    }
    sendSerializedJsonResponse(res, 200, serialized);
  } catch (error) {
    if (lifecycle.signal.aborted) return;
    const code = isAccessError(error) ? error.code : 'ACCESS_UNAVAILABLE';
    // A transport capability mismatch remains the existing unavailable API response.
    const responseCode = code === 'ACCESS_REQUEST_OWNED_REQUIRED' ? 'ACCESS_UNAVAILABLE' : code;
    jsonResponse(res, failures[code].status, { code: responseCode, error: failures[code].error });
  } finally {
    lifecycle.dispose();
  }
}
