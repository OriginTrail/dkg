import React, { useEffect, useState } from 'react';
import {
  ensureDashboardSession,
  exchangeDashboardSession,
  getDashboardSession,
  isDashboardSessionReady,
  subscribeDashboardSession,
  type DashboardSessionStatus,
} from '../dashboardSessionClient.js';

function DashboardUnlockForm() {
  const [token, setToken] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = token.trim();
    if (!trimmed) return;
    setSubmitting(true);
    setError(null);
    try {
      await exchangeDashboardSession(trimmed);
      setToken('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Dashboard unlock failed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="v10-session-gate" data-testid="dashboard-session-unlock">
      <form className="v10-session-unlock" onSubmit={submit}>
        <div className="v10-session-unlock-copy">
          <h1>Unlock dashboard</h1>
          <p>Enter a node API token to open a dashboard session.</p>
        </div>
        <label className="v10-session-token-field">
          <span>API token</span>
          <input
            type="password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        {error && <div className="v10-session-error" role="alert">{error}</div>}
        <button className="dkg-btn dkg-btn-solid" type="submit" disabled={submitting || token.trim().length === 0}>
          {submitting ? 'Unlocking...' : 'Unlock'}
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

  if (!isDashboardSessionReady(session)) return <DashboardUnlockForm />;

  return <>{children}</>;
}
