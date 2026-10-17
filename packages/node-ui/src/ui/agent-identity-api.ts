import type { AgentIdentity } from './api.js';
import { BASE, authHeaders, HttpError } from './http.js';
import { fetchQueryJson } from './query-transport.js';

/** Bound headers and body so shared identity refresh cannot pin inventory ownership. */
export async function fetchCurrentAgent(): Promise<AgentIdentity> {
  const { response, body } = await fetchQueryJson(`${BASE}/api/agent/identity`, {
    headers: authHeaders(),
  }, { timeoutMs: 10_000, maxResponseBytes: null }, () => {});
  if (!response.ok) {
    throw new HttpError(response.status, (body as { error?: string })?.error ?? `HTTP ${response.status}`, body);
  }
  return body as AgentIdentity;
}
