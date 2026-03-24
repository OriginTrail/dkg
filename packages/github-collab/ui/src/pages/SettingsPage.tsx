import React, { useState, useEffect } from 'react';
import { fetchConfig, addRepo, removeRepo, testAuthToken, startSync } from '../api.js';
import { useRepo, repoKey as toRepoKey } from '../context/RepoContext.js';

export function SettingsPage() {
  const { selectedRepo, refreshRepos } = useRepo();
  const [config, setConfig] = useState<any>(null);
  const [owner, setOwner] = useState('');
  const [repo, setRepo] = useState('');
  const [privacy, setPrivacy] = useState<'shared' | 'local'>('shared');
  const [token, setToken] = useState('');
  const [tokenStatus, setTokenStatus] = useState<any>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedRepo, setExpandedRepo] = useState<string | null>(null);

  // Removal confirmation state
  const [removeTarget, setRemoveTarget] = useState<{ owner: string; repo: string } | null>(null);
  const [removeConfirmText, setRemoveConfirmText] = useState('');

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
      setMessage(`Added ${owner}/${repo} (${privacy})`);
      loadConfig();
      await refreshRepos();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const handleRemoveRepo = async () => {
    if (!removeTarget) return;
    const key = `${removeTarget.owner}/${removeTarget.repo}`;
    if (removeConfirmText !== key) return;
    try {
      await removeRepo(removeTarget.owner, removeTarget.repo);
      setMessage(`Removed ${key}`);
      setRemoveTarget(null);
      setRemoveConfirmText('');
      loadConfig();
      await refreshRepos();
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

  const selectedKey = selectedRepo ? toRepoKey(selectedRepo) : null;

  return (
    <div className="page">
      <h2 className="page-title">Settings</h2>

      {message && <div className="success-banner">{message}</div>}
      {error && <div className="error-banner">{error}</div>}

      {/* --- Token Section --- */}
      <div className="section">
        <h3>GitHub Authentication</h3>
        <div className="token-status-row">
          <span className={`token-indicator ${token ? 'token-configured' : 'token-not-configured'}`}>
            {token ? 'Token configured' : 'No token configured'}
          </span>
          {tokenStatus?.valid && (
            <span className="text-success" style={{ marginLeft: 8 }}>
              Authenticated as {tokenStatus.login}
            </span>
          )}
        </div>
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
        {tokenStatus && !tokenStatus.valid && (
          <p className="text-error">Invalid token</p>
        )}
      </div>

      {/* --- Add Repository Section --- */}
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
        <div className="privacy-radios">
          <label className="radio-label">
            <input
              type="radio"
              name="privacy"
              value="local"
              checked={privacy === 'local'}
              onChange={() => setPrivacy('local')}
            />
            <span className="radio-text">Local Only</span>
            <span className="radio-hint">Data stays on this node</span>
          </label>
          <label className="radio-label">
            <input
              type="radio"
              name="privacy"
              value="shared"
              checked={privacy === 'shared'}
              onChange={() => setPrivacy('shared')}
            />
            <span className="radio-text">Shared</span>
            <span className="radio-hint">Synced to paranet for multi-agent collaboration</span>
          </label>
        </div>
      </div>

      {/* --- Configured Repos --- */}
      {config?.repos?.length > 0 && (
        <div className="section">
          <h3>Configured Repositories</h3>
          {config.repos.map((r: any) => {
            const key = `${r.owner}/${r.repo}`;
            const isSelected = key === selectedKey;
            const isExpanded = expandedRepo === key;

            return (
              <div key={key} className={`repo-card ${isSelected ? 'repo-card-selected' : ''}`}>
                <div className="repo-card-header" onClick={() => setExpandedRepo(isExpanded ? null : key)}>
                  <span className="mono">{key}</span>
                  {isSelected && <span className="badge badge-selected" style={{ marginLeft: 8 }}>selected</span>}
                  <span className={`badge ${r.syncEnabled ? 'badge-open' : 'badge-idle'}`} style={{ marginLeft: 8 }}>
                    {r.syncEnabled ? 'Sync Enabled' : 'Sync Disabled'}
                  </span>
                  <span className="repo-card-chevron">{isExpanded ? '\u25B2' : '\u25BC'}</span>
                </div>

                {isExpanded && (
                  <div className="repo-card-details">
                    <div className="detail-grid">
                      <div className="detail-item">
                        <span className="detail-label">Paranet ID</span>
                        <span className="detail-value mono">{r.paranetId ?? 'N/A'}</span>
                      </div>
                      <div className="detail-item">
                        <span className="detail-label">Poll Interval</span>
                        <span className="detail-value">{r.pollIntervalMs ? `${r.pollIntervalMs / 1000}s` : 'N/A'}</span>
                      </div>
                      <div className="detail-item">
                        <span className="detail-label">Sync Scope</span>
                        <span className="detail-value">{r.syncScope?.join(', ') ?? 'N/A'}</span>
                      </div>
                      <div className="detail-item">
                        <span className="detail-label">Webhook</span>
                        <span className="detail-value">{r.webhookSecret ?? 'Not configured'}</span>
                      </div>
                      <div className="detail-item">
                        <span className="detail-label">Token</span>
                        <span className="detail-value">{r.syncEnabled ? 'Configured' : 'Not configured'}</span>
                      </div>
                    </div>

                    <div className="repo-card-actions">
                      <button className="btn btn-small" onClick={() => handleSync(r.owner, r.repo)}>Sync Now</button>
                      <button
                        className="btn btn-small btn-danger"
                        onClick={() => { setRemoveTarget({ owner: r.owner, repo: r.repo }); setRemoveConfirmText(''); }}
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* --- Remove Confirmation Dialog --- */}
      {removeTarget && (
        <div className="dialog-overlay" onClick={() => setRemoveTarget(null)}>
          <div className="dialog" onClick={e => e.stopPropagation()}>
            <h3>Remove Repository</h3>
            <p>
              This will remove <strong className="mono">{removeTarget.owner}/{removeTarget.repo}</strong> and
              unsubscribe from its paranet. This cannot be undone.
            </p>
            <p style={{ marginTop: 12 }}>
              Type <strong className="mono">{removeTarget.owner}/{removeTarget.repo}</strong> to confirm:
            </p>
            <input
              type="text"
              className="input"
              value={removeConfirmText}
              onChange={e => setRemoveConfirmText(e.target.value)}
              placeholder={`${removeTarget.owner}/${removeTarget.repo}`}
              autoFocus
            />
            <div className="dialog-actions">
              <button className="btn btn-secondary" onClick={() => setRemoveTarget(null)}>Cancel</button>
              <button
                className="btn btn-danger"
                disabled={removeConfirmText !== `${removeTarget.owner}/${removeTarget.repo}`}
                onClick={handleRemoveRepo}
              >
                Remove
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
