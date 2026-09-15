export async function callCodex(path: string, body?: unknown) {
  const response = await fetch(`/api/codex/${path}`, body === undefined ? { cache: 'no-store' } : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-DKG-Codex': '1' },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}
