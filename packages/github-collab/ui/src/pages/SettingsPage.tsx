import React, { useState, useEffect } from 'react';
import { fetchConfig, addRepo, removeRepo, testAuthToken, startSync } from '../api.js';

export function SettingsPage() {
  const [config, setConfig] = useState<any>(null);
  const [owner, setOwner] = useState('');
  const [repo, setRepo] = useState('');
  const [token, setToken] = useState('');
  const [tokenStatus, setTokenStatus] = useState<any>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadConfig = () => {
    fetchConfig()
      .then(setConfig)
      .catch(() => {});
  };

  useEffect(loadConfig, []);

  const handleTestToken = async () => {
    if (!token) return;
    setTokenStatus(null);
    try {
      const result = await testAuthToken(token);
      setTokenStatus(result);
    } catch (e: any) {
      setTokenStatus({ valid: false, error: e.message });
    }
  };

  const handleAddRepo = async () => {
    if (!owner || !repo) return;
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      await addRepo({ owner, repo, githubToken: token || undefined });
      setMessage(`Added ${owner}/${repo}`);
      loadConfig();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const handleRemoveRepo = async (o: string, r: string) => {
    try {
      await removeRepo(o, r);
      setMessage(`Removed ${o}/${r}`);
      loadConfig();
    } catch (e: any) {
      setError(e.message);
    }
  };

  const handleSync = async (o: string, r: string) => {
    try {
      await startSync(o, r);
      setMessage(`Sync started for ${o}/${r}`);
    } catch (e: any) {
      setError(e.message);
    }
  };

  return (
    <div className="page">
      <h2 className="page-title">Settings</h2>

      {message && <div className="success-banner">{message}</div>}
      {error && <div className="error-banner">{error}</div>}

      <div className="section">
        <h3>GitHub Authentication</h3>
        <div className="input-row">
          <input
            type="password"
            className="input"
            placeholder="GitHub Personal Access Token"
            value={token}
            onChange={e => setToken(e.target.value)}
          />
          <button className="btn btn-secondary" onClick={handleTestToken}>Test Token</button>
        </div>
        {tokenStatus && (
          <p className={tokenStatus.valid ? 'text-success' : 'text-error'}>
            {tokenStatus.valid ? `Authenticated as ${tokenStatus.login}` : 'Invalid token'}
          </p>
        )}
      </div>

      <div className="section">
        <h3>Add Repository</h3>
        <div className="input-row">
          <input
            type="text"
            className="input"
            placeholder="Owner"
            value={owner}
            onChange={e => setOwner(e.target.value)}
          />
          <input
            type="text"
            className="input"
            placeholder="Repository"
            value={repo}
            onChange={e => setRepo(e.target.value)}
          />
          <button className="btn" onClick={handleAddRepo} disabled={saving}>
            {saving ? 'Adding...' : 'Add Repository'}
          </button>
        </div>
      </div>

      {config?.repos?.length > 0 && (
        <div className="section">
          <h3>Configured Repositories</h3>
          <div className="table-container">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Repository</th>
                  <th>Sync</th>
                  <th>Webhook</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {config.repos.map((r: any) => (
                  <tr key={`${r.owner}/${r.repo}`}>
                    <td className="mono">{r.owner}/{r.repo}</td>
                    <td>{r.syncEnabled ? 'Enabled' : 'Disabled'}</td>
                    <td>{r.webhookSecret ?? 'Not configured'}</td>
                    <td>
                      <button className="btn btn-small" onClick={() => handleSync(r.owner, r.repo)}>Sync</button>
                      <button className="btn btn-small btn-danger" onClick={() => handleRemoveRepo(r.owner, r.repo)}>Remove</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
