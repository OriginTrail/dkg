import { isIP } from 'node:net';
import { loadTokens } from '../../auth.js';
import { ApiClient } from '../../api-client.js';
import type { BenchmarkClient, BenchmarkConfig } from './types.js';

export async function createBenchmarkClient(config: BenchmarkConfig): Promise<BenchmarkClient> {
  if (config.apiUrl) {
    const token = await resolveTokenForApiUrl(config.apiUrl, config.authToken);
    return new ApiClient(config.apiUrl, token);
  }

  if (config.apiPort) {
    const token = config.authToken ?? await loadFirstLocalToken();
    return new ApiClient(config.apiPort, token);
  }

  return ApiClient.connect();
}

export async function resolveTokenForApiUrl(apiUrl: string, explicitToken?: string): Promise<string | undefined> {
  if (explicitToken) return explicitToken;
  if (isLoopbackApiUrl(apiUrl)) return loadFirstLocalToken();

  throw new Error(
    'Refusing to auto-load the local DKG auth token for a non-loopback API URL. ' +
    'Pass --auth-token or DKG_AUTH_TOKEN explicitly for remote benchmark targets.',
  );
}

export async function loadFirstLocalToken(): Promise<string | undefined> {
  const tokens = await loadTokens();
  return tokens.size > 0 ? tokens.values().next().value : undefined;
}

export function isLoopbackApiUrl(apiUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(apiUrl);
  } catch {
    throw new Error(`Invalid API URL: ${apiUrl}`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;

  const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (hostname === 'localhost') return true;

  const ipVersion = isIP(hostname);
  if (ipVersion === 4) return hostname.startsWith('127.');
  if (ipVersion === 6) return hostname === '::1' || hostname === '0:0:0:0:0:0:0:1';
  return false;
}
