import React, { useEffect, useState } from 'react';
import {
  ensureDashboardSession,
  getDashboardSession,
  isDashboardSessionReady,
  loginDashboardSession,
  subscribeDashboardSession,
  type DashboardSessionStatus,
} from '../dashboardSessionClient.js';

function DashboardLoginForm() {
  const [username, setUsername] = useState('node-admin');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmedUsername = username.trim();
    if (!trimmedUsername || !password) return;
    setSubmitting(true);
    setError(null);
    try {
      await loginDashboardSession(trimmedUsername, password);
      setPassword('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Dashboard sign in failed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="v10-session-gate" data-testid="dashboard-session-unlock">
      <form className="v10-session-unlock" onSubmit={submit}>
        <div className="v10-session-unlock-copy">
          <h1>Sign in to DKG Node Dashboard</h1>
          <p>Use the dashboard credentials created during setup, or reset them from this machine.</p>
        </div>
        <label className="v10-session-token-field">
          <span>Username</span>
          <input
            type="text"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            autoComplete="username"
            spellCheck={false}
          />
        </label>
        <label className="v10-session-token-field">
          <span>Password</span>
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            aria-describedby={error ? 'dashboard-session-login-error' : undefined}
          />
        </label>
        <p className="v10-session-reset-copy">Lost the password? Run <code>dkg auth dashboard reset-password</code> on this machine.</p>
        {error && <div id="dashboard-session-login-error" className="v10-session-error" role="alert">{error}</div>}
        <button className="dkg-btn dkg-btn-solid" type="submit" disabled={submitting || username.trim().length === 0 || password.length === 0}>
          {submitting ? 'Signing in...' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}

export function DashboardSessionGate({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<DashboardSessionStatus>(() => getDashboardSession());
  const [checking, setChecking] = useState(() => !isDashboardSessionReady(getDashboardSession()));

  useEffect(() => {
    let mounted = true;
    const unsubscribe = subscribeDashboardSession(() => {
      if (mounted) setSession(getDashboardSession());
    });
    void ensureDashboardSession().then((nextSession) => {
      if (!mounted) return;
      setSession(nextSession);
    }).finally(() => {
      if (mounted) setChecking(false);
    });
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  if (checking && !isDashboardSessionReady(session)) {
    return (
      <div className="v10-session-gate">
        <div className="v10-session-unlock">
          <div className="v10-stat-loading">Checking session...</div>
        </div>
      </div>
    );
  }

  if (!isDashboardSessionReady(session)) return <DashboardLoginForm />;

  return <>{children}</>;
}
