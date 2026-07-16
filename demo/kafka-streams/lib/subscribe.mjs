export async function ensureSubscribed(httpJson, baseUrl, contextGraphId, authHeaders = {}) {
  const headers = { 'Content-Type': 'application/json', ...authHeaders };
  const r = await httpJson(`${baseUrl}/api/context-graph/subscribe`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ contextGraphId, includeSharedMemory: true }),
  });
  if (r.status < 200 || r.status >= 300) {
    const detail = r.parsed?.error ?? r.body?.slice?.(0, 300) ?? '';
    throw new Error(`subscribe ${contextGraphId} on ${baseUrl} failed: ${r.status} ${detail}`);
  }
  return r.parsed ?? {};
}
