import { readFile } from 'node:fs/promises';

// Minimal application example: no implicit retries, sharing, or publication.
const [operation = 'read', view = 'working-memory'] = process.argv.slice(2);
const contextGraphId = process.env.DKG_CONTEXT_GRAPH;
const token = process.env.DKG_AUTH_TOKEN;
const name = process.env.DKG_KA_NAME || 'atlas-app';
const base = new URL(process.env.DKG_NODE_URL || 'http://127.0.0.1:9200');
if (!contextGraphId || !token) throw new Error('Set DKG_CONTEXT_GRAPH and DKG_AUTH_TOKEN.');
if (!['write', 'read', 'share'].includes(operation)) throw new Error('Use write, read, or share.');
if (!['working-memory', 'shared-working-memory', 'verifiable-memory'].includes(view)) {
  throw new Error('Unsupported query view.');
}
if (base.protocol !== 'https:' && !(base.protocol === 'http:' &&
    ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname))) {
  throw new Error('Use HTTPS for a remote node.');
}
if (base.username || base.password) throw new Error('Do not put credentials in the URL.');

async function request(path, body) {
  const response = await fetch(new URL(path, base), {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
    redirect: 'error',
  });
  const result = await response.json();
  if (!response.ok || response.status === 207 || result.error ||
      (result.errors && Object.keys(result.errors).length > 0)) {
    // Avoid logging server-provided text that could contain secrets or payloads.
    throw new Error(`Node operation incomplete (HTTP ${response.status}); inspect the existing KA/job before retrying.`);
  }
  return result;
}

const path = `/api/knowledge-assets/${encodeURIComponent(name)}`;
const ex = 'https://example.org/dkg-tutorial/';
const schema = 'https://schema.org/';
if (operation === 'write') {
  await request('/api/knowledge-assets', { contextGraphId, name });
  await request(`${path}/wm/write`, {
    contextGraphId,
    quads: [
      { subject: `${ex}atlas`, predicate: `${schema}name`, object: '"Atlas"' },
      { subject: `${ex}atlas`, predicate: `${ex}usesDatabase`, object: `${ex}oxigraph` },
      { subject: `${ex}atlas`, predicate: `${schema}citation`, object: `${ex}source` },
      { subject: `${ex}oxigraph`, predicate: `${schema}name`, object: '"Oxigraph"' },
      { subject: `${ex}source`, predicate: `${schema}name`, object: '"Atlas architecture note (tutorial fixture)"' },
    ],
  });
  const result = await request(`${path}/wm/quads?${new URLSearchParams({ contextGraphId })}`);
  console.log(JSON.stringify({ layer: 'working-memory', ...result }, null, 2));
} else if (operation === 'share') {
  await request(`${path}/wm/finalize`, { contextGraphId });
  const result = await request(`${path}/swm/share`, { contextGraphId, entities: 'all' });
  console.log(JSON.stringify({ layer: 'shared-working-memory', result }, null, 2));
} else {
  const sparql = await readFile(new URL('./atlas-query.rq', import.meta.url), 'utf8');
  const result = await request('/api/query', { contextGraphId, view, sparql });
  console.log(JSON.stringify({ layer: view, ...result }, null, 2));
}
