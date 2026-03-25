/**
 * API client for the GitHub Collaboration app.
 * Calls /api/apps/github-collab/* endpoints.
 */

const PREFIX = '/api/apps/github-collab';

function getApiOrigin(): string {
  return (window as any).__DKG_API_ORIGIN__ ?? '';
}

function getAuthHeaders(): Record<string, string> {
  const token = (window as any).__DKG_TOKEN__;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * Parse an N-Triples binding value to a plain string.
 * Handles: "value"^^<xsd:type>, "value"@lang, "value", and bare URIs.
 */
export function bv(raw: string | undefined | null): string {
  if (!raw) return '';
  const s = String(raw);
  // Typed literal: "value"^^<type>
  const typedMatch = s.match(/^"((?:[^"\\]|\\.)*)"(?:\^\^<[^>]+>)?$/);
  if (typedMatch) return typedMatch[1].replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\\\/g, '\\');
  // Language-tagged: "value"@lang
  const langMatch = s.match(/^"((?:[^"\\]|\\.)*)"@\S+$/);
  if (langMatch) return langMatch[1].replace(/\\"/g, '"');
  // Plain quoted: "value"
  if (s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1);
  // Bare URI or already clean
  return s;
}

/** Clean all binding values in an array of SPARQL result bindings. */
function cleanBindings(bindings: Record<string, string>[]): Record<string, string>[] {
  return bindings.map(row => {
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(row)) {
      clean[k] = bv(v);
    }
    return clean;
  });
}

