import { setTimeout as sleep } from 'node:timers/promises';
import { AUTHORITY_CODE, askWithAuthorityRetry } from '../lib/qa/authority-retry.mjs';

/** Stress-driver HTTP boundary. Only an explicitly opted-in publish retries its pre-submit authority refusal. */
export function createStressApiClient({ host, token, fetch: request = globalThis.fetch, wait = sleep }) {
  return async function apiCall(method, path, body, {
    timeoutMs = 120_000, retryPublishAuthority = false, onAuthorityRetry,
  } = {}) {
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    const ask = async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await request(`${host}${path}`, {
          method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: encoded, signal: controller.signal,
        });
        const text = await res.text();
        let json;
        try { json = text.length > 0 ? JSON.parse(text) : {}; }
        catch { json = { _raw: text }; }
        return { status: res.status, ok: res.ok, json, text, retryAfter: res.headers.get('retry-after') };
      } finally { clearTimeout(timer); }
    };
    const answer = retryPublishAuthority
      ? await askWithAuthorityRetry(ask, { codes: [AUTHORITY_CODE], sleep: wait, onRetry: onAuthorityRetry })
      : await ask();
    if (!answer.ok) {
      const err = new Error(`HTTP ${answer.status} ${method} ${path}: ${answer.json.error ?? answer.text.slice(0, 300)}`);
      err.status = answer.status;
      err.body = answer.json;
      err.retryAfter = answer.retryAfter;
      throw err;
    }
    return answer.json;
  };
}
