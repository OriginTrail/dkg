import React, { useState, useEffect, useRef } from 'react';
import { fetchConfig, addRepo, removeRepo, testAuthToken, startSync, fetchSyncStatus } from '../api.js';
import { useRepo, repoKey as toRepoKey } from '../context/RepoContext.js';

export function SettingsPage() {
  const { selectedRepo, refreshRepos } = useRepo();
  const [config, setConfig] = useState<any>(null);
  const [repoInput, setRepoInput] = useState('');

  /** Parse GitHub URL or owner/repo into { owner, repo } */
  function parseRepoInput(input: string): { owner: string; repo: string } | null {
    const trimmed = input.trim().replace(/\/$/, '');
    // Full URL: https://github.com/owner/repo
    const urlMatch = trimmed.match(/(?:https?:\/\/)?github\.com\/([^/]+)\/([^/]+)/i);
    if (urlMatch) return { owner: urlMatch[1], repo: urlMatch[2] };
    // owner/repo format
    const slashMatch = trimmed.match(/^([^/]+)\/([^/]+)$/);
    if (slashMatch) return { owner: slashMatch[1], repo: slashMatch[2] };
    return null;
  }

  const parsedRepo = parseRepoInput(repoInput);
  const owner = parsedRepo?.owner ?? '';
  const repo = parsedRepo?.repo ?? '';
  const [privacy, setPrivacy] = useState<'shared' | 'local'>('local');
  const [token, setToken] = useState('');
  const [tokenStatus, setTokenStatus] = useState<any>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedRepo, setExpandedRepo] = useState<string | null>(null);

  // Removal confirmation state
  const [removeTarget, setRemoveTarget] = useState<{ owner: string; repo: string } | null>(null);
  const [removeConfirmText, setRemoveConfirmText] = useState('');

  // Sync progress state
  const [syncingRepo, setSyncingRepo] = useState<string | null>(null);
  const [syncProgress, setSyncProgress] = useState<any>(null);
  const syncPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Webhook config state
  const [webhookSecret, setWebhookSecret] = useState('');
  const [webhookSaving, setWebhookSaving] = useState(false);

  const loadConfig = () => {
    fetchConfig()
      .then(setConfig)
      .catch(() => {});
  };

  useEffect(loadConfig, []);

  // Cleanup sync polling on unmount
  useEffect(() => {
    return () => {
      if (syncPollRef.current) clearInterval(syncPollRef.current);
    };
  }, []);

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
      await addRepo({ owner, repo, githubToken: token || undefined, privacyLevel: privacy });
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
    if (removeConfirmText.trim().toLowerCase() !== key.toLowerCase()) return;
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
    const repoKey = `${o}/${r}`;
    try {
      const result = await startSync(o, r);
      setSyncingRepo(repoKey);
      setSyncProgress({ status: 'running', jobId: result.jobId });

      // Poll sync status every 2 seconds
      if (syncPollRef.current) clearInterval(syncPollRef.current);
      syncPollRef.current = setInterval(async () => {
        try {
          const status = await fetchSyncStatus(undefined, repoKey);
          setSyncProgress(status);
          if (status.status === 'completed' || status.status === 'failed') {
            if (syncPollRef.current) clearInterval(syncPollRef.current);
            syncPollRef.current = null;
            // Keep showing result for 5 seconds then clear
            setTimeout(() => {
              setSyncingRepo(prev => prev === repoKey ? null : prev);
              setSyncProgress(null);
            }, 5000);
          }
        } catch {
          // Status endpoint might 404 if job vanished
          if (syncPollRef.current) clearInterval(syncPollRef.current);
          syncPollRef.current = null;
          setSyncingRepo(null);
          setSyncProgress(null);
        }
      }, 2000);
    } catch (e: any) {
      setError(e.message);
    }
  };

  const handleSaveWebhook = async (o: string, r: string) => {
    setWebhookSaving(true);
    setError(null);
    try {
      await addRepo({ owner: o, repo: r, webhookSecret: webhookSecret || undefined });
      setMessage(`Webhook secret updated for ${o}/${r}`);
      setWebhookSecret('');
      loadConfig();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setWebhookSaving(false);
    }
  };

  const selectedKey = selectedRepo ? toRepoKey(selectedRepo) : null;

  /** Format sync progress for display */
  function formatProgress(progress: Record<string, { total: number; synced: number }> | undefined): string {
    if (!progress) return '';
    return Object.entries(progress)
      .map(([scope, { synced, total }]) => `${scope}: ${synced}/${total}`)
      .join(', ');
  }

  return (
    <div className="page">
      <h2 className="page-title">Settings</h2>

      {message && <div className="success-banner">{message}</div>}
      {error && <div className="error-banner">{error}</div>}

      {/* --- Token Section --- */}
      <div className="section">
        <h3>GitHub Authentication</h3>
        <p className="text-muted" style={{ marginTop: 0, marginBottom: 8 }}>
          Optional for public repositories. Required for private repos and higher rate limits.
        </p>
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
          <p className="text-error">{tokenStatus.error ?? 'Invalid token'}</p>
        )}
      </div>

      {/* --- Add Repository Section --- */}
      <div className="section">
        <h3>Add Repository</h3>
        <div className="input-row">
          <input
            type="text"
            className="input"
            style={{ flex: 2 }}
            placeholder="GitHub URL or owner/repo (e.g. https://github.com/OriginTrail/dkg-v9)"
            value={repoInput}
            onChange={e => setRepoInput(e.target.value)}
          />
          <button className="btn" onClick={handleAddRepo} disabled={saving || !parsedRepo}>
            {saving ? 'Adding...' : 'Add Repository'}
          </button>
        </div>
        {repoInput && !parsedRepo && (
          <p className="text-error" style={{ marginTop: 4 }}>Enter a GitHub URL or owner/repo format</p>
        )}
        {parsedRepo && (
          <p style={{ marginTop: 4, color: 'var(--green)', fontSize: 13 }}>
            {parsedRepo.owner}/{parsedRepo.repo}
          </p>
        )}
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
            const isSyncing = syncingRepo === key;
            const repoPrivacy: string = r.privacyLevel ?? 'local';

            return (
              <div key={key} className={`repo-card ${isSelected ? 'repo-card-selected' : ''}`}>
                <div className="repo-card-header" onClick={() => setExpandedRepo(isExpanded ? null : key)}>
                  <span className="mono">{key}</span>
                  {isSelected && <span className="badge badge-selected" style={{ marginLeft: 8 }}>selected</span>}
                  <span className={`badge ${r.syncEnabled ? 'badge-open' : 'badge-idle'}`} style={{ marginLeft: 8 }}>
                    {r.syncEnabled ? 'Sync Enabled' : 'Sync Disabled'}
                  </span>
                  <span className={`repo-privacy-badge repo-privacy-${repoPrivacy}`} style={{ marginLeft: 8 }}>
                    {repoPrivacy === 'shared' ? 'Shared' : 'Local'}
                  </span>
                  <span className="repo-card-chevron">{isExpanded ? '\u25B2' : '\u25BC'}</span>
                </div>

                {isExpanded && (
                  <div className="repo-card-details">
                    <div className="detail-grid">
                      <div className="detail-item">
                        <span className="detail-label">Privacy</span>
                        <span className="detail-value">
                          {repoPrivacy === 'shared' ? 'Shared' : 'Local Only'}
                        </span>
                      </div>
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
                        <span className="detail-value">
                          {r.hasToken ? 'Configured' : 'Not configured'}
                          {!r.hasToken && token && (
                            <button
                              className="btn btn-small btn-secondary"
                              style={{ marginLeft: 8 }}
                              onClick={async () => {
                                try {
                                  await addRepo({ owner: r.owner, repo: r.repo, githubToken: token });
                                  setMessage(`Token updated for ${r.owner}/${r.repo}`);
                                  loadConfig();
                                } catch (e: any) { setError(e.message); }
                              }}
                            >
                              Apply Token
                            </button>
                          )}
                          {!r.hasToken && !token && (
                            <span className="text-muted" style={{ marginLeft: 8, fontSize: 12 }}>
                              Enter token above first
                            </span>
                          )}
                        </span>
                      </div>
                    </div>

                    {/* Sync progress indicator */}
                    {isSyncing && syncProgress && (
                      <div className="sync-progress-section" style={{ marginBottom: 12 }}>
                        {syncProgress.status === 'running' || syncProgress.status === 'queued' ? (
                          <div className="sync-progress-row">
                            <span className="badge badge-running">Syncing...</span>
                            {syncProgress.progress && (
                              <span className="text-muted" style={{ marginLeft: 8 }}>
                                {formatProgress(syncProgress.progress)}
                              </span>
                            )}
                          </div>
                        ) : syncProgress.status === 'completed' ? (
                          <div className="sync-progress-row">
                            <span className="badge badge-completed">Sync complete</span>
                            {syncProgress.completedAt && (
                              <span className="text-muted" style={{ marginLeft: 8 }}>
                                {new Date(syncProgress.completedAt).toLocaleTimeString()}
                              </span>
                            )}
                          </div>
                        ) : syncProgress.status === 'failed' ? (
                          <div className="sync-progress-row">
                            <span className="badge badge-failed">Sync failed</span>
                            {syncProgress.errors?.length > 0 && (
                              <span className="text-error" style={{ marginLeft: 8 }}>
                                {syncProgress.errors[0]}
                              </span>
                            )}
                          </div>
                        ) : null}
                      </div>
                    )}

                    {/* Webhook Configuration */}
                    <div className="webhook-config-section" style={{ marginBottom: 12, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
                      <span className="detail-label">Configure Webhook</span>
                      <p className="text-muted" style={{ marginTop: 2, marginBottom: 8 }}>
                        Without a webhook, the app polls GitHub periodically. With a webhook, updates are received in real-time.
                      </p>
                      <p className="text-muted" style={{ marginTop: 0, marginBottom: 8 }}>
                        Webhook URL: <span className="mono">{`${window.location.origin}/api/apps/github-collab/webhook`}</span>
                      </p>
                      <div className="input-row">
                        <input
                          type="password"
                          className="input"
                          placeholder="Webhook secret"
                          value={webhookSecret}
                          onChange={e => setWebhookSecret(e.target.value)}
                        />
                        <button
                          className="btn btn-small btn-secondary"
                          onClick={() => handleSaveWebhook(r.owner, r.repo)}
                          disabled={webhookSaving || !webhookSecret}
                        >
                          {webhookSaving ? 'Saving...' : 'Save Webhook Secret'}
                        </button>
                      </div>
                    </div>

                    <div className="repo-card-actions">
                      <button
                        className="btn btn-small"
                        onClick={() => handleSync(r.owner, r.repo)}
                        disabled={isSyncing && syncProgress?.status === 'running'}
                      >
                        {isSyncing && syncProgress?.status === 'running' ? 'Syncing...' : 'Sync Now'}
                      </button>
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
                disabled={removeConfirmText.trim().toLowerCase() !== `${removeTarget.owner}/${removeTarget.repo}`.toLowerCase()}
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
