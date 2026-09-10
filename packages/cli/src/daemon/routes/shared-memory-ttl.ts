import { resolveSharedMemoryTtlMs } from '../../config.js';
import type { DkgConfigStore } from '../../daemon-config-store.js';
import { validateSharedMemoryTtlMs } from '@origintrail-official/dkg-agent';
import { isPayloadTooLargeError, jsonResponse, readBody, SMALL_BODY_BYTES } from '../http-utils.js';
import type { RequestContext } from './context.js';

type TtlSettingsContext = Pick<RequestContext, 'req' | 'res' | 'agent'> & {
  configStore: DkgConfigStore;
};

/** Shared handler for the V10 and legacy workspace TTL settings routes. */
export async function handleSharedMemoryTtlSettings({ req, res, configStore, agent }: TtlSettingsContext): Promise<void> {
  if (req.method === 'GET') {
    const ttlMs = resolveSharedMemoryTtlMs(configStore.current) ?? 30 * 24 * 60 * 60 * 1000;
    return jsonResponse(res, 200, { ttlMs, ttlDays: Math.round(ttlMs / (24 * 60 * 60 * 1000)) });
  }
  try {
    const bodyStr = await readBody(req, SMALL_BODY_BYTES);
    const { ttlDays } = JSON.parse(bodyStr ?? '{}') as { ttlDays?: number };
    if (typeof ttlDays !== 'number' || !Number.isFinite(ttlDays) || ttlDays < 0) {
      return jsonResponse(res, 400, { error: 'ttlDays must be a finite non-negative number' });
    }
    const ttlMs = Math.round(ttlDays * 24 * 60 * 60 * 1000);
    try {
      validateSharedMemoryTtlMs(ttlMs);
    } catch (error) {
      if (error instanceof RangeError) {
        return jsonResponse(res, 400, { error: error.message });
      }
      throw error;
    }
    await configStore.update(
      current => ({ ...current, sharedMemoryTtlMs: ttlMs, workspaceTtlMs: ttlMs }),
      () => {
        agent.setSharedMemoryTtlMs(ttlMs);
        return undefined;
      },
    );
    return jsonResponse(res, 200, { ok: true, ttlMs, ttlDays });
  } catch (error) {
    if (isPayloadTooLargeError(error)) throw error;
    return jsonResponse(res, 500, {
      error: error instanceof Error ? error.message : 'Failed to update shared memory TTL',
    });
  }
}
