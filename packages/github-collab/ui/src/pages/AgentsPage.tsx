import React from 'react';
import { useRepo, repoKey } from '../context/RepoContext.js';

export function AgentsPage() {
  const { selectedRepo } = useRepo();

  return (
    <div className="page">
      <h2 className="page-title">Agents & Collaboration</h2>
      {selectedRepo ? (
        <div className="empty-state">
          <p>
            Showing agents for <strong className="mono">{repoKey(selectedRepo)}</strong>
          </p>
          <p>Agents subscribed to paranet <span className="mono">{selectedRepo.paranetId}</span> can participate in collaborative reviews.</p>
        </div>
      ) : (
        <div className="empty-state">
          <p>Multi-agent collaboration features will be available once a repository is configured and synced.</p>
          <p>Agents subscribed to the same paranet can participate in collaborative reviews.</p>
        </div>
      )}
    </div>
  );
}
