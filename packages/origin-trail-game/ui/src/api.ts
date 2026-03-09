const API_PATH = '/api/apps/origin-trail-game';

function getBaseUrl(): string {
  const origin = (window as any).__DKG_API_ORIGIN__;
  return origin ? `${origin}${API_PATH}` : API_PATH;
}

async function request(method: string, path: string, body?: unknown) {
  const token = (window as any).__DKG_TOKEN__;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${getBaseUrl()}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

export const api = {
  lobby: () => request('GET', '/lobby'),
  info: () => request('GET', '/info'),
  locations: () => request('GET', '/locations'),
  leaderboard: () => request('GET', '/leaderboard'),
  swarm: (swarmId: string) => request('GET', `/swarm/${swarmId}`),
  create: (playerName: string, swarmName: string, maxPlayers?: number) =>
    request('POST', '/create', { playerName, swarmName, maxPlayers }),
  join: (swarmId: string, playerName: string) =>
    request('POST', '/join', { swarmId, playerName }),
  leave: (swarmId: string) =>
    request('POST', '/leave', { swarmId }),
  start: (swarmId: string) =>
    request('POST', '/start', { swarmId }),
  vote: (swarmId: string, voteAction: string, params?: Record<string, any>) =>
    request('POST', '/vote', { swarmId, voteAction, params }),
  forceResolve: (swarmId: string) =>
    request('POST', '/force-resolve', { swarmId }),
  notifications: () => request('GET', '/notifications'),
  markNotificationsRead: (ids?: string[]) =>
    request('POST', '/notifications/read', ids ? { ids } : {}),
};
