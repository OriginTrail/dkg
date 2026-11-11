import { join } from 'node:path';
import { dkgDir } from '../../config.js';
import { CPU_PROFILE_PATH, parseCpuProfileRequest } from '../../cpu-profile-wire.js';
import {
  CpuProfileBusyError,
  CpuProfileUnavailableError,
  daemonCpuProfiles,
  type CpuProfileRecorder,
} from '../cpu-profile.js';
import { jsonResponse, readBody, SMALL_BODY_BYTES } from '../http-utils.js';
import { requireNodeAdmin } from '../node-admin-guard.js';
import { actorFromRequestContext, type RequestContext } from './context.js';

/**
 * Node-admin diagnostics: record a CPU profile of the daemon's main thread
 * and write it into `<DKG home>/diagnostics`. The request is answered when
 * the file is written, at most 60 s of recording later.
 */
export async function handleCpuProfileRoutes(
  ctx: RequestContext,
  options: { recorder?: CpuProfileRecorder; directory?: string } = {},
): Promise<void> {
  const { req, res, path } = ctx;
  if (req.method !== 'POST' || path !== CPU_PROFILE_PATH) return;
  if (!requireNodeAdmin(actorFromRequestContext(ctx).authentication, res,
    `POST ${CPU_PROFILE_PATH}`, 'record a CPU profile of the node')) return;
  const request = parseCpuProfileRequest(await readBody(req, SMALL_BODY_BYTES));
  if ('error' in request) return jsonResponse(res, 400, { error: request.error });
  const recorder = options.recorder ?? daemonCpuProfiles;
  try {
    const result = await recorder.record({ ...request, directory: options.directory ?? join(dkgDir(), 'diagnostics') });
    jsonResponse(res, 200, result);
  } catch (error) {
    if (error instanceof CpuProfileBusyError) return jsonResponse(res, 409, { code: error.code, error: error.message });
    if (error instanceof CpuProfileUnavailableError) {
      if (error.cause !== undefined) console.error('[cpu-profile] no inspector session', error.cause);
      return jsonResponse(res, 503, { code: error.code, error: error.message });
    }
    // The daemon log keeps the cause; the answer stays short.
    console.error('[cpu-profile] recording failed', error);
    jsonResponse(res, 500, { code: 'CPU_PROFILE_FAILED', error: 'Recording or writing the CPU profile failed; see the node log.' });
  }
}
