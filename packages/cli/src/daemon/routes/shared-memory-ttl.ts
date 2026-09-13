import { resolveSharedMemoryTtlMs } from '../../config.js';
import type { DkgConfigStore } from '../../daemon-config-store.js';
import { validateSharedMemoryTtlMs } from '@origintrail-official/dkg-agent';
import { isPayloadTooLargeError, jsonResponse, readBody, SMALL_BODY_BYTES } from '../http-utils.js';
import type { RequestContext } from './context.js';

type TtlSettingsContext = Pick<RequestContext, 'req' | 'res' | 'agent'> & {
  configStore: DkgConfigStore;
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** Shared handler for the V10 and legacy workspace TTL settings routes. */
export async function handleSharedMemoryTtlSettings({ req, res, configStore, agent }: TtlSettingsContext): Promise<void> {
  if (req.method === 'GET') {
    const ttlMs = resolveSharedMemoryTtlMs(configStore.current) ?? 30 * DAY_MS;
    return jsonResponse(res, 200, { ttlMs, ttlDays: ttlMs / DAY_MS });
  }
  try {
    const bodyStr = await readBody(req, SMALL_BODY_BYTES);
    const { ttlDays } = JSON.parse(bodyStr ?? '{}') as { ttlDays?: number };
    if (typeof ttlDays !== 'number' || !Number.isFinite(ttlDays) || ttlDays < 0) {
      return jsonResponse(res, 400, { error: 'ttlDays must be a finite non-negative number' });
    }
    const ttlMs = Math.round(ttlDays * DAY_MS);
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
      (_next, previous) => ({
        apply: () => agent.setSharedMemoryTtlMs(ttlMs),
        rollback: () => agent.setSharedMemoryTtlMs(resolveSharedMemoryTtlMs(previous) ?? 30 * DAY_MS),
      }),
    );
    return jsonResponse(res, 200, { ok: true, ttlMs, ttlDays });
  } catch (error) {
    if (isPayloadTooLargeError(error)) throw error;
    return jsonResponse(res, 500, {
      error: error instanceof Error ? error.message : 'Failed to update shared memory TTL',
    });
  }
}