async function apiFetch(path: string, init?: RequestInit): Promise<any> {
  const origin = getApiOrigin();
  const url = `${origin}${PREFIX}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders(), ...init?.headers },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `API error: ${res.status}`);
  }
  return res.json();
}

// --- Info & Status ---

export function fetchInfo() {
  return apiFetch('/info');
}

export function fetchStatus() {
  return apiFetch('/status');
}

// --- Config ---

export function fetchConfig() {
  return apiFetch('/config');
}

export function addRepo(config: {
  owner: string;
  repo: string;
  githubToken?: string;
  webhookSecret?: string;
  pollIntervalMs?: number;
  syncScope?: string[];
  privacyLevel?: 'local' | 'shared';
}) {
  return apiFetch('/config/repo', { method: 'POST', body: JSON.stringify(config) });
}

export function removeRepo(owner: string, repo: string) {
  return apiFetch('/config/repo', { method: 'DELETE', body: JSON.stringify({ owner, repo }) });
}

// --- Sync ---

export function startSync(owner: string, repo: string, scope?: string[], since?: string) {
  return apiFetch('/sync', { method: 'POST', body: JSON.stringify({ owner, repo, scope, since }) });
}

export function fetchSyncStatus(jobId?: string, repo?: string) {
  const params = new URLSearchParams();
  if (jobId) params.set('jobId', jobId);
  if (repo) params.set('repo', repo);
  return apiFetch(`/sync/status?${params}`);
}

// --- Query ---

export function executeQuery(sparql: string, repo?: string, includeWorkspace = true) {
  return apiFetch('/query', { method: 'POST', body: JSON.stringify({ sparql, repo, includeWorkspace }) });
}

// --- Auth ---

export function testAuthToken(token: string) {
  return apiFetch('/auth/test', { method: 'POST', body: JSON.stringify({ token }) });
}

// --- Reviews ---

export function requestReview(owner: string, repo: string, prNumber: number, reviewers: string[], requiredApprovals: number) {
  return apiFetch('/review/request', { method: 'POST', body: JSON.stringify({ owner, repo, prNumber, reviewers, requiredApprovals }) });
}

export function submitReview(sessionId: string, decision: string, comment?: string) {
  return apiFetch('/review/submit', { method: 'POST', body: JSON.stringify({ sessionId, decision, comment }) });
}

export function fetchReviewStatus(sessionId: string) {
  return apiFetch(`/review/status?sessionId=${sessionId}`);
}

// --- PRs ---

export async function fetchPullRequests(owner: string, repo: string, state = 'all', limit = 50) {
  const raw = await apiFetch(`/repos/${owner}/${repo}/prs?state=${state}&limit=${limit}`);
  return { ...raw, pullRequests: cleanBindings(raw.pullRequests ?? []) };
}

export function fetchPullRequest(owner: string, repo: string, number: number) {
  return apiFetch(`/repos/${owner}/${repo}/prs/${number}`);
}

// --- Issues ---

export async function fetchIssues(owner: string, repo: string, state = 'all', limit = 50) {
  const sparql = `
    SELECT ?issue ?number ?title ?state ?author ?createdAt WHERE {
      ?issue a <https://ontology.dkg.io/ghcode#Issue> ;
             <https://ontology.dkg.io/ghcode#issueNumber> ?number ;
             <https://ontology.dkg.io/ghcode#inRepo> <urn:github:${owner}/${repo}> .
      OPTIONAL { ?issue <https://ontology.dkg.io/ghcode#title> ?title }
      OPTIONAL { ?issue <https://ontology.dkg.io/ghcode#state> ?state }
      OPTIONAL { ?issue <https://ontology.dkg.io/ghcode#author> ?authorUri . ?authorUri <https://ontology.dkg.io/ghcode#login> ?author }
      OPTIONAL { ?issue <https://ontology.dkg.io/ghcode#createdAt> ?createdAt }
      ${state !== 'all' ? `FILTER(?state = "${state}")` : ''}
    }
    ORDER BY DESC(?createdAt)
    LIMIT ${limit}
  `;
  const raw = await executeQuery(sparql, `${owner}/${repo}`);
  const bindings = raw?.result?.bindings ?? [];
  return { issues: cleanBindings(bindings), total: bindings.length };
}

// --- Commits ---

export async function fetchCommits(owner: string, repo: string, limit = 50) {
  const sparql = `
    SELECT ?commit ?sha ?message ?author ?committedAt WHERE {
      ?commit a <https://ontology.dkg.io/ghcode#Commit> ;
              <https://ontology.dkg.io/ghcode#sha> ?sha ;
              <https://ontology.dkg.io/ghcode#inRepo> <urn:github:${owner}/${repo}> .
      OPTIONAL { ?commit <https://ontology.dkg.io/ghcode#message> ?message }
      OPTIONAL { ?commit <https://ontology.dkg.io/ghcode#author> ?authorUri . ?authorUri <https://ontology.dkg.io/ghcode#login> ?author }
      OPTIONAL { ?commit <https://ontology.dkg.io/ghcode#committedAt> ?committedAt }
    }
    ORDER BY DESC(?committedAt)
    LIMIT ${limit}
  `;
  const raw = await executeQuery(sparql, `${owner}/${repo}`);
  const bindings = raw?.result?.bindings ?? [];
  return { commits: cleanBindings(bindings), total: bindings.length };
}

// --- Conversion ---

export function convertToShared(owner: string, repo: string) {
  return apiFetch('/convert-to-shared', { method: 'POST', body: JSON.stringify({ owner, repo }) });
}

// --- Invitations ---

export function sendInvitation(owner: string, repo: string, peerId: string) {
  return apiFetch('/invite', { method: 'POST', body: JSON.stringify({ owner, repo, peerId }) });
}

export function fetchInvitations(repo?: string) {
  const params = repo ? `?repo=${encodeURIComponent(repo)}` : '';
  return apiFetch(`/invitations${params}`);
}

export function acceptInvitation(invitationId: string) {
  return apiFetch(`/invitations/${invitationId}/accept`, { method: 'POST' });
}

export function declineInvitation(invitationId: string) {
  return apiFetch(`/invitations/${invitationId}/decline`, { method: 'POST' });
}

export function revokeInvitation(invitationId: string) {
  return apiFetch(`/invitations/${invitationId}`, { method: 'DELETE' });
}

// --- Collaborators ---

export function fetchCollaborators(owner: string, repo: string) {
  return apiFetch(`/collaborators?repo=${encodeURIComponent(`${owner}/${repo}`)}`);
}

// --- Branches ---

export function fetchBranches(owner: string, repo: string) {
  return apiFetch(`/repos/${owner}/${repo}/branches`);
}
