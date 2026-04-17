const API_PATH = '/api/apps/origin-trail-game';

function getBaseUrl(): string {
  const origin = (window as any).__DKG_API_ORIGIN__;
  return origin ? `${origin}${API_PATH}` : API_PATH;
}

async function waitForToken(timeoutMs = 3000): Promise<string | undefined> {
  const token = (window as any).__DKG_TOKEN__;
  if (token) return token;
  if (window.parent === window) return undefined;
  return new Promise(resolve => {
    const check = setInterval(() => {
      if ((window as any).__DKG_TOKEN__) {
        clearInterval(check);
        clearTimeout(timer);
        resolve((window as any).__DKG_TOKEN__);
      }
    }, 100);
    const timer = setTimeout(() => {
      clearInterval(check);
      resolve(undefined);
    }, timeoutMs);
  });
}

async function request(method: string, path: string, body?: unknown) {
  const token = (window as any).__DKG_TOKEN__ ?? await waitForToken();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${getBaseUrl()}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data: any;
  try { data = await res.json(); } catch { data = {}; }
  if (!res.ok) {
    const msg = data.error || (res.status === 401 ? 'Connection to node lost — try refreshing the page' : 'Request failed');
    throw new Error(msg);
  }
  return data;
}

export const api: Record<string, (...args: any[]) => Promise<any>> = {
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
  chat: (limit?: number) => request('GET', `/chat${limit ? `?limit=${limit}` : ''}`),
  sendChat: (message: string, displayName?: string) => request('POST', '/chat', { message, displayName }),
  notifications: () => request('GET', '/notifications'),
  markNotificationsRead: (ids?: string[]) =>
    request('POST', '/notifications/read', ids ? { ids } : {}),
};

/** @internal Replace api methods for testing. Returns a restore function. */
export function _setApiForTest(overrides: Partial<typeof api>): () => void {
  const originals: Record<string, (...args: any[]) => Promise<any>> = {};
  for (const [key, fn] of Object.entries(overrides)) {
    originals[key] = api[key];
    api[key] = fn as any;
  }
  return () => {
    for (const [key, fn] of Object.entries(originals)) {
      api[key] = fn;
    }
  };
}
