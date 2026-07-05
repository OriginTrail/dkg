import { describe, expect, it, vi } from 'vitest';
import {
  parseDashboardSessionExchange,
  selectDashboardLoginCompatToken,
} from '../src/daemon/dashboard-session.js';

const TOKEN_AGENT_ADDRESS = 'did:dkg:agent:token';

describe('dashboard session exchange helpers', () => {
  it('parses token, login, and mixed exchange requests explicitly', () => {
    expect(parseDashboardSessionExchange({ token: ' dashboard-token ' }, undefined)).toEqual({
      kind: 'token',
      token: 'dashboard-token',
    });
    expect(parseDashboardSessionExchange({}, 'Bearer header-token')).toEqual({
      kind: 'token',
      token: 'header-token',
    });
    expect(parseDashboardSessionExchange({ username: ' node-admin ', password: 'secret' }, undefined)).toEqual({
      kind: 'login',
      username: 'node-admin',
      password: 'secret',
    });
    expect(parseDashboardSessionExchange({ username: 'node-admin', token: 'dashboard-token' }, undefined)).toEqual({
      kind: 'invalid',
      status: 400,
      error: 'Dashboard session exchange accepts either token or username/password',
    });
  });

  it('selects a node-admin backing token for password-login sessions', () => {
    const validTokens = new Set(['agent-token-a', 'node-admin-token', 'bridge-token']);
    const resolveAgentByToken = (token: string) => token.startsWith('agent-token') ? TOKEN_AGENT_ADDRESS : undefined;
    const refreshValidTokens = vi.fn();

    expect(selectDashboardLoginCompatToken({
      validTokens,
      bridgeAuthToken: 'bridge-token',
      resolveAgentByToken,
      refreshValidTokens,
    })).toBe('bridge-token');
    expect(refreshValidTokens).toHaveBeenCalledTimes(1);

    expect(selectDashboardLoginCompatToken({
      validTokens,
      bridgeAuthToken: 'stale-bridge-token',
      resolveAgentByToken,
    })).toBe('node-admin-token');

    expect(selectDashboardLoginCompatToken({
      validTokens: new Set(['agent-token-a', 'agent-token-b']),
      resolveAgentByToken,
    })).toBeUndefined();
  });
});
